// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Svelte's compiler runtime has no public module declarations.
import { effect_root, flush } from "svelte/internal/client";
import type { GitGuiClient } from "@gitgui/client-runtime";
import type { GitDiscardFile, GitDiscardResult, OrderedEventEnvelope, RepositorySnapshot, RepositorySummary } from "@gitgui/contracts";
import { ClientWorkspace, InMemoryWorkspaceMetadataAdapter, type ClientWorkspaceState } from "../client-runtime";
import type { WebApplicationRuntime, WebApplicationRuntimeState } from "../connection/runtime";
import { WorkspaceStore } from "./workspace-store.svelte";

const notifications = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("svelte-sonner", () => ({ toast: notifications }));
vi.mock("$lib/connection/platform", () => ({ readDesktopBridge: () => null }));

const files: GitDiscardFile[] = ["one", "two"].map((path) => ({ path, untracked: false, revision: "a".repeat(64) }));
const receipt: GitDiscardResult = { completedPaths: ["one", "two"], remainingPaths: [], error: null };
const cleanups: Array<() => void> = [];
const drain = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); flush(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function setup(environmentId = "env") {
  let event: ((event: OrderedEventEnvelope) => void) | undefined;
  const repository: RepositorySummary = { id: "repo", name: "Repo", root: "/repo", path: "/repo", isWorktree: false };
  const snapshot: RepositorySnapshot = {
    info: { path: "/repo", root: "/repo" },
    status: { currentBranch: "main", headOid: "head", ahead: 0, behind: 0, changedFiles: [
      { path: "one", originalPath: null, indexStatus: "M", worktreeStatus: "M" },
      { path: "two", originalPath: null, indexStatus: ".", worktreeStatus: "M" },
      { path: "other", originalPath: null, indexStatus: ".", worktreeStatus: "M" },
    ] }, commits: [], refs: [], worktrees: [], stashes: [], graph: { commits: [], edges: [], headLane: null, width: 1 },
  };
  const client = {
    serverWelcome: { capabilities: ["repositories.watch"] },
    on: vi.fn((_name, listener) => { event = listener; return () => { event = undefined; }; }), onSequenceGap: vi.fn(() => () => {}),
    listRepositories: vi.fn(async () => [repository]),
    refreshRepositories: vi.fn(async () => ({ repositories: [{ repositoryId: "repo", repository, snapshot }] })),
    getGitStatus: vi.fn(async () => ({ repository, status: snapshot.status })),
    getAmendInfo: vi.fn(async () => ({})), prefetchCommitFiles: vi.fn(async () => {}),
    previewDiscard: vi.fn(async () => files), discard: vi.fn(async (): Promise<unknown> => receipt),
  };
  const metadata = new InMemoryWorkspaceMetadataAdapter([{ identity: { environmentId }, metadata: { schemaVersion: 1, openRepositoryIds: ["repo"], activeRepositoryId: "repo", recentRepositories: [] } }]);
  const workspace = new ClientWorkspace({ client: client as unknown as GitGuiClient, identity: { environmentId }, metadataAdapter: metadata });
  workspace.startUpdates();
  await workspace.restore();
  cleanups.push(() => workspace.dispose());
  client.refreshRepositories.mockClear();
  const runtimeState = { client, workspace, registry: { selectedEnvironmentId: environmentId, entries: [] }, loading: false, error: "", connection: null, workspaceState: workspace.state };
  const runtime = { isDesktop: false, get state() { return runtimeState; } };
  let store!: WorkspaceStore;
  cleanups.push(effect_root(() => { store = new WorkspaceStore(runtime as unknown as WebApplicationRuntime); }));
  store.client = client as unknown as GitGuiClient;
  store.workspace = workspace;
  const internals = store as unknown as { connectionEnvironmentId: string; applyWorkspaceState(state: ClientWorkspaceState): void; applyApplicationRuntimeState(state: WebApplicationRuntimeState): void };
  internals.connectionEnvironmentId = environmentId;
  cleanups.push(workspace.subscribe((state) => { runtimeState.workspaceState = state; internals.applyWorkspaceState(state); }));
  flush();
  return { store, client, workspace, snapshot, runtimeState, internals,
    emit: (paths?: string[]) => event?.({ type: "event", sequence: 1, event: "repository.changed", payload: { repositoryId: "repo", kind: "status", ...(paths ? { paths } : {}) } }),
  };
}

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => { cleanups.splice(0).reverse().forEach((cleanup) => cleanup()); vi.useRealTimers(); });

