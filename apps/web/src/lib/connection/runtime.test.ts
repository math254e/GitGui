import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type { OrderedEventEnvelope, RepositorySnapshot, RepositorySummary, WelcomeMessage } from "@gitgui/contracts";
import { LocalStorageWorkspaceMetadataAdapter, workspaceMetadataKey } from "../client-runtime/metadata";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentId } from "@gitgui/contracts/environment";
import { BearerConnectionTarget, PrimaryConnectionTarget, type SupervisorConnectionState, type ConnectionCatalogEntry } from "@gitgui/client-runtime";
import * as Registry from "@gitgui/client-runtime/connection/registry";
import * as Supervisor from "@gitgui/client-runtime/connection/supervisor";
import { ConnectionWakeups, type ConnectionWakeup } from "@gitgui/client-runtime/connection/wakeups";
import { ConnectionBlockedError } from "@gitgui/client-runtime/connection/model";
import type { RpcSession } from "@gitgui/client-runtime/rpc/session";
import { GitGuiRpcError } from "@gitgui/client-runtime/rpc";
import { clearEnvironmentOwnedData, type WebConnectionOptions } from "./platform";
import { WebApplicationRuntime, connectionDisplayName } from "./runtime";
import { RepositoryCatalogCache } from "./repository-catalog-cache";
import { EnvironmentWorkspaceRemovalJournal } from "../client-runtime/application-workspace-metadata";
import { ApplicationWorkspace } from "../client-runtime/application-workspace";

const fixture = vi.hoisted(() => ({ registry: undefined as unknown, wakeups: undefined as unknown }));
vi.mock("./platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("./platform")>(),
  webConnectionLayer: () => Layer.merge(
    Layer.succeed(Registry.EnvironmentRegistry, fixture.registry as Registry.EnvironmentRegistry["Service"]),
    Layer.succeed(ConnectionWakeups, fixture.wakeups as ConnectionWakeups["Service"]),
  ),
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
    sessionScopes: ["repository:read", "repository:operate", "repository:manage"],
    client: { call: () => Effect.succeed({ repositories: [] }), events: Stream.never },
    welcome: Effect.succeed({ type: "welcome", server_id: serverId, environment_id: id, protocol_version: 2, capabilities: [] }),
    sequenceGaps: Stream.never, ready: Effect.void, probe: Effect.void, closed: Effect.never,
  } as unknown as RpcSession;
}
let runtime: WebApplicationRuntime | undefined;
afterEach(async () => { await runtime?.stop(); runtime = undefined; });
function setup(savedSelection?: string, tabOwnership: "legacy" | "external" = "legacy") {
  const wakeups = Effect.runSync(PubSub.unbounded<ConnectionWakeup>());
  const wakeupReaders = { count: 0 };
  fixture.wakeups = { changes: Stream.fromPubSub(wakeups).pipe(
    Stream.onStart(Effect.sync(() => { wakeupReaders.count += 1; })),
    Stream.ensuring(Effect.sync(() => { wakeupReaders.count -= 1; })),
  ) };
  const entries = Effect.runSync(SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(new Map()));
  const supervisors = new Map<EnvironmentId, Supervisor.EnvironmentSupervisor["Service"]>();
  const followers = new Map<string, number>();
  const durable = new Set<string>();
  fixture.registry = {
    start: Effect.void, entries,
    recoverRemoval: (id: EnvironmentId, complete: (removed: boolean) => Effect.Effect<void>) => Effect.gen(function* () {
      const primary = (yield* SubscriptionRef.get(entries)).get(id)?.target._tag === "PrimaryConnectionTarget";
      const removed = !primary && !durable.has(id);
      if (removed) yield* Effect.promise(() => clearEnvironmentOwnedData(options.storage, id));
      yield* complete(removed);
    }),
    followStream: (id: EnvironmentId, stream: Stream.Stream<unknown, unknown, Supervisor.EnvironmentSupervisor>) =>
      SubscriptionRef.changes(entries).pipe(Stream.switchMap(() => {
        const supervisor = supervisors.get(id);
        return supervisor === undefined ? Stream.empty : stream.pipe(Stream.provideService(Supervisor.EnvironmentSupervisor, supervisor));
      }), Stream.onStart(Effect.sync(() => { followers.set(id, (followers.get(id) ?? 0) + 1); })),
      Stream.ensuring(Effect.sync(() => { followers.set(id, (followers.get(id) ?? 0) - 1); }))),
    run: (id: EnvironmentId, effect: Effect.Effect<unknown, unknown, Supervisor.EnvironmentSupervisor>) => Effect.suspend(() => {
      const supervisor = supervisors.get(id);
      return supervisor === undefined ? Effect.fail(new Registry.EnvironmentNotRegisteredError({ environmentId: id }))
        : effect.pipe(Effect.provideService(Supervisor.EnvironmentSupervisor, supervisor));
    }),
  };
  const options: WebConnectionOptions = { desktop: null, storage: storage(), fetchFn: fetch };
  if (savedSelection) options.storage.setItem("gitgui.selectedEnvironment.v3", savedSelection);
  runtime = new WebApplicationRuntime(options, { tabOwnership });
  const add = async (value: string, serverId = value, kind: "primary" | "bearer" = "primary", initialSession: RpcSession | null = session(value, serverId)) => {
    if (kind === "bearer") durable.add(value);
    const id = EnvironmentId.make(value);
    const target = kind === "primary"
      ? new PrimaryConnectionTarget({ environmentId: id, label: value, httpBaseUrl: `https://${value}.test`, wsBaseUrl: `wss://${value}.test` })
      : new BearerConnectionTarget({ environmentId: id, label: value, connectionId: `direct:${value}` });
    const currentSession = Effect.runSync(SubscriptionRef.make(initialSession === null ? Option.none<RpcSession>() : Option.some(initialSession)));
    const state = Effect.runSync(SubscriptionRef.make(connected));
    supervisors.set(id, { target, session: currentSession, state } as Supervisor.EnvironmentSupervisor["Service"]);
    await Effect.runPromise(SubscriptionRef.update(entries, (current) => new Map(current).set(id, { target, profile: Option.none(), enabled: true })));
    return { currentSession, state };
  };
  return { runtime, add, entries, followers, durable, storage: options.storage, wakeupReaders,
    wake: (reason: ConnectionWakeup = "application-active") => Effect.runPromise(PubSub.publish(wakeups, reason)),
  };
}

function dataSession(environmentId: string, serverId = environmentId) {
  const repository: RepositorySummary = { id: "same", name: environmentId, path: `/${environmentId}`, root: `/${environmentId}`, isWorktree: false };
  let branch = "main";
  const snapshot = (): RepositorySnapshot => ({
    info: { path: repository.path, root: repository.root },
    status: { currentBranch: branch, headOid: branch, ahead: 0, behind: 0, changedFiles: [] },
    commits: [], graph: { commits: [], edges: [], headLane: null, width: 1 }, refs: [], stashes: [], worktrees: [],
  });
  const events = Effect.runSync(PubSub.unbounded<OrderedEventEnvelope>());
  const gaps = Effect.runSync(PubSub.unbounded<{ expected: number; received: number }>());
  const readers = { events: 0, gaps: 0 };
  const call = vi.fn((method: string, _input?: unknown): Effect.Effect<unknown, Error> => Effect.sync(() => {
    if (method === "repositories.list") return { repositories: [repository] };
    if (method === "repositories.refresh") return { repositories: [{ repositoryId: "same", repository, snapshot: snapshot() }] };
    if (method === "git.status") return { repository, status: snapshot().status };
    return { repository, snapshot: snapshot() };
  }));
  const rpcSession = {
    ...session(environmentId, serverId),
    client: { call, events: Stream.fromPubSub(events).pipe(
      Stream.onStart(Effect.sync(() => { readers.events += 1; })),
      Stream.ensuring(Effect.sync(() => { readers.events -= 1; })),
    ) },
    sequenceGaps: Stream.fromPubSub(gaps).pipe(
      Stream.onStart(Effect.sync(() => { readers.gaps += 1; })),
      Stream.ensuring(Effect.sync(() => { readers.gaps -= 1; })),
    ),
  } as unknown as RpcSession;
  let sequence = 0;
  return { session: rpcSession, repository, call, readers, snapshot,
    setBranch(value: string) { branch = value; },
    emit: (kind: "snapshot" | "status", seq = ++sequence) => Effect.runPromise(PubSub.publish(events, {
      type: "event", event: "repository.changed", sequence: seq, payload: { repositoryId: "same", kind },
    })),
    gap: () => Effect.runPromise(PubSub.publish(gaps, { expected: 1, received: 3 })),
  };
}

