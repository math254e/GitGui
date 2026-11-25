import { describe, expect, it } from "vitest";
import type { CommitRef } from "$lib/types/repository";
import { commitMenuItems } from "./commit-menu";

const main: CommitRef = { name: "refs/heads/main", shortName: "main", refType: "localBranch", target: "a".repeat(40) };
const other: CommitRef = { name: "refs/heads/other", shortName: "other", refType: "localBranch", target: main.target };
const options = {
  branches: [main], currentBranch: "feature", headOid: "b".repeat(40), commitOid: main.target, worktrees: [], pending: false,
  canPull: true, canPush: true, canSwitchBranch: true, canCreateBranch: true, canCreateTag: true,
  canMerge: true, canRebase: true, canRename: true, canDelete: true,
};

describe("commit context menu", () => {
  it("enables commit, local and remote checkout independently and explains worktree restrictions", () => {
    const remote: CommitRef = { name: "refs/remotes/origin/topic", shortName: "origin/topic", refType: "remoteBranch", target: main.target };
    const items = commitMenuItems({ ...options, branches: [main], worktreeBranches: [main, remote], canCheckoutCommit: true, canCheckoutRemoteBranch: true });
    const checkout = items.find((item) => item.id === "checkout")!;
    expect(checkout.disabled).toBe(false);
    expect(checkout.children?.map((item) => [item.id, item.disabled])).toEqual([
      ["checkout-commit", false], ["checkout-branch:refs/heads/main", false], ["checkout-branch:refs/remotes/origin/topic", false],
    ]);
    const busy = commitMenuItems({ ...options, branches: [main], worktrees: [{ path: "/other", branch: "main", current: false, isMain: false, headOid: main.target }], canCheckoutCommit: true });
    expect(busy.find((item) => item.id === "checkout")?.children?.[1]).toMatchObject({ disabled: true, disabledReason: "This branch is already checked out in another worktree." });
    const oldServer = commitMenuItems({ ...options, branches: [], canSwitchBranch: false });
    expect(oldServer.find((item) => item.id === "checkout")?.disabled).toBe(true);
    const current = commitMenuItems({ ...options, currentBranch: "main", canCheckoutCommit: true });
    expect(current.find((item) => item.id === "checkout")?.children?.[1]).toMatchObject({ disabled: true, disabledReason: "This branch is already checked out in the current worktree." });
  });
  it("uses the agreed order and greys unimplemented actions", () => {
    const items = commitMenuItems(options);
    expect(items.map((item) => item.id)).toEqual([
      "pull", "push", "merge-commit", "rebase-commit", "interactive-rebase", "squash", "checkout", "worktree", "create", "cherry-pick", "reset", "revert", "compare", "rename:refs/heads/main", "delete:refs/heads/main", "solo:refs/heads/main", "createTag", "createAnnotatedTag",
    ]);
    expect(items.find((item) => item.id === "pull")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "push")?.disabled).toBe(true);
    const checkout = items.find((item) => item.id === "checkout")!;
    expect(checkout.children?.map((item) => [item.id, item.disabled])).toEqual([["checkout-commit", true], ["checkout-branch:refs/heads/main", false]]);
    expect(items.find((item) => item.id === "merge-commit")).toMatchObject({ label: "Merge main into feature", disabled: false, separatorBefore: true });
    expect(items.find((item) => item.id === "rebase-commit")).toMatchObject({ label: "Rebase feature onto main", disabled: false });
    expect(items.filter((item) => item.id === "interactive-rebase" || item.id === "squash").every((item) => item.disabled)).toBe(true);
    for (const id of ["worktree", "cherry-pick", "reset", "revert", "createAnnotatedTag"]) expect(items.find((item) => item.id === id)?.disabled).toBe(true);
    expect(items.find((item) => item.id === "reset")?.children?.map((item) => item.label)).toEqual(["Soft", "Mixed", "Hard"]);
    expect(items.filter((item) => /^(rename|delete|solo):/.test(item.id)).map((item) => [item.id, item.disabled])).toEqual([
      ["rename:refs/heads/main", false], ["delete:refs/heads/main", false], ["solo:refs/heads/main", true],
    ]);
  });

  it("only enables branch-specific sync for the uniquely selected current branch", () => {
    const current = commitMenuItems({ ...options, currentBranch: "main", headOid: main.target });
    expect(current.find((item) => item.id === "pull")?.disabled).toBe(false);
    expect(current.find((item) => item.id === "push")?.disabled).toBe(false);
    expect(current.some((item) => item.id === "merge-commit" || item.id === "rebase-commit")).toBe(false);
    expect(current.some((item) => item.id === "interactive-rebase" || item.id === "squash")).toBe(false);
    expect(current.find((item) => item.id === "delete:refs/heads/main")?.disabled).toBe(true);
    const ambiguous = commitMenuItems({ ...options, currentBranch: "main", branches: [main, other] });
    expect(ambiguous.find((item) => item.id === "pull")?.disabled).toBe(true);
    expect(ambiguous.find((item) => item.id === "merge-commit")?.disabled).toBe(true);
    expect(ambiguous.find((item) => item.id === "rebase-commit")?.disabled).toBe(true);
    expect(ambiguous.filter((item) => item.id.startsWith("rename:")).map((item) => item.label)).toEqual(["Rename main…", "Rename other…"]);
  });

  it("hides integration actions for older commits attributed to the current branch", () => {
    const items = commitMenuItems({ ...options, branches: [], isCurrentBranchContext: true });
    expect(items.some((item) => ["merge-commit", "rebase-commit", "interactive-rebase", "squash"].includes(item.id))).toBe(false);
    expect(items.find((item) => item.id === "checkout")?.separatorBefore).toBe(true);
  });

  it("shows Pull and Push together only on a branch tip", () => {
    for (const branches of [[], [{ ...main, target: "c".repeat(40) }]]) {
      const items = commitMenuItems({ ...options, branches });
      expect(items.some((item) => item.id === "pull" || item.id === "push")).toBe(false);
    }
    for (const branches of [[main], [main, other]]) {
      const items = commitMenuItems({ ...options, branches });
      expect(items.filter((item) => item.id === "pull" || item.id === "push").map((item) => item.id)).toEqual(["pull", "push"]);
    }
  });

  it("enables sync for a selected non-current local branch when supported", () => {
    const items = commitMenuItems({ ...options, canPullOther: true, canPushOther: true });
    expect(items.find((item) => item.id === "pull")?.disabled).toBe(false);
    expect(items.find((item) => item.id === "push")?.disabled).toBe(false);
    const remote = commitMenuItems({ ...options, branches: [{ ...main, refType: "remoteBranch", name: "refs/remotes/origin/main" }], canPullOther: true, canPushOther: true });
    expect(remote.find((item) => item.id === "pull")?.disabled).toBe(true);
    expect(remote.find((item) => item.id === "push")?.disabled).toBe(true);
  });

  it("shows unavailable branch actions directly as disabled", () => {
    const actions = commitMenuItems({ ...options, canRename: false, canDelete: false }).filter((item) => /^(rename|delete|solo):/.test(item.id));
    expect(actions).toHaveLength(3);
    expect(actions.every((item) => item.disabled)).toBe(true);
  });

  it("keeps commit rebase available without a branch and blocks unavailable targets", () => {
    const items = commitMenuItems({ ...options, branches: [] });
    expect(items.find((item) => item.id === "rebase-commit")).toMatchObject({ label: "Rebase feature onto this commit", disabled: false });
    expect(items.find((item) => item.id === "merge-commit")?.disabled).toBe(true);
    expect(items.some((item) => item.id.startsWith("rename:"))).toBe(false);
    expect(commitMenuItems({ ...options, branches: [], currentBranch: null }).find((item) => item.id === "rebase-commit")?.disabled).toBe(true);
  });
});
