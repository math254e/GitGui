import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { EnvironmentId } from "@gitgui/contracts/environment";
import * as Authorization from "../authorization/service.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { ClientPresentation, PrimaryEnvironmentAuth, SshEnvironmentGateway } from "../platform/capabilities.ts";
import { BearerConnectionCredential, BearerConnectionProfile, SshConnectionProfile, type ConnectionProfile } from "./catalog.ts";
import { ConnectionCredentialStore } from "./credentialStore.ts";
import { ConnectionProfileStore } from "./profileStore.ts";
import { BearerConnectionTarget, PrimaryConnectionTarget, SshConnectionTarget } from "./model.ts";
import * as Resolver from "./resolver.ts";

const id = EnvironmentId.make("scope-resolution");
const httpBaseUrl = "https://scope.test", wsBaseUrl = "wss://scope.test";
const descriptor = { schemaVersion: 1, environmentId: id, label: "Test", serverVersion: "test", protocolVersion: 2,
  platform: "linux", architecture: "x64", capabilities: ["repositories.open", "repositories.create", "repositories.remove"],
  auth: { required: true, bootstrapMethods: [], sessionMethods: ["bearer"] }, endpoints: [] };

describe("scope propagation through connection targets", () => {
  for (const kind of ["primary", "bearer", "ssh"] as const) {
    for (const manage of [false, true]) {
      it.effect(`retains the ${manage ? "full" : "limited"} authenticated grant through ${kind}`, () => Effect.gen(function* () {
        const scopes = ["repository:read", "repository:operate", ...(manage ? ["repository:manage"] : [])];
        const target = kind === "primary"
          ? new PrimaryConnectionTarget({ environmentId: id, label: "Test", httpBaseUrl, wsBaseUrl })
          : kind === "bearer" ? new BearerConnectionTarget({ environmentId: id, label: "Test", connectionId: "direct" })
          : new SshConnectionTarget({ environmentId: id, label: "Test", connectionId: "ssh" });
        const profile: ConnectionProfile | null = kind === "bearer"
          ? new BearerConnectionProfile({ environmentId: id, label: "Test", connectionId: "direct", httpBaseUrl, wsBaseUrl })
          : kind === "ssh" ? new SshConnectionProfile({ environmentId: id, label: "Test", connectionId: "ssh", target: { alias: "host", hostname: "host" } }) : null;
        const base = Layer.mergeAll(
          layerRemoteHttpClient(async (request) => {
            const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
            if (path === "/.well-known/gitgui/environment") return Response.json(descriptor);
            if (path === "/api/auth/session") return Response.json({ environmentId: id, sessionId: "one", scopes, expiresAtUnixMs: Date.now() + 60_000 });
            return Response.json({ ticket: "one-use", expiresIn: 300 });
          }),
          Layer.succeed(ClientPresentation, { metadata: {} }),
          Layer.succeed(PrimaryEnvironmentAuth, { bearerToken: Effect.succeed(Option.some("fixture-only")) }),
          Layer.succeed(ConnectionCredentialStore, { get: () => Effect.succeed(Option.some(new BearerConnectionCredential({ token: "fixture-only" }))), put: () => Effect.void, remove: () => Effect.void }),
          Layer.succeed(ConnectionProfileStore, { get: () => Effect.succeed(Option.fromNullishOr(profile)), put: () => Effect.void, remove: () => Effect.void }),
          Layer.succeed(SshEnvironmentGateway, { prepare: () => Effect.succeed({ bootstrap: { environmentId: id, httpBaseUrl, wsBaseUrl }, bearerToken: "fixture-only" }), disconnect: () => Effect.void }),
        );
        const resolver = yield* Resolver.ConnectionResolver.pipe(Effect.provide(Resolver.layer.pipe(Layer.provide(Authorization.layer.pipe(Layer.provideMerge(base))))));
        const prepared = yield* resolver.prepare({ target, profile: Option.fromNullishOr(profile), enabled: true });
        expect(prepared.sessionScopes).toEqual(scopes);
        expect(prepared.target._tag).toBe(target._tag);
        expect(JSON.stringify(prepared.sessionScopes)).not.toContain("fixture-only");
      }));
    }
  }
});
