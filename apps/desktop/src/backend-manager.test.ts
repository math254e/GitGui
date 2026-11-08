import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => "/isolated-test", getAppPath: () => "/fixture" } }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
import { BackendManager } from "./backend-manager.js";

function spawnFixture(prepare = true, ready = true) {
  const commands: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
    kill: vi.fn(() => true) });
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      if (!line.startsWith("{")) continue; // The inherited bootstrap is deliberately not recorded.
      const { id, command } = JSON.parse(line);
      commands.push(command);
      queueMicrotask(() => {
        const ok = command !== "prepare-update" || prepare;
        child.stdout.emit("data", Buffer.from(`GITGUI_SERVER_CONTROL=${JSON.stringify({ id, ok })}\n`));
        if (command === "shutdown" && ok) { child.exitCode = 0; child.emit("exit", 0); }
      });
    }
  });
  if (ready) queueMicrotask(() => child.stdout.emit("data", Buffer.from('GITGUI_SERVER_READY={"address":"127.0.0.1:3774"}\n')));
  return { child, commands };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("managed local update stop", () => {
  it("stops the owned child after a readiness timeout before retrying startup", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    spawnMock.mockImplementation(() => {
      const value = spawnFixture(true, children.length > 0); children.push(value);
      value.child.kill.mockImplementation(() => { value.child.exitCode = 0; value.child.emit("exit", 0); return true; });
      return value.child;
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ environmentId: "replacement" })));
    vi.useFakeTimers();
    try {
      const backend = new BackendManager();
      const connecting = backend.getConnection();
      const failure = expect(connecting).rejects.toThrow("readiness timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await failure;
      expect(children[0].child.kill).toHaveBeenCalledOnce();
      expect(children[0].child.exitCode).toBe(0);
      vi.useRealTimers();
      expect((await backend.getConnection()).descriptor.environmentId).toBe("replacement");
      expect(spawnMock).toHaveBeenCalledTimes(2);
      await backend.shutdownForUpdate();
    } finally { vi.useRealTimers(); }
  });

  it("restarts an in-flight startup before resolving concurrent connection requests", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    let resolveFirst!: (value: Response) => void;
    const firstDescriptor = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    spawnMock.mockImplementation(() => { const value = spawnFixture(); children.push(value); return value.child; });
    const fetch = vi.fn().mockReturnValueOnce(firstDescriptor).mockResolvedValue(Response.json({ environmentId: "replacement" }));
    vi.stubGlobal("fetch", fetch);
    const backend = new BackendManager();
    const firstConnection = backend.getConnection();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const restart = backend.restart();
    const secondRestart = backend.restart();
    const concurrentConnection = backend.getConnection();
    resolveFirst(Response.json({ environmentId: "initial" }));
    await vi.waitFor(() => expect(children[0].child.kill).toHaveBeenCalledOnce());
    expect(spawnMock).toHaveBeenCalledOnce();
    children[0].child.exitCode = 0; children[0].child.emit("exit", 0);
    expect((await restart).descriptor.environmentId).toBe("replacement");
    expect((await secondRestart).descriptor.environmentId).toBe("replacement");
    expect((await concurrentConnection).descriptor.environmentId).toBe("replacement");
    expect((await firstConnection).descriptor.environmentId).toBe("replacement");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    children[1].child.exitCode = 0; children[1].child.emit("exit", 0);
  });

  it("does not start a replacement during update preparation after a restart is interrupted", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    spawnMock.mockImplementation(() => { const value = spawnFixture(); children.push(value); return value.child; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ environmentId: "same" })));
    const backend = new BackendManager(); await backend.getConnection();
    const restart = backend.restart();
    const interrupted = expect(restart).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(children[0].child.kill).toHaveBeenCalledOnce());
    const preparing = backend.shutdownForUpdate();
    await expect(backend.getConnection()).rejects.toThrow("preparing");
    expect(spawnMock).toHaveBeenCalledOnce();
    children[0].child.exitCode = 0; children[0].child.emit("exit", 0);
    await interrupted; await preparing;
    expect(spawnMock).toHaveBeenCalledOnce();
    await backend.recoverAfterUpdate();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await backend.shutdownForUpdate();
  });

  it("drains an initial startup and cancels its pending restart when quit begins", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    let resolveDescriptor!: (value: Response) => void;
    const descriptor = new Promise<Response>((resolve) => { resolveDescriptor = resolve; });
    spawnMock.mockImplementation(() => {
      const value = spawnFixture(); children.push(value);
      value.child.kill.mockImplementation(() => { queueMicrotask(() => { value.child.exitCode = 0; value.child.emit("exit", 0); }); return true; });
      return value.child;
    });
    const fetch = vi.fn(() => descriptor); vi.stubGlobal("fetch", fetch);
    const backend = new BackendManager();
    const connecting = backend.getConnection();
    const stoppedConnection = expect(connecting).rejects.toThrow("stopping");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const restart = backend.restart();
    const interrupted = expect(restart).rejects.toThrow("interrupted");
    const quit = backend.shutdown();
    resolveDescriptor(Response.json({ environmentId: "initial" }));
    await stoppedConnection; await interrupted; await quit;
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(children[0].child.kill).toHaveBeenCalledOnce();
    expect(children[0].child.exitCode).toBe(0);
  });

  it("prepares the original child when update interrupts a restart waiting on startup", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    let resolveDescriptor!: (value: Response) => void;
    const descriptor = new Promise<Response>((resolve) => { resolveDescriptor = resolve; });
    spawnMock.mockImplementation(() => { const value = spawnFixture(); children.push(value); return value.child; });
    const fetch = vi.fn(() => descriptor); vi.stubGlobal("fetch", fetch);
    const backend = new BackendManager();
    const connecting = backend.getConnection();
    const blockedConnection = expect(connecting).rejects.toThrow("preparing");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const restart = backend.restart();
    const interrupted = expect(restart).rejects.toThrow("interrupted");
    const preparing = backend.shutdownForUpdate();
    resolveDescriptor(Response.json({ environmentId: "initial" }));
    await blockedConnection; await interrupted; await preparing;
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(children[0].commands).toEqual(["prepare-update", "shutdown"]);
    expect(children[0].child.kill).not.toHaveBeenCalled();
  });

  it("does not return a replacement endpoint after update reserves while it is starting", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    let resolveReplacement!: (value: Response) => void;
    const replacement = new Promise<Response>((resolve) => { resolveReplacement = resolve; });
    spawnMock.mockImplementation(() => {
      const value = spawnFixture(); children.push(value);
      value.child.kill.mockImplementation(() => { queueMicrotask(() => { value.child.exitCode = 0; value.child.emit("exit", 0); }); return true; });
      return value.child;
    });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ environmentId: "initial" })).mockReturnValueOnce(replacement);
    vi.stubGlobal("fetch", fetch);
    const backend = new BackendManager(); await backend.getConnection();
    const restart = backend.restart();
    const blockedRestart = expect(restart).rejects.toThrow("preparing");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const waiting = backend.getConnection();
    const blockedConnection = expect(waiting).rejects.toThrow("preparing");
    const preparing = backend.shutdownForUpdate();
    resolveReplacement(Response.json({ environmentId: "replacement" }));
    await blockedRestart; await blockedConnection; await preparing;
    expect(children[1].commands).toEqual(["prepare-update", "shutdown"]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("does not create a replacement when the exact old child fails to exit after both signals", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    spawnMock.mockImplementation(() => { const value = spawnFixture(); children.push(value); return value.child; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ environmentId: "same" })));
    const backend = new BackendManager(); await backend.getConnection();
    vi.useFakeTimers();
    try {
      const restarting = backend.restart();
      const failure = expect(restarting).rejects.toThrow("did not stop");
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      expect(children[0].child.kill).toHaveBeenCalledWith("SIGKILL");
      await expect(backend.getConnection()).rejects.toThrow("has not stopped");
      await expect(backend.shutdownForUpdate()).rejects.toThrow("has not stopped");
      expect(spawnMock).toHaveBeenCalledOnce();
      children[0].child.signalCode = "SIGKILL"; children[0].child.emit("exit", null, "SIGKILL");
      vi.useRealTimers();
      await backend.recoverAfterUpdate();
      expect(spawnMock).toHaveBeenCalledTimes(2);
      await backend.shutdownForUpdate();
    } finally { vi.useRealTimers(); }
  });

  it("waits for the old child to exit even after sending SIGKILL", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    spawnMock.mockImplementation(() => { const value = spawnFixture(); children.push(value); return value.child; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ environmentId: "same" })));
    const backend = new BackendManager(); await backend.getConnection();
    vi.useFakeTimers();
    try {
      const restarting = backend.restart();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(children[0].child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(spawnMock).toHaveBeenCalledOnce();
      const connection = backend.getConnection();
      children[0].child.signalCode = "SIGKILL"; children[0].child.emit("exit", null, "SIGKILL");
      vi.useRealTimers();
      await restarting; await connection;
      expect(spawnMock).toHaveBeenCalledTimes(2);
      await backend.shutdownForUpdate();
    } finally { vi.useRealTimers(); }
  });

  it("retains ownership after failed startup cleanup and blocks replacement until exit", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    let rejectDescriptor!: (error: Error) => void;
    const descriptor = new Promise<Response>((_, reject) => { rejectDescriptor = reject; });
    spawnMock.mockImplementation(() => { const value = spawnFixture(); children.push(value); return value.child; });
    const fetch = vi.fn().mockReturnValueOnce(descriptor).mockResolvedValue(Response.json({ environmentId: "replacement" }));
    vi.stubGlobal("fetch", fetch);
    const backend = new BackendManager();
    const connecting = backend.getConnection();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const failure = expect(connecting).rejects.toThrow("did not stop");
    vi.useFakeTimers();
    try {
      rejectDescriptor(new Error("descriptor unavailable"));
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      await expect(backend.getConnection()).rejects.toThrow("has not stopped");
      expect(spawnMock).toHaveBeenCalledOnce();
      children[0].child.signalCode = "SIGKILL"; children[0].child.emit("exit", null, "SIGKILL");
      vi.useRealTimers();
      expect((await backend.getConnection()).descriptor.environmentId).toBe("replacement");
      await backend.shutdownForUpdate();
    } finally { vi.useRealTimers(); }
  });

  it.each(["code", "signal"] as const)("rejects a child that exits by %s after its ready line while the descriptor is pending", async (kind) => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    let resolveDescriptor!: (value: Response) => void;
    const descriptor = new Promise<Response>((resolve) => { resolveDescriptor = resolve; });
    spawnMock.mockImplementation(() => { const value = spawnFixture(); children.push(value); return value.child; });
    const fetch = vi.fn().mockReturnValueOnce(descriptor).mockResolvedValue(Response.json({ environmentId: "replacement" }));
    vi.stubGlobal("fetch", fetch);

    const backend = new BackendManager();
    const connecting = backend.getConnection();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const first = children[0].child;
    if (kind === "code") first.exitCode = 1;
    else first.signalCode = "SIGTERM";
    first.emit("exit", first.exitCode, first.signalCode);
    resolveDescriptor(Response.json({ environmentId: "exited" }));
    await expect(connecting).rejects.toThrow("exited before readiness completed");
    expect(first.kill).not.toHaveBeenCalled();

    expect((await backend.getConnection()).descriptor.environmentId).toBe("replacement");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    children[1].child.exitCode = 0;
    children[1].child.emit("exit", 0);
  });

  it("waits for pending startup during quit and blocks late connection/restart attempts", async () => {
    let fixture!: ReturnType<typeof spawnFixture>;
    let resolveDescriptor!: (value: Response) => void;
    const descriptor = new Promise<Response>(resolve => { resolveDescriptor = resolve; });
    spawnMock.mockImplementation(() => {
      fixture = spawnFixture();
      fixture.child.kill.mockImplementation(() => {
        queueMicrotask(() => { fixture.child.exitCode = 0; fixture.child.emit("exit", 0); });
        return true;
      });
      return fixture.child;
    });
    const fetch = vi.fn(() => descriptor); vi.stubGlobal("fetch", fetch);
    const backend = new BackendManager(); const connecting = backend.getConnection();
    const stoppedConnection = expect(connecting).rejects.toThrow("stopping");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    let stopped = false; const closing = backend.shutdown().then(() => { stopped = true; });
    await expect(backend.getConnection()).rejects.toThrow("stopping");
    await expect(backend.restart()).rejects.toThrow("stopping");
    expect(stopped).toBe(false); expect(fixture.child.kill).not.toHaveBeenCalled();
    resolveDescriptor(Response.json({ environmentId: "same-environment" }));
    await stoppedConnection; await closing;
    expect(fixture.child.exitCode).toBe(0); expect(spawnMock).toHaveBeenCalledOnce();
  });
  it("uses the inherited control channel and restarts the same local environment after install failure", async () => {
    const children: ReturnType<typeof spawnFixture>[] = [];
    spawnMock.mockImplementation(() => { const value = spawnFixture(); children.push(value); return value.child; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ environmentId: "same-environment" })));
    const backend = new BackendManager();
    await backend.getConnection();
    await backend.shutdownForUpdate();
    expect(children[0].commands).toEqual(["prepare-update", "shutdown"]);
    expect(children[0].child.kill).not.toHaveBeenCalled();
    await expect(backend.getConnection()).rejects.toThrow("preparing");
    await backend.recoverAfterUpdate();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect((await backend.getConnection()).descriptor.environmentId).toBe("same-environment");
    // Stop the fixture through its safe update path so no child is left active.
    await backend.shutdownForUpdate();
  });

  it("resumes the existing server after busy refusal without killing or respawning it", async () => {
    let fixture!: ReturnType<typeof spawnFixture>;
    spawnMock.mockImplementation(() => { fixture = spawnFixture(false); return fixture.child; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ environmentId: "same-environment" })));
    const backend = new BackendManager();
    await backend.getConnection();
    await expect(backend.shutdownForUpdate()).rejects.toThrow("could not prepare");
    await backend.recoverAfterUpdate();
    expect(fixture.commands).toEqual(["prepare-update", "resume"]);
    expect(fixture.child.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();
    fixture.child.exitCode = 0; fixture.child.emit("exit", 0);
  });
});
