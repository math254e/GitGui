//! Standalone GitGui HTTP/WebSocket host.
//!
//! The server owns the repository catalog for the machine on which it runs.
//! Clients receive stable repository IDs and use those IDs for all read
//! operations; repository paths never cross the wire after catalog lookup.

use axum::{
    extract::{ws::Message, ws::WebSocket, ws::WebSocketUpgrade, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use gitgui_core::git::{
    cache::{
        CommitFileDiffKey, CommitFileDiffLookup, CommitFilesKey, InFlightCommitFileDiff,
        SharedCommitFilesCache,
    },
    command::GitError,
    operations::{
        commit as run_commit, create_branch as run_create_branch, fetch as run_fetch,
        list_local_branches, pull as run_pull, push as run_push, stage as run_stage,
        stash_pop as run_stash_pop, stash_push as run_stash_push,
        switch_branch as run_switch_branch, unstage as run_unstage,
    },
    repository::{
        load_commit_file_diff as load_core_commit_file_diff,
        load_commit_files_from_root as load_core_commit_files,
        load_repository as load_core_repository,
        load_repository_status as load_core_repository_status,
        load_working_tree_file_diff as load_core_working_tree_file_diff, resolve_repository,
        ChangedFile as CoreChangedFile, CommitFile as CoreCommitFile,
        CommitFileDiff as CoreCommitFileDiff, RepositorySnapshot as CoreRepositorySnapshot,
        RepositoryStatus as CoreRepositoryStatus,
    },
};
use gitgui_protocol::{
    error_codes, ChangedFile as ProtocolChangedFile, CommitFile as ProtocolCommitFile,
    CommitFileDiff as ProtocolCommitFileDiff, CommitFilesParams, CommitFilesResult,
    CommitGraph as ProtocolCommitGraph, CommitInfo as ProtocolCommitInfo,
    CommitRef as ProtocolCommitRef, CommitRefType as ProtocolCommitRefType, FileDiffResult,
    GitBranch, GitBranchCreateParams, GitBranchCreateResult, GitBranchListParams,
    GitBranchListResult, GitBranchSwitchParams, GitBranchSwitchResult, GitCommitParams,
    GitCommitResult, GitFetchResult, GitPathsParams, GitPullResult, GitPushResult,
    GitRepositoryParams, GitStageResult, GitStashPopParams, GitStashPopResult, GitStashPushParams,
    GitStashPushResult, GitStatusParams, GitStatusResult, GitUnstageResult,
    GraphCommit as ProtocolGraphCommit, GraphEdge as ProtocolGraphEdge,
    GraphEdgeType as ProtocolGraphEdgeType, PrefetchCommitDiffsParams, PrefetchCommitDiffsResult,
    PrefetchCommitFilesParams, PrefetchCommitFilesResult, ProtocolError, ProtocolErrorMessage,
    RepositoriesListResult, RepositoriesOpenParams, RepositoriesOpenResult,
    RepositoriesRefreshParams, RepositoriesRefreshResult, RepositoryInfo as ProtocolRepositoryInfo,
    RepositoryRefreshItem, RepositorySnapshot, RepositorySnapshotParams, RepositorySnapshotResult,
    RepositoryStatus as ProtocolRepositoryStatus, RepositorySummary, RequestEnvelope,
    ResponseEnvelope, ServerInfo, ServerLifecycle, ServerReadiness, ServerStatus,
    StashInfo as ProtocolStashInfo, WelcomeMessage, CAPABILITY_GIT_BRANCH_CREATE,
    CAPABILITY_GIT_BRANCH_LIST, CAPABILITY_GIT_BRANCH_SWITCH, CAPABILITY_GIT_COMMIT,
    CAPABILITY_GIT_COMMIT_FILES, CAPABILITY_GIT_COMMIT_FILE_DIFF, CAPABILITY_GIT_FETCH,
    CAPABILITY_GIT_PREFETCH_COMMIT_DIFFS, CAPABILITY_GIT_PREFETCH_COMMIT_FILES,
    CAPABILITY_GIT_PULL, CAPABILITY_GIT_PUSH, CAPABILITY_GIT_STAGE, CAPABILITY_GIT_STASH_POP,
    CAPABILITY_GIT_STASH_PUSH, CAPABILITY_GIT_STATUS, CAPABILITY_GIT_UNSTAGE,
    CAPABILITY_GIT_WORKING_TREE_FILE_DIFF, CAPABILITY_REPOSITORIES_GET_SNAPSHOT,
    CAPABILITY_REPOSITORIES_LIST, CAPABILITY_REPOSITORIES_OPEN, CAPABILITY_REPOSITORIES_REFRESH,
    CAPABILITY_SERVER_INFO, CAPABILITY_SERVER_STATUS, MAX_PREFETCH_COMMIT_DIFF_TARGETS,
    MAX_PREFETCH_COMMIT_HASHES, METHOD_GIT_BRANCH_CREATE, METHOD_GIT_BRANCH_LIST,
    METHOD_GIT_BRANCH_SWITCH, METHOD_GIT_COMMIT, METHOD_GIT_COMMIT_FILES,
    METHOD_GIT_COMMIT_FILE_DIFF, METHOD_GIT_FETCH, METHOD_GIT_PREFETCH_COMMIT_DIFFS,
    METHOD_GIT_PREFETCH_COMMIT_FILES, METHOD_GIT_PULL, METHOD_GIT_PUSH, METHOD_GIT_STAGE,
    METHOD_GIT_STASH_POP, METHOD_GIT_STASH_PUSH, METHOD_GIT_STATUS, METHOD_GIT_UNSTAGE,
    METHOD_GIT_WORKING_TREE_FILE_DIFF, METHOD_REPOSITORIES_GET_SNAPSHOT, METHOD_REPOSITORIES_LIST,
    METHOD_REPOSITORIES_OPEN, METHOD_REPOSITORIES_REFRESH, METHOD_SERVER_GET_INFO,
    METHOD_SERVER_GET_STATUS, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    error::Error,
    fmt::{self, Display, Formatter},
    fs::{self, OpenOptions},
    io::{self, Write},
    net::{IpAddr, SocketAddr},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Mutex, RwLock},
    task::{spawn_blocking, JoinHandle},
};
use tower_http::services::{ServeDir, ServeFile};
use tracing::{info, warn};

/// Environment variable for the bind IP address.
pub const BIND_ENV: &str = "GITGUI_SERVER_BIND";
/// Environment variable for the bind port.
pub const PORT_ENV: &str = "GITGUI_SERVER_PORT";
/// Environment variable for the optional persistent server data directory.
pub const DATA_DIR_ENV: &str = "GITGUI_SERVER_DATA_DIR";
/// Environment variable containing the local bootstrap/session token.
pub const BOOTSTRAP_TOKEN_ENV: &str = "GITGUI_SERVER_BOOTSTRAP_TOKEN";
/// Environment variable replacing the default exact browser-origin allowlist.
pub const ALLOWED_ORIGINS_ENV: &str = "GITGUI_SERVER_ALLOWED_ORIGINS";
/// Environment variable containing additional exact browser origins.
pub const ADDITIONAL_ORIGINS_ENV: &str = "GITGUI_SERVER_ADDITIONAL_ORIGINS";
/// Environment variable pointing at the Vite development client.
pub const DEV_URL_ENV: &str = "GITGUI_SERVER_DEV_URL";
/// Environment variable pointing at the compiled SvelteKit web application.
pub const WEB_DIR_ENV: &str = "GITGUI_SERVER_WEB_DIR";

/// Query parameter used by browser WebSocket clients for the session token.
pub const SESSION_TOKEN_QUERY_KEY: &str = "session_token";
/// Exact browser origins accepted by the local Tauri webview in development
/// and packaged builds.
pub const DEFAULT_ALLOWED_ORIGINS: &[&str] = &[
    "http://localhost:1420",
    "http://tauri.localhost",
    "tauri://localhost",
];

/// Default bind IP. Loopback is required until authentication exists.
pub const DEFAULT_BIND_IP: &str = "127.0.0.1";
/// Port `0` asks the operating system for an available ephemeral port.
pub const DEFAULT_PORT: u16 = 0;
/// Persistent-file schema version owned by this server implementation.
pub const PERSISTENCE_SCHEMA_VERSION: u32 = 1;
const SERVER_ID_FILE: &str = "server.json";
const REPOSITORY_CATALOG_FILE: &str = "repositories.json";

/// Prefix for the machine-readable line emitted by the standalone binary
/// after its listener binds.
pub const SERVER_READY_LINE_PREFIX: &str = "GITGUI_SERVER_READY=";

/// Server configuration used by both the binary and future Tauri management.
#[derive(Clone)]
pub struct ServerConfig {
    /// Requested bind address. Port `0` is allowed and becomes an ephemeral port.
    pub bind_addr: SocketAddr,
    /// Process identity advertised to clients. A configured data directory
    /// replaces this with the persisted host identity during startup.
    pub server_id: String,
    /// Package version advertised to clients.
    pub server_version: String,
    /// Requested capabilities. Startup filters these to implemented methods.
    pub capabilities: Vec<String>,
    /// Repository paths explicitly configured for this host.
    pub repository_paths: Vec<String>,
    /// Optional persistent server data directory.
    pub data_dir: Option<PathBuf>,
    /// Optional bootstrap/session token required before a WebSocket upgrade.
    pub bootstrap_token: Option<String>,
    /// Exact browser origins accepted before a WebSocket upgrade.
    pub allowed_origins: Vec<String>,
    /// Optional directory containing the compiled SvelteKit app.
    pub web_dir: Option<PathBuf>,
    /// Optional Vite development client URL used by the local browser entrypoint.
    pub dev_url: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_addr: SocketAddr::new(
                DEFAULT_BIND_IP
                    .parse()
                    .expect("the default bind IP is a valid IPv4 address"),
                DEFAULT_PORT,
            ),
            server_id: generate_server_id(),
            server_version: env!("CARGO_PKG_VERSION").to_string(),
            capabilities: implemented_capabilities(),
            repository_paths: Vec::new(),
            data_dir: None,
            bootstrap_token: None,
            allowed_origins: DEFAULT_ALLOWED_ORIGINS
                .iter()
                .map(|origin| (*origin).to_string())
                .collect(),
            web_dir: None,
            dev_url: None,
        }
    }
}

