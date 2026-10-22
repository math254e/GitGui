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
pub const PROTOCOL_VERSION: u32 = 2;

/// Optional support for session-scoped cancellation of read requests.
pub const CAPABILITY_RPC_CANCEL: &str = "rpc.cancel";

/// Best-effort read cancellation notification, with no response of its own.
/// Servers answer the original request with `request_cancelled`. Started
/// blocking work may finish; mutations cannot be cancelled.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(tag = "type")]
pub enum CancelRequest {
    /// Cancel a read with this request ID on the current socket only.
    #[serde(rename = "cancel")]
    Cancel {
        /// Identifier of the original request.
        id: String,
    },
}

/// Read repository catalogs, snapshots, status, history, and diffs.
pub const SCOPE_REPOSITORY_READ: &str = "repository:read";
/// Run Git operations that change repository state.
pub const SCOPE_REPOSITORY_OPERATE: &str = "repository:operate";
/// Add, create, and remove repositories from the host catalog.
pub const SCOPE_REPOSITORY_MANAGE: &str = "repository:manage";
/// Inspect the current authorized client session.
pub const SCOPE_ACCESS_READ: &str = "access:read";
/// Issue pairing credentials and revoke client access.
pub const SCOPE_ACCESS_WRITE: &str = "access:write";

/// All scopes granted by the desktop bootstrap credential.
pub const ADMIN_SCOPES: &[&str] = &[
    SCOPE_REPOSITORY_READ,
    SCOPE_REPOSITORY_OPERATE,
    SCOPE_REPOSITORY_MANAGE,
    SCOPE_ACCESS_READ,
    SCOPE_ACCESS_WRITE,
];

/// Scopes granted by an ordinary pairing credential.
pub const CLIENT_SCOPES: &[&str] = &[SCOPE_REPOSITORY_READ, SCOPE_REPOSITORY_OPERATE];

/// Canonical method for retrieving immutable server metadata.
pub const METHOD_SERVER_GET_INFO: &str = "server.get_info";
/// Canonical method for retrieving current server lifecycle status.
pub const METHOD_SERVER_GET_STATUS: &str = "server.get_status";
/// Canonical method for repository catalog reads.
pub const METHOD_REPOSITORIES_LIST: &str = "repositories.list";
/// Canonical host-admin method for registering and loading a repository.
pub const METHOD_REPOSITORIES_OPEN: &str = "repositories.open";
/// Canonical host-admin method for creating, registering, and loading a repository.
pub const METHOD_REPOSITORIES_CREATE: &str = "repositories.create";
/// Canonical host-admin method for removing a repository from the catalog.
pub const METHOD_REPOSITORIES_REMOVE: &str = "repositories.remove";
/// Canonical method for loading a complete repository snapshot.
pub const METHOD_REPOSITORIES_GET_SNAPSHOT: &str = "repositories.get_snapshot";
/// Canonical method for loading a graph limited to selected commit targets.
pub const METHOD_REPOSITORIES_GET_GRAPH: &str = "repositories.get_graph";
/// Canonical method for refreshing multiple repository snapshots.
pub const METHOD_REPOSITORIES_REFRESH: &str = "repositories.refresh";
/// Canonical method for repository working-tree status reads.
pub const METHOD_GIT_STATUS: &str = "git.status";
/// Canonical method for listing the files changed by a commit.
pub const METHOD_GIT_COMMIT_FILES: &str = "git.commit_files";
pub const METHOD_GIT_COMMIT_WORKING_TREE_FILES: &str = "git.commit_working_tree_files";
pub const METHOD_GIT_COMMIT_WORKING_TREE_FILE_DIFF: &str = "git.commit_working_tree_file_diff";
/// Canonical method for reading one committed file diff.
pub const METHOD_GIT_COMMIT_FILE_DIFF: &str = "git.commit_file_diff";
/// Canonical method for reading one working-tree file diff.
pub const METHOD_GIT_WORKING_TREE_FILE_DIFF: &str = "git.working_tree_file_diff";
/// Canonical performance hint for prefetching commit file lists.
pub const METHOD_GIT_PREFETCH_COMMIT_FILES: &str = "git.prefetch_commit_files";
/// Canonical performance hint for prefetching commit file diffs.
pub const METHOD_GIT_PREFETCH_COMMIT_DIFFS: &str = "git.prefetch_commit_diffs";
/// Canonical method for staging working-tree paths.
pub const METHOD_GIT_STAGE: &str = "git.stage";
/// Canonical method for removing paths from the index.
pub const METHOD_GIT_UNSTAGE: &str = "git.unstage";
/// Canonical method for creating a commit from staged changes.
pub const METHOD_GIT_COMMIT: &str = "git.commit";
pub const METHOD_GIT_HUNK_PREVIEW: &str = "git.hunk_preview";
pub const METHOD_GIT_APPLY_HUNKS: &str = "git.apply_hunks";
pub const METHOD_GIT_DISCARD_PREVIEW: &str = "git.discard_preview";
pub const METHOD_GIT_DISCARD: &str = "git.discard";
pub const METHOD_GIT_AMEND_INFO: &str = "git.amend_info";
pub const METHOD_GIT_AMEND: &str = "git.amend";
/// Canonical method for fetching and pruning remote refs.
pub const METHOD_GIT_FETCH: &str = "git.fetch";
/// Canonical method for pulling the current configured branch.
pub const METHOD_GIT_PULL: &str = "git.pull";
/// Canonical method for pushing the current configured branch.
pub const METHOD_GIT_PUSH: &str = "git.push";
/// Canonical method for listing local branches.
pub const METHOD_GIT_BRANCH_LIST: &str = "git.branch.list";
/// Canonical method for creating a local branch.
pub const METHOD_GIT_BRANCH_CREATE: &str = "git.branch.create";
/// Canonical method for switching the current branch.
pub const METHOD_GIT_BRANCH_SWITCH: &str = "git.branch.switch";
/// Canonical method for creating a stash.
pub const METHOD_GIT_STASH_PUSH: &str = "git.stash.push";
/// Canonical method for applying and removing the latest stash.
pub const METHOD_GIT_STASH_POP: &str = "git.stash.pop";

