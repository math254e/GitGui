import { describe, expect, it } from "vitest";
import type { CommitRef, WorktreeInfo } from "$lib/types/repository";
import { branchMenuItems } from "./branch-menu";
import { worktreeMenuItems } from "./worktree-menu";

const branch: CommitRef = { name: "refs/heads/issue/2", shortName: "issue/2", target: "a".repeat(40), refType: "localBranch" };
const worktree: WorktreeInfo = { path: "/tmp/linked", branch: "issue/2", headOid: branch.target, current: false, isMain: false };
const options = { canRename: true, canRemove: true, canDeleteBranch: true };

describe("branch and worktree removal menus", () => {
  it("offers the same three actions on a branch checked out in a linked worktree", () => {
    const fromWorktree = worktreeMenuItems(worktree, options);
    const fromBranch = branchMenuItems(branch, { canRename: true, canDelete: true, checkedOut: true, worktree, canRemoveWorktree: true });
    expect(fromBranch.map((item) => item.label)).toEqual(fromWorktree.map((item) => item.label));
    expect(fromBranch.every((item) => !item.disabled)).toBe(true);
    expect(fromBranch.map((item) => item.id)).toContain(`remove-worktree-branch:${branch.name}`);
  });

  it("protects the main and currently open worktrees and older servers", () => {
    for (const target of [{ ...worktree, isMain: true }, { ...worktree, current: true }, { ...worktree, isMain: undefined }]) {
      expect(worktreeMenuItems(target, options).filter((item) => item.id.startsWith("remove")).every((item) => item.disabled)).toBe(true);
    }
    expect(worktreeMenuItems(worktree, { ...options, canRemove: false }).filter((item) => item.id.startsWith("remove")).every((item) => item.disabled)).toBe(true);
  });

  it("offers only worktree removal for a detached checkout", () => {
    expect(worktreeMenuItems({ ...worktree, branch: null }, options).map((item) => item.id)).toEqual(["remove-worktree"]);
  });
});
