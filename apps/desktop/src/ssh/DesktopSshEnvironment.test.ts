// Adapted failure boundaries from T3 70cd258d DesktopSshEnvironment.test.ts;
// sender-bound acquisition IDs and close/reopen are GitGui IPC adaptations.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { BrowserWindow } from "electron";
import type { SshEnvironmentManager, SshEnvironmentManagerOptions } from "@gitgui/ssh";
import { SshFailure } from "@gitgui/ssh";
import { DesktopSshEnvironment } from "./DesktopSshEnvironment.js";

const presentations = vi.hoisted(() => new Map<string, { respond: (value: string | null) => void; closed: boolean }>());
vi.mock("electron", () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: {} }));
vi.mock("./DesktopSshPasswordPrompts.js", async importOriginal => ({
  ...await importOriginal<typeof import("./DesktopSshPasswordPrompts.js")>(),
  nativePasswordPresenter: () => ({ present(id: string, _prompt: string, respond: (value: string | null) => void) {
    const entry = { respond, closed: false }; presentations.set(id, entry);
    return { close() { entry.closed = true; } };
  } }),
}));

const environmentId = "11111111-1111-4111-8111-111111111111";
const target = { kind: "ssh" as const, host: "fixture" };
const services: DesktopSshEnvironment[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); presentations.clear(); });
function fixture() {
  let options!: SshEnvironmentManagerOptions;
  const manager: SshEnvironmentManager = {
    ensureEnvironment: vi.fn(() => Effect.succeed({ httpUrl: "http://127.0.0.1:40000", descriptor: { environmentId } } as any)),
    issuePairingCredential: vi.fn(() => Effect.succeed({ kind: "pairing" as const, token: "one-use-secret" })),
    claimConnection: vi.fn(() => Effect.void), cancelConnection: vi.fn(() => Effect.succeed("stopped" as const)),
    disconnectEnvironment: vi.fn(() => Effect.succeed([])), discoverHosts: vi.fn(() => Effect.succeed([])), close: Effect.void, reopen: Effect.void,
  };
  const initialized = Deferred.makeUnsafe<void>();
  const service = new DesktopSshEnvironment({ stateDirectory: "unused-fixture", getParent: () => null as BrowserWindow | null,
    makeManager: input => Effect.sync(() => { options = input; Deferred.doneUnsafe(initialized, Effect.void); return manager; }),
  });
  services.push(service);
  return { service, manager, ready: () => Effect.runPromise(Deferred.await(initialized)), options: () => options };
}

