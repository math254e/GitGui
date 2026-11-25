import type { ContextMenuItem } from "$lib/contextMenu";
import type { CommitRef, WorktreeInfo } from "$lib/types/repository";
import { branchManagementMenu } from "./branch-menu";

type Options = {
  branches: CommitRef[];
  worktreeBranches?: CommitRef[];
  currentBranch: string | null;
  isCurrentBranchContext?: boolean;
  headOid: string | null;
  commitOid: string;
  worktrees: WorktreeInfo[];
  pending: boolean;
  canPull: boolean;
  canPush: boolean;
  canPullOther?: boolean;
  canPushOther?: boolean;
  canSwitchBranch: boolean;
  canCheckoutRemoteBranch?: boolean;
  canCheckoutCommit?: boolean;
  canCreateBranch: boolean;
  canCreateWorktree?: boolean;
  canCreateTag: boolean;
  canMerge: boolean;
  canRebase: boolean;
  canRename: boolean;
  canDelete: boolean;
};

/** The menu is scoped to the clicked commit and, when unambiguous, its branch. */
export function commitMenuItems(options: Options): ContextMenuItem[] {
  const { branches, currentBranch, pending } = options;
  const selected = branches.length === 1 ? branches[0] : undefined;
  const currentSelected = selected?.refType === "localBranch" && selected.shortName === currentBranch;
  const hideIntegration = currentSelected || options.isCurrentBranchContext === true;
  const headSelected = options.headOid === options.commitOid;
  const elsewhere = (branch: CommitRef) => options.worktrees.some((worktree) => worktree.branch === branch.shortName && !worktree.current);
  const checkoutBranches: ContextMenuItem[] = (options.worktreeBranches ?? branches).map((branch) => ({
    id: `checkout-branch:${branch.name}`,
    label: branch.shortName,
    disabled: pending || (branch.refType === "remoteBranch" ? !options.canCheckoutRemoteBranch : !options.canSwitchBranch || branch.shortName === currentBranch || elsewhere(branch)),
    disabledReason: branch.refType === "localBranch" && branch.shortName === currentBranch ? "This branch is already checked out in the current worktree."
      : branch.refType === "localBranch" && elsewhere(branch) ? "This branch is already checked out in another worktree." : undefined,
  }));
  const branchActions: ContextMenuItem[] = branches.flatMap((branch) => {
    const checkedOut = branch.refType !== "localBranch" || branch.shortName === currentBranch || options.worktrees.some((worktree) => worktree.branch === branch.shortName);
    const canRename = !pending && branch.refType === "localBranch" && options.canRename;
    const canDelete = !pending && !checkedOut && options.canDelete;
    const deleteDisabledReason = branch.refType !== "localBranch" ? "Only local branches can be deleted here."
      : branch.shortName === currentBranch ? "Cannot delete the currently checked-out branch."
      : checkedOut ? "Cannot delete a branch checked out in a worktree."
      : pending ? "Wait for the current operation to finish."
      : !options.canDelete ? "Branch deletion is currently unavailable." : undefined;
    return (branchManagementMenu(branch, { canRename, canDelete, deleteDisabledReason }).children ?? []).map((item) =>
      item.id.startsWith("solo:") ? { ...item, label: "Solo" } : item,
    );
  });
  const sourceLabel = selected?.shortName ?? (branches.length ? "selected branch" : "this commit");
  const currentLabel = currentBranch ?? "current branch";
  const worktreeBranches = options.worktreeBranches ?? branches;
  return [
    ...(branches.some((branch) => branch.target === options.commitOid) ? [
      { id: "pull", label: "Pull", icon: "arrow-down-to-line", disabled: pending || !selected || selected.refType !== "localBranch" || !(currentSelected ? options.canPull : options.canPullOther) },
      { id: "push", label: "Push", icon: "upload", disabled: pending || !selected || selected.refType !== "localBranch" || !(currentSelected ? options.canPush : options.canPushOther) },
    ] : []),
    ...(!hideIntegration ? [
      { id: "merge-commit", label: `Merge ${sourceLabel} into ${currentLabel}`, icon: "git-branch", separatorBefore: true, disabled: pending || !currentBranch || headSelected || !selected || !options.canMerge },
      { id: "rebase-commit", label: `Rebase ${currentLabel} onto ${sourceLabel}`, icon: "git-branch", disabled: pending || !currentBranch || headSelected || branches.length > 1 || !options.canRebase },
      { id: "interactive-rebase", label: "Interactive rebase", disabled: true },
      { id: "squash", label: "Squash", disabled: true },
    ] : []),
    { id: "checkout", label: "Checkout", icon: "git-branch", separatorBefore: true, disabled: (pending || !options.canCheckoutCommit) && checkoutBranches.every((item) => item.disabled), children: [
      { id: "checkout-commit", label: "This commit", disabled: pending || !options.canCheckoutCommit },
      ...checkoutBranches,
    ] },
    ...(worktreeBranches.length === 0 ? [{ id: "worktree-commit", label: "Create worktree from this commit", icon: "folder", disabled: pending || !options.canCreateWorktree }] : [{ id: "worktree", label: "Create worktree", icon: "folder", disabled: pending || !options.canCreateWorktree, children: [
      { id: "worktree-commit", label: "This commit", disabled: pending || !options.canCreateWorktree },
      ...worktreeBranches.map((branch) => {
        const isCurrent = branch.refType === "localBranch" && branch.shortName === currentBranch;
        const checkedOutElsewhere = branch.refType === "localBranch" && elsewhere(branch);
        return {
          id: `worktree-branch:${branch.name}`,
          label: branch.shortName,
          disabled: pending || !options.canCreateWorktree || isCurrent || checkedOutElsewhere,
          disabledReason: isCurrent ? "This branch is already checked out in the current worktree."
            : checkedOutElsewhere ? "This branch is already checked out in another worktree." : undefined,
        };
      }),
    ] }]),
    { id: "create", label: "Create branch here…", icon: "git-branch", separatorBefore: true, disabled: pending || !options.canCreateBranch },
    { id: "cherry-pick", label: "Cherry-pick commit", disabled: true },
    { id: "reset", label: "Reset current branch to this commit", disabled: true, children: [
      { id: "reset-soft", label: "Soft", disabled: true },
      { id: "reset-mixed", label: "Mixed", disabled: true },
      { id: "reset-hard", label: "Hard", disabled: true },
    ] },
    { id: "revert", label: "Revert commit", disabled: true },
    { id: "compare", label: "Compare to working tree", icon: "git-branch" },
    ...branchActions.map((item, index) => index === 0 ? { ...item, separatorBefore: true } : item),
    { id: "createTag", label: "Create tag…", icon: "tag", separatorBefore: true, disabled: pending || !options.canCreateTag },
    { id: "createAnnotatedTag", label: "Create annotated tag here…", icon: "tag", disabled: true },
  ];
}
