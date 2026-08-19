use gitgui_protocol::{ServerInfo, ServerLifecycle, ServerReadiness, PROTOCOL_VERSION};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    env,
    fmt::{self, Display, Formatter},
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};

const SERVER_BINARY_ENV: &str = "GITGUI_SERVER_BIN";
const SERVER_BOOTSTRAP_TOKEN_ENV: &str = "GITGUI_SERVER_BOOTSTRAP_TOKEN";
const SERVER_ALLOWED_ORIGINS_ENV: &str = "GITGUI_SERVER_ALLOWED_ORIGINS";
const SERVER_DEV_URL_ENV: &str = "GITGUI_SERVER_DEV_URL";
const TAURI_ALLOWED_ORIGINS: &str =
    "http://localhost:1420,http://127.0.0.1:1420,http://tauri.localhost,tauri://localhost";
const SERVER_READY_LINE_PREFIX: &str = "GITGUI_SERVER_READY=";
const SERVER_READY_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_HTTP_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_DIAGNOSTIC_LINE_BYTES: usize = 4096;

pub type SharedLocalServerManager = Arc<Mutex<LocalServerManager>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerConnection {
    pub http_url: String,
    pub websocket_url: String,
    pub session_token: String,
    pub server_id: String,
    pub protocol_version: u32,
    pub capabilities: Vec<String>,
}

pub struct LocalServerManager {
    child: Option<ManagedServer>,
    connection: Option<LocalServerConnection>,
    server_data_dir: Option<PathBuf>,
    last_error: Option<String>,
}

impl Default for LocalServerManager {
    fn default() -> Self {
        Self {
            child: None,
            connection: None,
            server_data_dir: None,
            last_error: None,
        }
    }
}

impl LocalServerManager {
    pub fn configure(&mut self, server_data_dir: PathBuf) -> Result<(), String> {
        if self.child.is_some() {
            return Err(
                "Cannot configure the local server data directory while the server is running."
                    .to_string(),
            );
        }

        fs::create_dir_all(&server_data_dir).map_err(|error| {
            format!(
                "failed to create local GitGui server data directory {}: {error}",
                server_data_dir.display()
            )
        })?;

        if !server_data_dir.is_dir() {
            return Err(format!(
                "local GitGui server data path is not a directory: {}",
                server_data_dir.display()
            ));
        }

        self.server_data_dir = Some(server_data_dir);
        Ok(())
    }

    pub fn start(&mut self) -> Result<LocalServerConnection, String> {
        let server_data_dir = self.server_data_dir.clone().ok_or_else(|| {
            "The local GitGui server data directory is not configured. Desktop setup must configure it before starting or restarting the server.".to_string()
        })?;

        if let Err(error) = self.stop_owned() {
            self.connection = None;
            self.last_error = Some(error.clone());
            return Err(error);
        }

        self.connection = None;
        match start_server_process(&server_data_dir) {
            Ok((child, connection)) => {
                self.child = Some(child);
                self.connection = Some(connection.clone());
                self.last_error = None;
                Ok(connection)
            }
            Err(error) => {
                let message = error.to_string();
                self.last_error = Some(message.clone());
                Err(message)
            }
        }
    }

    pub fn connection(&self) -> Result<LocalServerConnection, String> {
        self.connection.clone().ok_or_else(|| {
            self.last_error.clone().unwrap_or_else(|| {
                "The local GitGui server is not running. Use restart_local_server to try again."
                    .to_string()
            })
        })
    }

    pub fn shutdown(&mut self) -> Result<(), String> {
        self.connection = None;
        self.stop_owned()
    }

    fn stop_owned(&mut self) -> Result<(), String> {
        let Some(child) = self.child.take() else {
            return Ok(());
        };

        child.shutdown()
    }
}

impl Drop for LocalServerManager {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            eprintln!("[gitgui] failed to stop owned local server during shutdown: {error}");
        }
    }
}

pub fn new_shared() -> SharedLocalServerManager {
    Arc::new(Mutex::new(LocalServerManager::default()))
}

