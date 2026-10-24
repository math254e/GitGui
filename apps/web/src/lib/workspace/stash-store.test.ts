// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
// @ts-expect-error Svelte's compiler runtime has no public module declarations.
import { effect_root, flush } from "svelte/internal/client";
import { GitGuiClientError, GitGuiRpcError, type GitGuiClient } from "@gitgui/client-runtime";
import type { GitStashMutationResult, RepositorySnapshot, StashInfo } from "@gitgui/contracts";
import type { ClientWorkspaceState } from "../client-runtime";
import type { WebApplicationRuntime, WebApplicationRuntimeState } from "../connection/runtime";
import { WorkspaceStore } from "./workspace-store.svelte";
import { stashMethods } from "./stash-operations";
import StashInspectionLifecycle from "../components/__tests__/StashInspectionLifecycle.svelte";

const notifications = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("svelte-sonner", () => ({ toast: notifications }));
vi.mock("$lib/connection/platform", () => ({ readDesktopBridge: () => null }));
vi.mock("@lucide/svelte", () => ({ X: () => {} }));
// Render the real inspection components and their request lifetimes without
// starting rendering workers. No successful diff payload needs rendering here.
vi.mock("$lib/diff/renderer", () => ({ acquireDiffRenderer: () => ({ ready: Promise.reject(new Error("Renderer disabled in lifetime test")), release: () => {} }) }));

const stash: StashInfo = { selector: "stash@{0}", hash: "a".repeat(40), message: "Latest", baseHash: "b".repeat(40), indexHash: null, branch: "main", timestamp: 1 };
const older: StashInfo = { ...stash, selector: "stash@{1}", hash: "c".repeat(40), message: "Older" };
const file = { path: "one", status: "M", originalPath: null };
const snapshot = (): RepositorySnapshot => ({
  status: { currentBranch: "main", headOid: "head", changedFiles: [] }, stashes: [stash, older],
  commits: [{ hash: "head", parents: [], message: "head", author: "Me", timestamp: 1 }], refs: [], worktrees: [], graph: { commits: [], edges: [] },
} as unknown as RepositorySnapshot);
const state = (environmentId = "env-a"): ClientWorkspaceState => ({
  environmentId, activeRepositoryId: "repo", openRepositoryIds: ["repo"], recentRepositories: [], fileContentRevisions: {}, restoring: false, opening: false, refreshing: false,
  repositories: { repo: { repository: { id: "repo", root: "/repo", title: "Repo", isWorktree: false } as never, snapshot: snapshot(), loading: false, refreshing: false } },
});

type StoreInternals = {
  connectionEnvironmentId: string;
  applyWorkspaceState(state: ClientWorkspaceState): void;
  applyApplicationRuntimeState(state: WebApplicationRuntimeState): void;
};
const cleanups: Array<() => void> = [];
function setup(capabilities: string[] = Object.values(stashMethods)) {
  const client = {
    serverWelcome: { environment_id: "env-a", capabilities },
    getAmendInfo: vi.fn(async () => ({})),
    stashApply: vi.fn(), stashPopTarget: vi.fn(), stashDrop: vi.fn(), stashBranch: vi.fn(), stashPushSelected: vi.fn(), stashPop: vi.fn(),
    getStashFiles: vi.fn(), getStashFileDiff: vi.fn(),
  };
  const workspace = { state: state(), refreshRepository: vi.fn(async () => workspace.state), prefetchCommitFiles: vi.fn(async () => {}) };
  const runtimeState = { client, workspace, registry: { selectedEnvironmentId: "env-a", entries: [] }, loading: false, error: "", connection: null, workspaceState: workspace.state };
  const runtime = { isDesktop: false, get state() { return runtimeState; } };
  let store!: WorkspaceStore;
  cleanups.push(effect_root(() => { store = new WorkspaceStore(runtime as unknown as WebApplicationRuntime); }));
  store.client = client as unknown as GitGuiClient;
  store.workspace = workspace as never;
  const internals = store as unknown as StoreInternals;
  internals.connectionEnvironmentId = "env-a";
  internals.applyWorkspaceState(workspace.state);
  flush();
  return { store, internals, client, workspace, runtimeState };
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });
const diagnostic = { code: "stash_incomplete", message: "The stash was retained." };
const mutation = (overrides: Partial<GitStashMutationResult> = {}): GitStashMutationResult => ({ repositoryId: "repo", target: { selector: stash.selector, expectedOid: stash.hash }, outcome: "success", stashState: "removed", restore: "succeeded", branch: null, error: overrides.outcome && overrides.outcome !== "success" ? diagnostic : null, ...overrides });

