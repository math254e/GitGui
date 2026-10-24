import type { CommitFile, CommitInfo, RepositorySnapshot, StashInfo } from "$lib/types/repository";

export function buildFileDiffSelectionKey(
  repositoryId: string,
  source: "commit" | "workingTree" | "staged" | "commitWorkingTree" | "stash",
  commit: CommitInfo | null,
  file: CommitFile,
  stash?: StashInfo | null,
  environmentId = "",
): string {
  const commitSource = source === "commit" || source === "commitWorkingTree";
  if (source === "stash") return [environmentId, repositoryId, source, stash?.selector ?? "", stash?.hash ?? "", file.path, file.originalPath ?? ""].join("\0");
  return [repositoryId, source, commitSource ? commit?.hash ?? "" : "",
    source === "commit" ? commit?.parents[0] ?? "" : "", file.path, file.originalPath ?? ""].join("\0");
}

export function buildFileDiffRequestKey(
  repositoryId: string,
  snapshot: RepositorySnapshot,
  source: "commit" | "workingTree" | "staged" | "commitWorkingTree" | "stash",
  commit: CommitInfo | null,
  file: CommitFile,
  contentRevision = 0,
  stash?: StashInfo | null,
  environmentId = "",
): string {
  const commitSource = source === "commit" || source === "commitWorkingTree";
  if (source === "stash") return buildFileDiffSelectionKey(repositoryId, source, commit, file, stash, environmentId);
  const commitHash = commitSource ? commit?.hash ?? "" : snapshot.status.headOid ?? "";
  const parentHash = source === "commit" ? commit?.parents[0] ?? "" : "";

  return [
    repositoryId,
    source,
    commitHash,
    parentHash,
    file.path,
    file.originalPath ?? "",
    file.status,
    source === "commit" ? "" : contentRevision,
  ].join("\0");
}