pub fn start_shared(manager: &SharedLocalServerManager) -> Result<LocalServerConnection, String> {
    let mut manager = manager
        .lock()
        .map_err(|_| "Local server manager state is unavailable.".to_string())?;
    manager.start()
}

pub fn configure_shared(
    manager: &SharedLocalServerManager,
    server_data_dir: PathBuf,
) -> Result<(), String> {
    let mut manager = manager
        .lock()
        .map_err(|_| "Local server manager state is unavailable.".to_string())?;
    manager.configure(server_data_dir)
}

pub fn connection_shared(
    manager: &SharedLocalServerManager,
) -> Result<LocalServerConnection, String> {
    let manager = manager
        .lock()
        .map_err(|_| "Local server manager state is unavailable.".to_string())?;
    manager.connection()
}

pub fn restart_shared(manager: &SharedLocalServerManager) -> Result<LocalServerConnection, String> {
    start_shared(manager)
}

pub fn shutdown_shared(manager: &SharedLocalServerManager) -> Result<(), String> {
    let mut manager = manager
        .lock()
        .map_err(|_| "Local server manager state is unavailable.".to_string())?;
    manager.shutdown()
}

struct ManagedServer {
    pid: u32,
    child: Child,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
}

impl ManagedServer {
    fn shutdown(mut self) -> Result<(), String> {
        let pid = self.pid;
        let mut shutdown_error = None;

        match self.child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                if let Err(error) = self.child.kill() {
                    if error.kind() != io::ErrorKind::InvalidInput {
                        shutdown_error =
                            Some(format!("failed to stop local server {pid}: {error}"));
                    }
                }

                if let Err(error) = self.child.wait() {
                    shutdown_error =
                        Some(format!("failed to wait for local server {pid}: {error}"));
                }
            }
            Err(error) => {
                shutdown_error = Some(format!("failed to inspect local server {pid}: {error}"));
                if let Err(kill_error) = self.child.kill() {
                    shutdown_error = Some(format!(
                        "failed to inspect local server {pid}: {error}; failed to stop it: {kill_error}"
                    ));
                } else if let Err(wait_error) = self.child.wait() {
                    shutdown_error = Some(format!(
                        "failed to inspect local server {pid}: {error}; failed to wait for it: {wait_error}"
                    ));
                }
            }
        }

        join_output_thread(self.stdout_thread.take(), "stdout", &mut shutdown_error);
        join_output_thread(self.stderr_thread.take(), "stderr", &mut shutdown_error);

        shutdown_error.map_or(Ok(()), Err)
    }
}

fn join_output_thread(
    thread: Option<JoinHandle<()>>,
    stream_name: &str,
    shutdown_error: &mut Option<String>,
) {
    if let Some(thread) = thread {
        if thread.join().is_err() && shutdown_error.is_none() {
            *shutdown_error = Some(format!(
                "local server {stream_name} diagnostics thread panicked"
            ));
        }
    }
}

#[derive(Debug)]
enum StartError {
    Executable(String),
    Spawn(io::Error),
    MissingStdout,
    MissingStderr,
    Readiness(String),
    Probe(String),
    Protocol(String),
}

impl Display for StartError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Executable(message) => write!(formatter, "{message}"),
            Self::Spawn(error) => write!(formatter, "failed to start local GitGui server: {error}"),
            Self::MissingStdout => formatter
                .write_str("local GitGui server did not provide stdout for readiness detection"),
            Self::MissingStderr => {
                formatter.write_str("local GitGui server did not provide stderr for diagnostics")
            }
            Self::Readiness(message) => {
                write!(formatter, "local GitGui server readiness failed: {message}")
            }
            Self::Probe(message) => write!(
                formatter,
                "local GitGui server readiness probe failed: {message}"
            ),
            Self::Protocol(message) => write!(
                formatter,
                "local GitGui server protocol check failed: {message}"
            ),
        }
    }
}

impl std::error::Error for StartError {}

#[derive(Debug, Deserialize)]
struct ReadyAnnouncement {
    address: String,
}