async function saveTab(store: Storage, environmentId: string) {
  await new LocalStorageWorkspaceMetadataAdapter(store).save({ environmentId }, {
    schemaVersion: 1, openRepositoryIds: ["same"], activeRepositoryId: "same", recentRepositories: [],
  });
}

describe("Svelte runtime session ownership", () => {
  it("starts and accepts a rename when browser name preferences are malformed", async () => {
    const f = setup(undefined, "external");
    f.storage.setItem("gitgui.environmentNames.v1", "{broken");
    await f.runtime.start();
    await f.add("a", "a", "primary", dataSession("a").session);
    await vi.waitFor(() => expect(f.runtime.state.registry.entries).toHaveLength(1));
    await f.runtime.renameEnvironment("a", "Workstation");
    expect(f.runtime.state.registry.entries[0].registration.displayName).toBe("Workstation");
  });
  it("renames primary and offline environments without changing sessions, routes, selection, tabs or cached repository data", async () => {
    const f = setup(undefined, "external"), a = dataSession("a"), b = dataSession("b");
    f.storage.setItem("gitgui.environmentNames.v1", JSON.stringify({ a: "GitGui on purpose" }));
    await f.runtime.start();
    const first = await f.add("a", "a", "primary", a.session);
    const second = await f.add("b", "b", "bearer", b.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.ready).toBe(true));
    const application = new ApplicationWorkspace(f.runtime, f.storage); await application.start();
    try {
      await application.open({ environmentId: "a", repositoryId: "same" });
      await application.open({ environmentId: "b", repositoryId: "same" });
      await Effect.runPromise(SubscriptionRef.set(second.state, { ...connected, phase: "offline" as const }));
      const tabs = JSON.stringify(application.state.tabs);
      const entries = Effect.runSync(SubscriptionRef.get(f.entries));
      const firstSession = Effect.runSync(SubscriptionRef.get(first.currentSession));
      const secondSession = Effect.runSync(SubscriptionRef.get(second.currentSession));
      const firstGeneration = f.runtime.environmentWorkspaces.a.generation;
      const secondGeneration = f.runtime.environmentWorkspaces.b.generation;
      const beforeStorage = [...Array(f.storage.length)].map((_, i) => f.storage.key(i)!).filter((key) => key !== "gitgui.environmentNames.v1")
        .map((key) => [key, f.storage.getItem(key)]);
      expect(f.runtime.state.registry.entries.find((entry) => entry.registration.environmentId === "a")?.registration.displayName).toBe("GitGui on purpose");
      await f.runtime.renameEnvironment("a", "  My workstation  ");
      await f.runtime.renameEnvironment("b", "Build server");
      expect(f.runtime.state.registry.entries.map((entry) => entry.registration.displayName)).toEqual(["My workstation", "Build server"]);
      expect(JSON.parse(f.storage.getItem("gitgui.environmentNames.v1")!)).toEqual({ a: "My workstation", b: "Build server" });
      expect(Effect.runSync(SubscriptionRef.get(f.entries))).toBe(entries);
      expect(Effect.runSync(SubscriptionRef.get(first.currentSession))).toBe(firstSession);
      expect(Effect.runSync(SubscriptionRef.get(second.currentSession))).toBe(secondSession);
      expect(f.runtime.environmentWorkspaces.a.generation).toBe(firstGeneration);
      expect(f.runtime.environmentWorkspaces.b.generation).toBe(secondGeneration);
      expect(JSON.stringify(application.state.tabs)).toBe(tabs);
      for (const [key, value] of beforeStorage) expect(f.storage.getItem(key!)).toBe(value);
      const setItem = vi.spyOn(f.storage, "setItem").mockImplementationOnce(() => { throw new Error("disk full"); });
      await expect(f.runtime.renameEnvironment("a", "Unsaved")).rejects.toThrow("disk full");
      setItem.mockRestore();
      expect(f.runtime.state.registry.entries[0]?.registration.displayName).toBe("My workstation");
      await expect(f.runtime.renameEnvironment("a", "  ")).rejects.toThrow("environment name");
      await expect(f.runtime.renameEnvironment("missing", "Name")).rejects.toThrow("no longer registered");
    } finally { application.dispose(); }
  });

  it("uses the SSH alias for a remote server's generic local label", () => {
    const entry = { target: { _tag: "SshConnectionTarget", label: "GitGui on This computer" },
      profile: Option.some({ _tag: "SshConnectionProfile", target: { alias: "agentbox", hostname: "agentbox" } }), enabled: true } as unknown as ConnectionCatalogEntry;
    expect(connectionDisplayName(entry)).toBe("agentbox");
    expect(connectionDisplayName({ ...entry, target: { ...entry.target, label: "Work server" } } as ConnectionCatalogEntry)).toBe("Work server");
  });
  it("isolates authenticated grants and guards current-session commands across loss and replacement", async () => {
    const f = setup(undefined, "external"), a = dataSession("a"), limited = dataSession("b");
    const limitedSession = { ...limited.session, sessionScopes: ["repository:read", "repository:operate"] };
    await f.runtime.start();
    await f.add("a", "a", "primary", a.session);
    const handle = await f.add("b", "b", "bearer", limitedSession);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.ready).toBe(true));
    const client = f.runtime.getEnvironmentWorkspace("b")!.client;
    expect(f.runtime.environmentWorkspaces.b.sessionScopes).toEqual(limitedSession.sessionScopes);
    const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
    try {
      await app.open({ environmentId: "b", repositoryId: "same" });
      const source = app.state.tabs[0];
      await app.switchPath(source.tabId, limited.repository.root, source.target);
      expect(limited.call).toHaveBeenCalledWith("repositories.get_snapshot", { repositoryId: "same" });
      for (const action of [() => client.openRepository("/unregistered"), () => client.createRepository("/srv", "demo"), () => client.removeRepository("same")]) {
        await expect(action()).rejects.toThrow("repository:manage");
      }
      expect(limited.call.mock.calls.some(([method]) => ["repositories.open", "repositories.create", "repositories.remove"].includes(method))).toBe(false);
      await f.runtime.getEnvironmentWorkspace("a")!.client.removeRepository("same");
      expect(a.call).toHaveBeenCalledWith("repositories.remove", { repositoryId: "same" });

      const generation = f.runtime.environmentWorkspaces.b.generation;
      await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.none()));
      await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b.sessionScopes).toBeNull());
      expect(f.runtime.environmentWorkspaces.a.sessionScopes).toContain("repository:manage");
      const unknown = dataSession("b", "unknown");
      await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.some({ ...unknown.session, sessionScopes: undefined })));
      await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.welcome?.server_id).toBe("unknown"));
      await expect(client.removeRepository("same")).rejects.toThrow("authorization is unavailable");
      expect(unknown.call).not.toHaveBeenCalledWith("repositories.remove", expect.anything());

      const full = dataSession("b", "full");
      await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.some(full.session)));
      await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.welcome?.server_id).toBe("full"));
      expect(f.runtime.environmentWorkspaces.b.generation).toBeGreaterThan(generation);
      await client.openRepository("/new"); await client.createRepository("/srv", "demo"); await client.removeRepository("same");
      expect(full.call.mock.calls.map(([method]) => method)).toEqual(expect.arrayContaining(["repositories.open", "repositories.create", "repositories.remove"]));

      // Even before the presentation watcher runs, dispatch reads the replacement.
      const downgraded = dataSession("b", "downgraded");
      await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.some({ ...downgraded.session, sessionScopes: ["repository:read"] })));
      await expect(client.removeRepository("same")).rejects.toThrow("repository:manage");
      expect(downgraded.call).not.toHaveBeenCalledWith("repositories.remove", expect.anything());
      expect(f.runtime.environmentWorkspaces.a.sessionScopes).toContain("repository:manage");
    } finally { app.dispose(); }
  });

  it("revalidates healthy catalogs on wakeup without tabs, coalesces per session and releases the listener", async () => {
    const f = setup(undefined, "external"), a = dataSession("a"), b = dataSession("b");
    await f.runtime.start();
    await f.add("a", "a", "primary", a.session);
    const handle = await f.add("b", "b", "bearer", b.session);
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b?.status).toBe("live"));
    const generations = [f.runtime.environmentWorkspaces.a.generation, f.runtime.environmentWorkspaces.b.generation];
    expect(f.runtime.environmentWorkspaces.a.workspaceState.openRepositoryIds).toEqual([]);
    expect(f.runtime.environmentWorkspaces.b.workspaceState.openRepositoryIds).toEqual([]);
    let finish!: (value: { repositories: RepositorySummary[] }) => void;
    const delayed = new Promise<{ repositories: RepositorySummary[] }>((resolve) => { finish = resolve; });
    a.call.mockClear(); b.call.mockClear();
    a.call.mockImplementation(() => Effect.promise(() => delayed));
    const remote = { ...b.repository, id: "added-by-another-client" };
    b.call.mockImplementation(() => Effect.succeed({ repositories: [remote] }));
    await f.wake(); await f.wake("application-active-probe"); await f.wake();
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b.repositories).toEqual([remote]));
    expect(a.call).toHaveBeenCalledTimes(1);
    expect(b.call).toHaveBeenCalledTimes(1);
    // An additional foreground signal must not cancel/restart a slow read.
    await f.wake();
    await vi.waitFor(() => expect(b.call).toHaveBeenCalledTimes(2));
    const joined = f.runtime.refreshEnvironmentCatalog("a", { coalesce: true });
    expect(a.call).toHaveBeenCalledTimes(1);
    finish({ repositories: [] }); await joined;
    expect(f.runtime.state.catalogs.a.repositories).toEqual([]);
    expect(new RepositoryCatalogCache(f.storage).load("b")).toEqual([remote]);
    expect([f.runtime.environmentWorkspaces.a.generation, f.runtime.environmentWorkspaces.b.generation]).toEqual(generations);
    expect(Effect.runSync(SubscriptionRef.get(handle.currentSession))).toEqual(Option.some(b.session));
    expect(a.call.mock.calls.every(([method]) => method === "repositories.list")).toBe(true);
    expect(b.call.mock.calls.every(([method]) => method === "repositories.list")).toBe(true);
    await f.runtime.stop(); runtime = undefined;
    expect(f.wakeupReaders.count).toBe(0);
    await f.wake();
    expect(b.call).toHaveBeenCalledTimes(2);
  });

  it("lets explicit post-mutation catalog refresh supersede an older foreground read", async () => {
    const f = setup(undefined, "external"), a = dataSession("a");
    await f.runtime.start(); await f.add("a", "a", "primary", a.session);
    await vi.waitFor(() => expect(f.runtime.state.catalogs.a?.status).toBe("live"));
    let finish!: (value: { repositories: RepositorySummary[] }) => void;
    const old = new Promise<{ repositories: RepositorySummary[] }>((resolve) => { finish = resolve; });
    const added = { ...a.repository, id: "new-repository" };
    a.call.mockClear();
    a.call.mockImplementationOnce(() => Effect.promise(() => old))
      .mockImplementation(() => Effect.succeed({ repositories: [a.repository, added] }));
    await f.wake();
    await vi.waitFor(() => expect(a.call).toHaveBeenCalledTimes(1));
    await f.runtime.refreshEnvironmentCatalog("a");
    expect(f.runtime.state.catalogs.a.repositories).toEqual([a.repository, added]);
    finish({ repositories: [a.repository] });
    await Promise.resolve();
    expect(f.runtime.state.catalogs.a.repositories).toEqual([a.repository, added]);
  });
  it("keeps equal repository IDs open in separate environment workspaces", async () => {
    const f = setup(undefined, "external");
    const repo = (root: string) => ({ id: "same", name: root, root, path: root, isWorktree: false });
    const makeSession = (id: string, root: string) => {
      const repository = repo(root);
      const snapshot = { info: { path: root, root }, status: { currentBranch: "main", headOid: null, ahead: 0, behind: 0, changedFiles: [] },
        commits: [], refs: [], stashes: [], worktrees: [], graph: { commits: [], edges: [], headLane: null, width: 1 } };
      return { ...session(id), client: { events: Stream.never, call: (method: string) => Effect.succeed(
        method === "repositories.list" ? { repositories: [repository] } :
        method === "repositories.refresh" ? { repositories: [{ repositoryId: "same", repository, snapshot }] } : { repository, snapshot },
      ) } } as unknown as RpcSession;
    };
    await f.runtime.start();
    await f.add("a", "a", "primary", makeSession("a", "/local"));
    await f.add("b", "b", "bearer", makeSession("b", "/remote"));
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a?.welcome).toBeTruthy());
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.welcome).toBeTruthy());
    const app = new ApplicationWorkspace(f.runtime, f.storage);
    await app.start();
    await app.open({ environmentId: "a", repositoryId: "same" });
    await app.open({ environmentId: "b", repositoryId: "same" });
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a?.workspaceState.repositories.same?.snapshot?.info.root).toBe("/local"));
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.workspaceState.repositories.same?.snapshot?.info.root).toBe("/remote"));
    expect(app.state.tabs).toHaveLength(2);
    await expect(app.open({ environmentId: "a", repositoryId: "same" })).rejects.toThrow("already open");
    app.dispose();
  });
  it("preserves a registry startup failure in the compatibility projection", async () => {
    const f = setup();
    Object.assign(fixture.registry as object, { start: Effect.fail(new Error("Registration store unavailable")) });
    await f.runtime.start();
    expect(f.runtime.state.loading).toBe(false);
    expect(f.runtime.state.error).toContain("Registration store unavailable");
  });
  it("hydrates equal repository IDs independently and updates a nonselected workspace", async () => {
    const f = setup("a");
    await saveTab(f.storage, "a");
    await saveTab(f.storage, "b");
    const a = dataSession("a");
    const b = dataSession("b");
    await f.runtime.start();
    await f.add("a", "a", "primary", a.session);
    await f.add("b", "b", "bearer", b.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b.ready).toBe(true));
    const aWorkspace = f.runtime.getEnvironmentWorkspace("a")!.workspace;
    const bWorkspace = f.runtime.getEnvironmentWorkspace("b")!.workspace;
    expect(aWorkspace.state.openRepositoryIds).toEqual(["same"]);
    expect(bWorkspace.state.openRepositoryIds).toEqual(["same"]);
    expect(aWorkspace.state.repositories.same.repository.path).toBe("/a");
    expect(bWorkspace.state.repositories.same.repository.path).toBe("/b");
    b.setBranch("nonselected");
    await b.emit("snapshot", 100);
    await vi.waitFor(() => expect(bWorkspace.state.repositories.same.snapshot?.status.currentBranch).toBe("nonselected"));
    expect(aWorkspace.state.repositories.same.snapshot?.status.currentBranch).toBe("main");
    f.runtime.selectEnvironment("b");
    expect(f.runtime.state.workspace).toBe(bWorkspace);
    f.runtime.selectEnvironment("a");
    expect(f.runtime.state.workspace).toBe(aWorkspace);
    expect(a.readers).toEqual({ events: 1, gaps: 1 });
    expect(b.readers).toEqual({ events: 1, gaps: 1 });
  });

  it("retains offline placeholders, switches readers and capabilities, and disposes only removed data", async () => {
    const f = setup("a");
    await saveTab(f.storage, "a");
    await saveTab(f.storage, "b");
    const a = dataSession("a");
    const b = dataSession("b");
    await f.runtime.start();
    await f.add("a", "a", "primary", a.session);
    const handle = await f.add("b", "b", "bearer", b.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b.ready).toBe(true));
    const data = f.runtime.getEnvironmentWorkspace("b")!;
    b.setBranch("cached");
    await b.emit("snapshot", 100);
    await vi.waitFor(() => expect(data.workspace.state.repositories.same.snapshot?.status.currentBranch).toBe("cached"));
    await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.none()));
    await vi.waitFor(() => expect(b.readers).toEqual({ events: 0, gaps: 0 }));
    expect(data.workspace.state.openRepositoryIds).toEqual(["same"]);
    expect(data.workspace.state.repositories.same.snapshot?.status.currentBranch).toBe("cached");
    expect(data.state.welcome).toBeNull();
    await expect(data.client.stage("same")).rejects.toThrow("not connected");
    const next = dataSession("b", "next-supervisor");
    next.session = { ...next.session, welcome: Effect.succeed({ type: "welcome", environment_id: "b", server_id: "next-supervisor", protocol_version: 2, capabilities: ["repositories.watch"] }) };
    // Re-register replaces the supervisor rather than only its session ref.
    await f.add("b", "next-supervisor", "bearer", next.session);
    await vi.waitFor(() => expect(data.state.welcome?.server_id).toBe("next-supervisor"));
    await vi.waitFor(() => expect(data.state.loading).toBe(false));
    expect(f.runtime.getEnvironmentWorkspace("b")).toBe(data);
    expect(data.state.welcome?.capabilities).toEqual(["repositories.watch"]);
    next.setBranch("fresh-sequence");
    await next.emit("snapshot", 1);
    await vi.waitFor(() => expect(data.workspace.state.repositories.same.snapshot?.status.currentBranch).toBe("fresh-sequence"));
    next.setBranch("gap-recovery");
    await next.gap();
    await vi.waitFor(() => expect(data.workspace.state.repositories.same.snapshot?.status.currentBranch).toBe("gap-recovery"));
    await Effect.runPromise(SubscriptionRef.update(f.entries, (current) => {
      const entries = new Map(current); entries.delete(EnvironmentId.make("b")); return entries;
    }));
    await vi.waitFor(() => expect(next.readers).toEqual({ events: 0, gaps: 0 }));
    expect(f.runtime.getEnvironmentWorkspace("b")).toBeUndefined();
    expect(a.readers).toEqual({ events: 1, gaps: 1 });
    await expect(data.client.stage("same")).rejects.toThrow();
    await f.runtime.stop();
    runtime = undefined;
    expect(a.readers).toEqual({ events: 0, gaps: 0 });
    expect(f.runtime.environmentWorkspaces).toEqual({});
    expect([...f.followers.values()]).toEqual([0, 0]);
  });

  it("restores saved placeholders before an offline environment ever connects", async () => {
    const f = setup("a");
    await saveTab(f.storage, "b");
    await f.runtime.start();
    await f.add("a");
    await f.add("b", "b", "bearer", null);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b.workspaceState.openRepositoryIds).toEqual(["same"]));
    expect(f.runtime.environmentWorkspaces.b.workspaceState.repositories.same.loading).toBe(false);
    expect(f.runtime.state.registry.selectedEnvironmentId).toBe("a");
  });

  it("routes captured clients to the current session and never replays an uncertain mutation", async () => {
    const f = setup("a");
    const a = dataSession("a");
    const b = dataSession("b");
    await f.runtime.start();
    const handle = await f.add("a", "a", "primary", a.session);
    await f.add("b", "b", "bearer", b.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b.ready).toBe(true));
    const captured = f.runtime.getEnvironmentWorkspace("a")!.client;
    f.runtime.selectEnvironment("b");
    const next = dataSession("a", "replacement");
    await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.some(next.session)));
    await vi.waitFor(() => expect(captured.serverWelcome.server_id).toBe("replacement"));
    await captured.stage("same", ["captured"]);
    expect(next.call).toHaveBeenCalledWith("git.stage", { repositoryId: "same", paths: ["captured"] });
    expect(a.call.mock.calls.some(([method]) => method === "git.stage")).toBe(false);
    expect(b.call.mock.calls.some(([method]) => method === "git.stage")).toBe(false);
    let resolve!: (value: unknown) => void;
    const reply = new Promise((done) => { resolve = done; });
    next.call.mockImplementation((method) => method === "git.stage" ? Effect.promise(() => reply) : Effect.succeed({ repositories: [] }));
    const mutation = captured.stage("same", ["uncertain"]).catch((error) => error);
    await vi.waitFor(() => expect(next.call.mock.calls.filter(([method]) => method === "git.stage")).toHaveLength(2));
    const last = dataSession("a", "last");
    await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.some(last.session)));
    await vi.waitFor(() => expect(captured.serverWelcome.server_id).toBe("last"));
    expect(await mutation).toBeInstanceOf(Error);
    resolve({ repository: next.repository, snapshot: next.snapshot() });
    await Promise.resolve();
    expect(last.call.mock.calls.some(([method]) => method === "git.stage")).toBe(false);
    last.call.mockImplementation(() => Effect.fail(new GitGuiRpcError({ code: "forbidden", message: "Missing scope" })));
    await expect(captured.stage("same")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects delayed welcomes and stale refresh results after replacement or removal", async () => {
    const f = setup("a");
    await saveTab(f.storage, "b");
    await f.runtime.start();
    await f.add("a");
    const initial = dataSession("b");
    const handle = await f.add("b", "b", "bearer", initial.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b.ready).toBe(true));
    const data = f.runtime.getEnvironmentWorkspace("b")!;
    let resolveWelcome!: (value: WelcomeMessage) => void;
    const delayedWelcome = new Promise<WelcomeMessage>((done) => { resolveWelcome = done; });
    const delayed = dataSession("b", "delayed");
    await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.some({ ...delayed.session, welcome: Effect.promise(() => delayedWelcome) })));
    await vi.waitFor(() => expect(data.state.welcome).toBeNull());
    const newer = dataSession("b", "newer");
    newer.setBranch("newer");
    await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.some(newer.session)));
    await vi.waitFor(() => expect(data.workspace.state.repositories.same.snapshot?.status.currentBranch).toBe("newer"));
    resolveWelcome(await Effect.runPromise(delayed.session.welcome));
    await Promise.resolve();
    expect(delayed.readers).toEqual({ events: 0, gaps: 0 });
    expect(data.state.welcome?.server_id).toBe("newer");
    let resolveRefresh!: (value: unknown) => void;
    const delayedRefresh = new Promise((done) => { resolveRefresh = done; });
    newer.call.mockImplementation((method) => method === "repositories.refresh" ? Effect.promise(() => delayedRefresh) : Effect.succeed({ repositories: [newer.repository] }));
    const pending = data.workspace.refreshAllRepositories();
    await vi.waitFor(() => expect(data.workspace.state.refreshing).toBe(true));
    const last = dataSession("b", "last"); last.setBranch("last");
    await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.some(last.session)));
    await vi.waitFor(() => expect(data.workspace.state.repositories.same.snapshot?.status.currentBranch).toBe("last"));
    resolveRefresh({ repositories: [{ repositoryId: "same", repository: newer.repository, snapshot: newer.snapshot() }] });
    await pending;
    expect(data.workspace.state.repositories.same.snapshot?.status.currentBranch).toBe("last");
    await Effect.runPromise(SubscriptionRef.update(f.entries, (current) => {
      const entries = new Map(current); entries.delete(EnvironmentId.make("b")); return entries;
    }));
    await vi.waitFor(() => expect(last.readers).toEqual({ events: 0, gaps: 0 }));
    expect(f.runtime.environmentWorkspaces.b).toBeUndefined();
  });

  it("projects external targets without writing an independent tab list", async () => {
    const f = setup("a", "external");
    await saveTab(f.storage, "a");
    const legacyKey = `gitgui.workspace.${workspaceMetadataKey({ environmentId: "a" })}`;
    const legacyBefore = f.storage.getItem(legacyKey);
    expect(legacyBefore).not.toBeNull();
    const a = dataSession("a");
    await f.runtime.start();
    await f.add("a", "a", "primary", a.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a.ready).toBe(true));
    const data = f.runtime.getEnvironmentWorkspace("a")!;
    expect(data.workspace.state.openRepositoryIds).toEqual([]);
    await data.setRepositoryTargets(["same"], "same");
    expect(data.workspace.state.repositories.same.snapshot?.status.currentBranch).toBe("main");
    const calls = a.call.mock.calls.length;
    await data.setRepositoryTargets(["same"], "same");
    expect(a.call).toHaveBeenCalledTimes(calls);
    let pendingReads = 0;
    a.call.mockImplementationOnce(() => Effect.sync(() => { pendingReads += 1; }).pipe(
      Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { pendingReads -= 1; })),
    ));
    const pending = data.workspace.refreshAllRepositories();
    await vi.waitFor(() => expect(pendingReads).toBe(1));
    await data.setRepositoryTargets([]);
    await pending;
    expect(pendingReads).toBe(0);
    expect(data.workspace.state.openRepositoryIds).toEqual([]);
    await data.workspace.removeRecentRepository("same");
    expect(f.storage.getItem(legacyKey)).toBe(legacyBefore);
    await expect(data.workspace.openKnownRepository("same")).rejects.toThrow("external coordinator");
  });

  it("keeps failures scoped and ignores a removed environment's delayed activation after re-registration", async () => {
    const f = setup("a");
    const a = dataSession("a");
    const b = dataSession("b");
    let resolve!: (welcome: WelcomeMessage) => void;
    const delayed = new Promise<WelcomeMessage>((done) => { resolve = done; });
    await f.runtime.start();
    const aHandle = await f.add("a", "a", "primary", a.session);
    const bHandle = await f.add("b", "b", "bearer", { ...b.session, welcome: Effect.promise(() => delayed) });
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a.ready).toBe(true));
    const removed = f.runtime.getEnvironmentWorkspace("b")!;
    await Effect.runPromise(SubscriptionRef.set(bHandle.state, { ...connected, phase: "blocked", lastFailure:
      new ConnectionBlockedError({ reason: "authentication", detail: "Pair again" }),
    } satisfies SupervisorConnectionState));
    await vi.waitFor(() => expect(f.runtime.state.registry.entries.find((entry) => entry.registration.environmentId === "b")?.connection.phase).toBe("blocked"));
    expect(f.runtime.state.connection?.phase).toBe("connected");
    await Effect.runPromise(SubscriptionRef.set(aHandle.state, { ...connected, network: "offline", phase: "offline" } satisfies SupervisorConnectionState));
    await vi.waitFor(() => expect(f.runtime.state.connection?.phase).toBe("offline"));
    await Effect.runPromise(SubscriptionRef.set(aHandle.state, connected));
    await Effect.runPromise(SubscriptionRef.update(f.entries, (current) => {
      const entries = new Map(current); entries.delete(EnvironmentId.make("b")); return entries;
    }));
    await vi.waitFor(() => expect(f.runtime.getEnvironmentWorkspace("b")).toBeUndefined());
    const replacement = dataSession("b", "registered-again");
    await f.add("b", "registered-again", "bearer", replacement.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b.ready).toBe(true));
    resolve(await Effect.runPromise(b.session.welcome));
    await Promise.resolve();
    expect(f.runtime.getEnvironmentWorkspace("b")).not.toBe(removed);
    expect(f.runtime.environmentWorkspaces.b.welcome?.server_id).toBe("registered-again");
    expect(b.readers).toEqual({ events: 0, gaps: 0 });
    expect(replacement.readers).toEqual({ events: 1, gaps: 1 });
    expect(a.readers).toEqual({ events: 1, gaps: 1 });
    expect(f.followers.get("b")).toBe(2);
  });
  it("projects one logical repository with every environment and clone", async () => {
    const f = setup("a");
    const summary = (id: string, path: string) => ({ id, name: "Repo", path, root: path, isWorktree: false,
      repositoryIdentity: { canonicalKey: "host/team/repo" } });
    const catalogSession = (id: string, repositories: ReturnType<typeof summary>[]) => ({
      ...session(id), client: { call: () => Effect.succeed({ repositories }), events: Stream.never },
    }) as unknown as RpcSession;
    await f.runtime.start();
    await f.add("a", "a", "primary", catalogSession("a", [summary("one", "/one"), summary("two", "/two")]));
    await f.add("b", "b", "bearer", catalogSession("b", [summary("one", "/remote")]));
    await vi.waitFor(() => expect(f.runtime.state.repositoryGroups[0]?.members).toHaveLength(3));
    expect(f.runtime.state.repositoryGroups).toHaveLength(1);
    expect(f.runtime.state.repositoryGroups[0].members.map((member) => member.ref)).toEqual(expect.arrayContaining([
      { environmentId: "a", repositoryId: "one" }, { environmentId: "a", repositoryId: "two" },
      { environmentId: "b", repositoryId: "one" },
    ]));
  });
  it("loads catalogs independently and discards results from a replaced session", async () => {
    const f = setup("a");
    await f.runtime.start();
    await f.add("a");
    const b = await f.add("b", "b", "bearer");
    await vi.waitFor(() => expect(f.runtime.state.catalogs.a?.status).toBe("live"));
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b?.status).toBe("live"));

    const repository = { id: "remote-repo", name: "Remote", root: "/remote", path: "/remote", isWorktree: false };
    let resolveOld!: (result: { repositories: typeof repository[] }) => void;
    const oldResult = new Promise<{ repositories: typeof repository[] }>((resolve) => { resolveOld = resolve; });
    const oldSession = { ...session("b"), client: { call: () => Effect.promise(() => oldResult), events: Stream.never } } as unknown as RpcSession;
    await Effect.runPromise(SubscriptionRef.set(b.currentSession, Option.some(oldSession)));
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b?.status).toBe("syncing"));
    const newSession = { ...session("b"), client: { call: () => Effect.succeed({ repositories: [repository] }), events: Stream.never } } as unknown as RpcSession;
    await Effect.runPromise(SubscriptionRef.set(b.currentSession, Option.some(newSession)));
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b?.repositories).toEqual([repository]));
    resolveOld({ repositories: [] });
    await Promise.resolve();
    expect(f.runtime.state.catalogs.b.repositories).toEqual([repository]);
    expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("a");

    await Effect.runPromise(SubscriptionRef.set(b.currentSession, Option.none()));
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b?.status).toBe("stale"));
    expect(f.runtime.state.catalogs.b.repositories).toEqual([repository]);
    expect(f.runtime.state.catalogs.a.status).toBe("live");
  });

  it("distinguishes a failed first catalog load from a successful empty catalog", async () => {
    const f = setup("a");
    await f.runtime.start();
    await f.add("a");
    const failed = { ...session("b"), client: { call: () => Effect.fail(new Error("catalog unavailable")), events: Stream.never } } as unknown as RpcSession;
    const b = await f.add("b", "b", "bearer", failed);
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b?.error).toContain("catalog unavailable"));
    expect(f.runtime.state.catalogs.b.hasSnapshot).toBe(false);
    expect(f.runtime.state.catalogs.a.status).toBe("live");
    await Effect.runPromise(SubscriptionRef.set(b.currentSession, Option.some(session("b"))));
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b?.status).toBe("live"));
    expect(f.runtime.state.catalogs.b.hasSnapshot).toBe(true);
    expect(f.runtime.state.catalogs.b.repositories).toEqual([]);
    await Effect.runPromise(SubscriptionRef.update(f.entries, (entries) => {
      const next = new Map(entries);
      next.delete(EnvironmentId.make("b"));
      return next;
    }));
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b).toBeUndefined());
    expect(f.runtime.state.catalogs.a.status).toBe("live");
  });

  it("hydrates an offline environment's saved catalog without changing another environment", async () => {
    const f = setup("a");
    const repository = { id: "saved", name: "Saved", root: "/saved", path: "/saved", isWorktree: false };
    new RepositoryCatalogCache(f.storage).save("b", [repository]);
    await f.runtime.start();
    await f.add("a");
    const failed = { ...session("b"), client: { call: () => Effect.fail(new Error("offline")), events: Stream.never } } as unknown as RpcSession;
    await f.add("b", "b", "bearer", failed);
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b?.error).toContain("offline"));
    expect(f.runtime.state.catalogs.b).toMatchObject({ status: "stale", hasSnapshot: true, repositories: [repository] });
    await vi.waitFor(() => expect(f.runtime.state.catalogs.a?.status).toBe("live"));
  });
  it("attaches a saved primary selection when asynchronous registration arrives", async () => {
    const f = setup("a");
    await f.runtime.start();
    expect(f.runtime.state.workspace).toBeNull();
    await f.add("a");
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("a"));
    expect(f.runtime.state.registry.selectedEnvironmentId).toBe("a");
    expect(f.runtime.state.workspace).not.toBeNull();
  });

  it("preserves the selected session and workspace when persistence rejects removal", async () => {
    const f = setup("a");
    Object.assign(fixture.registry as object, { remove: () => Effect.fail(new Error("disk unavailable")) });
    await f.runtime.start();
    await f.add("a", "a", "bearer");
    await vi.waitFor(() => expect(f.runtime.state.workspace).not.toBeNull());
    const previousWorkspace = f.runtime.state.workspace;
    await expect(f.runtime.removeEnvironment("a")).rejects.toThrow("disk unavailable");
    await vi.waitFor(() => expect(f.runtime.state.workspace).not.toBeNull());
    expect(f.runtime.state.workspace).toBe(previousWorkspace);
    expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("a");
    expect(f.runtime.state.registry.entries).toHaveLength(1);
    expect(new EnvironmentWorkspaceRemovalJournal(f.storage).load()).toEqual(["a"]);
    const removeTabs = vi.fn(async () => {});
    await f.runtime.acknowledgeEnvironmentWorkspaceRemoval("a", removeTabs);
    expect(removeTabs).not.toHaveBeenCalled();
    expect(new EnvironmentWorkspaceRemovalJournal(f.storage).load()).toEqual([]);
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
    expect(disposed).not.toHaveBeenCalled();
    await Effect.runPromise(SubscriptionRef.set(a.currentSession, Option.some(session("a", "a-replaced"))));
    await Effect.runPromise(SubscriptionRef.set(a.currentSession, Option.none()));
    await Effect.runPromise(Effect.sleep("20 millis"));
    expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("b");
    expect(f.runtime.state.registry.selectedEnvironmentId).toBe("b");
    await Effect.runPromise(SubscriptionRef.set(b.currentSession, Option.none()));
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b.welcome).toBeNull());
    expect(f.runtime.state.workspace).toBe(f.runtime.environmentWorkspaces.b.workspace);
    await Effect.runPromise(SubscriptionRef.set(b.currentSession, Option.some(session("b"))));
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("b"));
    await f.add("b", "b-new-supervisor");
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.server_id).toBe("b-new-supervisor"));
    await Effect.runPromise(SubscriptionRef.set(a.currentSession, Option.some(session("a"))));
    f.runtime.selectEnvironment("a");
    await vi.waitFor(() => expect(f.runtime.state.client?.serverWelcome.environment_id).toBe("a"));
  });
  it.each(["open", "activate", "openPath", "create", "switch", "switchPath"] as const)(
    "retains the prepared snapshot for %s when post-publication hydration fails", async (action) => {
      const f = setup(undefined, "external");
      const a = dataSession("a");
      await f.runtime.start();
      await f.add("a", "a", "primary", a.session);
      await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a?.ready).toBe(true));
      const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
      try {
        if (action === "switch" || action === "switchPath") {
          await app.open({ environmentId: "a", repositoryId: "same" });
          await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a.workspaceState.repositories.same?.snapshot).toBeTruthy());
        }
        const repository = { ...a.repository, id: "target", name: "Prepared", path: "/prepared", root: "/prepared" };
        const snapshot = { ...a.snapshot(), info: { path: "/prepared", root: "/prepared" } };
        a.call.mockImplementation((method) => method === "repositories.list"
          ? Effect.fail(new Error("catalog unavailable after preparation")) : Effect.succeed({ repository, snapshot }));
        const target = { environmentId: "a", repositoryId: "target" };
        const source = app.state.tabs[0];
        if (action === "open") await app.open(target);
        if (action === "activate") await app.activate(target, new AbortController().signal);
        if (action === "openPath") await app.openPath("a", "/prepared");
        if (action === "create") await app.create("a", "/", "prepared", {});
        if (action === "switch") await app.switch(source.tabId, target, source.target);
        if (action === "switchPath") await app.switchPath(source.tabId, "/prepared", source.target);
        await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a.error).toContain("catalog unavailable"));
        expect(f.runtime.environmentWorkspaces.a.workspaceState.repositories.target).toMatchObject({ repository, snapshot });
        expect(app.state.tabs.some((tab) => tab.target.repositoryId === "target")).toBe(true);
      } finally { app.dispose(); }
    },
  );

  it("seeds external offline targets from cached summaries after application-tab restoration", async () => {
    const f = setup(undefined, "external");
    const repository = { id: "same", name: "Offline worktree", path: "/host/worktree", root: "/host/worktree", isWorktree: true,
      missing: true, repositoryIdentity: { canonicalKey: "host/team/repo" }, worktreeFamily: { id: "family", mainRoot: "/host/main" } };
    new RepositoryCatalogCache(f.storage).save("b", [repository]);
    f.storage.setItem("gitgui.applicationWorkspace.v1", JSON.stringify({ schemaVersion: 1,
      tabs: [{ tabId: "tab", target: { environmentId: "b", repositoryId: "same" } }], activeTabId: "tab" }));
    await f.runtime.start(); await f.add("b", "b", "bearer", null);
    const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
    try {
      await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.workspaceState.repositories.same?.repository).toEqual(repository));
      expect(f.runtime.environmentWorkspaces.b.workspaceState.repositories.same.snapshot).toBeUndefined();
      expect(app.state.tabs).toHaveLength(1);
    } finally { app.dispose(); }
  });

  it("navigates registered worktrees with read scope and never registers their paths", async () => {
    const f = setup(undefined, "external"), a = dataSession("a");
    await f.runtime.start(); await f.add("a", "a", "bearer", a.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a?.ready).toBe(true));
    const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
    try {
      const worktree = { ...a.repository, id: "worktree", path: "/registered-worktree", root: "/registered-worktree", isWorktree: true };
      a.call.mockImplementation((method, input) => {
        if (method === "repositories.open") return Effect.fail(new GitGuiRpcError({ code: "forbidden", message: "Missing repositories.manage scope" }));
        if (method === "repositories.list") return Effect.succeed({ repositories: [a.repository, worktree] });
        const repository = (input as { repositoryId?: string }).repositoryId === "worktree" ? worktree : a.repository;
        if (method === "repositories.refresh") return Effect.succeed({ repositories: [] });
        return Effect.succeed({ repository, snapshot: a.snapshot() });
      });
      await f.runtime.refreshEnvironmentCatalog("a");
      await app.openPath("a", "/registered-worktree");
      expect(a.call.mock.calls.some(([method]) => method === "repositories.open")).toBe(false);
      await app.close(app.state.tabs[0].tabId);
      await app.open({ environmentId: "a", repositoryId: "same" });
      const source = app.state.tabs[0];
      await app.switchPath(source.tabId, "/registered-worktree", source.target);
      expect(app.state.tabs[0].target.repositoryId).toBe("worktree");
      expect(a.call.mock.calls.some(([method]) => method === "repositories.open")).toBe(false);
      await expect(app.openPath("a", "/unregistered")).rejects.toThrow("Missing repositories.manage");
    } finally { app.dispose(); }
  });

  it("does not refresh catalogs or readers when foreground selection uses an unchanged session", async () => {
    const f = setup(undefined, "external"), a = dataSession("a");
    await f.runtime.start(); const handle = await f.add("a", "a", "primary", a.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a?.ready).toBe(true));
    const data = f.runtime.getEnvironmentWorkspace("a")!;
    await data.setRepositoryTargets(["same"], "same");
    const second = { ...a.repository, id: "second" };
    a.call.mockImplementation((method) => Effect.succeed(method === "repositories.list"
      ? { repositories: [a.repository, second] } : { repositories: [] }));
    await data.setRepositoryTargets(["same", "second"], "same");
    const before = a.call.mock.calls.length, generation = data.state.generation;
    await data.setRepositoryTargets(["same", "second"], "second");
    await Effect.runPromise(SubscriptionRef.set(handle.currentSession, Option.some(a.session)));
    await Effect.runPromise(SubscriptionRef.set(handle.state, { ...connected }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(a.call).toHaveBeenCalledTimes(before);
    expect(data.state.generation).toBe(generation);
    expect(data.state.workspaceState.activeRepositoryId).toBe("second");
    expect(a.readers).toEqual({ events: 1, gaps: 1 });
  });

  it("updates catalog identity, grouping and durable cache from watcher refreshes", async () => {
    const f = setup(undefined, "external"), a = dataSession("a"), b = dataSession("b");
    a.repository.repositoryIdentity = { canonicalKey: "host/team/old" };
    b.repository.repositoryIdentity = { canonicalKey: "host/team/new" };
    await f.runtime.start(); await f.add("a", "a", "primary", a.session); await f.add("b", "b", "bearer", b.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a?.ready).toBe(true));
    await vi.waitFor(() => expect(f.runtime.state.catalogs.b?.status).toBe("live"));
    await f.runtime.getEnvironmentWorkspace("a")!.setRepositoryTargets(["same"], "same");
    expect(f.runtime.state.repositoryGroups).toHaveLength(2);
    const updated = { ...a.repository, repositoryIdentity: { canonicalKey: "host/team/new" } };
    a.call.mockImplementation((method) => Effect.succeed(method === "repositories.list" ? { repositories: [updated] }
      : { repositories: [{ repositoryId: "same", repository: updated, snapshot: a.snapshot() }] }));
    await a.emit("snapshot");
    await vi.waitFor(() => expect(f.runtime.state.repositoryGroups).toHaveLength(1));
    expect(f.runtime.state.repositoryGroups[0].members).toHaveLength(2);
    expect(new RepositoryCatalogCache(f.storage).load("a")?.[0].repositoryIdentity?.canonicalKey).toBe("host/team/new");
    expect(f.runtime.state.catalogs.b.repositories[0].repositoryIdentity?.canonicalKey).toBe("host/team/new");
  });

  it("journals before removing a registration and keeps recovery until tab persistence succeeds", async () => {
    const f = setup(undefined, "external"), a = dataSession("a"), b = dataSession("b");
    await f.runtime.start(); await f.add("a", "a", "primary", a.session); await f.add("b", "b", "bearer", b.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.ready).toBe(true));
    const journal = new EnvironmentWorkspaceRemovalJournal(f.storage);
    Object.assign(fixture.registry as object, { remove: (id: EnvironmentId) => Effect.gen(function* () {
      expect(journal.load()).toEqual(["b"]);
      f.durable.delete(id);
      yield* SubscriptionRef.update(f.entries, (current) => { const next = new Map(current); next.delete(id); return next; });
    }) });
    const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
    try {
      await app.open({ environmentId: "a", repositoryId: "same" });
      await app.open({ environmentId: "b", repositoryId: "same" });
      const original = f.storage.setItem.bind(f.storage);
      const write = vi.spyOn(f.storage, "setItem").mockImplementation((key, value) => {
        if (key === "gitgui.applicationWorkspace.v1") throw new Error("quota");
        original(key, value);
      });
      await f.runtime.removeEnvironment("b");
      await vi.waitFor(() => expect(f.runtime.getEnvironmentWorkspace("b")).toBeUndefined());
      expect(app.state.tabs).toHaveLength(2);
      expect(journal.load()).toEqual(["b"]);
      write.mockRestore();
      await vi.waitFor(() => expect(app.state.tabs).toHaveLength(1), { timeout: 2500 });
      await vi.waitFor(() => expect(journal.load()).toEqual([]));
    } finally { app.dispose(); }
  });

  it("recovers only journaled removals across restart while retaining a late primary tab", async () => {
    const f = setup(undefined, "external"), journal = new EnvironmentWorkspaceRemovalJournal(f.storage);
    journal.begin("removed");
    await saveTab(f.storage, "removed");
    new RepositoryCatalogCache(f.storage).save("removed", [dataSession("removed").repository]);
    f.storage.setItem("gitgui.applicationWorkspace.v1", JSON.stringify({ schemaVersion: 1, tabs: [
      { tabId: "primary-tab", target: { environmentId: "late-primary", repositoryId: "same" } },
      { tabId: "removed-tab", target: { environmentId: "removed", repositoryId: "same" } },
    ], activeTabId: "removed-tab" }));
    await f.runtime.start();
    const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
    try {
      await vi.waitFor(() => expect(app.state.tabs.map((tab) => tab.tabId)).toEqual(["primary-tab"]));
      await f.add("late-primary", "late-primary", "primary", dataSession("late-primary").session);
      await vi.waitFor(() => expect(f.runtime.environmentWorkspaces["late-primary"]?.workspaceState.repositories.same?.snapshot).toBeTruthy());
      expect(app.state.tabs[0].tabId).toBe("primary-tab");
      await vi.waitFor(() => expect(journal.load()).toEqual([]));
      expect(await new LocalStorageWorkspaceMetadataAdapter(f.storage).load({ environmentId: "removed" })).toBeNull();
      expect(new RepositoryCatalogCache(f.storage).load("removed")).toBeNull();
    } finally { app.dispose(); }
  });

  it("keeps the removal journal until interrupted owned-data cleanup succeeds", async () => {
    const f = setup(undefined, "external"), journal = new EnvironmentWorkspaceRemovalJournal(f.storage);
    journal.begin("removed");
    await saveTab(f.storage, "removed");
    new RepositoryCatalogCache(f.storage).save("removed", [dataSession("removed").repository]);
    const remove = f.storage.removeItem.bind(f.storage);
    let fail = true;
    const spy = vi.spyOn(f.storage, "removeItem").mockImplementation((key) => {
      if (key === "gitgui.repositoryCatalog.v1.removed" && fail) throw new Error("storage unavailable");
      remove(key);
    });
    await f.runtime.start();
    const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("gitgui.repositoryCatalog.v1.removed"));
      expect(journal.load()).toEqual(["removed"]);
      fail = false;
      await vi.waitFor(() => expect(journal.load()).toEqual([]), { timeout: 2500 });
      expect(new RepositoryCatalogCache(f.storage).load("removed")).toBeNull();
      expect(await new LocalStorageWorkspaceMetadataAdapter(f.storage).load({ environmentId: "removed" })).toBeNull();
    } finally { spy.mockRestore(); app.dispose(); }
  });

  it("retains committed removal intent when memory still contains the entry, then recovers after restart", async () => {
    const f = setup(undefined, "external"), journal = new EnvironmentWorkspaceRemovalJournal(f.storage);
    await f.runtime.start(); await f.add("b", "b", "bearer", dataSession("b").session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.ready).toBe(true));
    await saveTab(f.storage, "b");
    new RepositoryCatalogCache(f.storage).save("b", [dataSession("b").repository]);
    f.storage.setItem("gitgui.applicationWorkspace.v1", JSON.stringify({ schemaVersion: 1,
      tabs: [{ tabId: "old", target: { environmentId: "b", repositoryId: "same" } }], activeTabId: "old" }));
    Object.assign(fixture.registry as object, { remove: (id: EnvironmentId) => Effect.sync(() => {
      f.durable.delete(id);
    }).pipe(Effect.andThen(Effect.fail(new Error("credential deletion failed")))) });
    await expect(f.runtime.removeEnvironment("b")).rejects.toThrow("credential deletion failed");
    expect(Effect.runSync(SubscriptionRef.get(f.entries)).has(EnvironmentId.make("b"))).toBe(true);
    expect(journal.load()).toEqual(["b"]);
    await f.runtime.stop(); runtime = undefined;
    // Same durable storage, a fresh runtime and an empty hydrated catalog.
    const restarted = setup(undefined, "external");
    for (let index = 0; index < f.storage.length; index++) {
      const key = f.storage.key(index)!;
      restarted.storage.setItem(key, f.storage.getItem(key)!);
    }
    await restarted.runtime.start();
    const app = new ApplicationWorkspace(restarted.runtime, restarted.storage); await app.start();
    try {
      await vi.waitFor(() => expect(new EnvironmentWorkspaceRemovalJournal(restarted.storage).load()).toEqual([]));
      expect(app.state.tabs).toEqual([]);
      expect(new RepositoryCatalogCache(restarted.storage).load("b")).toBeNull();
      expect(await new LocalStorageWorkspaceMetadataAdapter(restarted.storage).load({ environmentId: "b" })).toBeNull();
    } finally { app.dispose(); }
  });

  it("retires failed cleanup after re-registration, preserves its tabs/cache, and permits new opens", async () => {
    const f = setup(undefined, "external"), journal = new EnvironmentWorkspaceRemovalJournal(f.storage);
    await f.runtime.start(); await f.add("b", "b", "bearer", dataSession("b").session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.ready).toBe(true));
    const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
    let fail = true;
    const remove = f.storage.removeItem.bind(f.storage);
    const spy = vi.spyOn(f.storage, "removeItem").mockImplementation((key) => {
      if (key === "gitgui.repositoryCatalog.v1.b" && fail) throw new Error("cache deletion failed");
      remove(key);
    });
    try {
      await app.open({ environmentId: "b", repositoryId: "same" });
      const originalTab = app.state.tabs[0].tabId;
      Object.assign(fixture.registry as object, { remove: (id: EnvironmentId) => Effect.gen(function* () {
        f.durable.delete(id);
        yield* SubscriptionRef.update(f.entries, (current) => { const next = new Map(current); next.delete(id); return next; });
      }) });
      await f.runtime.removeEnvironment("b");
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("gitgui.repositoryCatalog.v1.b"));
      expect(journal.load()).toEqual(["b"]);
      expect(app.state.tabs[0].tabId).toBe(originalTab);
      await f.add("b", "replacement", "bearer", dataSession("b", "replacement").session);
      await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.ready).toBe(true));
      new RepositoryCatalogCache(f.storage).save("b", [dataSession("b").repository]);
      await vi.waitFor(() => expect(journal.load()).toEqual([]), { timeout: 2500 });
      expect(app.state.tabs[0].tabId).toBe(originalTab);
      expect(new RepositoryCatalogCache(f.storage).load("b")).not.toBeNull();
      // A stale retry must not delete the newly persisted tab either.
      await app.close(originalTab);
      await app.open({ environmentId: "b", repositoryId: "same" });
      expect(app.state.tabs).toHaveLength(1);
    } finally { fail = false; spy.mockRestore(); app.dispose(); }
  });

  it.each(["success", "failure"] as const)("preserves watcher identity during a delayed catalog %s", async (outcome) => {
    const f = setup(undefined, "external"), a = dataSession("a");
    await f.runtime.start(); await f.add("a", "a", "primary", a.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a?.ready).toBe(true));
    await f.runtime.getEnvironmentWorkspace("a")!.setRepositoryTargets(["same"], "same");
    const updated = { ...a.repository, repositoryIdentity: { canonicalKey: "host/team/updated" } };
    let finish!: () => void, reject!: (error: Error) => void;
    const pendingCatalog = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    let listStarted = false;
    a.call.mockImplementation((method) => method === "repositories.list"
      ? Effect.sync(() => { listStarted = true; }).pipe(Effect.andThen(Effect.promise(() => pendingCatalog)),
        Effect.as({ repositories: [{ ...a.repository }] }))
      : Effect.succeed({ repositories: [{ repositoryId: "same", repository: updated, snapshot: a.snapshot() }] }));
    const refreshing = f.runtime.refreshEnvironmentCatalog("a");
    await vi.waitFor(() => expect(listStarted).toBe(true));
    await a.emit("snapshot");
    await vi.waitFor(() => expect(f.runtime.state.catalogs.a.repositories[0].repositoryIdentity?.canonicalKey).toBe("host/team/updated"));
    if (outcome === "success") finish(); else reject(new Error("catalog failed"));
    await refreshing;
    expect(f.runtime.state.catalogs.a.repositories[0].repositoryIdentity?.canonicalKey).toBe("host/team/updated");
    expect(new RepositoryCatalogCache(f.storage).load("a")?.[0].repositoryIdentity?.canonicalKey).toBe("host/team/updated");
  });

  it("preserves registered tabs when a removal intent survives an interrupted removal", async () => {
    const f = setup(undefined, "external"), a = dataSession("a"), journal = new EnvironmentWorkspaceRemovalJournal(f.storage);
    await f.add("a", "a", "bearer", a.session);
    journal.begin("a");
    f.storage.setItem("gitgui.applicationWorkspace.v1", JSON.stringify({ schemaVersion: 1,
      tabs: [{ tabId: "tab", target: { environmentId: "a", repositoryId: "same" } }], activeTabId: "tab" }));
    await f.runtime.start();
    const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
    try {
      await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a?.ready).toBe(true));
      expect(app.state.tabs.map((tab) => tab.tabId)).toEqual(["tab"]);
      expect(journal.load()).toEqual([]);
    } finally { app.dispose(); }
  });

  it("delivers a completed removal to an application workspace mounted later", async () => {
    const f = setup(undefined, "external"), b = dataSession("b");
    await f.runtime.start(); await f.add("b", "b", "bearer", b.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.b?.ready).toBe(true));
    f.storage.setItem("gitgui.applicationWorkspace.v1", JSON.stringify({ schemaVersion: 1,
      tabs: [{ tabId: "tab", target: { environmentId: "b", repositoryId: "same" } }], activeTabId: "tab" }));
    Object.assign(fixture.registry as object, { remove: (id: EnvironmentId) => SubscriptionRef.update(f.entries, (current) => {
      f.durable.delete(id);
      const next = new Map(current); next.delete(id); return next;
    }) });
    await f.runtime.removeEnvironment("b");
    const app = new ApplicationWorkspace(f.runtime, f.storage); await app.start();
    try { await vi.waitFor(() => expect(app.state.tabs).toEqual([])); }
    finally { app.dispose(); }
  });

  it("does not remove a registration when its recovery intent cannot be persisted", async () => {
    const f = setup(undefined, "external"), a = dataSession("a");
    const remove = vi.fn(() => Effect.void);
    Object.assign(fixture.registry as object, { remove });
    await f.runtime.start(); await f.add("a", "a", "bearer", a.session);
    await vi.waitFor(() => expect(f.runtime.environmentWorkspaces.a?.ready).toBe(true));
    const write = vi.spyOn(f.storage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await expect(f.runtime.removeEnvironment("a")).rejects.toThrow("quota");
    expect(remove).not.toHaveBeenCalled();
    expect(f.runtime.environmentWorkspaces.a.ready).toBe(true);
    write.mockRestore();
  });

});