/// Every method the WebSocket RPC surface accepts, in a stable order.
///
/// The client runtime types its RPC calls against this registry, and the
/// TypeScript contract is generated from it, so a method that the server
/// accepts is never missing from the client.
pub const WS_METHOD_NAMES: &[&str] = &[
    METHOD_SERVER_GET_INFO,
    METHOD_SERVER_GET_STATUS,
    METHOD_REPOSITORIES_LIST,
    METHOD_REPOSITORIES_OPEN,
    METHOD_REPOSITORIES_CREATE,
    METHOD_REPOSITORIES_REMOVE,
    METHOD_REPOSITORIES_GET_SNAPSHOT,
    METHOD_REPOSITORIES_GET_GRAPH,
    METHOD_REPOSITORIES_REFRESH,
    METHOD_GIT_STATUS,
    METHOD_GIT_COMMIT_FILES,
    METHOD_GIT_COMMIT_WORKING_TREE_FILES,
    METHOD_GIT_COMMIT_WORKING_TREE_FILE_DIFF,
    METHOD_GIT_COMMIT_FILE_DIFF,
    METHOD_GIT_WORKING_TREE_FILE_DIFF,
    METHOD_GIT_PREFETCH_COMMIT_FILES,
    METHOD_GIT_PREFETCH_COMMIT_DIFFS,
    METHOD_GIT_STAGE,
    METHOD_GIT_UNSTAGE,
    METHOD_GIT_COMMIT,
    METHOD_GIT_HUNK_PREVIEW,
    METHOD_GIT_APPLY_HUNKS,
    METHOD_GIT_DISCARD_PREVIEW,
    METHOD_GIT_DISCARD,
    METHOD_GIT_AMEND_INFO,
    METHOD_GIT_AMEND,
    METHOD_GIT_FETCH,
    METHOD_GIT_PULL,
    METHOD_GIT_PUSH,
    METHOD_GIT_BRANCH_LIST,
    METHOD_GIT_BRANCH_CREATE,
    METHOD_GIT_BRANCH_SWITCH,
    METHOD_GIT_STASH_PUSH,
    METHOD_GIT_STASH_POP,
];

/// Maximum number of commit hashes accepted by one commit-file prefetch hint.
pub const MAX_PREFETCH_COMMIT_HASHES: usize = 256;
/// Maximum number of typed diff targets accepted by one diff prefetch hint.
/// A one-target call is the smallest interruptible unit because each target
/// loads a complete diff synchronously.
pub const MAX_PREFETCH_COMMIT_DIFF_TARGETS: usize = 1;
/// Maximum number of commit targets accepted by one filtered graph request.
pub const MAX_GRAPH_TARGETS: usize = 256;

