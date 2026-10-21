/**
 * Vendored from T3 Code (`packages/client-runtime/src/connection/registry.test.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - GitGui has no relay, so the relay removal and GitHub routing trust cases
 *   are gone.
 * - GitGui keys a credential by its environment, not by its connection.
 */
import { EnvironmentId } from "@gitgui/contracts/environment";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";

import * as EnvironmentRegistry from "./registry.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  PrimaryConnectionRegistration,
  type ConnectionCredential,
  type ConnectionProfile,
  type ConnectionRegistration,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type PersistedConnectionTarget,
} from "./model.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-2");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Desk",
  connectionId: "bearer:lan",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: "Desk",
  httpBaseUrl: ENDPOINT.httpBaseUrl,
  wsBaseUrl: ENDPOINT.wsBaseUrl,
});
const BEARER_REGISTRATION = new BearerConnectionRegistration({
  target: BEARER_TARGET,
  profile: BEARER_PROFILE,
  credential: new BearerConnectionCredential({ token: "bearer-token" }),
});

const PRIMARY_TARGET = new PrimaryConnectionTarget({
  environmentId: OTHER_ENVIRONMENT_ID,
  label: "Primary",
  httpBaseUrl: ENDPOINT.httpBaseUrl,
  wsBaseUrl: ENDPOINT.wsBaseUrl,
});

const makeDependencies = Effect.fn("TestConnectionRegistry.makeDependencies")(function* (options?: {
  readonly targets?: ReadonlyArray<ConnectionTarget>;
  readonly disabled?: ReadonlyArray<EnvironmentId>;
}) {
  const targets = [...(options?.targets ?? [])];
  const disabled = new Set<EnvironmentId>(options?.disabled ?? []);
  const registrations = new Map<string, ConnectionRegistration>();
  const routes = new Map<string, ReadonlyArray<PersistedConnectionTarget>>();
  const credentials = new Map<string, ConnectionCredential>();
  const profiles = new Map<string, ConnectionProfile>();

  const targetStore = Persistence.ConnectionTargetStore.of({
    list: Effect.succeed(targets),
    listDisabled: Effect.succeed([...disabled]),
  });
  const registrationStore = Persistence.ConnectionRegistrationStore.of({
    register: (registration, persistedRoutes) =>
      Effect.sync(() => {
        registrations.set(registration.target.environmentId, registration);
        routes.set(registration.target.environmentId, persistedRoutes);
      }),
    setRoutes: (environmentId, persistedRoutes) =>
      Effect.sync(() => void routes.set(environmentId, persistedRoutes)),
    remove: (environmentId) =>
      Effect.sync(() => {
        registrations.delete(environmentId);
        routes.delete(environmentId);
      }),
    setEnabled: (environmentId, enabled) =>
      Effect.sync(() => {
        if (enabled) {
          disabled.delete(environmentId);
        } else {
          disabled.add(environmentId);
        }
      }),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (environmentId) => Effect.succeed(Option.fromNullishOr(credentials.get(environmentId))),
    put: (environmentId, credential) =>
      Effect.sync(() => void credentials.set(environmentId, credential)),
    remove: (environmentId) => Effect.sync(() => void credentials.delete(environmentId)),
  });
  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });

  const networkStatus = yield* SubscriptionRef.make<"online" | "offline">("online");
  const wakeups = yield* SubscriptionRef.make<ConnectionWakeups.ConnectionWakeup>("application-active");

  const layerDependencies = Layer.mergeAll(
    Layer.succeed(Persistence.ConnectionTargetStore, targetStore),
    Layer.succeed(Persistence.ConnectionRegistrationStore, registrationStore),
    Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, {
      clear: () => Effect.void,
    }),
    Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
    Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({
        status: SubscriptionRef.get(networkStatus),
        changes: SubscriptionRef.changes(networkStatus),
      }),
    ),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        changes: SubscriptionRef.changes(wakeups).pipe(Stream.drop(1)),
      }),
    ),
    Layer.succeed(
      ConnectionDriver.ConnectionDriver,
      ConnectionDriver.ConnectionDriver.of({
        connect: () =>
          Effect.fail(
            new ConnectionTransientError({ reason: "transport", detail: "Not used." }),
          ) as Effect.Effect<never, ConnectionAttemptError>,
        checkRoute: () => Effect.succeed<ConnectionDriver.RouteCheck>("unchecked"),
        preflight: () => Effect.succeed(false),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.SshEnvironmentGateway,
      ClientCapabilities.SshEnvironmentGateway.of({
        prepare: () => Effect.die("unused"),
        disconnect: () => Effect.void,
      }),
    ),
  );

  return {
    dependencies: layerDependencies,
    registrations,
    routes,
    credentials,
    profiles,
    networkStatus,
    wakeups,
  };
});

