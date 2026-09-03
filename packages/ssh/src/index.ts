import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type {
  DesktopPreparedConnection,
  DesktopSshHost,
  DesktopSshTarget,
} from "@gitgui/contracts/desktop";

const REMOTE_RESULT_PREFIX = "GITGUI_SSH_REMOTE=";
const READY_TIMEOUT_MS = 60_000;

interface ManagedSshEnvironment {
  tunnel: ChildProcessWithoutNullStreams;
  connection: DesktopPreparedConnection;
  connectionTarget: DesktopSshTarget;
  remoteServerKind: "managed" | "external";
  sshEnvironment: NodeJS.ProcessEnv;
}

interface RemoteLaunchResult {
  remotePort: number;
  serverKind: "managed" | "external";
  reused: boolean;
}

// Like T3 Code's SSH launcher, this state lives on the remote host so an app
// crash can restore the bridge to the same backend instead of creating a
// second environment. Only processes marked `managed` are ever stopped.
export const REMOTE_LAUNCH_SCRIPT = `set -eu
STATE_KEY="$1"
STATE_DIR="$HOME/.gitgui/ssh-launch/$STATE_KEY"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
KIND_FILE="$STATE_DIR/kind"
TOKEN_FILE="$STATE_DIR/bootstrap"
LOG_FILE="$STATE_DIR/server.log"
DATA_DIR="$HOME/.gitgui/environments/$STATE_KEY"
mkdir -p "$STATE_DIR" "$DATA_DIR"
chmod 700 "$STATE_DIR" "$DATA_DIR" 2>/dev/null || true
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
REMOTE_KIND="$(cat "$KIND_FILE" 2>/dev/null || true)"
if [ "$REMOTE_KIND" = "managed" ] && [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  printf '${REMOTE_RESULT_PREFIX}{"remotePort":%s,"serverKind":"managed","reused":true}\n' "$REMOTE_PORT"
  exit 0
fi
rm -f "$PID_FILE" "$PORT_FILE" "$KIND_FILE"
IFS= read -r BOOTSTRAP
if [ -z "$BOOTSTRAP" ]; then
  printf 'GitGui bootstrap credential was not supplied.\n' >&2
  exit 1
fi
umask 077
printf '%s\n' "$BOOTSTRAP" >"$TOKEN_FILE"
: >"$LOG_FILE"
nohup sh -c 'exec env GITGUI_SERVER_BOOTSTRAP_STDIN=1 GITGUI_SERVER_ALLOWED_ORIGINS=gitgui://app,http://127.0.0.1:1420 gitgui-server --bind 127.0.0.1 --port 0 --data-dir "$1" < "$2"' gitgui "$DATA_DIR" "$TOKEN_FILE" >>"$LOG_FILE" 2>&1 &
REMOTE_PID="$!"
printf '%s\n' "$REMOTE_PID" >"$PID_FILE"
ATTEMPT=0
REMOTE_PORT=""
while [ "$ATTEMPT" -lt 600 ]; do
  REMOTE_PORT="$(sed -n 's/.*"address":"[^"]*:\\([0-9][0-9]*\\)".*/\\1/p' "$LOG_FILE" | tail -n 1)"
  if [ -n "$REMOTE_PORT" ]; then break; fi
  if ! kill -0 "$REMOTE_PID" 2>/dev/null; then
    tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    rm -f "$PID_FILE" "$PORT_FILE" "$KIND_FILE" "$TOKEN_FILE"
    exit 1
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.1
done
if [ -z "$REMOTE_PORT" ]; then
  printf 'Remote GitGui server did not become ready.\n' >&2
  kill "$REMOTE_PID" 2>/dev/null || true
  rm -f "$PID_FILE" "$PORT_FILE" "$KIND_FILE" "$TOKEN_FILE"
  exit 1
fi
printf '%s\n' "$REMOTE_PORT" >"$PORT_FILE"
printf 'managed\n' >"$KIND_FILE"
rm -f "$TOKEN_FILE"
printf '${REMOTE_RESULT_PREFIX}{"remotePort":%s,"serverKind":"managed","reused":false}\n' "$REMOTE_PORT"
`;

