import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentId } from "@gitgui/contracts/environment";
import { BearerConnectionCredential } from "@gitgui/client-runtime/connection/catalog";
import { PrimaryConnectionTarget, BearerConnectionTarget } from "@gitgui/client-runtime/connection/model";
import { ConnectionCredentialStore } from "@gitgui/client-runtime/connection/credentialStore";
import * as Registry from "@gitgui/client-runtime/connection/registry";
import * as Supervisor from "@gitgui/client-runtime/connection/supervisor";
import { WebApplicationRuntime } from "./runtime";

const fixture = vi.hoisted(() => ({ registry: undefined as any, credentials: undefined as any, descriptor: undefined as any, authorize: undefined as any }));
vi.mock("@gitgui/client-runtime/environment/descriptor", () => ({ fetchRemoteEnvironmentDescriptor: () => fixture.descriptor }));
vi.mock("./platform", async (original) => ({
  ...await original<typeof import("./platform")>(),
  authorizeConnectionCredential: (...args: unknown[]) => fixture.authorize(...args),
  webConnectionLayer: () => Layer.merge(
    Layer.succeed(Registry.EnvironmentRegistry, fixture.registry),
    Layer.succeed(ConnectionCredentialStore, fixture.credentials),
  ),
}));

const id = EnvironmentId.make("environment-1");
function storage(): Storage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, clear: () => map.clear(), key: (i) => [...map.keys()][i] ?? null,
    getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: (key) => { map.delete(key); } };
}

beforeEach(() => {
  vi.stubGlobal("window", { location: { protocol: "https:" } });
  fixture.descriptor = Effect.succeed({ environmentId: id, label: "Home" });
  fixture.authorize = vi.fn(() => Effect.succeed(new BearerConnectionCredential({ token: "new-session" })));
});
afterEach(() => vi.unstubAllGlobals());

function setup(kind: "primary" | "bearer", desktop = false) {
  const target = kind === "primary"
    ? new PrimaryConnectionTarget({ environmentId: id, label: "Home", httpBaseUrl: "https://host.example/", wsBaseUrl: "wss://host.example/" })
    : new BearerConnectionTarget({ environmentId: id, label: "Home", connectionId: "direct" });
  const entries = Effect.runSync(SubscriptionRef.make(new Map([[id, { target, profile: Option.none(), enabled: true }]])));
  const saved = new Map<string, string>();
  const disconnect = vi.fn();
  const connect = vi.fn();
  const supervisor = { disconnect: Effect.sync(disconnect), connect: Effect.sync(connect) };
  const reconnect = vi.fn((_id: EnvironmentId, action: Effect.Effect<void, never, Supervisor.EnvironmentSupervisor>) =>
    action.pipe(Effect.provideService(Supervisor.EnvironmentSupervisor, supervisor as any)));
  const register = vi.fn(() => Effect.succeed(true));
  fixture.registry = { entries, run: reconnect, register };
  fixture.credentials = { put: (key: string, credential: BearerConnectionCredential) => Effect.sync(() => { saved.set(key, credential.token); }) };
  const runtime = new WebApplicationRuntime({ desktop: desktop ? {} as any : null, storage: storage(), fetchFn: fetch });
  return { runtime, saved, reconnect, disconnect, connect, register };
}

describe("browser reauthentication", () => {
  it("updates the platform primary credential and retries without replacing its registration", async () => {
    const f = setup("primary");
    await f.runtime.addDirect("https://host.example/", { kind: "pairing", token: "pairing" });
    expect(f.saved.get(id)).toBe("new-session");
    expect(f.reconnect).toHaveBeenCalledOnce();
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.register).not.toHaveBeenCalled();
  });
  it("rejects another primary origin before spending the pairing credential", async () => {
    const f = setup("primary");
    await expect(f.runtime.addDirect("https://other.example/", { kind: "pairing", token: "pairing" })).rejects.toThrow("configured address");
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(f.saved.size).toBe(0);
  });
  it("retains an existing session if pairing fails", async () => {
    const f = setup("primary");
    f.saved.set(id, "previous");
    fixture.authorize.mockReturnValue(Effect.fail(new Error("pairing rejected")));
    await expect(f.runtime.addDirect("https://host.example/", { kind: "pairing", token: "bad" })).rejects.toThrow("pairing rejected");
    expect(f.saved.get(id)).toBe("previous");
    expect(f.reconnect).not.toHaveBeenCalled();
  });
  it("rejects attempts to replace the desktop-managed primary", async () => {
    const f = setup("primary", true);
    await expect(f.runtime.addDirect("https://host.example/", { kind: "pairing", token: "pairing" })).rejects.toThrow("configured address");
    expect(fixture.authorize).not.toHaveBeenCalled();
  });
  it("registers a saved bearer environment through the existing registry", async () => {
    const f = setup("bearer");
    await f.runtime.addDirect("https://host.example/", { kind: "pairing", token: "pairing" });
    expect(f.register).toHaveBeenCalledOnce();
    expect(f.reconnect).not.toHaveBeenCalled();
  });
});
