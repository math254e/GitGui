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
    refreshRepositories: vi.fn(async () => ({ repositories: [{ repositoryId: repository.id, repository, snapshot }] })),
    getGitStatus: vi.fn(async () => ({ repository, status: { ...snapshot.status } })),
  };
  const metadata = new InMemoryWorkspaceMetadataAdapter([{ identity: { environmentId }, metadata: {
    schemaVersion: 1, openRepositoryIds: [repository.id], activeRepositoryId: repository.id, recentRepositories: [],
  } }]);
  const workspace = new ClientWorkspace({ client: client as unknown as GitGuiClient, identity: { environmentId }, metadataAdapter: metadata });
  workspace.startUpdates();
  await workspace.restore();
  client.refreshRepositories.mockClear();
  return { workspace, client, snapshot, emit(kind: "status" | "snapshot", repositoryId = repository.id) {
    event?.({ type: "event", sequence: 1, event: "repository.changed", payload: { repositoryId, kind } });
  }, gap: () => gap?.() };
}

describe("repository invalidations", () => {
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
