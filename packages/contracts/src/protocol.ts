// This file is generated. Do not edit it by hand.
// Source: crates/gitgui-protocol/src/lib.rs
// Generate with: npm run protocol:generate

/** Any JSON value accepted by the GitGui wire protocol. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type RequestEnvelope = {
/**
 * Client-chosen identifier echoed by the response.
 */
id: string,
/**
 * Canonical method name.
 */
method: string,
/**
 * Method-specific parameters. An omitted `params` field is treated as `{}`.
 */
params: JsonValue, };

export type ProtocolError = {
/**
 * Stable machine-readable error code.
 */
code: string,
/**
 * Safe human-readable explanation.
 */
message: string,
/**
 * Optional structured context. This must never contain secrets.
 */
details?: JsonValue | null, };

export type ResponseSuccessEnvelope = {
/**
 * Envelope discriminator.
 */
type: "response",
/**
 * Identifier from the corresponding request.
 */
id: string,
/**
 * Successful response discriminator.
 */
ok: true,
/**
 * Method result payload.
 */
result: JsonValue, };

export type ResponseErrorEnvelope = {
/**
 * Envelope discriminator.
 */
type: "response",
/**
 * Identifier from the corresponding request.
 */
id: string,
/**
 * Error response discriminator.
 */
ok: false,
/**
 * Structured protocol error.
 */
error: ProtocolError, };

export type ResponseEnvelope = ResponseSuccessEnvelope | ResponseErrorEnvelope;

export type WelcomePayload = {
/**
 * Deprecated compatibility alias for `environment_id`.
 */
server_id: string,
/**
 * Stable identity persisted by the backend environment.
 */
environment_id: string,
/**
 * Public protocol version understood by this server.
 */
protocol_version: number,
/**
 * Server capabilities available to the client.
 */
capabilities: Array<string>, };

export type WelcomeMessage = {
/**
 * Envelope discriminator.
 */
type: "welcome",
/**
 * Deprecated compatibility alias for `environment_id`.
 */
server_id: string,
/**
 * Stable identity persisted by the backend environment.
 */
environment_id: string,
/**
 * Public protocol version understood by this server.
 */
protocol_version: number,
/**
 * Server capabilities available to the client.
 */
capabilities: Array<string>, };

export type OrderedEventEnvelope = {
/**
 * Envelope discriminator.
 */
type: "event",
/**
 * Monotonic event sequence number.
 */
sequence: number,
/**
 * Canonical event name.
 */
event: string,
/**
 * Event-specific payload.
 */
payload: JsonValue, };

export type ServerLifecycle = "starting" | "ready" | "stopping" | "stopped" | "failed";

export type ServerInfo = {
/**
 * Deprecated compatibility alias for `environment_id`.
 */
server_id: string,
/**
 * Stable identity of the backend environment.
 */
environment_id: string,
/**
 * Public protocol version.
 */
protocol_version: number,
/**
 * GitGui server package version.
 */
server_version: string,
/**
 * Address selected by the server after binding, including an ephemeral port.
 */
bind_address: string,
/**
 * Methods and features understood by this server.
 */
capabilities: Array<string>, };

export type ServerReadiness = {
/**
 * Whether a client may begin a session.
 */
ready: boolean,
/**
 * Current lifecycle state.
 */
lifecycle: ServerLifecycle,
/**
 * Server identity for correlating readiness with a process.
 */
server_id: string,
/**
 * Stable backend environment identity.
 */
environment_id: string,
/**
 * Protocol version exposed by the server.
 */
protocol_version: number, };

export type ServerStatus = {
/**
 * Current lifecycle state.
 */
lifecycle: ServerLifecycle,
/**
 * Whether the server is currently ready.
 */
ready: boolean,
/**
 * Stable server identity.
 */
server_id: string,
/**
 * Stable backend environment identity.
 */
environment_id: string,
/**
 * Public protocol version.
 */
protocol_version: number,
/**
 * Whole seconds since the server entered its running state.
 */
uptime_seconds: number, };

export type AdvertisedEndpoint = {
/**
 * Stable provider-specific key; unlike the URL this may survive network changes.
 */
key: string,
/**
 * HTTP base URL used for discovery, authentication, and other HTTP APIs.
 */
httpUrl: string,
/**
 * WebSocket base URL used for the GitGui RPC session.
 */
websocketUrl: string,
/**
 * Whether the server recommends this route when it is reachable.
 */
isDefault: boolean,
/**
 * Reachability hint such as `loopback`, `lan`, `private`, `public`, or `tunnel`.
 */
reachability: string, };

