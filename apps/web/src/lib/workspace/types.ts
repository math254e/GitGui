import type { CommitFile, CommitInfo, CommitRef, RepositorySnapshot, StashInfo } from "$lib/types/repository";
import type { GitStashTarget } from "@gitgui/contracts";
import type { WorkingTreeDiffSource } from "$lib/components/WorkingTreePanel.svelte";

/** The graph row the user has selected in a repository. */
export type SelectedGraphItem =
  | { type: "changes" }
  | { type: "commit"; commit: CommitInfo }
  | { type: "stash"; stash: StashInfo };

/** Capture when opening a menu/dialog, before active environment or refs change. */
export type StashActionContext = {
  readonly environmentId: string;
  readonly repositoryId: string;
  readonly target: Readonly<GitStashTarget>;
};

/** One open repository tab, including the selection state the tab owns. */
export type WorkspaceRepo = {
  id: string;
  title: string;
  root: string;
  isWorktree: boolean;
  snapshot?: RepositorySnapshot;
  error?: string | null;
  loading: boolean;
  selectedGraphItem: SelectedGraphItem | null;
  /** Distinguish an intentionally cleared selection from a still-loading tab. */
  selectionInitialized?: boolean;
  selectedFile: CommitFile | null;
  selectedFileSource: WorkingTreeDiffSource | null;
  selectedChangePaths: string[];
  selectedChangeSource: WorkingTreeDiffSource | null;
};

/** A repository the server catalog offers but that is not open in a tab. */
export type RepositoryListItem = {
  repositoryId: string;
  root: string;
  title: string;
};

/** A graph the server produced for a reduced set of refs. */
export type FilteredGraphView = {
  repositoryId: string;
  key: string;
  refs: CommitRef[];
  commits: RepositorySnapshot["commits"];
  graph: RepositorySnapshot["graph"];
  sourceGraph: RepositorySnapshot["graph"];
};

export type GitActionKind =
  | "stage"
  | "unstage"
  | "commit"
  | "amend"
  | "discard"
  | "fetch"
  | "pull"
  | "push"
  | "switchBranch"
  | "createBranch"
  | "renameBranch"
  | "deleteBranch"
  | "removeWorktree"
  | "stash"
  | "stashPop";

export type GitActionRequest = {
  kind: GitActionKind;
  label: string;
  action: (repositoryId: string) => Promise<unknown>;
  affectedPaths?: string[];
  successMessage?: string;
  notifySuccess?: boolean;
  onApplied?: (result?: unknown) => void | Promise<void>;
  /** Present a custom result after refresh completes and pending status clears. */
  onSucceeded?: (result: unknown) => void;
  /** Return true when the caller has presented its own notification. */
  onFailed?: (error: unknown) => boolean;
};

export type PendingGitAction = GitActionRequest & {
  repositoryId: string;
};

export type LayoutStorage = {
  sidebarWidth?: number;
  detailsWidth?: number;
};
