import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@gitgui/contracts/environment";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { BearerConnectionCredential, SshConnectionProfile, SshConnectionRegistration, type ConnectionCredential } from "./catalog.ts";
import { ConnectionTransientError, SshConnectionTarget } from "./model.ts";
import * as Registry from "./registry.ts";
import * as Driver from "./driver.ts";
import * as Connectivity from "./connectivity.ts";
import * as Wakeups from "./wakeups.ts";
import { SshEnvironmentGateway } from "../platform/capabilities.ts";
import { EnvironmentOwnedDataCleanup } from "../platform/persistence.ts";
import { layerConnectionPersistence, makeRegistrationStore, type EnvironmentCatalogBackend } from "../platform/catalog.ts";
import type { PersistedEnvironmentCatalog } from "../platform/records.ts";

const id = EnvironmentId.make("removed");
const registration = (environmentId = id, token = "old") => new SshConnectionRegistration({
  target: new SshConnectionTarget({ environmentId, connectionId: `ssh:${environmentId}`, label: environmentId }),
  profile: new SshConnectionProfile({ environmentId, connectionId: `ssh:${environmentId}`, label: environmentId,
    target: { alias: environmentId, hostname: environmentId, remoteDataDirectory: `/state/${environmentId}` } }),
  credential: new BearerConnectionCredential({ token }),
});

class Backend implements EnvironmentCatalogBackend {
  catalog: PersistedEnvironmentCatalog = { schemaVersion: 1, environments: [] };
  credentials = new Map<string, ConnectionCredential>();
  failWrite = false;
  failSecret = false;
  failRead = false;
  async read() { if (this.failRead) throw new Error("read unavailable"); return this.catalog; }
  async write(catalog: PersistedEnvironmentCatalog) { if (this.failWrite) throw new Error("disk unavailable"); this.catalog = catalog; }
  async readCredential(id: string) { return this.credentials.get(id); }
  async writeCredential(id: string, credential: ConnectionCredential) { this.credentials.set(id, credential); }
  async removeCredential(id: string) { if (this.failSecret) throw new Error("credential unavailable"); this.credentials.delete(id); }
}

const harness = (backend = new Backend()) => {
  const calls: string[] = [];
  const failures = { cleanup: false, disconnect: false };
  const dependencies = Layer.mergeAll(
    layerConnectionPersistence(backend),
    Layer.succeed(Connectivity.Connectivity, { status: Effect.succeed("offline" as const), changes: Stream.never }),
    Layer.succeed(Wakeups.ConnectionWakeups, { changes: Stream.never }),
    Layer.succeed(Driver.ConnectionDriver, {
      connect: () => Effect.fail(new ConnectionTransientError({ reason: "transport", detail: "unused" })),
      checkRoute: () => Effect.succeed("unchecked"), preflight: () => Effect.succeed(false),
    }),
    Layer.succeed(SshEnvironmentGateway, {
      prepare: () => Effect.die("unused"),
      disconnect: (target) => Effect.sync(() => { calls.push(`disconnect:${target.hostname}`); }).pipe(
        Effect.andThen(Effect.suspend(() => failures.disconnect
          ? Effect.fail(new ConnectionTransientError({ reason: "transport", detail: "disconnect unavailable" })) : Effect.void))),
    }),
    Layer.succeed(EnvironmentOwnedDataCleanup, { clear: (id) => Effect.sync(() => {
      calls.push(`cleanup:${id}`);
      if (failures.cleanup) throw new Error("cache unavailable");
    }) }),
  );
  return { backend, calls, failures, make: Registry.make.pipe(Effect.provide(dependencies)) };
};