export const REMOTE_STOP_SCRIPT = `set -eu
STATE_KEY="$1"
STATE_DIR="$HOME/.gitgui/ssh-launch/$STATE_KEY"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
KIND_FILE="$STATE_DIR/kind"
TOKEN_FILE="$STATE_DIR/bootstrap"
REMOTE_KIND="$(cat "$KIND_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ "$REMOTE_KIND" = "managed" ] && [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  kill "$REMOTE_PID" 2>/dev/null || true
fi
rm -f "$PID_FILE" "$PORT_FILE" "$KIND_FILE" "$TOKEN_FILE"
`;

export interface SshEnvironmentManagerOptions {
  stateDirectory: string;
  requestPassword?: (target: DesktopSshTarget, prompt: string) => Promise<string | null>;
  requestHostTrust?: (target: DesktopSshTarget) => Promise<boolean>;
}

export class SshEnvironmentManager {
  private readonly environments = new Map<string, ManagedSshEnvironment>();

  constructor(private readonly options: SshEnvironmentManagerOptions) {}

  async discoverHosts(): Promise<DesktopSshHost[]> {
    return discoverSshHosts();
  }

  async ensureEnvironment(target: DesktopSshTarget): Promise<DesktopPreparedConnection> {
    validateTarget(target);
    const key = targetKey(target);
    const existing = this.environments.get(key);
    if (existing && existing.tunnel.exitCode === null) {
      try {
        await fetchDescriptor(existing.connection.httpUrl);
        return existing.connection;
      } catch {
        await this.disconnectEnvironment(target);
      }
    }

    let managed: ManagedSshEnvironment;
    try {
      managed = await this.createEnvironment(target);
    } catch (error) {
      let retryError = error;
      if (isUnknownHostKeyFailure(retryError) && this.options.requestHostTrust) {
        const trusted = await this.options.requestHostTrust(target);
        if (!trusted) throw new Error("SSH host-key confirmation was cancelled");
        try {
          managed = await this.createEnvironment(target, "yes");
          this.environments.set(key, managed);
          return managed.connection;
        } catch (hostRetryError) {
          retryError = hostRetryError;
        }
      }
      if (!isAuthenticationFailure(retryError) || !this.options.requestPassword) throw retryError;
      const password = await this.options.requestPassword(target, `Password or key passphrase for ${formatTarget(target)}`);
      if (!password) throw new Error("SSH authentication was cancelled");
      managed = await this.createEnvironment(target, password);
    }
    this.environments.set(key, managed);
    return managed.connection;
  }

  async disconnectEnvironment(target: DesktopSshTarget): Promise<void> {
    const entry = this.environments.get(targetKey(target));
    if (!entry) return;
    this.environments.delete(targetKey(target));
    terminate(entry.tunnel);
    if (entry.remoteServerKind === "managed") {
      await stopRemoteServer(target, entry.sshEnvironment);
    }
  }

  async close(): Promise<void> {
    const entries = [...this.environments.values()];
    this.environments.clear();
    for (const entry of entries) {
      terminate(entry.tunnel);
    }
    await Promise.allSettled(entries
      .filter((entry) => entry.remoteServerKind === "managed")
      .map((entry) => stopRemoteServer(entry.connectionTarget, entry.sshEnvironment)));
  }