impl fmt::Debug for ServerConfig {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServerConfig")
            .field("bind_addr", &self.bind_addr)
            .field("server_id", &self.server_id)
            .field("server_version", &self.server_version)
            .field("capabilities", &self.capabilities)
            .field("repository_paths", &self.repository_paths)
            .field("data_dir", &self.data_dir)
            .field(
                "bootstrap_token",
                &self.bootstrap_token.as_ref().map(|_| "[configured]"),
            )
            .field("allowed_origins", &self.allowed_origins)
            .field("web_dir", &self.web_dir)
            .field("dev_url", &self.dev_url)
            .finish()
    }
}

impl ServerConfig {
    /// Parses CLI flags and environment variables without requiring a CLI crate.
    /// CLI values override environment values.
    pub fn from_env_and_args<I, S>(args: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut config = Self::default();
        if let Ok(bind) = env::var(BIND_ENV) {
            config.bind_addr.set_ip(parse_ip(&bind)?);
        }
        if let Ok(port) = env::var(PORT_ENV) {
            config.bind_addr.set_port(parse_port(&port)?);
        }
        if let Ok(data_dir) = env::var(DATA_DIR_ENV) {
            config.data_dir = Some(parse_data_dir(&data_dir)?);
        }
        if let Ok(token) = env::var(BOOTSTRAP_TOKEN_ENV) {
            if !token.is_empty() {
                config.bootstrap_token = Some(token);
            }
        }
        if let Ok(origins) = env::var(ALLOWED_ORIGINS_ENV) {
            config.allowed_origins = parse_origin_list(&origins)?;
        }
        if let Ok(origins) = env::var(ADDITIONAL_ORIGINS_ENV) {
            append_origin_list(&mut config.allowed_origins, &origins)?;
        }
        if let Ok(dev_url) = env::var(DEV_URL_ENV) {
            config.dev_url = Some(parse_dev_url(&dev_url)?);
        }
        if let Ok(web_dir) = env::var(WEB_DIR_ENV) {
            config.web_dir = Some(parse_web_dir(&web_dir)?);
        }

        let mut args = args.into_iter().map(Into::into).skip(1);
        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--bind" | "--bind-addr" => {
                    let value = args.next().ok_or_else(|| ConfigError::MissingValue {
                        flag: argument.clone(),
                    })?;
                    config.bind_addr.set_ip(parse_ip(&value)?);
                }
                "--port" => {
                    let value = args.next().ok_or_else(|| ConfigError::MissingValue {
                        flag: argument.clone(),
                    })?;
                    config.bind_addr.set_port(parse_port(&value)?);
                }
                "--data-dir" => {
                    let value = args.next().ok_or_else(|| ConfigError::MissingValue {
                        flag: argument.clone(),
                    })?;
                    config.data_dir = Some(parse_data_dir(&value)?);
                }
                "--repository" | "--repo" => {
                    let value = args.next().ok_or_else(|| ConfigError::MissingValue {
                        flag: argument.clone(),
                    })?;
                    config.repository_paths.push(value);
                }
                "--web-dir" => {
                    let value = args.next().ok_or_else(|| ConfigError::MissingValue {
                        flag: argument.clone(),
                    })?;
                    config.web_dir = Some(parse_web_dir(&value)?);
                }
                "--help" | "-h" => return Err(ConfigError::HelpRequested),
                "--version" | "-V" => return Err(ConfigError::VersionRequested),
                unknown => return Err(ConfigError::UnknownArgument(unknown.to_string())),
            }
        }

        Ok(config)
    }
}

/// Configuration parsing failures surfaced by the standalone binary.
#[derive(Debug)]
pub enum ConfigError {
    MissingValue { flag: String },
    InvalidBind { value: String },
    InvalidPort { value: String },
    InvalidDataDir { value: String },
    InvalidOrigin { value: String },
    InvalidWebDir { value: String },
    InvalidDevUrl { value: String },
    UnknownArgument(String),
    HelpRequested,
    VersionRequested,
}

impl Display for ConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingValue { flag } => write!(formatter, "missing value for {flag}"),
            Self::InvalidBind { value } => write!(formatter, "invalid bind IP address: {value}"),
            Self::InvalidPort { value } => write!(formatter, "invalid port: {value}"),
            Self::InvalidDataDir { value } => write!(formatter, "invalid data directory: {value}"),
            Self::InvalidOrigin { value } => write!(formatter, "invalid allowed origin: {value}"),
            Self::InvalidWebDir { value } => write!(formatter, "invalid web directory: {value}"),
            Self::InvalidDevUrl { value } => write!(formatter, "invalid development URL: {value}"),
            Self::UnknownArgument(argument) => write!(formatter, "unknown argument: {argument}"),
            Self::HelpRequested => formatter.write_str("help requested"),
            Self::VersionRequested => formatter.write_str("version requested"),
        }
    }
}

impl Error for ConfigError {}

/// Errors returned while starting or managing the server.
#[derive(Debug)]
pub enum ServerError {
    Configuration(String),
    Io(std::io::Error),
    Join(tokio::task::JoinError),
}

impl From<std::io::Error> for ServerError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl Display for ServerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) => {
                write!(formatter, "server configuration error: {message}")
            }
            Self::Io(error) => write!(formatter, "server I/O error: {error}"),
            Self::Join(error) => write!(formatter, "server task error: {error}"),
        }
    }
}

impl Error for ServerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Configuration(_) => None,
            Self::Io(error) => Some(error),
            Self::Join(error) => Some(error),
        }
    }
}

/// A running server started through [`start`].
pub struct ServerHandle {
    local_addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<(), std::io::Error>>,
}

impl ServerHandle {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn shutdown(mut self) -> Result<(), ServerError> {
        let _ = self
            .shutdown
            .take()
            .expect("shutdown sender is present")
            .send(());
        self.task
            .await
            .map_err(ServerError::Join)?
            .map_err(ServerError::Io)
    }
}

/// Starts a server in a background Tokio task and returns its actual bound address.
pub async fn start(config: ServerConfig) -> Result<ServerHandle, ServerError> {
    validate_bind_security(&config).map_err(ServerError::Configuration)?;
    let startup = prepare_startup(&config)
        .await
        .map_err(ServerError::Configuration)?;
    let mut config = config;
    config.server_id = startup.server_id;
    let web_dir = resolve_web_dir(&config).map_err(ServerError::Configuration)?;

    let listener = TcpListener::bind(config.bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let state = Arc::new(ServerState::new(&config, local_addr, startup.repositories));
    let router = router(state.clone(), web_dir);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let shutdown_state = state.clone();
    let task = tokio::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
                shutdown_state
                    .set_lifecycle(ServerLifecycle::Stopping)
                    .await;
            })
            .await;
        state.set_lifecycle(ServerLifecycle::Stopped).await;
        result
    });

    log_bind_address(local_addr, &config);
    Ok(ServerHandle {
        local_addr,
        shutdown: Some(shutdown_tx),
        task,
    })
}

/// Runs a foreground server until Ctrl-C or a termination signal is received.
pub async fn run(config: ServerConfig) -> Result<(), ServerError> {
    validate_bind_security(&config).map_err(ServerError::Configuration)?;
    let startup = prepare_startup(&config)
        .await
        .map_err(ServerError::Configuration)?;
    let mut config = config;
    config.server_id = startup.server_id;
    let web_dir = resolve_web_dir(&config).map_err(ServerError::Configuration)?;

    let listener = TcpListener::bind(config.bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let state = Arc::new(ServerState::new(&config, local_addr, startup.repositories));
    let router = router(state.clone(), web_dir);

    log_bind_address(local_addr, &config);
    emit_ready_line(local_addr);
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal(state.clone()))
        .await
        .map_err(ServerError::Io)?;
    state.set_lifecycle(ServerLifecycle::Stopped).await;
    Ok(())
}

fn router(state: Arc<ServerState>, web_dir: Option<PathBuf>) -> Router {
    let dev_url = state.dev_url.clone();
    let server_address = state.info.bind_address.clone();
    let session_token = state.bootstrap_token.clone();
    let router = Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/info", get(info))
        .route("/ws", get(websocket))
        .with_state(state);

    if let Some(dev_url) = dev_url {
        let redirect_url =
            build_dev_redirect_url(&dev_url, &server_address, session_token.as_deref());
        return router.route(
            "/",
            get(move || async move { Redirect::temporary(&redirect_url) }),
        );
    }

    let Some(web_dir) = web_dir else {
        return router;
    };

    let index_file = web_dir.join("index.html");
    info!(web_dir = %web_dir.display(), "GitGui web application enabled");
    router.fallback_service(
        ServeDir::new(web_dir)
            .append_index_html_on_directories(true)
            .fallback(ServeFile::new(index_file)),
    )
}

