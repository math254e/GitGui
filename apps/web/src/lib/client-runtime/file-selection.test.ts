import { describe, expect, it } from "vitest";
import type { RepositorySnapshot } from "../types/repository";
import { reconcileWorkingTreeFile } from "./file-selection";

const file = { path: "file.txt", originalPath: null, status: ".M" };
function snapshot(indexStatus: string, worktreeStatus: string): RepositorySnapshot {
  return {
    info: { path: "/repo", root: "/repo" },
    status: { currentBranch: "main", headOid: "head", ahead: 0, behind: 0, changedFiles: [{ path: file.path, originalPath: null, indexStatus, worktreeStatus }] },
    commits: [], graph: { commits: [], edges: [], width: 1, headLane: 0 }, refs: [], stashes: [], worktrees: [],
  };
}

describe("open working-tree diff after staging", () => {
  it("closes after the last unstaged hunk even though the path remains staged", () => {
    expect(reconcileWorkingTreeFile(file, "workingTree", snapshot("M", "."))).toBeNull();
  });

  it("keeps remaining unstaged hunks open with updated status metadata", () => {
    expect(reconcileWorkingTreeFile(file, "workingTree", snapshot("M", "M"))).toEqual({ ...file, status: "MM" });
    expect(reconcileWorkingTreeFile({ ...file, status: "MM" }, "workingTree", snapshot("M", "M"))).toEqual({ ...file, status: "MM" });
  });

  it("closes staged view after the last hunk is unstaged, while preserving a partial staged view", () => {
    expect(reconcileWorkingTreeFile(file, "staged", snapshot(".", "M"))).toBeNull();
    expect(reconcileWorkingTreeFile(file, "staged", snapshot("M", "M"))).toEqual({ ...file, status: "MM" });
  });

  it("keeps untracked files only on the unstaged side and closes removed paths", () => {
    expect(reconcileWorkingTreeFile(file, "workingTree", snapshot("?", "?"))).toEqual({ ...file, status: "??" });
    expect(reconcileWorkingTreeFile(file, "staged", snapshot("?", "?"))).toBeNull();
    const next = snapshot("M", ".");
    next.status.changedFiles = [];
    expect(reconcileWorkingTreeFile(file, "workingTree", next)).toBeNull();
  });
});
