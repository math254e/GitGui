// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
// @ts-expect-error Svelte's compiler runtime has no public module declarations.
import { effect_root, flush } from "svelte/internal/client";
import type { RepositorySnapshot, RepositorySummary } from "@gitgui/contracts";
import type { ClientWorkspaceState } from "$lib/client-runtime";
import type { WebApplicationRuntime, WebApplicationRuntimeState } from "$lib/connection/runtime";
import { ApplicationWorkspace } from "$lib/client-runtime/application-workspace";
import { WorkspaceStore } from "./workspace-store.svelte";
import NewRepositoryPage from "../../routes/new/+page.svelte";

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}), hooks: [] as Array<() => void> }));
const route = vi.hoisted(() => ({ store: null as WorkspaceStore | null }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("$app/navigation", () => ({ goto: navigation.goto, beforeNavigate: (hook: () => void) => navigation.hooks.push(hook) }));
vi.mock("$app/environment", () => ({ browser: true }));
vi.mock("$lib/workspace", () => ({ useWorkspaceStore: () => route.store }));
vi.mock("svelte-sonner", () => ({ toast: notifications }));
vi.mock("$lib/connection/platform", () => ({ readDesktopBridge: () => null }));
vi.mock("$lib/preferences", () => ({ resolveProjectsLocation: vi.fn(async () => "D:/projects"), readBranchSwitchMergePreference: () => false }));
vi.mock("@lucide/svelte", () => ({ Cloud: () => {}, FolderPlus: () => {}, GitBranch: () => {}, HardDriveDownload: () => {}, Monitor: () => {}, X: () => {} }));

const cleanups: Array<() => void> = [];
let component: ReturnType<typeof mount> | undefined;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const repository = (id = "same"): RepositorySummary => ({ id, name: id, path: `/${id}`, root: `/${id}`, isWorktree: false });
const snapshot = (): RepositorySnapshot => ({ info: { path: "/same", root: "/same" }, status: { currentBranch: "main", headOid: "head", ahead: 0, behind: 0, changedFiles: [] },
  commits: [], refs: [], worktrees: [], stashes: [], graph: { commits: [], edges: [], headLane: null, width: 1 } });
const workspaceState = (environmentId: string): ClientWorkspaceState => ({
  environmentId, activeRepositoryId: "same", openRepositoryIds: ["same"], recentRepositories: [], fileContentRevisions: {}, restoring: false, opening: false, refreshing: false,
  repositories: { same: { repository: repository(), snapshot: snapshot(), loading: false, refreshing: false } },
});

async function setup(isDesktop = false) {
  localStorage.clear();
  const service = (environmentId: string) => {
    const state = workspaceState(environmentId);
    const client = {
      serverWelcome: { environment_id: environmentId, capabilities: ["repositories.open", "repositories.create", "repositories.remove", "git.worktree.remove", "git.branch.delete", "git.stash.popTarget"] },
      getRepositorySnapshot: vi.fn(async (id: string) => ({ repository: repository(id), snapshot: snapshot() })),
      openRepository: vi.fn(async (_path: string) => ({ repository: repository("linked"), snapshot: snapshot() })),
      createRepository: vi.fn(async (_parent: string, _name: string, _options: unknown) => ({ repository: repository("created"), snapshot: snapshot() })),
      removeRepository: vi.fn(async (_id: string) => {}), removeWorktree: vi.fn(),
      getAmendInfo: vi.fn(async () => ({})), stage: vi.fn(async (_id: string) => {}), unstage: vi.fn(async (_id: string) => {}),
      stashPopTarget: vi.fn(),
    };
    const workspace = { state, refreshRepository: vi.fn(async (_id: string) => state), refreshRepositoryStatus: vi.fn(async (_id: string) => state),
      invalidateFileContent: vi.fn(), prefetchCommitFiles: vi.fn(async () => {}), forgetRepository: vi.fn(async () => {}) };
    return { client, workspace, workspaceState: state, sessionScopes: ["repository:read", "repository:operate", "repository:manage"] as readonly string[] | null, generation: 1, state: { generation: 1 }, welcome: client.serverWelcome as typeof client.serverWelcome | null, setRepositoryTargets: vi.fn(async () => {}), loading: false, error: "" };
  };
  const services = { a: service("a"), b: service("b") };
  const entries = ["a", "b"].map((id) => ({ registration: { environmentId: id, displayName: id === "a" ? "Local" : "Remote", target: { kind: id === "a" ? "primary" : "bearer" } }, connection: { phase: "connected", lastFailure: null } }));
  const state = { registry: { entries, selectedEnvironmentId: "b" }, catalogs: {}, environmentWorkspaces: services, repositoryGroups: [],
    client: services.b.client, workspace: services.b.workspace, workspaceState: services.b.workspaceState, loading: false, error: "", connection: null };
  const runtime = { isDesktop, tabOwnership: "external", state, environmentWorkspaces: services,
    getEnvironmentWorkspace: (id: string) => services[id as "a" | "b"], refreshEnvironmentCatalog: vi.fn(async (_id: string) => {}), retry: vi.fn(async (_id: string) => {}),
    subscribe: (fn: (value: WebApplicationRuntimeState) => void) => { fn(state as unknown as WebApplicationRuntimeState); return () => {}; },
  };
  const application = new ApplicationWorkspace(runtime as unknown as WebApplicationRuntime, localStorage);
  await application.start();
  cleanups.push(() => application.dispose());
  let store!: WorkspaceStore;
  cleanups.push(effect_root(() => { store = new WorkspaceStore(runtime as unknown as WebApplicationRuntime); }));
  const internals = store as unknown as { applicationWorkspace: ApplicationWorkspace; applyApplicationRuntimeState(state: WebApplicationRuntimeState): void };
  internals.applicationWorkspace = application;
  cleanups.push(application.subscribe((tabs) => { store.applicationTabs = tabs; }));
  const project = () => { internals.applyApplicationRuntimeState(state as unknown as WebApplicationRuntimeState); flush(); };
  project();
  store.applicationReady = true;
  const display = async (environmentId: "a" | "b", repositoryId = "same") => {
    const data = services[environmentId];
    data.workspaceState.activeRepositoryId = repositoryId;
    data.workspaceState.repositories[repositoryId] ??= { repository: repository(repositoryId), snapshot: snapshot(), loading: false, refreshing: false };
    data.workspaceState.openRepositoryIds = Object.keys(data.workspaceState.repositories);
    await application.activate({ environmentId, repositoryId }, new AbortController().signal);
    project();
  };
  return { store, application, services, runtime, state, display, project };
}

beforeEach(() => { vi.clearAllMocks(); navigation.hooks.length = 0; });
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});

