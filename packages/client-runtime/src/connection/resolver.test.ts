/**
 * Vendored from T3 Code (`packages/client-runtime/src/connection/resolver.test.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - GitGui has no DPoP and no relay, so the DPoP and relay cases are gone.
 * - The compatibility check compares the GitGui protocol version instead of the
 *   orchestration protocol version.
 */
import { EnvironmentId } from "@gitgui/contracts/environment";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};

function catalogEntry(
  target: ConnectionTarget,
  profile: Option.Option<ConnectionProfile> = Option.none(),
): ConnectionCatalogEntry {
  return { target, profile, enabled: true };
}

const descriptorBody = (protocolVersion: number, environmentId: string) => ({
  schemaVersion: 1,
  environmentId,
  label: "Compatible environment",
  serverVersion: "0.0.0-test",
  protocolVersion,
  platform: "linux",
  architecture: "x64",
  capabilities: ["repositories.list"],
  auth: { required: true, bootstrapMethods: ["pairing"], sessionMethods: ["bearer"] },
  endpoints: [],
});

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly authorizeBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly primaryBearerToken?: string;
  readonly protocolVersion?: number;
  readonly environmentId?: string;
}) => {
  const profiles = new Map(
    (options?.profiles ?? []).map((profile) => [profile.connectionId, profile]),
  );
  const credentials = new Map(options?.credentials ?? []);

  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => void credentials.set(connectionId, credential)),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer:
      options?.authorizeBearer ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized bearer environment",
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=bearer",
          httpAuthorization: {
            _tag: "Bearer" as const,
            token: input.bearerToken,
          },
        })),
  });
  const ssh = ClientCapabilities.SshEnvironmentGateway.of({
    prepare: () => Effect.die("unused"),
    disconnect: () => Effect.void,
  });

  const layerDependencies = Layer.mergeAll(
    layerRemoteHttpClient((() =>
      Promise.resolve(
        Response.json(
          descriptorBody(options?.protocolVersion ?? 2, options?.environmentId ?? ENVIRONMENT_ID),
        ),
      )) satisfies typeof fetch),
    Layer.succeed(
      ConnectionProfileStore.ConnectionProfileStore,
      profileStore,
    ),
    Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeed(Option.fromNullishOr(options?.primaryBearerToken)),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: { appVersion: "0.0.0-test", deviceType: "desktop", surface: "web" },
      }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provide(layerDependencies)));
});

const PRIMARY_TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Primary environment",
  httpBaseUrl: ENDPOINT.httpBaseUrl,
  wsBaseUrl: ENDPOINT.wsBaseUrl,
});

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Bearer environment",
  connectionId: "bearer:lan",
});

const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: "Bearer environment",
  httpBaseUrl: ENDPOINT.httpBaseUrl,
  wsBaseUrl: ENDPOINT.wsBaseUrl,
});

describe("ConnectionResolver", () => {
  it.effect("prepares a primary environment with its bearer session", () =>
    Effect.gen(function* () {
      const layer = yield* makeDependencies({ primaryBearerToken: "primary-bearer" });
      const resolver = yield* Effect.provide(
        ConnectionResolver.ConnectionResolver,
        layer,
      );

      const prepared = yield* resolver.prepare(
        catalogEntry(PRIMARY_TARGET),
      );
      expect(prepared.environmentId).toBe(ENVIRONMENT_ID);
      expect(prepared.httpAuthorization).toEqual({
        _tag: "Bearer",
        token: "primary-bearer",
      });
    }),
  );

  it.effect("blocks a primary environment without a credential", () =>
    Effect.gen(function* () {
      const layer = yield* makeDependencies({});
      const resolver = yield* Effect.provide(
        ConnectionResolver.ConnectionResolver,
        layer,
      );

      const error = yield* resolver
        .prepare(catalogEntry(PRIMARY_TARGET))
        .pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(error.reason).toBe("authentication");
    }),
  );

  it.effect("blocks a bearer environment whose credential is missing", () =>
    Effect.gen(function* () {
      const layer = yield* makeDependencies({ profiles: [BEARER_PROFILE] });
      const resolver = yield* Effect.provide(
        ConnectionResolver.ConnectionResolver,
        layer,
      );

      const error = yield* resolver
        .prepare(catalogEntry(BEARER_TARGET, Option.some(BEARER_PROFILE)))
        .pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(error.reason).toBe("authentication");
    }),
  );

  it.effect("blocks a bearer environment whose profile is missing", () =>
    Effect.gen(function* () {
      const layer = yield* makeDependencies({});
      const resolver = yield* Effect.provide(
        ConnectionResolver.ConnectionResolver,
        layer,
      );

      const error = yield* resolver
        .prepare(catalogEntry(BEARER_TARGET))
        .pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(error.reason).toBe("configuration");
    }),
  );

  it.effect("blocks an environment whose protocol version is incompatible", () =>
    Effect.gen(function* () {
      const layer = yield* makeDependencies({
        primaryBearerToken: "primary-bearer",
        protocolVersion: 99,
      });
      const resolver = yield* Effect.provide(
        ConnectionResolver.ConnectionResolver,
        layer,
      );

      const error = yield* resolver
        .prepare(catalogEntry(PRIMARY_TARGET))
        .pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(error.reason).toBe("unsupported");
    }),
  );

  it.effect("blocks an environment that answers with a different identity", () =>
    Effect.gen(function* () {
      const layer = yield* makeDependencies({
        primaryBearerToken: "primary-bearer",
        environmentId: "another-environment",
      });
      const resolver = yield* Effect.provide(
        ConnectionResolver.ConnectionResolver,
        layer,
      );

      const error = yield* resolver
        .prepare(catalogEntry(PRIMARY_TARGET))
        .pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(error.reason).toBe("configuration");
    }),
  );

  it.effect("keeps a transient authorization failure retryable", () =>
    Effect.gen(function* () {
      const layer = yield* makeDependencies({
        primaryBearerToken: "primary-bearer",
        authorizeBearer: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "network",
              detail: "The environment did not answer.",
            }),
          ),
      });
      const resolver = yield* Effect.provide(
        ConnectionResolver.ConnectionResolver,
        layer,
      );

      const error = yield* resolver
        .prepare(catalogEntry(PRIMARY_TARGET))
        .pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionTransientError");
    }),
  );
});