export type EnvironmentAuthPolicy = {
/**
 * Whether an authenticated session is required for WebSocket RPC.
 */
required: boolean,
/**
 * Supported bootstrap/pairing exchange mechanisms.
 */
bootstrapMethods: Array<string>,
/**
 * Supported authenticated session mechanisms.
 */
sessionMethods: Array<string>, };

export type EnvironmentDescriptor = {
/**
 * Descriptor schema version, independent of the RPC protocol version.
 */
schemaVersion: number,
/**
 * Stable identity persisted in the backend state directory.
 */
environmentId: string,
/**
 * User-facing default label for this environment.
 */
label: string,
/**
 * GitGui server package version.
 */
serverVersion: string,
/**
 * Public RPC protocol version.
 */
protocolVersion: number,
/**
 * Server operating-system family.
 */
platform: string,
/**
 * Server CPU architecture.
 */
architecture: string,
/**
 * Available protocol methods and server features.
 */
capabilities: Array<string>,
/**
 * Authentication policy for this server.
 */
auth: EnvironmentAuthPolicy,
/**
 * Candidate routes authored by this server or its desktop host.
 */
endpoints: Array<AdvertisedEndpoint>, };

export type TokenExchangeResponse = { access_token: string, issued_token_type: string, token_type: string, expires_in: number, scope: string, };

export type AuthSession = { sessionId: string, environmentId: string, scopes: Array<string>, expiresAtUnixMs: number, };

export type WebSocketTicketResponse = { ticket: string, expiresIn: number, };

export type PairingCredentialResponse = { credential: string, expiresIn: number, scopes: Array<string>, };

export type RepositorySummary = {
/**
 * Stable host-local repository identifier.
 */
id: string,
/**
 * Display name of the main repository, shared by its linked worktrees.
 */
name: string,
/**
 * Canonical path used to perform operations.
 */
path: string,
/**
 * Canonical Git repository root.
 */
root: string,
/**
 * Whether this entry is a linked Git worktree rather than the main worktree.
 */
isWorktree: boolean, };

export type RepositoriesListResult = {
/**
 * Configured repositories. This is empty when the host has no entries.
 */
repositories: Array<RepositorySummary>, };

export type RepositoriesOpenParams = {
/**
 * Path on the server host to resolve as a Git repository.
 */
path: string, };

export type RepositoriesOpenResult = {
/**
 * Server-owned repository catalog entry.
 */
repository: RepositorySummary,
/**
 * Fresh snapshot computed for the calling client.
 */
snapshot: RepositorySnapshot, };

export type RepositoriesCreateParams = {
/**
 * Existing directory on the server host where the repository folder is created.
 */
parentPath: string,
/**
 * Single folder name for the new repository.
 */
name: string,
/**
 * Optional initial branch name. Git's configured default is used when omitted.
 */
initialBranch?: string | null,
/**
 * Whether to configure Git LFS hooks and filters in the new repository.
 */
initializeLfs: boolean, };

export type RepositoriesCreateResult = {
/**
 * Server-owned repository catalog entry.
 */
repository: RepositorySummary,
/**
 * Fresh snapshot computed for the new repository.
 */
snapshot: RepositorySnapshot, };

export type RepositoriesRemoveParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string, };

export type RepositoriesRemoveResult = {
/**
 * Stable ID removed from the host's configured repository catalog.
 */
repositoryId: string, };

export type RepositorySnapshotParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string, };

export type RepositorySnapshotResult = {
/**
 * Server-owned repository catalog entry.
 */
repository: RepositorySummary,
/**
 * Fresh repository snapshot.
 */
snapshot: RepositorySnapshot, };

export type RepositoryGraphParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string,
/**
 * Commit IDs whose ancestors should be included in the graph.
 */
targetCommits: Array<string>, };

export type RepositoryGraphResult = {
/**
 * Server-owned repository catalog entry.
 */
repository: RepositorySummary,
/**
 * Commits reachable from the requested targets.
 */
commits: Array<CommitInfo>,
/**
 * Graph layout for the returned commits.
 */
graph: CommitGraph, };

export type RepositoriesRefreshParams = {
/**
 * Stable IDs from the host's configured repository catalog.
 */
repositoryIds: Array<string>, };

export type RepositoryRefreshItem = {
/**
 * Stable ID requested by the client.
 */
repositoryId: string,
/**
 * Repository catalog entry on success.
 */
repository?: RepositorySummary,
/**
 * Fresh snapshot on success.
 */
snapshot?: RepositorySnapshot,
/**
 * Per-repository failure on error.
 */
error?: ProtocolError, };

