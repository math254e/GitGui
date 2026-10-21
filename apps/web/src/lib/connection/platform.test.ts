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
import { LocalStorageWorkspaceMetadataAdapter, createEmptyWorkspaceMetadata } from "../client-runtime/metadata";
import { authorizeConnectionCredential, createCatalogBackend, webConnectionLayer, writeSelectedEnvironmentId, readSelectedEnvironmentId, type WebConnectionOptions } from "./platform";

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
  it("starts the actual browser layer and retains bootstrap authentication after stripping the fragment", async () => {
    const token = await Effect.runPromise(Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      expect(Option.isSome(yield* Stream.runHead(source.registrations))).toBe(true);
      expect(window.location.href).not.toContain("#");
      const auth = yield* PrimaryEnvironmentAuth;
      const token = yield* auth.bearerToken;
      expect(yield* auth.bearerToken).toEqual(token);
      return token;
    }).pipe(Effect.provide(webConnectionLayer(options))));
    expect(Option.getOrUndefined(token)).toBe("test-session");
    expect(exchanges).toBe(1);
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
    }).pipe(Effect.provide(webConnectionLayer(options))));
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
    const disconnect = vi.fn(async () => undefined);
    options = { ...options, desktop: { listConnectionRegistrations: async () => [], disconnectSshConnection: disconnect } as unknown as DesktopBridge };
    await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      yield* ssh.disconnect({ alias: "host", hostname: "server", username: "alice", port: 2222, identityFile: "/keys/test-key" });
    }).pipe(Effect.provide(webConnectionLayer(options))));
    expect(disconnect).toHaveBeenCalledWith({ kind: "ssh", host: "server", user: "alice", port: 2222, identityFile: "/keys/test-key" });
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

  it("exchanges an SSH bootstrap once and reuses the saved bearer on later preparations", async () => {
    options = { ...options, desktop: { listConnectionRegistrations: async () => [], ensureSshConnection: async () => ({ httpUrl: "http://127.0.0.1:3774", descriptor, credential: { kind: "bootstrap", token: "ssh-bootstrap" } }) } as unknown as DesktopBridge };
    await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const input = { connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" } };
      const first = yield* ssh.prepare(input);
      expect(first.bearerToken).toBe("test-session");
      const second = yield* ssh.prepare({ ...input, bearerToken: first.bearerToken });
      expect(second.bearerToken).toBe(first.bearerToken);
    }).pipe(Effect.provide(webConnectionLayer(options))));
    expect(exchanges).toBe(1);
    expect(validations).toEqual(["Bearer test-session"]);
  });

  it.each([401, 403, 500])("handles an SSH saved-session HTTP %s without hiding the failure or retrying exchange indiscriminately", async (status) => {
    const fetchFn = options.fetchFn;
    options = { ...options,
      desktop: { listConnectionRegistrations: async () => [], ensureSshConnection: async () => ({ httpUrl: "http://127.0.0.1:3774", descriptor, credential: { kind: "bootstrap", token: "ssh-bootstrap" } }) } as unknown as DesktopBridge,
      fetchFn: async (input, init) => new URL(input instanceof Request ? input.url : input.toString()).pathname === "/api/auth/session"
        ? json({ error: "auth_error", message: "fixture rejection" }, status) : fetchFn(input, init),
    };
    const result = await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      return yield* ssh.prepare({ connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" }, bearerToken: "stale" })
        .pipe(Effect.result);
    }).pipe(Effect.provide(webConnectionLayer(options))));
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
      ensureSshConnection: async () => { throw new Error(message); },
    } as unknown as DesktopBridge };
    const error = await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      return yield* ssh.prepare({ connectionId: "ssh", expectedEnvironmentId: environmentId, target: { alias: "host", hostname: "host" } }).pipe(Effect.flip);
    }).pipe(Effect.provide(webConnectionLayer(options))));
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
    }).pipe(Effect.provide(webConnectionLayer(options))));
    expect(error).toMatchObject({ _tag: "ConnectionTransientError", reason: "remote-unavailable" });
  });

  it("does not retry a cancelled SSH prompt until explicit retry", async () => {
    const prepare = vi.fn(async () => { throw new Error("SSH authentication was cancelled"); });
    let records: DesktopConnectionRegistration[] = [];
    const credentials = new Map<string, DesktopCredential>();
    const desktop: Partial<DesktopBridge> = {
      listConnectionRegistrations: async () => records,
      saveConnectionRegistration: async (record) => { records = [record]; },
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
    options = { ...options, desktop: { listConnectionRegistrations: async () => [], ensureSshConnection: async () => ({ httpUrl: "http://127.0.0.1:3774", descriptor, credential: { kind: "bootstrap", token: "ssh-bootstrap" } }) } as unknown as DesktopBridge };
    const error = await Effect.runPromise(Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      return yield* ssh.prepare({ connectionId: "ssh", expectedEnvironmentId: EnvironmentId.make("other"), target: { alias: "host", hostname: "host" }, bearerToken: "saved" }).pipe(Effect.flip);
    }).pipe(Effect.provide(webConnectionLayer(options))));
    expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
    expect(exchanges).toBe(0); expect(validations).toEqual([]);
  });

  it("moves legacy browser catalog credentials into the separate store and scrubs the record", async () => {
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
    }).pipe(Effect.provide(webConnectionLayer(options))));
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
    await metadata.save({ environmentId }, createEmptyWorkspaceMetadata());
    await metadata.save({ environmentId: "other" }, createEmptyWorkspaceMetadata());
    await Effect.runPromise(Effect.gen(function* () {
      const cleanup = yield* EnvironmentOwnedDataCleanup;
      yield* cleanup.clear(environmentId);
    }).pipe(Effect.provide(webConnectionLayer(options))));
    expect(await metadata.load({ environmentId })).toBeNull();
    expect(await metadata.load({ environmentId: "other" })).not.toBeNull();
  });
});
