/**
 * Vendored from T3 Code (`packages/client-runtime/src/rpc/protocol.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - T3 Code's server is TypeScript and speaks `effect/rpc`, so its protocol
 *   group is declared with `Rpc.make` and the client is
 *   `RpcClient.make(WsRpcGroup)`. The GitGui server is Rust and speaks the
 *   GitGui JSON envelope (`welcome` / `response` / `event`), so this module
 *   declares the method registry and the payload and result types instead.
 * - The types come from the generated contract, which the Rust protocol crate
 *   produces with `ts-rs`, so a method, its payload, and its result are
 *   checked against the server's own definitions. `WS_METHOD_NAMES` is
 *   generated from the same crate and the test in `protocol.test.ts` fails if
 *   the registry and this table drift apart.
 * - GitGui-owned branch rename/delete methods use reviewed local ref targets
 *   and return mutation outcomes before the client refreshes repository state.
 * - Reviewed worktree removal also reports branch and catalog cleanup outcomes.
 * - GitGui-owned lightweight tag creation accepts a full reviewed commit ID
 *   and returns a snapshot through the ordinary repository mutation contract.
 * - Reviewed tag deletion compares the unpeeled tag object ID atomically and
 *   returns a snapshot through that same mutation contract.
 * - GitGui tag checkout/push, annotation details, and reviewed fetch replacement
 *   extend the domain table. Main fetch/push include tags in one network call.
 * - Accepted stash feature contracts include selected capture, reviewed actions,
 *   and saved-object reads. The Rust feature list is a subset of its accepted
 *   registry; advertised capabilities still determine server availability.
 */
import type {
  CommitFileDiffParams,
  CommitFilesParams,
  CommitFilesResult,
  CommitWorkingTreeFilesParams,
  CommitWorkingTreeFileDiffParams,
  FileDiffResult,
  GitAmendInfo,
  GitAmendParams,
  GitApplyHunksParams,
  GitBranchCreateParams,
  GitBranchCreateResult,
  GitTagCreateParams,
  GitTagCreateResult,
  GitTagDeleteParams,
  GitTagDeleteResult,
  GitTagTargetParams,
  GitTagMutationResult,
  GitTagApplyFetchParams,
  GitTagDetails,
  GitBranchRenameParams,
  GitBranchDeleteParams,
  GitWorktreeRemoveParams,
  GitWorktreeRemoveResult,
  GitBranchListParams,
  GitBranchListResult,
  GitBranchSwitchParams,
  GitBranchSwitchResult,
  GitCommitParams,
  GitCommitResult,
  GitDiscardFile,
  GitDiscardParams,
  GitDiscardResult,
  GitFetchResult,
  GitHunkPreview,
  GitHunkPreviewParams,
  GitPathsParams,
  GitPullResult,
  GitPushResult,
  GitRepositoryParams,
  GitStageResult,
  GitStashPopParams,
  GitStashPopResult,
  GitStashPushParams,
  GitStashPushResult,
  GitStashPushSelectedParams,
  GitStashPushSelectedResult,
  GitStashTargetParams,
  GitStashBranchParams,
  GitStashMutationResult,
  GitStashFilesResult,
  GitStashFileDiffParams,
  GitStashFileDiffResult,
  GitStatusParams,
  GitStatusResult,
  GitUnstageResult,
  OrderedEventEnvelope,
  PrefetchCommitDiffsParams,
  PrefetchCommitDiffsResult,
  PrefetchCommitFilesParams,
  PrefetchCommitFilesResult,
  RepositoriesCreateParams,
  RepositoriesCreateResult,
  RepositoriesListResult,
  RepositoriesOpenParams,
  RepositoriesOpenResult,
  RepositoriesRefreshParams,
  RepositoriesRefreshResult,
  RepositoriesRemoveParams,
  RepositoriesRemoveResult,
  RepositoryGraphParams,
  RepositoryGraphResult,
  RepositorySnapshotParams,
  RepositorySnapshotResult,
  ServerInfo,
  ServerStatus,
  WorkingTreeFileDiffParams,
} from "@gitgui/contracts";
import { STASH_FEATURE_METHOD_NAMES } from "@gitgui/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

