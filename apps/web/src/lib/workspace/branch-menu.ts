import type { ContextMenuItem } from "$lib/contextMenu";
import type { CommitRef, WorktreeInfo } from "$lib/types/repository";
import { worktreeMenuItems } from "./worktree-menu";

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
}): ContextMenuItem[] {
  const integration: ContextMenuItem[] = options.canIntegrate === undefined ? [] : [
    { id: `merge:${branch.name}`, label: "Merge into current branch…", icon: "git-branch", disabled: !options.canIntegrate || options.isCurrent },
    { id: `rebase:${branch.name}`, label: "Rebase current branch onto this commit", icon: "git-branch", disabled: !(options.canRebase ?? options.canIntegrate) || options.isCurrent },
  ];
  const currentActions: ContextMenuItem[] = options.isCurrent ? [
    ...(options.canRewritePush !== undefined ? [{ id: `rewrite-push:${branch.name}`, label: "Push rewritten branch…", icon: "upload", disabled: !options.canRewritePush }] : []),
  ] : [];
  if (branch.refType === "remoteBranch") return integration;
  if (options.worktree?.isMain === false) {
    return [...integration, ...currentActions, ...worktreeMenuItems(options.worktree, {
      canRename: options.canRename,
      canRemove: options.canRemoveWorktree ?? false,
      canDeleteBranch: options.canDelete,
    }).map((item) => ({ ...item, id: `${item.id}:${branch.name}` }))];
  }
  return [
    ...integration,
    ...currentActions,
    { id: `rename:${branch.name}`, label: "Rename branch…", icon: "pencil", disabled: !options.canRename },
    { id: `delete:${branch.name}`, label: options.checkedOut ? "Delete branch (checked out)" : "Delete branch…", icon: "trash", disabled: !options.canDelete || options.checkedOut },
  ];
}
