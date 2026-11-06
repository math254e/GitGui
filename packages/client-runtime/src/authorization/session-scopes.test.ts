import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EnvironmentId } from "@gitgui/contracts/environment";
import { ClientPresentation } from "../platform/capabilities.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { RemoteEnvironmentAuthorization, layer } from "./service.ts";

const id = EnvironmentId.make("scope-test");
const input = { expectedEnvironmentId: id, httpBaseUrl: "https://scope.test", wsBaseUrl: "wss://scope.test", bearerToken: "fixture-secret", connectionMethod: "direct" as const };
const descriptor = { schemaVersion: 1, environmentId: id, label: "Test", serverVersion: "test", protocolVersion: 2,
  platform: "linux", architecture: "x64", capabilities: ["repositories.open", "repositories.create", "repositories.remove"],
  auth: { required: true, bootstrapMethods: [], sessionMethods: ["bearer"] }, endpoints: [] };
const dependencies = (fetchFn: typeof fetch) => layer.pipe(Layer.provide(Layer.mergeAll(
  layerRemoteHttpClient(fetchFn), Layer.succeed(ClientPresentation, { metadata: {} }),
)));

describe("authenticated session scopes", () => {
  it.effect("reads current grants on every preparation, independently of advertised capabilities and descriptor caching", () => Effect.gen(function* () {
    let scopes = ["repository:read", "repository:operate"];
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      requests.push(url.pathname);
      if (url.pathname === "/.well-known/gitgui/environment") return Response.json(descriptor);
      expect(new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined)).get("authorization")).toBe("Bearer fixture-secret");
      expect(url.search).toBe("");
      if (url.pathname === "/api/auth/session") {
        expect(init?.cache).toBe("no-store");
        return Response.json({ environmentId: id, sessionId: "one", scopes, expiresAtUnixMs: Date.now() + 60_000 });
      }
      return Response.json({ ticket: "single-use", expiresIn: 300 });
    };
    const auth = yield* RemoteEnvironmentAuthorization.pipe(Effect.provide(dependencies(fetchFn)));
    const limited = yield* auth.authorizeBearer(input);
    expect(limited.sessionScopes).toEqual(scopes);
    scopes = [...scopes, "repository:manage"];
    const full = yield* auth.authorizeBearer({ ...input, connectionMethod: "ssh" });
    expect(full.sessionScopes).toEqual(scopes);
    expect(limited.sessionScopes).not.toContain("repository:manage");
    expect(Object.isFrozen(full.sessionScopes)).toBe(true);
    expect(requests.filter((path) => path === "/api/auth/session")).toHaveLength(2);
    expect(requests.indexOf("/api/auth/session")).toBeLessThan(requests.indexOf("/api/auth/websocket-ticket"));
    expect(JSON.stringify(full.sessionScopes)).not.toContain("fixture-secret");
  }));

  for (const failure of ["wrong-environment", "malformed", "denied", "unavailable"] as const) {
    it.effect(`does not mint a ticket when session authorization is ${failure}`, () => Effect.gen(function* () {
      let tickets = 0;
      const auth = yield* RemoteEnvironmentAuthorization.pipe(Effect.provide(dependencies(async (request) => {
        const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
        if (path === "/.well-known/gitgui/environment") return Response.json(descriptor);
        if (path === "/api/auth/websocket-ticket") { tickets++; return Response.json({ ticket: "unused", expiresIn: 300 }); }
        if (failure === "denied") return new Response(null, { status: 401 });
        if (failure === "unavailable") return new Response(null, { status: 503 });
        return Response.json(failure === "malformed" ? { scopes: "repository:manage" }
          : { environmentId: "other", sessionId: "one", scopes: ["repository:manage"], expiresAtUnixMs: Date.now() + 60_000 });
      })));
      const error = yield* auth.authorizeBearer(input).pipe(Effect.flip);
      expect(error._tag).toBe(failure === "unavailable" || failure === "malformed" ? "ConnectionTransientError" : "ConnectionBlockedError");
      expect(tickets).toBe(0);
      expect(JSON.stringify(error)).not.toContain("fixture-secret");
    }));
  }
});
