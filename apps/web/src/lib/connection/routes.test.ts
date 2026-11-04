import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopConnectionRegistration, DesktopCredential } from "@gitgui/contracts/desktop";
import { createCatalogBackend, type WebConnectionOptions } from "./platform";
import { WebApplicationRuntime } from "./runtime";

// These route-catalog tests exercise the actual onboarding transaction with a
// responsive session service. Real HTTP/WebSocket tests qualify the transport.
vi.mock("@gitgui/client-runtime/rpc/session", async (original) => {
  const module = await original<typeof import("@gitgui/client-runtime/rpc/session")>();
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Stream = await import("effect/Stream");
  return { ...module, layer: () => Layer.succeed(module.RpcSessionFactory, {
    connect: () => Effect.succeed({ ready: Effect.void, closed: Effect.never, welcome: Effect.never,
      initialConfig: Effect.never, probe: Effect.void, pendingRequests: Effect.succeed(0),
      sequenceGaps: Stream.never, client: { events: Stream.never, call: () => Effect.never },
    } as never),
  }) };
});

const descriptor = {
  schemaVersion: 1, environmentId: "remote", label: "Remote", serverVersion: "0.1.0", protocolVersion: 2,
  platform: "linux", architecture: "x64", capabilities: [],
  auth: { bootstrapMethods: ["pairing"], sessionMethods: ["bearer"], required: true }, endpoints: [],
};
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, clear: () => map.clear(), key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: (key) => { map.delete(key); } };
}
let runtime: WebApplicationRuntime;
let options: WebConnectionOptions;
beforeEach(() => {
  vi.stubGlobal("window", { location: new URL("https://client.test") });
  options = { desktop: null, storage: memoryStorage(), fetchFn: async (input) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    return Response.json(path === "/api/auth/websocket-ticket" ? { ticket: "fixture-ticket", expiresIn: 300 } : path === "/api/auth/session"
      ? { environmentId: "remote", sessionId: "session", scopes: ["repository:read"], expiresAtUnixMs: Date.now() + 3600_000 }
      : descriptor);
  } };
});
afterEach(async () => { await runtime?.stop(); vi.unstubAllGlobals(); });

describe("adding saved routes through the application adapter", () => {
  it("requires a saved identity before acquiring an explicit existing state directory", async () => {
    const ensure = vi.fn();
    options = { ...options, desktop: { ensureSshConnection: ensure } as unknown as DesktopBridge };
    runtime = new WebApplicationRuntime(options);
    await expect(runtime.addSsh({ kind: "ssh", host: "host", remoteDataDirectory: "/existing/catalog" })).rejects.toMatchObject({ reason: "configuration" });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("recovers an existing directory using its saved opaque environment ID", async () => {
    let records: DesktopConnectionRegistration[] = [];
    const ensure = vi.fn<DesktopBridge["ensureSshConnection"]>(async (_target, request) => ({ httpUrl: "http://127.0.0.1:3774", descriptor,
      ssh: { operationId: request!.operationId, remoteDataDirectory: "/isolated/remote" } }));
    options = { ...options, desktop: {
      listConnectionRegistrations: async () => records,
      saveConnectionRegistration: async record => { records = [record]; },
      getCredential: async () => undefined,
      ensureSshConnection: ensure,
      claimSshConnection: async () => {}, cancelSshConnection: async () => "released",
    } as Partial<DesktopBridge> as DesktopBridge };
    runtime = new WebApplicationRuntime(options);
    expect(await runtime.addSsh({ kind: "ssh", host: "host", remoteDataDirectory: "/isolated/remote", expectedEnvironmentId: "remote" },
      { kind: "bearer", token: "test-session" })).toBe("remote");
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ remoteDataDirectory: "/isolated/remote" }),
      expect.objectContaining({ expectedEnvironmentId: "remote" }));
    expect(records[0].environmentId).toBe("remote");
  });

  it("retains distinct direct addresses across registration, reload and another add", async () => {
    runtime = new WebApplicationRuntime(options);
    for (const url of ["https://public.test", "https://lan.test"]) {
      await runtime.addDirect(url, { kind: "bearer", token: "test-session" });
    }
    await runtime.stop();
    runtime = new WebApplicationRuntime(options);
    await runtime.addDirect("https://third.test", { kind: "bearer", token: "test-session" });
    // Adding the same address again replaces its profile, not another address.
    await runtime.addDirect("https://lan.test", { kind: "bearer", token: "test-session" });
    const catalog = await createCatalogBackend(options).read();
    const record = catalog.environments[0];
    expect(record.routes).toHaveLength(3);
    expect(new Set(record.routes.map((route) => route.connectionId)).size).toBe(3);
    expect(record.profiles?.filter((profile) => profile._tag === "BearerConnectionProfile").map((profile) => profile.httpBaseUrl).sort())
      .toEqual(["https://lan.test", "https://public.test", "https://third.test"]);
  });

  it.each([
    { field: "identity file", first: { host: "host", user: "alice", port: 22, identityFile: "/keys/key-a" }, second: { host: "host", user: "alice", port: 22, identityFile: "/keys/key-b" }, expected: ["/keys/key-a", "/keys/key-b"] },
    { field: "user/port", first: { host: "host", user: "alice", port: 2222 }, second: { host: "host", user: "bob", port: 22, identityFile: "/keys/test-key" }, expected: ["alice", "bob"] },
  ])("retains SSH routes differing by $field, across reload and re-adding the same route", async ({ field, first, second, expected }) => {
    let records: DesktopConnectionRegistration[] = [];
    const credentials = new Map<string, DesktopCredential>();
    const desktop: Partial<DesktopBridge> = {
      listConnectionRegistrations: async () => records,
      saveConnectionRegistration: async (record, credential) => { records = [record]; if (credential) credentials.set(record.environmentId, credential); },
      getCredential: async (id) => credentials.get(id),
      setCredential: async (id, credential) => { credentials.set(id, credential); },
      ensureSshConnection: async (_target, request) => ({ httpUrl: "http://127.0.0.1:3774", descriptor,
        ssh: { operationId: request!.operationId, remoteDataDirectory: "/isolated/remote" } }),
      claimSshConnection: async () => undefined,
      cancelSshConnection: async () => "released",
    };
    options = { ...options, desktop: desktop as DesktopBridge };
    runtime = new WebApplicationRuntime(options);
    await runtime.addSsh({ kind: "ssh", ...first }, { kind: "bearer", token: "test-session" });
    await runtime.addSsh({ kind: "ssh", ...second }, { kind: "bearer", token: "test-session" });
    await runtime.stop();
    runtime = new WebApplicationRuntime(options);
    await runtime.addSsh({ kind: "ssh", ...first }, { kind: "bearer", token: "test-session" });
    const record = (await createCatalogBackend(options).read()).environments[0];
    expect(record.routes).toHaveLength(2);
    expect(new Set(record.routes.map((route) => route.connectionId)).size).toBe(2);
    expect(record.profiles?.filter((profile) => profile._tag === "SshConnectionProfile").map((profile) => field === "identity file" ? profile.target.identityFile : profile.target.username).sort())
      .toEqual(expected);
  });
});
