import { describe, expect, it } from "vitest";
import type { CommitRef, WorktreeInfo } from "$lib/types/repository";
import { branchMenuItems } from "./branch-menu";
import { worktreeMenuItems } from "./worktree-menu";

const branch: CommitRef = { name: "refs/heads/issue/2", shortName: "issue/2", target: "a".repeat(40), refType: "localBranch" };
const worktree: WorktreeInfo = { path: "/tmp/linked", branch: "issue/2", headOid: branch.target, current: false, isMain: false };
const options = { canRename: true, canRemove: true, canDeleteBranch: true };

describe("branch and worktree removal menus", () => {
  it("offers integration for local, remote and linked-worktree branches while blocking the current branch", () => {
    const base = { canRename: true, canDelete: true, checkedOut: false, canIntegrate: true };
    for (const ref of [branch, { ...branch, name: "refs/remotes/origin/issue/2", refType: "remoteBranch" as const }]) {
      const items = branchMenuItems(ref, base);
      expect(items.filter((item) => item.id.startsWith("merge:") || item.id.startsWith("rebase:")).every((item) => !item.disabled)).toBe(true);
    }
    const linked = branchMenuItems(branch, { ...base, worktree });
    expect(linked.some((item) => item.id === `merge:${branch.name}` && !item.disabled)).toBe(true);
    const current = branchMenuItems(branch, { ...base, isCurrent: true });
    expect(current.filter((item) => item.id.startsWith("merge:") || item.id.startsWith("rebase:")).every((item) => item.disabled)).toBe(true);
  });

  it("offers reviewed rewrite push only on the current branch", () => {
    const options = { canRename: true, canDelete: true, checkedOut: true, canIntegrate: true, canRewritePush: true };
    expect(branchMenuItems(branch, { ...options, isCurrent: true }).find((item) => item.id === `rewrite-push:${branch.name}`)?.disabled).toBe(false);
    expect(branchMenuItems(branch, { ...options, isCurrent: true, worktree }).find((item) => item.id === `rewrite-push:${branch.name}`)?.disabled).toBe(false);
    expect(branchMenuItems(branch, { ...options, isCurrent: false }).some((item) => item.id === `rewrite-push:${branch.name}`)).toBe(false);
  });
  it("offers navigation to a new tab independently of destructive permissions", () => {
    const items = worktreeMenuItems(worktree, { canRename: false, canRemove: false, canDeleteBranch: false, canOpenInNewTab: true });
    expect(items[0]).toMatchObject({ id: "open-in-new-tab", label: "Open in new tab" });
    expect(items[0].disabled).not.toBe(true);
  });
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