/// Capability advertised when `server.get_info` is available.
pub const CAPABILITY_SERVER_INFO: &str = "server.info";
/// Capability advertised when `server.get_status` is available.
pub const CAPABILITY_SERVER_STATUS: &str = "server.status";
/// Capability advertised when the repository catalog implementation is available.
pub const CAPABILITY_REPOSITORIES_LIST: &str = "repositories.list";
/// Capability advertised when host-admin repository registration is available.
pub const CAPABILITY_REPOSITORIES_OPEN: &str = "repositories.open";
/// Capability advertised when host-admin repository creation is available.
pub const CAPABILITY_REPOSITORIES_CREATE: &str = "repositories.create";
/// Capability advertised when host-admin repository removal is available.
pub const CAPABILITY_REPOSITORIES_REMOVE: &str = "repositories.remove";
/// Capability advertised when complete repository snapshots are available.
pub const CAPABILITY_REPOSITORIES_GET_SNAPSHOT: &str = "repositories.get_snapshot";
/// Capability advertised when filtered repository graphs are available.
pub const CAPABILITY_REPOSITORIES_GET_GRAPH: &str = "repositories.get_graph";
/// Capability advertised when batch repository refresh is available.
pub const CAPABILITY_REPOSITORIES_REFRESH: &str = "repositories.refresh";
/// Ordered repository invalidations are delivered to read-authorized sessions.
pub const CAPABILITY_REPOSITORIES_WATCH: &str = "repositories.watch";
pub const EVENT_REPOSITORY_CHANGED: &str = "repository.changed";

/// The smallest repository view invalidated by a filesystem change.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryChangeKind {
    /// Reload status and working-tree diffs; preserve the loaded history.
    Status,
    /// Refs, HEAD, stashes, or worktree metadata may have changed.
    Snapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChanged {
    pub repository_id: String,
    pub kind: RepositoryChangeKind,
    /// Worktree paths affected by a status invalidation when the watcher can identify them.
    /// Missing paths means the invalidation is broad or originated outside the worktree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
}
/// Capability advertised when Git status is available.
pub const CAPABILITY_GIT_STATUS: &str = "git.status";
/// Capability advertised when commit file listing is available.
pub const CAPABILITY_GIT_COMMIT_FILES: &str = "git.commit_files";
pub const CAPABILITY_GIT_COMMIT_WORKING_TREE_FILES: &str = "git.commit_working_tree_files";
pub const CAPABILITY_GIT_COMMIT_WORKING_TREE_FILE_DIFF: &str = "git.commit_working_tree_file_diff";
/// Capability advertised when committed file diffs are available.
pub const CAPABILITY_GIT_COMMIT_FILE_DIFF: &str = "git.commit_file_diff";
/// Capability advertised when working-tree file diffs are available.
pub const CAPABILITY_GIT_WORKING_TREE_FILE_DIFF: &str = "git.working_tree_file_diff";
/// Capability advertised when commit-file prefetch hints are available.
pub const CAPABILITY_GIT_PREFETCH_COMMIT_FILES: &str = "git.prefetch_commit_files";
/// Capability advertised when commit-diff prefetch hints are available.
pub const CAPABILITY_GIT_PREFETCH_COMMIT_DIFFS: &str = "git.prefetch_commit_diffs";
/// Capability advertised when Git staging is available.
pub const CAPABILITY_GIT_STAGE: &str = "git.stage";
/// Capability advertised when Git unstaging is available.
pub const CAPABILITY_GIT_UNSTAGE: &str = "git.unstage";
/// Capability advertised when Git commits are available.
pub const CAPABILITY_GIT_COMMIT: &str = "git.commit";
pub const CAPABILITY_GIT_HUNKS: &str = "git.hunks";
pub const CAPABILITY_GIT_DISCARD: &str = "git.discard";
pub const CAPABILITY_GIT_AMEND: &str = "git.amend";
/// Capability advertised when Git fetch is available.
pub const CAPABILITY_GIT_FETCH: &str = "git.fetch";
/// Capability advertised when Git pull is available.
pub const CAPABILITY_GIT_PULL: &str = "git.pull";
/// Capability advertised when Git push is available.
pub const CAPABILITY_GIT_PUSH: &str = "git.push";
/// Capability advertised when local branch listing is available.
pub const CAPABILITY_GIT_BRANCH_LIST: &str = "git.branch.list";
/// Capability advertised when local branch creation is available.
pub const CAPABILITY_GIT_BRANCH_CREATE: &str = "git.branch.create";
/// Capability advertised when branch switching is available.
pub const CAPABILITY_GIT_BRANCH_SWITCH: &str = "git.branch.switch";
/// Capability advertised when stash creation is available.
pub const CAPABILITY_GIT_STASH_PUSH: &str = "git.stash.push";
/// Capability advertised when stash popping is available.
pub const CAPABILITY_GIT_STASH_POP: &str = "git.stash.pop";

