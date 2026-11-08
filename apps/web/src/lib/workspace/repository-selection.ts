import { reconcileWorkingTreeFile } from "$lib/client-runtime/file-selection";
import type { RepositorySnapshot } from "$lib/types/repository";
import { reconcileSelectedStash } from "./stash-selection";
import type { SelectedGraphItem, WorkspaceRepo } from "./types";

type RepositorySelection = Pick<WorkspaceRepo,
  "selectedGraphItem" | "selectionInitialized" | "selectedFile" | "selectedFileSource" |
  "selectedChangePaths" | "selectedChangeSource">;

/** Select user-visible history, keeping synthetic stash history out of the default. */
function initialGraphSelection(snapshot: RepositorySnapshot): SelectedGraphItem | null {
  if (snapshot.status.changedFiles.length) return { type: "changes" };
  const stashHashes = new Set(snapshot.stashes.map((stash) => stash.hash));
  const commit = snapshot.commits.find((candidate) => !stashHashes.has(candidate.hash));
  return commit ? { type: "commit", commit } : null;
}

function reconcileGraphSelection(selection: SelectedGraphItem | null, snapshot: RepositorySnapshot): SelectedGraphItem | null {
  // A deliberately cleared stash selection stays cleared after invalidation.
  if (!selection) return null;
  if (selection.type === "stash") {
    const stash = reconcileSelectedStash(selection.stash, snapshot.stashes);
    return stash ? { type: "stash", stash } : null;
  }
  if (selection.type === "commit") {
    const commit = snapshot.commits.find((candidate) => candidate.hash === selection.commit.hash);
    if (commit) return { type: "commit", commit };
  }
  if (selection.type === "changes" && snapshot.status.changedFiles.length) return { type: "changes" };
  return initialGraphSelection(snapshot);
}

function reconcileFileSelection(previous: WorkspaceRepo | undefined, graph: SelectedGraphItem | null, snapshot: RepositorySnapshot | undefined): WorkspaceRepo["selectedFile"] {
  if (!snapshot) return previous?.selectedFile ?? null;
  if (graph?.type === "changes") {
    return reconcileWorkingTreeFile(previous?.selectedFile ?? null,
      previous?.selectedFileSource === "staged" ? "staged" : "workingTree", snapshot);
  }
  if (graph?.type === "commit" && previous?.selectedGraphItem?.type === "commit" &&
      graph.commit.hash === previous.selectedGraphItem.commit.hash) return previous.selectedFile;
  if (graph?.type === "stash" && previous?.selectedGraphItem?.type === "stash" &&
      graph.stash.hash === previous.selectedGraphItem.stash.hash && graph.stash.selector === previous.selectedGraphItem.stash.selector) {
    return previous.selectedFile;
  }
  return null;
}

/** Reconcile a tab's graph and file selection together when repository data changes. */
export function reconcileRepositorySelection(previous: WorkspaceRepo | undefined, snapshot: RepositorySnapshot | undefined): RepositorySelection {
  const graph = snapshot
    ? previous?.selectionInitialized ? reconcileGraphSelection(previous.selectedGraphItem, snapshot) : initialGraphSelection(snapshot)
    : previous?.selectedGraphItem ?? null;
  const file = reconcileFileSelection(previous, graph, snapshot);
  return {
    selectedGraphItem: graph,
    selectionInitialized: previous?.selectionInitialized || Boolean(snapshot),
    selectedFile: file,
    selectedFileSource: graph?.type === "changes" && file ? previous?.selectedFileSource ?? "workingTree" : null,
    selectedChangePaths: previous?.selectedChangePaths ?? [],
    selectedChangeSource: graph?.type === "changes" ? previous?.selectedChangeSource ?? "workingTree" : null,
  };
}