describe("environment removal transactions", () => {
  it.effect("preserves a registration, credentials and SSH when the durable catalog write fails", () => Effect.gen(function* () {
    const f = harness(), registry = yield* f.make;
    yield* registry.register(registration());
    f.backend.failWrite = true;
    expect(Exit.isFailure(yield* Effect.exit(registry.remove(id)))).toBe(true);
    expect((yield* SubscriptionRef.get(registry.entries)).has(id)).toBe(true);
    expect(f.backend.credentials.get(id)?.token).toBe("old");
    const completions: boolean[] = [];
    yield* registry.recoverRemoval(id, (removed) => Effect.sync(() => { completions.push(removed); }));
    expect(completions).toEqual([false]);
    expect(f.calls).toEqual([]);
  }));

  it.effect("recovers committed deletion after credential failure and restart without touching another environment", () => Effect.gen(function* () {
    const f = harness(), registry = yield* f.make, other = EnvironmentId.make("other");
    yield* registry.register(registration());
    yield* registry.register(registration(other, "other-secret"));
    f.backend.failSecret = true;
    expect(Exit.isFailure(yield* Effect.exit(registry.remove(id)))).toBe(true);
    expect(f.backend.catalog.environments.map((entry) => entry.environmentId)).toEqual([other]);
    expect((yield* SubscriptionRef.get(registry.entries)).has(id)).toBe(false);
    expect(f.calls).toEqual(["disconnect:removed"]);
    let acknowledged = false;
    const complete = () => Effect.sync(() => { acknowledged = true; });
    const restarted = harness(f.backend), recovered = yield* restarted.make;
    expect(Exit.isFailure(yield* Effect.exit(recovered.recoverRemoval(id, complete)))).toBe(true);
    expect(acknowledged).toBe(false);
    f.backend.failSecret = false;
    yield* recovered.recoverRemoval(id, complete);
    expect(acknowledged).toBe(true);
    expect(f.backend.credentials.has(id)).toBe(false);
    expect(f.backend.credentials.get(other)?.token).toBe("other-secret");
    expect(restarted.calls).toEqual(["cleanup:removed"]);
  }));

  it.effect("uses durable presence over stale memory in both directions and retains intent on read failure", () => Effect.gen(function* () {
    const f = harness(), registry = yield* f.make;
    yield* registry.register(registration());
    f.backend.catalog = { ...f.backend.catalog, environments: [] };
    let completed: boolean | undefined;
    const complete = (removed: boolean) => Effect.sync(() => { completed = removed; });
    f.backend.failRead = true;
    expect(Exit.isFailure(yield* Effect.exit(registry.recoverRemoval(id, complete)))).toBe(true);
    expect(completed).toBeUndefined();
    expect(f.calls).toEqual([]);
    f.backend.failRead = false;
    yield* registry.recoverRemoval(id, complete);
    expect(completed).toBe(true);
    expect(f.calls).toEqual(["disconnect:removed", "cleanup:removed"]);
    // An external durable replacement need not have reached the in-memory map.
    const store = yield* makeRegistrationStore(f.backend);
    yield* store.register(registration(id, "replacement"), [registration().target]);
    f.calls.length = 0;
    yield* registry.recoverRemoval(id, complete);
    expect(completed).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.backend.credentials.get(id)?.token).toBe("replacement");
  }));

  it.effect("disconnects SSH before owned-data failure and retries data after restart", () => Effect.gen(function* () {
    const f = harness(), registry = yield* f.make;
    yield* registry.register(registration());
    f.failures.cleanup = true;
    expect(Exit.isFailure(yield* Effect.exit(registry.remove(id)))).toBe(true);
    expect(f.calls).toEqual(["disconnect:removed", "cleanup:removed"]);
    expect((yield* SubscriptionRef.get(registry.entries)).has(id)).toBe(false);
    const restarted = harness(f.backend), recovered = yield* restarted.make;
    let completed = false;
    yield* recovered.recoverRemoval(id, (removed) => Effect.sync(() => { completed = removed; }));
    expect(completed).toBe(true);
    expect(restarted.calls).toEqual(["cleanup:removed"]);
  }));

  it.effect("retains SSH profiles for a rejected disconnect and retries before data completion", () => Effect.gen(function* () {
    const f = harness(), registry = yield* f.make;
    yield* registry.register(registration());
    f.failures.disconnect = true;
    expect(Exit.isFailure(yield* Effect.exit(registry.remove(id)))).toBe(true);
    expect((yield* SubscriptionRef.get(registry.entries)).has(id)).toBe(true);
    let completed = false;
    const complete = () => Effect.sync(() => { completed = true; });
    expect(Exit.isFailure(yield* Effect.exit(registry.recoverRemoval(id, complete)))).toBe(true);
    expect(completed).toBe(false);
    f.failures.disconnect = false;
    yield* registry.recoverRemoval(id, complete);
    expect(completed).toBe(true);
    expect(f.calls).toEqual(["disconnect:removed", "disconnect:removed", "disconnect:removed", "cleanup:removed"]);
  }));

  it.effect("retires a stale removal after re-registration without cleaning its data or credential", () => Effect.gen(function* () {
    const f = harness(), registry = yield* f.make;
    yield* registry.register(registration());
    f.failures.cleanup = true;
    yield* Effect.exit(registry.remove(id));
    yield* registry.register(registration(id, "new-secret"));
    f.calls.length = 0;
    let removed = true;
    yield* registry.recoverRemoval(id, (value) => Effect.sync(() => { removed = value; }));
    expect(removed).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.backend.credentials.get(id)?.token).toBe("new-secret");
  }));

  it.effect("holds the registration lease through asynchronous tab persistence and journal acknowledgement", () => Effect.gen(function* () {
    const f = harness(), registry = yield* f.make;
    yield* registry.register(registration());
    yield* registry.remove(id);
    const entered = yield* Deferred.make<void>(), release = yield* Deferred.make<void>();
    let completed = false;
    const cleaning = yield* Effect.forkChild(registry.recoverRemoval(id, (removed) => Effect.gen(function* () {
      expect(removed).toBe(true);
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      completed = true;
    })));
    yield* Deferred.await(entered);
    const registering = yield* Effect.forkChild(registry.register(registration(id, "new-secret")));
    yield* Effect.yieldNow;
    expect(f.backend.catalog.environments).toHaveLength(0);
    expect(completed).toBe(false);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(cleaning);
    yield* Fiber.join(registering);
    expect(f.backend.credentials.get(id)?.token).toBe("new-secret");
  }));

  it.effect("waits for an in-flight replacement before deciding whether tabs may be removed", () => Effect.gen(function* () {
    const f = harness(), registry = yield* f.make;
    const entered = yield* Deferred.make<void>(), release = yield* Deferred.make<void>();
    const registering = yield* Effect.forkChild(registry.register(registration(id, "new-secret"), {
      beforeActivate: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    }));
    yield* Deferred.await(entered);
    let removed: boolean | undefined;
    const cleaning = yield* Effect.forkChild(registry.recoverRemoval(id, (value) => Effect.sync(() => { removed = value; })));
    yield* Effect.yieldNow;
    expect(removed).toBeUndefined();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(registering);
    yield* Fiber.join(cleaning);
    expect(removed).toBe(false);
    expect(f.backend.credentials.get(id)?.token).toBe("new-secret");
    expect(f.calls).toEqual([]);
  }));
});