/** A method that takes no payload. */
export type EmptyRpcInput = Record<string, never>;

/**
 * The payload and result of accepted WebSocket methods.
 *
 * The method names are the canonical ones from the Rust protocol, and the
 * types are the generated contract, so a call is checked against the server's
 * own definitions.
 */
export interface GitGuiRpcMethods {
  "server.get_info": { readonly input: EmptyRpcInput; readonly output: ServerInfo };
  "server.get_status": { readonly input: EmptyRpcInput; readonly output: ServerStatus };
  "repositories.list": { readonly input: EmptyRpcInput; readonly output: RepositoriesListResult };
  "repositories.open": { readonly input: RepositoriesOpenParams; readonly output: RepositoriesOpenResult };
  "repositories.create": {
    readonly input: RepositoriesCreateParams;
    readonly output: RepositoriesCreateResult;
  };
  "repositories.remove": {
    readonly input: RepositoriesRemoveParams;
    readonly output: RepositoriesRemoveResult;
  };
  "repositories.get_snapshot": {
    readonly input: RepositorySnapshotParams;
    readonly output: RepositorySnapshotResult;
  };
  "repositories.get_graph": {
    readonly input: RepositoryGraphParams;
    readonly output: RepositoryGraphResult;
  };
  "repositories.refresh": {
    readonly input: RepositoriesRefreshParams;
    readonly output: RepositoriesRefreshResult;
  };
  "git.status": { readonly input: GitStatusParams; readonly output: GitStatusResult };
  "git.commit_files": { readonly input: CommitFilesParams; readonly output: CommitFilesResult };
  "git.commit_working_tree_files": { readonly input: CommitWorkingTreeFilesParams; readonly output: CommitFilesResult };
  "git.commit_working_tree_file_diff": { readonly input: CommitWorkingTreeFileDiffParams; readonly output: FileDiffResult };
  "git.commit_file_diff": { readonly input: CommitFileDiffParams; readonly output: FileDiffResult };
  "git.working_tree_file_diff": {
    readonly input: WorkingTreeFileDiffParams;
    readonly output: FileDiffResult;
  };
  "git.prefetch_commit_files": {
    readonly input: PrefetchCommitFilesParams;
    readonly output: PrefetchCommitFilesResult;
  };
  "git.prefetch_commit_diffs": {
    readonly input: PrefetchCommitDiffsParams;
    readonly output: PrefetchCommitDiffsResult;
  };
  "git.stage": { readonly input: GitPathsParams; readonly output: GitStageResult };
  "git.unstage": { readonly input: GitPathsParams; readonly output: GitUnstageResult };
  "git.commit": { readonly input: GitCommitParams; readonly output: GitCommitResult };
  "git.hunk_preview": { readonly input: GitHunkPreviewParams; readonly output: GitHunkPreview };
  "git.apply_hunks": { readonly input: GitApplyHunksParams; readonly output: null };
  "git.discard_preview": { readonly input: GitPathsParams; readonly output: GitDiscardFile[] };
  "git.discard": { readonly input: GitDiscardParams; readonly output: GitDiscardResult };
  "git.amend_info": { readonly input: GitRepositoryParams; readonly output: GitAmendInfo };
  "git.amend": { readonly input: GitAmendParams; readonly output: null };
  "git.fetch": { readonly input: GitRepositoryParams; readonly output: GitFetchResult };
  "git.pull": { readonly input: GitRepositoryParams; readonly output: GitPullResult };
  "git.push": { readonly input: GitRepositoryParams; readonly output: GitPushResult };
  "git.branch.list": { readonly input: GitBranchListParams; readonly output: GitBranchListResult };
  "git.branch.create": {
    readonly input: GitBranchCreateParams;
    readonly output: GitBranchCreateResult;
  };
  "git.branch.switch": {
    readonly input: GitBranchSwitchParams;
    readonly output: GitBranchSwitchResult;
  };
  "git.tag.create": { readonly input: GitTagCreateParams; readonly output: GitTagCreateResult };
  "git.tag.delete": { readonly input: GitTagDeleteParams; readonly output: GitTagDeleteResult };
  "git.tag.checkout": { readonly input: GitTagTargetParams; readonly output: GitTagMutationResult };
  "git.tag.push": { readonly input: GitTagTargetParams; readonly output: GitTagMutationResult };
  "git.tag.details": { readonly input: GitTagTargetParams; readonly output: GitTagDetails };
  "git.tag.apply_fetch": { readonly input: GitTagApplyFetchParams; readonly output: GitTagMutationResult };
  "git.branch.rename": { readonly input: GitBranchRenameParams; readonly output: null };
  "git.branch.delete": { readonly input: GitBranchDeleteParams; readonly output: null };
  "git.worktree.remove": { readonly input: GitWorktreeRemoveParams; readonly output: GitWorktreeRemoveResult };
  "git.stash.push": { readonly input: GitStashPushParams; readonly output: GitStashPushResult };
  "git.stash.pop": { readonly input: GitStashPopParams; readonly output: GitStashPopResult };
  "git.stash.push_selected": { readonly input: GitStashPushSelectedParams; readonly output: GitStashPushSelectedResult };
  "git.stash.apply": { readonly input: GitStashTargetParams; readonly output: GitStashMutationResult };
  "git.stash.pop_target": { readonly input: GitStashTargetParams; readonly output: GitStashMutationResult };
  "git.stash.drop": { readonly input: GitStashTargetParams; readonly output: GitStashMutationResult };
  "git.stash.branch": { readonly input: GitStashBranchParams; readonly output: GitStashMutationResult };
  "git.stash.files": { readonly input: GitStashTargetParams; readonly output: GitStashFilesResult };
  "git.stash.file_diff": { readonly input: GitStashFileDiffParams; readonly output: GitStashFileDiffResult };
}

