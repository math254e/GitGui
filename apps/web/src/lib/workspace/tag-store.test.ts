// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Svelte's compiler runtime has no public module declarations.
import { effect_root, flush } from "svelte/internal/client";
import type { GitGuiClient } from "@gitgui/client-runtime";
import type { CommitInfo, RepositorySnapshot } from "@gitgui/contracts";
import type { ClientWorkspaceState } from "../client-runtime";
import type { WebApplicationRuntime } from "../connection/runtime";
import { WorkspaceStore } from "./workspace-store.svelte";

const notifications = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("svelte-sonner", () => ({ toast: notifications }));
vi.mock("$lib/connection/platform", () => ({ readDesktopBridge: () => null }));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.clearAllMocks(); localStorage.clear(); });
const commit: CommitInfo = { hash: "a".repeat(40), parents: [], author: "Me", message: "First", timestamp: 1 };

function setup(capabilities = ["git.tag.create", "git.tag.delete", "git.tag.checkout", "git.tag.push", "git.tag.details", "git.tag.apply_fetch"]) {
  const snapshot = { status: { currentBranch: "main", headOid: commit.hash, changedFiles: [] }, refs: [],
    stashes: [], worktrees: [], commits: [commit, { ...commit, hash: "b".repeat(40) }], graph: { commits: [], edges: [] } } as unknown as RepositorySnapshot;
  const repository = { id: "repo", root: "/repo", title: "Repo", isWorktree: false };
  const state = { environmentId: "env", activeRepositoryId: "repo", openRepositoryIds: ["repo"], recentRepositories: [], fileContentRevisions: {},
    restoring: false, opening: false, refreshing: false, repositories: { repo: { repository, snapshot, loading: false, refreshing: false } },
  } as unknown as ClientWorkspaceState;
  const client = { serverWelcome: { capabilities }, getAmendInfo: vi.fn(async () => ({})), createTag: vi.fn(), deleteTag: vi.fn(), getRepositoryGraph: vi.fn(),
    checkoutTag: vi.fn(), pushTag: vi.fn(), getTagDetails: vi.fn(), fetch: vi.fn(), push: vi.fn(), applyFetchedTags: vi.fn() };
  const workspace = { state, refreshRepository: vi.fn(async () => state), prefetchCommitFiles: vi.fn(async () => {}), applyMutationSnapshot: vi.fn(async () => state) };
  const runtime = { isDesktop: false, state: { client, workspace, registry: { selectedEnvironmentId: "env", entries: [] }, workspaceState: state } };
  let store!: WorkspaceStore;
  cleanups.push(effect_root(() => { store = new WorkspaceStore(runtime as unknown as WebApplicationRuntime); }));
  store.client = client as unknown as GitGuiClient;
  store.workspace = workspace as never;
  const internals = store as unknown as { connectionEnvironmentId: string; applyWorkspaceState(state: ClientWorkspaceState): void };
  internals.connectionEnvironmentId = "env";
  internals.applyWorkspaceState(state);
  flush();
  return { store, client, workspace, internals, repository, snapshot, state };
}