fn start_server_process(
    server_data_dir: &Path,
) -> Result<(ManagedServer, LocalServerConnection), StartError> {
    let executable = locate_server_executable()?;
    let session_token = generate_session_token();
    let server_port = if cfg!(debug_assertions) { "3774" } else { "0" };
    let mut command = Command::new(&executable);
    command
        .arg("--bind")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(server_port)
        .arg("--data-dir")
        .arg(server_data_dir)
        .env(SERVER_BOOTSTRAP_TOKEN_ENV, &session_token)
        .env(SERVER_ALLOWED_ORIGINS_ENV, TAURI_ALLOWED_ORIGINS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if cfg!(debug_assertions) {
        command.env(SERVER_DEV_URL_ENV, "http://localhost:1420");
    }

    let mut child = command.spawn().map_err(StartError::Spawn)?;
    let pid = child.id();
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(StartError::MissingStdout);
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(StartError::MissingStderr);
        }
    };
    let (ready_sender, ready_receiver) = mpsc::channel();

    let stdout_thread = match spawn_stdout_drain(stdout, ready_sender) {
        Ok(thread) => thread,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(StartError::Readiness(format!(
                "failed to start stdout diagnostics: {error}"
            )));
        }
    };
    let stderr_thread = match spawn_stderr_drain(stderr) {
        Ok(thread) => thread,
        Err(error) => {
            let owned = ManagedServer {
                pid,
                child,
                stdout_thread: Some(stdout_thread),
                stderr_thread: None,
            };
            let _ = owned.shutdown();
            return Err(StartError::Readiness(format!(
                "failed to start stderr diagnostics: {error}"
            )));
        }
    };

    let managed = ManagedServer {
        pid,
        child,
        stdout_thread: Some(stdout_thread),
        stderr_thread: Some(stderr_thread),
    };

    let announcement = match ready_receiver.recv_timeout(SERVER_READY_TIMEOUT) {
        Ok(Ok(announcement)) => announcement,
        Ok(Err(error)) => {
            let _ = managed.shutdown();
            return Err(StartError::Readiness(error));
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = managed.shutdown();
            return Err(StartError::Readiness(format!(
                "did not receive {SERVER_READY_LINE_PREFIX} within {} seconds",
                SERVER_READY_TIMEOUT.as_secs()
            )));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = managed.shutdown();
            return Err(StartError::Readiness(
                "server stdout closed before readiness was reported".to_string(),
            ));
        }
    };

    let address = match parse_loopback_address(&announcement.address) {
        Ok(address) => address,
        Err(error) => {
            let _ = managed.shutdown();
            return Err(StartError::Readiness(error));
        }
    };

    let readiness = match probe_json::<ServerReadiness>(address, "/ready") {
        Ok(readiness) => readiness,
        Err(error) => {
            let _ = managed.shutdown();
            return Err(StartError::Probe(error));
        }
    };

    if let Err(error) = validate_readiness(&readiness) {
        let _ = managed.shutdown();
        return Err(StartError::Protocol(error));
    }

    let info = match probe_json::<ServerInfo>(address, "/info") {
        Ok(info) => info,
        Err(error) => {
            let _ = managed.shutdown();
            return Err(StartError::Probe(error));
        }
    };

    if let Err(error) = validate_info(&readiness, &info) {
        let _ = managed.shutdown();
        return Err(StartError::Protocol(error));
    }

    let http_url = format_http_url(address);
    let connection = LocalServerConnection {
        websocket_url: http_url.replacen("http://", "ws://", 1) + "/ws",
        session_token,
        http_url,
        server_id: info.server_id,
        protocol_version: info.protocol_version,
        capabilities: info.capabilities,
    };

    Ok((managed, connection))
}

fn generate_session_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    token
}

