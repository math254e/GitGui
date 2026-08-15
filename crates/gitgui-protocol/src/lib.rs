//! Browser-friendly JSON wire contracts shared by GitGui clients and servers.
//!
//! Server messages use an explicit top-level `type` field (`welcome`, `response`,
//! or `event`) so a browser client can discriminate messages without knowing
//! implementation details. Requests use their stable `id`, `method`, and
//! `params` fields and do not need a separate enum tag. Event messages use the
//! `event` field for the event name because the top-level `type` is reserved for
//! the envelope kind.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Version of the public JSON protocol.
pub const PROTOCOL_VERSION: u32 = 1;

/// Canonical method for retrieving immutable server metadata.
pub const METHOD_SERVER_GET_INFO: &str = "server.get_info";
/// Canonical method for retrieving current server lifecycle status.
pub const METHOD_SERVER_GET_STATUS: &str = "server.get_status";
/// Canonical method for repository catalog reads.
pub const METHOD_REPOSITORIES_LIST: &str = "repositories.list";
/// Canonical host-admin method for registering and loading a repository.
pub const METHOD_REPOSITORIES_OPEN: &str = "repositories.open";
/// Canonical method for loading a complete repository snapshot.
pub const METHOD_REPOSITORIES_GET_SNAPSHOT: &str = "repositories.get_snapshot";
/// Canonical method for refreshing multiple repository snapshots.
pub const METHOD_REPOSITORIES_REFRESH: &str = "repositories.refresh";
/// Canonical method for repository working-tree status reads.
pub const METHOD_VCS_STATUS: &str = "vcs.status";
/// Canonical method for listing the files changed by a commit.
pub const METHOD_VCS_COMMIT_FILES: &str = "vcs.commit_files";
/// Canonical method for reading one committed file diff.
pub const METHOD_VCS_COMMIT_FILE_DIFF: &str = "vcs.commit_file_diff";
/// Canonical method for reading one working-tree file diff.
pub const METHOD_VCS_WORKING_TREE_FILE_DIFF: &str = "vcs.working_tree_file_diff";
/// Canonical performance hint for prefetching commit file lists.
pub const METHOD_VCS_PREFETCH_COMMIT_FILES: &str = "vcs.prefetch_commit_files";
/// Canonical performance hint for prefetching commit file diffs.
pub const METHOD_VCS_PREFETCH_COMMIT_DIFFS: &str = "vcs.prefetch_commit_diffs";

/// Maximum number of commit hashes accepted by one commit-file prefetch hint.
pub const MAX_PREFETCH_COMMIT_HASHES: usize = 256;
/// Maximum number of typed diff targets accepted by one diff prefetch hint.
pub const MAX_PREFETCH_COMMIT_DIFF_TARGETS: usize = 256;

/// Capability advertised when `server.get_info` is available.
pub const CAPABILITY_SERVER_INFO: &str = "server.info";
/// Capability advertised when `server.get_status` is available.
pub const CAPABILITY_SERVER_STATUS: &str = "server.status";
/// Capability advertised when the repository catalog implementation is available.
pub const CAPABILITY_REPOSITORIES_LIST: &str = "repositories.list";
/// Capability advertised when host-admin repository registration is available.
pub const CAPABILITY_REPOSITORIES_OPEN: &str = "repositories.open";
/// Capability advertised when complete repository snapshots are available.
pub const CAPABILITY_REPOSITORIES_GET_SNAPSHOT: &str = "repositories.get_snapshot";
/// Capability advertised when batch repository refresh is available.
pub const CAPABILITY_REPOSITORIES_REFRESH: &str = "repositories.refresh";
/// Capability advertised when Git status is available.
pub const CAPABILITY_VCS_STATUS: &str = "vcs.status";
/// Capability advertised when commit file listing is available.
pub const CAPABILITY_VCS_COMMIT_FILES: &str = "vcs.commit_files";
/// Capability advertised when committed file diffs are available.
pub const CAPABILITY_VCS_COMMIT_FILE_DIFF: &str = "vcs.commit_file_diff";
/// Capability advertised when working-tree file diffs are available.
pub const CAPABILITY_VCS_WORKING_TREE_FILE_DIFF: &str = "vcs.working_tree_file_diff";
/// Capability advertised when commit-file prefetch hints are available.
pub const CAPABILITY_VCS_PREFETCH_COMMIT_FILES: &str = "vcs.prefetch_commit_files";
/// Capability advertised when commit-diff prefetch hints are available.
pub const CAPABILITY_VCS_PREFETCH_COMMIT_DIFFS: &str = "vcs.prefetch_commit_diffs";

