/**
 * A manual end-to-end check of the Effect connection runtime against a
 * running GitGui server.
 *
 * Run it with a server on 127.0.0.1:3774 that accepts the bootstrap token
 * `test-bootstrap-token`:
 *
 *   GITGUI_SERVER_BOOTSTRAP_TOKEN=test-bootstrap-token \
 *     ./target/debug/gitgui-server --port 3774 --repository . --ephemeral
 *
 *   GITGUI_IT=1 npx vitest run src/integration.live.test.ts
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/socket/Socket";

import * as Connectivity from "./connection/connectivity.ts";
import * as ConnectionWakeups from "./connection/wakeups.ts";
import * as EnvironmentRegistry from "./connection/registry.ts";
import * as EnvironmentSupervisor from "./connection/supervisor.ts";
import { layer as connectionLayer } from "./connection/layer.ts";
import * as ClientCapabilities from "./platform/capabilities.ts";
import * as PlatformConnectionSource from "./platform/source.ts";
import { layerRemoteHttpClient } from "./rpc/http.ts";
import { bootstrapRemoteBearerSession } from "./authorization/remote.ts";
import { layerConnectionPersistence } from "./platform/catalog.ts";
import { PrimaryConnectionRegistration } from "./connection/catalog.ts";
import { PrimaryConnectionTarget } from "./connection/model.ts";
import { EnvironmentId } from "@gitgui/contracts/environment";

const HTTP_URL = process.env["GITGUI_IT_URL"] ?? "http://127.0.0.1:3774";
const BOOTSTRAP_TOKEN = process.env["GITGUI_IT_TOKEN"] ?? "test-bootstrap-token";

const live = process.env["GITGUI_IT"] === "1";

describe.skipIf(!live)("live connection runtime", () => {
  it(
    "connects to a running GitGui server and lists its repositories",
    async () => {
      const descriptor = await fetch(
        new URL("/.well-known/gitgui/environment", HTTP_URL).toString(),
      ).then((response) => response.json() as Promise<{ environmentId: string; label: string }>);
      const exchanged = await Effect.runPromise(
        bootstrapRemoteBearerSession({
          httpBaseUrl: HTTP_URL,
          credential: BOOTSTRAP_TOKEN,
          scopes: ["repository:read", "repository:operate"],
        }).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch))),
      );

      const program = Effect.gen(function* () {
        const networkStatus = yield* SubscriptionRef.make<"online" | "offline">("online");
        const wakeups = yield* SubscriptionRef.make<ConnectionWakeups.ConnectionWakeup>(
          "application-active",
        );
        const layer = connectionLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerRemoteHttpClient(globalThis.fetch),
              layerConnectionPersistence({
                read: () => Promise.resolve({ schemaVersion: 1, environments: [] }),
                write: () => Promise.resolve(),
                readCredential: () => Promise.resolve(undefined),
                writeCredential: () => Promise.resolve(),
                removeCredential: () => Promise.resolve(),
              }),
              Socket.layerWebSocketConstructorGlobal,
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
                ClientCapabilities.ClientPresentation,
                ClientCapabilities.ClientPresentation.of({
                  metadata: { surface: "web", deviceType: "desktop" },
                }),
              ),
              Layer.succeed(
                ClientCapabilities.PrimaryEnvironmentAuth,
                ClientCapabilities.PrimaryEnvironmentAuth.of({
                  bearerToken: Effect.succeed(Option.some(exchanged.access_token)),
                }),
              ),
              Layer.succeed(
                ClientCapabilities.SshEnvironmentGateway,
                ClientCapabilities.SshEnvironmentGateway.of({
                  prepare: () => Effect.die("unused"),
                  disconnect: () => Effect.void,
                }),
              ),
              Layer.succeed(
                PlatformConnectionSource.PlatformConnectionSource,
                PlatformConnectionSource.PlatformConnectionSource.of({
                  registrations: Stream.succeed([
                    new PrimaryConnectionRegistration({
                      target: new PrimaryConnectionTarget({
                        environmentId: EnvironmentId.make(descriptor.environmentId),
                        label: descriptor.label,
                        httpBaseUrl: HTTP_URL,
                        wsBaseUrl: HTTP_URL.replace(/^http/, "ws"),
                      }),
                    }),
                  ]),
                }),
              ),
            ),
          ),
        );

        return yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
          const environmentId = EnvironmentId.make(descriptor.environmentId);
          // The platform source registers the primary environment
          // asynchronously.
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const entries = yield* SubscriptionRef.get(registry.entries);
            if (entries.has(environmentId)) break;
            yield* Effect.sleep("50 millis");
          }
          return yield* registry.run(
            environmentId,
            Effect.gen(function* () {
              const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
              for (let attempt = 0; attempt < 100; attempt += 1) {
                const state = yield* SubscriptionRef.get(supervisor.state);
                if (state.phase === "connected") break;
                if (state.phase === "blocked") {
                  return yield* Effect.fail(
                    new Error(`The environment was blocked: ${state.lastFailure?.detail ?? ""}`),
                  );
                }
                yield* Effect.sleep("50 millis");
              }
              const session = yield* SubscriptionRef.get(supervisor.session);
              if (Option.isNone(session)) {
                return yield* Effect.fail(
                  new Error("The environment connected without a session."),
                );
              }
              return yield* session.value.client.call("repositories.list", {});
            }),
          );
        }).pipe(Effect.provide(layer));
      });

      const result = await Effect.runPromise(program.pipe(Effect.timeout("20 seconds")));
      expect(Array.isArray(result.repositories)).toBe(true);
    },
    30_000,
  );
});