describe("integration review RPC inputs", () => {
  it("rebases onto a commit immediately after checking it, without opening a dialog", async () => {
    const f = await setup();
    await f.display("a");
    f.services.a.client.serverWelcome.capabilities.push("git.integration.start", "git.integration.commit_target");
    const target = "b".repeat(40);
    const review = { currentRef: "refs/heads/main", headOid: "a".repeat(40), targetRef: target, targetOid: target };
    const reviewIntegration = vi.fn(async () => review);
    const startIntegration = vi.fn(async (input: unknown) => { structuredClone(input); return { state: null, failure: null }; });
    Object.assign(f.services.a.client, { reviewIntegration, startIntegration });
    await f.store.openIntegrationReview(target, "rebase");
    expect(f.store.integrationReview).toBeNull();
    await vi.waitFor(() => expect(startIntegration).toHaveBeenCalledWith({ repositoryId: "same", review, action: "rebase" }));
    await vi.waitFor(() => expect(f.store.gitActionPending).toBe(false));
  });

  it("requires confirmation before skipping a rebase and scopes the action to the checkout", async () => {
    const f = await setup();
    await f.display("a");
    f.services.a.client.serverWelcome.capabilities.push("git.integration.start");
    const recoverIntegration = vi.fn(async (input: unknown) => { structuredClone(input); return { state: null, failure: null }; });
    Object.assign(f.services.a.client, { recoverIntegration });
    f.store.integrationError = "";
    f.store.integrationState = { kind: "rebase", unresolvedPaths: ["conflict.txt"] };
    f.store.requestIntegrationRecovery("continue");
    expect(recoverIntegration).not.toHaveBeenCalled();
    f.store.requestIntegrationRecovery("skip");
    expect(f.store.integrationRecoveryDialog?.action).toBe("skip");
    expect(recoverIntegration).not.toHaveBeenCalled();
    f.store.confirmIntegrationRecovery();
    await vi.waitFor(() => expect(recoverIntegration).toHaveBeenCalledWith({ repositoryId: "same", kind: "rebase", action: "skip" }));
    await vi.waitFor(() => expect(f.store.gitActionPending).toBe(false));
  });

  it.each(["merge", "rebase"] as const)("sends a cloneable reviewed %s request", async (action) => {
    const f = await setup();
    await f.display("a");
    f.services.a.client.serverWelcome.capabilities.push("git.integration.start");
    const startIntegration = vi.fn(async (input: unknown) => {
      structuredClone(input);
      return { state: null, failure: null };
    });
    Object.assign(f.services.a.client, { startIntegration });
    const review = { currentRef: "refs/heads/main", headOid: "a".repeat(40), targetRef: "refs/heads/topic", targetOid: "b".repeat(40) };
    f.store.integrationReview = { repositoryId: "same", environmentId: "a", review, action };
    expect(() => structuredClone(f.store.integrationReview!.review)).toThrow();
    f.store.confirmIntegration();
    await vi.waitFor(() => expect(startIntegration).toHaveBeenCalledOnce());
    expect(startIntegration).toHaveBeenCalledWith({ repositoryId: "same", review, action });
    await vi.waitFor(() => expect(f.store.gitActionPending).toBe(false));
    expect(notifications.error).not.toHaveBeenCalled();
  });

  it("sends a cloneable reviewed rewrite push", async () => {
    const f = await setup();
    await f.display("a");
    f.services.a.client.serverWelcome.capabilities.push("git.integration.start");
    const pushRewrite = vi.fn(async (input: unknown) => { structuredClone(input); return null; });
    Object.assign(f.services.a.client, { pushRewrite });
    const review = { currentRef: "refs/heads/main", localOid: "a".repeat(40), remote: "origin", destinationRef: "refs/heads/main", remoteOid: "b".repeat(40), destinationFingerprint: "c".repeat(64), commitsRemoved: 1 };
    f.store.rewritePushReview = { repositoryId: "same", environmentId: "a", review };
    expect(() => structuredClone(f.store.rewritePushReview!.review)).toThrow();
    f.store.confirmRewritePush();
    await vi.waitFor(() => expect(pushRewrite).toHaveBeenCalledOnce());
    expect(pushRewrite).toHaveBeenCalledWith({ repositoryId: "same", pushReview: review });
    await vi.waitFor(() => expect(f.store.gitActionPending).toBe(false));
    expect(notifications.error).not.toHaveBeenCalled();
  });
});

