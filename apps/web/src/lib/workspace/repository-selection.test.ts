import { describe, expect, it } from "vitest";
import type { CommitInfo, RepositorySnapshot, StashInfo } from "$lib/types/repository";
import { reconcileRepositorySelection } from "./repository-selection";
import type { WorkspaceRepo } from "./types";

const commit: CommitInfo = { hash: "commit", parents: [], author: "A", timestamp: 1, message: "Original" };
const stash: StashInfo = { hash: "stash", selector: "stash@{0}", baseHash: "commit", indexHash: null, branch: "main", message: "Saved", timestamp: 1 };
const file = { path: "file.txt", originalPath: null, status: ".M" };
const snapshot = (): RepositorySnapshot => ({ info: { path: "/repo", root: "/repo" },
  status: { currentBranch: "main", headOid: "commit", ahead: 0, behind: 0, changedFiles: [] },
  commits: [commit], stashes: [], refs: [], worktrees: [], graph: { commits: [], edges: [], width: 1, headLane: 0 } });
const previous = (overrides: Partial<WorkspaceRepo> = {}): WorkspaceRepo => ({ id: "repo", title: "repo", root: "/repo", isWorktree: false, loading: false,
  selectedGraphItem: null, selectionInitialized: true, selectedFile: null, selectedFileSource: null,
  selectedChangePaths: [], selectedChangeSource: null, ...overrides });

describe("repository selection reconciliation", () => {
  it("initializes changes first, otherwise skips synthetic stash commits", () => {
    const next = snapshot();
    next.stashes = [stash];
    next.commits = [{ ...commit, hash: stash.hash }, commit];
    expect(reconcileRepositorySelection(undefined, next).selectedGraphItem).toEqual({ type: "commit", commit });
    next.status.changedFiles = [{ path: file.path, originalPath: null, indexStatus: ".", worktreeStatus: "M" }];
    expect(reconcileRepositorySelection(undefined, next).selectedGraphItem).toEqual({ type: "changes" });
  });

  it("preserves a cleared selection across subsequent snapshots", () => {
    expect(reconcileRepositorySelection(previous(), snapshot()).selectedGraphItem).toBeNull();
  });

  it("keeps a selected commit and its file only while the same commit exists", () => {
    const selected = previous({ selectedGraphItem: { type: "commit", commit }, selectedFile: file });
    const next = snapshot();
    next.commits = [{ ...commit, message: "Updated" }];
    expect(reconcileRepositorySelection(selected, next)).toMatchObject({ selectedGraphItem: { type: "commit", commit: { message: "Updated" } }, selectedFile: file });
    next.commits = [{ ...commit, hash: "other" }];
    expect(reconcileRepositorySelection(selected, next)).toMatchObject({ selectedGraphItem: { type: "commit", commit: { hash: "other" } }, selectedFile: null });
  });

  it("clears an open stash diff when its reviewed stash is replaced or reindexed", () => {
    const selected = previous({ selectedGraphItem: { type: "stash", stash }, selectedFile: file });
    const next = snapshot();
    next.stashes = [{ ...stash, message: "Updated" }];
    expect(reconcileRepositorySelection(selected, next)).toMatchObject({ selectedGraphItem: { type: "stash", stash: { message: "Updated" } }, selectedFile: file });
    next.stashes = [{ ...stash, selector: "stash@{1}" }];
    expect(reconcileRepositorySelection(selected, next)).toMatchObject({ selectedGraphItem: null, selectedFile: null });
  });

  it("closes a staged diff when the file is no longer staged and preserves placeholders", () => {
    const selected = previous({ selectedGraphItem: { type: "changes" }, selectedFile: file, selectedFileSource: "staged" });
    const next = snapshot();
    next.status.changedFiles = [{ path: file.path, originalPath: null, indexStatus: ".", worktreeStatus: "M" }];
    expect(reconcileRepositorySelection(selected, next)).toMatchObject({ selectedGraphItem: { type: "changes" }, selectedFile: null, selectedFileSource: null });
    expect(reconcileRepositorySelection(selected, undefined)).toMatchObject({ selectedGraphItem: { type: "changes" }, selectedFile: file, selectedFileSource: "staged" });
  });
});