fn build_dev_redirect_url(
    dev_url: &str,
    server_address: &str,
    session_token: Option<&str>,
) -> String {
    let separator = if dev_url.ends_with('?') || dev_url.ends_with('&') {
        ""
    } else if dev_url.contains('?') {
        "&"
    } else {
        "?"
    };
    let mut redirect_url = format!("{dev_url}{separator}server=http://{server_address}");
    if let Some(session_token) = session_token {
        redirect_url.push_str("#session_token=");
        redirect_url.push_str(session_token);
    }
    redirect_url
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn ready(State(state): State<Arc<ServerState>>) -> Json<ServerReadiness> {
    Json(state.readiness().await)
}

async fn info(State(state): State<Arc<ServerState>>) -> Json<ServerInfo> {
    Json(state.info.clone())
}

async fn websocket(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(query): Query<WebSocketQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !state.authorizes_token(query.session_token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
        let Ok(origin) = origin.to_str() else {
            return StatusCode::FORBIDDEN.into_response();
        };
        let host_matches_origin = headers
            .get(axum::http::header::HOST)
            .and_then(|host| host.to_str().ok())
            .is_some_and(|host| origin == format!("http://{host}"));
        if !host_matches_origin
            && !state
                .allowed_origins
                .iter()
                .any(|allowed| allowed == origin)
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    }

    upgrade
        .on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

#[derive(Debug, Default, Deserialize)]
struct WebSocketQuery {
    #[serde(rename = "session_token")]
    session_token: Option<String>,
}

async fn handle_socket(mut socket: WebSocket, state: Arc<ServerState>) {
    let welcome = WelcomeMessage::new(
        state.info.server_id.clone(),
        state.info.protocol_version,
        state.info.capabilities.clone(),
    );
    if send_json(&mut socket, &welcome).await.is_err() {
        return;
    }

    while let Some(frame) = socket.next().await {
        match frame {
            Ok(Message::Text(text)) => {
                if process_text_frame(&mut socket, &state, text.as_str())
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Ok(Message::Binary(bytes)) => {
                let text = String::from_utf8(bytes.to_vec());
                let request_id = text
                    .as_ref()
                    .ok()
                    .and_then(|text| request_id_from_text(text));
                let result = text
                    .map_err(|_| {
                        ProtocolError::new(
                            error_codes::INVALID_REQUEST,
                            "binary frames must contain UTF-8 JSON",
                        )
                    })
                    .and_then(|text| parse_request(&text));
                if process_request_result(&mut socket, &state, result, request_id)
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Ok(Message::Ping(payload)) => {
                if socket.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            Ok(Message::Pong(_)) => {}
            Ok(Message::Close(_)) => {
                let _ = socket.close().await;
                break;
            }
            Err(error) => {
                warn!(error = %error, "WebSocket receive failed");
                break;
            }
        }
    }
}

async fn process_text_frame(
    socket: &mut WebSocket,
    state: &ServerState,
    text: &str,
) -> Result<(), ()> {
    let result = parse_request(text);
    process_request_result(socket, state, result, request_id_from_text(text)).await
}

fn parse_request(text: &str) -> Result<RequestEnvelope, ProtocolError> {
    let request = serde_json::from_str::<RequestEnvelope>(text).map_err(|error| {
        ProtocolError::with_details(
            error_codes::INVALID_REQUEST,
            "WebSocket frame is not a valid request envelope",
            json!({ "reason": error.to_string() }),
        )
    })?;

    if !request.has_valid_id() {
        return Err(ProtocolError::new(
            error_codes::INVALID_REQUEST,
            "request id must be a non-empty string",
        ));
    }
    if request.method.trim().is_empty() {
        return Err(ProtocolError::new(
            error_codes::INVALID_REQUEST,
            "request method must be a non-empty string",
        ));
    }
    Ok(request)
}

async fn process_request_result(
    socket: &mut WebSocket,
    state: &ServerState,
    result: Result<RequestEnvelope, ProtocolError>,
    request_id: Option<String>,
) -> Result<(), ()> {
    match result {
        Ok(request) => {
            let response = dispatch(request, state).await;
            send_json(socket, &response).await
        }
        Err(error) => match request_id {
            Some(id) => send_json(socket, &ResponseEnvelope::error(id, error)).await,
            None => send_json(socket, &ProtocolErrorMessage::new(error)).await,
        },
    }
}

fn request_id_from_text(text: &str) -> Option<String> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .filter(|id| !id.trim().is_empty())
}

async fn dispatch(request: RequestEnvelope, state: &ServerState) -> ResponseEnvelope {
    match request.method.as_str() {
        METHOD_SERVER_GET_INFO => response_success(request.id, state.info.clone()),
        METHOD_SERVER_GET_STATUS => response_success(request.id, state.status().await),
        METHOD_REPOSITORIES_LIST => repositories_list(request.id, state).await,
        METHOD_REPOSITORIES_OPEN => repositories_open(request.id, request.params, state).await,
        METHOD_REPOSITORIES_GET_SNAPSHOT => {
            repositories_get_snapshot(request.id, request.params, state).await
        }
        METHOD_REPOSITORIES_REFRESH => {
            repositories_refresh(request.id, request.params, state).await
        }
        METHOD_GIT_STATUS => git_status(request.id, request.params, state).await,
        METHOD_GIT_COMMIT_FILES => git_commit_files(request.id, request.params, state).await,
        METHOD_GIT_COMMIT_FILE_DIFF => {
            git_commit_file_diff(request.id, request.params, state).await
        }
        METHOD_GIT_WORKING_TREE_FILE_DIFF => {
            git_working_tree_file_diff(request.id, request.params, state).await
        }
        METHOD_GIT_PREFETCH_COMMIT_FILES => {
            git_prefetch_commit_files(request.id, request.params, state).await
        }
        METHOD_GIT_PREFETCH_COMMIT_DIFFS => {
            git_prefetch_commit_diffs(request.id, request.params, state).await
        }
        METHOD_GIT_STAGE => git_stage(request.id, request.params, state).await,
        METHOD_GIT_UNSTAGE => git_unstage(request.id, request.params, state).await,
        METHOD_GIT_COMMIT => git_commit(request.id, request.params, state).await,
        METHOD_GIT_FETCH => git_fetch(request.id, request.params, state).await,
        METHOD_GIT_PULL => git_pull(request.id, request.params, state).await,
        METHOD_GIT_PUSH => git_push(request.id, request.params, state).await,
        METHOD_GIT_BRANCH_LIST => git_branch_list(request.id, request.params, state).await,
        METHOD_GIT_BRANCH_CREATE => git_branch_create(request.id, request.params, state).await,
        METHOD_GIT_BRANCH_SWITCH => git_branch_switch(request.id, request.params, state).await,
        METHOD_GIT_STASH_PUSH => git_stash_push(request.id, request.params, state).await,
        METHOD_GIT_STASH_POP => git_stash_pop(request.id, request.params, state).await,
        _ => ResponseEnvelope::error(
            request.id,
            ProtocolError::with_details(
                error_codes::METHOD_NOT_FOUND,
                "Unknown GitGui method",
                json!({ "method": request.method }),
            ),
        ),
    }
}

async fn repositories_list(request_id: String, state: &ServerState) -> ResponseEnvelope {
    response_success(
        request_id,
        RepositoriesListResult {
            repositories: state.repository_summaries().await,
        },
    )
}

async fn repositories_open(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params = match parse_params::<RepositoriesOpenParams>(params, "repositories.open") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if params.path.trim().is_empty() || params.path.len() > 32_768 {
        return invalid_params(request_id, "path must be a non-empty repository path");
    }

    let path = params.path;
    let loaded = spawn_blocking(move || load_open_repository(&path)).await;
    let (candidate, core_snapshot) = match loaded {
        Ok(Ok(value)) => value,
        Ok(Err(OpenRepositoryError::NotFound)) => {
            return ResponseEnvelope::error(
                request_id,
                ProtocolError::new(
                    error_codes::REPOSITORY_NOT_FOUND,
                    "path is not a Git repository or could not be found",
                ),
            )
        }
        Ok(Err(OpenRepositoryError::Git(error))) => {
            warn!(error = %error.message, "repository open operation failed");
            return git_failure(request_id, "repository could not be loaded");
        }
        Err(error) => {
            warn!(error = %error, "repository open worker failed");
            return git_failure(request_id, "repository worker failed");
        }
    };

    let repository = match state.upsert_repository(candidate).await {
        Ok(repository) => repository,
        Err(error) => {
            warn!(error = %error, "repository catalog persistence failed");
            return internal_error(request_id, "repository catalog could not be updated");
        }
    };
    let snapshot = protocol_snapshot(core_snapshot, &repository.summary);
    let repository_summary = repository.summary.clone();

    response_success(
        request_id,
        RepositoriesOpenResult {
            repository: repository_summary.clone(),
            snapshot: normalize_snapshot(snapshot, &repository_summary),
        },
    )
}

async fn repositories_get_snapshot(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params = match parse_params::<RepositorySnapshotParams>(params, "repositories.get_snapshot")
    {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }
    let Some(repository) = state.repository(&params.repository_id).await else {
        return repository_not_configured(request_id, &params.repository_id);
    };
    let repository_summary = repository.summary.clone();

    match spawn_blocking(move || load_snapshot(&repository)).await {
        Ok(Ok(snapshot)) => response_success(
            request_id,
            RepositorySnapshotResult {
                repository: repository_summary,
                snapshot,
            },
        ),
        Ok(Err(RepositoryLoadError::NotFound)) => repository_not_found(request_id),
        Ok(Err(RepositoryLoadError::Git(error))) => {
            warn!(error = %error.message, "repository snapshot operation failed");
            git_failure(request_id, "repository snapshot could not be loaded")
        }
        Err(error) => {
            warn!(error = %error, "repository snapshot worker failed");
            git_failure(request_id, "repository snapshot worker failed")
        }
    }
}

async fn repositories_refresh(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params = match parse_params::<RepositoriesRefreshParams>(params, "repositories.refresh") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };

    let mut repositories = Vec::with_capacity(params.repository_ids.len());
    for repository_id in params.repository_ids {
        if let Err(error) = validate_repository_id(&repository_id) {
            repositories.push(RepositoryRefreshItem {
                repository_id,
                repository: None,
                snapshot: None,
                error: Some(error),
            });
            continue;
        }

        let Some(repository) = state.repository(&repository_id).await else {
            repositories.push(RepositoryRefreshItem {
                repository_id: repository_id.clone(),
                repository: None,
                snapshot: None,
                error: Some(repository_not_configured_error(&repository_id)),
            });
            continue;
        };
        let repository_summary = repository.summary.clone();

        let result = spawn_blocking(move || load_snapshot(&repository)).await;
        match result {
            Ok(Ok(snapshot)) => repositories.push(RepositoryRefreshItem {
                repository_id,
                repository: Some(repository_summary.clone()),
                snapshot: Some(normalize_snapshot(snapshot, &repository_summary)),
                error: None,
            }),
            Ok(Err(RepositoryLoadError::NotFound)) => repositories.push(RepositoryRefreshItem {
                repository_id,
                repository: None,
                snapshot: None,
                error: Some(repository_not_found_error()),
            }),
            Ok(Err(RepositoryLoadError::Git(error))) => {
                warn!(error = %error.message, "repository refresh operation failed");
                repositories.push(RepositoryRefreshItem {
                    repository_id,
                    repository: None,
                    snapshot: None,
                    error: Some(git_failure_error("repository refresh could not be loaded")),
                });
            }
            Err(error) => {
                warn!(error = %error, "repository refresh worker failed");
                repositories.push(RepositoryRefreshItem {
                    repository_id,
                    repository: None,
                    snapshot: None,
                    error: Some(git_failure_error("repository refresh worker failed")),
                });
            }
        }
    }

    response_success(request_id, RepositoriesRefreshResult { repositories })
}

async fn git_status(request_id: String, params: Value, state: &ServerState) -> ResponseEnvelope {
    let params = match parse_params::<GitStatusParams>(params, "git.status") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }
    let Some(repository) = state.repository(&params.repository_id).await else {
        return repository_not_configured(request_id, &params.repository_id);
    };
    let repository_summary = repository.summary.clone();

    let result = spawn_blocking(move || load_status(&repository)).await;
    match result {
        Ok(Ok(status)) => response_success(
            request_id,
            GitStatusResult {
                repository: repository_summary,
                status: protocol_status(status),
            },
        ),
        Ok(Err(StatusLoadError::NotFound)) => repository_not_found(request_id),
        Ok(Err(StatusLoadError::Git(error))) => {
            warn!(error = %error.message, "Git status operation failed");
            git_failure(request_id, "Git status could not be read")
        }
        Err(error) => {
            warn!(error = %error, "Git status worker failed");
            git_failure(request_id, "Git status worker failed")
        }
    }
}

async fn git_stage(request_id: String, params: Value, state: &ServerState) -> ResponseEnvelope {
    let params = match parse_params::<GitPathsParams>(params, "git.stage") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id)
        .and_then(|_| validate_git_paths(&params.paths))
    {
        return ResponseEnvelope::error(request_id, error);
    }

    let repository_id = params.repository_id.clone();
    let paths = params.paths;
    match run_git_action(state, &repository_id, move |root| run_stage(root, &paths)).await {
        Ok((repository, snapshot, _)) => response_success(
            request_id,
            GitStageResult {
                repository,
                snapshot,
            },
        ),
        Err(error) => ResponseEnvelope::error(request_id, error),
    }
}

async fn git_unstage(request_id: String, params: Value, state: &ServerState) -> ResponseEnvelope {
    let params = match parse_params::<GitPathsParams>(params, "git.unstage") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id)
        .and_then(|_| validate_git_paths(&params.paths))
    {
        return ResponseEnvelope::error(request_id, error);
    }

    let repository_id = params.repository_id.clone();
    let paths = params.paths;
    match run_git_action(state, &repository_id, move |root| run_unstage(root, &paths)).await {
        Ok((repository, snapshot, _)) => response_success(
            request_id,
            GitUnstageResult {
                repository,
                snapshot,
            },
        ),
        Err(error) => ResponseEnvelope::error(request_id, error),
    }
}