describe("responsive discard", () => {
  it("rechecks amend blockers when same-HEAD workflow metadata is created and removed", async () => {
    const f = await setup();
    await drain();
    const calls = f.client.getAmendInfo.mock.calls.length;
    f.emit(["one"]);
    await vi.advanceTimersByTimeAsync(100);
    await drain();
    expect(f.client.getAmendInfo).toHaveBeenCalledTimes(calls);
    f.client.getAmendInfo.mockResolvedValueOnce({ headOid: "head", blockedReason: "Finish the current merge" });
    f.emit();
    await vi.advanceTimersByTimeAsync(100);
    await drain();
    expect(f.store.amendInfo?.blockedReason).toBe("Finish the current merge");
    f.client.getAmendInfo.mockResolvedValueOnce({ headOid: "head", blockedReason: null });
    f.emit();
    await vi.advanceTimersByTimeAsync(100);
    await drain();
    expect(f.store.amendInfo?.blockedReason).toBeNull();
    expect(f.client.getAmendInfo).toHaveBeenCalledTimes(calls + 2);
  });
  it("does not enqueue amend reviews on status-only updates, but rechecks blockers on a full snapshot", async () => {
    const { client, workspace, snapshot } = await setup();
    await drain();
    const initialCalls = client.getAmendInfo.mock.calls.length;
    await workspace.refreshRepositoryStatus("repo");
    await drain();
    expect(client.getAmendInfo).toHaveBeenCalledTimes(initialCalls);
    await workspace.applyMutationSnapshot("repo", workspace.state.repositories.repo.repository, { ...snapshot, graph: { ...snapshot.graph } });
    await drain();
    expect(client.getAmendInfo).toHaveBeenCalledTimes(initialCalls + 1);
  });
  it("releases its pending action after an environment switch without running the old queue", async () => {
    const a = await setup();
    const b = await setup("other");
    const mutation = deferred<unknown>();
    a.client.discard.mockReturnValueOnce(mutation.promise);
    await a.store.openDiscard(["one", "two"]);
    a.store.confirmDiscard(files, false);
    const queued = vi.fn(async () => {});
    a.store.queuedGitActions = [{ repositoryId: "repo", kind: "stage", label: "Staging", action: queued }];
    a.internals.applyApplicationRuntimeState(b.runtimeState as unknown as WebApplicationRuntimeState);
    mutation.resolve(receipt);
    await drain();
    expect(a.store.gitActionPending).toBe(false);
    expect(queued).not.toHaveBeenCalled();
    expect(b.workspace.state.repositories.repo.snapshot?.status.changedFiles).toEqual(b.snapshot.status.changedFiles);
    expect(b.client.getGitStatus).not.toHaveBeenCalled();
  });

  it("invalidates same-environment dialogs and their outstanding preview on session replacement", async () => {
    const a = await setup();
    const b = await setup();
    const preview = deferred<GitDiscardFile[]>();
    a.client.previewDiscard.mockReturnValueOnce(preview.promise);
    const opening = a.store.openDiscard(["one"]);
    a.internals.applyApplicationRuntimeState(b.runtimeState as unknown as WebApplicationRuntimeState);
    expect(a.store.discardDialog).toBeNull();
    preview.resolve(files);
    await opening;
    expect(a.store.discardDialog).toBeNull();
    a.store.confirmDiscard(files, false);
    expect(a.client.discard).not.toHaveBeenCalled();
    expect(b.client.discard).not.toHaveBeenCalled();
  });
  it("closes on submission, waits for a receipt to reconcile rows, and clears pending before the toast and status read", async () => {
    const { store, client, workspace, snapshot } = await setup();
    const mutation = deferred<unknown>();
    const refresh = deferred<Awaited<ReturnType<typeof client.getGitStatus>>>();
    client.discard.mockReturnValueOnce(mutation.promise);
    client.getGitStatus.mockReturnValueOnce(refresh.promise);
    notifications.success.mockImplementation(() => { expect(store.gitActionPending).toBe(false); });
    await store.openDiscard(["one", "two"]);
    store.confirmDiscard(files, false);
    expect(store.discardDialog).toBeNull();
    expect(store.gitActionPending).toBe(true);
    expect(store.snapshot?.status.changedFiles).toEqual(snapshot.status.changedFiles);
    expect(notifications.success).not.toHaveBeenCalled();
    mutation.resolve(receipt);
    await drain();
    expect(store.gitActionPending).toBe(false);
    expect(notifications.success).toHaveBeenCalledExactlyOnceWith("Discarded changes in 2 files");
    expect(store.snapshot?.status.changedFiles).toEqual([{ ...snapshot.status.changedFiles[0], worktreeStatus: "." }, snapshot.status.changedFiles[2]]);
    expect(workspace.state.repositories.repo.snapshot?.graph).toBe(snapshot.graph);
    expect(store.openRepos[0].loading).toBe(false);
    expect(workspace.state.fileContentRevisions.repo).toEqual({ one: 1, two: 1 });
    expect(client.getGitStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getGitStatus).toHaveBeenCalledTimes(1);
    expect(store.gitActionPending).toBe(false);
    refresh.resolve({ repository: workspace.state.repositories.repo.repository, status: store.snapshot!.status });
    await drain();
    expect(client.refreshRepositories).not.toHaveBeenCalled();
  });

  it("shows partial completion before refresh and keeps remaining paths and a newer selection", async () => {
    const { store, client, snapshot } = await setup();
    const mutation = deferred<unknown>();
    client.discard.mockReturnValueOnce(mutation.promise);
    await store.openDiscard(["one", "two"]);
    store.confirmDiscard(files, false);
    store.selectFile({ path: "other", status: "M", originalPath: null });
    mutation.resolve({ completedPaths: ["one"], remainingPaths: ["two"], error: "two changed during discard" });
    await drain();
    expect(store.snapshot?.status.changedFiles).toEqual([{ ...snapshot.status.changedFiles[0], worktreeStatus: "." }, ...snapshot.status.changedFiles.slice(1)]);
    expect(store.selectedFile?.path).toBe("other");
    expect(notifications.error.mock.calls[0]).toEqual(["Discard stopped", { description: "two changed during discard\nChanged: one\nRemaining: two" }]);
    expect(notifications.success).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...receipt, completedPaths: ["outside"] }, { ...receipt, remainingPaths: ["one"] }])("treats malformed receipt %j as unknown, retains rows, and never replays", async (value) => {
    const { store, client, snapshot } = await setup();
    client.discard.mockResolvedValueOnce(value);
    await store.openDiscard(["one", "two"]);
    store.confirmDiscard(files, false);
    await drain();
    expect(store.snapshot?.status.changedFiles).toEqual(snapshot.status.changedFiles);
    expect(notifications.warning.mock.calls[0][0]).toBe("Discard completion is unknown");
    expect(notifications.success).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.discard).toHaveBeenCalledTimes(1);
    expect(client.getGitStatus).toHaveBeenCalledTimes(1);
  });

  it("publishes transport uncertainty promptly and separates later refresh failure with read-only recovery", async () => {
    const { store, client, snapshot } = await setup();
    client.discard.mockRejectedValueOnce({ code: "request_timeout", message: "No receipt" });
    client.getGitStatus.mockRejectedValueOnce(new Error("Refresh unavailable"));
    await store.openDiscard(["one", "two"]);
    store.confirmDiscard(files, false);
    await drain();
    expect(store.gitActionPending).toBe(false);
    expect(notifications.warning.mock.calls[0][0]).toBe("Discard completion is unknown");
    expect(store.snapshot?.status.changedFiles).toEqual(snapshot.status.changedFiles);
    await vi.advanceTimersByTimeAsync(100);
    expect(notifications.warning.mock.calls[1][0]).toBe("Discard status refresh failed");
    notifications.warning.mock.calls[1][1].action.onClick();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.discard).toHaveBeenCalledTimes(1);
    expect(client.getGitStatus).toHaveBeenCalledTimes(2);
  });

  it("retains a successful result across refresh failure", async () => {
    const { store, client } = await setup();
    client.getGitStatus.mockRejectedValueOnce(new Error("Refresh unavailable"));
    await store.openDiscard(["one", "two"]);
    store.confirmDiscard(files, false);
    await drain();
    expect(notifications.success).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(notifications.warning.mock.calls[0][0]).toBe("Discard status refresh failed");
    expect(notifications.success).toHaveBeenCalledTimes(1);
    expect(client.discard).toHaveBeenCalledTimes(1);
    expect(store.gitActionPending).toBe(false);
  });

  it("requires reviewed untracked targets and refuses a stale repository before dispatch", async () => {
    const { store, client } = await setup();
    const untracked = [{ ...files[0], untracked: true }];
    client.previewDiscard.mockResolvedValueOnce(untracked);
    await store.openDiscard(["one"]);
    store.confirmDiscard(untracked, false);
    expect(client.discard).not.toHaveBeenCalled();
    store.activeRepositoryId = "other";
    store.confirmDiscard(untracked, true);
    expect(client.discard).not.toHaveBeenCalled();
    store.activeRepositoryId = "repo";
    store.confirmDiscard(untracked, true);
    expect(client.discard).toHaveBeenCalledExactlyOnceWith({ repositoryId: "repo", files: untracked, deleteUntracked: true });
    await drain();
  });

  it("ignores an older preview response for the same repository", async () => {
    const { store, client } = await setup();
    const old = deferred<GitDiscardFile[]>();
    client.previewDiscard.mockReturnValueOnce(old.promise);
    const opening = store.openDiscard(["one"]);
    client.previewDiscard.mockResolvedValueOnce([files[1]]);
    await store.openDiscard(["two"]);
    old.resolve([files[0]]);
    await opening;
    expect(store.discardDialog?.files).toEqual([files[1]]);
  });
});