/// Machine-readable protocol error codes.
pub mod error_codes {
    /// The current session is missing or expired.
    pub const UNAUTHORIZED: &str = "unauthorized";
    /// The current session lacks a required scope.
    pub const FORBIDDEN: &str = "forbidden";
    /// The incoming WebSocket message was not a valid request envelope.
    pub const INVALID_REQUEST: &str = "invalid_request";
    /// A read was cancelled by its owning session.
    pub const REQUEST_CANCELLED: &str = "request_cancelled";
    /// The session has reached its bounded request admission limit.
    pub const SERVER_BUSY: &str = "server_busy";
    /// An identifier is already pending or running on this session.
    pub const DUPLICATE_REQUEST_ID: &str = "duplicate_request_id";
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
    /// A new repository could not be created at the requested location.
    pub const REPOSITORY_CREATE_FAILED: &str = "repository_create_failed";
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
    /// Deprecated compatibility alias for `environment_id`.
    pub server_id: String,
    /// Stable identity persisted by the backend environment.
    pub environment_id: String,
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
        let server_id = server_id.into();
        Self {
            message_type: "welcome".to_string(),
            payload: WelcomePayload {
                server_id: server_id.clone(),
                environment_id: server_id,
                protocol_version,
                capabilities,
            },
        }
    }

    /// Builds a welcome message with canonical backend environment identity.
    pub fn for_environment(
        environment_id: impl Into<String>,
        protocol_version: u32,
        capabilities: Vec<String>,
    ) -> Self {
        let environment_id = environment_id.into();
        Self {
            message_type: "welcome".to_string(),
            payload: WelcomePayload {
                server_id: environment_id.clone(),
                environment_id,
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

/// One concrete endpoint advertised by a GitGui environment.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AdvertisedEndpoint {
    /// Stable provider-specific key; unlike the URL this may survive network changes.
    pub key: String,
    /// HTTP base URL used for discovery, authentication, and other HTTP APIs.
    pub http_url: String,
    /// WebSocket base URL used for the GitGui RPC session.
    pub websocket_url: String,
    /// Whether the server recommends this route when it is reachable.
    pub is_default: bool,
    /// Reachability hint such as `loopback`, `lan`, `private`, `public`, or `tunnel`.
    pub reachability: String,
}

/// Authentication capabilities advertised before a client connects.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentAuthPolicy {
    /// Whether an authenticated session is required for WebSocket RPC.
    pub required: bool,
    /// Supported bootstrap/pairing exchange mechanisms.
    pub bootstrap_methods: Vec<String>,
    /// Supported authenticated session mechanisms.
    pub session_methods: Vec<String>,
}

/// Stable, versioned description of one running backend environment.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDescriptor {
    /// Descriptor schema version, independent of the RPC protocol version.
    pub schema_version: u32,
    /// Stable identity persisted in the backend state directory.
    pub environment_id: String,
    /// User-facing default label for this environment.
    pub label: String,
    /// GitGui server package version.
    pub server_version: String,
    /// Public RPC protocol version.
    pub protocol_version: u32,
    /// Server operating-system family.
    pub platform: String,
    /// Server CPU architecture.
    pub architecture: String,
    /// Available protocol methods and server features.
    pub capabilities: Vec<String>,
    /// Authentication policy for this server.
    pub auth: EnvironmentAuthPolicy,
    /// Candidate routes authored by this server or its desktop host.
    pub endpoints: Vec<AdvertisedEndpoint>,
}

/// OAuth-shaped token exchange response.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct TokenExchangeResponse {
    pub access_token: String,
    pub issued_token_type: String,
    pub token_type: String,
    pub expires_in: u64,
    pub scope: String,
}

/// Safe information about the current authenticated session.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub session_id: String,
    pub environment_id: String,
    pub scopes: Vec<String>,
    pub expires_at_unix_ms: u64,
}

/// A short-lived single-use credential for the WebSocket handshake.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketTicketResponse {
    pub ticket: String,
    pub expires_in: u64,
}

