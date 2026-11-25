import { describe, expect, it } from "vitest";
import type { CommitRef, WorktreeInfo } from "$lib/types/repository";
import { branchMenuItems } from "./branch-menu";
import { worktreeMenuItems } from "./worktree-menu";

const branch: CommitRef = { name: "refs/heads/issue/2", shortName: "issue/2", target: "a".repeat(40), refType: "localBranch" };
const worktree: WorktreeInfo = { path: "/tmp/linked", branch: "issue/2", headOid: branch.target, current: false, isMain: false };
const options = { canRename: true, canRemove: true, canDeleteBranch: true };

describe("branch and worktree removal menus", () => {
  it("allows checkout of an available local branch and explains checked out branches", () => {
    const base = { canRename: true, canDelete: true, canSwitchBranch: true, checkedOut: false };
    expect(branchMenuItems(branch, base).find((item) => item.id === `checkout:${branch.name}`)?.disabled).toBe(false);
    expect(branchMenuItems(branch, { ...base, checkedOut: true, isCurrent: true }).find((item) => item.id === `checkout:${branch.name}`)).toMatchObject({ disabled: true, disabledReason: "This branch is already checked out in the current worktree." });
    expect(branchMenuItems(branch, { ...base, checkedOut: true, worktree }).find((item) => item.id === `checkout:${branch.name}`)).toMatchObject({ disabled: true, disabledReason: "This branch is already checked out in another worktree." });
    expect(branchMenuItems(branch, { ...base, canSwitchBranch: false }).find((item) => item.id === `checkout:${branch.name}`)?.disabled).toBe(true);
  });
  it("offers integration for local, remote and linked-worktree branches while blocking the current branch", () => {
    const base = { canRename: true, canDelete: true, checkedOut: false, canIntegrate: true };
    for (const ref of [branch, { ...branch, name: "refs/remotes/origin/issue/2", refType: "remoteBranch" as const }]) {
      const items = branchMenuItems(ref, base);
      expect(items.filter((item) => item.id.startsWith("merge:") || item.id.startsWith("rebase:")).every((item) => !item.disabled)).toBe(true);
    }
    const linked = branchMenuItems(branch, { ...base, worktree });
    expect(linked.some((item) => item.id === `merge:${branch.name}` && !item.disabled)).toBe(true);
    const current = branchMenuItems(branch, { ...base, isCurrent: true });
    expect(current.some((item) => item.id.startsWith("merge:") || item.id.startsWith("rebase:"))).toBe(false);
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
  it("offers branch actions directly alongside linked worktree removal actions", () => {
    const fromBranch = branchMenuItems(branch, { canRename: true, canDelete: true, checkedOut: true, worktree, canRemoveWorktree: true });
    expect(fromBranch.slice(0, 3).map((item) => [item.id, item.disabled])).toEqual([
      [`rename:${branch.name}`, false], [`delete:${branch.name}`, true], [`solo:${branch.name}`, true],
    ]);
    expect(fromBranch.map((item) => item.label)).toEqual([
      "Rename branch…", "Delete branch…", "Solo", "Remove worktree…", "Remove worktree and delete branch…",
    ]);
    expect(fromBranch.map((item) => item.id)).toContain(`remove-worktree:${branch.name}`);
    expect(fromBranch.map((item) => item.id)).toContain(`remove-worktree-branch:${branch.name}`);
  });

  it("shows unavailable branch actions directly as disabled items", () => {
    const items = branchMenuItems(branch, { canRename: false, canDelete: false, checkedOut: false });
    expect(items.map((item) => item.id)).toEqual([`rename:${branch.name}`, `delete:${branch.name}`, `solo:${branch.name}`]);
    expect(items.every((item) => item.disabled)).toBe(true);
    expect(items[1].disabledReason).toBe("Branch deletion is currently unavailable.");
  });

  it("explains why a checked-out branch cannot be deleted", () => {
    const current = branchMenuItems(branch, { canRename: true, canDelete: true, checkedOut: true, isCurrent: true });
    expect(current.find((item) => item.id === `delete:${branch.name}`)?.disabledReason).toBe("Cannot delete the currently checked-out branch.");
    const linked = branchMenuItems(branch, { canRename: true, canDelete: true, checkedOut: true, worktree });
    expect(linked.find((item) => item.id === `delete:${branch.name}`)?.disabledReason).toBe("Cannot delete a branch checked out in a worktree.");
  });

  it("uses branch-specific integration wording in the local sidebar", () => {
    const items = branchMenuItems(branch, { canRename: true, canDelete: true, checkedOut: false, canIntegrate: true });
    expect(items.find((item) => item.id === `rebase:${branch.name}`)?.label).toBe("Rebase onto this branch");
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