describe("EnvironmentRegistry", () => {
  it.effect("registers a saved environment and keeps its routes", () =>
    Effect.gen(function* () {
      const harness = yield* makeDependencies();
      const registry = yield* EnvironmentRegistry.make.pipe(
        Effect.provide(harness.dependencies),
      );

      const registered = yield* registry.register(BEARER_REGISTRATION);
      expect(registered).toBe(true);

      const entries = yield* SubscriptionRef.get(registry.entries);
      expect([...entries.keys()]).toEqual([ENVIRONMENT_ID]);
      expect(harness.registrations.get(ENVIRONMENT_ID)).toBeDefined();
      expect(harness.routes.get(ENVIRONMENT_ID)).toEqual([BEARER_TARGET]);
    }),
  );

  it.effect("removes an environment and its saved credential", () =>
    Effect.gen(function* () {
      const harness = yield* makeDependencies();
      const registry = yield* EnvironmentRegistry.make.pipe(
        Effect.provide(harness.dependencies),
      );

      yield* registry.register(BEARER_REGISTRATION);
      yield* registry.remove(ENVIRONMENT_ID);

      const entries = yield* SubscriptionRef.get(registry.entries);
      expect(entries.size).toBe(0);
      expect(harness.registrations.has(ENVIRONMENT_ID)).toBe(false);
    }),
  );

  it.effect("keeps a platform-managed environment out of removal", () =>
    Effect.gen(function* () {
      const harness = yield* makeDependencies();
      const registry = yield* EnvironmentRegistry.make.pipe(
        Effect.provide(harness.dependencies),
      );

      yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: PRIMARY_TARGET }));

      const entries = yield* SubscriptionRef.get(registry.entries);
      expect(entries.has(OTHER_ENVIRONMENT_ID)).toBe(true);

      const error = yield* registry.remove(OTHER_ENVIRONMENT_ID).pipe(Effect.flip);
      expect(error._tag).toBe("PlatformEnvironmentRemovalError");
      expect((yield* SubscriptionRef.get(registry.entries)).has(OTHER_ENVIRONMENT_ID)).toBe(true);
    }),
  );

  it.effect("loads persisted routes when the registry starts", () =>
    Effect.gen(function* () {
      const harness = yield* makeDependencies({
        targets: [BEARER_TARGET],
        disabled: [ENVIRONMENT_ID],
      });
      const registry = yield* EnvironmentRegistry.make.pipe(
        Effect.provide(harness.dependencies),
      );

      yield* registry.start;
      const entries = yield* SubscriptionRef.get(registry.entries);
      expect(entries.has(ENVIRONMENT_ID)).toBe(true);
      expect(entries.get(ENVIRONMENT_ID)?.enabled).toBe(false);
    }),
  );

  it.effect("keeps the entries of an unregistered environment out of the catalog", () =>
    Effect.gen(function* () {
      const harness = yield* makeDependencies();
      const registry = yield* EnvironmentRegistry.make.pipe(
        Effect.provide(harness.dependencies),
      );

      const entries = yield* SubscriptionRef.get(registry.entries);
      expect(entries.size).toBe(0);
    }),
  );
});
