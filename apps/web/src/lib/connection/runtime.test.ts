import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentId } from "@gitgui/contracts/environment";
import { BearerConnectionTarget, PrimaryConnectionTarget, type SupervisorConnectionState, type ConnectionCatalogEntry } from "@gitgui/client-runtime";
import * as Registry from "@gitgui/client-runtime/connection/registry";
import * as Supervisor from "@gitgui/client-runtime/connection/supervisor";
import type { RpcSession } from "@gitgui/client-runtime/rpc/session";
import type { WebConnectionOptions } from "./platform";
import { WebApplicationRuntime } from "./runtime";

const fixture = vi.hoisted(() => ({ registry: undefined as unknown }));
vi.mock("./platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("./platform")>(),
  webConnectionLayer: () => Layer.succeed(Registry.EnvironmentRegistry, fixture.registry as Registry.EnvironmentRegistry["Service"]),
}));

function storage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; }, clear: () => map.clear(), key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null, removeItem: (key) => { map.delete(key); }, setItem: (key, value) => { map.set(key, value); },
  };
}
const connected: SupervisorConnectionState = { desired: true, network: "online", phase: "connected", stage: null, attempt: 0, generation: 1, lastFailure: null, retryAt: null };
function session(id: string, serverId = id): RpcSession {
  return {
    client: { call: () => Effect.succeed({ repositories: [] }), events: Stream.never },
    welcome: Effect.succeed({ type: "welcome", server_id: serverId, environment_id: id, protocol_version: 2, capabilities: [] }),
    sequenceGaps: Stream.never, ready: Effect.void, probe: Effect.void, closed: Effect.never,
  } as unknown as RpcSession;
}
let runtime: WebApplicationRuntime | undefined;
afterEach(async () => { await runtime?.stop(); runtime = undefined; });
function setup(savedSelection?: string) {
  const entries = Effect.runSync(SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(new Map()));
  const supervisors = new Map<EnvironmentId, Supervisor.EnvironmentSupervisor["Service"]>();
  fixture.registry = {
    start: Effect.void, entries,
    followStream: (id: EnvironmentId, stream: Stream.Stream<unknown, unknown, Supervisor.EnvironmentSupervisor>) =>
      SubscriptionRef.changes(entries).pipe(Stream.switchMap(() => {
        const supervisor = supervisors.get(id);
        return supervisor === undefined ? Stream.empty : stream.pipe(Stream.provideService(Supervisor.EnvironmentSupervisor, supervisor));
      })),
    run: (id: EnvironmentId, effect: Effect.Effect<unknown, unknown, Supervisor.EnvironmentSupervisor>) => Effect.suspend(() => {
      const supervisor = supervisors.get(id);
      return supervisor === undefined ? Effect.fail(new Registry.EnvironmentNotRegisteredError({ environmentId: id }))
        : effect.pipe(Effect.provideService(Supervisor.EnvironmentSupervisor, supervisor));
    }),
  };
  const options: WebConnectionOptions = { desktop: null, storage: storage(), fetchFn: fetch };
  if (savedSelection) options.storage.setItem("gitgui.selectedEnvironment.v3", savedSelection);
  runtime = new WebApplicationRuntime(options);
  const add = async (value: string, serverId = value, kind: "primary" | "bearer" = "primary") => {
    const id = EnvironmentId.make(value);
    const target = kind === "primary"
      ? new PrimaryConnectionTarget({ environmentId: id, label: value, httpBaseUrl: `https://${value}.test`, wsBaseUrl: `wss://${value}.test` })
      : new BearerConnectionTarget({ environmentId: id, label: value, connectionId: `direct:${value}` });
    const currentSession = Effect.runSync(SubscriptionRef.make(Option.some(session(value, serverId))));
    const state = Effect.runSync(SubscriptionRef.make(connected));
    supervisors.set(id, { target, session: currentSession, state } as Supervisor.EnvironmentSupervisor["Service"]);
    await Effect.runPromise(SubscriptionRef.update(entries, (current) => new Map(current).set(id, { target, profile: Option.none(), enabled: true })));
    return { currentSession, state };
  };
  return { runtime, add };
}

describe("Svelte runtime session ownership", () => {
  it("attaches a saved primary selection when asynchronous registration arrives", async () => {
    const f = setup("a");
    await f.runtime.start();
    expect(f.runtime.state.workspace).toBeNull();
    await f.add("a");
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("a"));
    expect(f.runtime.state.registry.selectedEnvironmentId).toBe("a");
    expect(f.runtime.state.workspace).not.toBeNull();
  });

  it("reattaches the selected session and workspace when persistence rejects removal", async () => {
    const f = setup("a");
    Object.assign(fixture.registry as object, { remove: () => Effect.fail(new Error("disk unavailable")) });
    await f.runtime.start();
    await f.add("a", "a", "bearer");
    await vi.waitFor(() => expect(f.runtime.state.workspace).not.toBeNull());
    const previousWorkspace = f.runtime.state.workspace;
    await expect(f.runtime.removeEnvironment("a")).rejects.toThrow("disk unavailable");
    await vi.waitFor(() => expect(f.runtime.state.workspace).not.toBeNull());
    expect(f.runtime.state.workspace).not.toBe(previousWorkspace);
    expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("a");
    expect(f.runtime.state.registry.entries).toHaveLength(1);
    f.runtime.selectEnvironment("a");
    expect(f.runtime.state.workspace).not.toBeNull();
  });

  it("isolates two environments across switching, old session replacement, and reconnect", async () => {
    const f = setup();
    await f.runtime.start();
    const a = await f.add("a");
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("a"));
    const first = f.runtime.state.client!;
    const disposed = vi.spyOn(first, "dispose");
    const b = await f.add("b");
    f.runtime.selectEnvironment("b");
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("b"));
    expect(disposed).toHaveBeenCalledOnce();
    await Effect.runPromise(SubscriptionRef.set(a.currentSession, Option.some(session("a-replaced"))));
    await Effect.runPromise(SubscriptionRef.set(a.currentSession, Option.none()));
    await Effect.runPromise(Effect.sleep("20 millis"));
    expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("b");
    expect(f.runtime.state.registry.selectedEnvironmentId).toBe("b");
    await Effect.runPromise(SubscriptionRef.set(b.currentSession, Option.none()));
    await vi.waitFor(() => expect(f.runtime.state.client).toBeNull());
    await Effect.runPromise(SubscriptionRef.set(b.currentSession, Option.some(session("b"))));
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("b"));
    await f.add("b", "b-new-supervisor");
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.server_id).toBe("b-new-supervisor"));
    await Effect.runPromise(SubscriptionRef.set(a.currentSession, Option.some(session("a"))));
    f.runtime.selectEnvironment("a");
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("a"));
  });
});