/// A one-time credential that can create an ordinary client session.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PairingCredentialResponse {
    pub credential: String,
    pub expires_in: u64,
    pub scopes: Vec<String>,
}

/// Immutable server metadata returned by `/info` and `server.get_info`.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct ServerInfo {
    /// Deprecated compatibility alias for `environment_id`.
    pub server_id: String,
    /// Stable identity of the backend environment.
    pub environment_id: String,
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
    /// Stable backend environment identity.
    pub environment_id: String,
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
    /// Stable backend environment identity.
    pub environment_id: String,
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
    /// Display name of the main repository, shared by its linked worktrees.
    pub name: String,
    /// Canonical path used to perform operations.
    pub path: String,
    /// Canonical Git repository root.
    pub root: String,
    /// Whether this entry is a linked Git worktree rather than the main worktree.
    pub is_worktree: bool,
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

/// Parameters for creating a new repository below an existing host directory.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesCreateParams {
    /// Existing directory on the server host where the repository folder is created.
    pub parent_path: String,
    /// Single folder name for the new repository.
    pub name: String,
    /// Optional initial branch name. Git's configured default is used when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_branch: Option<String>,
    /// Whether to configure Git LFS hooks and filters in the new repository.
    #[serde(default)]
    pub initialize_lfs: bool,
}

/// Result returned after a new repository is initialized and loaded.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesCreateResult {
    /// Server-owned repository catalog entry.
    pub repository: RepositorySummary,
    /// Fresh snapshot computed for the new repository.
    pub snapshot: RepositorySnapshot,
}

/// Parameters for removing a repository from the host catalog.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesRemoveParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
}

/// Result returned after a repository is removed from the host catalog.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesRemoveResult {
    /// Stable ID removed from the host's configured repository catalog.
    pub repository_id: String,
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

/// Parameters for loading the history reachable from selected commit targets.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryGraphParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
    /// Commit IDs whose ancestors should be included in the graph.
    pub target_commits: Vec<String>,
}

/// Result returned for a filtered repository graph request.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryGraphResult {
    /// Server-owned repository catalog entry.
    pub repository: RepositorySummary,
    /// Commits reachable from the requested targets.
    pub commits: Vec<CommitInfo>,
    /// Graph layout for the returned commits.
    pub graph: CommitGraph,
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
pub struct GitStatusParams {
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
pub struct GitStatusResult {
    pub repository: RepositorySummary,
    pub status: RepositoryStatus,
}

/// Parameters shared by staging and unstaging operations.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitPathsParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
    /// Repository-relative paths. An empty list means all working-tree paths.
    #[serde(default)]
    pub paths: Vec<String>,
}

/// Result of a staging or unstaging operation.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStageResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
}

/// Result of removing paths from the index.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitUnstageResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
}

/// Parameters for creating a commit from staged changes.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
    /// The commit title or summary line.
    pub summary: String,
    /// Optional commit description following the summary line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
}

/// Result of creating a commit.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
    /// Object ID of the newly created commit.
    pub commit_hash: String,
}

/// A Git-generated hunk. Its ID is valid only for the accompanying revision.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHunk {
    pub id: u32,
    pub header: String,
    pub patch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHunkPreviewParams {
    pub repository_id: String,
    pub file_path: String,
    #[serde(default)]
    pub staged: bool,
    /// Optional continuation from the file-content request. A cache miss loads fresh state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHunkPreview {
    pub file_path: String,
    pub staged: bool,
    pub revision: String,
    /// Display-only patch. Mutations accept IDs, never client-supplied patches.
    pub patch: String,
    pub hunks: Vec<GitHunk>,
    pub unavailable_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitApplyHunksParams {
    pub repository_id: String,
    pub file_path: String,
    pub staged: bool,
    pub revision: String,
    pub hunk_ids: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDiscardFile {
    pub path: String,
    pub untracked: bool,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDiscardParams {
    pub repository_id: String,
    /// Explicit targets from the confirmation preview; empty never means all.
    pub files: Vec<GitDiscardFile>,
    pub delete_untracked: bool,
}

/// Discard may stop after some files have changed. Refresh never retries it.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDiscardResult {
    pub completed_paths: Vec<String>,
    pub remaining_paths: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitAmendInfo {
    pub head_oid: Option<String>,
    pub summary: String,
    pub description: String,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitAmendParams {
    pub repository_id: String,
    pub expected_head: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
}

/// Parameters for a repository-wide Git operation.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryParams {
    /// Stable ID from the host's configured repository catalog.
    pub repository_id: String,
}

/// Result of fetch, pull, or push.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
}

/// Result of pulling the current configured branch.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitPullResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
}

/// Result of pushing the current configured branch.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
}

