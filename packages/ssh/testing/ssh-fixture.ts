import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, killed: false,
    kill: vi.fn(() => { child.killed = true; child.exitCode = 0; child.emit("exit", 0); return true; }),
  });
  return child;
}

// Exercise the real manager and real local port reservation; only SSH and HTTP
// are controlled so acquisition/finalization races are deterministic on CI.
export function sshProcessFixture(options: {
  manualLaunch?: boolean; manualStop?: boolean;
  serverKind?: "managed" | "external"; reused?: boolean;
} = {}) {
  const launches: ReturnType<typeof processFixture>[] = [];
  const tunnels: ReturnType<typeof processFixture>[] = [];
  const stops: ReturnType<typeof processFixture>[] = [];
  const launchResult = (child = launches.at(-1)!) => {
    child.stdout.emit("data", Buffer.from(`GITGUI_SSH_REMOTE=${JSON.stringify({
      remotePort: 3774, serverKind: options.serverKind ?? "managed", reused: options.reused ?? false,
    })}\n`));
  };
  const finishStop = (child = stops.at(-1)!) => { child.exitCode = 0; child.emit("exit", 0); };
  const spawn = vi.fn((_command: string, args: string[]) => {
    const child = processFixture();
    if (args.includes("-N")) tunnels.push(child);
    else if (args.at(-1)?.includes("GITGUI_SSH_REMOTE=")) {
      launches.push(child);
      if (!options.manualLaunch) queueMicrotask(() => launchResult(child));
    } else {
      stops.push(child);
      if (!options.manualStop) queueMicrotask(() => finishStop(child));
    }
    return child;
  });
  return { spawn, launches, tunnels, stops, launchResult, finishStop };
}
