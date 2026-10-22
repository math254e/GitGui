import type { ContextMenuItem } from "$lib/contextMenu";
import type { CommitRef, WorktreeInfo } from "$lib/types/repository";
import { worktreeMenuItems } from "./worktree-menu";

export function branchMenuItems(branch: CommitRef, options: {
  canRename: boolean;
  canDelete: boolean;
  checkedOut: boolean;
  worktree?: WorktreeInfo;
  canRemoveWorktree?: boolean;
}): ContextMenuItem[] {
  if (options.worktree?.isMain === false) {
    return worktreeMenuItems(options.worktree, {
      canRename: options.canRename,
      canRemove: options.canRemoveWorktree ?? false,
      canDeleteBranch: options.canDelete,
    }).map((item) => ({ ...item, id: `${item.id}:${branch.name}` }));
  }
  return [
    { id: `rename:${branch.name}`, label: "Rename branch…", icon: "pencil", disabled: !options.canRename },
    { id: `delete:${branch.name}`, label: options.checkedOut ? "Delete branch (checked out)" : "Delete branch…", icon: "trash", disabled: !options.canDelete || options.checkedOut },
  ];
}
