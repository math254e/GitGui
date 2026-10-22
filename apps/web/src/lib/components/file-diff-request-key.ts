import type { CommitFile, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

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