/// Parameters for listing local branches.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListParams {
    pub repository_id: String,
}

/// A local branch available for checkout.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

/// Result of listing local branches.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListResult {
    pub repository: RepositorySummary,
    pub branches: Vec<GitBranch>,
    pub snapshot: RepositorySnapshot,
}

/// Parameters for creating a local branch.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchCreateParams {
    pub repository_id: String,
    /// New local branch name.
    pub name: String,
    /// Optional starting ref or object ID. Defaults to the current HEAD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_point: Option<String>,
    /// Whether to switch to the new branch after creating it.
    #[serde(default)]
    pub checkout: bool,
}

/// Result of creating a local branch.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchCreateResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
}

/// Parameters for switching to a local branch.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchSwitchParams {
    pub repository_id: String,
    pub name: String,
    /// Attempt to carry local changes across the branch switch.
    #[serde(default)]
    pub merge: bool,
}

/// Result of switching branches.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchSwitchResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
}

/// Parameters for creating a stash.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStashPushParams {
    pub repository_id: String,
    /// Optional stash message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
    /// Include untracked files in the stash. Defaults to true.
    #[serde(default = "default_true")]
    pub include_untracked: bool,
}

/// Result of creating a stash.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStashPushResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
}

/// Parameters for popping the latest stash.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStashPopParams {
    pub repository_id: String,
}

/// Result of popping the latest stash.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStashPopResult {
    pub repository: RepositorySummary,
    pub snapshot: RepositorySnapshot,
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

/// Parameters for listing files differing between a commit and working tree.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitWorkingTreeFilesParams {
    pub repository_id: String,
    pub commit_hash: String,
}

/// Parameters for reading one file's commit-to-working-tree diff.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitWorkingTreeFileDiffParams {
    pub repository_id: String,
    pub commit_hash: String,
    pub file_path: String,
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
    /// When true, compare HEAD with the index; otherwise compare the index with the working tree.
    #[serde(default)]
    pub staged: bool,
    /// Prepare a short-lived hunk continuation while reading file contents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prepare_hunks: Option<bool>,
}

/// Result shared by committed and working-tree file-diff methods.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffResult {
    /// Structured file diff payload.
    pub diff: CommitFileDiff,
    /// Optional server-owned continuation for the separate hunk-preview request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hunk_context_id: Option<String>,
    /// Preview failure does not prevent displaying loaded file contents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hunk_error: Option<String>,
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
    /// Number of commit hashes processed; may be less than the supplied hint.
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
    /// Number of targets processed; may be less than the supplied hint.
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
    /// Local stash metadata for commits included in the history graph.
    pub stashes: Vec<StashInfo>,
    /// Git worktrees attached to this repository.
    pub worktrees: Vec<WorktreeInfo>,
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

/// One local stash entry and the commit it was based on.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    /// Commit object referenced by the stash reflog.
    pub hash: String,
    /// Reflog selector such as `stash@{0}`.
    pub selector: String,
    /// The `HEAD` commit when the stash was created.
    pub base_hash: String,
    /// The optional index commit created as the stash's second parent.
    pub index_hash: Option<String>,
    /// Branch name recorded in the stash subject, when available.
    pub branch: Option<String>,
    /// User-facing stash message without Git's generated branch prefix.
    pub message: String,
    /// Unix timestamp of the stash entry.
    pub timestamp: i64,
}

/// One Git worktree attached to the repository.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Filesystem path used to open this worktree.
    pub path: String,
    /// Commit currently checked out in this worktree.
    pub head_oid: Option<String>,
    /// Local branch checked out in this worktree, if any.
    pub branch: Option<String>,
    /// Whether this is the worktree represented by the current snapshot.
    pub current: bool,
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

/// Content omitted before transfer or parsing. Previews are plain text prefixes,
/// at most 8 KiB per side; they are never complete files or executable patches.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OmittedDiffContent {
    pub reason: String,
    pub max_bytes_per_side: usize,
    pub max_lines_per_side: usize,
    pub max_line_bytes: usize,
    pub original_preview: String,
    pub modified_preview: String,
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
    /// Both content strings are empty when this field is present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub omitted_content: Option<OmittedDiffContent>,
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

fn default_true() -> bool {
    true
}
