import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitGuiClient } from "../rpc/client";
import type { ConnectionDriver } from "./driver";
import type { ConnectionPlatform, RpcSession, RuntimeWakeup } from "./model";
import { EnvironmentRegistry } from "./registry";
import { MemoryCatalogStore, MemoryCredentialStore } from "./stores";

afterEach(() => vi.unstubAllGlobals());

describe("EnvironmentRegistry", () => {
  it("owns independent environments and removes all client-owned state", async () => {
    const descriptors = new Map([
      ["https://one.test/.well-known/gitgui/environment", descriptor("00000000-0000-4000-8000-000000000001", "One")],
      ["https://two.test/.well-known/gitgui/environment", descriptor("00000000-0000-4000-8000-000000000002", "Two")],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const value = descriptors.get(String(input));
      return value
        ? new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404 });
    }));

    const catalog = new MemoryCatalogStore();
    const credentials = new MemoryCredentialStore();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const platform = makePlatform(cleanup);
    const connect = vi.fn(async (registration) => makeSession(registration.environmentId));
    const registry = new EnvironmentRegistry(
      catalog,
      credentials,
      platform,
      () => ({ connect } as unknown as ConnectionDriver),
    );
    await registry.start();

    const first = await registry.addBearer("https://one.test", { kind: "pairing", token: "first-secret" });
    const second = await registry.addBearer("https://two.test", { kind: "pairing", token: "second-secret" });
    await flush();

    expect(registry.state.entries).toHaveLength(2);
    expect(registry.state.selectedEnvironmentId).toBe(second.environmentId);
    expect(registry.state.entries.every((entry) => entry.connection.phase === "connected")).toBe(true);
    expect(registry.currentSession(first.environmentId)).not.toBeNull();
    expect(registry.currentSession(second.environmentId)).not.toBeNull();

    await registry.remove(second.environmentId);
    expect(registry.state.entries.map((entry) => entry.registration.environmentId)).toEqual([first.environmentId]);
    expect(registry.state.selectedEnvironmentId).toBe(first.environmentId);
    expect(await credentials.get(second.environmentId)).toBeUndefined();
    expect((await catalog.load()).registrations.map((entry) => entry.environmentId)).toEqual([first.environmentId]);
    expect(cleanup).toHaveBeenCalledWith(second.environmentId);
    await registry.stop();
  });
});

function makePlatform(cleanup: (environmentId: string) => Promise<void>): ConnectionPlatform {
  return {
    isOnline: () => true,
    subscribeNetwork: () => () => undefined,
    subscribeWakeups: (_listener: (reason: RuntimeWakeup) => void) => () => undefined,
    async getPrimaryConnection() { return null; },
    async ensureSshConnection() { throw new Error("not used"); },
    cleanupEnvironment: cleanup,
  };
}

function descriptor(environmentId: string, label: string) {
  return {
    schemaVersion: 1,
    environmentId,
    label,
    serverVersion: "0.1.0",
    protocolVersion: 2,
    platform: "test",
    architecture: "test",
    capabilities: [],
    auth: { required: false, bootstrapMethods: [], sessionMethods: [] },
    endpoints: [],
  };
}

function makeSession(environmentId: string): RpcSession {
  let resolveClosed!: (error: Error) => void;
  return {
    client: {} as GitGuiClient,
    descriptor: descriptor(environmentId, environmentId),
    ready: Promise.resolve(),
    closed: new Promise<Error>((resolve) => (resolveClosed = resolve)),
    async probe() {},
    close(reason = "closed") { resolveClosed(new Error(reason)); },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
