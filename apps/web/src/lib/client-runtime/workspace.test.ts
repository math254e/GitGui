import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitGuiClient } from "@gitgui/client-runtime";
import type { OrderedEventEnvelope, RepositorySnapshot, RepositorySummary } from "@gitgui/contracts";
import { ClientWorkspace } from "./workspace";
import { InMemoryWorkspaceMetadataAdapter } from "./metadata";

afterEach(() => vi.useRealTimers());

async function fixture(environmentId = "one", watching = true) {
  vi.useFakeTimers();
  const repository: RepositorySummary = { id: "repo-one", name: "One", path: "/one", root: "/one", isWorktree: false };
  const snapshot: RepositorySnapshot = {
    info: { path: "/one", root: "/one" },
    status: { currentBranch: "main", headOid: "a", ahead: 0, behind: 0, changedFiles: [] },
    commits: [], graph: { commits: [], edges: [], headLane: null, width: 1 }, refs: [], stashes: [], worktrees: [],
  };
  let event: ((event: OrderedEventEnvelope) => void) | undefined;
  let gap: (() => void) | undefined;
  const client = {
    serverWelcome: { capabilities: watching ? ["repositories.watch"] : [] },
    on: vi.fn((_name, listener) => { event = listener; return () => { event = undefined; }; }),
    onSequenceGap: vi.fn((listener) => { gap = listener; return () => { gap = undefined; }; }),
    listRepositories: vi.fn(async () => [repository]),
    refreshRepositories: vi.fn(async (_ids?: string[]) => ({ repositories: [{ repositoryId: repository.id, repository, snapshot }] })),
    getGitStatus: vi.fn(async () => ({ repository, status: { ...snapshot.status } })),
  };
  const metadata = new InMemoryWorkspaceMetadataAdapter([{ identity: { environmentId }, metadata: {
    schemaVersion: 1, openRepositoryIds: [repository.id], activeRepositoryId: repository.id, recentRepositories: [],
  } }]);
  const workspace = new ClientWorkspace({ client: client as unknown as GitGuiClient, identity: { environmentId }, metadataAdapter: metadata });
  workspace.startUpdates();
  await workspace.restore();
  client.refreshRepositories.mockClear();
  return { workspace, client, snapshot, emit(kind: "status" | "snapshot", repositoryId = repository.id, paths?: string[]) {
    event?.({ type: "event", sequence: 1, event: "repository.changed", payload: { repositoryId, kind, ...(paths ? { paths } : {}) } });
  }, gap: () => gap?.() };
}