describe("desktop SSH operation ownership", () => {
  it("preserves a saved legacy environment identity at the IPC boundary", async () => {
    const f = fixture(); const id = randomUUID(); const legacyId = "gitgui-123456-1788413802919117400";
    expect((await f.service.ensureEnvironment(10, target, { operationId: id, expectedEnvironmentId: legacyId })).ok).toBe(true);
    expect(f.manager.ensureEnvironment).toHaveBeenCalledWith(target, { operationId: id, expectedEnvironmentId: legacyId });
    expect((await f.service.claimConnection(10, id, legacyId)).ok).toBe(true);
    expect(f.manager.claimConnection).toHaveBeenCalledWith(id, legacyId);
  });
  it("binds ensure, pairing, claim and cancellation to the initiating trusted sender", async () => {
    const f = fixture(); const id = randomUUID();
    expect((await f.service.ensureEnvironment(10, target, { operationId: id })).ok).toBe(true);
    for (const result of await Promise.all([
      f.service.issuePairingCredential(11, id, environmentId), f.service.claimConnection(11, id, environmentId),
      f.service.cancelConnection(11, id), f.service.ensureEnvironment(11, target, { operationId: id }),
    ])) expect(result).toMatchObject({ ok: false, error: { category: "cancelled" } });
    expect(f.manager.issuePairingCredential).not.toHaveBeenCalled(); expect(f.manager.claimConnection).not.toHaveBeenCalled();
    expect(f.manager.cancelConnection).not.toHaveBeenCalled();
    expect((await f.service.issuePairingCredential(10, id, environmentId)).ok).toBe(true);
    expect((await f.service.claimConnection(10, id, environmentId)).ok).toBe(true);
    expect(await f.service.cancelConnection(10, id)).toEqual({ ok: true, value: "stopped" });
    expect(await f.service.claimConnection(10, id, environmentId)).toMatchObject({ ok: false, error: { category: "cancelled" } });
  });

  it("tombstones cancellation before ensure arrives, across close/reopen and senders", async () => {
    const f = fixture(); const id = randomUUID();
    expect((await f.service.cancelConnection(10, id)).ok).toBe(true);
    await f.service.close(); await f.service.reopen();
    expect(await f.service.ensureEnvironment(10, target, { operationId: id })).toMatchObject({ ok: false, error: { category: "cancelled" } });
    expect(await f.service.ensureEnvironment(11, target, { operationId: id })).toMatchObject({ ok: false, error: { category: "cancelled" } });
    expect(f.manager.ensureEnvironment).not.toHaveBeenCalled();
  });

  it("checks cancellation again after asynchronous service initialization", async () => {
    const f = fixture(); const id = randomUUID();
    const connecting = f.service.ensureEnvironment(10, target, { operationId: id });
    const cancelling = f.service.cancelConnection(10, id);
    expect(await connecting).toMatchObject({ ok: false, error: { category: "cancelled" } });
    await cancelling; expect(f.manager.ensureEnvironment).not.toHaveBeenCalled();
  });

  it("releases only the crashed renderer's operations and retains their sender tombstones", async () => {
    const f = fixture(); const first = randomUUID(); const second = randomUUID();
    await f.service.ensureEnvironment(10, target, { operationId: first });
    await f.service.ensureEnvironment(11, target, { operationId: second });
    await f.service.releaseSender(10);
    expect(f.manager.cancelConnection).toHaveBeenCalledExactlyOnceWith(first);
    expect((await f.service.claimConnection(11, second, environmentId)).ok).toBe(true);
    expect(await f.service.issuePairingCredential(10, first, environmentId)).toMatchObject({ ok: false, error: { category: "cancelled" } });
  });

  it("returns typed static failures without exposing exception diagnostics", async () => {
    const f = fixture(); await f.ready();
    vi.mocked(f.manager.ensureEnvironment).mockImplementation(() => Effect.die(new Error("private remote diagnostics")));
    const result = await f.service.ensureEnvironment(10, target, { operationId: randomUUID() });
    expect(result).toMatchObject({ ok: false, error: { category: "transport" } });
    expect(JSON.stringify(result)).not.toContain("private remote diagnostics");
  });

  it("closes scoped prompts during shutdown and uses fresh prompt finalizers after reopening", async () => {
    const f = fixture(); await f.ready();
    let scope = Scope.makeUnsafe("sequential");
    // This fixture manager models the same operation-scope boundary as the real
    // manager. The presenter and prompt Deferred registry are the production ones.
    f.manager.close = Effect.suspend(() => Scope.close(scope, Exit.void));
    // Interrupt the actual request with a scope-owned fiber, as the manager does.
    vi.mocked(f.manager.ensureEnvironment).mockImplementation(() => Effect.gen(function* () {
      const result = yield* Deferred.make<never, SshFailure>();
      yield* f.options().requestPassword!({ alias: "fixture", hostname: "fixture", username: null, port: 22 }, "Password").pipe(
        Effect.andThen(Effect.fail(new SshFailure({ category: "authentication", message: "fixture complete" }))),
        Effect.onExit(exit => Deferred.done(result, exit).pipe(Effect.asVoid)), Effect.forkIn(scope),
      );
      return yield* Deferred.await(result);
    }));
    const first = f.service.ensureEnvironment(10, target, { operationId: randomUUID() });
    await vi.waitFor(() => expect(presentations.size).toBe(1));
    await f.service.close(); expect((await first).ok).toBe(false);
    const old = [...presentations.values()][0]; expect(old.closed).toBe(true);
    scope = Scope.makeUnsafe("sequential");
    await f.service.reopen();
    const second = f.service.ensureEnvironment(10, target, { operationId: randomUUID() });
    await vi.waitFor(() => expect(presentations.size).toBe(2));
    old.respond("late secret");
    const current = [...presentations.values()][1]; expect(current.closed).toBe(false);
    current.respond("new secret"); expect((await second).ok).toBe(false); expect(current.closed).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