export type RepositoriesRefreshResult = {
/**
 * One independent success or failure item per requested repository ID.
 */
repositories: Array<RepositoryRefreshItem>, };

export type GitStatusParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string, };

export type ChangedFile = { path: string, originalPath: string | null, indexStatus: string, worktreeStatus: string, };

export type RepositoryStatus = { currentBranch: string | null, headOid: string | null, ahead: number, behind: number, changedFiles: Array<ChangedFile>, };

export type GitStatusResult = { repository: RepositorySummary, status: RepositoryStatus, };

export type GitPathsParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string,
/**
 * Repository-relative paths. An empty list means all working-tree paths.
 */
paths: Array<string>, };

export type GitStageResult = { repository: RepositorySummary, snapshot: RepositorySnapshot, };

export type GitUnstageResult = { repository: RepositorySummary, snapshot: RepositorySnapshot, };

export type GitCommitParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string,
/**
 * The commit title or summary line.
 */
summary: string,
/**
 * Optional commit description following the summary line.
 */
description?: string, };

export type GitCommitResult = { repository: RepositorySummary, snapshot: RepositorySnapshot,
/**
 * Object ID of the newly created commit.
 */
commitHash: string, };

export type GitHunk = { id: number, header: string, patch: string, };

export type GitHunkPreviewParams = { repositoryId: string, filePath: string, staged: boolean, };

export type GitHunkPreview = { filePath: string, staged: boolean, revision: string,
/**
 * Display-only patch. Mutations accept IDs, never client-supplied patches.
 */
patch: string, hunks: Array<GitHunk>, unavailableReason: string | null, };

export type GitApplyHunksParams = { repositoryId: string, filePath: string, staged: boolean, revision: string, hunkIds: Array<number>, };

export type GitDiscardFile = { path: string, untracked: boolean, revision: string, };

export type GitDiscardParams = { repositoryId: string,
/**
 * Explicit targets from the confirmation preview; empty never means all.
 */
files: Array<GitDiscardFile>, deleteUntracked: boolean, };

export type GitDiscardResult = { completedPaths: Array<string>, remainingPaths: Array<string>, error: string | null, };

export type GitAmendInfo = { headOid: string | null, summary: string, description: string, blockedReason: string | null, };

export type GitAmendParams = { repositoryId: string, expectedHead: string, summary: string, description?: string, };

export type GitRepositoryParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string, };

export type GitFetchResult = { repository: RepositorySummary, snapshot: RepositorySnapshot, };

export type GitPullResult = { repository: RepositorySummary, snapshot: RepositorySnapshot, };

export type GitPushResult = { repository: RepositorySummary, snapshot: RepositorySnapshot, };

export type GitBranchListParams = { repositoryId: string, };

export type GitBranch = { name: string, current: boolean, };

export type GitBranchListResult = { repository: RepositorySummary, branches: Array<GitBranch>, snapshot: RepositorySnapshot, };

export type GitBranchCreateParams = { repositoryId: string,
/**
 * New local branch name.
 */
name: string,
/**
 * Optional starting ref or object ID. Defaults to the current HEAD.
 */
startPoint?: string,
/**
 * Whether to switch to the new branch after creating it.
 */
checkout: boolean, };

export type GitBranchCreateResult = { repository: RepositorySummary, snapshot: RepositorySnapshot, };

export type GitBranchSwitchParams = { repositoryId: string, name: string,
/**
 * Attempt to carry local changes across the branch switch.
 */
merge: boolean, };

export type GitBranchSwitchResult = { repository: RepositorySummary, snapshot: RepositorySnapshot, };

export type GitStashPushParams = { repositoryId: string,
/**
 * Optional stash message.
 */
message?: string,
/**
 * Include untracked files in the stash. Defaults to true.
 */
includeUntracked: boolean, };

export type GitStashPushResult = { repository: RepositorySummary, snapshot: RepositorySnapshot, };

export type GitStashPopParams = { repositoryId: string, };

export type GitStashPopResult = { repository: RepositorySummary, snapshot: RepositorySnapshot, };

export type CommitFilesParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string,
/**
 * Commit object ID to inspect.
 */
commitHash: string, };

export type CommitFilesResult = {
/**
 * Files changed by the requested commit.
 */
files: Array<CommitFile>, };

export type CommitFileDiffParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string,
/**
 * Commit object ID to inspect.
 */
commitHash: string,
/**
 * Optional explicit parent; the server may otherwise use the first parent.
 */
