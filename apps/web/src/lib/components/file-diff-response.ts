import type { CommitFileDiff, GitHunkPreview } from "@gitgui/contracts";

export function resolveFileDiffPatch(
  diff: CommitFileDiff,
  preview: GitHunkPreview | null,
  reviewRequired: boolean,
  reviewError: string,
): { patch: string | undefined } | null {
  if (reviewRequired && !preview && !reviewError) return null;
  return { patch: preview && !preview.unavailableReason && preview.patch ? preview.patch : diff.patch };
}

// Repository revalidation can return fresh objects for the same contents.
// Preserve identity so the viewer retains its parsed/highlighted representation.
export function reuseFileDiff(previous: CommitFileDiff | null, next: CommitFileDiff): CommitFileDiff {
  return previous && previous.originalPath === next.originalPath && previous.modifiedPath === next.modifiedPath &&
    previous.originalContent === next.originalContent && previous.modifiedContent === next.modifiedContent &&
    previous.isBinary === next.isBinary && previous.message === next.message && previous.patch === next.patch &&
    previous.omittedContent === next.omittedContent ? previous : next;
}

export function reuseHunkPreview(previous: GitHunkPreview | null, next: GitHunkPreview): GitHunkPreview {
  return previous && previous.filePath === next.filePath && previous.staged === next.staged &&
    previous.revision === next.revision && previous.patch === next.patch &&
    previous.unavailableReason === next.unavailableReason ? previous : next;
}

export function hasCurrentHunkReview(
  diff: CommitFileDiff | null,
  preview: GitHunkPreview | null,
  parsed: { source: CommitFileDiff; preview: GitHunkPreview | null } | null,
  reviewedRequestKey: string,
  requestKey: string,
): boolean {
  // Transport activity does not invalidate an already displayed review. A
  // changed selection revision or replacement patch does, until it is ready.
  return preview !== null && !preview.unavailableReason && parsed !== null &&
    parsed.source === diff && parsed.preview === preview &&
    reviewedRequestKey !== "" && reviewedRequestKey === requestKey;
}