/// Machine-readable protocol error codes.
pub mod error_codes {
    /// The incoming WebSocket message was not a valid request envelope.
    pub const INVALID_REQUEST: &str = "invalid_request";
    /// The request method is not in the canonical method registry.
    pub const METHOD_NOT_FOUND: &str = "method_not_found";
    /// The method is declared but not implemented by this server version.
    pub const NOT_IMPLEMENTED: &str = "not_implemented";
    /// Method parameters failed validation.
    pub const INVALID_PARAMS: &str = "invalid_params";
    /// The requested repository ID is not configured on this host.
    pub const REPOSITORY_NOT_CONFIGURED: &str = "repository_not_configured";
    /// A configured repository path could not be found or resolved as a repository.
    pub const REPOSITORY_NOT_FOUND: &str = "repository_not_found";
    /// A Git operation failed after request and repository validation succeeded.
    pub const GIT_OPERATION_FAILED: &str = "git_operation_failed";
    /// An internal server failure occurred while handling a request.
    pub const INTERNAL: &str = "internal_error";
}

/// Client request identifier used to correlate responses.
pub type RequestId = String;

/// A client-to-server JSON request.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct RequestEnvelope {
    /// Client-chosen identifier echoed by the response.
    pub id: RequestId,
    /// Canonical method name.
    pub method: String,
    /// Method-specific parameters. An omitted `params` field is treated as `{}`.
    #[serde(default = "empty_object")]
    pub params: Value,
}

impl RequestEnvelope {
    /// Returns whether the request has a usable non-empty identifier.
    pub fn has_valid_id(&self) -> bool {
        !self.id.trim().is_empty()
    }
}

/// A structured error returned on the wire.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct ProtocolError {
    /// Stable machine-readable error code.
    pub code: String,
    /// Safe human-readable explanation.
    pub message: String,
    /// Optional structured context. This must never contain secrets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl ProtocolError {
    /// Creates an error without additional context.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    /// Creates an error with JSON context safe for clients to inspect.
    pub fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details),
        }
    }
}

/// Successful response envelope.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct ResponseSuccessEnvelope {
    /// Envelope discriminator.
    #[serde(rename = "type")]
    #[ts(type = "\"response\"")]
    pub message_type: String,
    /// Identifier from the corresponding request.
    pub id: RequestId,
    /// Successful response discriminator.
    #[ts(type = "true")]
    pub ok: bool,
    /// Method result payload.
    pub result: Value,
}

/// Error response envelope.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct ResponseErrorEnvelope {
    /// Envelope discriminator.
    #[serde(rename = "type")]
    #[ts(type = "\"response\"")]
    pub message_type: String,
    /// Identifier from the corresponding request.
    pub id: RequestId,
    /// Error response discriminator.
    #[ts(type = "false")]
    pub ok: bool,
    /// Structured protocol error.
    pub error: ProtocolError,
}

/// A response is intentionally an untagged Rust enum: its concrete struct
/// carries the browser-visible `type` and `ok` fields, avoiding nested JSON.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(untagged)]
pub enum ResponseEnvelope {
    /// Successful method response.
    Success(ResponseSuccessEnvelope),
    /// Failed method response.
    Error(ResponseErrorEnvelope),
}

impl ResponseEnvelope {
    /// Creates a successful response and serializes its result as JSON.
    pub fn success(id: RequestId, result: impl Serialize) -> Result<Self, serde_json::Error> {
        Ok(Self::Success(ResponseSuccessEnvelope {
            message_type: "response".to_string(),
            id,
            ok: true,
            result: serde_json::to_value(result)?,
        }))
    }

    /// Creates an error response for a request identifier.
    pub fn error(id: RequestId, error: ProtocolError) -> Self {
        Self::Error(ResponseErrorEnvelope {
            message_type: "response".to_string(),
            id,
            ok: false,
            error,
        })
    }
}

/// Welcome payload sent immediately after a WebSocket connection is accepted.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct WelcomePayload {
    /// Stable identity of the running server process.
    pub server_id: String,
    /// Public protocol version understood by this server.
    pub protocol_version: u32,
    /// Server capabilities available to the client.
    pub capabilities: Vec<String>,
}

/// Welcome message containing the connection handshake payload.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct WelcomeMessage {
    /// Envelope discriminator.
    #[serde(rename = "type")]
    #[ts(type = "\"welcome\"")]
    pub message_type: String,
    /// Handshake data.
    #[serde(flatten)]
    pub payload: WelcomePayload,
}

impl WelcomeMessage {
    /// Builds a welcome message for a server instance.
    pub fn new(
        server_id: impl Into<String>,
        protocol_version: u32,
        capabilities: Vec<String>,
    ) -> Self {
        Self {
            message_type: "welcome".to_string(),
            payload: WelcomePayload {
                server_id: server_id.into(),
                protocol_version,
                capabilities,
            },
        }
    }
}