  private async createEnvironment(target: DesktopSshTarget, password?: string): Promise<ManagedSshEnvironment> {
    const bootstrap = randomToken();
    const remoteStateKey = Buffer.from(targetKey(target)).toString("base64url").slice(0, 48);
    const remoteCommand = buildRemoteCommand(REMOTE_LAUNCH_SCRIPT, remoteStateKey);
    const environment = password ? await this.askpassEnvironment(password) : process.env;
    const launch = spawn("ssh", [...sshArguments(target), formatTarget(target), remoteCommand], {
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    launch.stdin.write(`${bootstrap}\n`);
    launch.stdin.end();
    launch.stdin.on("error", () => undefined);

    let remote: RemoteLaunchResult;
    try {
      remote = await readRemoteLaunchResult(launch);
    } catch (error) {
      terminate(launch);
      throw error;
    }

    const localPort = await reserveLocalPort();
    const tunnel = spawn("ssh", [
      ...sshArguments(target),
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${remote.remotePort}`,
      formatTarget(target),
    ], {
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const httpUrl = `http://127.0.0.1:${localPort}`;
    try {
      const descriptor = await waitForDescriptor(httpUrl, tunnel);
      return {
        tunnel,
        connectionTarget: target,
        remoteServerKind: remote.serverKind,
        sshEnvironment: environment,
        connection: {
          httpUrl,
          descriptor,
          ...(!remote.reused ? { credential: { kind: "bootstrap" as const, token: bootstrap } } : {}),
        },
      };
    } catch (error) {
      terminate(tunnel);
      if (remote.serverKind === "managed") await stopRemoteServer(target, environment).catch(() => undefined);
      throw error;
    }
  }

  private async askpassEnvironment(password: string): Promise<NodeJS.ProcessEnv> {
    await mkdir(this.options.stateDirectory, { recursive: true });
    const windows = platform() === "win32";
    const helper = join(this.options.stateDirectory, windows ? "ssh-askpass.cmd" : "ssh-askpass.sh");
    const contents = windows
      ? "@echo off\r\n<nul set /p =%GITGUI_SSH_ASKPASS_SECRET%\r\n"
      : "#!/bin/sh\nprintf '%s' \"$GITGUI_SSH_ASKPASS_SECRET\"\n";
    await writeFile(helper, contents, { encoding: "utf8", mode: 0o700 });
    if (!windows) await chmod(helper, 0o700);
    return {
      ...process.env,
      SSH_ASKPASS: helper,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || "gitgui",
      GITGUI_SSH_ASKPASS_SECRET: password,
    };
  }
}

export async function discoverSshHosts(): Promise<DesktopSshHost[]> {
  const sshDirectory = join(homedir(), ".ssh");
  const hosts = new Map<string, DesktopSshHost>();
  try {
    const config = await readFile(join(sshDirectory, "config"), "utf8");
    let current: DesktopSshHost | undefined;
    for (const rawLine of config.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+#.*$/, "").trim();
      const [keyword, ...parts] = line.split(/\s+/);
      const value = parts.join(" ");
      if (keyword?.toLowerCase() === "host") {
        current = undefined;
        for (const alias of parts.filter((part) => !/[*!?]/.test(part))) {
          const host: DesktopSshHost = { alias, source: "ssh-config" };
          hosts.set(alias, host);
          current ??= host;
        }
      } else if (current && keyword?.toLowerCase() === "hostname") current.hostname = value;
      else if (current && keyword?.toLowerCase() === "user") current.user = value;
      else if (current && keyword?.toLowerCase() === "port" && /^\d+$/.test(value)) current.port = Number(value);
    }
  } catch {}

  try {
    const knownHosts = await readFile(join(sshDirectory, "known_hosts"), "utf8");
    for (const line of knownHosts.split(/\r?\n/)) {
      const hostField = line.trim().split(/\s+/)[0];
      if (!hostField || hostField.startsWith("|") || hostField.startsWith("@")) continue;
      for (const rawHost of hostField.split(",")) {
        const alias = rawHost.replace(/^\[([^\]]+)\]:\d+$/, "$1");
        if (alias && !hosts.has(alias)) hosts.set(alias, { alias, source: "known-hosts" });
      }
    }
  } catch {}
  return [...hosts.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

function sshArguments(target: DesktopSshTarget): string[] {
  const args = ["-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
  if (target.port) args.push("-p", String(target.port));
  if (target.identityFile) args.push("-i", target.identityFile);
  return args;
}

function formatTarget(target: DesktopSshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

function targetKey(target: DesktopSshTarget): string {
  return `${target.user ?? ""}@${target.host}:${target.port ?? 22}:${target.identityFile ?? ""}`;
}

export function buildRemoteCommand(script: string, stateKey: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(stateKey)) throw new TypeError("SSH state key is invalid");
  return `sh -c ${shellSingleQuote(script)} -- ${stateKey}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateTarget(target: DesktopSshTarget): void {
  const safe = /^[A-Za-z0-9._:@%+\-]+$/;
  if (!target.host || !safe.test(target.host)) throw new TypeError("SSH host contains unsupported characters");
  if (target.user && !safe.test(target.user)) throw new TypeError("SSH user contains unsupported characters");
  if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
    throw new TypeError("SSH port is invalid");
  }
  if (target.identityFile && /[\r\n\0]/.test(target.identityFile)) throw new TypeError("SSH identity path is invalid");
}

export function parseRemoteLaunchResult(stdout: string): RemoteLaunchResult | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(REMOTE_RESULT_PREFIX)) continue;
    try {
      const value = JSON.parse(line.slice(REMOTE_RESULT_PREFIX.length)) as Partial<RemoteLaunchResult>;
      if (
        Number.isInteger(value.remotePort) &&
        value.remotePort! >= 1 &&
        value.remotePort! <= 65_535 &&
        (value.serverKind === "managed" || value.serverKind === "external") &&
        typeof value.reused === "boolean"
      ) {
        return value as RemoteLaunchResult;
      }
    } catch {}
  }
  return null;
}

function readRemoteLaunchResult(child: ChildProcessWithoutNullStreams): Promise<RemoteLaunchResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error("Remote GitGui server did not become ready")), READY_TIMEOUT_MS);
    let settled = false;
    const finish = (error?: Error, result?: RemoteLaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      error ? reject(error) : resolve(result!);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const result = parseRemoteLaunchResult(stdout);
      if (result) return finish(undefined, result);
      if (stdout.length > 256_000) stdout = stdout.slice(-128_000);
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    };
    const onExit = (code: number | null) => finish(new Error(`Remote GitGui launch exited (${code ?? "unknown"}): ${redact(stderr)}`));
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", (error) => finish(error));
  });
}

async function stopRemoteServer(target: DesktopSshTarget, environment: NodeJS.ProcessEnv): Promise<void> {
  const remoteStateKey = Buffer.from(targetKey(target)).toString("base64url").slice(0, 48);
  const child = spawn(
    "ssh",
    [...sshArguments(target), formatTarget(target), buildRemoteCommand(REMOTE_STOP_SCRIPT, remoteStateKey)],
    { env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  await waitForExit(child, 15_000);
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      terminate(child);
      reject(new Error("Remote GitGui shutdown timed out"));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`Remote GitGui shutdown exited (${code ?? "unknown"}): ${redact(stderr)}`));
    });
  });
}

async function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForDescriptor(httpUrl: string, tunnel: ChildProcessWithoutNullStreams) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (tunnel.exitCode !== null) throw new Error(`SSH tunnel exited with code ${tunnel.exitCode}`);
    try {
      return await fetchDescriptor(httpUrl);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Forwarded GitGui server did not become ready");
}

async function fetchDescriptor(httpUrl: string) {
  const response = await fetch(`${httpUrl}/.well-known/gitgui/environment`);
  if (!response.ok) throw new Error(`GitGui descriptor returned HTTP ${response.status}`);
  return await response.json() as DesktopPreparedConnection["descriptor"];
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null && !child.killed) child.kill();
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof Error && /permission denied|authentication failed|publickey|passphrase/i.test(error.message);
}

function isUnknownHostKeyFailure(error: unknown): boolean {
  return error instanceof Error &&
    !/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(error.message) &&
    /host key verification failed|authenticity of host .* can't be established/i.test(error.message);
}

function redact(value: string): string {
  return value.replace(/(password|token|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]").trim().slice(-8_000);
}

function randomToken(): string {
  return `ggb_${randomBytes(32).toString("hex")}`;
}