describe("create tag from the graph", () => {
  it("reviews fetch conflicts before replacing local tags and sends only selected replacements", async () => {
    const { store, client, repository, snapshot } = setup();
    const conflicts = [1, 2].map((i) => ({ name: `v${i}`, localObjectId: "a".repeat(40), remoteObjectId: "c".repeat(40) }));
    client.fetch.mockResolvedValue({ repository, snapshot, remote: "origin", tagConflicts: conflicts });
    client.applyFetchedTags.mockResolvedValue({ repository, snapshot });
    store.fetchRepository();
    await vi.waitFor(() => expect(store.tagFetchReview?.conflicts).toHaveLength(2));
    expect(client.applyFetchedTags).not.toHaveBeenCalled();
    store.toggleFetchedTag("v2", false); store.confirmFetchedTags();
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(client.applyFetchedTags).toHaveBeenCalledExactlyOnceWith({ repositoryId: "repo", conflicts: [conflicts[0]] });
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(store.tagFetchReview).toBeNull();
  });

  it("reuses annotation reads and makes no Git request for lightweight hover details", async () => {
    const { store, client } = setup();
    const tag = { name: "refs/tags/v1", shortName: "v1", target: commit.hash, objectId: "c".repeat(40), refType: "tag" as const };
    const details = { annotated: true, message: "Release", tagger: "Me", timestamp: 1, hasSignature: false };
    client.getTagDetails.mockResolvedValue(details);
    await Promise.all([store.loadTagDetails(tag), store.loadTagDetails(tag)]);
    await store.loadTagDetails(tag);
    expect(client.getTagDetails).toHaveBeenCalledTimes(1);
    expect(await store.loadTagDetails({ ...tag, objectId: tag.target })).toMatchObject({ annotated: false });
    expect(client.getTagDetails).toHaveBeenCalledTimes(1);
  });

  it("deletes only after confirmation using the captured unpeeled object ID", async () => {
    const { store, client, workspace, repository, snapshot } = setup();
    const tag = { name: "refs/tags/release", shortName: "tags/release", target: commit.hash, objectId: "c".repeat(40), refType: "tag" as const };
    client.deleteTag.mockResolvedValue({ repository, snapshot });
    store.openDeleteTagDialog(tag);
    expect(client.deleteTag).not.toHaveBeenCalled();
    tag.objectId = "d".repeat(40);
    store.confirmDeleteTag();
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(client.deleteTag).toHaveBeenCalledExactlyOnceWith({ repositoryId: "repo", name: "release", expectedObjectId: "c".repeat(40) });
    expect(workspace.applyMutationSnapshot).toHaveBeenCalledExactlyOnceWith("repo", repository, snapshot);
    expect(workspace.refreshRepository).not.toHaveBeenCalled();
    expect(store.deleteTagDialog).toBeNull();
  });

  it("keeps failed deletion in the confirmation and blocks obsolete or unsupported requests", async () => {
    const { store, client, internals, state } = setup();
    const tag = { name: "refs/tags/v1", shortName: "v1", target: commit.hash, objectId: "c".repeat(40), refType: "tag" as const };
    client.deleteTag.mockRejectedValue(new Error("The tag changed"));
    store.openDeleteTagDialog(tag); store.confirmDeleteTag();
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(store.deleteTagDialog?.error).toContain("changed");
    internals.applyWorkspaceState({ ...state, environmentId: "other" }); flush();
    expect(store.deleteTagDialog).toBeNull();
    store.confirmDeleteTag();
    expect(client.deleteTag).toHaveBeenCalledTimes(1);
    const unavailable = setup([]);
    unavailable.store.openDeleteTagDialog(tag);
    expect(unavailable.store.deleteTagDialog).toBeNull();
    unavailable.store.confirmDeleteTag();
    expect(unavailable.client.deleteTag).not.toHaveBeenCalled();
  });

  it("uses the captured commit after selection changes and applies the response without a second snapshot fetch", async () => {
    const { store, client, workspace, repository, snapshot } = setup();
    client.createTag.mockResolvedValue({ repository, snapshot });
    store.openTagDialog(commit);
    store.gitNameDialogValue = "releases/v1.0.0";
    store.selectCommit(snapshot.commits[1]);
    store.submitGitNameDialog();
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(client.createTag).toHaveBeenCalledExactlyOnceWith({ repositoryId: "repo", name: "releases/v1.0.0", target: commit.hash });
    expect(workspace.applyMutationSnapshot).toHaveBeenCalledExactlyOnceWith("repo", repository, snapshot);
    expect(workspace.refreshRepository).not.toHaveBeenCalled();
    expect(store.gitNameDialogKind).toBeNull();
  });

  it("rejects invalid and duplicate names locally and preserves the entered name after server failure", async () => {
    const { store, client, snapshot, internals, state } = setup();
    snapshot.refs.push({ refType: "tag", name: "refs/tags/v1", shortName: "v1", target: commit.hash });
    internals.applyWorkspaceState({ ...state, repositories: { repo: { ...state.repositories.repo, snapshot: { ...snapshot } } } });
    store.openTagDialog(commit);
    for (const name of ["bad..name", "bad name", "v1"]) {
      store.gitNameDialogValue = name;
      store.submitGitNameDialog();
      expect(store.gitNameDialogError).not.toBe("");
    }
    expect(client.createTag).not.toHaveBeenCalled();
    client.createTag.mockRejectedValue(new Error("Tag is locked by another process"));
    store.gitNameDialogValue = "v2";
    store.submitGitNameDialog();
    await vi.waitFor(() => expect(store.gitActionPending).toBe(false));
    expect(store.gitNameDialogKind).toBe("tag");
    expect(store.gitNameDialogValue).toBe("v2");
    expect(store.gitNameDialogError).toContain("locked");
    expect(client.createTag).toHaveBeenCalledTimes(1);
  });

  it("blocks unavailable servers and discards a dialog after changing environment", () => {
    const unavailable = setup([]);
    unavailable.store.openTagDialog(commit);
    expect(unavailable.store.gitNameDialogKind).toBeNull();
    const { store, client, internals, state } = setup();
    store.openTagDialog(commit); store.gitNameDialogValue = "v1";
    internals.applyWorkspaceState({ ...state, environmentId: "other" });
    store.submitGitNameDialog();
    expect(client.createTag).not.toHaveBeenCalled();
  });

  it("updates tag badges before filtered history completes and ignores an obsolete filter response", async () => {
    const { store, client, internals, snapshot, state } = setup();
    const tags = snapshot.commits.map((commit, i) => ({ name: `refs/tags/v${i}`, shortName: `v${i}`, target: commit.hash, refType: "tag" as const }));
    const nextSnapshot = { ...snapshot, refs: tags };
    internals.applyWorkspaceState({ ...state, repositories: { repo: { ...state.repositories.repo, snapshot: nextSnapshot } } });
    const sourceGraph = store.snapshot!.graph;
    let complete!: (value: unknown) => void;
    client.getRepositoryGraph.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    store.toggleGraphRefs([tags[1]], false); flush();
    expect(store.graphSnapshot?.refs).toEqual([tags[0]]);
    expect(store.graphSnapshot?.graph).toBe(sourceGraph);
    expect(client.getRepositoryGraph).toHaveBeenCalledExactlyOnceWith({ repositoryId: "repo", targetCommits: [commit.hash] });
    store.selectRef(tags[1]); flush();
    expect(store.graphSnapshot?.refs).toEqual(tags);
    expect(store.scrollToCommit?.hash).toBe(tags[1].target);
    complete({ commits: [], graph: { commits: [], edges: [] } });
    await Promise.resolve(); flush();
    expect(store.graphSnapshot?.graph).toBe(sourceGraph);
  });
});