describe("stash workspace actions", () => {
  // These are resolved facade values from ok:true envelopes, not thrown errors.
  // The RPC session forwards result without checking its action-specific schema.
  it.each([
    ["pop", "empty object", {}], ["pop", "null", null],
    ["pop", "selected-push receipt", { repositoryId: "repo", outcome: "success", stash, error: null }],
    ["pop", "unknown outcome", mutation({ outcome: "future" as never })],
    ["pop", "unknown restore", mutation({ restore: "future" as never })],
    ["pop", "unknown retention", mutation({ stashState: "future" as never })],
    ["pop", "missing restore", { ...mutation(), restore: undefined }],
    ["pop", "wrong repository", mutation({ repositoryId: "other" })],
    ["pop", "wrong selector", mutation({ target: { selector: older.selector, expectedOid: stash.hash } })],
    ["pop", "wrong full OID", mutation({ target: { selector: stash.selector, expectedOid: older.hash } })],
    ["pop", "Apply receipt", mutation({ stashState: "retained" })],
    ["pop", "Delete receipt", mutation({ restore: "notAttempted" })],
    ["pop", "removed conflicts", mutation({ outcome: "conflicts", restore: "conflicts" })],
    ["pop", "removed partial restore", mutation({ outcome: "partial", restore: "failed" })],
    ["pop", "malformed diagnostic", mutation({ outcome: "partial", stashState: "retained", error: { code: "bad", message: {} } as never })],
    ["branch", "wrong branch", mutation({ branch: { name: "other", switched: true } })],
    ["branch", "missing branch", mutation()],
    ["branch", "malformed branch progress", mutation({ branch: { name: "rescue", switched: "yes" as never } })],
    ["branch", "removed before switch", mutation({ restore: "notAttempted", branch: { name: "rescue", switched: false } })],
    ["branch", "failed restore without switch", mutation({ outcome: "branchCreatedRestoreFailed", restore: "failed", stashState: "retained", branch: { name: "rescue", switched: false } })],
    ["selected", "mutation receipt", mutation()],
    ["selected", "null", null], ["selected", "empty object", {}],
    ["selected", "unknown outcome", { repositoryId: "repo", outcome: "future", stash, error: null }],
    ["selected", "success without stash", { repositoryId: "repo", outcome: "success", stash: null, error: null }],
    ["selected", "noChanges with stash", { repositoryId: "repo", outcome: "noChanges", stash, error: null }],
    ["selected", "wrong repository", { repositoryId: "other", outcome: "success", stash, error: null }],
    ["selected", "incomplete metadata", { repositoryId: "repo", outcome: "success", stash: { selector: stash.selector }, error: null }],
    ["selected", "missing diagnostic", { repositoryId: "repo", outcome: "partial", stash }],
  ] as const)("warns on ok:true %s %s before receipt-driven effects", async (action, _reason, payload) => {
    const { store, client, workspace } = setup();
    store.selectStash(older); store.selectFile(file);
    const method = action === "selected" ? client.stashPushSelected : action === "branch" ? client.stashBranch : client.stashPopTarget;
    method.mockResolvedValue(payload);
    workspace.refreshRepository.mockImplementation(async () => {
      expect(store.selectedStash?.selector).toBe(older.selector);
      expect(store.selectedFile?.path).toBe(file.path);
      return workspace.state;
    });
    notifications.warning.mockImplementation(() => { expect(store.gitActionPending).toBe(false); });
    if (action === "selected") store.openSelectedStash("unstaged", [{ path: file.path, originalPath: null } as never]);
    else if (action === "branch") store.openStashAction("branch", stash);
    else store.popStash();
    store.submitStashReview("rescue");
    await vi.waitFor(() => expect(notifications.warning).toHaveBeenCalledTimes(1));
    expect(notifications.warning.mock.calls[0][0]).toBe("Stash completion is unknown");
    expect(notifications.warning.mock.calls[0][1].description).toContain("not replayed");
    expect(store.gitActionPending).toBe(false);
    expect(store.selectedStash?.selector).toBe(older.selector); expect(store.selectedFile?.path).toBe(file.path);
    expect(notifications.success).not.toHaveBeenCalled(); expect(notifications.info).not.toHaveBeenCalled(); expect(notifications.error).not.toHaveBeenCalled();
    expect(workspace.refreshRepository).toHaveBeenCalledExactlyOnceWith("repo");
    expect(method).toHaveBeenCalledTimes(1);
    expect(client.stashApply).not.toHaveBeenCalled(); expect(client.stashDrop).not.toHaveBeenCalled(); expect(client.stashPop).not.toHaveBeenCalled();
  });

  it("keeps malformed-receipt recovery bound to its original workspace, with read-only retry", async () => {
    const { store, client, workspace, runtimeState } = setup();
    let finish!: (value: unknown) => void;
    client.stashPopTarget.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    workspace.refreshRepository.mockRejectedValue(new Error("Refresh unavailable"));
    store.popStash(); store.submitStashReview("");
    const other = { ...workspace, refreshRepository: vi.fn(async () => state("env-b")) };
    runtimeState.registry.selectedEnvironmentId = "env-b"; runtimeState.workspace = other;
    finish({});
    await vi.waitFor(() => expect(notifications.warning).toHaveBeenCalled());
    expect(notifications.warning.mock.calls[0][0]).toBe("Stash completion is unknown; refresh failed");
    expect(store.gitActionPending).toBe(false);
    expect(workspace.refreshRepository).toHaveBeenCalledExactlyOnceWith("repo"); expect(other.refreshRepository).not.toHaveBeenCalled();
    const retry = notifications.warning.mock.calls[0][1].action.onClick;
    retry();
    await vi.waitFor(() => expect(notifications.error).toHaveBeenCalled());
    expect(other.refreshRepository).not.toHaveBeenCalled();
    runtimeState.registry.selectedEnvironmentId = "env-a"; runtimeState.workspace = workspace;
    workspace.refreshRepository.mockResolvedValue(workspace.state);
    retry();
    await vi.waitFor(() => expect(workspace.refreshRepository).toHaveBeenCalledTimes(2));
    expect(client.stashPopTarget).toHaveBeenCalledTimes(1);
  });

  it("validates a late receipt against the captured request after the catalog reindexes", async () => {
    const { store, client, workspace } = setup();
    let finish!: (value: GitStashMutationResult) => void;
    client.stashPopTarget.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    store.popStash(); store.submitStashReview("");
    store.openRepos[0].snapshot!.stashes = [{ ...older, selector: stash.selector }];
    finish(mutation());
    await vi.waitFor(() => expect(notifications.success).toHaveBeenCalled());
    expect(notifications.success.mock.calls[0][0]).toBe("Stash popped");
    expect(workspace.refreshRepository).toHaveBeenCalledExactlyOnceWith("repo");
  });

  it.each([
    ["success", stash, null, "success"], ["noChanges", null, null, "info"],
    ["partial", stash, diagnostic, "warning"], ["partial", null, diagnostic, "warning"],
  ] as const)("keeps selected %s receipts after refresh failure", async (outcome, saved, error, tone) => {
    const { store, client, workspace } = setup();
    store.selectStash(older); store.selectFile(file);
    // Compatible extra fields must not turn a selected receipt into removal.
    client.stashPushSelected.mockResolvedValue({ repositoryId: "repo", outcome, stash: saved, error, stashState: "removed", target: mutation().target });
    workspace.refreshRepository.mockRejectedValue(new Error("Refresh unavailable"));
    store.openSelectedStash("staged", [{ path: file.path, originalPath: null } as never]); store.submitStashReview("");
    await vi.waitFor(() => expect(notifications[tone]).toHaveBeenCalled());
    expect(notifications[tone].mock.calls[0][0]).not.toContain("unknown");
    expect(store.gitActionPending).toBe(false);
    expect(store.selectedStash?.selector).toBe(older.selector); expect(store.selectedFile?.path).toBe(file.path);
    expect(workspace.refreshRepository).toHaveBeenCalledTimes(1); expect(client.stashPushSelected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["apply", mutation({ stashState: "retained" }), "Stash applied"],
    ["pop", mutation(), "Stash popped"],
    ["drop", mutation({ restore: "notAttempted" }), "Stash deleted"],
    ["apply", mutation({ outcome: "conflicts", restore: "conflicts", stashState: "retained" }), "Stash restored with conflicts"],
    ["pop", mutation({ outcome: "conflicts", restore: "conflicts", stashState: "retained" }), "Stash restored with conflicts"],
    ["apply", mutation({ outcome: "partial", restore: "failed", stashState: "retained" }), "Stash operation incomplete"],
    ["pop", mutation({ outcome: "partial", restore: "failed", stashState: "retained" }), "Stash operation incomplete"],
    ["pop", mutation({ outcome: "partial", stashState: "retained" }), "Stash operation incomplete"],
    ["drop", mutation({ outcome: "partial", restore: "notAttempted", stashState: "retained" }), "Stash operation incomplete"],
    ["branch", mutation({ branch: { name: "rescue", switched: true } }), "Branch created from stash"],
    ["branch", mutation({ outcome: "partial", stashState: "retained", restore: "notAttempted" }), "Stash operation incomplete"],
    ["branch", mutation({ outcome: "partial", stashState: "retained", restore: "notAttempted", branch: { name: "rescue", switched: false } }), "Stash operation incomplete"],
    ["branch", mutation({ outcome: "branchCreatedRestoreFailed", stashState: "retained", restore: "failed", branch: { name: "rescue", switched: true } }), "Branch created; restoration incomplete"],
    ["branch", mutation({ outcome: "branchCreatedRestoreFailed", stashState: "retained", restore: "conflicts", branch: { name: "rescue", switched: true } }), "Branch created; restoration incomplete"],
    ["branch", mutation({ outcome: "partial", stashState: "retained", branch: { name: "rescue", switched: true } }), "Stash operation incomplete"],
  ] as const)("preserves valid %s progress across a failed refresh: %s", async (action, receipt, title) => {
    const { store, client, workspace } = setup();
    store.selectStash(older); store.selectFile(file);
    const method = action === "apply" ? client.stashApply : action === "pop" ? client.stashPopTarget : action === "drop" ? client.stashDrop : client.stashBranch;
    method.mockResolvedValue(receipt);
    workspace.refreshRepository.mockImplementation(async () => {
      if (receipt.stashState === "removed") {
        expect(store.selectedStash).toBeNull(); expect(store.selectedFile).toBeNull();
      } else {
        expect(store.selectedStash?.selector).toBe(older.selector); expect(store.selectedFile?.path).toBe(file.path);
      }
      throw new Error("Refresh unavailable");
    });
    const notification = receipt.outcome === "success" ? notifications.success : notifications.warning;
    notification.mockImplementation(() => { expect(store.gitActionPending).toBe(false); });
    store.openStashAction(action, stash);
    if (action !== "apply") store.submitStashReview("rescue");
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(1));
    expect(notification.mock.calls[0][0]).toBe(`${title}; refresh failed`);
    expect(notification.mock.calls[0][1].description).toContain(receipt.stashState === "removed" ? "was removed" : "is retained");
    expect(workspace.refreshRepository).toHaveBeenCalledTimes(1); expect(method).toHaveBeenCalledTimes(1);
  });

  it.each([
    new GitGuiClientError("Timed out", { code: "request_timeout" }),
    new GitGuiRpcError({ code: "transport", message: "Socket lost" }),
    { type: "response", ok: false, error: { code: "client_error", message: "No receipt" } },
  ])("warns about unknown completion from the real store without replay: %s", async (error) => {
    const { store, client, workspace } = setup();
    client.stashPopTarget.mockRejectedValue(error);
    workspace.refreshRepository.mockRejectedValue(new Error("Refresh unavailable"));
    notifications.warning.mockImplementation(() => { expect(store.gitActionPending).toBe(false); });
    store.popStash(); store.submitStashReview("");
    await vi.waitFor(() => expect(notifications.warning).toHaveBeenCalled());
    const [title, options] = notifications.warning.mock.calls[0];
    expect(title).toBe("Stash completion is unknown; refresh failed");
    expect(options.description).toContain("inspect the stash and working changes before explicitly trying again");
    expect(notifications.error).not.toHaveBeenCalled();
    workspace.refreshRepository.mockResolvedValue(workspace.state);
    options.action.onClick();
    await vi.waitFor(() => expect(workspace.refreshRepository).toHaveBeenCalledTimes(2));
    expect(client.stashPopTarget).toHaveBeenCalledTimes(1);
  });

  it("toolbar Pop reviews the captured latest stash independently of selection and never calls legacy Pop", async () => {
    const { store, client } = setup();
    store.selectStash(older);
    store.popStash();
    expect(store.stashReview?.action).toBe("pop");
    expect(store.stashReview?.context).toMatchObject({ environmentId: "env-a", repositoryId: "repo", target: { selector: stash.selector, expectedOid: stash.hash } });
    store.selectStash(older);
    client.stashPopTarget.mockResolvedValue(mutation());
    store.submitStashReview("");
    expect(store.stashReview).toBeNull();
    expect(client.stashPopTarget).toHaveBeenCalledWith({ repositoryId: "repo", target: { selector: stash.selector, expectedOid: stash.hash } });
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(client.stashPop).not.toHaveBeenCalled();
  });

  it("blocks toolbar Pop and selected stash when only legacy capabilities are advertised", () => {
    const { store, client } = setup(["git.stash.pop", "git.stash.push"]);
    store.popStash();
    store.openSelectedStash("unstaged", [{ path: "one", originalPath: null } as never]);
    expect(store.canPopStash).toBe(false);
    expect(store.stashReview).toBeNull();
    expect(client.stashPop).not.toHaveBeenCalled();
  });

  it("copies selected source/rename paths and closes before executing", async () => {
    const { store, client } = setup();
    const files = [{ path: "new", originalPath: "old" }];
    store.openSelectedStash("staged", files as never);
    files[0].path = "later";
    store.selectChangePaths(["unrelated"], "workingTree");
    client.stashPushSelected.mockResolvedValue({ repositoryId: "repo", outcome: "noChanges", stash: null, error: null });
    store.submitStashReview("reviewed message");
    expect(store.stashReview).toBeNull();
    expect(client.stashPushSelected).toHaveBeenCalledWith({ repositoryId: "repo", source: "staged", paths: ["old", "new"], message: "reviewed message" });
    await vi.waitFor(() => expect(notifications.info).toHaveBeenCalled());
  });

  it("branches from the reviewed entry and reports branch progress while retaining a failed restore", async () => {
    const { store, client } = setup();
    store.openStashAction("branch", older);
    store.selectStash(stash);
    client.stashBranch.mockResolvedValue(mutation({ target: { selector: older.selector, expectedOid: older.hash }, outcome: "branchCreatedRestoreFailed", restore: "failed", stashState: "retained", branch: { name: "rescue", switched: true } }));
    store.submitStashReview("rescue");
    expect(store.stashReview).toBeNull();
    expect(client.stashBranch).toHaveBeenCalledWith({ repositoryId: "repo", target: { selector: older.selector, expectedOid: older.hash }, name: "rescue" });
    await vi.waitFor(() => expect(notifications.warning).toHaveBeenCalled());
    expect(notifications.warning.mock.calls[0][0]).toBe("Branch created; restoration incomplete");
    expect(notifications.warning.mock.calls[0][1].description).toContain("created and checked out");
    expect(notifications.warning.mock.calls[0][1].description).toContain("retained");
  });

  it("uses the current session of the captured environment after session replacement", async () => {
    const { store, client, runtimeState } = setup();
    store.openStashAction("drop", stash);
    const replacement = { ...client, stashDrop: vi.fn(async () => mutation({ restore: "notAttempted" })) };
    runtimeState.client = replacement;
    store.submitStashReview("");
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(replacement.stashDrop).toHaveBeenCalledTimes(1);
    expect(client.stashDrop).not.toHaveBeenCalled();
  });

  it.each(["repository", "environment", "reindex", "replacement", "destination"])("refuses a review after %s changes", (change) => {
    const { store, client, runtimeState } = setup();
    store.openStashAction("pop", stash);
    if (change === "repository") store.activeRepositoryId = "another";
    if (change === "environment") runtimeState.registry.selectedEnvironmentId = "env-b";
    if (change === "reindex") store.openRepos[0].snapshot!.stashes = [{ ...stash, selector: "stash@{2}" }];
    if (change === "replacement") store.openRepos[0].snapshot!.stashes = [{ ...stash, hash: older.hash }];
    if (change === "destination") store.openRepos[0].snapshot!.status.currentBranch = "other";
    store.submitStashReview("");
    expect(store.stashReview).toBeNull();
    expect(client.stashPopTarget).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalled();
  });

  it("publishes conflicts after pending clears, preserves the receipt after refresh failure, and retries only refresh", async () => {
    const { store, client, workspace } = setup();
    client.stashPopTarget.mockResolvedValue(mutation({ outcome: "conflicts", restore: "conflicts", stashState: "retained" }));
    workspace.refreshRepository.mockRejectedValue(new Error("offline refresh"));
    notifications.warning.mockImplementation(() => { expect(store.gitActionPending).toBe(false); });
    store.openStashAction("pop", stash); store.submitStashReview("");
    await vi.waitFor(() => expect(notifications.warning).toHaveBeenCalled());
    expect(store.changesSelected).toBe(true);
    const [title, options] = notifications.warning.mock.calls[0];
    expect(title).toBe("Stash restored with conflicts; refresh failed");
    expect(options.description).toContain("retained");
    workspace.refreshRepository.mockResolvedValue(workspace.state);
    options.action.onClick();
    await vi.waitFor(() => expect(workspace.refreshRepository).toHaveBeenCalledTimes(2));
    expect(client.stashPopTarget).toHaveBeenCalledTimes(1);
  });

  it.each(["repository", "environment"])("does not move another active %s on late conflicts", async (change) => {
    const { store, client, runtimeState, workspace } = setup();
    let complete!: (result: GitStashMutationResult) => void;
    client.stashApply.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    store.openStashAction("apply", stash);
    if (change === "repository") store.activeRepositoryId = "other";
    else runtimeState.registry.selectedEnvironmentId = "env-b";
    complete(mutation({ outcome: "conflicts", restore: "conflicts", stashState: "retained" }));
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(store.changesSelected).toBe(false);
    expect(workspace.refreshRepository).toHaveBeenCalledWith("repo");
    expect(client.stashApply).toHaveBeenCalledTimes(1);
  });

  it("rebinds refresh-only retry after reconnect and refuses to refresh another environment", async () => {
    const { store, client, runtimeState, workspace } = setup();
    client.stashApply.mockResolvedValue(mutation({ stashState: "retained" }));
    workspace.refreshRepository.mockRejectedValue(new Error("Connection lost during refresh"));
    store.openStashAction("apply", stash);
    await vi.waitFor(() => expect(notifications.success).toHaveBeenCalled());
    const retry = notifications.success.mock.calls[0][1].action.onClick;
    const replacement = { ...workspace, refreshRepository: vi.fn(async () => workspace.state) };
    runtimeState.workspace = replacement;
    retry();
    await vi.waitFor(() => expect(replacement.refreshRepository).toHaveBeenCalledTimes(1));
    runtimeState.registry.selectedEnvironmentId = "env-b";
    retry();
    await vi.waitFor(() => expect(notifications.error).toHaveBeenCalled());
    expect(replacement.refreshRepository).toHaveBeenCalledTimes(1);
    expect(client.stashApply).toHaveBeenCalledTimes(1);
  });

  it("clears selection and file on reindex/removal and keeps it clear across later snapshots", () => {
    const { store, internals, workspace } = setup();
    store.selectStash(stash); store.selectFile(file);
    const next = state(); next.repositories.repo.snapshot!.stashes = [older];
    internals.applyWorkspaceState(next);
    expect(store.selectedGraphItem).toBeNull(); expect(store.selectedFile).toBeNull();
    internals.applyWorkspaceState(next);
    expect(store.selectedGraphItem).toBeNull();
    internals.applyWorkspaceState(workspace.state);
    store.selectStash(stash); store.selectFile(file); store.closeDiff();
    expect(store.selectedStash?.hash).toBe(stash.hash); expect(store.selectedFile).toBeNull();
  });

  it("does not retain a stash or open diff across environments with the same repository id", () => {
    const { store, internals } = setup();
    store.selectStash(stash); store.selectFile(file);
    internals.applyWorkspaceState(state("env-b"));
    expect(store.selectedStash).toBeNull(); expect(store.selectedFile).toBeNull();
  });

  it("still makes the initial selection when a newly opened tab finishes loading", () => {
    const { store, internals } = setup();
    store.openRepos = [];
    const loading = state(); loading.repositories.repo.snapshot = undefined;
    internals.applyWorkspaceState(loading);
    expect(store.selectedGraphItem).toBeNull();
    internals.applyWorkspaceState(state());
    expect(store.selectedCommit?.hash).toBe("head");
  });

  it("clears a removed selected stash even if refresh fails, without selecting a replacement", async () => {
    const { store, client, workspace, internals } = setup();
    store.selectStash(stash); store.selectFile(file);
    client.stashDrop.mockResolvedValue(mutation({ restore: "notAttempted" }));
    workspace.refreshRepository.mockRejectedValue(new Error("Refresh unavailable"));
    store.openStashAction("drop", stash); store.submitStashReview("");
    await vi.waitFor(() => expect(notifications.success).toHaveBeenCalled());
    expect(store.selectedStash).toBeNull(); expect(store.selectedFile).toBeNull();
    const next = state(); next.repositories.repo.snapshot!.stashes = [older];
    internals.applyWorkspaceState(next);
    expect(store.selectedGraphItem).toBeNull();
  });

  it("clears an older selection and open diff on toolbar Pop's receipt before a failed refresh", async () => {
    const { store, client, workspace, internals } = setup();
    store.selectStash(older); store.selectFile(file);
    client.stashPopTarget.mockResolvedValue(mutation());
    workspace.refreshRepository.mockImplementation(async () => {
      expect(store.selectedGraphItem).toBeNull();
      expect(store.selectedFile).toBeNull();
      throw new Error("Refresh unavailable");
    });
    store.popStash(); store.submitStashReview("");
    await vi.waitFor(() => expect(notifications.success).toHaveBeenCalled());
    expect(notifications.success.mock.calls[0][0]).toBe("Stash popped; refresh failed");
    expect(store.selectedGraphItem).toBeNull(); expect(store.selectedFile).toBeNull();
    internals.applyWorkspaceState(workspace.state);
    expect(store.selectedGraphItem).toBeNull();
    expect(client.stashPopTarget).toHaveBeenCalledTimes(1);
  });

  it("keeps the stash file request and rendered tree across equivalent repository refreshes", async () => {
    const { store, client, internals } = setup();
    let finishFiles!: (value: unknown) => void;
    client.getStashFiles.mockImplementation(() => new Promise((resolve) => { finishFiles = resolve; }));
    store.selectStash(older);
    const target = document.createElement("div"); document.body.append(target);
    const component = mount(StashInspectionLifecycle, { target, props: { store } });
    const refresh = async (message: string) => {
      const next = state();
      next.repositories.repo.snapshot!.stashes = [{ ...stash }, { ...older, message }];
      internals.applyWorkspaceState(next);
      flushSync(); await tick();
    };
    try {
      flushSync();
      expect(client.getStashFiles).toHaveBeenCalledTimes(1);
      const signal = client.getStashFiles.mock.calls[0][1] as AbortSignal;
      await refresh("Refreshed message");
      expect(client.getStashFiles).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(false);
      finishFiles({ stash: older, files: [file] });
      await vi.waitFor(() => expect(target.textContent).toContain("1 saved file"));
      const section = target.querySelector('section[aria-label="Saved files"]')!;
      const tree = [...section.querySelectorAll("div")].find((node) => node.shadowRoot)!;
      expect(tree).toBeDefined();
      for (let index = 0; index < 3; index++) {
        await refresh(`Refreshed message ${index}`);
        expect(client.getStashFiles).toHaveBeenCalledTimes(1);
        expect(target.textContent).not.toContain("Loading saved files");
        expect(tree.isConnected).toBe(true);
      }
      expect(target.textContent).toContain("Refreshed message 2");
    } finally { await unmount(component); target.remove(); }
  });

  it.each(["stash", "session"])("reloads saved files on %s changes and ignores the superseded response", async (change) => {
    const { store, client } = setup();
    const nextStash = change === "stash" ? stash : older;
    let finishOld!: (value: unknown) => void;
    client.getStashFiles.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ stash: nextStash, files: [file] });
    store.selectStash(older);
    const target = document.createElement("div"); document.body.append(target);
    const component = mount(StashInspectionLifecycle, { target, props: { store } });
    try {
      flushSync();
      const oldSignal = client.getStashFiles.mock.calls[0][1] as AbortSignal;
      if (change === "stash") store.selectStash(stash);
      else store.client = { ...client } as unknown as GitGuiClient;
      await vi.waitFor(() => expect(target.textContent).toContain("1 saved file"));
      expect(oldSignal.aborted).toBe(true);
      expect(client.getStashFiles).toHaveBeenCalledTimes(2);
      expect(client.getStashFiles.mock.calls[1][0]).toEqual({ repositoryId: "repo", target: { selector: nextStash.selector, expectedOid: nextStash.hash } });
      finishOld({ stash: older, files: [{ path: "late file", status: "A", originalPath: null }, file] });
      await tick(); await tick();
      expect(target.textContent).not.toContain("2 saved files");
      expect(target.textContent).not.toContain("late file");
      expect(target.textContent).toContain("1 saved file");
    } finally { await unmount(component); target.remove(); }
  });

  it("keeps a stash file error across snapshot refreshes and reloads on explicit Retry", async () => {
    const { store, client, internals } = setup();
    client.getStashFiles.mockRejectedValueOnce(new Error("Saved files unavailable"))
      .mockResolvedValue({ stash: older, files: [file] });
    store.selectStash(older);
    const target = document.createElement("div"); document.body.append(target);
    const component = mount(StashInspectionLifecycle, { target, props: { store } });
    try {
      await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain("Saved files unavailable"));
      const next = state();
      next.repositories.repo.snapshot!.stashes = [{ ...stash }, { ...older }];
      internals.applyWorkspaceState(next);
      flushSync(); await tick();
      expect(client.getStashFiles).toHaveBeenCalledTimes(1);
      expect(target.querySelector('[role="alert"]')?.textContent).toContain("Saved files unavailable");
      target.querySelector<HTMLButtonElement>('section[aria-label="Saved files"] button')!.click();
      await vi.waitFor(() => expect(target.textContent).toContain("1 saved file"));
      expect(client.getStashFiles).toHaveBeenCalledTimes(2);
      expect(target.querySelector('[role="alert"]')).toBeNull();
    } finally { await unmount(component); target.remove(); }
  });

  it.each(["receipt", "close diff"])("invalidates real inspection reads on %s and ignores late results", async (change) => {
    const { store, client, workspace } = setup();
    let finishFiles!: (value: unknown) => void;
    let finishDiff!: (value: unknown) => void;
    client.getStashFiles.mockImplementation(() => new Promise((resolve) => { finishFiles = resolve; }));
    client.getStashFileDiff.mockImplementation(() => new Promise((resolve) => { finishDiff = resolve; }));
    store.selectStash(older); store.selectFile(file);
    const target = document.createElement("div"); document.body.append(target);
    const component = mount(StashInspectionLifecycle, { target, props: { store } });
    try {
      flushSync();
      expect(client.getStashFiles).toHaveBeenCalledTimes(1);
      expect(client.getStashFileDiff).toHaveBeenCalledTimes(1);
      const filesSignal = client.getStashFiles.mock.calls[0][1] as AbortSignal;
      const diffSignal = client.getStashFileDiff.mock.calls[0][1] as AbortSignal;
      if (change === "receipt") {
        client.stashPopTarget.mockResolvedValue(mutation());
        workspace.refreshRepository.mockRejectedValue(new Error("Refresh unavailable"));
        store.popStash(); store.submitStashReview("");
        await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
      } else store.closeDiff();
      await tick();
      expect(diffSignal.aborted).toBe(true);
      expect(filesSignal.aborted).toBe(change === "receipt");
      // Reject after teardown even if the client ignores AbortSignal.
      finishDiff({ diff: { originalContent: "", modifiedContent: "late", patch: "late" } });
      if (change === "receipt") finishFiles({ stash: older, files: [{ path: "late file", status: "A", originalPath: null }] });
      await tick(); await tick();
      expect(target.textContent).not.toContain("late");
      expect(store.selectedFile).toBeNull();
      expect(client.getStashFileDiff).toHaveBeenCalledTimes(1);
    } finally { await unmount(component); target.remove(); }
  });

  it("preserves an unshifted newer selection, including duplicate OIDs", async () => {
    const { store, client, workspace } = setup();
    const duplicate = { ...older, hash: stash.hash };
    store.openRepos[0].snapshot!.stashes = [stash, duplicate];
    store.selectStash(stash); store.selectFile(file);
    client.stashDrop.mockResolvedValue(mutation({ target: { selector: duplicate.selector, expectedOid: duplicate.hash }, restore: "notAttempted" }));
    workspace.refreshRepository.mockRejectedValue(new Error("Refresh unavailable"));
    store.openStashAction("drop", duplicate); store.submitStashReview("");
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(store.selectedStash?.selector).toBe(stash.selector);
    expect(store.selectedFile?.path).toBe(file.path);
  });

  it("invalidates known linked-worktree tabs without clearing unrelated tabs with identical stash OIDs", async () => {
    const { store, client, workspace } = setup();
    store.selectStash(older); store.selectFile(file);
    store.openRepos[0].snapshot!.worktrees = [{ path: "/linked", current: false, isMain: false, headOid: "head", branch: "linked" }];
    const original = store.openRepos[0];
    store.openRepos = [original, { ...original, id: "linked", root: "/linked" }, { ...original, id: "unrelated", root: "/unrelated", snapshot: snapshot() }];
    client.stashPopTarget.mockResolvedValue(mutation());
    workspace.refreshRepository.mockRejectedValue(new Error("Refresh unavailable"));
    store.popStash(); store.submitStashReview("");
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(store.openRepos.slice(0, 2).every((repo) => repo.selectedGraphItem === null && repo.selectedFile === null)).toBe(true);
    expect(store.openRepos[2].selectedGraphItem).toMatchObject({ type: "stash", stash: { selector: older.selector } });
    expect(store.openRepos[2].selectedFile?.path).toBe(file.path);
  });

  it("does not clear another environment's identical repository and selector after late removal", async () => {
    const { store, client, workspace, runtimeState, internals } = setup();
    let complete!: (receipt: GitStashMutationResult) => void;
    client.stashPopTarget.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    workspace.refreshRepository.mockRejectedValue(new Error("Refresh unavailable"));
    store.popStash(); store.submitStashReview("");
    runtimeState.registry.selectedEnvironmentId = "env-b";
    internals.applyWorkspaceState(state("env-b"));
    store.selectStash(older); store.selectFile(file);
    complete(mutation());
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(store.selectedStash?.selector).toBe(older.selector);
    expect(store.selectedFile?.path).toBe(file.path);
  });

  it("invalidates review and stash details as soon as the runtime selects another environment", () => {
    const { store, internals, runtimeState } = setup();
    store.selectStash(stash); store.selectFile(file); store.openStashAction("drop", stash);
    internals.applyApplicationRuntimeState({ ...runtimeState, registry: { entries: [], selectedEnvironmentId: "env-b" }, client: null, workspace: null, workspaceState: null } as WebApplicationRuntimeState);
    expect(store.stashReview).toBeNull(); expect(store.selectedStash).toBeNull(); expect(store.selectedFile).toBeNull();
  });
});