/// An ordered server push message. `sequence` is monotonic for the server
/// process, while `event` identifies the event payload schema.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct OrderedEventEnvelope {
    /// Envelope discriminator.
    #[serde(rename = "type")]
    #[ts(type = "\"event\"")]
    pub message_type: String,
    /// Monotonic event sequence number.
    pub sequence: u64,
    /// Canonical event name.
    pub event: String,
    /// Event-specific payload.
    pub payload: Value,
}

impl OrderedEventEnvelope {
    /// Creates an event envelope with the browser-visible event discriminator.
    pub fn new(sequence: u64, event: impl Into<String>, payload: Value) -> Self {
        Self {
            message_type: "event".to_string(),
            sequence,
            event: event.into(),
            payload,
        }
    }
}

/// Lifecycle state of a GitGui server process.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ServerLifecycle {
    /// The process is starting and is not ready for clients.
    Starting,
    /// HTTP and WebSocket routes are ready.
    Ready,
    /// Graceful shutdown has begun.
    Stopping,
    /// The process has stopped serving.
    Stopped,
    /// Startup or runtime failed.
    Failed,
}

/// Immutable server metadata returned by `/info` and `server.get_info`.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct ServerInfo {
    /// Stable identity of this server process.
    pub server_id: String,
    /// Public protocol version.
    pub protocol_version: u32,
    /// GitGui server package version.
    pub server_version: String,
    /// Address selected by the server after binding, including an ephemeral port.
    pub bind_address: String,
    /// Methods and features understood by this server.
    pub capabilities: Vec<String>,
}

/// Current readiness and lifecycle state returned by `/ready`.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct ServerReadiness {
    /// Whether a client may begin a session.
    pub ready: bool,
    /// Current lifecycle state.
    pub lifecycle: ServerLifecycle,
    /// Server identity for correlating readiness with a process.
    pub server_id: String,
    /// Protocol version exposed by the server.
    pub protocol_version: u32,
}

/// Current status returned by `server.get_status`.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct ServerStatus {
    /// Current lifecycle state.
    pub lifecycle: ServerLifecycle,
    /// Whether the server is currently ready.
    pub ready: bool,
    /// Stable server identity.
    pub server_id: String,
    /// Public protocol version.
    pub protocol_version: u32,
    /// Whole seconds since the server entered its running state.
    pub uptime_seconds: u64,
}

/// A configured repository as exposed to a client.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySummary {
    /// Stable host-local repository identifier.
    pub id: String,
    /// Canonical path used to perform operations.
    pub path: String,
    /// Canonical Git repository root.
    pub root: String,
}

/// Result of listing the repositories explicitly configured on a host.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesListResult {
    /// Configured repositories. This is empty when the host has no entries.
    pub repositories: Vec<RepositorySummary>,
}

/// Parameters for the host-admin repository registration and initial load.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesOpenParams {
    /// Path on the server host to resolve as a Git repository.
    pub path: String,
}

/// Result returned after a repository is registered and its initial snapshot is loaded.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesOpenResult {
    /// Server-owned repository catalog entry.
    pub repository: RepositorySummary,
    /// Fresh snapshot computed for the calling client.
    pub snapshot: RepositorySnapshot,
}

/// Parameters for loading a complete snapshot by server-issued repository ID.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshotParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
}

/// Result returned when a complete repository snapshot is requested.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshotResult {
    /// Server-owned repository catalog entry.
    pub repository: RepositorySummary,
    /// Fresh repository snapshot.
    pub snapshot: RepositorySnapshot,
}

/// Parameters for refreshing the requested repositories as one batch.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesRefreshParams {
    /// Stable IDs from the host's configured repository catalog.
    pub repository_ids: Vec<String>,
}

/// One repository's independent result in a refresh batch.
///
/// A successful item contains `repository` and `snapshot`; a failed item
/// contains `error`. The unused alternatives are omitted from serialized JSON
/// so clients can distinguish the two cases without relying on null values.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRefreshItem {
    /// Stable ID requested by the client.
    pub repository_id: String,
    /// Repository catalog entry on success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository: Option<RepositorySummary>,
    /// Fresh snapshot on success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snapshot: Option<RepositorySnapshot>,
    /// Per-repository failure on error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<ProtocolError>,
}

/// Result of a batch refresh. Individual repository failures do not fail the batch.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesRefreshResult {
    /// One independent success or failure item per requested repository ID.
    pub repositories: Vec<RepositoryRefreshItem>,
}

/// Parameters for a working-tree status request.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VcsStatusParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
}

/// A changed working-tree path in a status result.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
}

/// Working-tree status DTO returned by the public protocol.
#[derive(Clone, Debug, Deserialize, Serialize, Default, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    pub current_branch: Option<String>,
    pub head_oid: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changed_files: Vec<ChangedFile>,
}

