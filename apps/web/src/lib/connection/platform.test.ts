import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopConnectionRegistration, DesktopCredential } from "@gitgui/contracts/desktop";
import { EnvironmentId } from "@gitgui/contracts/environment";
import { BearerConnectionCredential, BearerConnectionProfile, BearerConnectionRegistration, SshConnectionProfile, SshConnectionRegistration } from "@gitgui/client-runtime/connection/catalog";
import { BearerConnectionTarget, SshConnectionTarget } from "@gitgui/client-runtime/connection/model";
import { makeRegistrationStore } from "@gitgui/client-runtime/platform/catalog";
import { EnvironmentRegistry } from "@gitgui/client-runtime/connection/registry";
import { PrimaryEnvironmentAuth, SshEnvironmentGateway } from "@gitgui/client-runtime/platform/capabilities";
import { PlatformConnectionSource } from "@gitgui/client-runtime/platform/source";
import { EnvironmentOwnedDataCleanup } from "@gitgui/client-runtime/platform/persistence";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import { layerRemoteHttpClient } from "@gitgui/client-runtime/rpc/http";
import { resolveRemoteWebSocketConnectionUrl } from "@gitgui/client-runtime/authorization/remote";
import * as HttpClient from "effect/http/HttpClient";
import { LocalStorageWorkspaceMetadataAdapter, createEmptyWorkspaceMetadata } from "../client-runtime/metadata";
import { authorizeConnectionCredential, createCatalogBackend, webConnectionLayer, writeSelectedEnvironmentId, readSelectedEnvironmentId, readEnvironmentNames, writeEnvironmentName, type WebConnectionOptions } from "./platform";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const environmentId = EnvironmentId.make("environment-1");
const descriptor = {
  schemaVersion: 1, environmentId, label: "Test", serverVersion: "0.1.0", protocolVersion: 2,
  platform: "linux", architecture: "x64", capabilities: [],
  auth: { bootstrapMethods: ["pairing"], sessionMethods: ["bearer"], required: true }, endpoints: [],
};
const session = { environmentId, sessionId: "session", scopes: ["repository:read"], expiresAtUnixMs: Date.now() + 3600_000 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sshDesktop = (overrides: Partial<DesktopBridge> = {}) => ({
  listConnectionRegistrations: async () => [],
  ensureSshConnection: async (_target, request) => ({ httpUrl: "http://127.0.0.1:3774", descriptor,
    ssh: { operationId: request!.operationId, remoteDataDirectory: "/isolated/environment" } }),
  issueSshPairingCredential: async () => ({ kind: "pairing", token: "one-time-fixture-grant" }),
  claimSshConnection: async () => undefined,
  cancelSshConnection: async () => "released",
  ...overrides,
} as DesktopBridge);
let options: WebConnectionOptions;
let exchanges: number;
let validations: string[];
beforeEach(() => {
  exchanges = 0; validations = [];
  const window = Object.assign(new EventTarget(), { location: { href: "http://localhost:1420/?server=http://127.0.0.1:3774#bootstrap=test-bootstrap" } });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("history", { state: null, replaceState: (_state: unknown, _unused: string, url: URL) => { window.location.href = url.toString(); } });
  options = { desktop: null, storage: new MemoryStorage(), fetchFn: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (path === "/.well-known/gitgui/environment") return json(descriptor);
    if (path === "/oauth/token") { exchanges++; return json({ access_token: "test-session", token_type: "Bearer", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", expires_in: 3600, scope: "repository:read" }); }
    if (path === "/api/auth/session") {
      validations.push(new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization") ?? "");
      return json(session);
    }
    throw new Error(`Unexpected request path: ${path}`);
  }) };
});
afterEach(() => vi.unstubAllGlobals());

function registration(id = environmentId) {
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId: id, label: "Test", connectionId: `direct:${id}` }),
    profile: new BearerConnectionProfile({ environmentId: id, label: "Test", connectionId: `direct:${id}`, httpBaseUrl: "http://127.0.0.1:3774", wsBaseUrl: "ws://127.0.0.1:3774" }),
    credential: new BearerConnectionCredential({ token: `test-session-${id}` }),
  });
}

