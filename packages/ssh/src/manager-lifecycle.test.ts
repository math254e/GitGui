// Carries the old Promise manager's quit/update/prompt/body/late-result coverage
// into scoped boundaries. Upstream: T3 70cd258d tunnel.test.ts pending entries,
// failed process, reuse/disconnect, user overrides and scope finalization.
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { fixture, environmentId, secondEnvironmentId, instanceId, hostResponse, descriptor } from "../testing/manager-fixture.js";
import { SshFailure } from "./errors.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const setup = async (options: Parameters<typeof fixture>[0] = {}) => { const f = await fixture(options); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const failure = (category: SshFailure["category"] = "transport") => new SshFailure({ category, message: "fixture failure" });

describe("SSH manager scoped resource ownership", () => {
  it.each(["retained", "cleanup-pending"] as const)("reports %s for each disconnected acquisition without affecting another environment", async outcome => {
    const f = await setup(); const first = f.acquire(); const second = f.acquire("second");
    await Promise.all([first.promise, second.promise]);
    f.state.onHost = operation => operation === "cancel" ? Effect.succeed(hostResponse({
      version: 1, acquisitionId: first.id, expectedEnvironmentId: environmentId,
      instanceId, locator: { kind: "default" },
    }, outcome)) : undefined;
    expect(await f.run(f.manager.disconnectEnvironment({ kind: "ssh", host: "first" }))).toEqual([
      { operationId: first.id, outcome },
    ]);
    expect(f.state.live.size).toBe(1);
    expect(f.state.hostCalls.filter(call => call.operation === "cancel").map(call => call.request.acquisitionId)).toEqual([first.id]);
    expect((await readdir(join(f.directory, "cleanup"))).includes(`${first.id}.json`)).toBe(outcome === "cleanup-pending");
  });

  it("tombstones cancellation before ensure and rejects operation reuse after reopen", async () => {
    const f = await setup(); const id = randomUUID();
    expect(await f.run(f.manager.cancelConnection(id))).toBe("stopped");
    await expect(f.acquire("first", id).promise).rejects.toMatchObject({ category: "cancelled" });
    await f.run(f.manager.close); await f.run(f.manager.reopen);
    await expect(f.acquire("first", id).promise).rejects.toMatchObject({ category: "cancelled" });
    expect(f.state.hostCalls).toHaveLength(0);
  });

  it.each([false, true])("cancels unknown launch output and retains exact ownership (external=%s)", async external => {
    const f = await setup(); f.state.external = external;
    const launched = Deferred.makeUnsafe<void>(); const late = Deferred.makeUnsafe<ReturnType<typeof hostResponse>>();
    f.state.onHost = (operation, request) => operation === "ensure" ? Deferred.succeed(launched, undefined).pipe(Effect.andThen(Deferred.await(late))) : undefined;
    const op = f.acquire(); const rejected = expect(op.promise).rejects.toMatchObject({ category: "cancelled" });
    await f.run(Deferred.await(launched));
    const closing = f.run(f.manager.close);
    await rejected; await closing;
    const request = f.state.hostCalls.find(c => c.operation === "ensure")!.request;
    expect(f.state.hostCalls.find(c => c.operation === "cancel")!.request.acquisitionId).toBe(op.id);
    await f.run(Deferred.succeed(late, hostResponse(request)));
    expect(f.state.tunnels).toBe(0);
  });

  it("isolates shared waiters, cancels the owner before readiness, and preserves the successful waiter", async () => {
    const f = await setup(); const ready = Deferred.makeUnsafe<void>(); f.state.beforeTunnel = Deferred.await(ready);
    const first = f.acquire(); const rejected = expect(first.promise).rejects.toMatchObject({ category: "cancelled" });
    const second = f.acquire();
    await vi.waitFor(() => expect(f.state.hostCalls.filter(c => c.operation === "ensure")).toHaveLength(2));
    await vi.waitFor(() => expect(f.state.tunnels).toBe(1));
    // Let both waiters attach to the same Deferred before cancelling the first.
    await new Promise(resolve => setTimeout(resolve, 20));
    await f.run(f.manager.cancelConnection(first.id)); await rejected;
    expect(f.state.stopped).toEqual([]);
    await f.run(Deferred.succeed(ready, undefined));
    const connected = await second.promise;
    expect(connected.ssh!.operationId).toBe(second.id);
    expect(connected.credential).toBeUndefined();
    await f.run(f.manager.claimConnection(second.id, environmentId));
    expect(f.state.live.size).toBe(1);
    await f.run(f.manager.cancelConnection(first.id));
    expect(f.state.live.size).toBe(1);
    expect(await f.run(f.manager.cancelConnection(second.id))).toBe("released");
    expect(f.state.stopped).toEqual([1]);
    const release = f.state.hostCalls.find(c => c.operation === "release")!;
    expect(release.request.instanceId).toBeTruthy();
    expect(release.request.acquisitionId).toBe(second.id);
  });

  it("close drains local and remote finalizers, blocks admission, then reopens for update recovery", async () => {
    const f = await setup(); const first = f.acquire(); await first.promise;
    const stop = Deferred.makeUnsafe<void>(); f.state.beforeStop = Deferred.await(stop);
    let finished = false;
    const closing = f.run(f.manager.close).then(() => { finished = true; });
    await vi.waitFor(() => expect(f.state.stopped).toEqual([1]));
    expect(finished).toBe(false);
    await expect(f.acquire("second").promise).rejects.toMatchObject({ category: "cancelled" });
    await f.run(Deferred.succeed(stop, undefined)); await closing;
    await f.run(f.manager.reopen);
    await f.acquire().promise;
    expect(f.state.tunnels).toBe(2);
    expect(f.state.live).toEqual(new Set([2]));
  });

  it("drains a disconnect already in progress and cancels all pending target handles", async () => {
    const f = await setup(); await f.acquire().promise;
    const stop = Deferred.makeUnsafe<void>(); f.state.beforeStop = Deferred.await(stop);
    const disconnecting = f.run(f.manager.disconnectEnvironment({ kind: "ssh", host: "first" }));
    await vi.waitFor(() => expect(f.state.stopped).toEqual([1]));
    const closing = f.run(f.manager.close);
    await f.run(Deferred.succeed(stop, undefined)); await disconnecting; await closing;
    expect(f.state.stopped).toEqual([1]);
  });

  it.each(["authentication", "permission"] as const)("does not start an auth retry after close during a %s prompt", async category => {
    const prompt = Deferred.makeUnsafe<void>(); let disposed = false;
    const f = await setup({ requestPassword: () => Effect.acquireUseRelease(Effect.void, () => Deferred.succeed(prompt, undefined).pipe(Effect.andThen(Effect.never)), () => Effect.sync(() => { disposed = true; })) });
    f.state.onHost = operation => operation === "ensure" ? Effect.fail(failure(category)) : undefined;
    const op = f.acquire(); const rejected = expect(op.promise).rejects.toMatchObject({ category: category === "authentication" ? "cancelled" : category });
    if (category === "authentication") {
      await f.run(Deferred.await(prompt));
      // Scope shutdown converts pending prompt cancellation to a blocked result.
      await f.run(f.manager.close);
      expect(disposed).toBe(true);
      await rejected;
    } else await rejected;
    expect(f.state.hostCalls.filter(c => c.operation === "ensure")).toHaveLength(1);
  });

  it("prevents success when a shared readiness probe overlaps close", async () => {
    const f = await setup(); await f.acquire().promise;
    const entered = Deferred.makeUnsafe<void>(); const result = Deferred.makeUnsafe<ReturnType<typeof descriptor>>();
    f.state.probe = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(result)));
    const next = f.acquire(); const rejected = expect(next.promise).rejects.toMatchObject({ category: "cancelled" });
    await f.run(Deferred.await(entered)); await f.run(f.manager.close); await rejected;
    expect(f.state.stopped).toEqual([1]);
  });

  it("replaces a failed tunnel without an old finalizer closing its replacement", async () => {
    const f = await setup(); const first = f.acquire(); await first.promise;
    f.state.probe = id => id === 1 ? Effect.fail(failure()) : Effect.succeed(descriptor());
    const next = f.acquire(); await next.promise;
    expect(f.state.tunnels).toBe(2);
    expect(f.state.live).toEqual(new Set([1, 2]));
    await f.run(f.manager.cancelConnection(first.id));
    expect(f.state.live).toEqual(new Set([2]));
    const third = f.acquire(); await third.promise;
    expect(f.state.tunnels).toBe(2);
  });

  it("keeps two independent environments alive when one acquisition is cancelled or removed", async () => {
    const f = await setup(); const first = f.acquire(); const second = f.acquire("second");
    await Promise.all([first.promise, second.promise]);
    await f.run(f.manager.claimConnection(second.id, secondEnvironmentId));
    await f.run(f.manager.disconnectEnvironment({ kind: "ssh", host: "first" }));
    expect(f.state.live.size).toBe(1);
    const secondGrant = await f.run(f.manager.issuePairingCredential(second.id, secondEnvironmentId));
    expect(secondGrant.kind).toBe("pairing");
    expect(f.state.hostCalls.filter(c => c.operation === "cancel" || c.operation === "release").map(c => c.alias)).toEqual(["first"]);
  });

  it("removes an originally default acquisition by its saved resolved directory without removing another environment on that route", async () => {
    const f = await setup(); const first = f.acquire(); await first.promise;
    const otherId = randomUUID();
    f.state.onHost = (operation, request) => request.locator.kind === "directory" && request.locator.path === "/state/other"
      ? Effect.succeed({ ...hostResponse(request, operation === "claim" ? "claimed" : operation === "cancel" ? "stopped" : "ready"), environmentId: secondEnvironmentId, remoteDataDirectory: "/state/other" }) : undefined;
    f.state.probe = id => Effect.succeed(descriptor(id !== 1));
    await f.run(f.manager.ensureEnvironment({ kind: "ssh", host: "first", remoteDataDirectory: "/state/other" }, { operationId: otherId, expectedEnvironmentId: secondEnvironmentId }));
    await f.run(f.manager.disconnectEnvironment({ kind: "ssh", host: "first", remoteDataDirectory: "/state/first" }));
    expect(f.state.live).toEqual(new Set([2]));
    expect(f.state.hostCalls.filter(c => c.operation === "cancel").map(c => c.request.acquisitionId)).toEqual([first.id]);
    await f.run(f.manager.claimConnection(otherId, secondEnvironmentId));
  });

  it("keeps retired outcomes idempotent and bounds tombstones without re-admitting a stale ID", async () => {
    const f = await setup(); const first = f.acquire(); await first.promise;
    await f.run(f.manager.claimConnection(first.id, environmentId));
    expect(await f.run(f.manager.cancelConnection(first.id))).toBe("released");
    expect(await f.run(f.manager.cancelConnection(first.id))).toBe("released");
    // Filling the bounded, lightweight tombstone set must fail closed rather
    // than evicting the first ID and allowing delayed ensure IPC to launch it.
    for (let i = 1; i < 8192; i++) await f.run(f.manager.cancelConnection(randomUUID()));
    await expect(f.acquire().promise).rejects.toMatchObject({ category: "configuration" });
    await expect(f.acquire("first", first.id).promise).rejects.toMatchObject({ category: "cancelled" });
    await f.run(f.manager.close); await f.run(f.manager.reopen);
    expect(await f.run(f.manager.cancelConnection(first.id))).toBe("released");
    expect(f.state.hostCalls.filter(c => c.operation === "release")).toHaveLength(1);
  });

  it("pairs only on explicit request, pins identity and releases an uncertain claim result", async () => {
    const f = await setup(); const op = f.acquire(); const value = await op.promise;
    expect(value.ssh!.remoteDataDirectory).toBe("/state/first");
    expect(f.state.hostCalls.some(c => c.operation === "pairing")).toBe(false);
    await expect(f.run(f.manager.issuePairingCredential(op.id, secondEnvironmentId))).rejects.toMatchObject({ category: "identity" });
    const grant = await f.run(f.manager.issuePairingCredential(op.id, environmentId));
    expect(grant.token).toBe("fixture-one-use-secret");
    f.state.onHost = operation => operation === "claim" ? Effect.fail(failure()) : undefined;
    await expect(f.run(f.manager.claimConnection(op.id, environmentId))).rejects.toMatchObject({ category: "transport" });
    expect(await f.run(f.manager.cancelConnection(op.id))).toBe("released");
    expect(f.state.hostCalls.at(-1)!.operation).toBe("release");
  });

  it("rejects an independent pairing grant for a replacement process in the same environment", async () => {
    const f = await setup(); const op = f.acquire(); await op.promise;
    f.state.onHost = (operation, request) => operation === "pairing" ? Effect.succeed({ ...hostResponse(request), instanceId: randomUUID(), pairing: { credential: "must-not-escape", expiresIn: 600, scopes: [] } }) : undefined;
    await expect(f.run(f.manager.issuePairingCredential(op.id, environmentId))).rejects.toMatchObject({ category: "identity" });
    const pairing = f.state.hostCalls.find(c => c.operation === "pairing")!.request;
    expect(pairing.acquisitionId).toBe(op.id);
    expect(pairing.instanceId).toBe(instanceId);
    expect(pairing.expectedEnvironmentId).toBe(environmentId);
  });

  it("bounds both pairing auth prompts to 210s and finalizes the second prompt", async () => {
    let prompts = 0; let secondClosed = false;
    const f = await setup({ requestPassword: () => Effect.suspend(() => {
      prompts++;
      return prompts === 1 ? Effect.sleep(179_000).pipe(Effect.as("first-secret")) : Effect.never.pipe(Effect.ensuring(Effect.sync(() => { secondClosed = true; })));
    }) });
    const op = f.acquire(); await op.promise;
    f.state.onHost = operation => operation === "pairing" ? Effect.fail(failure("authentication")) : undefined;
    vi.useFakeTimers();
    try {
      const pairing = expect(f.run(f.manager.issuePairingCredential(op.id, environmentId))).rejects.toMatchObject({ category: "authentication", message: "SSH pairing authentication expired. Try connecting again." });
      await vi.waitFor(() => expect(prompts).toBe(1));
      await vi.advanceTimersByTimeAsync(179_000);
      expect(prompts).toBe(2); expect(secondClosed).toBe(false);
      await vi.advanceTimersByTimeAsync(31_000); await pairing;
      expect(secondClosed).toBe(true);
      expect(f.state.hostCalls.filter(c => c.operation === "pairing")).toHaveLength(2);
      expect(f.state.hostCalls.some(c => c.operation === "claim")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("preserves a non-secret pending-cleanup journal on host loss and reconciles after reopen", async () => {
    const f = await setup(); const op = f.acquire(); await op.promise;
    f.state.onHost = operation => operation === "cancel" ? Effect.fail(failure()) : undefined;
    expect(await f.run(f.manager.cancelConnection(op.id))).toBe("cleanup-pending");
    expect(await f.run(f.manager.cancelConnection(op.id))).toBe("cleanup-pending");
    const file = join(f.directory, "cleanup", `${op.id}.json`);
    const journal = await readFile(file, "utf8");
    expect(journal).toContain(op.id);
    expect(journal).not.toMatch(/fixture-one-use-secret|authSecret|bootstrap|credential|token/);
    await f.run(f.manager.close); await f.run(f.manager.reopen);
    f.state.onHost = undefined;
    await f.acquire().promise;
    expect(await readdir(join(f.directory, "cleanup"))).not.toContain(`${op.id}.json`);
  });

  it("rejects a different environment returned by the helper before starting a forward", async () => {
    const f = await setup(); const id = randomUUID();
    await expect(f.run(f.manager.ensureEnvironment({ kind: "ssh", host: "first" }, { operationId: id, expectedEnvironmentId: secondEnvironmentId }))).rejects.toMatchObject({ category: "identity" });
    expect(f.state.tunnels).toBe(0);
    expect(f.state.hostCalls.at(-1)!.operation).toBe("cancel");
  });

  it("reconciles pending ownership after a manager restart and refuses to overwrite its known acquisition ID", async () => {
    const f = await setup(); const op = f.acquire(); await op.promise;
    await f.run(f.manager.claimConnection(op.id, environmentId));
    f.state.onHost = operation => operation === "release" ? Effect.fail(failure()) : undefined;
    expect(await f.run(f.manager.cancelConnection(op.id))).toBe("cleanup-pending");
    const resumed = await setup({ stateDirectory: f.directory });
    expect(await resumed.run(resumed.manager.cancelConnection(op.id))).toBe("cleanup-pending");
    await expect(resumed.acquire("first", op.id).promise).rejects.toMatchObject({ category: "cancelled" });
    expect(resumed.state.hostCalls).toHaveLength(0);
    await resumed.acquire().promise;
    const release = resumed.state.hostCalls.find(c => c.operation === "release")!.request;
    expect(release.acquisitionId).toBe(op.id); expect(release.instanceId).toBe(instanceId);
    expect(release.locator).toEqual({ kind: "directory", path: "/state/first", environmentId });
    expect(await readdir(join(f.directory, "cleanup"))).not.toContain(`${op.id}.json`);
  });

  it("does not reconcile an unrelated route or pass malformed journal requests to the helper", async () => {
    const f = await setup(); const op = f.acquire(); await op.promise;
    f.state.onHost = operation => operation === "cancel" ? Effect.fail(failure()) : undefined;
    await f.run(f.manager.cancelConnection(op.id));
    const file = join(f.directory, "cleanup", `${op.id}.json`);
    const resumed = await setup({ stateDirectory: f.directory });
    await resumed.acquire("second").promise;
    expect(resumed.state.hostCalls.some(c => c.request.acquisitionId === op.id)).toBe(false);
    const record = JSON.parse(await readFile(file, "utf8")); record.request.locator = { kind: "directory", path: "relative", environmentId };
    await writeFile(file, JSON.stringify(record));
    await resumed.acquire().promise;
    expect(resumed.state.hostCalls.some(c => c.request.acquisitionId === op.id)).toBe(false);
    expect(await readFile(file, "utf8")).toContain("relative");
  });
});