describe("workspace switch navigation lifetime", () => {
  it("distinguishes same-name, same-branch local clone tabs by their paths", async () => {
    const f = await setup(true); await f.display("a", "same"); await f.display("a", "copy");
    f.services.a.workspaceState.repositories.copy.repository.name = "same";
    f.project();
    const tabs = f.store.repoTabs;
    expect(tabs.map((tab) => tab.title)).toEqual(["same", "same"]);
    expect(tabs[0].branch).toContain("/same");
    expect(tabs[1].branch).toContain("/copy");
    expect(tabs[0].branch).not.toBe(tabs[1].branch);
  });
  it("omits the local environment from tab subtitles and avoids repeating the repository name", async () => {
    const f = await setup(true); await f.display("a"); await f.display("b");
    expect(f.store.repoTabs.find((tab) => tab.id === f.application.state.tabs[1].tabId)?.branch).toBe("Remote · main");
    f.services.b.workspaceState.repositories.same.snapshot!.status.currentBranch = "same";
    f.project();
    expect(f.store.repoTabs.find((tab) => tab.id === f.application.state.tabs[0].tabId)?.branch).toBe("main");
    expect(f.store.repoTabs.find((tab) => tab.id === f.application.state.tabs[1].tabId)?.branch).toBe("Remote");
  });
  it("releases a cancelled path dialog while its original server request is still pending", async () => {
    const f = await setup();
    await f.store.chooseRepositoryForEnvironment("a");
    f.store.repositoryPathValue = "/a/repo";
    const first = deferred<Awaited<ReturnType<typeof f.services.a.client.openRepository>>>();
    const second = deferred<Awaited<ReturnType<typeof f.services.b.client.openRepository>>>();
    f.services.a.client.openRepository.mockReturnValueOnce(first.promise);
    f.services.b.client.openRepository.mockReturnValueOnce(second.promise);
    const old = f.store.submitRepositoryPath();
    await vi.waitFor(() => expect(f.services.a.client.openRepository).toHaveBeenCalled());
    navigation.hooks.forEach((hook) => hook());
    expect(f.store.repositoryPathDialogOpen).toBe(false);
    expect(f.store.repositoryPathPending).toBe(false);
    await f.store.chooseRepositoryForEnvironment("b");
    f.store.repositoryPathValue = "/b/repo";
    const next = f.store.submitRepositoryPath();
    await vi.waitFor(() => expect(f.services.b.client.openRepository).toHaveBeenCalled());
    first.resolve({ repository: repository("a-created"), snapshot: snapshot() });
    await old;
    expect(f.store.repositoryPathPending).toBe(true);
    second.resolve({ repository: repository("b-created"), snapshot: snapshot() });
    await next;
    expect(f.store.repositoryPathPending).toBe(false);
    expect(f.application.state.tabs.map((tab) => tab.target.environmentId)).toEqual(["b"]);
  });
  it("projects offline restored tabs and retries only their environment even during bootstrap", async () => {
    const f = await setup();
    await f.display("b");
    f.services.b.workspaceState.repositories.same.snapshot = undefined;
    f.state.registry.entries[1].connection.phase = "offline";
    f.services.b.loading = true;
    f.project();
    expect(f.store.snapshot).toBeNull();
    expect(f.store.repositoryAvailability).toMatchObject({ environmentLabel: "Remote", title: "Environment offline", canRetry: true });
    await f.store.retryActiveRepository();
    expect(f.runtime.retry).toHaveBeenCalledExactlyOnceWith("b");
    expect(f.services.a.workspace.refreshRepository).not.toHaveBeenCalled();
    expect(f.services.b.workspace.refreshRepository).not.toHaveBeenCalled();
    expect(navigation.goto).not.toHaveBeenCalled();
  });

  it("keeps loading placeholders temporary and scopes repository-error retry on a healthy environment", async () => {
    const f = await setup();
    await f.display("b");
    const repository = f.services.b.workspaceState.repositories.same;
    repository.snapshot = undefined;
    f.services.b.loading = true; f.project();
    expect(f.store.repositoryAvailability).toMatchObject({ title: "Loading repository…", canRetry: false });
    f.services.b.loading = false;
    repository.error = { message: "Repository is inaccessible" }; f.project();
    expect(f.store.repositoryAvailability).toMatchObject({ title: "Repository unavailable", detail: "Repository is inaccessible", canRetry: true });
    await f.store.retryActiveRepository();
    expect(f.services.b.workspace.refreshRepository).toHaveBeenCalledExactlyOnceWith("same");
    expect(f.services.a.workspace.refreshRepository).not.toHaveBeenCalled();
    expect(f.runtime.retry).not.toHaveBeenCalled();
    f.state.registry.entries[1].connection.phase = "blocked"; f.project();
    expect(f.store.repositoryAvailability.title).toBe("Environment unavailable");
    f.state.registry.entries[1].connection.phase = "backoff"; f.project();
    expect(f.store.repositoryAvailability).toMatchObject({ title: "Reconnecting to environment", canRetry: true });
    f.state.registry.entries[1].connection.phase = "connecting"; f.project();
    expect(f.store.repositoryAvailability).toMatchObject({ title: "Loading repository…", canRetry: false });
    f.services.b.generation = 2; f.project();
    expect(f.store.activeEnvironmentGeneration).toBe(2);
    f.services.b.welcome = null; f.project();
    expect(f.store.activeEnvironmentGeneration).toBe(0);
    f.services.b.welcome = f.services.b.client.serverWelcome; f.project();
    expect(f.store.activeEnvironmentGeneration).toBe(2);
    await f.display("a");
    expect(f.store.activeEnvironmentGeneration).toBe(1);
    expect(f.store.repositoryAvailability.environmentLabel).toBe("Local");
  });
  it("does not publish or navigate a delayed open after the user visits settings", async () => {
    const f = await setup();
    const response = deferred<Awaited<ReturnType<typeof f.services.b.client.getRepositorySnapshot>>>();
    f.services.b.client.getRepositorySnapshot.mockReturnValueOnce(response.promise);
    const pending = f.store.openScopedRepository({ environmentId: "b", repositoryId: "other" });
    await vi.waitFor(() => expect(f.services.b.client.getRepositorySnapshot).toHaveBeenCalledWith("other", expect.any(AbortSignal)));
    await f.store.showSettingsView();
    navigation.goto.mockClear();
    response.resolve({ repository: repository("other"), snapshot: snapshot() });
    await pending;
    expect(f.application.state.tabs).toHaveLength(0);
    expect(navigation.goto).not.toHaveBeenCalled();
  });

  it("does not navigate away when closing an active tab outside repository routes", async () => {
    const f = await setup();
    await f.display("a"); await f.display("b");
    navigation.goto.mockClear();
    await f.store.closeApplicationTab(f.application.state.activeTabId!);
    expect(navigation.goto).not.toHaveBeenCalled();
    expect(f.application.state.tabs).toHaveLength(1);
  });
  it("keeps comparison mode separate for identical commits on different environments", async () => {
    const f = await setup();
    const commit = { hash: "same-hash", message: "commit", author: "A", timestamp: 0, parents: [] } as import("$lib/types/repository").CommitInfo;
    f.services.a.workspaceState.repositories.same.snapshot!.commits.push(commit);
    f.services.b.workspaceState.repositories.same.snapshot!.commits.push(commit);
    await f.display("a");
    f.store.compareCommitToWorkingTree(commit);
    flush();
    expect(f.store.comparingCommitToWorkingTree).toBe(true);
    await f.display("b");
    f.store.selectCommit(commit);
    flush();
    expect(f.store.comparingCommitToWorkingTree).toBe(false);
    await f.display("a");
    flush();
    expect(f.store.comparingCommitToWorkingTree).toBe(true);
  });
  it.each(["home", "settings", "navigation", "history", "selection", "route", "close", "dispose"] as const)("cancels a delayed location switch on later %s without publishing a stale tab", async (later) => {
    const f = await setup();
    await f.display("b"); await f.display("a");
    const source = f.application.state.tabs.find((tab) => tab.tabId === f.application.state.activeTabId)!;
    const response = deferred<Awaited<ReturnType<typeof f.services.b.client.getRepositorySnapshot>>>();
    f.services.b.client.getRepositorySnapshot.mockReturnValueOnce(response.promise);
    const switching = f.store.switchScopedRepository({ environmentId: "b", repositoryId: "other" }, source);
    await vi.waitFor(() => expect(f.services.b.client.getRepositorySnapshot).toHaveBeenCalledWith("other", expect.any(AbortSignal)));
    if (later === "home") await f.store.showStartView();
    if (later === "settings") await f.store.showSettingsView();
    if (later === "navigation") await f.store.navigateTo("/new");
    if (later === "history") navigation.hooks.forEach((hook) => hook());
    if (later === "selection") await f.store.selectApplicationTab(f.application.state.tabs[0].tabId);
    if (later === "route") await f.store.activateRouteRepository({ environmentId: "b", repositoryId: "same" }, new AbortController().signal);
    if (later === "close") await f.store.closeApplicationTab(source.tabId);
    if (later === "dispose") f.store.dispose();
    const tabs = f.application.state;
    const persisted = localStorage.getItem("gitgui.applicationWorkspace.v1");
    navigation.goto.mockClear();
    response.resolve({ repository: repository("other"), snapshot: snapshot() });
    await switching;
    expect(f.application.state).toEqual(tabs);
    expect(localStorage.getItem("gitgui.applicationWorkspace.v1")).toBe(persisted);
    expect(navigation.goto).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
  });

  it.each(["home", "selection", "navigation"] as const)("cancels a delayed worktree resolution when later %s wins", async (later) => {
    const f = await setup(); await f.display("b"); await f.display("a");
    const response = deferred<Awaited<ReturnType<typeof f.services.a.client.openRepository>>>();
    f.services.a.client.openRepository.mockReturnValueOnce(response.promise);
    const switching = f.store.switchWorktree("/linked");
    await vi.waitFor(() => expect(f.services.a.client.openRepository).toHaveBeenCalledWith("/linked"));
    if (later === "home") await f.store.showStartView();
    if (later === "selection") await f.store.selectApplicationTab(f.application.state.tabs[0].tabId);
    if (later === "navigation") await f.store.navigateTo("/settings/general");
    const tabs = f.application.state;
    navigation.goto.mockClear();
    response.resolve({ repository: repository("linked"), snapshot: snapshot() });
    await switching;
    expect(f.application.state).toEqual(tabs);
    expect(navigation.goto).not.toHaveBeenCalled();
  });

  it("lets a newer switch publish and navigate exactly once", async () => {
    const f = await setup(); await f.display("a");
    const source = f.application.state.tabs[0];
    const response = deferred<Awaited<ReturnType<typeof f.services.b.client.getRepositorySnapshot>>>();
    f.services.b.client.getRepositorySnapshot.mockReturnValueOnce(response.promise);
    const old = f.store.switchScopedRepository({ environmentId: "b", repositoryId: "old" }, source);
    await vi.waitFor(() => expect(f.services.b.client.getRepositorySnapshot).toHaveBeenCalledWith("old", expect.any(AbortSignal)));
    await f.store.switchScopedRepository({ environmentId: "b", repositoryId: "new" }, source);
    response.resolve({ repository: repository("old"), snapshot: snapshot() }); await old;
    expect(f.application.state.tabs[0].target).toEqual({ environmentId: "b", repositoryId: "new" });
    expect(navigation.goto).toHaveBeenCalledExactlyOnceWith("/repo/b/new", {});
  });
});