async fn git_commit(request_id: String, params: Value, state: &ServerState) -> ResponseEnvelope {
    let params = match parse_params::<GitCommitParams>(params, "git.commit") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id)
        .and_then(|_| validate_commit_text(&params.summary, "summary", 4096))
        .and_then(|_| {
            params
                .description
                .as_deref()
                .map(|description| validate_optional_text(description, "description", 64 * 1024))
                .unwrap_or(Ok(()))
        })
    {
        return ResponseEnvelope::error(request_id, error);
    }

    let repository_id = params.repository_id.clone();
    let message = build_commit_message(&params.summary, params.description.as_deref());
    match run_git_action(state, &repository_id, move |root| {
        run_commit(root, &message)
    })
    .await
    {
        Ok((repository, snapshot, _)) => {
            let Some(commit_hash) = snapshot.status.head_oid.clone() else {
                return git_failure(request_id, "commit completed without a new HEAD");
            };
            response_success(
                request_id,
                GitCommitResult {
                    repository,
                    snapshot,
                    commit_hash,
                },
            )
        }
        Err(error) => ResponseEnvelope::error(request_id, error),
    }
}

async fn git_fetch(request_id: String, params: Value, state: &ServerState) -> ResponseEnvelope {
    git_repository_action(
        request_id,
        params,
        state,
        "git.fetch",
        run_fetch,
        |repository, snapshot| GitFetchResult {
            repository,
            snapshot,
        },
    )
    .await
}

async fn git_pull(request_id: String, params: Value, state: &ServerState) -> ResponseEnvelope {
    git_repository_action(
        request_id,
        params,
        state,
        "git.pull",
        run_pull,
        |repository, snapshot| GitPullResult {
            repository,
            snapshot,
        },
    )
    .await
}

async fn git_push(request_id: String, params: Value, state: &ServerState) -> ResponseEnvelope {
    git_repository_action(
        request_id,
        params,
        state,
        "git.push",
        run_push,
        |repository, snapshot| GitPushResult {
            repository,
            snapshot,
        },
    )
    .await
}

async fn git_repository_action<T, F, R>(
    request_id: String,
    params: Value,
    state: &ServerState,
    method: &str,
    operation: F,
    result: R,
) -> ResponseEnvelope
where
    F: FnOnce(&str) -> Result<(), GitError> + Send + 'static,
    R: FnOnce(RepositorySummary, RepositorySnapshot) -> T,
    T: Serialize,
{
    let params = match parse_params::<GitRepositoryParams>(params, method) {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }

    match run_git_action(state, &params.repository_id, operation).await {
        Ok((repository, snapshot, _)) => response_success(request_id, result(repository, snapshot)),
        Err(error) => ResponseEnvelope::error(request_id, error),
    }
}

async fn git_branch_list(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params = match parse_params::<GitBranchListParams>(params, "git.branch.list") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }

    match run_git_action(state, &params.repository_id, |root| {
        list_local_branches(root)
    })
    .await
    {
        Ok((repository, snapshot, names)) => {
            let current = snapshot.status.current_branch.as_deref();
            response_success(
                request_id,
                GitBranchListResult {
                    repository,
                    branches: names
                        .into_iter()
                        .map(|name| GitBranch {
                            current: current == Some(name.as_str()),
                            name,
                        })
                        .collect(),
                    snapshot,
                },
            )
        }
        Err(error) => ResponseEnvelope::error(request_id, error),
    }
}

async fn git_branch_create(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params = match parse_params::<GitBranchCreateParams>(params, "git.branch.create") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id)
        .and_then(|_| validate_branch_argument(&params.name, "name"))
        .and_then(|_| {
            params
                .start_point
                .as_deref()
                .map(|start_point| validate_branch_argument(start_point, "startPoint"))
                .unwrap_or(Ok(()))
        })
    {
        return ResponseEnvelope::error(request_id, error);
    }

    let repository_id = params.repository_id.clone();
    let name = params.name;
    let start_point = params.start_point;
    let checkout = params.checkout;
    match run_git_action(state, &repository_id, move |root| {
        run_create_branch(root, &name, start_point.as_deref(), checkout)
    })
    .await
    {
        Ok((repository, snapshot, _)) => response_success(
            request_id,
            GitBranchCreateResult {
                repository,
                snapshot,
            },
        ),
        Err(error) => ResponseEnvelope::error(request_id, error),
    }
}

async fn git_branch_switch(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params = match parse_params::<GitBranchSwitchParams>(params, "git.branch.switch") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id)
        .and_then(|_| validate_branch_argument(&params.name, "name"))
    {
        return ResponseEnvelope::error(request_id, error);
    }

    let repository_id = params.repository_id.clone();
    let name = params.name;
    match run_git_action(state, &repository_id, move |root| {
        run_switch_branch(root, &name)
    })
    .await
    {
        Ok((repository, snapshot, _)) => response_success(
            request_id,
            GitBranchSwitchResult {
                repository,
                snapshot,
            },
        ),
        Err(error) => ResponseEnvelope::error(request_id, error),
    }
}

async fn git_stash_push(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params = match parse_params::<GitStashPushParams>(params, "git.stash.push") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id).and_then(|_| {
        params
            .message
            .as_deref()
            .map(|message| validate_optional_text(message, "message", 4096))
            .unwrap_or(Ok(()))
    }) {
        return ResponseEnvelope::error(request_id, error);
    }

    let repository_id = params.repository_id.clone();
    let message = params.message;
    let include_untracked = params.include_untracked;
    match run_git_action(state, &repository_id, move |root| {
        run_stash_push(root, message.as_deref(), include_untracked)
    })
    .await
    {
        Ok((repository, snapshot, _)) => response_success(
            request_id,
            GitStashPushResult {
                repository,
                snapshot,
            },
        ),
        Err(error) => ResponseEnvelope::error(request_id, error),
    }
}

async fn git_stash_pop(request_id: String, params: Value, state: &ServerState) -> ResponseEnvelope {
    let params = match parse_params::<GitStashPopParams>(params, "git.stash.pop") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }

    match run_git_action(state, &params.repository_id, run_stash_pop).await {
        Ok((repository, snapshot, _)) => response_success(
            request_id,
            GitStashPopResult {
                repository,
                snapshot,
            },
        ),
        Err(error) => ResponseEnvelope::error(request_id, error),
    }
}

async fn run_git_action<T, F>(
    state: &ServerState,
    repository_id: &str,
    operation: F,
) -> Result<(RepositorySummary, RepositorySnapshot, T), ProtocolError>
where
    T: Send + 'static,
    F: FnOnce(&str) -> Result<T, GitError> + Send + 'static,
{
    let repository = state
        .repository(repository_id)
        .await
        .ok_or_else(|| repository_not_configured_error(repository_id))?;
    let lock = state.git_mutation_lock(repository_id).await;
    let _guard = lock.lock().await;
    let operation_path = repository.operation_path.clone();
    let value = spawn_blocking(move || operation(&operation_path))
        .await
        .map_err(|error| {
            warn!(error = %error, "Git operation worker failed");
            git_failure_error("Git operation worker failed")
        })?
        .map_err(|error| {
            warn!(error = %error.message, "Git mutation failed");
            git_failure_error("Git operation failed")
        })?;
    let snapshot_repository = repository.clone();
    let snapshot = spawn_blocking(move || load_snapshot(&snapshot_repository))
        .await
        .map_err(|error| {
            warn!(error = %error, "repository refresh worker failed");
            git_failure_error("repository snapshot refresh failed")
        })?
        .map_err(|error| match error {
            RepositoryLoadError::NotFound => repository_not_found_error(),
            RepositoryLoadError::Git(error) => {
                warn!(error = %error.message, "Git snapshot refresh failed");
                git_failure_error("repository snapshot could not be refreshed")
            }
        })?;
    Ok((repository.summary, snapshot, value))
}

async fn git_commit_files(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params = match parse_params::<CommitFilesParams>(params, "git.commit_files") {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }
    if let Err(error) = validate_object_id(&params.commit_hash) {
        return ResponseEnvelope::error(request_id, error);
    }
    let Some(repository) = state.repository(&params.repository_id).await else {
        return repository_not_configured(request_id, &params.repository_id);
    };
    let cache = state.cache.clone();
    let commit_hash = params.commit_hash;
    match spawn_blocking(move || {
        load_commit_files_cached(&cache, &repository.operation_path, &commit_hash)
    })
    .await
    {
        Ok(Ok(files)) => response_success(
            request_id,
            CommitFilesResult {
                files: files.into_iter().map(protocol_commit_file).collect(),
            },
        ),
        Ok(Err(error)) => {
            warn!(error = %error.message, "commit file list operation failed");
            git_failure(request_id, "commit files could not be loaded")
        }
        Err(error) => {
            warn!(error = %error, "commit file list worker failed");
            git_failure(request_id, "commit file list worker failed")
        }
    }
}

