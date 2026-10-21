//! Native filesystem notifications are invalidation hints, never Git state.
//! Each repository has one bounded pending change, including during event storms.
use super::{ServerState, SCOPE_REPOSITORY_READ};
use gitgui_core::git::watch::{metadata_directories, only_ignored};
use gitgui_protocol::{
    OrderedEventEnvelope, RepositoryChangeKind, RepositoryChanged, ServerLifecycle,
    EVENT_REPOSITORY_CHANGED,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

const QUIET: Duration = Duration::from_millis(200);
const MAX_DELAY: Duration = Duration::from_secs(1);

#[derive(Default)]
struct Pending {
    change: Option<(RepositoryChangeKind, Instant, Instant)>,
    rebuild: bool,
    worktree_paths: HashSet<PathBuf>,
    unfiltered_status: bool,
}

impl Pending {
    fn mark(&mut self, kind: RepositoryChangeKind) {
        let now = Instant::now();
        self.change = Some(match self.change {
            Some((previous, first, _)) => (
                if previous == RepositoryChangeKind::Snapshot {
                    previous
                } else {
                    kind
                },
                first,
                now,
            ),
            None => (kind, now, now),
        });
    }

    fn take_ready(&mut self) -> Option<(RepositoryChangeKind, Option<Vec<PathBuf>>)> {
        let (kind, first, last) = self.change?;
        if last.elapsed() < QUIET && first.elapsed() < MAX_DELAY {
            return None;
        }
        self.change = None;
        let paths = std::mem::take(&mut self.worktree_paths)
            .into_iter()
            .collect();
        let unfiltered = std::mem::take(&mut self.unfiltered_status);
        Some((kind, (!unfiltered).then_some(paths)))
    }
}

struct RepositoryWatch {
    _watcher: Option<RecommendedWatcher>,
    pending: Arc<Mutex<Pending>>,
    retry_at: Instant,
    root: String,
}

#[derive(Clone)]
struct Roots {
    worktree: PathBuf,
    git: PathBuf,
    common: PathBuf,
}

impl Roots {
    fn discover(root: &str) -> Result<Self, String> {
        let (git, common) = metadata_directories(Path::new(root)).map_err(|error| error.message)?;
        Ok(Self {
            worktree: PathBuf::from(root),
            git,
            common,
        })
    }

    fn classify(&self, path: &Path) -> Option<RepositoryChangeKind> {
        let path = normalize(path);
        // Check the worktree-specific Git directory before the shared directory.
        for git in [&self.git, &self.common] {
            if let Ok(relative) = path.strip_prefix(normalize(git)) {
                // Older-stash removal changes its reflog without moving refs/stash.
                if relative == Path::new("logs/refs/stash") {
                    return Some(RepositoryChangeKind::Snapshot);
                }
                let first = relative
                    .components()
                    .next()
                    .map(|part| part.as_os_str().to_string_lossy());
                if path
                    .extension()
                    .is_some_and(|extension| extension == "lock")
                {
                    return None;
                }
                return match first.as_deref() {
                    Some("objects" | "logs" | "hooks" | "rr-cache") => None,
                    Some(
                        "index" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "merge_head"
                        | "cherry_pick_head" | "revert_head" | "rebase-merge" | "rebase-apply",
                    ) => Some(RepositoryChangeKind::Status),
                    _ => Some(RepositoryChangeKind::Snapshot),
                };
            }
        }
        if path == normalize(&self.worktree.join(".git")) {
            return Some(RepositoryChangeKind::Snapshot);
        }
        path.starts_with(normalize(&self.worktree))
            .then_some(RepositoryChangeKind::Status)
    }
}

fn normalize(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy().replace('/', "\\");
        let value = value
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .unwrap_or_else(|| value.trim_start_matches(r"\\?\").to_string());
        PathBuf::from(value.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

impl RepositoryWatch {
    fn create(root: &str) -> Self {
        let pending = Arc::new(Mutex::new(Pending::default()));
        let callback_pending = pending.clone();
        let result = Roots::discover(root).and_then(|roots| {
            let classify_roots = roots.clone();
            let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
                let mut pending = callback_pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                match event {
                    Ok(event) if event.need_rescan() => {
                        pending.mark(RepositoryChangeKind::Snapshot);
                        pending.rebuild = true;
                    }
                    Ok(event) if !matches!(event.kind, EventKind::Access(_)) => {
                        if event.paths.is_empty() {
                            pending.mark(RepositoryChangeKind::Snapshot);
                        }
                        for path in event.paths {
                            if [
                                &classify_roots.worktree,
                                &classify_roots.git,
                                &classify_roots.common,
                                &classify_roots.worktree.join(".git"),
                            ]
                            .iter()
                            .any(|root| normalize(root) == normalize(&path))
                            {
                                pending.mark(RepositoryChangeKind::Snapshot);
                                pending.rebuild = true;
                                continue;
                            }
                            if let Some(kind) = classify_roots.classify(&path) {
                                pending.mark(kind);
                                if kind == RepositoryChangeKind::Status {
                                    let normalized = normalize(&path);
                                    if [&classify_roots.git, &classify_roots.common]
                                        .iter()
                                        .any(|git| normalized.starts_with(normalize(git)))
                                        || pending.worktree_paths.len() >= 128
                                    {
                                        pending.unfiltered_status = true;
                                    } else {
                                        let relative: PathBuf = path
                                            .components()
                                            .skip(classify_roots.worktree.components().count())
                                            .collect();
                                        pending.worktree_paths.insert(relative);
                                    }
                                }
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(_) => {
                        pending.mark(RepositoryChangeKind::Snapshot);
                        pending.rebuild = true;
                    }
                }
            })
            .map_err(|error| error.to_string())?;
            watcher
                .watch(&roots.worktree, RecursiveMode::Recursive)
                .map_err(|error| error.to_string())?;
            let mut watched = vec![&roots.worktree];
            for git in [&roots.common, &roots.git] {
                if watched
                    .iter()
                    .any(|parent| normalize(git).starts_with(normalize(parent)))
                {
                    continue;
                }
                watcher
                    .watch(git, RecursiveMode::Recursive)
                    .map_err(|error| error.to_string())?;
                watched.push(git);
            }
            Ok(watcher)
        });
        if let Err(error) = &result {
            tracing::warn!(%error, "repository watcher unavailable; using periodic invalidation");
        }
        // Cover changes between initial hydration and installing the watch.
        pending.lock().unwrap().mark(RepositoryChangeKind::Snapshot);
        let retry_delay = if result.is_ok() { 5 } else { 30 };
        Self {
            _watcher: result.ok(),
            pending,
            retry_at: Instant::now() + Duration::from_secs(retry_delay),
            root: root.to_string(),
        }
    }
}

pub(super) fn can_read(session: &gitgui_protocol::AuthSession) -> bool {
    session
        .scopes
        .iter()
        .any(|scope| scope == SCOPE_REPOSITORY_READ)
}

pub(super) async fn run(state: Weak<ServerState>) {
    let mut watches: HashMap<String, RepositoryWatch> = HashMap::new();
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    let mut sequence = 0;
    let mut catalog_tick = 0;
    loop {
        interval.tick().await;
        let Some(state) = state.upgrade() else {
            return;
        };
        if state.lifecycle().await != ServerLifecycle::Ready {
            return;
        }
        if state.repository_events.receiver_count() == 0 {
            watches.clear();
            continue;
        }
        catalog_tick += 1;
        if catalog_tick % 10 == 1 {
            let repositories = state.repositories.read().await.clone();
            watches.retain(|id, _| {
                repositories
                    .iter()
                    .any(|repository| &repository.summary.id == id)
            });
            for repository in repositories {
                let replace = watches.get(&repository.summary.id).is_none_or(|watch| {
                    Instant::now() >= watch.retry_at
                        && (watch._watcher.is_none() || watch.pending.lock().unwrap().rebuild)
                });
                if replace {
                    let root = repository.operation_path;
                    if let Ok(watch) =
                        tokio::task::spawn_blocking(move || RepositoryWatch::create(&root)).await
                    {
                        watches.insert(repository.summary.id, watch);
                    }
                }
            }
        }
        let mut changes = Vec::new();
        for (repository_id, watch) in &mut watches {
            let change = watch
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take_ready();
            if let Some((kind, paths)) = change {
                changes.push((repository_id.clone(), watch.root.clone(), kind, paths));
            }
        }
        for (repository_id, root, kind, paths) in changes {
            if kind == RepositoryChangeKind::Status {
                if let Some(paths) = paths {
                    if tokio::task::spawn_blocking(move || only_ignored(Path::new(&root), &paths))
                        .await
                        .unwrap_or(false)
                    {
                        continue;
                    }
                }
            }
            sequence += 1;
            let payload = serde_json::to_value(RepositoryChanged {
                repository_id,
                kind,
            })
            .expect("serializable invalidation");
            let _ = state.repository_events.send(OrderedEventEnvelope::new(
                sequence,
                EVENT_REPOSITORY_CHANGED,
                payload,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{load_open_repository, ServerConfig};
    use gitgui_core::git::command::GitCommand;
    use std::{fs, net::SocketAddr};
    use tokio::sync::broadcast;

    fn repo(parent: &Path, name: &str) -> PathBuf {
        let root = parent.join(name);
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Watch Test"]);
        git(&root, &["config", "user.email", "watch@example.test"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        fs::write(root.join("tracked.txt"), "initial\n").unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "Initial"]);
        root
    }

    fn git(root: &Path, args: &[&str]) {
        GitCommand::run(args, Some(root)).unwrap();
    }

    async fn change(
        rx: &mut broadcast::Receiver<OrderedEventEnvelope>,
        id: &str,
        kind: RepositoryChangeKind,
    ) -> u64 {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let event = rx.recv().await.unwrap();
                let payload: RepositoryChanged = serde_json::from_value(event.payload).unwrap();
                // Some native backends coalesce an index rename into a Git
                // directory event, which safely requests the stronger refresh.
                if payload.repository_id == id
                    && (payload.kind == kind || kind == RepositoryChangeKind::Status)
                {
                    return event.sequence;
                }
            }
        })
        .await
        .expect("repository notification")
    }

    #[test]
    fn classifies_worktree_git_and_shared_metadata_without_lock_or_object_noise() {
        let temp = tempfile::tempdir().unwrap();
        let root = repo(temp.path(), "repo with spaces æ");
        let roots = Roots::discover(root.to_str().unwrap()).unwrap();
        assert_eq!(
            roots.classify(&root.join("tracked.txt")),
            Some(RepositoryChangeKind::Status)
        );
        assert_eq!(
            roots.classify(&roots.git.join("index")),
            Some(RepositoryChangeKind::Status)
        );
        for path in [
            "HEAD",
            "refs/heads/main",
            "packed-refs",
            "config",
            "worktrees/other/HEAD",
            "logs/refs/stash",
        ] {
            assert_eq!(
                roots.classify(&roots.common.join(path)),
                Some(RepositoryChangeKind::Snapshot)
            );
        }
        for path in [
            "index.lock",
            "objects/pack/pack-test.pack",
            "logs/refs/heads/main",
        ] {
            assert_eq!(roots.classify(&roots.git.join(path)), None);
        }
        assert_eq!(roots.classify(&temp.path().join("outside.txt")), None);
        assert!(only_ignored(&root, &[PathBuf::from("ignored/build.out")]));
        assert!(!only_ignored(
            &root,
            &[
                PathBuf::from("ignored/build.out"),
                PathBuf::from("tracked.txt")
            ]
        ));
        fs::create_dir(root.join("ignored")).unwrap();
        fs::write(root.join("ignored/tracked.txt"), "tracked despite ignore").unwrap();
        git(&root, &["add", "-f", "ignored/tracked.txt"]);
        assert!(!only_ignored(
            &root,
            &[PathBuf::from("ignored/tracked.txt")]
        ));
    }

    #[test]
    fn batches_changes_without_downgrading_history_or_starving_during_storms() {
        let mut pending = Pending::default();
        pending.mark(RepositoryChangeKind::Snapshot);
        pending.mark(RepositoryChangeKind::Status);
        assert!(pending.take_ready().is_none());
        let (_, _, last) = pending.change.unwrap();
        pending.change = Some((
            RepositoryChangeKind::Snapshot,
            Instant::now() - MAX_DELAY,
            last,
        ));
        assert_eq!(
            pending.take_ready().unwrap().0,
            RepositoryChangeKind::Snapshot
        );
        assert!(pending.take_ready().is_none());
    }

    #[tokio::test]
    async fn native_changes_are_scoped_and_watches_follow_removal_and_shutdown() {
        let temp = tempfile::tempdir().unwrap();
        let root = repo(temp.path(), "one");
        let other = repo(temp.path(), "two");
        let one = load_open_repository(root.to_str().unwrap()).unwrap().0;
        let two = load_open_repository(other.to_str().unwrap()).unwrap().0;
        let id = one.summary.id.clone();
        let other_id = two.summary.id.clone();
        let state = Arc::new(ServerState::new(
            &ServerConfig::default(),
            "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
            vec![one, two],
        ));
        let mut rx = state.repository_events.subscribe();
        let task = tokio::spawn(run(Arc::downgrade(&state)));
        // Both initial invalidations may arrive in either order.
        let mut initial = HashSet::new();
        while initial.len() < 2 {
            let event = tokio::time::timeout(Duration::from_secs(8), rx.recv())
                .await
                .unwrap()
                .unwrap();
            let payload: RepositoryChanged = serde_json::from_value(event.payload).unwrap();
            initial.insert(payload.repository_id);
        }
        fs::create_dir(root.join("ignored")).unwrap();
        fs::write(root.join("ignored/build.out"), "build output\n").unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(600), rx.recv())
                .await
                .is_err(),
            "ignored build output must not refresh clients"
        );
        fs::write(root.join("tracked.txt"), "external edit\n").unwrap();
        let first = change(&mut rx, &id, RepositoryChangeKind::Status).await;
        assert!(
            rx.try_recv().is_err(),
            "an edit must not invalidate the unrelated repository"
        );
        fs::rename(root.join("tracked.txt"), root.join("renamed.txt")).unwrap();
        change(&mut rx, &id, RepositoryChangeKind::Status).await;
        git(&root, &["add", "-A"]);
        change(&mut rx, &id, RepositoryChangeKind::Status).await;
        git(&root, &["commit", "-m", "External commit"]);
        let next = change(&mut rx, &id, RepositoryChangeKind::Snapshot).await;
        assert!(next > first);
        let linked = temp.path().join("linked");
        git(
            &root,
            &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
        );
        let linked_roots = Roots::discover(linked.to_str().unwrap()).unwrap();
        assert_ne!(
            normalize(&linked_roots.git),
            normalize(&linked_roots.common)
        );
        assert_eq!(
            linked_roots.classify(&linked_roots.common.join("refs/heads/main")),
            Some(RepositoryChangeKind::Snapshot)
        );
        change(&mut rx, &id, RepositoryChangeKind::Snapshot).await;
        state.remove_repository(&id).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1300)).await;
        while rx.try_recv().is_ok() {}
        fs::write(root.join("renamed.txt"), "after removal\n").unwrap();
        fs::write(other.join("tracked.txt"), "second repository\n").unwrap();
        change(&mut rx, &other_id, RepositoryChangeKind::Status).await;
        assert!(rx.try_recv().is_err());
        state.set_lifecycle(ServerLifecycle::Stopping).await;
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn events_use_the_existing_websocket_and_read_scope() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message};
        let temp = tempfile::tempdir().unwrap();
        let root = repo(temp.path(), "socket");
        let server = crate::start(ServerConfig {
            repository_paths: vec![root.display().to_string()],
            ..ServerConfig::default()
        })
        .await
        .unwrap();
        let (mut socket, _) = connect_async(format!("ws://{}/ws", server.local_addr))
            .await
            .unwrap();
        let welcome: serde_json::Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(welcome["type"], "welcome");
        assert!(welcome["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "repositories.watch"));
        let initial = tokio::time::timeout(Duration::from_secs(8), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let initial: OrderedEventEnvelope =
            serde_json::from_str(initial.to_text().unwrap()).unwrap();
        fs::write(root.join("tracked.txt"), "socket edit\n").unwrap();
        let event = tokio::time::timeout(Duration::from_secs(8), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let event: OrderedEventEnvelope = serde_json::from_str(event.to_text().unwrap()).unwrap();
        let changed: RepositoryChanged = serde_json::from_value(event.payload).unwrap();
        assert_eq!(event.event, EVENT_REPOSITORY_CHANGED);
        assert_eq!(changed.kind, RepositoryChangeKind::Status);
        assert!(event.sequence > initial.sequence);
        socket.send(Message::Close(None)).await.unwrap();
        server.shutdown().await.unwrap();
        let denied = gitgui_protocol::AuthSession {
            session_id: "limited".into(),
            environment_id: "test".into(),
            scopes: vec!["access:read".into()],
            expires_at_unix_ms: 0,
        };
        assert!(!can_read(&denied));
    }
}
