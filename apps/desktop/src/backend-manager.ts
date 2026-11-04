import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";
import type { DesktopPreparedConnection } from "@gitgui/contracts/desktop";
import { BackendControl, waitForBackendExit } from "./backend-control.js";

const READY_PREFIX = "GITGUI_SERVER_READY=";
const READY_TIMEOUT_MS = 30_000;

interface RunningBackend {
  child: ChildProcessWithoutNullStreams;
  connection: DesktopPreparedConnection;
  control: BackendControl;
}

export class BackendManager {
  private running?: RunningBackend;
  private starting?: Promise<RunningBackend>;
  private stopping = false;
  private updateReserved = false;
  private updateShutdownRequested = false;

  async getConnection(): Promise<DesktopPreparedConnection> {
    if (this.updateReserved) throw new Error("The local server is preparing for an app update.");
    if (this.stopping) throw new Error("The local server is stopping.");
    if (this.running && this.running.child.exitCode === null) return this.running.connection;
    return (await this.ensureStarted()).connection;
  }

  async restart(): Promise<DesktopPreparedConnection> {
    if (this.updateReserved) throw new Error("The local server is preparing for an app update.");
    if (this.stopping) throw new Error("The local server is stopping.");
    await this.shutdownCurrent();
    return (await this.ensureStarted()).connection;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    // A ready/descriptor result can arrive after quit was requested. Retain the
    // startup promise until it publishes (or cleans up) its exact owned child.
    try { await this.starting; } catch { /* Failed startup already owns cleanup. */ }
    await this.shutdownCurrent();
  }

  async shutdownForUpdate(): Promise<void> {
    this.updateReserved = true;
    if (this.starting) await this.starting;
    const running = this.running;
    if (!running || running.child.exitCode !== null) return;
    await running.control.request("prepare-update");
    this.stopping = true;
    this.updateShutdownRequested = true;
    await running.control.request("shutdown", 10_000);
    // The update path never force-kills Git workers. A timeout cancels install.
    await waitForBackendExit(running.child, 10_000);
    if (this.running === running) this.running = undefined;
  }

  async recoverAfterUpdate(): Promise<void> {
    const running = this.running;
    if (running && running.child.exitCode === null) {
      if (this.updateShutdownRequested) await waitForBackendExit(running.child, 10_000);
      else await running.control.request("resume", 5_000);
    }
    this.updateShutdownRequested = false;
    this.updateReserved = false;
    this.stopping = false;
    await this.getConnection();
  }

  private async ensureStarted(): Promise<RunningBackend> {
    if (this.stopping) throw new Error("The local server is stopping.");
    if (this.starting) return this.starting;
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
        GITGUI_SERVER_DESKTOP_CONTROL: "1",
        GITGUI_SERVER_ALLOWED_ORIGINS: "gitgui://app,http://127.0.0.1:1420,http://localhost:1420",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.write(`${bootstrap}\n`);
    const control = new BackendControl(child);

    child.stderr.on("data", (chunk: Buffer) => {
      const diagnostic = redact(chunk.toString("utf8")).trim();
      if (diagnostic) console.error(`[gitgui-server] ${diagnostic}`);
    });

    let address: string;
    let descriptor: DesktopPreparedConnection["descriptor"];
    try {
      address = await readReadyAddress(child);
      descriptor = await fetchDescriptor(`http://${address}`);
    } catch (error) {
      control.dispose();
      terminate(child);
      throw error;
    }
    const httpUrl = `http://${address}`;
    const running: RunningBackend = {
      child,
      control,
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
    running.control.dispose();
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
    let settled = false;
    const timer = setTimeout(() => finish(new Error("GitGui server readiness timed out")), READY_TIMEOUT_MS);
    const finish = (error?: Error, address?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
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
    const onError = () => finish(new Error("GitGui server could not be started."));
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function fetchDescriptor(httpUrl: string) {
  const response = await fetch(`${httpUrl}/.well-known/gitgui/environment`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GitGui server descriptor returned HTTP ${response.status}`);
  return await response.json() as DesktopPreparedConnection["descriptor"];
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null && !child.killed) child.kill();
}

function redact(value: string): string {
  return value.replace(/(authorization|password|token)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(-8_000);
}
