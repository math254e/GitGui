import type { GitGuiClient } from "@gitgui/client-runtime";
import type { CommitFile, CommitInfo, FileDiffResult, RepositorySnapshot, StashInfo } from "@gitgui/contracts";

export type DiffSource = "commit" | "workingTree" | "staged" | "commitWorkingTree" | "stash";
export function canMutateFileDiff(source: DiffSource): boolean {
  return source === "workingTree" || source === "staged";
}

/** Stash reads never prepare a live-index hunk continuation. */
export function requestFileDiff(
  client: GitGuiClient, repositoryId: string, source: DiffSource,
  commit: CommitInfo | null, stash: StashInfo | null, file: CommitFile,
  snapshot: RepositorySnapshot, signal: AbortSignal,
): Promise<FileDiffResult> {
  if (source === "stash") {
    if (!stash || !client.serverWelcome.capabilities.includes("git.stash.file_diff")) return Promise.reject(new Error("This server does not support the selected stash diff."));
    return client.getStashFileDiff({ repositoryId, target: { selector: stash.selector, expectedOid: stash.hash }, filePath: file.path }, signal);
  }
  if (source === "commit" || source === "commitWorkingTree") {
    if (!commit) return Promise.reject(new Error("No commit is selected."));
    return source === "commit"
      ? client.getCommitFileDiff({ repositoryId, commitHash: commit.hash, ...(commit.parents[0] ? { parentHash: commit.parents[0] } : {}), filePath: file.path }, signal)
      : client.getCommitWorkingTreeFileDiff({ repositoryId, commitHash: commit.hash, filePath: file.path }, signal);
  }
  return client.getWorkingTreeFileDiff({ repositoryId, ...(snapshot.status.headOid ? { headHash: snapshot.status.headOid } : {}), filePath: file.path, staged: source === "staged", prepareHunks: true }, signal);
}
