import type { ContextMenuItem } from "$lib/contextMenu";
import type { WorktreeInfo } from "$lib/types/repository";

export function removableWorktree(worktree: WorktreeInfo): boolean {
  return worktree.isMain === false && !worktree.current && Boolean(worktree.headOid);
}

export function worktreeMenuItems(worktree: WorktreeInfo, options: {
  canRename: boolean;
  canRemove: boolean;
  canDeleteBranch: boolean;
}): ContextMenuItem[] {
  const removable = removableWorktree(worktree);
  const items: ContextMenuItem[] = [];
  if (worktree.branch) items.push({ id: "rename", label: `Rename ${worktree.branch}…`, icon: "pencil", disabled: !options.canRename });
  items.push({ id: "remove-worktree", label: "Remove this worktree…", icon: "trash", disabled: !options.canRemove || !removable });
  if (worktree.branch) items.push({ id: "remove-worktree-branch", label: "Remove worktree and delete branch…", icon: "trash", disabled: !options.canRemove || !options.canDeleteBranch || !removable });
  return items;
}
