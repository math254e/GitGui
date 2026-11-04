import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => "/isolated-test", getAppPath: () => "/fixture" } }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
import { BackendManager } from "./backend-manager.js";

function spawnFixture(prepare = true) {
  const commands: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: null as number | null, signalCode: null, killed: false,
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
  queueMicrotask(() => child.stdout.emit("data", Buffer.from('GITGUI_SERVER_READY={"address":"127.0.0.1:3774"}\n')));
  return { child, commands };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("managed local update stop", () => {
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
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    let stopped = false; const closing = backend.shutdown().then(() => { stopped = true; });
    await expect(backend.getConnection()).rejects.toThrow("stopping");
    await expect(backend.restart()).rejects.toThrow("stopping");
    expect(stopped).toBe(false); expect(fixture.child.kill).not.toHaveBeenCalled();
    resolveDescriptor(Response.json({ environmentId: "same-environment" }));
    await connecting; await closing;
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