async fn git_commit_file_diff(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params =
        match parse_params::<gitgui_protocol::CommitFileDiffParams>(params, "git.commit_file_diff")
        {
            Ok(params) => params,
            Err(error) => return ResponseEnvelope::error(request_id, error),
        };
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }
    if let Err(error) = validate_object_id(&params.commit_hash) {
        return ResponseEnvelope::error(request_id, error);
    }
    if let Some(parent_hash) = params.parent_hash.as_deref() {
        if let Err(error) = validate_object_id(parent_hash) {
            return ResponseEnvelope::error(request_id, error);
        }
    }
    if let Err(error) = validate_relative_file_path(&params.file_path) {
        return ResponseEnvelope::error(request_id, error);
    }
    let Some(repository) = state.repository(&params.repository_id).await else {
        return repository_not_configured(request_id, &params.repository_id);
    };
    let cache = state.cache.clone();
    let commit_hash = params.commit_hash;
    let parent_hash = params.parent_hash;
    let file_path = params.file_path;
    match spawn_blocking(move || {
        let files = load_commit_files_cached(&cache, &repository.operation_path, &commit_hash)
            .map_err(FileDiffLoadError::Git)?;
        let Some(file) = find_commit_file(&files, &file_path) else {
            return Err(FileDiffLoadError::MissingFile);
        };
        load_commit_file_diff_cached(
            &cache,
            &repository.operation_path,
            &commit_hash,
            parent_hash.as_deref(),
            &file,
        )
        .map_err(FileDiffLoadError::Git)
    })
    .await
    {
        Ok(Ok(diff)) => response_success(
            request_id,
            FileDiffResult {
                diff: protocol_diff(diff),
            },
        ),
        Ok(Err(FileDiffLoadError::MissingFile)) => invalid_params(
            request_id,
            "filePath is not present in the requested commit",
        ),
        Ok(Err(FileDiffLoadError::Git(error))) => {
            warn!(error = %error.message, "commit file diff operation failed");
            git_failure(request_id, "commit file diff could not be loaded")
        }
        Err(error) => {
            warn!(error = %error, "commit file diff worker failed");
            git_failure(request_id, "commit file diff worker failed")
        }
    }
}

async fn git_working_tree_file_diff(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params = match parse_params::<gitgui_protocol::WorkingTreeFileDiffParams>(
        params,
        "git.working_tree_file_diff",
    ) {
        Ok(params) => params,
        Err(error) => return ResponseEnvelope::error(request_id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }
    if let Some(head_hash) = params.head_hash.as_deref() {
        if let Err(error) = validate_object_id(head_hash) {
            return ResponseEnvelope::error(request_id, error);
        }
    }
    if let Err(error) = validate_relative_file_path(&params.file_path) {
        return ResponseEnvelope::error(request_id, error);
    }
    let Some(repository) = state.repository(&params.repository_id).await else {
        return repository_not_configured(request_id, &params.repository_id);
    };
    let file_path = params.file_path;
    let head_hash = params.head_hash;
    match spawn_blocking(move || {
        resolve_repository(&repository.operation_path).map_err(|_| StatusLoadError::NotFound)?;
        let status = load_core_repository_status(&repository.operation_path)
            .map_err(StatusLoadError::Git)?
            .status;
        let file = status
            .changed_files
            .iter()
            .find(|file| {
                file.path == file_path || file.original_path.as_deref() == Some(&file_path)
            })
            .map(core_changed_file_to_commit_file)
            .unwrap_or_else(|| CoreCommitFile {
                path: file_path.clone(),
                original_path: None,
                status: "M".to_string(),
            });
        load_core_working_tree_file_diff(&repository.operation_path, head_hash.as_deref(), &file)
            .map_err(StatusLoadError::Git)
    })
    .await
    {
        Ok(Ok(diff)) => response_success(
            request_id,
            FileDiffResult {
                diff: protocol_diff(diff),
            },
        ),
        Ok(Err(StatusLoadError::Git(error))) => {
            warn!(error = %error.message, "working tree file diff operation failed");
            git_failure(request_id, "working tree file diff could not be loaded")
        }
        Ok(Err(StatusLoadError::NotFound)) => repository_not_found(request_id),
        Err(error) => {
            warn!(error = %error, "working tree file diff worker failed");
            git_failure(request_id, "working tree file diff worker failed")
        }
    }
}

async fn git_prefetch_commit_files(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params =
        match parse_params::<PrefetchCommitFilesParams>(params, "git.prefetch_commit_files") {
            Ok(params) => params,
            Err(error) => return ResponseEnvelope::error(request_id, error),
        };
    if params.commit_hashes.len() > MAX_PREFETCH_COMMIT_HASHES {
        return invalid_params(request_id, "commitHashes exceeds the prefetch limit");
    }
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }
    for hash in &params.commit_hashes {
        if let Err(error) = validate_object_id(hash) {
            return ResponseEnvelope::error(request_id, error);
        }
    }
    let Some(repository) = state.repository(&params.repository_id).await else {
        return repository_not_configured(request_id, &params.repository_id);
    };
    let cache = state.cache.clone();
    let hashes = params.commit_hashes;
    let count = hashes.len() as u32;
    match spawn_blocking(move || {
        for hash in &hashes {
            load_commit_files_cached(&cache, &repository.operation_path, hash)?;
        }
        Ok::<(), GitError>(())
    })
    .await
    {
        Ok(Ok(())) => response_success(
            request_id,
            PrefetchCommitFilesResult {
                accepted: true,
                count,
            },
        ),
        Ok(Err(error)) => {
            warn!(error = %error.message, "commit file prefetch failed");
            git_failure(request_id, "commit file prefetch could not be completed")
        }
        Err(error) => {
            warn!(error = %error, "commit file prefetch worker failed");
            git_failure(request_id, "commit file prefetch worker failed")
        }
    }
}

async fn git_prefetch_commit_diffs(
    request_id: String,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params =
        match parse_params::<PrefetchCommitDiffsParams>(params, "git.prefetch_commit_diffs") {
            Ok(params) => params,
            Err(error) => return ResponseEnvelope::error(request_id, error),
        };
    if params.targets.len() > MAX_PREFETCH_COMMIT_DIFF_TARGETS {
        return invalid_params(request_id, "targets exceeds the prefetch limit");
    }
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(request_id, error);
    }
    for target in &params.targets {
        if let Err(error) = validate_object_id(&target.commit_hash) {
            return ResponseEnvelope::error(request_id, error);
        }
        if let Some(parent_hash) = target.parent_hash.as_deref() {
            if let Err(error) = validate_object_id(parent_hash) {
                return ResponseEnvelope::error(request_id, error);
            }
        }
        if let Err(error) = validate_relative_file_path(&target.file_path) {
            return ResponseEnvelope::error(request_id, error);
        }
    }
    let Some(repository) = state.repository(&params.repository_id).await else {
        return repository_not_configured(request_id, &params.repository_id);
    };
    let cache = state.cache.clone();
    let targets = params.targets;
    match spawn_blocking(move || {
        let mut count = 0u32;
        for target in &targets {
            let files =
                load_commit_files_cached(&cache, &repository.operation_path, &target.commit_hash)?;
            let Some(file) = find_commit_file(&files, &target.file_path) else {
                continue;
            };
            load_commit_file_diff_cached(
                &cache,
                &repository.operation_path,
                &target.commit_hash,
                target.parent_hash.as_deref(),
                &file,
            )?;
            count += 1;
        }
        Ok::<u32, GitError>(count)
    })
    .await
    {
        Ok(Ok(count)) => response_success(
            request_id,
            PrefetchCommitDiffsResult {
                accepted: true,
                count,
            },
        ),
        Ok(Err(error)) => {
            warn!(error = %error.message, "commit diff prefetch failed");
            git_failure(request_id, "commit diff prefetch could not be completed")
        }
        Err(error) => {
            warn!(error = %error, "commit diff prefetch worker failed");
            git_failure(request_id, "commit diff prefetch worker failed")
        }
    }
}

fn parse_params<T: DeserializeOwned>(params: Value, method: &str) -> Result<T, ProtocolError> {
    serde_json::from_value(params).map_err(|_| {
        ProtocolError::new(
            error_codes::INVALID_PARAMS,
            format!("{method} params are invalid"),
        )
    })
}

fn validate_repository_id(repository_id: &str) -> Result<(), ProtocolError> {
    if repository_id.trim().is_empty() || repository_id.len() > 512 {
        return Err(ProtocolError::new(
            error_codes::INVALID_PARAMS,
            "repositoryId must be a non-empty server-issued identifier",
        ));
    }
    Ok(())
}

fn validate_object_id(hash: &str) -> Result<(), ProtocolError> {
    if !(4..=64).contains(&hash.len()) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ProtocolError::new(
            error_codes::INVALID_PARAMS,
            "commit and parent hashes must be hexadecimal object IDs",
        ));
    }
    Ok(())
}

fn validate_relative_file_path(path: &str) -> Result<(), ProtocolError> {
    if path.trim().is_empty() || path.len() > 32_768 {
        return Err(ProtocolError::new(
            error_codes::INVALID_PARAMS,
            "filePath must be a non-empty repository-relative path",
        ));
    }
    let path_object = Path::new(path);
    let has_cross_platform_prefix = path.starts_with('/')
        || path.starts_with('\\')
        || path.as_bytes().get(1).is_some_and(|byte| *byte == b':');
    let has_parent_segment = path.split(['/', '\\']).any(|segment| segment == "..");
    if path.bytes().any(|byte| byte.is_ascii_control())
        || has_cross_platform_prefix
        || has_parent_segment
        || path.split(['/', '\\']).any(|segment| segment == ".git")
        || path_object.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        })
    {
        return Err(ProtocolError::new(
            error_codes::INVALID_PARAMS,
            "filePath must not be absolute, prefixed, or contain parent traversal",
        ));
    }
    Ok(())
}

fn validate_git_paths(paths: &[String]) -> Result<(), ProtocolError> {
    if paths.len() > 4096 {
        return Err(ProtocolError::new(
            error_codes::INVALID_PARAMS,
            "paths contains too many entries",
        ));
    }
    for path in paths {
        validate_relative_file_path(path)?;
    }
    Ok(())
}