/// Result of reading one configured repository's working-tree status.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VcsStatusResult {
    pub repository: RepositorySummary,
    pub status: RepositoryStatus,
}

/// Parameters for listing files changed by one commit.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitFilesParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
    /// Commit object ID to inspect.
    pub commit_hash: String,
}

/// Result of listing files changed by one commit.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitFilesResult {
    /// Files changed by the requested commit.
    pub files: Vec<CommitFile>,
}

/// Parameters for reading one file's committed diff.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileDiffParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
    /// Commit object ID to inspect.
    pub commit_hash: String,
    /// Optional explicit parent; the server may otherwise use the first parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_hash: Option<String>,
    /// Repository-relative path to inspect.
    pub file_path: String,
}

/// Parameters for reading one file's working-tree diff.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeFileDiffParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
    /// Optional head object ID used as the comparison base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub head_hash: Option<String>,
    /// Repository-relative path to inspect.
    pub file_path: String,
}

/// Result shared by committed and working-tree file-diff methods.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffResult {
    /// Structured file diff payload.
    pub diff: CommitFileDiff,
}

/// Parameters for the commit-file-list performance hint.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchCommitFilesParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
    /// Commit IDs to prefetch; servers must enforce `MAX_PREFETCH_COMMIT_HASHES`.
    pub commit_hashes: Vec<String>,
}

/// Result of accepting or declining a commit-file-list prefetch hint.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchCommitFilesResult {
    /// Whether the server accepted the hint for processing.
    pub accepted: bool,
    /// Number of commit hashes accepted by the server.
    pub count: u32,
}

/// One typed target in a commit-diff prefetch hint.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchCommitDiffTarget {
    /// Commit object ID to inspect.
    pub commit_hash: String,
    /// Optional explicit parent; the server may otherwise use the first parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_hash: Option<String>,
    /// Repository-relative path to prefetch.
    pub file_path: String,
}

/// Parameters for the commit-diff performance hint.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchCommitDiffsParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
    /// Typed diff targets; servers must enforce `MAX_PREFETCH_COMMIT_DIFF_TARGETS`.
    pub targets: Vec<PrefetchCommitDiffTarget>,
}

/// Result of accepting or declining a commit-diff prefetch hint.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchCommitDiffsResult {
    /// Whether the server accepted the hint for processing.
    pub accepted: bool,
    /// Number of targets accepted by the server.
    pub count: u32,
}

/// Repository path information included in a complete snapshot.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    /// Path originally used to resolve the repository.
    pub path: String,
    /// Canonical Git repository root.
    pub root: String,
}

/// One complete browser-facing repository snapshot.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    /// Path and canonical-root metadata.
    pub info: RepositoryInfo,
    /// Current working-tree status.
    pub status: RepositoryStatus,
    /// Commits included in the snapshot.
    pub commits: Vec<CommitInfo>,
    /// Renderable commit graph.
    pub graph: CommitGraph,
    /// Local branches, remote branches, and tags.
    pub refs: Vec<CommitRef>,
}

/// Commit metadata included in a repository snapshot.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub timestamp: i64,
    pub message: String,
}

/// Layout and connections for the rendered commit graph.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraph {
    pub commits: Vec<GraphCommit>,
    pub edges: Vec<GraphEdge>,
    pub width: usize,
    pub head_lane: Option<usize>,
}

/// One commit's graph position.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub hash: String,
    pub row: usize,
    pub lane: usize,
}

/// One parent connection in the commit graph.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub edge_type: GraphEdgeType,
}

/// Wire discriminator for commit graph edge styling.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub enum GraphEdgeType {
    Normal,
    Merge,
}

/// One branch or tag reference included in a snapshot.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    pub name: String,
    pub short_name: String,
    pub target: String,
    pub ref_type: CommitRefType,
}

/// Wire discriminator for reference categories.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub enum CommitRefType {
    LocalBranch,
    RemoteBranch,
    Tag,
}

/// One file changed by a commit.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
}

/// Structured text or binary diff for one file.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileDiff {
    pub original_path: Option<String>,
    pub modified_path: String,
    pub original_content: String,
    pub modified_content: String,
    pub is_binary: bool,
    pub message: Option<String>,
}

/// Error-only message used when an incoming frame has no usable request ID.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct ProtocolErrorMessage {
    /// Envelope discriminator.
    #[serde(rename = "type")]
    #[ts(type = "\"protocol_error\"")]
    pub message_type: String,
    /// Structured protocol error.
    pub error: ProtocolError,
}

impl ProtocolErrorMessage {
    /// Creates a top-level protocol error message.
    pub fn new(error: ProtocolError) -> Self {
        Self {
            message_type: "protocol_error".to_string(),
            error,
        }
    }
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}
