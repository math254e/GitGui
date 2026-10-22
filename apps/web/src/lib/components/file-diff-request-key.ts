import type { CommitFile, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

export function buildFileDiffSelectionKey(
  repositoryId: string,
  source: "commit" | "workingTree" | "staged" | "commitWorkingTree",
  commit: CommitInfo | null,
  file: CommitFile,
): string {
  const commitSource = source === "commit" || source === "commitWorkingTree";
  return [repositoryId, source, commitSource ? commit?.hash ?? "" : "",
    source === "commit" ? commit?.parents[0] ?? "" : "", file.path, file.originalPath ?? ""].join("\0");
}

export function buildFileDiffRequestKey(
  repositoryId: string,
  snapshot: RepositorySnapshot,
  source: "commit" | "workingTree" | "staged" | "commitWorkingTree",
  commit: CommitInfo | null,
  file: CommitFile,
  contentRevision = 0,
): string {
  const commitSource = source === "commit" || source === "commitWorkingTree";
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