describe("web connection platform", () => {
  it("recovers malformed browser names without discarding the original value", async () => {
    options.storage.setItem("gitgui.environmentNames.v1", "{broken");
    expect(await readEnvironmentNames(options)).toEqual({});
    await writeEnvironmentName(options, environmentId, "Workstation");
    expect(await readEnvironmentNames(options)).toEqual({ [environmentId]: "Workstation" });
    const backup = Array.from({ length: options.storage.length }, (_, i) => options.storage.key(i))
      .find((key) => key?.startsWith("gitgui.environmentNames.v1.invalid."));
    expect(backup && options.storage.getItem(backup)).toBe("{broken");
  });

  it.each(['{"broken":42,"kept":"Existing"}', '[]', 'null'])("preserves invalid name data before repairing %s", async (raw) => {
    options.storage.setItem("gitgui.environmentNames.v1", raw);
    await writeEnvironmentName(options, environmentId, "Workstation");
    const backup = Array.from({ length: options.storage.length }, (_, i) => options.storage.key(i))
      .find((key) => key?.startsWith("gitgui.environmentNames.v1.invalid."));
    expect(backup && options.storage.getItem(backup)).toBe(raw);
    expect((await readEnvironmentNames(options))[environmentId]).toBe("Workstation");
    if (raw.includes("Existing")) expect((await readEnvironmentNames(options)).kept).toBe("Existing");
  });
  it("persists explicit browser names independently of the catalog, selection and credentials", async () => {
    options.storage.setItem("gitgui.selectedEnvironment.v3", environmentId);
    await Promise.all([writeEnvironmentName(options, environmentId, "My workstation"), writeEnvironmentName(options, "other", "Build host")]);
    expect(await readEnvironmentNames({ ...options })).toEqual({ [environmentId]: "My workstation", other: "Build host" });
    await writeEnvironmentName(options, environmentId, "GitGui on purpose");
    expect((await readEnvironmentNames(options))[environmentId]).toBe("GitGui on purpose");
    await writeEnvironmentName(options, "other", null);
    expect(await readEnvironmentNames(options)).toEqual({ [environmentId]: "GitGui on purpose" });
    expect(options.storage.getItem("gitgui.selectedEnvironment.v3")).toBe(environmentId);
    expect(options.storage.getItem("gitgui.connections.v3")).toBeNull();
    expect(options.storage.getItem("gitgui.credential.v3." + environmentId)).toBeNull();
  });

  it("keeps desktop names behind the narrow native persistence bridge", async () => {
    const getEnvironmentNames = vi.fn().mockResolvedValue({ [environmentId]: "Desktop name" });
    const setEnvironmentName = vi.fn().mockResolvedValue(undefined);
    options = { ...options, desktop: sshDesktop({ getEnvironmentNames, setEnvironmentName }) };
    expect(await readEnvironmentNames(options)).toEqual({ [environmentId]: "Desktop name" });
    await writeEnvironmentName(options, environmentId, "  New name  ");
    expect(setEnvironmentName).toHaveBeenCalledWith(environmentId, "New name");
    await writeEnvironmentName(options, environmentId, null);
    expect(setEnvironmentName).toHaveBeenLastCalledWith(environmentId, null);
    expect(options.storage.getItem("gitgui.environmentNames.v1")).toBeNull();
  });

  it("pins explicit directory recovery to the saved identity before requesting credentials", async () => {
    const ensure = vi.fn(sshDesktop().ensureSshConnection);
    const pairing = vi.fn(sshDesktop().issueSshPairingCredential);
    options = { ...options, desktop: sshDesktop({ ensureSshConnection: ensure, issueSshPairingCredential: pairing }) };
    const wrong = EnvironmentId.make("another-environment");
    await expect(Effect.runPromise(Effect.flatMap(SshEnvironmentGateway, ssh => ssh.provision!({
      alias: "host", hostname: "host", remoteDataDirectory: "/existing/catalog",
    }, undefined, wrong)).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped))).rejects.toMatchObject({ reason: "configuration", detail: expect.stringContaining("another-environment") });
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ remoteDataDirectory: "/existing/catalog" }),
      expect.objectContaining({ expectedEnvironmentId: wrong }));
    expect(pairing).not.toHaveBeenCalled();
    expect(exchanges).toBe(0);
  });

  it.each(["retained", "cleanup-pending"] as const)("reports %s returned by explicit disconnect", async outcome => {
    const notice = vi.fn();
    options = { ...options, onSshCleanup: notice, desktop: sshDesktop({
      disconnectSshConnection: async () => [{ operationId: "owned-operation", outcome }],
    }) };
    await Effect.runPromise(Effect.flatMap(SshEnvironmentGateway, ssh => ssh.disconnect({
      alias: "host", hostname: "host", remoteDataDirectory: "/isolated/environment",
    })).pipe(Effect.provide(webConnectionLayer(options))));
    expect(notice).toHaveBeenCalledExactlyOnceWith({ operationId: "owned-operation", outcome });
  });

  it("bounds a lost explicit disconnect response and reports uncertainty", async () => {
    vi.useFakeTimers();
    const notice = vi.fn(); const disconnect = vi.fn(async () => await new Promise<never>(() => {}));
    options = { ...options, onSshCleanup: notice, desktop: sshDesktop({ disconnectSshConnection: disconnect }) };
    try {
      let finished = false;
      const pending = Effect.runPromise(Effect.flatMap(SshEnvironmentGateway, ssh => ssh.disconnect({
        alias: "host", hostname: "host",
      })).pipe(Effect.provide(webConnectionLayer(options)))).then(() => { finished = true; });
      await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;
      expect(notice).toHaveBeenCalledExactlyOnceWith({ outcome: "cleanup-pending" });
    } finally { vi.useRealTimers(); }
  });

  it("replaces the prior route handle only after a successful ownership handoff", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const desktop = sshDesktop({ cancelSshConnection: async (id) => { released.push(id); return "released"; } });
    const ensure = desktop.ensureSshConnection;
    desktop.ensureSshConnection = async (target, request) => { acquired.push(request!.operationId); return ensure(target, request); };
    options = { ...options, desktop };
    await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const connect = (handoff: boolean) => Effect.scoped(Effect.gen(function* () {
        const prepared = yield* ssh.prepare({ connectionId: "same-route", expectedEnvironmentId: environmentId,
          target: { alias: "host", hostname: "host" }, bearerToken: "saved" });
        if (handoff) { yield* prepared.commit!; yield* prepared.handoff!("same-route"); }
      }));
      yield* connect(true);
      expect(released).toEqual([]);
      yield* connect(false);
      expect(released).toEqual([acquired[1]]);
      yield* connect(true);
      expect(released).toEqual([acquired[1], acquired[0]]);
    }).pipe(Effect.provide(webConnectionLayer(options))));
  });

  it("bounds a lost cancellation response and reports cleanup uncertainty", async () => {
    vi.useFakeTimers();
    const notice = vi.fn();
    const cancel = vi.fn(async () => await new Promise<"cleanup-pending">(() => {}));
    const ensure = vi.fn(async () => await new Promise<never>(() => {}));
    options = { ...options, onSshCleanup: notice, desktop: sshDesktop({ ensureSshConnection: ensure, cancelSshConnection: cancel }) };
    const abort = new AbortController();
    try {
      const pending = Effect.runPromise(Effect.flatMap(SshEnvironmentGateway, (ssh) => ssh.prepare({
        connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" },
      })).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped), { signal: abort.signal });
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
      abort.abort();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
      expect(notice).toHaveBeenCalledWith({ operationId: expect.any(String), outcome: "cleanup-pending" });
    } finally { vi.useRealTimers(); }
  });

  it("cancels the known desktop operation when interruption precedes any launch result", async () => {
    let operationId: string | undefined;
    const cancel = vi.fn(async () => "cleanup-pending" as const);
    options = { ...options, desktop: sshDesktop({
      ensureSshConnection: async (_target, request) => { operationId = request!.operationId; return await new Promise(() => {}); },
      cancelSshConnection: cancel,
    }) };
    const abort = new AbortController();
    const pending = Effect.runPromise(Effect.flatMap(SshEnvironmentGateway, (ssh) => ssh.prepare({
      connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" },
    })).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped), { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(operationId).toBeDefined());
    abort.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledExactlyOnceWith(operationId);
  });

  it("keeps independent acquisition finalizers bound to their operation IDs", async () => {
    const cancelled: string[] = [];
    const claimed: string[] = [];
    const ids: string[] = [];
    const desktop = sshDesktop({ cancelSshConnection: async (id) => { cancelled.push(id); return "released"; },
      claimSshConnection: async (id) => { claimed.push(id); } });
    const ensure = desktop.ensureSshConnection;
    desktop.ensureSshConnection = async (target, request) => { ids.push(request!.operationId); return ensure(target, request); };
    options = { ...options, desktop };
    await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const a = yield* ssh.prepare({ connectionId: "a", expectedEnvironmentId: environmentId,
        target: { alias: "host-a", hostname: "host-a" }, bearerToken: "saved" });
      const b = yield* ssh.prepare({ connectionId: "b", expectedEnvironmentId: environmentId,
        target: { alias: "host-b", hostname: "host-b" }, bearerToken: "saved" });
      yield* a.cancel!;
      yield* b.commit!;
      yield* b.handoff!("b");
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(new Set(ids).size).toBe(2);
    expect(cancelled).toEqual([ids[0], ids[1]]);
    expect(claimed).toEqual([ids[1]]);
    expect(exchanges).toBe(0);
  });

  it("rejects a forged forward without sending credentials or issuing pairing", async () => {
    const issue = vi.fn(async () => ({ kind: "pairing" as const, token: "grant" }));
    const cancel = vi.fn(async () => "released" as const);
    options = { ...options, desktop: sshDesktop({ issueSshPairingCredential: issue, cancelSshConnection: cancel,
      ensureSshConnection: async (_target, request) => ({ httpUrl: "https://outside.test", descriptor,
        ssh: { operationId: request!.operationId, remoteDataDirectory: "/fixture" } }),
    }) };
    const failure = await Effect.runPromise(Effect.flatMap(SshEnvironmentGateway, (ssh) => ssh.prepare({
      connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" }, bearerToken: "saved",
    })).pipe(Effect.flip, Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(failure.reason).toBe("configuration");
    expect(issue).not.toHaveBeenCalled();
    expect(validations).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("starts the actual browser layer and retains bootstrap authentication after stripping the fragment", async () => {
    const token = await Effect.runPromise(Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      expect(Option.isSome(yield* Stream.runHead(source.registrations))).toBe(true);
      expect(window.location.href).not.toContain("#");
      const auth = yield* PrimaryEnvironmentAuth;
      const token = yield* auth.bearerToken;
      expect(yield* auth.bearerToken).toEqual(token);
      return token;
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(Option.getOrUndefined(token)).toBe("test-session");
    expect(exchanges).toBe(1);
  });

  it("reaches an environment that does not require authentication without a credential", async () => {
    // A development backend that was started without a bootstrap credential
    // answers with its anonymous session. The client presents no credential.
    const openDescriptor = { ...descriptor, auth: { bootstrapMethods: [], sessionMethods: ["development-anonymous"], required: false } };
    const window = Object.assign(new EventTarget(), { location: { href: "http://localhost:1420/?server=http://127.0.0.1:3774" } });
    vi.stubGlobal("window", window);
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    const authorizations: (string | null)[] = [];
    options = { ...options, fetchFn: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/.well-known/gitgui/environment") return json(openDescriptor);
      if (path === "/api/auth/websocket-ticket") {
        authorizations.push(new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization"));
        return json({ ticket: "development-ticket", expiresIn: 300 });
      }
      throw new Error(`Unexpected request path: ${path}`);
    }) };
    const socketUrl = await Effect.runPromise(Effect.gen(function* () {
      const auth = yield* PrimaryEnvironmentAuth;
      const token = yield* auth.bearerToken;
      expect(Option.getOrUndefined(token)).toBe("");
      return yield* resolveRemoteWebSocketConnectionUrl({
        httpBaseUrl: "http://127.0.0.1:3774",
        wsBaseUrl: "ws://127.0.0.1:3774",
        bearerToken: Option.getOrThrow(token),
      });
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(exchanges).toBe(0);
    expect(authorizations).toEqual([null]);
    expect(socketUrl).toContain("wsTicket=development-ticket");
  });

  it("falls back to the anonymous session when a stale credential is rejected", async () => {
    // The environment stopped requiring authentication. A credential the
    // client cached earlier must not block the anonymous session.
    const openDescriptor = { ...descriptor, auth: { bootstrapMethods: [], sessionMethods: ["development-anonymous"], required: false } };
    const backend = createCatalogBackend(options);
    await backend.writeCredential(environmentId, new BearerConnectionCredential({ token: "stale-session", expiresAt: Date.now() + 86400_000 }));
    const window = Object.assign(new EventTarget(), { location: { href: "http://localhost:1420/?server=http://127.0.0.1:3774" } });
    vi.stubGlobal("window", window);
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    options = { ...options, fetchFn: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/.well-known/gitgui/environment") return json(openDescriptor);
      if (path === "/api/auth/session") return new Response(null, { status: 401 });
      throw new Error(`Unexpected request path: ${path}`);
    }) };
    const token = await Effect.runPromise(Effect.gen(function* () {
      const auth = yield* PrimaryEnvironmentAuth;
      return yield* auth.bearerToken;
    }).pipe(Effect.provide(webConnectionLayer(options, backend)), Effect.scoped));
    expect(Option.getOrUndefined(token)).toBe("");
  });

  it.each([401, 403, 500])("validates cached primary credentials and recovers only from HTTP %s authentication rejection", async (status) => {
    const backend = createCatalogBackend(options);
    await backend.writeCredential(environmentId, new BearerConnectionCredential({ token: "stale-session", expiresAt: Date.now() + 86400_000 }));
    const fetchFn = options.fetchFn;
    options = { ...options, fetchFn: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      return path === "/api/auth/session" ? new Response(null, { status }) : fetchFn(input, init);
    } };
    const result = await Effect.runPromise(Effect.gen(function* () {
      const auth = yield* PrimaryEnvironmentAuth;
      return yield* auth.bearerToken.pipe(Effect.result);
    }).pipe(Effect.provide(webConnectionLayer(options, backend)), Effect.scoped));
    if (status === 401) {
      expect(result._tag).toBe("Success");
      expect((await backend.readCredential(environmentId))?.token).toBe("test-session");
      expect(exchanges).toBe(1);
    } else {
      expect(result._tag).toBe("Failure");
      expect((await backend.readCredential(environmentId))?.token).toBe("stale-session");
      expect(exchanges).toBe(0);
    }
  });

  it("recovers initial discovery on the next poll and retains the last registration during refresh failure", async () => {
    let failed = true;
    let calls = 0;
    const fetchFn = options.fetchFn;
    options = { ...options, fetchFn: async (input, init) => {
      calls++;
      if (failed) throw new Error("network unavailable");
      return fetchFn(input, init);
    } };
    const managed = ManagedRuntime.make(webConnectionLayer(options));
    const seen: ReadonlyArray<unknown>[] = [];
    try {
      managed.runFork(Effect.gen(function* () {
        const source = yield* PlatformConnectionSource;
        yield* Stream.runForEach(source.registrations, (registrations) => Effect.sync(() => { seen.push(registrations); }));
      }));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
      failed = false;
      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
      const beforeFailure = calls;
      failed = true;
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(beforeFailure));
      expect(seen).toHaveLength(1);
      failed = false;
      const beforeRecovery = calls;
      window.dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(beforeRecovery));
      // Equivalent topology is not republished: a healthy session stays owned
      // by its existing supervisor rather than reconnecting on each poll.
      expect(seen).toHaveLength(1);
    } finally { await managed.dispose(); }
  }, 10_000);

  it("republishes a primary port change on wakeup", async () => {
    let httpUrl = "http://127.0.0.1:3774";
    options = { ...options, desktop: {
      listConnectionRegistrations: async () => [],
      getPrimaryEnvironment: async () => ({ httpUrl, descriptor }),
      onApplicationWakeup: () => () => undefined,
    } as unknown as DesktopBridge };
    const managed = ManagedRuntime.make(webConnectionLayer(options));
    const urls: string[] = [];
    try {
      managed.runFork(Effect.gen(function* () {
        const source = yield* PlatformConnectionSource;
        yield* Stream.runForEach(source.registrations, (registrations) => Effect.sync(() => {
          const target = registrations[0]?.target;
          if (target?._tag === "PrimaryConnectionTarget") urls.push(target.httpBaseUrl);
        }));
      }));
      await vi.waitFor(() => expect(urls).toEqual([httpUrl]));
      httpUrl = "http://127.0.0.1:3775";
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => expect(urls).toEqual(["http://127.0.0.1:3774", httpUrl]));
    } finally { await managed.dispose(); }
  });

  it.each(["unreadable", "invalid-json", "invalid-record"])("does not treat an %s browser catalog as authoritative absence", async (kind) => {
    const backend = createCatalogBackend(options);
    if (kind === "unreadable") {
      vi.spyOn(options.storage, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
    } else {
      options.storage.setItem("gitgui.connections.v3", kind === "invalid-json" ? "{" : JSON.stringify({
        schemaVersion: 1, environments: [{}],
      }));
    }
    await expect(backend.read()).rejects.toThrow();
  });

  it("preserves browser selection across unrelated and stale catalog writes, clearing it only on selected removal", async () => {
    const backend = createCatalogBackend(options);
    const registrations = await Effect.runPromise(makeRegistrationStore(backend));
    const a = registration();
    const b = registration(EnvironmentId.make("other"));
    await Effect.runPromise(registrations.register(a, [a.target]));
    await Effect.runPromise(registrations.register(b, [b.target]));
    await writeSelectedEnvironmentId(options, environmentId);
    const staleCatalog = await backend.read();
    await writeSelectedEnvironmentId(options, "other");
    await Effect.runPromise(registrations.setEnabled(environmentId, false));
    expect(await readSelectedEnvironmentId(options)).toBe("other");
    await backend.write(staleCatalog);
    expect(await readSelectedEnvironmentId(options)).toBe("other");
    expect((await backend.read()).selectedEnvironmentId).toBe("other");
    await Effect.runPromise(registrations.remove(environmentId));
    expect(await readSelectedEnvironmentId(options)).toBe("other");
    await Effect.runPromise(registrations.remove(EnvironmentId.make("other")));
    expect(await readSelectedEnvironmentId(options)).toBeUndefined();
    await writeSelectedEnvironmentId(options, "primary-not-in-catalog");
    await backend.write({ schemaVersion: 1, environments: [] });
    expect(await readSelectedEnvironmentId(options)).toBe("primary-not-in-catalog");
  });

  it("disconnects exactly the prepared SSH target including user, port, and identity file", async () => {
    const disconnect = vi.fn(async () => []);
    options = { ...options, desktop: { listConnectionRegistrations: async () => [], disconnectSshConnection: disconnect } as unknown as DesktopBridge };
    await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      yield* ssh.disconnect({ alias: "host", hostname: "server", username: "alice", port: 2222, identityFile: "/keys/test-key" });
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(disconnect).toHaveBeenCalledWith({ kind: "ssh", host: "host", user: "alice", port: 2222, identityFile: "/keys/test-key" });
  });

  it("validates supplied bearer sessions without attempting token exchange", async () => {
    const result = await Effect.runPromise(authorizeConnectionCredential("http://127.0.0.1:3774", environmentId, { kind: "bearer", token: "existing" })
      .pipe(Effect.provide(layerRemoteHttpClient(options.fetchFn))));
    expect(result.token).toBe("existing");
    expect(result.expiresAt).toBe(session.expiresAtUnixMs);
    expect(validations).toEqual(["Bearer existing"]);
    expect(exchanges).toBe(0);
  });

  it.each(["bootstrap", "pairing"])("preserves the server's %s grant instead of restricting catalog access", async (kind) => {
    let requestedScope: string | null | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requestedScope = new URLSearchParams(await request.text()).get("scope");
      return options.fetchFn(input, init);
    };
    await Effect.runPromise(authorizeConnectionCredential("http://127.0.0.1:3774", environmentId, { kind, token: "test-grant" })
      .pipe(Effect.provide(layerRemoteHttpClient(fetchFn))));
    expect(requestedScope).toBeNull();
    expect(exchanges).toBe(1);
  });

  it("issues independent SSH pairing once and reuses the saved bearer on later preparations", async () => {
    const issue = vi.fn(async () => ({ kind: "pairing" as const, token: "one-time" }));
    options = { ...options, desktop: sshDesktop({ issueSshPairingCredential: issue }) };
    await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const input = { connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" } };
      const first = yield* ssh.prepare(input);
      expect(first.bearerToken).toBe("test-session");
      const second = yield* ssh.prepare({ ...input, bearerToken: first.bearerToken });
      expect(second.bearerToken).toBe(first.bearerToken);
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(exchanges).toBe(1);
    expect(issue).toHaveBeenCalledOnce();
    expect(validations).toEqual(["Bearer test-session"]);
  });

  it.each([401, 403, 500])("handles an SSH saved-session HTTP %s without hiding the failure or retrying exchange indiscriminately", async (status) => {
    const fetchFn = options.fetchFn;
    options = { ...options,
      desktop: sshDesktop(),
      fetchFn: async (input, init) => new URL(input instanceof Request ? input.url : input.toString()).pathname === "/api/auth/session"
        ? json({ error: "auth_error", message: "fixture rejection" }, status) : fetchFn(input, init),
    };
    const result = await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      return yield* ssh.prepare({ connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" }, bearerToken: "stale" })
        .pipe(Effect.result);
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    if (status === 401) {
      expect(result._tag).toBe("Success");
      expect(exchanges).toBe(1);
    } else {
      expect(result._tag).toBe("Failure");
      expect(exchanges).toBe(0);
    }
  });

  it.each([
    ["SSH authentication was cancelled", "authentication"],
    ["Error invoking remote method 'desktop:ssh:ensure': Error: SSH authentication was cancelled", "authentication"],
    ["Permission denied (publickey,password)", "authentication"],
    ["SSH authentication failed", "authentication"],
    ["SSH host-key confirmation was cancelled", "permission"],
    ["Host key verification failed", "permission"],
    ["REMOTE HOST IDENTIFICATION HAS CHANGED", "permission"],
  ])("blocks SSH setup requiring external action: %s", async (message, reason) => {
    options = { ...options, desktop: {
      listConnectionRegistrations: async () => [],
      ensureSshConnection: async () => { throw Object.assign(new Error(message), { category: reason }); },
    } as unknown as DesktopBridge };
    const error = await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      return yield* ssh.prepare({ connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" } }).pipe(Effect.flip);
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason });
  });

  it("keeps network SSH failures transient", async () => {
    options = { ...options, desktop: {
      listConnectionRegistrations: async () => [],
      ensureSshConnection: async () => { throw new Error("ssh: connect to host example.test: Connection timed out"); },
    } as unknown as DesktopBridge };
    const error = await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      return yield* ssh.prepare({ connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" } }).pipe(Effect.flip);
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(error).toMatchObject({ _tag: "ConnectionTransientError", reason: "remote-unavailable" });
  });

  it("does not retry a cancelled SSH prompt until explicit retry", async () => {
    const prepare = vi.fn(async () => { throw Object.assign(new Error("SSH authentication was cancelled"), { category: "authentication" }); });
    let records: DesktopConnectionRegistration[] = [];
    const credentials = new Map<string, DesktopCredential>();
    const desktop: Partial<DesktopBridge> = {
      listConnectionRegistrations: async () => records,
      saveConnectionRegistration: async (record, credential) => { records = [record]; if (credential) credentials.set(record.environmentId, credential); },
      getCredential: async (id) => credentials.get(id),
      setCredential: async (id, credential) => { credentials.set(id, credential); },
      ensureSshConnection: prepare,
    };
    options = { ...options, desktop: desktop as DesktopBridge };
    const managed = ManagedRuntime.make(webConnectionLayer(options).pipe(Layer.provideMerge(TestClock.layer())));
    try {
      await managed.runPromise(Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry;
        yield* registry.register(new SshConnectionRegistration({
          target: new SshConnectionTarget({ environmentId, connectionId: "ssh", label: "SSH" }),
          profile: new SshConnectionProfile({ environmentId, connectionId: "ssh", label: "SSH", target: { alias: "host", hostname: "host" } }),
          credential: new BearerConnectionCredential({ token: "test-session" }),
        }));
      }));
      await vi.waitFor(async () => {
        const state = await managed.runPromise(Effect.flatMap(EnvironmentRegistry, (registry) => registry.state(environmentId)));
        expect(state.phase).toBe("blocked");
        expect(state.lastFailure?.reason).toBe("authentication");
      });
      await managed.runPromise(TestClock.adjust("1 hour"));
      expect(prepare).toHaveBeenCalledTimes(1);
      await managed.runPromise(Effect.flatMap(EnvironmentRegistry, (registry) => registry.retryNow(environmentId)));
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    } finally { await managed.dispose(); }
  });

  it("rejects a different SSH environment before sending credentials", async () => {
    options = { ...options, desktop: sshDesktop() };
    const error = await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      return yield* ssh.prepare({ connectionId: "ssh", expectedEnvironmentId: EnvironmentId.make("other"), target: { alias: "host", hostname: "host" }, bearerToken: "saved" }).pipe(Effect.flip);
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
    expect(exchanges).toBe(0); expect(validations).toEqual([]);
  });

  it("migrates inline browser credentials to memory, scrubs the record, and keeps the registration after reload", async () => {
    options.storage.setItem("gitgui.connections.v3", JSON.stringify({ schemaVersion: 1, environments: [{
      schemaVersion: 1, environmentId, enabled: true,
      registration: {
        _tag: "BearerConnectionRegistration",
        target: { _tag: "BearerConnectionTarget", environmentId, label: "Test", connectionId: "direct" },
        profile: { _tag: "BearerConnectionProfile", environmentId, label: "Test", connectionId: "direct", httpBaseUrl: "http://127.0.0.1:3774", wsBaseUrl: "ws://127.0.0.1:3774" },
        credential: { _tag: "BearerConnectionCredential", token: "legacy-session" },
      }, routes: [],
    }] }));
    const backend = createCatalogBackend(options);
    const catalog = await backend.read();
    expect(catalog.environments).toHaveLength(1);
    expect(JSON.stringify(catalog)).not.toContain("legacy-session");
    expect(options.storage.getItem("gitgui.connections.v3")).not.toContain("legacy-session");
    expect((await backend.readCredential(environmentId))?.token).toBe("legacy-session");
    const afterReload = createCatalogBackend(options);
    expect((await afterReload.read()).environments).toHaveLength(1);
    expect(await afterReload.readCredential(environmentId)).toBeUndefined();
  });

  it("retires old browser credential keys and keeps new sessions only in memory", async () => {
    const oldKey = "gitgui.credential.v3." + environmentId;
    const orphanKey = "gitgui.credential.v3.other";
    options.storage.setItem(oldKey, JSON.stringify({ _tag: "BearerConnectionCredential", token: "old-session" }));
    options.storage.setItem(orphanKey, JSON.stringify({ _tag: "BearerConnectionCredential", token: "orphan-session" }));
    const backend = createCatalogBackend(options);
    await backend.read();
    expect(options.storage.getItem(oldKey)).toBeNull();
    expect(options.storage.getItem(orphanKey)).toBeNull();
    expect((await backend.readCredential(environmentId))?.token).toBe("old-session");
    await backend.writeCredential(environmentId, new BearerConnectionCredential({ token: "new-session" }));
    expect(options.storage.getItem(oldKey)).toBeNull();
    expect((await backend.readCredential(environmentId))?.token).toBe("new-session");
    expect(await createCatalogBackend(options).readCredential(environmentId)).toBeUndefined();
    await backend.removeCredential(environmentId);
    expect(await backend.readCredential(environmentId)).toBeUndefined();
  });

  it("removes credentials, registrations and workspace metadata together while retaining another environment", async () => {
    const backend = createCatalogBackend(options);
    const registrations = await Effect.runPromise(makeRegistrationStore(backend));
    const a = registration();
    const b = registration(EnvironmentId.make("other"));
    await Effect.runPromise(registrations.register(a, [a.target]));
    await Effect.runPromise(registrations.register(b, [b.target]));
    const metadata = new LocalStorageWorkspaceMetadataAdapter(options.storage);
    await metadata.save({ environmentId }, createEmptyWorkspaceMetadata());
    await metadata.save({ environmentId: "other" }, createEmptyWorkspaceMetadata());
    await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      yield* registry.remove(environmentId);
    }).pipe(Effect.provide(webConnectionLayer(options, backend)), Effect.scoped));
    expect(await backend.readCredential(environmentId)).toBeUndefined();
    expect(await metadata.load({ environmentId })).toBeNull();
    expect((await backend.read()).environments.map((entry) => entry.environmentId)).toEqual(["other"]);
    expect(await backend.readCredential("other")).toBeDefined();
    expect(await metadata.load({ environmentId: "other" })).not.toBeNull();
  });

  it("migrates a desktop record through protected credential storage and persists only non-secret records", async () => {
    const a = registration();
    let records: DesktopConnectionRegistration[] = [{ environmentId, displayName: "Test", record: JSON.stringify({ schemaVersion: 1, environmentId, enabled: true, registration: a, routes: [a.target] }), capabilities: [], protocolVersion: 2 }];
    const credentials = new Map<string, DesktopCredential>();
    const desktop: Partial<DesktopBridge> = {
      listConnectionRegistrations: async () => records,
      saveConnectionRegistration: async (record) => { records = [record]; },
      getCredential: async (id) => credentials.get(id),
      setCredential: async (id, credential) => { credentials.set(id, credential); },
    };
    options = { ...options, desktop: desktop as DesktopBridge };
    const backend = createCatalogBackend(options);
    expect((await backend.read()).environments).toHaveLength(1);
    expect(credentials.get(environmentId)?.token).toBe(a.credential.token);
    expect(records[0].record).not.toContain(a.credential.token);
    expect(records[0].record).not.toContain('"credential"');
  });

  it("clears only the removed environment's workspace metadata", async () => {
    const metadata = new LocalStorageWorkspaceMetadataAdapter(options.storage);
    await writeEnvironmentName(options, environmentId, "Removed name");
    await writeEnvironmentName(options, "other", "Retained name");
    await metadata.save({ environmentId }, createEmptyWorkspaceMetadata());
    await metadata.save({ environmentId: "other" }, createEmptyWorkspaceMetadata());
    await Effect.runPromise(Effect.gen(function* () {
      const cleanup = yield* EnvironmentOwnedDataCleanup;
      yield* cleanup.clear(environmentId);
    }).pipe(Effect.provide(webConnectionLayer(options)), Effect.scoped));
    expect(await metadata.load({ environmentId })).toBeNull();
    expect(await metadata.load({ environmentId: "other" })).not.toBeNull();
    expect(await readEnvironmentNames(options)).toEqual({ other: "Retained name" });
  });
});
