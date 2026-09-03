import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";
import type { DesktopPreparedConnection } from "@gitgui/contracts/desktop";

const READY_PREFIX = "GITGUI_SERVER_READY=";
const READY_TIMEOUT_MS = 30_000;

interface RunningBackend {
  child: ChildProcessWithoutNullStreams;
  connection: DesktopPreparedConnection;
}

export class BackendManager {
  private running?: RunningBackend;
  private starting?: Promise<RunningBackend>;
  private stopping = false;

  async getConnection(): Promise<DesktopPreparedConnection> {
    if (this.running && this.running.child.exitCode === null) return this.running.connection;
    return (await this.ensureStarted()).connection;
  }

  async restart(): Promise<DesktopPreparedConnection> {
    await this.shutdownCurrent();
    return (await this.ensureStarted()).connection;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.shutdownCurrent();
  }

  private async ensureStarted(): Promise<RunningBackend> {
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.startBackend();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startBackend(): Promise<RunningBackend> {
    const executable = locateServerExecutable();
    const bootstrap = `ggb_${randomBytes(32).toString("hex")}`;
    const dataDirectory = join(app.getPath("userData"), "server");
    const child = spawn(executable, ["--bind", "127.0.0.1", "--port", "0", "--data-dir", dataDirectory], {
      env: {
        ...process.env,
        GITGUI_SERVER_BOOTSTRAP_STDIN: "1",
        GITGUI_SERVER_ALLOWED_ORIGINS: "gitgui://app,http://127.0.0.1:1420,http://localhost:1420",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.write(`${bootstrap}\n`);
    child.stdin.end();

    child.stderr.on("data", (chunk: Buffer) => {
      const diagnostic = redact(chunk.toString("utf8")).trim();
      if (diagnostic) console.error(`[gitgui-server] ${diagnostic}`);
    });

    let address: string;
    try {
      address = await readReadyAddress(child);
    } catch (error) {
      terminate(child);
      throw error;
    }
    const httpUrl = `http://${address}`;
    const descriptor = await fetchDescriptor(httpUrl);
    const running: RunningBackend = {
      child,
      connection: {
        httpUrl,
        descriptor,
        credential: { kind: "bootstrap", token: bootstrap },
      },
    };
    child.once("exit", () => {
      if (this.running === running) this.running = undefined;
      if (!this.stopping) console.error("[gitgui] managed server exited unexpectedly");
    });
    this.running = running;
    return running;
  }

  private async shutdownCurrent(): Promise<void> {
    const running = this.running;
    this.running = undefined;
    if (!running || running.child.exitCode !== null) return;
    terminate(running.child);
    await Promise.race([
      new Promise<void>((resolve) => running.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
  }
}

function locateServerExecutable(): string {
  const executableName = process.platform === "win32" ? "gitgui-server.exe" : "gitgui-server";
  const candidates = [
    process.env.GITGUI_SERVER_BINARY,
    app.isPackaged ? join(process.resourcesPath, "server", executableName) : undefined,
    resolve(process.cwd(), "target", "debug", executableName),
    resolve(app.getAppPath(), "..", "..", "target", "debug", executableName),
  ].filter((value): value is string => Boolean(value));
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new Error("Could not locate gitgui-server; build it or set GITGUI_SERVER_BINARY");
  return match;
}

function readReadyAddress(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("GitGui server readiness timed out")), READY_TIMEOUT_MS);
    const finish = (error?: Error, address?: string) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      error ? reject(error) : resolve(address!);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith(READY_PREFIX)) continue;
        try {
          const value = JSON.parse(line.slice(READY_PREFIX.length)) as { address?: string };
          if (value.address && /^(127\.0\.0\.1|\[::1\]):\d+$/.test(value.address)) return finish(undefined, value.address);
        } catch {}
      }
      if (output.length > 256_000) output = output.slice(-128_000);
    };
    const onExit = (code: number | null) => finish(new Error(`GitGui server exited before readiness (${code ?? "unknown"})`));
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", (error) => finish(error));
  });
}

async function fetchDescriptor(httpUrl: string) {
  const response = await fetch(`${httpUrl}/.well-known/gitgui/environment`);
  if (!response.ok) throw new Error(`GitGui server descriptor returned HTTP ${response.status}`);
  return await response.json() as DesktopPreparedConnection["descriptor"];
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null && !child.killed) child.kill();
}

function redact(value: string): string {
  return value.replace(/(authorization|password|token)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(-8_000);
}
