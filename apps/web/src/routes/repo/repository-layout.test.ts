// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import RepositoryLayoutHarness from "./RepositoryLayout.test-harness.svelte";
import type { WebApplicationRuntime, WebApplicationRuntimeState } from "$lib/connection/runtime";
import type { WorkspaceStore } from "$lib/workspace/workspace-store.svelte";
import type { RepositoryRouteAdapter, RepositoryRouteSnapshot, RepositoryPageModel } from "$lib/workspace/repository-routing";
import { createLegacyRepositoryRouteAdapter, readLegacyRouteEnvironment } from "./legacy-adapter";

const mocks = vi.hoisted(() => ({
  goto: vi.fn(async () => {}), useRuntime: vi.fn(), useStore: vi.fn(),
  page: { route: { id: "/repo/[repositoryId]" }, params: { repositoryId: "same" },
    url: new URL("http://localhost/repo/same?server=http%3A%2F%2F127.0.0.1%3A3774#files") },
}));
vi.mock("$app/state", () => ({ page: mocks.page }));
vi.mock("$app/navigation", () => ({ goto: mocks.goto }));
vi.mock("$lib/connection/runtime", () => ({ useWebApplicationRuntime: mocks.useRuntime }));
vi.mock("$lib/workspace", () => ({ useWorkspaceStore: mocks.useStore }));
vi.mock("./RepositoryPage.svelte", () => import("./RepositoryPage.test-fixture.svelte"));

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("repository route layout integration", () => {
  const a = { environmentId: "a", repositoryId: "same" };
  const b = { environmentId: "b", repositoryId: "same" };
  const repository = { id: "same", name: "Repo", path: "/repo", root: "/repo", isWorktree: false };
  function legacyFixture() {
    const runtimeState = {
      loading: false,
      registry: { entries: ["a", "b"].map((environmentId) => ({
        registration: { environmentId, displayName: environmentId, target: { kind: "bearer" } },
      })) },
      catalogs: {
        a: { hasSnapshot: true, repositories: [repository] },
        b: { hasSnapshot: true, repositories: [repository] },
      },
    } as unknown as WebApplicationRuntimeState;
    const select = vi.fn(async () => {});
    const open = vi.fn(async () => ({}));
    const store = {
      workspaceState: { environmentId: "a" },
      workspace: { environmentId: "a", state: { openRepositoryIds: ["same"] }, selectRepository: select, openKnownRepository: open },
      activeRepositoryId: "same", openRepos: [{ id: "same", root: "/repo" }],
      repositoryCatalog: [repository],
    } as unknown as WorkspaceStore;
    const release = vi.fn();
    const runtime = {
      state: runtimeState, subscribe: vi.fn((listener: (state: WebApplicationRuntimeState) => void) => { listener(runtimeState); return release; }),
    } as unknown as WebApplicationRuntime;
    mocks.useRuntime.mockReturnValue(runtime);
    mocks.useStore.mockReturnValue(store);
    return { store, runtime, runtimeState, release, select, open };
  }

  it("uses the provided coordinator adapter and preserves browser context on ambiguity choice", async () => {
    const snapshot: RepositoryRouteSnapshot = {
      ready: true, legacyCatalogsReady: true, environmentIds: ["a", "b"],
      candidates: [a, b].map((target) => ({ target, environmentLabel: target.environmentId, path: "/" + target.environmentId })),
      openTargets: [], activeTarget: null, view: null,
    };
    const adapter: RepositoryRouteAdapter = { snapshot, activate: vi.fn(async () => {}) };
    mounted = mount(RepositoryLayoutHarness, { target: document.body, props: { adapter } });
    flushSync(); await Promise.resolve();
    expect(mocks.useRuntime).not.toHaveBeenCalled();
    expect(mocks.useStore).not.toHaveBeenCalled();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    document.querySelectorAll<HTMLButtonElement>("button")[1].click();
    expect(mocks.goto).toHaveBeenCalledExactlyOnceWith(
      "/repo/b/same?server=http%3A%2F%2F127.0.0.1%3A3774#files", { replaceState: true });
    expect(adapter.activate).not.toHaveBeenCalled();
  });

  it("owns exactly one transitional runtime projection subscription and releases it on unmount", async () => {
    const f = legacyFixture();
    mounted = mount(RepositoryLayoutHarness, { target: document.body, props: {} });
    flushSync(); await Promise.resolve(); flushSync();
    expect(f.runtime.subscribe).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Choose a repository location");
    await unmount(mounted); mounted = undefined;
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("leaves transitional close navigation to the existing store without a second URL writer", async () => {
    const f = legacyFixture();
    localStorage.setItem("gitgui.selectedEnvironment.v3", "a");
    Object.assign(f.store, { stashContextKey: "a:same", fetchRepository: vi.fn(async () => {}), closeDiff: vi.fn() });
    mounted = mount(RepositoryLayoutHarness, { target: document.body, props: {} });
    flushSync(); await Promise.resolve(); flushSync();
    expect(document.body.textContent?.trim()).toBe("a:same");
    f.store.activeRepositoryId = null;
    f.store.openRepos = [];
    vi.mocked(f.runtime.subscribe).mock.calls[0][0]({ ...f.runtimeState });
    flushSync(); await Promise.resolve();
    expect(document.body.textContent).toContain("Repository tab closed.");
    expect(mocks.goto).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("keeps existing single-environment scoped open/select behavior without legacy URL navigation", async () => {
    const f = legacyFixture();
    const adapter = createLegacyRepositoryRouteAdapter(f.store, () => f.runtimeState, () => undefined);
    await adapter.activate(a, { signal: new AbortController().signal });
    expect(f.select).toHaveBeenCalledExactlyOnceWith("same");
    f.store.workspace!.state.openRepositoryIds.length = 0;
    await adapter.activate(a, { signal: new AbortController().signal });
    expect(f.open).toHaveBeenCalledExactlyOnceWith("same");
    expect(mocks.goto).not.toHaveBeenCalled();
    await expect(adapter.activate(b, { signal: new AbortController().signal })).rejects.toThrow("environment is unavailable");
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it("includes every known catalog, keeps incomplete catalogs unresolved and uses only a saved legacy hint", () => {
    const f = legacyFixture();
    localStorage.setItem("gitgui.selectedEnvironment.v3", "b");
    const saved = readLegacyRouteEnvironment(localStorage);
    const adapter = createLegacyRepositoryRouteAdapter(f.store, () => f.runtimeState, () => saved);
    localStorage.setItem("gitgui.selectedEnvironment.v3", "a");
    expect(adapter.snapshot.legacySelectedEnvironmentId).toBe("b");
    expect(adapter.snapshot.candidates.map((candidate) => candidate.target)).toEqual([a, b]);
    expect(adapter.snapshot.legacyCatalogsReady).toBe(true);
    (f.runtimeState.catalogs.b as { hasSnapshot: boolean }).hasSnapshot = false;
    expect(adapter.snapshot.legacyCatalogsReady).toBe(false);
    expect(readLegacyRouteEnvironment({ getItem() { throw new Error("storage denied"); } })).toBeUndefined();
  });

  it("renders the captured saved selection rather than guessing the active environment", async () => {
    const f = legacyFixture();
    const fetch = vi.fn(async () => {}), release = vi.fn();
    const view = { stashContextKey: "a:same", fetchRepository: fetch, closeDiff: release } as unknown as RepositoryPageModel;
    const snapshot: RepositoryRouteSnapshot = {
      ...createLegacyRepositoryRouteAdapter(f.store, () => f.runtimeState, () => "a").snapshot,
      view,
    };
    const activate = vi.fn(async () => {});
    mounted = mount(RepositoryLayoutHarness, { target: document.body, props: { adapter: { snapshot, activate } } });
    flushSync(); await Promise.resolve(); flushSync();
    expect(document.body.textContent?.trim()).toBe("a:same");
    expect(document.querySelectorAll('[data-testid="repository-presentation"]')).toHaveLength(1);
    expect(activate).not.toHaveBeenCalled();
  });
});
