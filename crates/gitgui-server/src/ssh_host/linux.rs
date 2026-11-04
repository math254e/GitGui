use super::*;
use crate::{ServerConfig, ServerState, local_control::WorkGate};
use fs2::FileExt;
use gitgui_protocol::{SshEnvironmentLocator, SshHostOwnership};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufReader, Read},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixStream,
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
};

const START_MS: u64 = 60_000;
// A permitted 3-minute SSH pairing prompt plus HTTP/RPC/save/claim must fit.
const UNCLAIMED_MS: u64 = 300_000;
const MAX_RECORD_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ACQUISITIONS: usize = 4096;
const DRAIN_BUDGET: Duration = Duration::from_secs(10);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn private_directory(path: &Path) -> io::Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.uid() != uid() || meta.mode() & 0o077 != 0 {
        return Err(invalid(
            "host runtime directory must be private and owned by this user",
        ));
    }
    Ok(())
}

fn private_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.uid() != uid() || meta.mode() & 0o077 != 0 {
        return Err(invalid("unsafe host runtime file"));
    }
    Ok(file)
}

#[derive(Clone)]
struct Store {
    data_dir: PathBuf,
    root: PathBuf,
}
impl Store {
    fn open(data_dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(data_dir)?;
        let data_dir = fs::canonicalize(data_dir)?;
        if data_dir.to_str().is_none() {
            return Err(invalid("environment path is not UTF-8"));
        }
        let root = data_dir.join(".ssh-host");
        private_directory(&root)?;
        Ok(Self { data_dir, root })
    }
    // No readiness, prompts, socket I/O or draining inside a transaction.
    fn transaction<T>(&self, f: impl FnOnce(&mut Record) -> io::Result<T>) -> io::Result<T> {
        let lock = private_file(&self.root.join("state.lock"))?;
        lock.lock_exclusive()?;
        let path = self.root.join("state.json");
        let mut record = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(file) => {
                if file.metadata()?.len() > MAX_RECORD_BYTES {
                    return Err(invalid("oversized host record"));
                }
                let record: Record = serde_json::from_reader(file.take(MAX_RECORD_BYTES))?;
                record.validate(&self.data_dir)?;
                record
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Record::new(&self.data_dir),
            Err(e) => return Err(e),
        };
        let result = f(&mut record)?;
        let next = self.root.join(format!("next-{}", uuid::Uuid::new_v4()));
        let write = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&next)?;
            serde_json::to_writer(&mut file, &record)?;
            file.sync_all()?;
            fs::rename(&next, path)?;
            File::open(&self.root)?.sync_all()
        })();
        if write.is_err() {
            let _ = fs::remove_file(&next);
        }
        write?;
        Ok(result)
    }
    fn process_lock(&self) -> io::Result<File> {
        let file = private_file(&self.root.join("process.lock"))?;
        file.try_lock_exclusive()?;
        Ok(file)
    }
    fn running(&self) -> io::Result<bool> {
        match self.process_lock() {
            Ok(_) => Ok(false),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(true),
            Err(e) => Err(e),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum LeaseState {
    Pending,
    Claimed,
    Cancelled,
    Released,
    Expired,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Lease {
    instance: Option<String>,
    state: LeaseState,
    deadline: u64,
}
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Starting,
    Ready,
    CleanupPending,
    Stopping,
    Stopped,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Instance {
    id: String,
    environment_id: Option<String>,
    port: Option<u16>,
    ownership: SshHostOwnership,
    phase: Phase,
    startup_deadline: u64,
    // Diagnostic only. Socket challenge + held process lock are ownership proof.
    pid: Option<u32>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    data_dir: PathBuf,
    instance: Option<Instance>,
    leases: BTreeMap<String, Lease>,
}
impl Record {
    fn new(data_dir: &Path) -> Self {
        Self {
            version: 1,
            data_dir: data_dir.into(),
            instance: None,
            leases: BTreeMap::new(),
        }
    }
    fn validate(&self, data_dir: &Path) -> io::Result<()> {
        if self.version != 1
            || self.data_dir != data_dir
            || self.leases.len() > MAX_ACQUISITIONS
            || self.leases.keys().any(|id| !super::valid_ownership_id(id))
            || self.leases.values().any(|lease| {
                lease
                    .instance
                    .as_ref()
                    .is_some_and(|id| !super::valid_ownership_id(id))
            })
            || self.instance.as_ref().is_some_and(|i| {
                !super::valid_ownership_id(&i.id)
                    || i.environment_id
                        .as_ref()
                        .is_some_and(|id| !crate::is_valid_environment_id(id))
                    || i.port == Some(0)
            })
        {
            return Err(invalid("invalid or incompatible host record"));
        }
        Ok(())
    }
    fn expire(&mut self, time: u64) {
        for lease in self.leases.values_mut() {
            if lease.state == LeaseState::Pending && lease.deadline <= time {
                lease.state = LeaseState::Expired;
            }
        }
    }
    fn used(&self, instance: &str) -> bool {
        self.leases.values().any(|lease| {
            lease.instance.as_deref() == Some(instance)
                && matches!(lease.state, LeaseState::Pending | LeaseState::Claimed)
        })
    }
    fn room(&self, id: &str) -> io::Result<()> {
        if !self.leases.contains_key(id) && self.leases.len() >= MAX_ACQUISITIONS {
            return Err(invalid("acquisition journal is full"));
        }
        Ok(())
    }
}

fn identity(data_dir: &Path) -> io::Result<Option<String>> {
    let path = data_dir.join(crate::SERVER_ID_FILE);
    match File::open(path) {
        Ok(file) => {
            if file.metadata()?.len() > 4096 {
                return Err(invalid("invalid environment identity"));
            }
            let value: crate::PersistedServerIdentity = serde_json::from_reader(file.take(4096))?;
            if value.schema_version != crate::PERSISTENCE_SCHEMA_VERSION
                || !crate::is_valid_environment_id(&value.server_id)
            {
                return Err(invalid("invalid environment identity"));
            }
            Ok(Some(value.server_id))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn locate(request: &SshHostRequest) -> Result<Store, SshHostOutcome> {
    let path = match &request.locator {
        SshEnvironmentLocator::Default => {
            crate::default_server_data_dir().ok_or(SshHostOutcome::InvalidRequest)?
        }
        SshEnvironmentLocator::Directory {
            path,
            environment_id,
        } => {
            let path = PathBuf::from(path);
            if !path.is_absolute()
                || !path.is_dir()
                || !crate::is_valid_environment_id(environment_id)
            {
                return Err(SshHostOutcome::InvalidRequest);
            }
            if identity(&path)
                .map_err(|_| SshHostOutcome::Ambiguous)?
                .as_deref()
                != Some(environment_id)
            {
                return Err(SshHostOutcome::IdentityMismatch);
            }
            if request
                .expected_environment_id
                .as_ref()
                .is_some_and(|id| id != environment_id)
            {
                return Err(SshHostOutcome::IdentityMismatch);
            }
            path
        }
        SshEnvironmentLocator::Legacy {
            state_key,
            environment_id,
        } => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or(SshHostOutcome::InvalidRequest)?;
            let default = crate::default_server_data_dir().ok_or(SshHostOutcome::InvalidRequest)?;
            legacy_directory(
                &home,
                &default,
                state_key,
                environment_id,
                request.expected_environment_id.as_deref(),
            )?
        }
    };
    let existing = identity(&path).map_err(|_| SshHostOutcome::Ambiguous)?;
    if request
        .expected_environment_id
        .as_ref()
        .is_some_and(|expected| existing.as_ref() != Some(expected))
    {
        return Err(SshHostOutcome::IdentityMismatch);
    }
    Store::open(&path).map_err(|_| SshHostOutcome::Ambiguous)
}

fn legacy_directory(
    home: &Path,
    default: &Path,
    key: &str,
    expected: &str,
    request_expected: Option<&str>,
) -> Result<PathBuf, SshHostOutcome> {
    if key.is_empty()
        || key.len() > 48
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || !crate::is_valid_environment_id(expected)
    {
        return Err(SshHostOutcome::InvalidRequest);
    }
    if request_expected.is_some_and(|id| id != expected) {
        return Err(SshHostOutcome::IdentityMismatch);
    }
    let path = home.join(".gitgui/environments").join(key);
    let default_id = identity(default).map_err(|_| SshHostOutcome::Ambiguous)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            if identity(&path)
                .map_err(|_| SshHostOutcome::Ambiguous)?
                .as_deref()
                != Some(expected)
            {
                return Err(SshHostOutcome::IdentityMismatch);
            }
            if default_id.as_deref() == Some(expected)
                && fs::canonicalize(&path).ok() != fs::canonicalize(default).ok()
            {
                return Err(SshHostOutcome::Ambiguous);
            }
            Ok(path)
        }
        Err(e)
            if e.kind() == io::ErrorKind::NotFound && default_id.as_deref() == Some(expected) =>
        {
            Ok(default.into())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err(SshHostOutcome::IdentityMismatch),
        Err(_) => Err(SshHostOutcome::Ambiguous),
    }
}

fn snapshot(request: &SshHostRequest, outcome: SshHostOutcome, record: &Record) -> SshHostResponse {
    let mut reply = response(request, outcome);
    reply.remote_data_directory = record.data_dir.to_str().map(str::to_string);
    if let Some(i) = &record.instance {
        reply.instance_id = Some(i.id.clone());
        reply.environment_id = i.environment_id.clone();
        reply.port = i.port;
        reply.ownership = Some(i.ownership);
        reply.expires_at_unix_ms = record
            .leases
            .get(&request.acquisition_id)
            .filter(|lease| lease.state == LeaseState::Pending)
            .map(|lease| lease.deadline);
    }
    reply
}

fn reserve(
    store: &Store,
    request: &SshHostRequest,
    spawn: impl FnOnce(&str) -> io::Result<()>,
) -> io::Result<SshHostResponse> {
    store
        .transaction(|record| {
            record.expire(now());
            record.room(&request.acquisition_id)?;
            if let Some(lease) = record.leases.get(&request.acquisition_id) {
                if !matches!(lease.state, LeaseState::Pending | LeaseState::Claimed) {
                    return Ok((
                        snapshot(request, SshHostOutcome::Cancelled, record),
                        false,
                        String::new(),
                    ));
                }
                if record.instance.as_ref().map(|i| &i.id) != lease.instance.as_ref() {
                    return Ok((
                        snapshot(request, SshHostOutcome::Cancelled, record),
                        false,
                        String::new(),
                    ));
                }
                if record
                    .instance
                    .as_ref()
                    .is_some_and(|i| matches!(i.phase, Phase::Stopped | Phase::Stopping))
                {
                    return Ok((
                        snapshot(request, SshHostOutcome::Cancelled, record),
                        false,
                        String::new(),
                    ));
                }
            }
            if record.instance.is_none() && store.running()? {
                return Err(invalid("unverifiable running instance"));
            }
            if record.instance.is_none() && identity(&store.data_dir)?.is_some() {
                // A pre-helper server cannot prove its process lock/ownership.
                // Require an explicit foreground restart with the new binary rather
                // than risk opening the same legacy catalog in two processes.
                return Ok((
                    snapshot(request, SshHostOutcome::Ambiguous, record),
                    false,
                    String::new(),
                ));
            }
            let replace = match &record.instance {
                None => true,
                Some(i) if i.phase == Phase::Stopped => !store.running()?,
                Some(i) if !store.running()? => {
                    i.phase != Phase::Starting || i.startup_deadline <= now()
                }
                _ => false,
            };
            if replace {
                // The reservation is committed BEFORE spawning (below). A child must
                // re-check it under this same lock before doing any server startup.
                let id = uuid::Uuid::new_v4().to_string();
                record.instance = Some(Instance {
                    id,
                    environment_id: identity(&store.data_dir)?,
                    port: None,
                    ownership: SshHostOwnership::Managed,
                    phase: Phase::Starting,
                    startup_deadline: now() + START_MS,
                    pid: None,
                });
            }
            let instance = record
                .instance
                .as_ref()
                .ok_or_else(|| invalid("missing instance"))?;
            if matches!(
                instance.phase,
                Phase::Stopping | Phase::Stopped | Phase::CleanupPending
            ) {
                return Ok((
                    snapshot(request, SshHostOutcome::CleanupPending, record),
                    false,
                    String::new(),
                ));
            }
            let instance_id = instance.id.clone();
            let deadline = now()
                + if instance.phase == Phase::Ready {
                    UNCLAIMED_MS
                } else {
                    START_MS
                };
            record
                .leases
                .entry(request.acquisition_id.clone())
                .or_insert(Lease {
                    instance: Some(instance_id.clone()),
                    state: LeaseState::Pending,
                    deadline,
                });
            let result = snapshot(request, SshHostOutcome::Ready, record);
            Ok((result, replace, instance_id))
        })
        .and_then(|(reply, launch, instance)| {
            if launch {
                // Re-check cancellation at the spawn decision. Spawn is a short OS
                // operation inside the transaction, never a readiness wait.
                store.transaction(|record| {
                    record.expire(now());
                    if record
                        .instance
                        .as_ref()
                        .is_some_and(|i| i.id == instance && i.phase == Phase::Starting)
                        && record.used(&instance)
                    {
                        spawn(&instance)?;
                    }
                    Ok(())
                })?;
            }
            Ok(reply)
        })
}

fn detach(store: &Store, instance: &str) -> io::Result<()> {
    #[derive(Serialize)]
    struct Child<'a> {
        data_dir: &'a Path,
        instance: &'a str,
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("ssh-serve")
        .env_remove(crate::BOOTSTRAP_STDIN_ENV)
        .env_remove(crate::local_control::DESKTOP_CONTROL_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // setsid is async-signal-safe; no allocation or inherited SSH terminal remains.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn()?;
    let mut pipe = child
        .stdin
        .take()
        .ok_or_else(|| invalid("missing child input"))?;
    serde_json::to_writer(
        &mut pipe,
        &Child {
            data_dir: &store.data_dir,
            instance,
        },
    )?;
    writeln!(pipe)?;
    // Do not kill/reap by PID. The detached process owns the lock and expiry.
    Ok(())
}

pub(super) async fn command(operation: &str, request: &SshHostRequest) -> SshHostResponse {
    let store = match locate(request) {
        Ok(s) => s,
        Err(outcome) => return response(request, outcome),
    };
    let result = match operation {
        "ensure" => {
            let (eof_tx, eof_rx) = tokio::sync::oneshot::channel();
            std::thread::spawn(move || {
                let mut byte = [0u8];
                // EOF or trailing input before result ends the setup lease.
                let _ = io::stdin().lock().read(&mut byte);
                let _ = eof_tx.send(());
            });
            tokio::select! {
                result = ensure(&store, request) => result,
                _ = eof_rx => cancel(&store, request, false).await,
            }
        }
        "claim" => claim(&store, request),
        "pairing" => owner_pairing(&store, request).await,
        "cancel" | "release" => cancel(&store, request, operation == "release").await,
        "probe" => probe(&store, request).await,
        _ => return response(request, SshHostOutcome::InvalidRequest),
    };
    result.unwrap_or_else(|error| {
        let outcome = match error.kind() {
            io::ErrorKind::InvalidData | io::ErrorKind::PermissionDenied => {
                SshHostOutcome::Ambiguous
            }
            _ => SshHostOutcome::Failed,
        };
        let mut reply = response(request, outcome);
        reply.message = Some("Host lifecycle state could not be safely resolved".into());
        reply
    })
}

async fn owner_pairing(store: &Store, request: &SshHostRequest) -> io::Result<SshHostResponse> {
    if request.expected_environment_id.is_none() || request.instance_id.is_none() {
        return Ok(response(request, SshHostOutcome::InvalidRequest));
    }
    let mut reply = probe(store, request).await?;
    if reply.outcome != SshHostOutcome::Ready {
        return Ok(reply);
    }
    if !store.data_dir.join("auth.sqlite3").is_file() {
        // Helper-less external servers cannot consume cross-process grants.
        reply.outcome = SshHostOutcome::Unsupported;
        return Ok(reply);
    }
    match crate::auth::AuthStore::issue_owner_pairing(
        &store.data_dir,
        request.expected_environment_id.as_deref().unwrap(),
    )
    .await
    {
        Ok(pairing) => reply.pairing = Some(pairing),
        Err(crate::auth::AuthError::IdentityMismatch) => {
            reply.outcome = SshHostOutcome::IdentityMismatch
        }
        Err(_) => reply.outcome = SshHostOutcome::Failed,
    }
    Ok(reply)
}

async fn ensure(store: &Store, request: &SshHostRequest) -> io::Result<SshHostResponse> {
    let first = reserve(store, request, |id| detach(store, id))?;
    if first.outcome != SshHostOutcome::Ready {
        return Ok(first);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(START_MS);
    loop {
        let reply = probe(store, request).await?;
        match reply.outcome {
            SshHostOutcome::Ready => return Ok(reply),
            SshHostOutcome::Cancelled
            | SshHostOutcome::IdentityMismatch
            | SshHostOutcome::CleanupPending
            | SshHostOutcome::Ambiguous => return Ok(reply),
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return cancel(store, request, false).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn claim(store: &Store, request: &SshHostRequest) -> io::Result<SshHostResponse> {
    if request.instance_id.is_none() || request.expected_environment_id.is_none() {
        return Ok(response(request, SshHostOutcome::InvalidRequest));
    }
    store.transaction(|record| {
        record.expire(now());
        let Some(instance) = &record.instance else {
            return Ok(response(request, SshHostOutcome::NotRunning));
        };
        if request.instance_id.as_ref() != Some(&instance.id) {
            return Ok(snapshot(request, SshHostOutcome::Cancelled, record));
        }
        if request.expected_environment_id != instance.environment_id {
            return Ok(snapshot(request, SshHostOutcome::IdentityMismatch, record));
        }
        let Some(lease) = record.leases.get_mut(&request.acquisition_id) else {
            return Ok(snapshot(request, SshHostOutcome::Cancelled, record));
        };
        if !matches!(lease.state, LeaseState::Pending | LeaseState::Claimed)
            || lease.instance.as_ref() != request.instance_id.as_ref()
        {
            return Ok(snapshot(request, SshHostOutcome::Cancelled, record));
        }
        if instance.phase != Phase::Ready || !store.running()? {
            return Ok(snapshot(request, SshHostOutcome::CleanupPending, record));
        }
        lease.state = LeaseState::Claimed;
        Ok(snapshot(request, SshHostOutcome::Claimed, record))
    })
}

async fn cancel(
    store: &Store,
    request: &SshHostRequest,
    release: bool,
) -> io::Result<SshHostResponse> {
    if release && request.instance_id.is_none() {
        return Ok(response(request, SshHostOutcome::InvalidRequest));
    }
    let reply = store.transaction(|record| {
        record.expire(now());
        record.room(&request.acquisition_id)?;
        if let Some(lease) = record.leases.get(&request.acquisition_id) {
            if release && lease.instance != request.instance_id {
                return Ok(snapshot(request, SshHostOutcome::Cancelled, record));
            }
            if !release && lease.state == LeaseState::Claimed {
                return Ok(snapshot(request, SshHostOutcome::Retained, record));
            }
        }
        // Unknown-result cancellation is durable even if reserve has not run.
        let instance = record
            .leases
            .get(&request.acquisition_id)
            .and_then(|l| l.instance.clone());
        record.leases.insert(
            request.acquisition_id.clone(),
            Lease {
                instance,
                state: if release {
                    LeaseState::Released
                } else {
                    LeaseState::Cancelled
                },
                deadline: 0,
            },
        );
        let Some(i) = &record.instance else {
            return Ok(snapshot(request, SshHostOutcome::Cancelled, record));
        };
        if record
            .leases
            .get(&request.acquisition_id)
            .and_then(|l| l.instance.as_deref())
            != Some(i.id.as_str())
        {
            return Ok(snapshot(
                request,
                if release {
                    SshHostOutcome::Released
                } else {
                    SshHostOutcome::Cancelled
                },
                record,
            ));
        }
        if record.used(&i.id) || i.ownership == SshHostOwnership::External {
            return Ok(snapshot(request, SshHostOutcome::Retained, record));
        }
        if !store.running()? {
            // Invalidate BEFORE a delayed child can acquire its process lock.
            record.instance.as_mut().unwrap().phase = Phase::Stopped;
            return Ok(snapshot(request, SshHostOutcome::Stopped, record));
        }
        record.instance.as_mut().unwrap().phase = Phase::CleanupPending;
        Ok(snapshot(request, SshHostOutcome::CleanupPending, record))
    })?;
    if reply.outcome != SshHostOutcome::CleanupPending {
        return Ok(reply);
    }
    let Some(instance) = reply.instance_id.as_deref() else {
        return Ok(reply);
    };
    let result = control(instance, ControlOp::Reconcile).await;
    if result
        .as_ref()
        .is_ok_and(|r| r.outcome == SshHostOutcome::Retained)
    {
        return Ok(SshHostResponse {
            outcome: SshHostOutcome::Retained,
            ..reply
        });
    }
    // Acknowledging shutdown is not proof of observed exit. The held process
    // lock must be released before reporting stopped.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        if !store.running()? {
            let stopped = store.transaction(|record| {
                if let Some(current) = record.instance.as_mut().filter(|i| i.id == instance) {
                    if store.running()? {
                        return Ok(false);
                    }
                    // A child can exit before constructing HostGuard. Commit
                    // the observed exit here, without changing a newer instance.
                    current.phase = Phase::Stopped;
                }
                Ok(true)
            })?;
            if stopped {
                return Ok(SshHostResponse {
                    outcome: SshHostOutcome::Stopped,
                    ..reply
                });
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(reply)
}

async fn probe(store: &Store, request: &SshHostRequest) -> io::Result<SshHostResponse> {
    let reply = store.transaction(|record| {
        record.expire(now());
        if record
            .leases
            .get(&request.acquisition_id)
            .is_some_and(|l| !matches!(l.state, LeaseState::Pending | LeaseState::Claimed))
        {
            return Ok(snapshot(request, SshHostOutcome::Cancelled, record));
        }
        let outcome = match &record.instance {
            Some(i) if request.instance_id.as_ref().is_some_and(|id| id != &i.id) => {
                SshHostOutcome::Cancelled
            }
            Some(i)
                if request.expected_environment_id.as_ref().is_some_and(|id| {
                    i.environment_id.as_ref().is_some_and(|actual| actual != id)
                }) =>
            {
                SshHostOutcome::IdentityMismatch
            }
            Some(i) if i.phase == Phase::Ready && store.running()? => SshHostOutcome::Ready,
            Some(i) if i.phase == Phase::Starting => SshHostOutcome::NotRunning,
            Some(i) if i.phase == Phase::CleanupPending || i.phase == Phase::Stopping => {
                SshHostOutcome::CleanupPending
            }
            _ => SshHostOutcome::NotRunning,
        };
        Ok(snapshot(request, outcome, record))
    })?;
    if reply.outcome == SshHostOutcome::Ready {
        let Some(id) = reply.instance_id.as_deref() else {
            return Err(invalid("missing instance"));
        };
        match control(id, ControlOp::Probe).await {
            Ok(control)
                if control.outcome == SshHostOutcome::Ready
                    && control.instance_id.as_ref() == reply.instance_id.as_ref()
                    && control.environment_id == reply.environment_id
                    && control.port == reply.port
                    && control.ownership == reply.ownership =>
            {
                // Linearize success after the socket roundtrip, against cancel.
                return store.transaction(|record| {
                    record.expire(now());
                    if record.leases.get(&request.acquisition_id).is_some_and(|l| {
                        !matches!(l.state, LeaseState::Pending | LeaseState::Claimed)
                    }) {
                        return Ok(snapshot(request, SshHostOutcome::Cancelled, record));
                    }
                    if record.instance.as_ref().is_none_or(|i| {
                        Some(&i.id) != control.instance_id.as_ref()
                            || i.phase != Phase::Ready
                            || i.environment_id != control.environment_id
                            || i.port != control.port
                            || Some(i.ownership) != control.ownership
                    }) {
                        return Ok(snapshot(request, SshHostOutcome::CleanupPending, record));
                    }
                    Ok(snapshot(request, SshHostOutcome::Ready, record))
                });
            }
            _ => {
                return Ok(SshHostResponse {
                    outcome: SshHostOutcome::CleanupPending,
                    ..reply
                });
            }
        }
    }
    Ok(reply)
}

fn socket_path(instance: &str) -> io::Result<PathBuf> {
    if !super::valid_ownership_id(instance) {
        return Err(invalid("invalid instance"));
    }
    // Bounded path length, independent of long repository/legacy data paths.
    let root = PathBuf::from("/tmp").join(format!("gitgui-owner-{}", uid()));
    private_directory(&root)?;
    Ok(root.join(format!("{instance}.sock")))
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ControlOp {
    Probe,
    Reconcile,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Control {
    version: u32,
    instance: String,
    operation: ControlOp,
}

async fn control(instance: &str, operation: ControlOp) -> io::Result<SshHostResponse> {
    let instance = instance.to_string();
    tokio::task::spawn_blocking(move || {
        let mut stream = UnixStream::connect(socket_path(&instance)?)?;
        stream.set_read_timeout(Some(DRAIN_BUDGET + Duration::from_secs(1)))?;
        stream.set_write_timeout(Some(Duration::from_secs(1)))?;
        serde_json::to_writer(
            &mut stream,
            &Control {
                version: 1,
                instance,
                operation,
            },
        )?;
        writeln!(stream)?;
        let line =
            crate::local_control::read_line(&mut BufReader::new(stream), SSH_HOST_MAX_FRAME_BYTES)?
                .ok_or_else(|| invalid("empty owner response"))?;
        serde_json::from_slice(&line).map_err(Into::into)
    })
    .await
    .map_err(|_| invalid("owner request worker failed"))?
}

pub(crate) struct HostGuard {
    store: Store,
    instance: String,
    managed: bool,
    _process_lock: File,
    listener: UnixListener,
    socket: PathBuf,
}
impl HostGuard {
    fn validate_live(&self, state: &ServerState, record: &Record) -> io::Result<()> {
        let instance = record
            .instance
            .as_ref()
            .ok_or_else(|| invalid("missing live instance"))?;
        let port = state
            .info
            .bind_address
            .parse::<std::net::SocketAddr>()
            .map_err(|_| invalid("invalid live port"))?
            .port();
        let ownership = if self.managed {
            SshHostOwnership::Managed
        } else {
            SshHostOwnership::External
        };
        if instance.id != self.instance
            || instance.environment_id.as_deref() != Some(state.info.environment_id.as_str())
            || instance.port != Some(port)
            || instance.ownership != ownership
        {
            return Err(invalid("journal disagrees with live process"));
        }
        Ok(())
    }
    pub(crate) fn begin(
        config: &ServerConfig,
        managed_instance: Option<&str>,
    ) -> io::Result<Option<Self>> {
        let Some(path) = &config.data_dir else {
            return Ok(None);
        };
        let store = Store::open(path)?;
        let process_lock = store.process_lock()?;
        let instance = store.transaction(|record| {
            record.expire(now());
            if let Some(id) = managed_instance {
                let instance = record
                    .instance
                    .as_ref()
                    .ok_or_else(|| invalid("missing launch reservation"))?;
                if instance.id != id
                    || instance.ownership != SshHostOwnership::Managed
                    || instance.phase != Phase::Starting
                    || !record.used(id)
                {
                    return Err(invalid("launch reservation was cancelled or replaced"));
                }
            } else {
                if record
                    .instance
                    .as_ref()
                    .is_some_and(|i| i.phase == Phase::Starting && i.startup_deadline > now())
                {
                    return Err(invalid("another launch is reserved"));
                }
                record.instance = Some(Instance {
                    id: uuid::Uuid::new_v4().to_string(),
                    environment_id: identity(&store.data_dir)?,
                    port: None,
                    ownership: SshHostOwnership::External,
                    phase: Phase::Starting,
                    startup_deadline: now() + START_MS,
                    pid: None,
                });
            }
            let instance = record.instance.as_mut().unwrap();
            instance.pid = Some(std::process::id());
            Ok(instance.id.clone())
        })?;
        let socket = socket_path(&instance)?;
        // Never unlink a socket on failed bind. An existing endpoint is not ours.
        let listener = UnixListener::bind(&socket)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        Ok(Some(Self {
            store,
            instance,
            managed: managed_instance.is_some(),
            _process_lock: process_lock,
            listener,
            socket,
        }))
    }
    pub(crate) fn ready(&self, state: &ServerState) -> io::Result<()> {
        self.store.transaction(|record| {
            record.expire(now());
            let instance = record
                .instance
                .as_ref()
                .ok_or_else(|| invalid("missing instance"))?;
            if instance.id != self.instance
                || instance.phase != Phase::Starting
                || (instance.ownership == SshHostOwnership::Managed) != self.managed
                || (instance.ownership == SshHostOwnership::Managed && !record.used(&self.instance))
            {
                return Err(invalid("instance cancelled during startup"));
            }
            let port = state
                .info
                .bind_address
                .parse::<std::net::SocketAddr>()
                .map_err(|_| invalid("invalid bound port"))?
                .port();
            let instance = record.instance.as_mut().unwrap();
            instance.environment_id = Some(state.info.environment_id.clone());
            instance.port = Some(port);
            instance.phase = Phase::Ready;
            for lease in record.leases.values_mut() {
                if lease.instance.as_deref() == Some(&self.instance)
                    && lease.state == LeaseState::Pending
                {
                    lease.deadline = now() + UNCLAIMED_MS;
                }
            }
            Ok(())
        })
    }
    async fn reconcile(&self, state: &ServerState) -> io::Result<bool> {
        // On-disk metadata cannot silently adopt a foreground/external process.
        // Ownership is fixed when this exact process accepts its reservation.
        if !self.managed {
            return Ok(false);
        }
        let stop = self.store.transaction(|record| {
            self.validate_live(state, record)?;
            record.expire(now());
            let Some(i) = &record.instance else {
                return Err(invalid("missing instance"));
            };
            if i.id != self.instance
                || i.ownership == SshHostOwnership::External
                || record.used(&self.instance)
            {
                return Ok(false);
            }
            record.instance.as_mut().unwrap().phase = Phase::CleanupPending;
            Ok(true)
        })?;
        if !stop {
            return Ok(false);
        }
        if !cooperative_drain(&state.work, &state.sockets, DRAIN_BUDGET).await {
            return Ok(false);
        }
        // Claim/ensure cannot race a successful drain: cleanup-pending blocks
        // acquisition, and this last transaction checks every surviving handle.
        let stopped = self.store.transaction(|record| {
            self.validate_live(state, record)?;
            record.expire(now());
            if record.used(&self.instance) {
                return Ok(false);
            }
            let i = record
                .instance
                .as_mut()
                .ok_or_else(|| invalid("missing instance"))?;
            if i.id != self.instance || i.ownership != SshHostOwnership::Managed {
                return Ok(false);
            }
            i.phase = Phase::Stopping;
            Ok(true)
        });
        let stopped = match stopped {
            Ok(stopped) => stopped,
            Err(error) => {
                state.work.resume();
                state.sockets.resume();
                return Err(error);
            }
        };
        if !stopped {
            state.work.resume();
            state.sockets.resume();
        }
        Ok(stopped)
    }
    pub(crate) async fn run(&self, state: &ServerState) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if self.reconcile(state).await.unwrap_or(false) { return; }
                },
                accepted = self.listener.accept() => {
                    let Ok((mut stream, _)) = accepted else { continue; };
                    if stream.peer_cred().map(|c| c.uid()).ok() != Some(uid()) { continue; }
                    let frame = tokio::time::timeout(Duration::from_secs(1), async {
                        let mut bytes = Vec::new();
                        loop {
                            let byte = stream.read_u8().await?;
                            bytes.push(byte);
                            if bytes.len() > SSH_HOST_MAX_FRAME_BYTES { return Err(invalid("oversized owner frame")); }
                            if byte == b'\n' { return Ok(bytes); }
                        }
                    }).await;
                    let Ok(Ok(bytes)) = frame else { continue; };
                    let Ok(input) = serde_json::from_slice::<Control>(&bytes) else { continue; };
                    if input.version != 1 || input.instance != self.instance { continue; }
                    let stop = matches!(input.operation, ControlOp::Reconcile) && self.reconcile(state).await.unwrap_or(false);
                    let request = SshHostRequest { version: 1, acquisition_id: String::new(), locator: SshEnvironmentLocator::Default, expected_environment_id: None, instance_id: None };
                    if let Ok(reply) = self.store.transaction(|record| {
                        self.validate_live(state, record)?;
                        let mut reply = snapshot(&request, if stop { SshHostOutcome::CleanupPending } else if matches!(input.operation, ControlOp::Probe) { SshHostOutcome::Ready } else { SshHostOutcome::Retained }, record);
                        // Proof is from this live guard and listener, never an
                        // echo of the journal that the caller is validating.
                        reply.instance_id = Some(self.instance.clone());
                        reply.environment_id = Some(state.info.environment_id.clone());
                        reply.port = Some(state.info.bind_address.parse::<std::net::SocketAddr>().map_err(|_| invalid("invalid live port"))?.port());
                        reply.ownership = Some(if self.managed { SshHostOwnership::Managed } else { SshHostOwnership::External });
                        reply.remote_data_directory = Some(self.store.data_dir.to_string_lossy().into_owned());
                        Ok(reply)
                    }) {
                        if let Ok(mut bytes) = serde_json::to_vec(&reply) {
                            bytes.push(b'\n');
                            let _ = tokio::time::timeout(Duration::from_secs(1), stream.write_all(&bytes)).await;
                        }
                    }
                    if stop { return; }
                }
            }
        }
    }
}
impl Drop for HostGuard {
    fn drop(&mut self) {
        // Holding the instance process lock proves this generation has exited
        // service. Never remove another generation's record or socket.
        let _ = self.store.transaction(|record| {
            if let Some(i) = record.instance.as_mut().filter(|i| i.id == self.instance) {
                i.phase = Phase::Stopped;
            }
            Ok(())
        });
        let _ = fs::remove_file(&self.socket);
    }
}

async fn cooperative_drain(
    work: &Arc<WorkGate>,
    sockets: &Arc<WorkGate>,
    budget: Duration,
) -> bool {
    if !sockets.pause_if_idle() {
        return false;
    }
    work.pause();
    if tokio::time::timeout(budget, work.drained()).await.is_err() {
        work.resume();
        sockets.resume();
        return false;
    }
    true
}

pub(super) async fn serve_child() -> Result<(), crate::ServerError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Child {
        data_dir: PathBuf,
        instance: String,
    }
    let line = crate::local_control::read_line(&mut io::stdin().lock(), SSH_HOST_MAX_FRAME_BYTES)?
        .ok_or_else(|| invalid("missing child input"))?;
    let input: Child = serde_json::from_slice(&line).map_err(|_| invalid("invalid child input"))?;
    if !input.data_dir.is_absolute() || !super::valid_ownership_id(&input.instance) {
        return Err(invalid("invalid child locator").into());
    }
    let config = ServerConfig {
        data_dir: Some(input.data_dir),
        ..ServerConfig::default()
    };
    crate::run_internal(config, None, Some(input.instance)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn request() -> SshHostRequest {
        SshHostRequest {
            version: 1,
            acquisition_id: uuid::Uuid::new_v4().to_string(),
            locator: SshEnvironmentLocator::Default,
            expected_environment_id: None,
            instance_id: None,
        }
    }
    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }
    fn state(environment: &str) -> ServerState {
        ServerState::new(
            &ServerConfig {
                server_id: environment.into(),
                ..ServerConfig::default()
            },
            "127.0.0.1:12345".parse().unwrap(),
            vec![],
        )
    }
    fn managed(store: &Store, request: &SshHostRequest) -> (HostGuard, ServerState) {
        let reserved = reserve(store, request, |_| Ok(())).unwrap();
        let config = ServerConfig {
            data_dir: Some(store.data_dir.clone()),
            ..ServerConfig::default()
        };
        let guard = HostGuard::begin(&config, reserved.instance_id.as_deref())
            .unwrap()
            .unwrap();
        let state = state(&uuid::Uuid::new_v4().to_string());
        guard.ready(&state).unwrap();
        (guard, state)
    }

    #[tokio::test]
    async fn unknown_result_cancel_tombstone_prevents_future_spawn_and_claim() {
        let (_dir, store) = store();
        let request = request();
        assert_eq!(
            cancel(&store, &request, false).await.unwrap().outcome,
            SshHostOutcome::Cancelled
        );
        let result = reserve(&store, &request, |_| {
            panic!("cancelled ID must never spawn")
        })
        .unwrap();
        assert_eq!(result.outcome, SshHostOutcome::Cancelled);
        let other = self::request();
        let launch = reserve(&store, &other, |_| Ok(())).unwrap();
        cancel(&store, &other, false).await.unwrap();
        let config = ServerConfig {
            data_dir: Some(store.data_dir.clone()),
            ..ServerConfig::default()
        };
        assert!(
            HostGuard::begin(&config, launch.instance_id.as_deref()).is_err(),
            "a late child cannot resurrect the cancelled reservation"
        );
    }

    #[tokio::test]
    async fn cancellation_commits_observed_exit_before_host_guard_exists() {
        let (_dir, store) = store();
        let request = request();
        reserve(&store, &request, |_| Ok(())).unwrap();
        // Model a child that acquired its process lock but fails before it can
        // construct HostGuard, whose Drop normally records terminal metadata.
        let process_lock = store.process_lock().unwrap();
        let child_store = store.clone();
        let exiting = tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
            loop {
                let cancelling = child_store
                    .transaction(|record| {
                        Ok(record
                            .instance
                            .as_ref()
                            .is_some_and(|i| i.phase == Phase::CleanupPending))
                    })
                    .unwrap();
                if cancelling {
                    break;
                }
                assert!(tokio::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            drop(process_lock);
        });
        assert_eq!(
            cancel(&store, &request, false).await.unwrap().outcome,
            SshHostOutcome::Stopped
        );
        exiting.await.unwrap();
        store
            .transaction(|record| {
                assert!(
                    record
                        .instance
                        .as_ref()
                        .is_some_and(|i| i.phase == Phase::Stopped),
                    "observed stopped reply must persist terminal metadata"
                );
                assert!(
                    record.leases.get(&request.acquisition_id).unwrap().state
                        == LeaseState::Cancelled
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(
            reserve(&store, &request, |_| panic!(
                "cancelled child cannot relaunch"
            ))
            .unwrap()
            .outcome,
            SshHostOutcome::Cancelled
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_desktops_reserve_one_instance_and_cancel_cannot_stop_shared_waiter() {
        let (_dir, store) = store();
        let first = request();
        let second = request();
        let launches = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for request in [first.clone(), second.clone()] {
            let store = store.clone();
            let launches = launches.clone();
            tasks.push(tokio::task::spawn_blocking(move || {
                reserve(&store, &request, |_| {
                    launches.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .unwrap()
            }));
        }
        let a = tasks.remove(0).await.unwrap();
        let b = tasks.remove(0).await.unwrap();
        assert_eq!(a.instance_id, b.instance_id);
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        assert_eq!(
            cancel(&store, &first, false).await.unwrap().outcome,
            SshHostOutcome::Retained
        );
        let config = ServerConfig {
            data_dir: Some(store.data_dir.clone()),
            ..ServerConfig::default()
        };
        let guard = HostGuard::begin(&config, a.instance_id.as_deref())
            .unwrap()
            .unwrap();
        let state = state(&uuid::Uuid::new_v4().to_string());
        guard.ready(&state).unwrap();
        let mut claimed = second.clone();
        claimed.instance_id = a.instance_id;
        claimed.expected_environment_id = Some(state.info.environment_id.clone());
        assert_eq!(
            claim(&store, &claimed).unwrap().outcome,
            SshHostOutcome::Claimed
        );
        assert_eq!(
            cancel(&store, &claimed, false).await.unwrap().outcome,
            SshHostOutcome::Retained
        );
        assert!(!guard.reconcile(&state).await.unwrap());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn claim_cancel_linearize_and_never_leave_a_cancelled_claim() {
        for _ in 0..12 {
            let (_dir, store) = store();
            let mut request = request();
            let (guard, state) = managed(&store, &request);
            request.instance_id = Some(guard.instance.clone());
            request.expected_environment_id = Some(state.info.environment_id.clone());
            let claim_store = store.clone();
            let claim_request = request.clone();
            let claiming =
                tokio::task::spawn_blocking(move || claim(&claim_store, &claim_request).unwrap());
            // Keep another handle so the race never waits for a real process exit.
            let waiter = self::request();
            reserve(&store, &waiter, |_| panic!()).unwrap();
            let cancelled = cancel(&store, &request, false).await.unwrap();
            let claimed = claiming.await.unwrap();
            store
                .transaction(|record| {
                    let lease = record.leases.get(&request.acquisition_id).unwrap();
                    if claimed.outcome == SshHostOutcome::Claimed {
                        assert_eq!(cancelled.outcome, SshHostOutcome::Retained);
                        assert!(lease.state == LeaseState::Claimed);
                    } else {
                        assert!(lease.state == LeaseState::Cancelled);
                    }
                    Ok(())
                })
                .unwrap();
        }
    }

    #[tokio::test]
    async fn server_expiry_and_busy_git_drain_preserve_clients_then_reconcile() {
        let (_dir, store) = store();
        let request = request();
        let (guard, state) = managed(&store, &request);
        store
            .transaction(|r| {
                let deadline = r.leases.get(&request.acquisition_id).unwrap().deadline;
                assert!(
                    deadline >= now() + 299_000,
                    "ready budget accommodates the 3-minute pairing prompt"
                );
                Ok(())
            })
            .unwrap();
        store
            .transaction(|r| {
                r.leases.get_mut(&request.acquisition_id).unwrap().deadline = 0;
                Ok(())
            })
            .unwrap();
        let expired_claim = SshHostRequest {
            instance_id: Some(guard.instance.clone()),
            expected_environment_id: Some(state.info.environment_id.clone()),
            ..request.clone()
        };
        assert_eq!(
            claim(&store, &expired_claim).unwrap().outcome,
            SshHostOutcome::Cancelled
        );
        let socket = state.sockets.enter().unwrap();
        assert!(
            !guard.reconcile(&state).await.unwrap(),
            "another RPC client is retained"
        );
        assert!(state.sockets.enter().is_some());
        assert!(state.work.enter().is_some());
        drop(socket);
        let work = state.work.enter().unwrap();
        assert!(!cooperative_drain(&state.work, &state.sockets, Duration::from_millis(10)).await);
        assert!(
            state.work.enter().is_some(),
            "busy timeout resumes admission"
        );
        drop(work);
        assert!(guard.reconcile(&state).await.unwrap());
        assert!(state.work.enter().is_none());
        assert!(state.sockets.enter().is_none());
    }

    #[tokio::test]
    async fn stale_instance_pid_and_cancel_id_cannot_affect_new_generation_or_other_environment() {
        let (_dir, store) = store();
        let old = request();
        let reserved = reserve(&store, &old, |_| Ok(())).unwrap();
        cancel(&store, &old, false).await.unwrap();
        let current = request();
        let (guard, state) = managed(&store, &current);
        let (_other_dir, other_store) = self::store();
        let other = request();
        let (other_guard, other_state) = managed(&other_store, &other);
        store
            .transaction(|r| {
                r.instance.as_mut().unwrap().pid = Some(1);
                Ok(())
            })
            .unwrap();
        let mut stale = old.clone();
        stale.instance_id = reserved.instance_id;
        stale.expected_environment_id = Some(state.info.environment_id.clone());
        assert_eq!(
            claim(&store, &stale).unwrap().outcome,
            SshHostOutcome::Cancelled
        );
        assert_eq!(
            cancel(&store, &old, false).await.unwrap().outcome,
            SshHostOutcome::Cancelled
        );
        assert!(!guard.reconcile(&state).await.unwrap());
        assert!(!other_guard.reconcile(&other_state).await.unwrap());
        assert_ne!(guard.instance, other_guard.instance);
    }

    #[tokio::test]
    async fn external_record_is_attach_only_and_missing_legacy_evidence_blocks() {
        let (_dir, store) = store();
        let config = ServerConfig {
            data_dir: Some(store.data_dir.clone()),
            ..ServerConfig::default()
        };
        let guard = HostGuard::begin(&config, None).unwrap().unwrap();
        let state = state("gitgui-123456-1788413802919117400");
        guard.ready(&state).unwrap();
        let waiter = request();
        let attached = reserve(&store, &waiter, |_| panic!("external never replaced")).unwrap();
        assert_eq!(attached.ownership, Some(SshHostOwnership::External));
        assert_eq!(
            cancel(&store, &waiter, false).await.unwrap().outcome,
            SshHostOutcome::Retained
        );
        assert!(!guard.reconcile(&state).await.unwrap());
        assert!(
            HostGuard::begin(&config, None).is_err(),
            "process lock prevents duplicate server"
        );
        store
            .transaction(|record| {
                record.instance.as_mut().unwrap().ownership = SshHostOwnership::Managed;
                record.instance.as_mut().unwrap().pid = Some(1);
                record.leases.clear();
                Ok(())
            })
            .unwrap();
        assert!(
            !guard.reconcile(&state).await.unwrap(),
            "untrusted metadata cannot adopt an external process"
        );
        let (_legacy_dir, legacy) = self::store();
        fs::write(
            legacy.data_dir.join("server.json"),
            serde_json::to_vec(&crate::PersistedServerIdentity {
                schema_version: 1,
                server_id: uuid::Uuid::new_v4().to_string(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            reserve(&legacy, &request(), |_| panic!()).unwrap().outcome,
            SshHostOutcome::Ambiguous
        );
    }

    #[tokio::test]
    async fn private_socket_rejects_wrong_instance_and_proves_exact_live_instance() {
        let (_dir, store) = store();
        let request = request();
        let (guard, state) = managed(&store, &request);
        let instance = guard.instance.clone();
        assert!(guard.socket.as_os_str().len() < 108);
        assert_eq!(
            fs::metadata(guard.socket.parent().unwrap()).unwrap().mode() & 0o777,
            0o700
        );
        assert_eq!(fs::metadata(&guard.socket).unwrap().mode() & 0o777, 0o600);
        let task = tokio::spawn(async move {
            guard.run(&state).await;
        });
        let proof = control(&instance, ControlOp::Probe).await.unwrap();
        assert_eq!(proof.instance_id.as_deref(), Some(instance.as_str()));
        assert!(
            control(&uuid::Uuid::new_v4().to_string(), ControlOp::Reconcile)
                .await
                .is_err()
        );
        // Connect to the real socket but supply another generation's ID.
        let path = socket_path(&instance).unwrap();
        let wrong = tokio::task::spawn_blocking(move || {
            let mut stream = UnixStream::connect(path).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            serde_json::to_writer(
                &mut stream,
                &Control {
                    version: 1,
                    instance: uuid::Uuid::new_v4().to_string(),
                    operation: ControlOp::Reconcile,
                },
            )
            .unwrap();
            writeln!(stream).unwrap();
            let mut byte = [0u8];
            assert_eq!(stream.read(&mut byte).unwrap(), 0);
        });
        wrong.await.unwrap();
        assert_eq!(
            control(&instance, ControlOp::Probe).await.unwrap().outcome,
            SshHostOutcome::Ready
        );
        task.abort();
        let _ = task.await;
    }

    #[tokio::test]
    async fn forged_journal_fields_cannot_become_live_ownership_proof() {
        let (_dir, store) = store();
        let request = request();
        let (guard, state) = managed(&store, &request);
        let instance = guard.instance.clone();
        let original = store
            .transaction(|record| Ok(record.instance.clone().unwrap()))
            .unwrap();
        let task = tokio::spawn(async move {
            guard.run(&state).await;
        });
        for field in ["port", "environment", "ownership", "instance"] {
            store
                .transaction(|record| {
                    let current = record.instance.as_mut().unwrap();
                    match field {
                        "port" => current.port = Some(1),
                        "environment" => {
                            current.environment_id = Some(uuid::Uuid::new_v4().to_string())
                        }
                        "ownership" => current.ownership = SshHostOwnership::External,
                        _ => current.id = uuid::Uuid::new_v4().to_string(),
                    }
                    Ok(())
                })
                .unwrap();
            assert_ne!(
                probe(&store, &request).await.unwrap().outcome,
                SshHostOutcome::Ready,
                "{field}"
            );
            assert!(
                control(&instance, ControlOp::Probe).await.is_err(),
                "{field}"
            );
            store
                .transaction(|record| {
                    record.instance = Some(original.clone());
                    Ok(())
                })
                .unwrap();
            assert_eq!(
                probe(&store, &request).await.unwrap().outcome,
                SshHostOutcome::Ready
            );
        }
        task.abort();
        let _ = task.await;
    }

    #[test]
    fn records_are_bounded_private_and_corrupt_state_fails_closed() {
        let (_dir, store) = store();
        let request = request();
        reserve(&store, &request, |_| Ok(())).unwrap();
        let state = store.root.join("state.json");
        assert_eq!(fs::metadata(&state).unwrap().mode() & 0o077, 0);
        fs::write(&state, b"{broken}").unwrap();
        assert!(reserve(&store, &request, |_| panic!()).is_err());
        fs::write(&state, vec![b'x'; MAX_RECORD_BYTES as usize + 1]).unwrap();
        assert!(store.transaction(|_| Ok(())).is_err());
    }

    #[test]
    fn legacy_locator_selects_only_matching_identity_and_never_changes_catalogs() {
        let root = tempfile::tempdir().unwrap();
        let default = root.path().join("ordinary");
        let legacy = root.path().join(".gitgui/environments/old_key");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&default).unwrap();
        let expected = "gitgui-123456-1788413802919117400".to_string();
        let different = uuid::Uuid::new_v4().to_string();
        let write_identity = |path: &Path, id: &str| {
            fs::write(
                path.join("server.json"),
                serde_json::to_vec(&crate::PersistedServerIdentity {
                    schema_version: 1,
                    server_id: id.into(),
                })
                .unwrap(),
            )
            .unwrap()
        };
        write_identity(&legacy, &expected);
        write_identity(&default, &different);
        fs::write(legacy.join("repositories.json"), b"preserved legacy bytes").unwrap();
        assert_eq!(
            legacy_directory(root.path(), &default, "old_key", &expected, Some(&expected)).unwrap(),
            legacy
        );
        assert_eq!(
            legacy_directory(root.path(), &default, "old_key", &different, None),
            Err(SshHostOutcome::IdentityMismatch)
        );
        assert_eq!(
            legacy_directory(root.path(), &default, "../escape", &expected, None),
            Err(SshHostOutcome::InvalidRequest)
        );
        write_identity(&default, &expected);
        assert_eq!(
            legacy_directory(root.path(), &default, "old_key", &expected, None),
            Err(SshHostOutcome::Ambiguous)
        );
        assert_eq!(
            legacy_directory(root.path(), &default, "absent_key", &expected, None).unwrap(),
            default
        );
        assert_eq!(
            fs::read(legacy.join("repositories.json")).unwrap(),
            b"preserved legacy bytes"
        );
        assert_eq!(
            identity(&legacy).unwrap().as_deref(),
            Some(expected.as_str())
        );
    }
}
