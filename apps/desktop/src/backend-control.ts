import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const CONTROL_PREFIX = "GITGUI_SERVER_CONTROL=";
type Command = "prepare-update" | "resume" | "shutdown";
interface Pending {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Private inherited stdio control, never exposed through renderer or Git RPC. */
export class BackendControl {
  private buffer = "";
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", this.onData);
    child.once("exit", this.onExit);
    child.stdin.on("error", this.onInputError);
  }

  request(command: Command, timeoutMs = 35_000): Promise<void> {
    if (this.closed || this.child.exitCode !== null || this.child.stdin.destroyed) {
      return Promise.reject(new Error("The local server control channel is unavailable."));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The local server did not finish preparing for the update. Try again after Git operations finish."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, command })}\n`, (error) => {
        if (error) this.fail(id);
      });
    });
  }

  dispose(): void {
    this.closed = true;
    this.child.stdout.off("data", this.onData);
    this.child.off("exit", this.onExit);
    // Keep the stdin error consumer until the stream itself closes.
    for (const id of this.pending.keys()) this.fail(id);
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > 256_000) {
      this.buffer = "";
      for (const id of this.pending.keys()) this.fail(id);
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trimEnd();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith(CONTROL_PREFIX)) continue;
      try {
        const value: unknown = JSON.parse(line.slice(CONTROL_PREFIX.length));
        if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") continue;
        const request = this.pending.get(value.id);
        if (!request) continue;
        clearTimeout(request.timer);
        this.pending.delete(value.id);
        if ("ok" in value && value.ok === true) request.resolve();
        else request.reject(new Error("The local server could not prepare for the update. Wait for Git operations to finish and retry."));
      } catch { /* Ordinary stdout is not a trusted control response. */ }
    }
  };

  private readonly onExit = () => this.dispose();
  private readonly onInputError = () => { for (const id of this.pending.keys()) this.fail(id); };

  private fail(id: string): void {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(id);
    request.reject(new Error("The local server control channel closed before the update handoff."));
  }
}

export function waitForBackendExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); child.off("exit", finish); resolve(); };
    const timer = setTimeout(() => {
      child.off("exit", finish);
      reject(new Error("The local server has not stopped yet. Installation was cancelled."));
    }, timeoutMs);
    child.once("exit", finish);
  });
}
