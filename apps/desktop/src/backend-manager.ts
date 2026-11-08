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
  stopping: boolean;
}

export class BackendManager {
  private running?: RunningBackend;
  private starting?: Promise<RunningBackend>;
  private restarting?: Promise<RunningBackend>;
  private unstoppedChild?: ChildProcessWithoutNullStreams;
  private stopping = false;
  private updateReserved = false;
  private updateShutdownRequested = false;

  async getConnection(): Promise<DesktopPreparedConnection> {
    this.assertConnectionAdmitted();
    if (this.restarting) {
      const running = await this.restarting;
      this.assertConnectionAdmitted();
      return running.connection;
    }
    if (this.running && isChildRunning(this.running.child)) return this.running.connection;
    const running = await this.ensureStarted();
    this.assertConnectionAdmitted();
    // A restart may have begun while this caller was awaiting initial startup.
    const restarting = this.restartInFlight();
    if (restarting) {
      const replacement = await restarting;
      this.assertConnectionAdmitted();
      return replacement.connection;
    }
    return running.connection;
  }

  private restartInFlight(): Promise<RunningBackend> | undefined { return this.restarting; }

  async restart(): Promise<DesktopPreparedConnection> {
    if (this.updateReserved) throw new Error("The local server is preparing for an app update.");
    if (this.stopping) throw new Error("The local server is stopping.");
    const pending = this.restarting ??= this.restartBackend();
    try {
      const running = await pending;
      this.assertConnectionAdmitted();
      return running.connection;
    } finally {
      if (this.restarting === pending) this.restarting = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    try { await this.restarting; } catch { /* A quit supersedes the restart. */ }
    // A ready/descriptor result can arrive after quit was requested. Retain the
    // startup promise until it publishes (or cleans up) its exact owned child.
    try { await this.starting; } catch { /* Failed startup already owns cleanup. */ }
    await this.shutdownCurrent();
    if (this.unstoppedChild) await this.stopChild(this.unstoppedChild);
  }

  async shutdownForUpdate(): Promise<void> {
    this.updateReserved = true;
    try { await this.restarting; } catch (error) {
      // Only the admission interruption is expected; a failure to stop the
      // exact child must prevent installation.
      if (!(error instanceof RestartInterruptedError)) throw error;
    }
    if (this.starting) await this.starting;
    this.assertNoUnstoppedChild();
    const running = this.running;
    if (!running || !isChildRunning(running.child)) return;
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
    if (running && isChildRunning(running.child)) {
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
    this.assertNoUnstoppedChild();
    if (this.starting) return this.starting;
    this.starting = this.startBackend();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async restartBackend(): Promise<RunningBackend> {
    // Own and stop the startup that was already in flight, rather than return
    // that same child as the result of a restart.
    if (this.starting) await this.starting;
    this.assertRestartAdmitted();
    if (this.unstoppedChild) await this.stopChild(this.unstoppedChild);
    await this.shutdownCurrent();
    this.assertRestartAdmitted();
    return this.ensureStarted();
  }

  private assertRestartAdmitted(): void {
    if (this.stopping || this.updateReserved) throw new RestartInterruptedError();
  }

  private assertConnectionAdmitted(): void {
    if (this.updateReserved) throw new Error("The local server is preparing for an app update.");
    if (this.stopping) throw new Error("The local server is stopping.");
    this.assertNoUnstoppedChild();
  }

  private assertNoUnstoppedChild(): void {
    if (this.unstoppedChild && isChildRunning(this.unstoppedChild)) {
      throw new Error("The previous local server has not stopped.");
    }
    this.unstoppedChild = undefined;
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    try {
      await stopOwnedChild(child);
      if (this.unstoppedChild === child) this.unstoppedChild = undefined;
    } catch (error) {
      // A timed-out child is still owned; never start another over it.
      this.unstoppedChild = child;
      throw error;
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
      // The child may exit after its ready line while the descriptor request is
      // still in flight. Never publish a connection for an already-dead child.
      if (!isChildRunning(child)) throw new Error("GitGui server exited before readiness completed.");
    } catch (error) {
      control.dispose();
      await this.stopChild(child);
      throw error;
    }
    const httpUrl = `http://${address}`;
    const running: RunningBackend = {
      child,
      control,
      stopping: false,
      connection: {
        httpUrl,
        descriptor,
        credential: { kind: "bootstrap", token: bootstrap },
      },
    };
    child.once("exit", () => {
      if (this.running === running) this.running = undefined;
      if (!this.stopping && !running.stopping) console.error("[gitgui] managed server exited unexpectedly");
    });
    this.running = running;
    return running;
  }

  private async shutdownCurrent(): Promise<void> {
    const running = this.running;
    if (!running || !isChildRunning(running.child)) return;
    running.stopping = true;
    running.control.dispose();
    await this.stopChild(running.child);
    if (this.running === running) this.running = undefined;
  }
}

class RestartInterruptedError extends Error {
  constructor() { super("The local server restart was interrupted by shutdown or update preparation."); }
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

function isChildRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (isChildRunning(child) && !child.killed) child.kill();
}

async function stopOwnedChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!isChildRunning(child)) return;
  terminate(child);
  try {
    await waitForBackendExit(child, 5_000);
  } catch {
    if (!isChildRunning(child)) return;
    child.kill("SIGKILL");
    try { await waitForBackendExit(child, 5_000); }
    catch { throw new Error("The local server did not stop."); }
  }
}

function redact(value: string): string {
  return value.replace(/(authorization|password|token)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(-8_000);
}
