import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, sshProcessFixture } from "../testing/ssh-fixture.js";
import { createServer } from "node:http";

const nativeFetch = globalThis.fetch;

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { SshEnvironmentManager } from "./index.js";

const target = { host: "fixture-host" };
let manager: SshEnvironmentManager;
beforeEach(() => {
  manager = new SshEnvironmentManager({ stateDirectory: "/unused" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ environmentId: "same-environment" })));
});
afterEach(async () => {
  await manager.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SSH manager install resource ownership (T3 tunnel scopes)", () => {
  it.each([
    { serverKind: "managed" as const, reused: false },
    { serverKind: "managed" as const, reused: true },
    { serverKind: "external" as const, reused: true },
  ])("cancels pending setup and disposes a $serverKind result (reused=$reused)", async (ownership) => {
    const process = sshProcessFixture({ ...ownership, manualStop: true });
    spawn.mockImplementation(process.spawn);
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    const setup = expect(manager.ensureEnvironment(target)).rejects.toThrow("SSH connections are closed");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    expect(manager.close()).toBe(manager.close());
    await expect(manager.ensureEnvironment({ host: "another-host" })).rejects.toThrow("SSH connections are closed");
    expect(process.launches).toHaveLength(1);
    expect(closed).toBe(false);

    await vi.waitFor(() => expect(process.tunnels[0].kill).toHaveBeenCalledOnce());
    if (ownership.serverKind === "managed") {
      expect(closed).toBe(false);
      expect(process.stops).toHaveLength(1);
      process.finishStop();
    } else expect(process.stops).toHaveLength(0);
    await setup;
    await closing;
    await manager.disconnectEnvironment(target);
    expect(process.stops).toHaveLength(ownership.serverKind === "managed" ? 1 : 0);
  });

  it("shares pending setup, preserves reuse credentials, and reconnects only after reopening", async () => {
    const process = sshProcessFixture({ reused: true });
    spawn.mockImplementation(process.spawn);
    const [first, second] = await Promise.all([manager.ensureEnvironment(target), manager.ensureEnvironment(target)]);
    expect(first).toBe(second);
    expect(first.credential).toBeUndefined();
    expect(process.launches).toHaveLength(1);
    await manager.close();
    await expect(manager.ensureEnvironment(target)).rejects.toThrow("SSH connections are closed");
    await manager.reopen();
    const restored = await manager.ensureEnvironment(target);
    expect(restored.descriptor.environmentId).toBe("same-environment");
    expect(process.launches).toHaveLength(2);
    expect(process.stops).toHaveLength(1);
    expect(process.tunnels[1].killed).toBe(false);
  });

  it("does not return an existing connection whose readiness probe overlaps close", async () => {
    const process = sshProcessFixture();
    spawn.mockImplementation(process.spawn);
    await manager.ensureEnvironment(target);
    const descriptor = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(descriptor.promise);
    const probe = expect(manager.ensureEnvironment(target)).rejects.toThrow("SSH connections are closed");
    const closing = manager.close();
    descriptor.resolve(Response.json({ environmentId: "same-environment" }));
    await probe;
    await closing;
    expect(process.launches).toHaveLength(1);
    expect(process.stops).toHaveLength(1);
  });

  it.each([
    { error: "Host key verification failed", prompt: "trust" },
    { error: "Permission denied (publickey)", prompt: "password" },
  ])("does not start an auth retry after close during the $prompt prompt", async ({ error, prompt }) => {
    const answer = deferred<never>();
    const asked = deferred();
    const request = () => { asked.resolve(); return answer.promise; };
    manager = new SshEnvironmentManager({ stateDirectory: "/unused",
      ...(prompt === "trust" ? { requestHostTrust: request } : { requestPassword: request }),
    });
    const process = sshProcessFixture({ manualLaunch: true });
    spawn.mockImplementation(process.spawn);
    const setup = expect(manager.ensureEnvironment(target)).rejects.toThrow("SSH connections are closed");
    process.launches[0].stderr.emit("data", Buffer.from(error));
    process.launches[0].emit("exit", 255);
    await asked.promise;
    const closing = manager.close();
    await setup;
    await closing;
    await manager.reopen();
    answer.resolve(undefined as never);
    await Promise.resolve();
    expect(process.launches).toHaveLength(1);
  });

  it("cancels an SSH launch without waiting for its readiness result", async () => {
    const process = sshProcessFixture({ manualLaunch: true });
    spawn.mockImplementation(process.spawn);
    const setup = expect(manager.ensureEnvironment(target)).rejects.toThrow("SSH connections are closed");
    await manager.close();
    await setup;
    expect(process.launches[0].kill).toHaveBeenCalledOnce();
    expect(process.tunnels).toHaveLength(0);
    expect(process.launches[0].stdout.listenerCount("data")).toBe(0);
    // Late launch output/error cannot recreate resources or crash the shell.
    process.launchResult();
    expect(() => process.launches[0].emit("error", new Error("late spawn failure"))).not.toThrow();
    expect(process.tunnels).toHaveLength(0);
  });

  it("aborts a stuck descriptor body and its tunnel before close completes", async () => {
    const process = sshProcessFixture();
    spawn.mockImplementation(process.spawn);
    let signal!: AbortSignal;
    const readingBody = deferred();
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      signal = options!.signal!;
      return { ok: true, json: () => { readingBody.resolve(); return new Promise(() => {}); } } as Response;
    });
    const setup = expect(manager.ensureEnvironment(target)).rejects.toThrow("SSH connections are closed");
    await readingBody.promise;
    await manager.close();
    await setup;
    expect(signal.aborted).toBe(true);
    expect(process.tunnels[0].kill).toHaveBeenCalledOnce();
    expect(process.stops).toHaveLength(1);
  });

  it("cancels a real HTTP descriptor stream that never finishes", async () => {
    const bodyStarted = deferred();
    const responseClosed = deferred();
    const server = createServer((_request, response) => {
      response.once("close", () => responseClosed.resolve());
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"environmentId":');
      bodyStarted.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      vi.mocked(fetch).mockImplementation((_url, options) => nativeFetch(`http://127.0.0.1:${address.port}/`, options));
      const process = sshProcessFixture();
      spawn.mockImplementation(process.spawn);
      const setup = expect(manager.ensureEnvironment(target)).rejects.toThrow("SSH connections are closed");
      await bodyStarted.promise;
      await manager.close();
      await setup;
      await responseClosed.promise;
      expect(process.tunnels[0].killed).toBe(true);
      expect(process.stops).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["headers", "body"])("bounds readiness across stalled descriptor %s", async (stage) => {
    vi.useFakeTimers();
    const process = sshProcessFixture();
    spawn.mockImplementation(process.spawn);
    if (stage === "headers") vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    else vi.mocked(fetch).mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as Response);
    const bounded = expect(manager.ensureEnvironment(target)).rejects.toThrow("SSH operation timed out");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(process.tunnels[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await bounded;
    expect(process.tunnels.at(-1)!.kill).toHaveBeenCalledOnce();
    expect(process.stops).toHaveLength(1);
  });

  it("expires an unanswered password prompt and aborts its presentation", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const asked = deferred();
    manager = new SshEnvironmentManager({ stateDirectory: "/unused", requestPassword: (_target, _prompt, input) => {
      signal = input; asked.resolve(); return new Promise(() => {});
    } });
    const process = sshProcessFixture({ manualLaunch: true });
    spawn.mockImplementation(process.spawn);
    const setup = expect(manager.ensureEnvironment(target)).rejects.toThrow("SSH operation timed out");
    process.launches[0].stderr.emit("data", Buffer.from("Permission denied (publickey)"));
    process.launches[0].emit("exit", 255);
    await asked.promise;
    await vi.advanceTimersByTimeAsync(180_000);
    await setup;
    expect(signal.aborted).toBe(true);
    expect(process.launches).toHaveLength(1);
  });

  it("drains a disconnect already stopping an owned remote process", async () => {
    const process = sshProcessFixture({ manualStop: true });
    spawn.mockImplementation(process.spawn);
    await manager.ensureEnvironment(target);
    const disconnecting = manager.disconnectEnvironment(target);
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    process.finishStop();
    await disconnecting;
    await closing;
    expect(process.stops).toHaveLength(1);
  });

  it.each(["managed", "external"] as const)("cleans up only owned resources when tunnel spawn fails after a %s launch", async (serverKind) => {
    const process = sshProcessFixture({ serverKind });
    spawn.mockImplementation((command, args) => {
      if (args.includes("-N")) throw new Error("tunnel spawn failed");
      return process.spawn(command, args);
    });
    await expect(manager.ensureEnvironment(target)).rejects.toThrow("tunnel spawn failed");
    await manager.close();
    expect(process.stops).toHaveLength(serverKind === "managed" ? 1 : 0);
    expect(process.tunnels).toHaveLength(0);
  });
});
