import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebApplicationRuntime, WebApplicationRuntimeState } from "$lib/connection/runtime";
import { ApplicationWorkspace } from "./application-workspace";

afterEach(() => vi.useRealTimers());

function setup() {
  const values = new Map<string, string>();
  const storage = { get length() { return values.size; }, clear: () => values.clear(), key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as Storage;
  const service = () => ({ state: { generation: 1 }, client: { getRepositorySnapshot: vi.fn(async (id: string, _signal?: AbortSignal) => ({ repository: { id } })),
    openRepository: vi.fn(async () => ({ repository: { id: "same" } })) },
    setRepositoryTargets: vi.fn(async (_ids: readonly string[], _active: string | null, _prepared?: readonly unknown[]) => {}) });
  const workspaces = { a: service(), b: service() };
  let runtimeState = { registry: { entries: [{ registration: { environmentId: "a" } }, { registration: { environmentId: "b" } }] } } as unknown as WebApplicationRuntimeState;
  let listener: ((value: WebApplicationRuntimeState) => void) | undefined;
  const runtime = { get state() { return runtimeState; }, get environmentWorkspaces() { return workspaces; },
    getEnvironmentWorkspace: (id: string) => workspaces[id as "a" | "b"], refreshEnvironmentCatalog: vi.fn(async () => {}),
    acknowledgeEnvironmentWorkspaceRemoval: vi.fn(async (_id: string, removeTabs: () => Promise<void>) => { await removeTabs(); }),
    subscribe: (fn: typeof listener) => { listener = fn; fn?.(runtimeState); return () => { listener = undefined; }; },
  } as unknown as WebApplicationRuntime;
  return { controller: new ApplicationWorkspace(runtime, storage), runtime, storage, workspaces, update: (ids: string[]) => {
    const removedEnvironmentIds = runtimeState.registry.entries.map((entry) => entry.registration.environmentId).filter((id) => !ids.includes(id));
    runtimeState = { ...runtimeState, removedEnvironmentIds, registry: { entries: ids.map((environmentId) => ({ registration: { environmentId } })) } } as unknown as WebApplicationRuntimeState;
    listener?.(runtimeState);
  } };
}

describe("application workspace", () => {
  it("cancels the in-flight repository read when navigation is aborted", async () => {
    const f = setup(); await f.controller.start();
    let received: AbortSignal | undefined;
    f.workspaces.a.client.getRepositorySnapshot.mockImplementationOnce((_id, signal) => new Promise((_resolve, reject) => {
      received = signal;
      signal?.addEventListener("abort", () => reject(new Error("read cancelled")), { once: true });
    }));
    const abort = new AbortController();
    const pending = f.controller.open({ environmentId: "a", repositoryId: "repo" }, undefined, abort.signal);
    await vi.waitFor(() => expect(received).toBe(abort.signal));
    abort.abort();
    await expect(pending).rejects.toThrow("read cancelled");
    expect(f.controller.state.tabs).toHaveLength(0);
    f.controller.dispose();
  });
  it.each(["open", "switch"] as const)("refreshes the catalog when a registered path completes after a cancelled %s", async (mode) => {
    const f = setup(); await f.controller.start();
    if (mode === "switch") await f.controller.open({ environmentId: "a", repositoryId: "source" });
    let release!: (result: { repository: { id: string } }) => void;
    f.workspaces.a.client.openRepository.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const abort = new AbortController();
    const source = f.controller.state.tabs[0];
    const pending = mode === "open" ? f.controller.openPath("a", "/new", undefined, abort.signal)
      : f.controller.switchPath(source.tabId, "/new", source.target, abort.signal);
    await vi.waitFor(() => expect(release).toBeDefined());
    abort.abort(); release({ repository: { id: "new" } });
    await expect(pending).rejects.toThrow("no longer current");
    expect(f.runtime.refreshEnvironmentCatalog).toHaveBeenCalledWith("a");
    expect(f.controller.state.tabs.map((tab) => tab.target.repositoryId)).toEqual(mode === "open" ? [] : ["source"]);
    f.controller.dispose();
  });
  it("resolves Windows extended catalog paths without requiring repository registration", async () => {
    const f = setup();
    f.runtime.state.catalogs = { a: { repositories: [{ id: "linked", root: "\\\\?\\D:\\repo\\linked", path: "\\\\?\\D:\\repo\\linked", name: "linked", isWorktree: true }], status: "live", hasSnapshot: true, error: null } };
    await f.controller.start();
    await f.controller.openPath("a", "D:/repo/linked");
    expect(f.workspaces.a.client.openRepository).not.toHaveBeenCalled();
    expect(f.workspaces.a.client.getRepositorySnapshot).toHaveBeenCalledWith("linked");
    expect(f.controller.state.tabs[0].target.repositoryId).toBe("linked");
    f.controller.dispose();
  });
  it("route activation selects an existing scoped tab and aborts stale preparation", async () => {
    const f = setup(); await f.controller.start();
    const a = { environmentId: "a", repositoryId: "same" };
    const b = { environmentId: "b", repositoryId: "same" };
    await f.controller.open(a);
    await f.controller.open(b);
    await f.controller.activate(a, new AbortController().signal);
    expect(f.controller.state.tabs).toHaveLength(2);
    expect(f.controller.state.tabs.find((tab) => tab.tabId === f.controller.state.activeTabId)?.target).toEqual(a);

    let release!: (value: { repository: { id: string } }) => void;
    f.workspaces.b.client.getRepositorySnapshot.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const abort = new AbortController();
    const pending = f.controller.activate({ environmentId: "b", repositoryId: "other" }, abort.signal);
    await vi.waitFor(() => expect(release).toBeDefined());
    abort.abort();
    release({ repository: { id: "other" } });
    await expect(pending).rejects.toThrow("no longer current");
    expect(f.controller.state.tabs).toHaveLength(2);
    f.controller.dispose();
  });
  it("keeps equal repository IDs on independent environments and rejects duplicate targets", async () => {
    const f = setup(); await f.controller.start();
    await f.controller.open({ environmentId: "a", repositoryId: "same" });
    await f.controller.open({ environmentId: "b", repositoryId: "same" });
    expect(f.controller.state.tabs).toHaveLength(2);
    await expect(f.controller.open({ environmentId: "a", repositoryId: "same" })).rejects.toThrow("already open");
    expect(f.workspaces.a.setRepositoryTargets).toHaveBeenLastCalledWith(["same"], null, expect.any(Array));
    expect(f.workspaces.b.setRepositoryTargets).toHaveBeenLastCalledWith(["same"], "same", expect.any(Array));
    f.controller.dispose();
  });

  it("preserves the source tab when a switch fails and removes only the removed environment", async () => {
    const f = setup(); await f.controller.start();
    await f.controller.open({ environmentId: "a", repositoryId: "same" });
    const source = f.controller.state.tabs[0];
    f.workspaces.b.client.getRepositorySnapshot.mockRejectedValueOnce(new Error("offline"));
    await expect(f.controller.switch(source.tabId, { environmentId: "b", repositoryId: "same" }, source.target)).rejects.toThrow("offline");
    expect(f.controller.state.tabs[0].target).toEqual(source.target);
    await f.controller.open({ environmentId: "b", repositoryId: "same" });
    f.update(["a"]);
    await vi.waitFor(() => expect(f.controller.state.tabs).toHaveLength(1));
    expect(f.controller.state.tabs[0].target.environmentId).toBe("a");
    f.controller.dispose();
  });
  it("retries failed removal persistence without another runtime notification", async () => {
    const f = setup(); await f.controller.start();
    await f.controller.open({ environmentId: "a", repositoryId: "same" });
    await f.controller.open({ environmentId: "b", repositoryId: "same" });
    const write = vi.spyOn(f.storage, "setItem");
    write.mockImplementationOnce(() => { throw new Error("quota"); });
    vi.useFakeTimers();
    f.update(["a"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.state.tabs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.controller.state.tabs.map((tab) => tab.target.environmentId)).toEqual(["a"]);
    expect(JSON.parse(f.storage.getItem("gitgui.applicationWorkspace.v1")!).tabs).toHaveLength(1);
    f.controller.dispose();
  });

  it.each(["switch", "switchPath"] as const)("cancels %s preparation and releases the checkout reservation", async (action) => {
    const f = setup(); await f.controller.start();
    const old = { environmentId: "a", repositoryId: "old" };
    await f.controller.open(old);
    const tabId = f.controller.state.tabs[0].tabId;
    const target = { environmentId: "a", repositoryId: "same" };
    let release!: (value: { repository: { id: string } }) => void;
    const client = f.workspaces.a.client;
    const method = action === "switch" ? client.getRepositorySnapshot : client.openRepository;
    method.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const abort = new AbortController();
    const pending = action === "switch"
      ? f.controller.switch(tabId, target, old, abort.signal)
      : f.controller.switchPath(tabId, "/worktree", old, abort.signal);
    await vi.waitFor(() => expect(release).toBeDefined());
    abort.abort(); release({ repository: { id: "same" } });
    await expect(pending).rejects.toThrow("no longer current");
    expect(f.controller.state.tabs[0].target).toEqual(old);
    await f.controller.switch(tabId, target, old);
    expect(f.controller.state.tabs[0].target).toEqual(target);
    f.controller.dispose();
  });

  it("does not close a switched checkout for a delayed repository removal", async () => {
    const f = setup(); await f.controller.start();
    const old = { environmentId: "a", repositoryId: "old" };
    await f.controller.open(old);
    const tabId = f.controller.state.tabs[0].tabId;
    const next = { environmentId: "b", repositoryId: "same" };
    await f.controller.switch(tabId, next, old);
    await f.controller.closeIfMatches(tabId, old);
    expect(f.controller.state.tabs[0].target).toEqual(next);
    await f.controller.closeIfMatches(tabId, next);
    expect(f.controller.state.tabs).toEqual([]);
    f.controller.dispose();
  });

  it("does not publish prepared data after metadata failure or session replacement", async () => {
    const f = setup(); await f.controller.start();
    const target = { environmentId: "a", repositoryId: "new" };
    vi.spyOn(f.storage, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
    await expect(f.controller.open(target)).rejects.toThrow("quota");
    expect(f.controller.state.tabs).toEqual([]);
    expect(f.workspaces.a.setRepositoryTargets.mock.calls.every(([ids]) => !ids?.includes("new"))).toBe(true);
    let release!: (value: { repository: { id: string } }) => void;
    f.workspaces.a.client.getRepositorySnapshot.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.controller.open(target);
    await vi.waitFor(() => expect(release).toBeDefined());
    f.workspaces.a.state.generation += 1;
    release({ repository: { id: "new" } });
    await expect(pending).rejects.toThrow("session changed");
    expect(f.controller.state.tabs).toEqual([]);
    await f.controller.open(target);
    expect(f.controller.state.tabs).toHaveLength(1);
    f.controller.dispose();
  });

});
