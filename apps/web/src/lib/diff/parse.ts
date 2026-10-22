import { parseDiffFromFile, processFile } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";

export interface DiffParseRequest {
  originalPath: string | null;
  modifiedPath: string;
  originalContent: string;
  modifiedContent: string;
  patch?: string;
  cacheKey: string;
}

export type DiffParseResponse =
  | { metadata: FileDiffMetadata; durationMs: number }
  | { error: string };

// Called only in a worker. Supplying full contents here also avoids splitting
// and hydrating partial patches on the UI thread when context is expanded.
export function parseFileDiff(request: DiffParseRequest): FileDiffMetadata {
  const oldFile = { name: request.originalPath ?? request.modifiedPath, contents: request.originalContent };
  const newFile = { name: request.modifiedPath, contents: request.modifiedContent };
  const metadata = request.patch
    ? processFile(request.patch, { oldFile, newFile, cacheKey: request.cacheKey, throwOnError: true })
    : parseDiffFromFile(request.originalPath === null ? null : oldFile, newFile, { context: 3 }, true);
  if (!metadata) throw new Error("Git returned an invalid file patch.");
  // Snapshot patches use private temporary filenames, never repository paths.
  metadata.name = request.modifiedPath;
  metadata.prevName = request.originalPath ?? undefined;
  if (request.originalPath === null) metadata.type = "new";
  metadata.cacheKey = request.cacheKey;
  return metadata;
}
