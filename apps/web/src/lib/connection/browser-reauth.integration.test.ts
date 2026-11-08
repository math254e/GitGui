import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { EnvironmentId } from "@gitgui/contracts/environment";
import { PrimaryConnectionRegistration } from "@gitgui/client-runtime/connection/catalog";
import { PrimaryConnectionTarget } from "@gitgui/client-runtime/connection/model";
import * as EnvironmentRegistry from "@gitgui/client-runtime/connection/registry";
import { PrimaryEnvironmentAuth } from "@gitgui/client-runtime/platform/capabilities";
import { ApplicationWorkspaceMetadataAdapter } from "../client-runtime/application-workspace-metadata";
import { ApplicationWorkspace } from "../client-runtime/application-workspace";
import { createCatalogBackend, type WebConnectionOptions } from "./platform";
import { WebApplicationRuntime } from "./runtime";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
}
const first = EnvironmentId.make("environment-first");
const second = EnvironmentId.make("environment-second");
const primary = EnvironmentId.make("environment-primary");
const descriptor = (environmentId: string) => ({ schemaVersion: 1, environmentId, label: environmentId, serverVersion: "0.1.0", protocolVersion: 2,
  platform: "linux", architecture: "x64", capabilities: [], auth: { bootstrapMethods: ["pairing"], sessionMethods: ["bearer"], required: true }, endpoints: [] });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
let options: WebConnectionOptions;
let runtime: WebApplicationRuntime | undefined;
let application: ApplicationWorkspace | undefined;
let tickets: string[];

beforeEach(() => {
  const win = Object.assign(new EventTarget(), { location: new URL("https://primary.test") });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("history", { state: null, replaceState: () => undefined });
  tickets = [];
  options = { desktop: null, storage: memoryStorage(), fetchFn: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const id = url.hostname === "b.test" ? second : url.hostname === "primary.test" ? primary : first;
    const authorization = new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization") ?? "";
    if (url.pathname === "/.well-known/gitgui/environment") return response(descriptor(id));
    if (url.pathname === "/oauth/token") return response({ access_token: `new-${id}`, token_type: "Bearer", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", expires_in: 3600, scope: "repository:read" });
    if (url.pathname === "/api/auth/session") return response({ environmentId: id, sessionId: "session", scopes: ["repository:read"], expiresAtUnixMs: Date.now() + 3600_000 });
    if (url.pathname === "/api/auth/websocket-ticket") { tickets.push(authorization); return response({ error: "unavailable" }, 503); }
    throw new Error(`Unexpected path ${url.pathname}`);
  }) };
});
afterEach(async () => { application?.dispose(); application = undefined; await runtime?.stop(); runtime = undefined; vi.unstubAllGlobals(); });

async function phase(environmentId: string, expected: string) {
  await vi.waitFor(() => {
    const entry = runtime?.state.registry.entries.find((item) => item.registration.environmentId === environmentId);
    expect(entry?.connection.phase).toBe(expected);
  }, { timeout: 4000 });
}

