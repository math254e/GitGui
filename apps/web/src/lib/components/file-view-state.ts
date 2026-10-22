import type { CommitFileDiff } from "@gitgui/contracts";

export function fileViewState(
  diff: CommitFileDiff | null,
  loading: boolean,
  error: string,
  renderError: string,
  rendererReady: boolean,
): "loading" | "error" | "binary" | "omitted" | "ready" {
  if (loading) return "loading";
  if (error) return "error";
  // Omission is a successful response and needs no renderer initialization.
  if (diff?.omittedContent) return "omitted";
  if (renderError) return "error";
  if (diff?.isBinary) return "binary";
  if (diff && !rendererReady) return "loading";
  return "ready";
}
