/** GitGui failure cases extending T3's onboarding/persistence test boundary. */
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@gitgui/contracts/environment";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { SshEnvironmentGateway } from "../platform/capabilities.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { RpcSessionFactory, type RpcSession } from "../rpc/session.ts";
import { ConnectionPersistenceError } from "../platform/persistence.ts";
import { ConnectionTransientError } from "./model.ts";
import { EnvironmentRegistry } from "./registry.ts";
import { make } from "./onboarding.ts";

const id = EnvironmentId.make("environment");
const descriptor = { schemaVersion: 1, environmentId: id, label: "Fixture", serverVersion: "1", protocolVersion: 2,
  platform: "linux", architecture: "x64", capabilities: [], endpoints: [],
  auth: { required: true, bootstrapMethods: ["pairing"], sessionMethods: ["bearer"] } };
const input = { target: { alias: "fixture", hostname: "fixture", identityFile: "/key" } };

const fixture = (options: { failSave?: boolean; failHandshake?: boolean; holdHandshake?: boolean } = {}) => Effect.gen(function* () {
  const events: string[] = [];
  const expectedIdentities: (EnvironmentId | undefined)[] = [];
  const opened = yield* Deferred.make<void>();
  const cancelled = yield* Deferred.make<void>();
  const gateway = Layer.succeed(SshEnvironmentGateway, {
    prepare: () => Effect.die("not a reconnect"), disconnect: () => Effect.void,
    provision: (_target, _credential, expectedIdentity) => {
      expectedIdentities.push(expectedIdentity);
      return Effect.succeed({ bootstrap: { environmentId: id, httpBaseUrl: "http://127.0.0.1:1", wsBaseUrl: "ws://127.0.0.1:1" },
      bearerToken: "fixture-bearer", descriptor, target: { ...input.target, remoteDataDirectory: "/persistent/fixture" },
      commit: Effect.sync(() => { events.push("claim"); }),
      cancel: Effect.sync(() => { events.push("cancel"); }).pipe(Effect.andThen(Deferred.succeed(cancelled, undefined))),
    }); },
  });
  const auth = Layer.succeed(RemoteEnvironmentAuthorization, {
    authorizeBearer: (request) => Effect.sync(() => {
      events.push("authorize");
      return { environmentId: request.expectedEnvironmentId, label: "Fixture", httpBaseUrl: request.httpBaseUrl,
        socketUrl: "ws://127.0.0.1:1/ws", httpAuthorization: { _tag: "Bearer" as const, token: request.bearerToken } };
    }),
  });
  const sessions = Layer.succeed(RpcSessionFactory, { connect: () => Effect.gen(function* () {
    events.push("open");
    yield* Effect.addFinalizer(() => Effect.sync(() => { events.push("close-preflight"); }));
    yield* Deferred.succeed(opened, undefined);
    return { ready: options.holdHandshake ? Effect.never : options.failHandshake
      ? Effect.fail(new ConnectionTransientError({ reason: "transport", detail: "handshake lost" }))
      : Effect.sync(() => { events.push("ready"); }),
      welcome: Effect.never, initialConfig: Effect.never, probe: Effect.void, closed: Effect.never,
      pendingRequests: Effect.succeed(0), sequenceGaps: Stream.never,
      client: { call: () => Effect.never, events: Stream.never },
    } satisfies RpcSession;
  }) });
  const registry = Layer.succeed(EnvironmentRegistry, {
    register: (registration, settings) => Effect.gen(function* () {
      expect(registration.profile._tag === "SshConnectionProfile" && registration.profile.target.remoteDataDirectory).toBe("/persistent/fixture");
      events.push("save");
      if (options.failSave) return yield* new ConnectionPersistenceError({ operation: "register-connection", message: "disk failed" });
      if (settings !== undefined) yield* settings.beforeActivate;
      events.push("activate");
      if (settings?.onCommitted !== undefined) yield* settings.onCommitted;
      return true;
    }),
  } as EnvironmentRegistry["Service"]);
  const onboarding = yield* make.pipe(Effect.provide(Layer.mergeAll(gateway, auth, sessions, registry)));
  return { onboarding, events, opened, cancelled, expectedIdentities };
});

describe("SSH onboarding acquisition transaction", () => {
  it.effect("passes the saved recovery identity to acquisition before authentication", () => Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.onboarding.registerSsh({ ...input, expectedEnvironmentId: id });
    expect(f.expectedIdentities).toEqual([id]);
  }));

  it.effect("verifies and closes temporary RPC before save, claim and activation", () => Effect.gen(function* () {
    const f = yield* fixture();
    expect(yield* f.onboarding.registerSsh(input)).toBe(id);
    expect(f.events).toEqual(["authorize", "open", "ready", "close-preflight", "save", "claim", "activate"]);
  }));

  it.effect("cancels acquisition when persistence fails without claiming or activating", () => Effect.gen(function* () {
    const f = yield* fixture({ failSave: true });
    expect((yield* f.onboarding.registerSsh(input).pipe(Effect.flip))._tag).toBe("ConnectionPersistenceError");
    expect(f.events).toEqual(["authorize", "open", "ready", "close-preflight", "save", "cancel"]);
  }));

  it.effect("cancels a failed handshake before publishing any credential/registration", () => Effect.gen(function* () {
    const f = yield* fixture({ failHandshake: true });
    yield* f.onboarding.registerSsh(input).pipe(Effect.flip);
    expect(f.events).toEqual(["authorize", "open", "close-preflight", "cancel"]);
  }));

  it.effect("interrupts a stalled handshake and finalizes its acquisition once", () => Effect.gen(function* () {
    const f = yield* fixture({ holdHandshake: true });
    const pending = yield* Effect.forkChild(f.onboarding.registerSsh(input));
    yield* Deferred.await(f.opened);
    yield* Fiber.interrupt(pending);
    yield* Deferred.await(f.cancelled);
    expect(f.events).toEqual(["authorize", "open", "close-preflight", "cancel"]);
  }));
});