fn validate_commit_text(value: &str, field: &str, max_length: usize) -> Result<(), ProtocolError> {
    if value.trim().is_empty() || value.len() > max_length || value.bytes().any(|byte| byte == 0) {
        return Err(ProtocolError::new(
            error_codes::INVALID_PARAMS,
            format!("{field} must be non-empty and no longer than {max_length} bytes"),
        ));
    }
    if value.contains('\r') || value.contains('\n') {
        return Err(ProtocolError::new(
            error_codes::INVALID_PARAMS,
            format!("{field} must be a single line"),
        ));
    }
    Ok(())
}

fn validate_optional_text(
    value: &str,
    field: &str,
    max_length: usize,
) -> Result<(), ProtocolError> {
    if value.len() > max_length || value.bytes().any(|byte| byte == 0) {
        return Err(ProtocolError::new(
            error_codes::INVALID_PARAMS,
            format!("{field} is too long or contains invalid characters"),
        ));
    }
    Ok(())
}

fn validate_branch_argument(value: &str, field: &str) -> Result<(), ProtocolError> {
    if value.trim().is_empty()
        || value.len() > 1024
        || value.starts_with('-')
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ProtocolError::new(
            error_codes::INVALID_PARAMS,
            format!("{field} is not a valid Git reference argument"),
        ));
    }
    Ok(())
}

fn build_commit_message(summary: &str, description: Option<&str>) -> String {
    let summary = summary.trim();
    match description
        .map(str::trim)
        .filter(|description| !description.is_empty())
    {
        Some(description) => format!("{summary}\n\n{description}\n"),
        None => format!("{summary}\n"),
    }
}

fn invalid_params(request_id: String, message: &str) -> ResponseEnvelope {
    ResponseEnvelope::error(
        request_id,
        ProtocolError::new(error_codes::INVALID_PARAMS, message),
    )
}

fn internal_error(request_id: String, message: &str) -> ResponseEnvelope {
    ResponseEnvelope::error(
        request_id,
        ProtocolError::new(error_codes::INTERNAL, message),
    )
}

fn git_failure(request_id: String, message: &str) -> ResponseEnvelope {
    ResponseEnvelope::error(request_id, git_failure_error(message))
}

fn git_failure_error(message: &str) -> ProtocolError {
    ProtocolError::new(error_codes::GIT_OPERATION_FAILED, message)
}

fn repository_not_found(request_id: String) -> ResponseEnvelope {
    ResponseEnvelope::error(request_id, repository_not_found_error())
}

fn repository_not_found_error() -> ProtocolError {
    ProtocolError::new(
        error_codes::REPOSITORY_NOT_FOUND,
        "configured repository could not be found or is no longer a Git repository",
    )
}

fn repository_not_configured(request_id: String, repository_id: &str) -> ResponseEnvelope {
    ResponseEnvelope::error(request_id, repository_not_configured_error(repository_id))
}

fn repository_not_configured_error(repository_id: &str) -> ProtocolError {
    ProtocolError::with_details(
        error_codes::REPOSITORY_NOT_CONFIGURED,
        "repository is not configured on this host",
        json!({ "repositoryId": repository_id }),
    )
}

fn response_success<T: Serialize>(id: String, result: T) -> ResponseEnvelope {
    ResponseEnvelope::success(id, result)
        .unwrap_or_else(|_| internal_response("unable to serialize server response"))
}

fn internal_response(message: &str) -> ResponseEnvelope {
    ResponseEnvelope::error(
        String::new(),
        ProtocolError::new(error_codes::INTERNAL, message),
    )
}

struct ServerState {
    info: ServerInfo,
    started_at: SystemTime,
    lifecycle: RwLock<ServerLifecycle>,
    repositories: RwLock<Vec<ConfiguredRepository>>,
    catalog_mutation: Mutex<()>,
    git_mutation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    data_dir: Option<PathBuf>,
    cache: SharedCommitFilesCache,
    bootstrap_token: Option<String>,
    allowed_origins: Vec<String>,
    dev_url: Option<String>,
}

#[derive(Clone, Debug)]
struct ConfiguredRepository {
    summary: RepositorySummary,
    operation_path: String,
}

#[derive(Debug)]
enum RepositoryLoadError {
    NotFound,
    Git(GitError),
}

#[derive(Debug)]
enum OpenRepositoryError {
    NotFound,
    Git(GitError),
}

#[derive(Debug)]
enum StatusLoadError {
    NotFound,
    Git(GitError),
}

#[derive(Debug)]
enum FileDiffLoadError {
    MissingFile,
    Git(GitError),
}

impl ServerState {
    fn new(
        config: &ServerConfig,
        local_addr: SocketAddr,
        repositories: Vec<ConfiguredRepository>,
    ) -> Self {
        let actual_capabilities = implemented_capabilities();
        let capabilities = config
            .capabilities
            .iter()
            .filter(|capability| {
                actual_capabilities
                    .iter()
                    .any(|actual| actual == *capability)
            })
            .cloned()
            .collect();
        Self {
            info: ServerInfo {
                server_id: config.server_id.clone(),
                protocol_version: PROTOCOL_VERSION,
                server_version: config.server_version.clone(),
                bind_address: local_addr.to_string(),
                capabilities,
            },
            started_at: SystemTime::now(),
            lifecycle: RwLock::new(ServerLifecycle::Ready),
            repositories: RwLock::new(repositories),
            catalog_mutation: Mutex::new(()),
            git_mutation_locks: Mutex::new(HashMap::new()),
            data_dir: config.data_dir.clone(),
            cache: SharedCommitFilesCache::default(),
            bootstrap_token: config
                .bootstrap_token
                .clone()
                .filter(|token| !token.is_empty()),
            allowed_origins: config.allowed_origins.clone(),
            dev_url: config.dev_url.clone(),
        }
    }

    fn authorizes_token(&self, supplied: Option<&str>) -> bool {
        match self.bootstrap_token.as_deref() {
            Some(expected) => supplied
                .map(|supplied| constant_time_equal(expected.as_bytes(), supplied.as_bytes()))
                .unwrap_or(false),
            None => true,
        }
    }

    async fn repository_summaries(&self) -> Vec<RepositorySummary> {
        self.repositories
            .read()
            .await
            .iter()
            .map(|repository| repository.summary.clone())
            .collect()
    }

    async fn repository(&self, id: &str) -> Option<ConfiguredRepository> {
        self.repositories
            .read()
            .await
            .iter()
            .find(|repository| repository.summary.id == id)
            .cloned()
    }