/**
 * Every accepted method the client can name.
 *
 * The list is the source of truth on this side; the generated contract holds
 * the server's accepted list, and tests prove the two agree.
 * Availability is determined only by advertised server capabilities.
 */
export const WS_METHOD_NAMES = [
  "server.get_info",
  "server.get_status",
  "repositories.list",
  "repositories.open",
  "repositories.create",
  "repositories.remove",
  "repositories.get_snapshot",
  "repositories.get_graph",
  "repositories.refresh",
  "git.status",
  "git.commit_files",
  "git.commit_working_tree_files",
  "git.commit_working_tree_file_diff",
  "git.commit_file_diff",
  "git.working_tree_file_diff",
  "git.prefetch_commit_files",
  "git.prefetch_commit_diffs",
  "git.stage",
  "git.unstage",
  "git.commit",
  "git.hunk_preview",
  "git.apply_hunks",
  "git.discard_preview",
  "git.discard",
  "git.amend_info",
  "git.amend",
  "git.fetch",
  "git.pull",
  "git.push",
  "git.branch.list",
  "git.branch.create",
  "git.tag.create",
  "git.tag.delete",
  "git.tag.checkout",
  "git.tag.push",
  "git.tag.details",
  "git.tag.apply_fetch",
  "git.branch.switch",
  "git.branch.rename",
  "git.branch.delete",
  "git.worktree.remove",
  "git.stash.push",
  "git.stash.pop",
  ...STASH_FEATURE_METHOD_NAMES,
] as const satisfies ReadonlyArray<keyof GitGuiRpcMethods>;

export type GitGuiRpcMethod = (typeof WS_METHOD_NAMES)[number];

/**
 * The method table and the method list must describe the same methods.
 *
 * A method in the table that the list does not name, or a method the list
 * names that the table does not describe, is a compile error here.
 */
type AssertMethodsMatchNames = [Exclude<keyof GitGuiRpcMethods, GitGuiRpcMethod>] extends [never]
  ? [Exclude<GitGuiRpcMethod, keyof GitGuiRpcMethods>] extends [never]
    ? true
    : { readonly missing: Exclude<GitGuiRpcMethod, keyof GitGuiRpcMethods> }
  : { readonly extra: Exclude<keyof GitGuiRpcMethods, GitGuiRpcMethod> };