describe("cold create route and operation environment", () => {
  it("warns when creation cannot be confirmed after leaving the form", async () => {
    const f = await setup(); await f.store.prepareCreateRepository("b");
    f.store.createRepositoryName = "demo";
    let fail!: (error: Error) => void;
    f.services.b.client.createRepository.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const creating = f.store.submitCreateRepository();
    await vi.waitFor(() => expect(fail).toBeDefined());
    await f.store.showSettingsView();
    fail(new Error("Session disconnected"));
    await creating;
    expect(notifications.warning).toHaveBeenCalledWith("Could not confirm repository creation", expect.anything());
    expect(f.services.b.client.createRepository).toHaveBeenCalledOnce();
  });
  it("gates management by the operation host's grant while retaining registered and known worktree navigation", async () => {
    const f = await setup();
    f.services.b.sessionScopes = ["repository:read", "repository:operate"]; f.project();
    expect(f.store.operationEnvironments.find((entry) => entry.id === "b")).toMatchObject({ canOpen: false, canCreate: false, openReason: expect.stringContaining("repository:manage") });
    expect(f.store.operationEnvironments.find((entry) => entry.id === "a")).toMatchObject({ canOpen: true, canCreate: true });
    await f.store.chooseRepositoryForEnvironment("b");
    expect(f.store.repositoryPathDialogOpen).toBe(false);
    await f.store.prepareCreateRepository("b"); f.store.createRepositoryName = "demo";
    await f.store.submitCreateRepository();
    expect(f.store.createRepositoryError).toContain("repository:manage");
    expect(f.services.b.client.createRepository).not.toHaveBeenCalled();
    await f.store.removeScopedRepository({ environmentId: "b", repositoryId: "same" });
    expect(f.services.b.client.removeRepository).not.toHaveBeenCalled();
    await f.store.openScopedRepository({ environmentId: "b", repositoryId: "same" });
    const linked = repository("linked");
    f.state.catalogs = { b: { repositories: [linked] } } as typeof f.state.catalogs;
    await f.store.switchWorktree(linked.root);
    expect(f.services.b.client.getRepositorySnapshot).toHaveBeenCalledWith("linked", expect.any(AbortSignal));
    expect(f.services.b.client.openRepository).not.toHaveBeenCalled();

    f.services.b.sessionScopes = null; f.services.b.generation++; f.project();
    await f.store.submitCreateRepository();
    expect(f.store.createAvailability).toMatchObject({ allowed: false, reason: expect.stringContaining("authorization is unavailable") });
    expect(f.store.operationEnvironments.find((entry) => entry.id === "a")?.canCreate).toBe(true);
  });

  it("rechecks a form's pinned environment after its grant changes", async () => {
    const f = await setup();
    await f.store.chooseRepositoryForEnvironment("b");
    expect(f.store.repositoryPathDialogOpen).toBe(true);
    f.store.repositoryPathValue = "/unregistered";
    await f.store.prepareCreateRepository("b"); f.store.createRepositoryName = "demo";
    f.services.b.sessionScopes = ["repository:read"]; f.services.b.generation++; f.project();
    await f.store.submitRepositoryPath(); await f.store.submitCreateRepository();
    expect(f.store.repositoryPathError).toContain("repository:manage");
    expect(f.store.createRepositoryError).toContain("repository:manage");
    expect(f.services.b.client.openRepository).not.toHaveBeenCalled();
    expect(f.services.b.client.createRepository).not.toHaveBeenCalled();
  });

  it("allows another environment to create while a previous host is still responding", async () => {
    const f = await setup();
    await f.store.prepareCreateRepository("b");
    f.store.createRepositoryName = "remote";
    const response = deferred<Awaited<ReturnType<typeof f.services.b.client.createRepository>>>();
    f.services.b.client.createRepository.mockReturnValueOnce(response.promise);
    const remote = f.store.submitCreateRepository();
    await vi.waitFor(() => expect(f.services.b.client.createRepository).toHaveBeenCalled());
    await f.store.showStartView();
    await f.store.prepareCreateRepository("a");
    f.store.createRepositoryName = "local";
    expect(f.store.createRepositoryPending).toBe(false);
    await f.store.submitCreateRepository();
    expect(f.services.a.client.createRepository).toHaveBeenCalledOnce();
    response.resolve({ repository: repository("created-remote"), snapshot: snapshot() });
    await remote;
    expect(f.application.state.tabs.map((tab) => tab.target.environmentId)).toEqual(["a"]);
  });
  it("does not take over navigation when creation completes after leaving the form", async () => {
    const f = await setup();
    await f.store.prepareCreateRepository("b");
    f.store.createRepositoryParentPath = "/srv/projects";
    f.store.createRepositoryName = "demo";
    const response = deferred<Awaited<ReturnType<typeof f.services.b.client.createRepository>>>();
    f.services.b.client.createRepository.mockReturnValueOnce(response.promise);
    const creating = f.store.submitCreateRepository();
    await vi.waitFor(() => expect(f.services.b.client.createRepository).toHaveBeenCalled());
    await f.store.showSettingsView();
    navigation.goto.mockClear();
    response.resolve({ repository: repository("created"), snapshot: snapshot() });
    await creating;
    expect(f.application.state.tabs).toHaveLength(0);
    expect(navigation.goto).not.toHaveBeenCalled();
    expect(notifications.success).toHaveBeenCalledWith("Repository created", expect.anything());
    expect(f.runtime.refreshEnvironmentCatalog).toHaveBeenCalledWith("b");
  });
  it("waits for startup on /new, resolves the selected host, and submits there after selection changes", async () => {
    const f = await setup(true);
    f.store.applicationReady = false;
    f.store.environmentEntries = [];
    route.store = f.store;
    const target = document.createElement("div"); document.body.append(target);
    component = mount(NewRepositoryPage, { target }); flushSync();
    expect(f.store.createRepositoryPrepared).toBe(false);
    f.project(); f.store.applicationReady = true; flushSync();
    await vi.waitFor(() => expect(f.store.createRepositoryPrepared).toBe(true));
    expect(f.store.createRepositoryEnvironmentId).toBe("b");
    expect(f.store.createRepositoryParentPath).toBe("");
    expect(f.store.canBrowseCreateLocation).toBe(false);
    f.store.createRepositoryParentPath = "/srv/projects"; f.store.createRepositoryName = "demo";
    await f.display("a");
    await f.store.submitCreateRepository();
    expect(f.services.b.client.createRepository).toHaveBeenCalledExactlyOnceWith("/srv/projects", "demo", { initializeLfs: false });
    expect(f.services.a.client.createRepository).not.toHaveBeenCalled();
  });

  it("keeps explicitly prepared primary defaults and reports missing environments rather than silently submitting", async () => {
    const f = await setup(true);
    await f.store.prepareCreateRepository("a");
    expect(f.store.createRepositoryEnvironmentId).toBe("a");
    expect(f.store.createRepositoryParentPath).toBe("D:/projects");
    f.store.createRepositoryName = "demo";
    f.store.environmentEntries = [];
    await f.store.submitCreateRepository();
    expect(f.store.createRepositoryError).toContain("environment is unavailable");
    expect(f.services.a.client.createRepository).not.toHaveBeenCalled();
  });

  it("reports unavailable startup environments and recovers when a registration arrives", async () => {
    const f = await setup();
    f.store.environmentEntries = [];
    route.store = f.store;
    const target = document.createElement("div"); document.body.append(target);
    component = mount(NewRepositoryPage, { target }); flushSync();
    expect(f.store.createRepositoryError).toContain("No environment is available");
    expect(target.textContent).toContain("No environment is available");
    f.project(); flushSync();
    expect(f.store.createRepositoryEnvironmentId).toBe("b");
    expect(f.store.createRepositoryError).toBe("");
  });
});