fn locate_server_executable() -> Result<PathBuf, StartError> {
    if let Some(override_path) = env::var_os(SERVER_BINARY_ENV).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(override_path);
        if path.is_file() {
            return Ok(path);
        }
        return Err(StartError::Executable(format!(
            "{SERVER_BINARY_ENV} points to a missing server executable: {}",
            path.display()
        )));
    }

    let names = server_executable_names();
    let mut candidates = Vec::new();

    if let Ok(desktop_executable) = env::current_exe() {
        if let Some(parent) = desktop_executable.parent() {
            candidates.extend(names.iter().map(|name| parent.join(name)));
        }
    }

    for root in workspace_roots() {
        candidates.extend(
            names
                .iter()
                .map(|name| root.join("target").join("debug").join(name)),
        );
        candidates.extend(
            names
                .iter()
                .map(|name| root.join("target").join("release").join(name)),
        );
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            StartError::Executable(format!(
                "could not locate gitgui-server; set {SERVER_BINARY_ENV} or build the sibling/development server executable"
            ))
        })
}

fn server_executable_names() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        &["gitgui-server.exe", "gitgui-server"]
    }

    #[cfg(not(windows))]
    {
        &["gitgui-server"]
    }
}

fn workspace_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for start in [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    ] {
        if let Some(root) = find_workspace_root(&start) {
            if !roots.iter().any(|known| known == &root) {
                roots.push(root);
            }
        }
    }
    roots
}

fn find_workspace_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|directory| {
        let manifest = directory.join("Cargo.toml");
        let contents = fs::read_to_string(manifest).ok()?;
        contents
            .lines()
            .any(|line| line.trim() == "[workspace]")
            .then(|| directory.to_path_buf())
    })
}

fn spawn_stdout_drain(
    stdout: ChildStdout,
    ready_sender: mpsc::Sender<Result<ReadyAnnouncement, String>>,
) -> io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name("gitgui-server-stdout".to_string())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let mut readiness_reported = false;

            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let diagnostic = line.trim_end_matches(['\r', '\n']);
                        if !readiness_reported && diagnostic.starts_with(SERVER_READY_LINE_PREFIX) {
                            readiness_reported = true;
                            let result = parse_ready_announcement(diagnostic);
                            if let Err(error) = &result {
                                log_server_diagnostic("stdout", diagnostic);
                                let _ = ready_sender.send(Err(error.clone()));
                            } else if let Ok(announcement) = &result {
                                eprintln!(
                                    "[gitgui] local server reported readiness at {}",
                                    announcement.address
                                );
                                let _ = ready_sender.send(result);
                            }
                        } else {
                            log_server_diagnostic("stdout", diagnostic);
                        }
                    }
                    Err(error) => {
                        if !readiness_reported {
                            let _ = ready_sender
                                .send(Err(format!("could not read server stdout: {error}")));
                        }
                        log_server_diagnostic("stdout", &format!("output read failed: {error}"));
                        return;
                    }
                }
            }

            if !readiness_reported {
                let _ = ready_sender.send(Err(
                    "server stdout closed before a readiness line was received".to_string(),
                ));
            }
        })
}

fn spawn_stderr_drain(stderr: ChildStderr) -> io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name("gitgui-server-stderr".to_string())
        .spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => log_server_diagnostic("stderr", &line),
                    Err(error) => {
                        log_server_diagnostic("stderr", &format!("output read failed: {error}"));
                        break;
                    }
                }
            }
        })
}

fn parse_ready_announcement(line: &str) -> Result<ReadyAnnouncement, String> {
    let payload = line
        .strip_prefix(SERVER_READY_LINE_PREFIX)
        .ok_or_else(|| "server readiness line had an unexpected prefix".to_string())?;
    serde_json::from_str(payload)
        .map_err(|error| format!("server readiness line contained invalid JSON: {error}"))
}

fn parse_loopback_address(address: &str) -> Result<SocketAddr, String> {
    let address = address
        .parse::<SocketAddr>()
        .map_err(|error| format!("server reported invalid address {address:?}: {error}"))?;
    if !address.ip().is_loopback() {
        return Err(format!(
            "server reported non-loopback address {}; local desktop startup only permits loopback",
            address
        ));
    }
    Ok(address)
}