const methodsMatchNames: AssertMethodsMatchNames = true;
void methodsMatchNames;

/** The canonical method names, under a readable name for each one. */
export const WS_METHODS = {
  serverGetInfo: "server.get_info",
  serverGetStatus: "server.get_status",
  repositoriesList: "repositories.list",
  repositoriesOpen: "repositories.open",
  repositoriesCreate: "repositories.create",
  repositoriesRemove: "repositories.remove",
  repositoriesGetSnapshot: "repositories.get_snapshot",
  repositoriesGetGraph: "repositories.get_graph",
  repositoriesRefresh: "repositories.refresh",
  gitStatus: "git.status",
  gitCommitFiles: "git.commit_files",
  gitCommitWorkingTreeFiles: "git.commit_working_tree_files",
  gitCommitWorkingTreeFileDiff: "git.commit_working_tree_file_diff",
  gitCommitFileDiff: "git.commit_file_diff",
  gitWorkingTreeFileDiff: "git.working_tree_file_diff",
  gitPrefetchCommitFiles: "git.prefetch_commit_files",
  gitPrefetchCommitDiffs: "git.prefetch_commit_diffs",
  gitStage: "git.stage",
  gitUnstage: "git.unstage",
  gitCommit: "git.commit",
  gitHunkPreview: "git.hunk_preview",
  gitApplyHunks: "git.apply_hunks",
  gitDiscardPreview: "git.discard_preview",
  gitDiscard: "git.discard",
  gitAmendInfo: "git.amend_info",
  gitAmend: "git.amend",
  gitFetch: "git.fetch",
  gitPull: "git.pull",
  gitPush: "git.push",
  gitBranchList: "git.branch.list",
  gitBranchCreate: "git.branch.create",
  gitTagCreate: "git.tag.create",
  gitTagDelete: "git.tag.delete",
  gitTagCheckout: "git.tag.checkout",
  gitTagPush: "git.tag.push",
  gitTagDetails: "git.tag.details",
  gitTagApplyFetch: "git.tag.apply_fetch",
  gitBranchSwitch: "git.branch.switch",
  gitBranchRename: "git.branch.rename",
  gitBranchDelete: "git.branch.delete",
  gitWorktreeRemove: "git.worktree.remove",
  gitStashPush: "git.stash.push",
  gitStashPop: "git.stash.pop",
  gitStashPushSelected: "git.stash.push_selected",
  gitStashApply: "git.stash.apply",
  gitStashPopTarget: "git.stash.pop_target",
  gitStashDrop: "git.stash.drop",
  gitStashBranch: "git.stash.branch",
  gitStashFiles: "git.stash.files",
  gitStashFileDiff: "git.stash.file_diff",
} as const satisfies Record<string, GitGuiRpcMethod>;

/** Server-sent events the client subscribes to. */
export const WS_EVENTS = {
  repositoryChanged: "repository.changed",
} as const;

export type GitGuiRpcEvent = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];

/** A GitGui RPC request that the server rejected. */
export class GitGuiRpcError extends Schema.TaggedError<GitGuiRpcError>()("GitGuiRpcError", {
  code: Schema.String,
  message: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Unknown),
}) {}

/** One request the client is waiting for. */
export interface GitGuiRpcProtocolClient {
  /**
   * Sends one request over the session and waits for its response.
   *
   * The method, its payload, and its result are checked against the generated
   * contract, so a renamed or reshaped method is a compile error.
   */
  readonly call: <K extends GitGuiRpcMethod>(
    method: K,
    input: GitGuiRpcMethods[K]["input"],
  ) => Effect.Effect<GitGuiRpcMethods[K]["output"], GitGuiRpcError>;
  /** Server-sent events, in the order the server sent them. */
  readonly events: Stream.Stream<OrderedEventEnvelope, GitGuiRpcError>;
}