parentHash?: string,
/**
 * Repository-relative path to inspect.
 */
filePath: string, };

export type WorkingTreeFileDiffParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string,
/**
 * Optional head object ID used as the comparison base.
 */
headHash?: string,
/**
 * Repository-relative path to inspect.
 */
filePath: string,
/**
 * When true, compare HEAD with the index; otherwise compare the index with the working tree.
 */
staged: boolean, };

export type FileDiffResult = {
/**
 * Structured file diff payload.
 */
diff: CommitFileDiff, };

export type PrefetchCommitFilesParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string,
/**
 * Commit IDs to prefetch; servers must enforce `MAX_PREFETCH_COMMIT_HASHES`.
 */
commitHashes: Array<string>, };

export type PrefetchCommitFilesResult = {
/**
 * Whether the server accepted the hint for processing.
 */
accepted: boolean,
/**
 * Number of commit hashes accepted by the server.
 */
count: number, };

export type PrefetchCommitDiffTarget = {
/**
 * Commit object ID to inspect.
 */
commitHash: string,
/**
 * Optional explicit parent; the server may otherwise use the first parent.
 */
parentHash?: string,
/**
 * Repository-relative path to prefetch.
 */
filePath: string, };

export type PrefetchCommitDiffsParams = {
/**
 * Stable ID from the host's configured repository catalog.
 */
repositoryId: string,
/**
 * Typed diff targets; servers must enforce `MAX_PREFETCH_COMMIT_DIFF_TARGETS`.
 */
targets: Array<PrefetchCommitDiffTarget>, };

export type PrefetchCommitDiffsResult = {
/**
 * Whether the server accepted the hint for processing.
 */
accepted: boolean,
/**
 * Number of targets accepted by the server.
 */
count: number, };

export type RepositoryInfo = {
/**
 * Path originally used to resolve the repository.
 */
path: string,
/**
 * Canonical Git repository root.
 */
root: string, };

export type RepositorySnapshot = {
/**
 * Path and canonical-root metadata.
 */
info: RepositoryInfo,
/**
 * Current working-tree status.
 */
status: RepositoryStatus,
/**
 * Commits included in the snapshot.
 */
commits: Array<CommitInfo>,
/**
 * Renderable commit graph.
 */
graph: CommitGraph,
/**
 * Local branches, remote branches, and tags.
 */
refs: Array<CommitRef>,
/**
 * Local stash metadata for commits included in the history graph.
 */
stashes: Array<StashInfo>,
/**
 * Git worktrees attached to this repository.
 */
worktrees: Array<WorktreeInfo>, };

export type CommitInfo = { hash: string, parents: Array<string>, author: string, timestamp: number, message: string, };

export type StashInfo = {
/**
 * Commit object referenced by the stash reflog.
 */
hash: string,
/**
 * Reflog selector such as `stash@{0}`.
 */
selector: string,
/**
 * The `HEAD` commit when the stash was created.
 */
baseHash: string,
/**
 * The optional index commit created as the stash's second parent.
 */
indexHash: string | null,
/**
 * Branch name recorded in the stash subject, when available.
 */
branch: string | null,
/**
 * User-facing stash message without Git's generated branch prefix.
 */
message: string,
/**
 * Unix timestamp of the stash entry.
 */
timestamp: number, };

export type WorktreeInfo = {
/**
 * Filesystem path used to open this worktree.
 */
path: string,
/**
 * Commit currently checked out in this worktree.
 */
headOid: string | null,
/**
 * Local branch checked out in this worktree, if any.
 */
branch: string | null,
/**
 * Whether this is the worktree represented by the current snapshot.
 */
current: boolean, };

export type CommitGraph = { commits: Array<GraphCommit>, edges: Array<GraphEdge>, width: number, headLane: number | null, };

export type GraphCommit = { hash: string, row: number, lane: number, };

export type GraphEdge = { from: string, to: string, edgeType: GraphEdgeType, };

export type GraphEdgeType = "normal" | "merge";

export type CommitRef = { name: string, shortName: string, target: string, refType: CommitRefType, };

export type CommitRefType = "localBranch" | "remoteBranch" | "tag";

export type CommitFile = { path: string, originalPath: string | null, status: string, };

export type CommitFileDiff = { originalPath: string | null, modifiedPath: string, originalContent: string, modifiedContent: string, isBinary: boolean, message: string | null, };

export type ProtocolErrorMessage = {
/**
 * Envelope discriminator.
 */
type: "protocol_error",
/**
 * Structured protocol error.
 */
error: ProtocolError, };