describe("scoped Git action ownership", () => {
  it("disables mutation controls for a connected read-only session", async () => {
    const f = await setup(); await f.display("a");
    f.services.a.client.serverWelcome.capabilities.push("git.branch.rename");
    f.services.a.sessionScopes = ["repository:read"];
    f.project();
    expect(f.store.repositoryCanOperate).toBe(false);
    expect(f.store.canRenameBranch).toBe(false);
    f.store.stageAll();
    expect(f.services.a.client.stage).not.toHaveBeenCalled();
  });
  it("disables and refuses mutations when the displayed environment disconnects with a cached snapshot", async () => {
    const f = await setup(); await f.display("a");
    f.state.registry.entries[0].connection.phase = "offline";
    f.project();
    expect(f.store.snapshot).not.toBeNull();
    expect(f.store.repositoryDisconnected).toBe(true);
    expect(f.store.gitActionPending).toBe(true);
    f.store.stageAll();
    expect(f.services.a.client.stage).not.toHaveBeenCalled();
  });
  it("runs and drains two independent environment queues with scoped pending UI and captured clients", async () => {
    const f = await setup(); await f.display("a");
    const a = deferred<void>(), aQueued = deferred<void>(), b = deferred<void>();
    f.services.a.client.stage.mockReturnValueOnce(a.promise);
    f.services.a.client.unstage.mockReturnValueOnce(aQueued.promise);
    f.services.b.client.stage.mockReturnValueOnce(b.promise);
    f.store.stageAll(); f.store.unstageAll();
    expect(f.services.a.client.stage).toHaveBeenCalledExactlyOnceWith("same");
    expect(f.services.a.client.unstage).not.toHaveBeenCalled();
    expect(f.store.gitAction?.environmentId).toBe("a");
    await f.display("b");
    expect(f.store.gitActionPending).toBe(false);
    f.store.stageAll(); f.store.unstageAll();
    expect(f.services.b.client.stage).toHaveBeenCalledExactlyOnceWith("same");
    expect(f.store.gitAction?.environmentId).toBe("b");
    a.resolve();
    await vi.waitFor(() => expect(f.services.a.client.unstage).toHaveBeenCalledExactlyOnceWith("same"));
    expect(f.services.b.client.unstage).not.toHaveBeenCalled();
    expect(f.store.gitAction?.environmentId).toBe("b");
    aQueued.resolve();
    await vi.waitFor(() => expect(f.services.a.workspace.refreshRepositoryStatus).toHaveBeenCalledTimes(2));
    expect(f.store.gitActionPending).toBe(true);
    b.resolve();
    await vi.waitFor(() => expect(f.services.b.client.unstage).toHaveBeenCalledExactlyOnceWith("same"));
    await vi.waitFor(() => expect(f.store.gitActionPending).toBe(false));
    expect(f.store.queuedGitActions).toEqual([]);
  });

  it("closes application-owned worktree tabs only in the displayed environment", async () => {
    const f = await setup();
    await f.display("b", "linked"); await f.display("a", "linked"); await f.display("a");
    f.services.a.client.removeWorktree.mockResolvedValue({ removedRepositoryIds: ["linked"], branchDeleted: false, warning: null });
    f.store.commitDrafts["a:linked"] = { normal: { summary: "draft", description: "" }, amend: { summary: "", description: "" }, amendMode: false, amendHead: null };
    f.store.openRemoveWorktreeDialog({ path: "/linked", headOid: "head", branch: "topic", current: false, isMain: false }, false);
    f.store.confirmRemoveWorktree();
    await vi.waitFor(() => expect(notifications.success).toHaveBeenCalledWith("Worktree removed"));
    expect(f.application.state.tabs.map((tab) => tab.target)).toEqual([{ environmentId: "b", repositoryId: "linked" }, { environmentId: "a", repositoryId: "same" }]);
    expect(f.store.commitDrafts["a:linked"]).toBeUndefined();
    expect(f.services.a.workspace.forgetRepository).not.toHaveBeenCalled();
    expect(f.services.b.client.removeWorktree).not.toHaveBeenCalled();
  });

  it("does not close a switched checkout when server removal completes late", async () => {
    const f = await setup(); await f.display("a");
    const removal = deferred<void>();
    f.services.a.client.removeRepository.mockReturnValueOnce(removal.promise);
    const source = f.application.state.tabs[0];
    const removing = f.store.removeScopedRepository(source.target);
    await f.store.switchScopedRepository({ environmentId: "b", repositoryId: "other" }, source);
    navigation.goto.mockClear();
    removal.resolve(); await removing;
    expect(f.application.state.tabs[0].target).toEqual({ environmentId: "b", repositoryId: "other" });
    expect(navigation.goto).not.toHaveBeenCalled();
    expect(f.runtime.refreshEnvironmentCatalog).toHaveBeenCalledWith("a");
  });

  it("keeps later tab selection and home when an earlier active repository removal finishes", async () => {
    const f = await setup(); await f.display("a"); await f.display("b");
    const source = f.application.state.tabs.find((tab) => tab.target.environmentId === "b")!;
    const removal = deferred<void>(); f.services.b.client.removeRepository.mockReturnValueOnce(removal.promise);
    const removing = f.store.removeScopedRepository(source.target);
    await f.store.selectApplicationTab(f.application.state.tabs[0].tabId);
    await f.store.showStartView(); navigation.goto.mockClear();
    removal.resolve(); await removing;
    expect(f.application.state.tabs).toHaveLength(1);
    expect(f.application.state.tabs[0].target.environmentId).toBe("a");
    expect(f.application.state.activeTabId).toBe(f.application.state.tabs[0].tabId);
    expect(navigation.goto).not.toHaveBeenCalled();
  });
});

describe("home catalog projection", () => {
  it("exposes uncached failures and scoped retry without reconnecting healthy transports", async () => {
    const f = await setup();
    f.store.environmentCatalogs = {
      a: { repositories: [], status: "empty", hasSnapshot: false, error: "Cannot list repositories" },
      b: { repositories: [], status: "syncing", hasSnapshot: false, error: null },
    };
    expect(f.store.homeEnvironmentCatalogs).toMatchObject([
      { id: "a", error: "Cannot list repositories", loading: false }, { id: "b", error: "", loading: true },
    ]);
    await f.store.retryEnvironmentCatalog("a");
    expect(f.runtime.refreshEnvironmentCatalog).toHaveBeenCalledExactlyOnceWith("a");
    expect(f.runtime.retry).not.toHaveBeenCalled();
    f.store.environmentEntries = f.store.environmentEntries.map((entry) => entry.registration.environmentId === "b"
      ? { ...entry, connection: { ...entry.connection, phase: "offline" } } : entry);
    await f.store.retryEnvironmentCatalog("b");
    expect(f.runtime.retry).toHaveBeenCalledExactlyOnceWith("b");
  });
});
