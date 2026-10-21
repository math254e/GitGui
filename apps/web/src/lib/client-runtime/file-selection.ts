import type { CommitFile, RepositorySnapshot } from "../types/repository";

/** A path must still have changes on the side whose diff is open. */
export function reconcileWorkingTreeFile(
  currentFile: CommitFile | null,
  source: "workingTree" | "staged",
  snapshot: RepositorySnapshot,
): CommitFile | null {
  if (!currentFile) return null;
  const next = snapshot.status.changedFiles.find((file) => file.path === currentFile.path);
  if (!next) return null;
  const status = source === "staged" ? next.indexStatus : next.worktreeStatus;
  const untracked = next.indexStatus === "?";
  const hasChanges = Boolean(status && status !== "." && status !== " " && status !== "?");
  if (source === "staged" ? !hasChanges : !hasChanges && !untracked) return null;
  return { path: next.path, originalPath: next.originalPath, status: `${next.indexStatus}${next.worktreeStatus}` };
}