fn validate_readiness(readiness: &ServerReadiness) -> Result<(), String> {
    if !readiness.ready || readiness.lifecycle != ServerLifecycle::Ready {
        return Err(format!(
            "server is not ready (lifecycle {:?}, ready {})",
            readiness.lifecycle, readiness.ready
        ));
    }
    if readiness.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "incompatible protocol version {}; desktop requires {}",
            readiness.protocol_version, PROTOCOL_VERSION
        ));
    }
    if readiness.server_id.trim().is_empty() {
        return Err("server readiness response did not include a server ID".to_string());
    }
    Ok(())
}

fn validate_info(readiness: &ServerReadiness, info: &ServerInfo) -> Result<(), String> {
    if info.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "incompatible info protocol version {}; desktop requires {}",
            info.protocol_version, PROTOCOL_VERSION
        ));
    }
    if info.server_id != readiness.server_id {
        return Err("server ID changed between readiness and info responses".to_string());
    }
    Ok(())
}

fn probe_json<T>(address: SocketAddr, path: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    if !address.ip().is_loopback() {
        return Err(format!("refusing to probe non-loopback address {address}"));
    }

    let mut stream = TcpStream::connect_timeout(&address, HTTP_CONNECT_TIMEOUT)
        .map_err(|error| format!("could not connect to {address}: {error}"))?;
    stream
        .set_read_timeout(Some(HTTP_READ_TIMEOUT))
        .map_err(|error| format!("could not set readiness read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(HTTP_CONNECT_TIMEOUT))
        .map_err(|error| format!("could not set readiness write timeout: {error}"))?;

    let host = format_host(address);
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )
    .map_err(|error| format!("could not send readiness request: {error}"))?;

    let mut response = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = stream
            .read(&mut buffer)
            .map_err(|error| format!("could not read readiness response: {error}"))?;
        if count == 0 {
            break;
        }
        if response.len() + count > MAX_HTTP_RESPONSE_BYTES {
            return Err("readiness response exceeded the local safety limit".to_string());
        }
        response.extend_from_slice(&buffer[..count]);
    }

    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "readiness response did not contain HTTP headers".to_string())?;
    let header = std::str::from_utf8(&response[..header_end])
        .map_err(|error| format!("readiness response headers were not UTF-8: {error}"))?;
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_ascii_whitespace().nth(1))
        .ok_or_else(|| "readiness response did not contain an HTTP status".to_string())?;
    if status != "200" {
        return Err(format!("readiness endpoint returned HTTP status {status}"));
    }

    serde_json::from_slice(&response[header_end + 4..])
        .map_err(|error| format!("readiness response contained invalid JSON: {error}"))
}

fn format_http_url(address: SocketAddr) -> String {
    format!("http://{}", format_host(address))
}

fn format_host(address: SocketAddr) -> String {
    match address.ip() {
        IpAddr::V4(ip) => format!("{ip}:{}", address.port()),
        IpAddr::V6(ip) => format!("[{ip}]:{}", address.port()),
    }
}

fn log_server_diagnostic(stream_name: &str, line: &str) {
    let line = redact_diagnostic_line(line);
    let line = if line.len() > MAX_DIAGNOSTIC_LINE_BYTES {
        format!(
            "{}...",
            line.chars()
                .take(MAX_DIAGNOSTIC_LINE_BYTES)
                .collect::<String>()
        )
    } else {
        line
    };
    eprintln!("[gitgui] local server {stream_name}: {line}");
}

fn redact_diagnostic_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if ["authorization:", "token=", "password=", "passwd="]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return "[redacted diagnostic line]".to_string();
    }

    let mut sanitized = line.to_string();
    for scheme in ["http://", "https://", "ws://", "wss://", "ssh://"] {
        let mut search_from = 0;
        while let Some(relative_start) = sanitized[search_from..].find(scheme) {
            let start = search_from + relative_start + scheme.len();
            let Some(relative_at) = sanitized[start..].find('@') else {
                break;
            };
            let at = start + relative_at;
            sanitized.replace_range(start..at, "<redacted>");
            search_from = at + 1;
        }
    }
    sanitized
}