describe("repository invalidations", () => {
  it("merges newer snapshot invalidations and paths while another repository's read is pending", async () => {
    const f = await fixture();
    const second = { ...f.workspace.state.repositories["repo-one"].repository, id: "repo-two", root: "/two", path: "/two" };
    Object.assign(f.client, { getRepositorySnapshot: vi.fn(async () => ({ repository: second, snapshot: f.snapshot })) });
    await f.workspace.openKnownRepository("repo-two");
    f.client.refreshRepositories.mockImplementation(async (ids = []) => ({ repositories: ids.map((id) => ({ repositoryId: id, repository: id === second.id ? second : f.workspace.state.repositories[id].repository, snapshot: f.snapshot })) }));
    let resolve!: (value: Awaited<ReturnType<typeof f.client.getGitStatus>>) => void;
    f.client.getGitStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.emit("status", "repo-one");
    f.emit("status", "repo-two", ["old"]);
    await vi.advanceTimersByTimeAsync(100);
    const checkpoint = f.workspace.beginDiscard("repo-two");
    f.emit("snapshot", "repo-two", ["new"]);
    resolve({ repository: f.workspace.state.repositories["repo-one"].repository, status: f.snapshot.status });
    await vi.advanceTimersByTimeAsync(0);
    f.workspace.reconcileDiscard(checkpoint, [], []);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.refreshRepositories).toHaveBeenCalledExactlyOnceWith(["repo-two"]);
    expect(f.workspace.state.fileContentRevisions["repo-two"]).toEqual({ old: 1, new: 1 });
    f.workspace.dispose();
  });
  it.each(["watcher", "discard"])("settles a full refresh superseded by %s and retains the full refresh demand", async (kind) => {
    const f = await fixture();
    let resolve!: (value: Awaited<ReturnType<typeof f.client.refreshRepositories>>) => void;
    f.client.refreshRepositories.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const refresh = f.workspace.refreshRepository("repo-one");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.workspace.state.repositories["repo-one"].refreshing).toBe(true);
    const checkpoint = kind === "discard" ? f.workspace.beginDiscard("repo-one") : undefined;
    if (kind === "watcher") f.emit("status");
    resolve({ repositories: [{ repositoryId: "repo-one", repository: f.workspace.state.repositories["repo-one"].repository, snapshot: f.snapshot }] });
    await refresh;
    expect(f.workspace.state.repositories["repo-one"].refreshing).toBe(false);
    if (checkpoint) f.workspace.reconcileDiscard(checkpoint, ["one"], ["one"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.refreshRepositories).toHaveBeenCalledTimes(2);
    expect(f.workspace.state.repositories["repo-one"].refreshing).toBe(false);
    expect(f.workspace.state.refreshing).toBe(false);
    f.workspace.dispose();
  });
  it("projects confirmed discard paths immediately while preserving staged rows and history", async () => {
    const f = await fixture();
    const one = { path: "one", originalPath: null, indexStatus: "M", worktreeStatus: "M" };
    const two = { path: "two", originalPath: null, indexStatus: ".", worktreeStatus: "M" };
    const other = { path: "other", originalPath: null, indexStatus: ".", worktreeStatus: "M" };
    f.snapshot.status.changedFiles = [one, two, other];
    const checkpoint = f.workspace.beginDiscard("repo-one");
    expect(f.workspace.state.repositories["repo-one"].snapshot?.status.changedFiles).toEqual([one, two, other]);
    f.workspace.reconcileDiscard(checkpoint, ["one", "two"], ["one", "two"]);
    const next = f.workspace.state.repositories["repo-one"];
    expect(next.snapshot?.status.changedFiles).toEqual([{ ...one, worktreeStatus: "." }, other]);
    expect(next.snapshot?.graph).toBe(f.snapshot.graph);
    expect(next.snapshot?.status.changedFiles[1]).toBe(other);
    expect(next.loading || next.refreshing).toBe(false);
    expect(f.workspace.state.fileContentRevisions["repo-one"]).toEqual({ one: 1, two: 1 });
    expect(f.client.getGitStatus).not.toHaveBeenCalled();
    f.workspace.dispose();
  });

  it("keeps newer edit observations and rejects an in-flight stale status response", async () => {
    const f = await fixture();
    const file = { path: "one", originalPath: null, indexStatus: ".", worktreeStatus: "M" };
    f.snapshot.status.changedFiles = [file];
    let resolve!: (result: Awaited<ReturnType<typeof f.client.getGitStatus>>) => void;
    f.client.getGitStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const refresh = f.workspace.refreshRepositoryStatus("repo-one");
    await vi.advanceTimersByTimeAsync(0);
    const checkpoint = f.workspace.beginDiscard("repo-one");
    f.emit("status", "repo-one", ["one"]);
    f.workspace.reconcileDiscard(checkpoint, ["one"], ["one"]);
    expect(f.workspace.state.repositories["repo-one"].snapshot?.status.changedFiles).toEqual([file]);
    resolve({ repository: f.workspace.state.repositories["repo-one"].repository, status: { ...f.snapshot.status, changedFiles: [] } });
    await refresh;
    expect(f.workspace.state.repositories["repo-one"].snapshot?.status.changedFiles).toEqual([file]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.getGitStatus).toHaveBeenCalledTimes(2);
    expect(f.workspace.state.repositories["repo-one"].snapshot?.status.changedFiles).toEqual([file]);
    f.workspace.dispose();
  });

  it("retains edits arriving during explicit reconciliation and deduplicates background reads", async () => {
    const f = await fixture();
    let resolve!: (result: Awaited<ReturnType<typeof f.client.getGitStatus>>) => void;
    f.client.getGitStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const refresh = f.workspace.refreshRepositoryStatus("repo-one");
    await vi.advanceTimersByTimeAsync(0);
    const file = { path: "new edit", originalPath: null, indexStatus: ".", worktreeStatus: "M" };
    f.client.getGitStatus.mockResolvedValue({ repository: f.workspace.state.repositories["repo-one"].repository, status: { ...f.snapshot.status, changedFiles: [file] } });
    f.emit("status", "repo-one", [file.path]);
    f.workspace.queueRepositoryStatusRefresh("repo-one");
    f.workspace.queueRepositoryStatusRefresh("repo-one");
    resolve({ repository: f.workspace.state.repositories["repo-one"].repository, status: f.snapshot.status });
    await refresh;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.getGitStatus).toHaveBeenCalledTimes(2);
    expect(f.workspace.state.repositories["repo-one"].snapshot?.status.changedFiles).toEqual([file]);
    expect(f.workspace.state.fileContentRevisions["repo-one"][file.path]).toBe(1);
    f.workspace.dispose();
  });

  it("bounds background work while discard is active and reports refresh failure without removing cached data", async () => {
    const f = await fixture();
    const checkpoint = f.workspace.beginDiscard("repo-one");
    f.emit("status");
    await vi.advanceTimersByTimeAsync(500);
    expect(f.client.getGitStatus).not.toHaveBeenCalled();
    f.workspace.reconcileDiscard(checkpoint, ["one"], []);
    const onError = vi.fn();
    f.client.getGitStatus.mockRejectedValueOnce(new Error("unavailable"));
    f.workspace.queueRepositoryStatusRefresh("repo-one", onError);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.getGitStatus).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith({ message: "unavailable", code: undefined });
    expect(f.workspace.state.repositories["repo-one"].snapshot).toBe(f.snapshot);
    f.workspace.dispose();
  });

  it("ignores receipts superseded by a newer request, lifecycle, or closed repository", async () => {
    for (const supersede of ["request", "disconnect", "close"] as const) {
      const f = await fixture();
      const file = { path: "one", originalPath: null, indexStatus: ".", worktreeStatus: "M" };
      f.snapshot.status.changedFiles = [file];
      const checkpoint = f.workspace.beginDiscard("repo-one");
      if (supersede === "request") await f.workspace.refreshRepositoryStatus("repo-one");
      else if (supersede === "disconnect") f.workspace.stopUpdates();
      else await f.workspace.closeRepository("repo-one");
      f.workspace.reconcileDiscard(checkpoint, ["one"], ["one"]);
      if (supersede !== "close") expect(f.workspace.state.repositories["repo-one"].snapshot?.status.changedFiles).toEqual([file]);
      else expect(f.workspace.state.repositories["repo-one"]).toBeUndefined();
      f.workspace.dispose();
    }
  });
  it("forgets a server-removed worktree without requesting another catalog deletion", async () => {
    const f = await fixture();
    const remove = vi.fn();
    Object.assign(f.client, { removeRepository: remove });
    await f.workspace.forgetRepository("repo-one");
    expect(remove).not.toHaveBeenCalled();
    expect(f.workspace.state.openRepositoryIds).toEqual([]);
    expect(f.workspace.state.activeRepositoryId).toBeNull();
    expect(f.workspace.state.repositories["repo-one"]).toBeUndefined();
    expect(f.workspace.state.recentRepositories.some((entry) => entry.repositoryId === "repo-one")).toBe(false);
    f.emit("snapshot");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.refreshRepositories).not.toHaveBeenCalled();
    f.workspace.dispose();
  });

  it("coalesces edits into status reads and retains history identity", async () => {
    const f = await fixture();
    f.emit("status"); f.emit("status"); f.emit("status", "closed-repo");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.getGitStatus).toHaveBeenCalledTimes(1);
    expect(f.client.refreshRepositories).not.toHaveBeenCalled();
    expect(f.workspace.state.repositories["repo-one"].snapshot).not.toBe(f.snapshot);
    expect(f.workspace.state.repositories["repo-one"].snapshot?.graph).toBe(f.snapshot.graph);
    f.workspace.dispose();
  });

  it("tracks same-status file invalidations only for affected paths", async () => {
    const f = await fixture();
    f.emit("status", "repo-one", ["src/open.ts"]);
    await vi.advanceTimersByTimeAsync(100);
    const revisions = f.workspace.state.fileContentRevisions["repo-one"];
    expect(revisions).toEqual({ "src/open.ts": 1 });
    f.emit("status", "repo-one", ["src/other.ts"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.workspace.state.fileContentRevisions["repo-one"]).toEqual({ "src/open.ts": 1, "src/other.ts": 1 });
    f.workspace.dispose();
  });

  it("promotes edits to a full refresh on refs or changed HEAD", async () => {
    const f = await fixture();
    f.emit("snapshot"); f.emit("status");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.refreshRepositories).toHaveBeenCalledTimes(1);
    f.client.getGitStatus.mockResolvedValueOnce({ repository: f.workspace.state.repositories["repo-one"].repository, status: { ...f.snapshot.status, headOid: "b" } });
    f.emit("status");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.refreshRepositories).toHaveBeenCalledTimes(2);
    f.workspace.dispose();
  });

  it("uses a status-only explicit refresh when history is unchanged", async () => {
    const f = await fixture();
    f.emit("status");
    await f.workspace.refreshRepositoryStatus("repo-one");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.getGitStatus).toHaveBeenCalledTimes(1);
    expect(f.client.refreshRepositories).not.toHaveBeenCalled();
    expect(f.workspace.state.repositories["repo-one"].snapshot?.graph).toBe(f.snapshot.graph);
    f.workspace.dispose();
  });

  it("adopts mutation snapshots and consumes queued watcher invalidations", async () => {
    const f = await fixture();
    const changed = {
      ...f.snapshot,
      status: { ...f.snapshot.status, changedFiles: [{ path: "staged.txt", originalPath: null, indexStatus: "A", worktreeStatus: "." }] },
    };
    f.emit("status");
    await f.workspace.applyMutationSnapshot(
      "repo-one",
      f.workspace.state.repositories["repo-one"].repository,
      changed,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.getGitStatus).not.toHaveBeenCalled();
    expect(f.client.refreshRepositories).not.toHaveBeenCalled();
    expect(f.workspace.state.repositories["repo-one"].snapshot).toBe(changed);
    f.workspace.dispose();
  });

  it("retains an invalidation arriving during a read, and preserves cached data on failure", async () => {
    const f = await fixture();
    let resolve!: (result: Awaited<ReturnType<typeof f.client.getGitStatus>>) => void;
    f.client.getGitStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.emit("status");
    await vi.advanceTimersByTimeAsync(100);
    f.emit("snapshot");
    resolve({ repository: f.workspace.state.repositories["repo-one"].repository, status: f.snapshot.status });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.refreshRepositories).toHaveBeenCalledTimes(1);
    f.client.getGitStatus.mockRejectedValueOnce(new Error("temporarily inaccessible"));
    f.emit("status");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.workspace.state.repositories["repo-one"].error?.message).toContain("inaccessible");
    expect(f.workspace.state.repositories["repo-one"].snapshot).toBe(f.snapshot);
    f.workspace.dispose();
  });

  it("recovers sequence gaps and isolates disposal and independent environments", async () => {
    const a = await fixture("a"); const b = await fixture("b");
    a.gap(); b.emit("status");
    await vi.advanceTimersByTimeAsync(100);
    expect(a.client.refreshRepositories).toHaveBeenCalledTimes(1);
    expect(b.client.refreshRepositories).not.toHaveBeenCalled();
    a.emit("snapshot"); a.workspace.dispose();
    await vi.advanceTimersByTimeAsync(120_100);
    expect(a.client.refreshRepositories).toHaveBeenCalledTimes(1);
    expect(b.client.refreshRepositories).toHaveBeenCalledTimes(1);
    b.workspace.dispose();
  });

  it("ignores pending updates after a tab closes", async () => {
    const f = await fixture();
    f.emit("snapshot");
    await f.workspace.closeRepository("repo-one");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.refreshRepositories).not.toHaveBeenCalled();
    f.workspace.dispose();
  });

  it("drops an old session's in-flight status result on disconnect", async () => {
    const f = await fixture();
    let resolve!: (result: Awaited<ReturnType<typeof f.client.getGitStatus>>) => void;
    f.client.getGitStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.emit("status");
    await vi.advanceTimersByTimeAsync(100);
    f.workspace.stopUpdates();
    f.workspace.revalidate();
    resolve({ repository: f.workspace.state.repositories["repo-one"].repository, status: { ...f.snapshot.status, changedFiles: [{ path: "stale", originalPath: null, indexStatus: "M", worktreeStatus: "." }] } });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.workspace.state.repositories["repo-one"].snapshot).toBe(f.snapshot);
    expect(f.client.getGitStatus).toHaveBeenCalledTimes(1);
    expect(f.client.refreshRepositories).not.toHaveBeenCalled();
    f.workspace.dispose();
  });

  it("does not recreate removed metadata when a pending load finishes after disposal", async () => {
    let finishLoad!: (value: null) => void;
    const metadata = {
      load: vi.fn(() => new Promise<null>((resolve) => { finishLoad = resolve; })),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const workspace = new ClientWorkspace({ client: {} as GitGuiClient, identity: { environmentId: "removed" }, metadataAdapter: metadata });
    const pending = workspace.removeRecentRepository("repo");
    await vi.waitFor(() => expect(metadata.load).toHaveBeenCalledOnce());
    workspace.dispose();
    await metadata.remove();
    finishLoad(null);
    await pending;
    expect(metadata.save).not.toHaveBeenCalled();
  });

  it("keeps the previous polling cadence for servers without watch support", async () => {
    const f = await fixture("legacy", false);
    await vi.advanceTimersByTimeAsync(30_100);
    expect(f.client.refreshRepositories).toHaveBeenCalledTimes(1);
    f.workspace.dispose();
  });
});
