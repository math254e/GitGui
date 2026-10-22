import type { CommitFile, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

export function buildFileDiffRequestKey(
  repositoryId: string,
  snapshot: RepositorySnapshot,
  source: "commit" | "workingTree" | "staged",
  commit: CommitInfo | null,
  file: CommitFile,
  contentRevision = 0,
): string {
  const commitHash = source === "commit" ? commit?.hash ?? "" : snapshot.status.headOid ?? "";
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
