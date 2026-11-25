import type { ContextMenuItem } from "$lib/contextMenu";
import type { CommitRef, WorktreeInfo } from "$lib/types/repository";
import { worktreeMenuItems } from "./worktree-menu";

export function branchManagementMenu(branch: CommitRef, options: { canRename: boolean; canDelete: boolean; deleteDisabledReason?: string }): ContextMenuItem {
  return {
    id: `branch-menu:${branch.name}`,
    label: branch.shortName,
    icon: "git-branch",
    children: [
      { id: `rename:${branch.name}`, label: `Rename ${branch.shortName}…`, icon: "pencil", disabled: !options.canRename },
      { id: `delete:${branch.name}`, label: `Delete ${branch.shortName}…`, icon: "trash", destructive: true, disabled: !options.canDelete, disabledReason: options.deleteDisabledReason },
      { id: `solo:${branch.name}`, label: `Solo ${branch.shortName}`, disabled: true },
    ],
  };
}

export function branchMenuItems(branch: CommitRef, options: {
  canRename: boolean;
  canDelete: boolean;
  checkedOut: boolean;
  worktree?: WorktreeInfo;
  canRemoveWorktree?: boolean;
  canIntegrate?: boolean;
  canRebase?: boolean;
  isCurrent?: boolean;
  canRewritePush?: boolean;
  canCreateLocalBranch?: boolean;
  canCreateWorktree?: boolean;
  canSwitchBranch?: boolean;
}): ContextMenuItem[] {
  const integration: ContextMenuItem[] = options.canIntegrate === undefined || options.isCurrent ? [] : [
    { id: `merge:${branch.name}`, label: "Merge into current branch", icon: "git-branch", disabled: !options.canIntegrate || options.isCurrent },
    { id: `rebase:${branch.name}`, label: branch.refType === "localBranch" ? "Rebase onto this branch" : "Rebase current branch onto this commit", icon: "git-branch", disabled: !(options.canRebase ?? options.canIntegrate) || options.isCurrent },
  ];
  const currentActions: ContextMenuItem[] = options.isCurrent ? [
    ...(options.canRewritePush !== undefined ? [{ id: `rewrite-push:${branch.name}`, label: "Push rewritten branch…", icon: "upload", disabled: !options.canRewritePush }] : []),
  ] : [];
  const worktreeCreation: ContextMenuItem[] = options.canCreateWorktree === undefined ? [] : [
    { id: `create-worktree:${branch.name}`, label: "Create worktree", icon: "folder", disabled: !options.canCreateWorktree || options.checkedOut || Boolean(options.worktree) },
  ];
  const checkout: ContextMenuItem[] = options.canSwitchBranch === undefined ? [] : [{
    id: `checkout:${branch.name}`, label: "Checkout branch", icon: "git-branch",
    disabled: !options.canSwitchBranch || options.checkedOut || Boolean(options.worktree),
    disabledReason: options.isCurrent ? "This branch is already checked out in the current worktree."
      : options.checkedOut || options.worktree ? "This branch is already checked out in another worktree." : undefined,
  }];
  const management = branchManagementMenu(branch, {
    canRename: branch.refType === "localBranch" && options.canRename,
    canDelete: branch.refType === "localBranch" && options.canDelete && !options.checkedOut && !options.worktree,
    deleteDisabledReason: options.isCurrent || options.worktree?.current
      ? "Cannot delete the currently checked-out branch."
      : options.checkedOut || options.worktree
        ? "Cannot delete a branch checked out in a worktree."
        : !options.canDelete ? "Branch deletion is currently unavailable." : undefined,
  });
  if (branch.refType === "remoteBranch") return [
    { id: `create-local:${branch.name}`, label: "Checkout branch", icon: "git-branch", disabled: !options.canCreateLocalBranch },
    { id: `create-worktree:${branch.name}`, label: "Create worktree", icon: "folder", disabled: !options.canCreateWorktree },
    ...integration,
  ];
  const managementItems = (management.children ?? []).map((item) => ({
    ...item,
    label: item.id.startsWith("rename:") ? "Rename branch…" : item.id.startsWith("delete:") ? "Delete branch…" : "Solo",
  }));
  if (options.worktree?.isMain === false) {
    return [...checkout, ...integration, ...currentActions, ...worktreeCreation, ...managementItems, ...worktreeMenuItems(options.worktree, {
      canRename: options.canRename,
      canRemove: options.canRemoveWorktree ?? false,
      canDeleteBranch: options.canDelete,
    }).filter((item) => item.id !== "rename").map((item) => ({
      ...item,
      id: `${item.id}:${branch.name}`,
      label: item.id === "remove-worktree" ? "Remove worktree…" : item.id === "remove-worktree-branch" ? "Remove worktree and delete branch…" : item.label,
    }))];
  }
  return [
    ...checkout,
    ...integration,
    ...currentActions,
    ...worktreeCreation,
    ...managementItems,
  ];
}