    async fn git_mutation_lock(&self, id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.git_mutation_locks.lock().await;
        locks
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn upsert_repository(
        &self,
        candidate: ConfiguredRepository,
    ) -> Result<ConfiguredRepository, String> {
        let _mutation = self.catalog_mutation.lock().await;
        let repository = {
            let mut repositories = self.repositories.write().await;
            if let Some(existing) = repositories.iter_mut().find(|existing| {
                path_key(&existing.summary.root) == path_key(&candidate.summary.root)
            }) {
                existing.summary.path = candidate.summary.path.clone();
                existing.summary.root = candidate.summary.root.clone();
                existing.operation_path = candidate.operation_path.clone();
                existing.clone()
            } else {
                repositories.push(candidate.clone());
                candidate
            }
        };

        self.persist_catalog().await?;
        Ok(repository)
    }

    async fn persist_catalog(&self) -> Result<(), String> {
        let Some(data_dir) = self.data_dir.clone() else {
            return Ok(());
        };
        let entries = self
            .repositories
            .read()
            .await
            .iter()
            .map(PersistedRepository::from_configured)
            .collect::<Vec<_>>();
        spawn_blocking(move || write_catalog(&data_dir, &entries))
            .await
            .map_err(|error| format!("catalog writer failed: {error}"))??;
        Ok(())
    }

    async fn set_lifecycle(&self, lifecycle: ServerLifecycle) {
        *self.lifecycle.write().await = lifecycle;
    }

    async fn lifecycle(&self) -> ServerLifecycle {
        *self.lifecycle.read().await
    }

    async fn readiness(&self) -> ServerReadiness {
        let lifecycle = self.lifecycle().await;
        ServerReadiness {
            ready: lifecycle == ServerLifecycle::Ready,
            lifecycle,
            server_id: self.info.server_id.clone(),
            protocol_version: self.info.protocol_version,
        }
    }

    async fn status(&self) -> ServerStatus {
        let lifecycle = self.lifecycle().await;
        ServerStatus {
            ready: lifecycle == ServerLifecycle::Ready,
            lifecycle,
            server_id: self.info.server_id.clone(),
            protocol_version: self.info.protocol_version,
            uptime_seconds: self
                .started_at
                .elapsed()
                .unwrap_or(Duration::ZERO)
                .as_secs(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PersistedServerIdentity {
    schema_version: u32,
    server_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PersistedRepository {
    schema_version: u32,
    id: String,
    path: String,
    root: String,
}

impl PersistedRepository {
    fn from_configured(repository: &ConfiguredRepository) -> Self {
        Self {
            schema_version: PERSISTENCE_SCHEMA_VERSION,
            id: repository.summary.id.clone(),
            path: repository.summary.path.clone(),
            root: repository.summary.root.clone(),
        }
    }

    fn into_configured(self) -> Option<ConfiguredRepository> {
        if self.schema_version != PERSISTENCE_SCHEMA_VERSION
            || self.id.trim().is_empty()
            || self.root.trim().is_empty()
        {
            return None;
        }
        let root = canonicalize_path(&self.root);
        Some(ConfiguredRepository {
            summary: RepositorySummary {
                id: self.id,
                path: if self.path.trim().is_empty() {
                    root.clone()
                } else {
                    canonicalize_path(&self.path)
                },
                root: root.clone(),
            },
            operation_path: root,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
struct PersistedCatalog<'a> {
    schema_version: u32,
    repositories: &'a [PersistedRepository],
}

struct StartupState {
    server_id: String,
    repositories: Vec<ConfiguredRepository>,
}

async fn prepare_startup(config: &ServerConfig) -> Result<StartupState, String> {
    let config = config.clone();
    spawn_blocking(move || load_startup_state(&config))
        .await
        .map_err(|error| format!("startup worker failed: {error}"))?
}

fn load_startup_state(config: &ServerConfig) -> Result<StartupState, String> {
    let Some(data_dir) = config.data_dir.clone() else {
        return Ok(StartupState {
            server_id: config.server_id.clone(),
            repositories: build_repository_catalog(&config.repository_paths),
        });
    };

    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("could not create server data directory: {error}"))?;
    let identity_path = data_dir.join(SERVER_ID_FILE);
    let server_id = read_json::<PersistedServerIdentity>(&identity_path)
        .ok()
        .filter(|identity| {
            identity.schema_version == PERSISTENCE_SCHEMA_VERSION
                && !identity.server_id.trim().is_empty()
        })
        .map(|identity| identity.server_id)
        .unwrap_or_else(generate_server_id);
    let identity = PersistedServerIdentity {
        schema_version: PERSISTENCE_SCHEMA_VERSION,
        server_id: server_id.clone(),
    };
    write_json_atomically(&identity_path, &identity)
        .map_err(|error| format!("could not persist server identity: {error}"))?;

    let catalog_path = data_dir.join(REPOSITORY_CATALOG_FILE);
    let mut repositories = read_json::<PersistedCatalogOwned>(&catalog_path)
        .ok()
        .filter(|catalog| catalog.schema_version == PERSISTENCE_SCHEMA_VERSION)
        .map(|catalog| {
            catalog
                .repositories
                .into_iter()
                .filter_map(PersistedRepository::into_configured)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut changed = !catalog_path.exists();
    for path in &config.repository_paths {
        match resolve_repository(path) {
            Ok(info) => {
                let candidate = configured_from_repository_info(&info);
                changed |= upsert_catalog_entry(&mut repositories, candidate);
            }
            Err(error) => {
                warn!(error = %error.message, "ignoring configured path that is not a Git repository")
            }
        }
    }
    if changed {
        write_catalog(
            &data_dir,
            &repositories
                .iter()
                .map(PersistedRepository::from_configured)
                .collect::<Vec<_>>(),
        )?;
    }

    Ok(StartupState {
        server_id,
        repositories,
    })
}

#[derive(Debug, Deserialize)]
struct PersistedCatalogOwned {
    schema_version: u32,
    repositories: Vec<PersistedRepository>,
}

fn build_repository_catalog(paths: &[String]) -> Vec<ConfiguredRepository> {
    let mut repositories = Vec::new();
    for path in paths {
        match resolve_repository(path) {
            Ok(info) => {
                upsert_catalog_entry(&mut repositories, configured_from_repository_info(&info));
            }
            Err(error) => {
                warn!(error = %error.message, "ignoring configured path that is not a Git repository")
            }
        }
    }
    repositories
}

fn configured_from_repository_info(
    info: &gitgui_core::git::repository::RepositoryInfo,
) -> ConfiguredRepository {
    let path = canonicalize_path(&info.path);
    let root = canonicalize_path(&info.root);
    ConfiguredRepository {
        summary: RepositorySummary {
            id: stable_repository_id(&root),
            path,
            root: root.clone(),
        },
        operation_path: root,
    }
}

fn upsert_catalog_entry(
    repositories: &mut Vec<ConfiguredRepository>,
    candidate: ConfiguredRepository,
) -> bool {
    if let Some(existing) = repositories
        .iter_mut()
        .find(|existing| path_key(&existing.summary.root) == path_key(&candidate.summary.root))
    {
        let changed = existing.summary.path != candidate.summary.path
            || existing.summary.root != candidate.summary.root
            || existing.operation_path != candidate.operation_path;
        existing.summary.path = candidate.summary.path;
        existing.summary.root = candidate.summary.root;
        existing.operation_path = candidate.operation_path;
        return changed;
    }
    repositories.push(candidate);
    true
}

fn write_catalog(data_dir: &Path, repositories: &[PersistedRepository]) -> Result<(), String> {
    fs::create_dir_all(data_dir)
        .map_err(|error| format!("could not create catalog directory: {error}"))?;
    let path = data_dir.join(REPOSITORY_CATALOG_FILE);
    let catalog = PersistedCatalog {
        schema_version: PERSISTENCE_SCHEMA_VERSION,
        repositories,
    };
    write_json_atomically(&path, &catalog)
        .map_err(|error| format!("could not persist repository catalog: {error}"))
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, io::Error> {
    let contents = fs::read_to_string(path)?;
    serde_json::from_str(&contents)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), io::Error> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("gitgui-data");
    let temporary_path = parent.join(format!(".{file_name}.tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    replace_file_atomically(&temporary_path, path)
}

fn replace_file_atomically(source: &Path, destination: &Path) -> Result<(), io::Error> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let source_path = source.to_path_buf();
        let source = source
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe extern "system" {
            fn MoveFileExW(
                existing_file_name: *const u16,
                new_file_name: *const u16,
                flags: u32,
            ) -> i32;
        }
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
        let result = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            let error = io::Error::last_os_error();
            let _ = fs::remove_file(source_path);
            return Err(error);
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
    }
}

fn canonicalize_path(path: &str) -> String {
    let candidate = Path::new(path);
    let canonical = fs::canonicalize(candidate).unwrap_or_else(|_| {
        if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(candidate)
        }
    });
    canonical.to_string_lossy().into_owned()
}

fn path_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.replace('/', "\\").to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

fn stable_repository_id(root: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in path_key(root).as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("repo-{hash:016x}")
}

fn parse_ip(value: &str) -> Result<IpAddr, ConfigError> {
    value.parse().map_err(|_| ConfigError::InvalidBind {
        value: value.to_string(),
    })
}

fn parse_port(value: &str) -> Result<u16, ConfigError> {
    value.parse().map_err(|_| ConfigError::InvalidPort {
        value: value.to_string(),
    })
}

fn parse_data_dir(value: &str) -> Result<PathBuf, ConfigError> {
    if value.trim().is_empty() {
        return Err(ConfigError::InvalidDataDir {
            value: value.to_string(),
        });
    }
    Ok(PathBuf::from(value))
}

fn parse_web_dir(value: &str) -> Result<PathBuf, ConfigError> {
    if value.trim().is_empty() {
        return Err(ConfigError::InvalidWebDir {
            value: value.to_string(),
        });
    }
    Ok(PathBuf::from(value))
}

fn parse_dev_url(value: &str) -> Result<String, ConfigError> {
    let value = value.trim();
    if value.is_empty()
        || value.contains('#')
        || value.chars().any(char::is_whitespace)
        || !(value.starts_with("http://") || value.starts_with("https://"))
    {
        return Err(ConfigError::InvalidDevUrl {
            value: value.to_string(),
        });
    }
    Ok(value.to_string())
}

fn resolve_web_dir(config: &ServerConfig) -> Result<Option<PathBuf>, String> {
    let candidates = if let Some(web_dir) = config.web_dir.clone() {
        vec![web_dir]
    } else {
        let current_dir = env::current_dir()
            .map_err(|error| format!("could not determine the current directory: {error}"))?;
        vec![current_dir.join("build"), current_dir]
    };

    for candidate in candidates {
        let index_file = candidate.join("index.html");
        if candidate.is_dir() && index_file.is_file() {
            return Ok(Some(candidate));
        }
    }

    if let Some(web_dir) = &config.web_dir {
        return Err(format!(
            "configured web directory does not contain index.html: {}",
            web_dir.display()
        ));
    }

    Ok(None)
}

fn generate_server_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    format!("gitgui-{}-{timestamp}", std::process::id())
}

fn implemented_capabilities() -> Vec<String> {
    [
        CAPABILITY_SERVER_INFO,
        CAPABILITY_SERVER_STATUS,
        CAPABILITY_REPOSITORIES_LIST,
        CAPABILITY_REPOSITORIES_OPEN,
        CAPABILITY_REPOSITORIES_GET_SNAPSHOT,
        CAPABILITY_REPOSITORIES_REFRESH,
        CAPABILITY_GIT_STATUS,
        CAPABILITY_GIT_COMMIT_FILES,
        CAPABILITY_GIT_COMMIT_FILE_DIFF,
        CAPABILITY_GIT_WORKING_TREE_FILE_DIFF,
        CAPABILITY_GIT_PREFETCH_COMMIT_FILES,
        CAPABILITY_GIT_PREFETCH_COMMIT_DIFFS,
        CAPABILITY_GIT_STAGE,
        CAPABILITY_GIT_UNSTAGE,
        CAPABILITY_GIT_COMMIT,
        CAPABILITY_GIT_FETCH,
        CAPABILITY_GIT_PULL,
        CAPABILITY_GIT_PUSH,
        CAPABILITY_GIT_BRANCH_LIST,
        CAPABILITY_GIT_BRANCH_CREATE,
        CAPABILITY_GIT_BRANCH_SWITCH,
        CAPABILITY_GIT_STASH_PUSH,
        CAPABILITY_GIT_STASH_POP,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn load_open_repository(
    path: &str,
) -> Result<(ConfiguredRepository, CoreRepositorySnapshot), OpenRepositoryError> {
    let info = resolve_repository(path).map_err(|_| OpenRepositoryError::NotFound)?;
    let root = canonicalize_path(&info.root);
    let snapshot = load_core_repository(&root).map_err(OpenRepositoryError::Git)?;
    let candidate = ConfiguredRepository {
        summary: RepositorySummary {
            id: stable_repository_id(&root),
            path: canonicalize_path(&info.path),
            root: root.clone(),
        },
        operation_path: root,
    };
    Ok((candidate, snapshot))
}

fn load_snapshot(
    repository: &ConfiguredRepository,
) -> Result<RepositorySnapshot, RepositoryLoadError> {
    resolve_repository(&repository.operation_path).map_err(|_| RepositoryLoadError::NotFound)?;
    let snapshot =
        load_core_repository(&repository.operation_path).map_err(RepositoryLoadError::Git)?;
    Ok(normalize_snapshot(
        protocol_snapshot(snapshot, &repository.summary),
        &repository.summary,
    ))
}

fn load_status(repository: &ConfiguredRepository) -> Result<CoreRepositoryStatus, StatusLoadError> {
    resolve_repository(&repository.operation_path).map_err(|_| StatusLoadError::NotFound)?;
    load_core_repository_status(&repository.operation_path)
        .map(|snapshot| snapshot.status)
        .map_err(StatusLoadError::Git)
}

fn protocol_snapshot(
    snapshot: CoreRepositorySnapshot,
    summary: &RepositorySummary,
) -> RepositorySnapshot {
    RepositorySnapshot {
        info: ProtocolRepositoryInfo {
            path: summary.path.clone(),
            root: summary.root.clone(),
        },
        status: protocol_status(snapshot.status),
        commits: snapshot
            .commits
            .into_iter()
            .map(protocol_commit_info)
            .collect(),
        graph: ProtocolCommitGraph {
            commits: snapshot
                .graph
                .commits
                .into_iter()
                .map(protocol_graph_commit)
                .collect(),
            edges: snapshot
                .graph
                .edges
                .into_iter()
                .map(protocol_graph_edge)
                .collect(),
            width: snapshot.graph.width,
            head_lane: snapshot.graph.head_lane,
        },
        refs: snapshot.refs.into_iter().map(protocol_commit_ref).collect(),
        stashes: snapshot
            .stashes
            .into_iter()
            .map(protocol_stash_info)
            .collect(),
    }
}

fn normalize_snapshot(
    mut snapshot: RepositorySnapshot,
    summary: &RepositorySummary,
) -> RepositorySnapshot {
    snapshot.info.path = summary.path.clone();
    snapshot.info.root = summary.root.clone();
    snapshot
}

fn protocol_status(status: CoreRepositoryStatus) -> ProtocolRepositoryStatus {
    ProtocolRepositoryStatus {
        current_branch: status.current_branch,
        head_oid: status.head_oid,
        ahead: status.ahead,
        behind: status.behind,
        changed_files: status
            .changed_files
            .into_iter()
            .map(protocol_changed_file)
            .collect(),
    }
}

fn protocol_changed_file(file: CoreChangedFile) -> ProtocolChangedFile {
    ProtocolChangedFile {
        path: file.path,
        original_path: file.original_path,
        index_status: file.index_status,
        worktree_status: file.worktree_status,
    }
}

fn protocol_commit_info(commit: gitgui_core::git::repository::CommitInfo) -> ProtocolCommitInfo {
    ProtocolCommitInfo {
        hash: commit.hash,
        parents: commit.parents,
        author: commit.author,
        timestamp: commit.timestamp,
        message: commit.message,
    }
}

fn protocol_stash_info(stash: gitgui_core::git::repository::StashInfo) -> ProtocolStashInfo {
    ProtocolStashInfo {
        hash: stash.hash,
        selector: stash.selector,
        base_hash: stash.base_hash,
        index_hash: stash.index_hash,
        branch: stash.branch,
        message: stash.message,
        timestamp: stash.timestamp,
    }
}

fn protocol_graph_commit(commit: gitgui_core::git::repository::GraphCommit) -> ProtocolGraphCommit {
    ProtocolGraphCommit {
        hash: commit.hash,
        row: commit.row,
        lane: commit.lane,
    }
}

fn protocol_graph_edge(edge: gitgui_core::git::repository::GraphEdge) -> ProtocolGraphEdge {
    ProtocolGraphEdge {
        from: edge.from,
        to: edge.to,
        edge_type: match edge.edge_type {
            gitgui_core::git::repository::GraphEdgeType::Normal => ProtocolGraphEdgeType::Normal,
            gitgui_core::git::repository::GraphEdgeType::Merge => ProtocolGraphEdgeType::Merge,
        },
    }
}

fn protocol_commit_ref(reference: gitgui_core::git::repository::CommitRef) -> ProtocolCommitRef {
    ProtocolCommitRef {
        name: reference.name,
        short_name: reference.short_name,
        target: reference.target,
        ref_type: match reference.ref_type {
            gitgui_core::git::repository::CommitRefType::LocalBranch => {
                ProtocolCommitRefType::LocalBranch
            }
            gitgui_core::git::repository::CommitRefType::RemoteBranch => {
                ProtocolCommitRefType::RemoteBranch
            }
            gitgui_core::git::repository::CommitRefType::Tag => ProtocolCommitRefType::Tag,
        },
    }
}

fn protocol_commit_file(file: CoreCommitFile) -> ProtocolCommitFile {
    ProtocolCommitFile {
        path: file.path,
        original_path: file.original_path,
        status: file.status,
    }
}

fn protocol_diff(diff: CoreCommitFileDiff) -> ProtocolCommitFileDiff {
    ProtocolCommitFileDiff {
        original_path: diff.original_path,
        modified_path: diff.modified_path,
        original_content: diff.original_content,
        modified_content: diff.modified_content,
        is_binary: diff.is_binary,
        message: diff.message,
    }
}

fn core_changed_file_to_commit_file(file: &CoreChangedFile) -> CoreCommitFile {
    let status = first_non_blank_status(&file.index_status)
        .or_else(|| first_non_blank_status(&file.worktree_status))
        .unwrap_or('M');
    CoreCommitFile {
        path: file.path.clone(),
        original_path: file.original_path.clone(),
        status: status.to_string(),
    }
}

fn first_non_blank_status(status: &str) -> Option<char> {
    status
        .chars()
        .find(|character| !character.is_whitespace() && *character != '.')
}

fn find_commit_file(files: &[CoreCommitFile], requested_path: &str) -> Option<CoreCommitFile> {
    files
        .iter()
        .find(|file| {
            file.path == requested_path || file.original_path.as_deref() == Some(requested_path)
        })
        .cloned()
}

fn commit_file_diff_key(
    repo_root: &str,
    commit_hash: &str,
    parent_hash: Option<&str>,
    file: &CoreCommitFile,
) -> CommitFileDiffKey {
    CommitFileDiffKey {
        repo_root: repo_root.to_string(),
        commit_hash: commit_hash.to_string(),
        parent_hash: parent_hash.map(ToString::to_string),
        path: file.path.clone(),
        original_path: file.original_path.clone(),
        status: file.status.clone(),
    }
}

fn load_commit_files_cached(
    cache: &SharedCommitFilesCache,
    repo_root: &str,
    commit_hash: &str,
) -> Result<Vec<CoreCommitFile>, GitError> {
    let key = CommitFilesKey {
        repo_root: repo_root.to_string(),
        commit_hash: commit_hash.to_string(),
    };
    if let Some(files) = cache.lock().map_err(cache_error)?.get(&key) {
        return Ok(files);
    }
    let files = load_core_commit_files(repo_root, commit_hash)?;
    cache
        .lock()
        .map_err(cache_error)?
        .insert_recent(key, files.clone());
    Ok(files)
}

fn load_commit_file_diff_cached(
    cache: &SharedCommitFilesCache,
    repo_root: &str,
    commit_hash: &str,
    parent_hash: Option<&str>,
    file: &CoreCommitFile,
) -> Result<CoreCommitFileDiff, GitError> {
    let key = commit_file_diff_key(repo_root, commit_hash, parent_hash, file);
    let lookup = {
        let mut cache = cache.lock().map_err(cache_error)?;
        cache.get_or_start_diff(&key)
    };
    match lookup {
        CommitFileDiffLookup::Cached(diff) => Ok(diff),
        CommitFileDiffLookup::Loading(in_flight) => wait_for_diff_load(in_flight),
        CommitFileDiffLookup::StartLoad => {
            let result = load_core_commit_file_diff(repo_root, commit_hash, parent_hash, file);
            cache
                .lock()
                .map_err(cache_error)?
                .finish_diff_load(&key, result.clone());
            result
        }
    }
}

fn wait_for_diff_load(in_flight: InFlightCommitFileDiff) -> Result<CoreCommitFileDiff, GitError> {
    let (state, ready) = &*in_flight;
    let mut state = state.lock().map_err(|_| GitError {
        message: "commit file diff load state is unavailable".to_string(),
        stderr: String::new(),
        status: None,
    })?;
    while state.is_none() {
        state = ready.wait(state).map_err(|_| GitError {
            message: "commit file diff load state is unavailable".to_string(),
            stderr: String::new(),
            status: None,
        })?;
    }
    state.clone().expect("diff load state should be ready")
}

fn cache_error<T>(_error: std::sync::PoisonError<T>) -> GitError {
    GitError {
        message: "Git read cache is unavailable".to_string(),
        stderr: String::new(),
        status: None,
    }
}

fn parse_origin_list(value: &str) -> Result<Vec<String>, ConfigError> {
    let mut origins = Vec::new();
    append_origin_list(&mut origins, value)?;
    if origins.is_empty() {
        return Err(ConfigError::InvalidOrigin {
            value: value.to_string(),
        });
    }
    Ok(origins)
}

fn append_origin_list(origins: &mut Vec<String>, value: &str) -> Result<(), ConfigError> {
    for raw_origin in value.split(',') {
        let origin = raw_origin.trim();
        if origin.is_empty() || origin.contains('*') || origin.chars().any(char::is_whitespace) {
            return Err(ConfigError::InvalidOrigin {
                value: origin.to_string(),
            });
        }
        if !origins.iter().any(|known| known == origin) {
            origins.push(origin.to_string());
        }
    }
    Ok(())
}

fn validate_bind_security(config: &ServerConfig) -> Result<(), String> {
    if !config.bind_addr.ip().is_loopback() && !has_bootstrap_token(config) {
        return Err(
            "non-loopback binding requires GITGUI_SERVER_BOOTSTRAP_TOKEN authentication"
                .to_string(),
        );
    }
    if config
        .allowed_origins
        .iter()
        .any(|origin| origin.contains('*'))
    {
        return Err(
            "allowed origins must be exact values; wildcards are not supported".to_string(),
        );
    }
    Ok(())
}

fn has_bootstrap_token(config: &ServerConfig) -> bool {
    config
        .bootstrap_token
        .as_deref()
        .is_some_and(|token| !token.is_empty())
}

fn log_bind_address(local_addr: SocketAddr, config: &ServerConfig) {
    if !config.bind_addr.ip().is_loopback() {
        if has_bootstrap_token(config) {
            info!(address = %local_addr, "GitGui server listening with bootstrap authentication");
            return;
        }
        warn!(address = %local_addr, "GitGui server is listening without authentication; loopback-only development mode is active");
    } else if !has_bootstrap_token(config) {
        warn!("GitGui server is listening on loopback without authentication; use only for explicit local development");
    }
    info!(address = %local_addr, "GitGui server listening");
}

fn constant_time_equal(expected: &[u8], supplied: &[u8]) -> bool {
    let mut difference = expected.len() ^ supplied.len();
    let length = expected.len().max(supplied.len());
    for index in 0..length {
        difference |= usize::from(
            expected.get(index).copied().unwrap_or(0) ^ supplied.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn emit_ready_line(local_addr: SocketAddr) {
    let payload = json!({ "address": local_addr.to_string() });
    println!("{}{}", SERVER_READY_LINE_PREFIX, payload);
    let _ = std::io::Write::flush(&mut std::io::stdout());
}

async fn send_json<T>(socket: &mut WebSocket, value: &T) -> Result<(), ()>
where
    T: Serialize,
{
    let text = serde_json::to_string(value).map_err(|error| {
        warn!(error = %error, "failed to serialize WebSocket response");
    })?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|error| {
            warn!(error = %error, "WebSocket client disconnected while sending");
        })
}

async fn shutdown_signal(state: Arc<ServerState>) {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install terminate signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    state.set_lifecycle(ServerLifecycle::Stopping).await;
}