describe("browser re-pair with actual registry and storage", () => {
  it("restores saved routes and tabs, then retries with the new in-memory bearer after reload", async () => {
    runtime = new WebApplicationRuntime(options, { tabOwnership: "external" });
    await runtime.addDirect("https://a.test", { kind: "bearer", token: "old-first" });
    await runtime.addDirect("https://a2.test", { kind: "bearer", token: "old-first" });
    await runtime.addDirect("https://b.test", { kind: "bearer", token: "old-second" });
    const tabState = { tabs: [
      { tabId: "tab-first", target: { environmentId: first, repositoryId: "repo-first" } },
      { tabId: "tab-second", target: { environmentId: second, repositoryId: "repo-second" } },
    ], activeTabId: "tab-first" };
    new ApplicationWorkspaceMetadataAdapter(options.storage).save(tabState);
    expect(JSON.stringify([...Array(options.storage.length)].map((_, i) => options.storage.getItem(options.storage.key(i)!)))).not.toContain("old-first");
    await runtime.stop();

    runtime = new WebApplicationRuntime(options, { tabOwnership: "external" });
    await runtime.start();
    application = new ApplicationWorkspace(runtime, options.storage);
    await application.start();
    await phase(first, "blocked");
    await phase(second, "blocked");
    expect(application.state).toEqual(tabState);
    tickets = [];
    await runtime.addDirect("https://a.test", { kind: "pairing", token: "fresh-grant" });
    await vi.waitFor(() => expect(tickets).toContain(`Bearer new-${first}`), { timeout: 4000 });
    const catalog = await createCatalogBackend(options).read();
    expect(catalog.environments.find((item) => item.environmentId === first)?.routes).toHaveLength(2);
    expect(catalog.environments.find((item) => item.environmentId === second)).toBeDefined();
    expect(application.state).toEqual(tabState);
    expect(JSON.stringify([...Array(options.storage.length)].map((_, i) => options.storage.getItem(options.storage.key(i)!)))).not.toContain(`new-${first}`);
    const freshLayer = createCatalogBackend(options);
    expect(await freshLayer.readCredential(first)).toBeUndefined();
  });

  it("re-pairs a disconnected platform primary and lets its real supervisor retry", async () => {
    runtime = new WebApplicationRuntime(options, { tabOwnership: "external" });
    await runtime.start();
    const managed = runtime["runtime"];
    await managed.runPromise(Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: new PrimaryConnectionTarget({
        environmentId: primary, label: "Primary", httpBaseUrl: "https://primary.test/", wsBaseUrl: "wss://primary.test/",
      }) }));
    }));
    await phase(primary, "blocked");
    await runtime.addDirect("https://primary.test/", { kind: "pairing", token: "fresh-grant" });
    await vi.waitFor(() => expect(tickets).toContain(`Bearer new-${primary}`), { timeout: 4000 });
    expect(options.storage.getItem(`gitgui.credential.v3.${primary}`)).toBeNull();
  });

  it("retires a reusable URL bootstrap after replacing the primary session", async () => {
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: new URL("https://primary.test/#bootstrap=reusable-admin") }));
    let exchanges = 0;
    let rejectNarrow = false;
    options = { ...options, fetchFn: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const authorization = new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization") ?? "";
      if (url.pathname === "/.well-known/gitgui/environment") return response(descriptor(primary));
      if (url.pathname === "/oauth/token") {
        exchanges++;
        return response({ access_token: exchanges === 1 ? "admin-session" : "narrow-session", token_type: "Bearer", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", expires_in: 3600, scope: "repository:read" });
      }
      if (url.pathname === "/api/auth/session") return rejectNarrow && authorization === "Bearer narrow-session"
        ? response({ error: "unauthorized" }, 401)
        : response({ environmentId: primary, sessionId: "session", scopes: ["repository:read"], expiresAtUnixMs: Date.now() + 3600_000 });
      if (url.pathname === "/api/auth/websocket-ticket") return response({ error: "unavailable" }, 503);
      throw new Error(`Unexpected path ${url.pathname}`);
    }) };
    runtime = new WebApplicationRuntime(options, { tabOwnership: "external" });
    const managed = runtime["runtime"];
    const read = Effect.gen(function* () { return yield* (yield* PrimaryEnvironmentAuth).bearerToken; });
    await managed.runPromise(read);
    await managed.runPromise(Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: new PrimaryConnectionTarget({
        environmentId: primary, label: "Primary", httpBaseUrl: "https://primary.test/", wsBaseUrl: "wss://primary.test/",
      }) }));
    }));
    await runtime.addDirect("https://primary.test/", { kind: "pairing", token: "narrow-pairing" });
    rejectNarrow = true;
    await expect(managed.runPromise(read)).rejects.toMatchObject({ reason: "authentication" });
    expect(exchanges).toBe(2); // Initial bootstrap plus explicit pairing; no fallback.
  });
});
