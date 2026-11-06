//! Best-effort catalog metadata. Cache ownership is one catalog registration;
//! removing/re-registering a checkout cannot publish an older registration's read.
//! T3's RepositoryIdentityResolver (70cd258d8aac43ea57494527b00bf36de3efa6c0)
//! supplies the one-minute positive/negative TTL. GitGui additionally correlates
//! registered worktrees, bounds concurrency, and retains explicitly stale hints.

use super::*;
use gitgui_core::git::repository_identity::{resolve_repository_metadata, RepositoryMetadata};
use sha2::{Digest, Sha256};
use std::time::Instant;

pub(super) const CONCURRENCY: usize = 4;
const TTL: Duration = Duration::from_secs(60);

#[derive(Default, Debug)]
pub(super) struct Cached {
    checked_at: Option<Instant>,
    stamps: Vec<Option<FileStamp>>,
    value: Option<RepositoryMetadata>,
    stale: bool,
    #[cfg(test)]
    reads: usize,
    #[cfg(test)]
    gate: Option<Arc<TestGate>>,
}

#[derive(Debug, PartialEq, Eq)]
struct FileStamp {
    length: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}

#[cfg(test)]
#[derive(Default, Debug)]
struct TestGate {
    entered: tokio::sync::Notify,
    released: std::sync::Mutex<bool>,
    changed: std::sync::Condvar,
}

#[cfg(test)]
impl TestGate {
    fn block(&self) {
        self.entered.notify_one();
        let mut released = self.released.lock().unwrap();
        while !*released {
            let (next, timeout) = self
                .changed
                .wait_timeout(released, Duration::from_secs(10))
                .unwrap();
            released = next;
            if timeout.timed_out() {
                break;
            }
        }
    }

    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

impl Cached {
    fn refresh(&mut self, root: &str) -> bool {
        let missing = directory_missing(root);
        if missing {
            self.stale = true;
        }
        let paths = self
            .value
            .as_ref()
            .map(|value| value.watch_paths.clone())
            .unwrap_or_else(|| vec![Path::new(root).join(".git")]);
        let stamps = file_stamps(&paths);
        if self
            .checked_at
            .is_some_and(|checked| checked.elapsed() < TTL)
            && stamps == self.stamps
        {
            return missing;
        }
        if missing {
            self.stale = true;
        } else {
            #[cfg(test)]
            {
                self.reads += 1;
                if let Some(gate) = &self.gate {
                    gate.block();
                }
            }
            match resolve_repository_metadata(Path::new(root)) {
                Ok(value) => {
                    self.value = Some(value);
                    self.stale = false;
                }
                // Failure output can contain credentials. It never reaches logs,
                // persistence or the wire, and cannot erase last-known hints.
                Err(_) => self.stale = true,
            }
        }
        self.stamps = file_stamps(
            &self
                .value
                .as_ref()
                .map(|value| value.watch_paths.clone())
                .unwrap_or_else(|| paths.clone()),
        );
        // Never bless a read with a newer configuration's stamp. If an
        // already-observed path changed during discovery, revalidate next time.
        let same_paths = self
            .value
            .as_ref()
            .is_none_or(|value| value.watch_paths == paths);
        let changed_during_read = same_paths && self.stamps != stamps;
        self.stale |= changed_during_read;
        self.checked_at = (!changed_during_read).then(Instant::now);
        missing
    }

    fn apply(&self, summary: &mut RepositorySummary, environment_id: &str) {
        summary.metadata_stale = self.stale.then_some(true);
        let Some(value) = &self.value else {
            return;
        };
        summary.repository_identity = value
            .canonical_key
            .clone()
            .map(|canonical_key| gitgui_protocol::RepositoryIdentity { canonical_key });
        let mut hash = Sha256::new();
        hash.update(environment_id.as_bytes());
        hash.update([0]);
        hash.update(path_key(&value.common_dir.to_string_lossy()).as_bytes());
        summary.worktree_family = Some(gitgui_protocol::RepositoryWorktreeFamily {
            id: format!("family-{:x}", hash.finalize()),
            main_root: value
                .main_root
                .as_ref()
                .map(|root| root.to_string_lossy().into_owned()),
        });
        summary.is_worktree = value.is_linked_worktree;
        if let Some(root) = &value.main_root {
            if let Some(name) = root.file_name() {
                summary.name = name.to_string_lossy().into_owned();
            }
        }
    }
}

fn file_stamps(paths: &[PathBuf]) -> Vec<Option<FileStamp>> {
    paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            fs::metadata(path).ok().map(|metadata| {
                // The first path is .git. Its directory mtime changes on normal
                // index/HEAD writes; those must not defeat the identity TTL.
                // Gitfiles and the shared worktrees directory do need mtimes.
                let git_directory = index == 0 && metadata.is_dir();
                FileStamp {
                    length: if git_directory { 0 } else { metadata.len() },
                    modified: if git_directory {
                        None
                    } else {
                        metadata.modified().ok()
                    },
                    created: metadata.created().ok(),
                }
            })
        })
        .collect()
}

impl ServerState {
    pub(super) async fn hydrate_repository(
        &self,
        mut repository: ConfiguredRepository,
    ) -> ConfiguredRepository {
        let entry = repository.metadata.clone().lock_owned().await;
        let Ok(permit) = self.metadata_slots.clone().acquire_owned().await else {
            return repository;
        };
        let Some(work) = self.work.enter() else {
            return repository;
        };
        let root = repository.operation_path.clone();
        let mut summary = repository.summary.clone();
        let environment_id = self.info.environment_id.clone();
        // The lock, concurrency permit and lifecycle work guard belong to the
        // actual worker, even if its RPC is cancelled or disconnects.
        if let Ok(updated) = spawn_blocking(move || {
            let _work = work;
            let _permit = permit;
            let mut entry = entry;
            summary.missing = entry.refresh(&root).then_some(true);
            entry.apply(&mut summary, &environment_id);
            summary
        })
        .await
        {
            repository.summary = updated;
            if let Some(current) = self
                .repositories
                .write()
                .await
                .iter_mut()
                .find(|current| Arc::ptr_eq(&current.metadata, &repository.metadata))
            {
                // Availability is also the watcher's explicit recovery signal.
                current.summary = repository.summary.clone();
            }
        }
        repository
    }

    pub(super) async fn registration_is_current(&self, repository: &ConfiguredRepository) -> bool {
        self.repositories.read().await.iter().any(|current| {
            current.summary.id == repository.summary.id
                && Arc::ptr_eq(&current.metadata, &repository.metadata)
        })
    }

    pub(super) async fn repository_with_metadata(&self, id: &str) -> Option<ConfiguredRepository> {
        let repository = self.repository(id).await?;
        let repository = self.hydrate_repository(repository).await;
        self.registration_is_current(&repository)
            .await
            .then_some(repository)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gitgui_core::git::command::GitCommand;

    fn git(root: &Path, args: &[&str]) {
        GitCommand::run(args, Some(root)).unwrap();
    }

    fn repository() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q", "-b", "main"]);
        git(
            root.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
        );
        root
    }

    fn state(paths: &[&Path], environment_id: &str) -> Arc<ServerState> {
        Arc::new(ServerState::new(
            &ServerConfig {
                server_id: environment_id.into(),
                ..ServerConfig::default()
            },
            "127.0.0.1:0".parse().unwrap(),
            build_repository_catalog(
                &paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
            ),
        ))
    }

    async fn cache(state: &ServerState) -> Arc<Mutex<Cached>> {
        state.repositories.read().await[0].metadata.clone()
    }

    #[tokio::test]
    async fn catalog_metadata_keeps_clones_distinct_and_scopes_worktree_families_to_environment() {
        let main = repository();
        let other = repository();
        let linked_parent = tempfile::tempdir().unwrap();
        let linked = linked_parent.path().join("linked checkout");
        git(
            main.path(),
            &["worktree", "add", "--detach", linked.to_str().unwrap()],
        );
        for root in [main.path(), other.path()] {
            git(
                root,
                &[
                    "remote",
                    "add",
                    "origin",
                    "https://user:password@example.com/team/repo.git",
                ],
            );
        }
        let first = state(&[main.path(), other.path(), &linked], "first-environment");
        let summaries = first.repository_summaries().await;
        assert_eq!(summaries.len(), 3);
        assert_ne!(summaries[0].id, summaries[1].id);
        assert_ne!(summaries[0].id, summaries[2].id);
        for summary in &summaries {
            assert_eq!(
                summary.repository_identity.as_ref().unwrap().canonical_key,
                "example.com/team/repo"
            );
            assert_eq!(summary.metadata_stale, None);
        }
        assert_eq!(
            summaries[0].worktree_family.as_ref().unwrap().id,
            summaries[2].worktree_family.as_ref().unwrap().id
        );
        assert_ne!(
            summaries[0].worktree_family.as_ref().unwrap().id,
            summaries[1].worktree_family.as_ref().unwrap().id
        );
        assert!(summaries[2].is_worktree);
        assert_eq!(
            summaries[2]
                .worktree_family
                .as_ref()
                .unwrap()
                .main_root
                .as_ref(),
            Some(&canonicalize_path(main.path().to_str().unwrap()))
        );
        let second = state(&[main.path()], "second-environment");
        let second = second.repository_summaries().await;
        assert_eq!(
            second[0].id, summaries[0].id,
            "existing checkout IDs do not migrate"
        );
        assert_ne!(
            second[0].worktree_family.as_ref().unwrap().id,
            summaries[0].worktree_family.as_ref().unwrap().id
        );
        let wire = serde_json::to_string(&summaries).unwrap();
        assert!(!wire.contains("password") && !wire.contains("https://"));
    }

    #[tokio::test]
    async fn positive_negative_and_failed_reads_are_cached_and_config_changes_invalidate() {
        let root = repository();
        let state = state(&[root.path()], "environment");
        let cache = cache(&state).await;
        let first = state.repository_summaries().await.remove(0);
        assert!(first.repository_identity.is_none());
        assert!(first.worktree_family.is_some());
        state.repository_summaries().await;
        assert_eq!(cache.lock().await.reads, 1, "negative identity is cached");

        git(
            root.path(),
            &["remote", "add", "origin", "git@example.com:team/repo.git"],
        );
        let updated = state.repository_summaries().await.remove(0);
        assert_eq!(
            updated.repository_identity.unwrap().canonical_key,
            "example.com/team/repo"
        );
        assert_eq!(cache.lock().await.reads, 2);
        fs::write(root.path().join("staged file"), "content").unwrap();
        git(root.path(), &["add", "staged file"]);
        state.repository_summaries().await;
        assert_eq!(
            cache.lock().await.reads,
            2,
            "ordinary index updates do not invalidate identity"
        );
        let mut readers = JoinSet::new();
        for _ in 0..12 {
            let state = state.clone();
            readers.spawn(async move { state.repository_summaries().await });
        }
        while let Some(result) = readers.join_next().await {
            assert_eq!(result.unwrap().len(), 1);
        }
        assert_eq!(cache.lock().await.reads, 2, "warm reads do not start Git");
        cache.lock().await.checked_at = Some(Instant::now() - TTL);
        state.repository_summaries().await;
        assert_eq!(cache.lock().await.reads, 3, "TTL revalidates metadata");

        let config = root.path().join(".git/config");
        let valid = fs::read(&config).unwrap();
        fs::write(&config, b"[invalid config containing a secret").unwrap();
        let failed = state.repository_summaries().await.remove(0);
        assert_eq!(failed.metadata_stale, Some(true));
        assert_eq!(
            failed.repository_identity.unwrap().canonical_key,
            "example.com/team/repo"
        );
        assert!(failed.worktree_family.is_some());
        assert_eq!(failed.missing, None);
        state.repository_summaries().await;
        assert_eq!(cache.lock().await.reads, 4, "failures are cached too");
        fs::write(&config, valid).unwrap();
        git(root.path(), &["remote", "remove", "origin"]);
        let cleared = state.repository_summaries().await.remove(0);
        assert!(
            cleared.repository_identity.is_none(),
            "a successful no-remote read clears old identity"
        );
        assert_eq!(cleared.metadata_stale, None);
    }

    #[tokio::test]
    async fn missing_checkout_retains_stale_metadata_without_failing_other_entries_and_recovers() {
        let root = repository();
        let other = repository();
        git(
            root.path(),
            &["remote", "add", "origin", "git@example.com:team/repo"],
        );
        let state = state(&[root.path(), other.path()], "environment");
        let before = state.repository_summaries().await;
        let parking = tempfile::tempdir().unwrap();
        let moved = parking.path().join("temporarily moved checkout");
        fs::rename(root.path(), &moved).unwrap();
        let missing = state.repository_summaries().await;
        assert_eq!(missing.len(), 2);
        assert_eq!(missing[0].missing, Some(true));
        assert_eq!(missing[0].metadata_stale, Some(true));
        assert_eq!(
            missing[0]
                .repository_identity
                .as_ref()
                .unwrap()
                .canonical_key,
            "example.com/team/repo"
        );
        assert_eq!(
            missing[0].worktree_family.as_ref().unwrap().id,
            before[0].worktree_family.as_ref().unwrap().id
        );
        assert_eq!(missing[1].metadata_stale, None);
        fs::rename(&moved, root.path()).unwrap();
        let restored = state.repository_summaries().await;
        assert_eq!(restored[0].missing, None);
        assert_eq!(restored[0].metadata_stale, None);
    }

    #[tokio::test]
    async fn late_reads_cannot_repopulate_removed_or_re_registered_catalog_entries() {
        let root = repository();
        git(
            root.path(),
            &["remote", "add", "origin", "git@example.com:team/old"],
        );
        let state = state(&[root.path()], "environment");
        let old = state.repositories.read().await[0].clone();
        let gate = Arc::new(TestGate::default());
        old.metadata.lock().await.gate = Some(gate.clone());
        let pending = {
            let state = state.clone();
            tokio::spawn(async move { state.repository_summaries().await })
        };
        tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
            .await
            .unwrap();
        assert!(state.remove_repository(&old.summary.id).await.unwrap());
        git(
            root.path(),
            &["remote", "set-url", "origin", "git@example.com:team/new"],
        );
        let info = resolve_repository(root.path().to_str().unwrap()).unwrap();
        let new = state
            .upsert_repository(configured_from_repository_info(&info))
            .await
            .unwrap();
        assert_eq!(old.summary.id, new.summary.id);
        assert!(!Arc::ptr_eq(&old.metadata, &new.metadata));
        gate.release();
        assert!(
            pending.await.unwrap().is_empty(),
            "a late list must not expose an old registration"
        );
        let late = state.hydrate_repository(old).await;
        assert!(!state.registration_is_current(&late).await);
        let summaries = state.repository_summaries().await;
        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0]
                .repository_identity
                .as_ref()
                .unwrap()
                .canonical_key,
            "example.com/team/new"
        );
        state.remove_repository(&new.summary.id).await.unwrap();
        state.hydrate_repository(late).await;
        assert!(state.repository_summaries().await.is_empty());
    }

    #[tokio::test]
    async fn bounded_workers_keep_lifecycle_and_cache_ownership_after_cancellation() {
        let roots: Vec<_> = (0..CONCURRENCY + 1).map(|_| repository()).collect();
        let state = state(
            &roots.iter().map(|root| root.path()).collect::<Vec<_>>(),
            "environment",
        );
        let entries: Vec<_> = state
            .repositories
            .read()
            .await
            .iter()
            .map(|repository| repository.metadata.clone())
            .collect();
        let mut gates = Vec::new();
        for entry in &entries {
            let gate = Arc::new(TestGate::default());
            entry.lock().await.gate = Some(gate.clone());
            gates.push(gate);
        }
        let pending = {
            let state = state.clone();
            tokio::spawn(async move { state.repository_summaries().await })
        };
        for gate in &gates[..CONCURRENCY] {
            tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
                .await
                .unwrap();
        }
        let extra_waited = tokio::time::timeout(
            Duration::from_millis(30),
            gates[CONCURRENCY].entered.notified(),
        )
        .await
        .is_err();
        state.work.pause();
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        let drain_waited = tokio::time::timeout(Duration::from_millis(30), state.work.drained())
            .await
            .is_err();
        let slots_held = state.metadata_slots.available_permits();
        let caches_held = entries[..CONCURRENCY]
            .iter()
            .all(|entry| entry.try_lock().is_err());
        for gate in &gates {
            gate.release();
        }
        tokio::time::timeout(Duration::from_secs(10), state.work.drained())
            .await
            .unwrap();
        assert!(extra_waited && drain_waited && caches_held);
        assert_eq!(slots_held, 0);
        assert_eq!(state.metadata_slots.available_permits(), CONCURRENCY);
        assert_eq!(entries[CONCURRENCY].lock().await.reads, 0);
    }

    #[tokio::test]
    async fn catalog_write_failures_preserve_membership_and_metadata_cache() {
        let root = repository();
        let other = repository();
        let persistence = tempfile::tempdir().unwrap();
        let invalid_directory = persistence.path().join("not a directory");
        fs::write(&invalid_directory, b"fixture").unwrap();
        let mut state = state(&[root.path()], "environment");
        Arc::get_mut(&mut state).unwrap().data_dir = Some(invalid_directory);
        let first = state.repository_summaries().await.remove(0);
        let original = cache(&state).await;
        assert!(state.remove_repository(&first.id).await.is_err());
        let existing = configured_from_repository_info(
            &resolve_repository(root.path().to_str().unwrap()).unwrap(),
        );
        assert!(state.upsert_repository(existing).await.is_err());
        let addition = configured_from_repository_info(
            &resolve_repository(other.path().to_str().unwrap()).unwrap(),
        );
        assert!(state.upsert_repository(addition).await.is_err());
        let summaries = state.repository_summaries().await;
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, first.id);
        assert!(Arc::ptr_eq(&original, &cache(&state).await));
        assert_eq!(original.lock().await.reads, 1);
    }

    #[tokio::test]
    async fn config_changes_during_discovery_cannot_poison_the_fresh_cache_stamp() {
        let root = repository();
        let state = state(&[root.path()], "environment");
        state.repository_summaries().await;
        let cache = cache(&state).await;
        let gate = Arc::new(TestGate::default());
        {
            let mut cache = cache.lock().await;
            cache.checked_at = Some(Instant::now() - TTL);
            cache.gate = Some(gate.clone());
        }
        let pending = {
            let state = state.clone();
            tokio::spawn(async move { state.repository_summaries().await })
        };
        tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
            .await
            .unwrap();
        git(
            root.path(),
            &["remote", "add", "origin", "git@example.com:team/new"],
        );
        gate.release();
        assert_eq!(pending.await.unwrap()[0].metadata_stale, Some(true));
        assert!(cache.lock().await.checked_at.is_none());
        let verified = state.repository_summaries().await;
        assert_eq!(verified[0].metadata_stale, None);
        assert_eq!(
            verified[0]
                .repository_identity
                .as_ref()
                .unwrap()
                .canonical_key,
            "example.com/team/new"
        );
        assert_eq!(cache.lock().await.reads, 3);
    }

    #[tokio::test]
    async fn authorization_and_quiescence_block_metadata_work_before_cache_access() {
        let root = repository();
        let state = state(&[root.path()], "environment");
        let cache = cache(&state).await;
        let mut session = AuthSession {
            session_id: "fixture".into(),
            environment_id: state.info.environment_id.clone(),
            scopes: vec![SCOPE_REPOSITORY_OPERATE.into()],
            expires_at_unix_ms: u64::MAX,
        };
        let request = || RequestEnvelope {
            id: "fixture".into(),
            method: METHOD_REPOSITORIES_LIST.into(),
            params: json!({}),
        };
        let response =
            serde_json::to_value(dispatch_authorized(request(), &state, &session).await).unwrap();
        assert_eq!(response["error"]["code"], error_codes::FORBIDDEN);
        assert_eq!(cache.lock().await.reads, 0);
        session.scopes = vec![SCOPE_REPOSITORY_READ.into()];
        let response =
            serde_json::to_value(dispatch_authorized(request(), &state, &session).await).unwrap();
        assert_eq!(response["ok"], true);
        let response = serde_json::to_value(
            dispatch_authorized(
                RequestEnvelope {
                    id: "fixture".into(),
                    method: METHOD_REPOSITORIES_OPEN.into(),
                    params: json!({"path": root.path()}),
                },
                &state,
                &session,
            )
            .await,
        )
        .unwrap();
        assert_eq!(response["error"]["code"], error_codes::FORBIDDEN);
        state.work.pause();
        let response =
            serde_json::to_value(dispatch_authorized(request(), &state, &session).await).unwrap();
        assert_eq!(response["error"]["code"], error_codes::SERVER_BUSY);
        assert_eq!(cache.lock().await.reads, 1);
        state.work.drained().await;
    }

    #[tokio::test]
    async fn open_list_snapshot_and_refresh_share_metadata_without_changing_checkout_ids() {
        let root = repository();
        git(
            root.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://token@example.com/team/repo.git",
            ],
        );
        let state = state(&[], "environment");
        let call = |method: &str, params| RequestEnvelope {
            id: "metadata-fixture".into(),
            method: method.into(),
            params,
        };
        let session = AuthSession {
            session_id: "fixture".into(),
            environment_id: state.info.environment_id.clone(),
            scopes: vec![SCOPE_REPOSITORY_MANAGE.into(), SCOPE_REPOSITORY_READ.into()],
            expires_at_unix_ms: u64::MAX,
        };
        let response = serde_json::to_value(
            dispatch_authorized(
                call(METHOD_REPOSITORIES_OPEN, json!({"path": root.path()})),
                &state,
                &session,
            )
            .await,
        )
        .unwrap();
        assert_eq!(response["ok"], true, "{response}");
        let summary = response["result"]["repository"].clone();
        let id = summary["id"].as_str().unwrap();
        assert_eq!(
            summary["repositoryIdentity"]["canonicalKey"],
            "example.com/team/repo"
        );
        assert!(summary["worktreeFamily"]["id"]
            .as_str()
            .unwrap()
            .starts_with("family-"));
        assert_eq!(
            id,
            stable_repository_id(&canonicalize_path(root.path().to_str().unwrap()))
        );
        for (method, params, pointer) in [
            (
                METHOD_REPOSITORIES_LIST,
                json!({}),
                "/result/repositories/0",
            ),
            (
                METHOD_REPOSITORIES_GET_SNAPSHOT,
                json!({"repositoryId": id}),
                "/result/repository",
            ),
            (
                METHOD_REPOSITORIES_REFRESH,
                json!({"repositoryIds": [id]}),
                "/result/repositories/0/repository",
            ),
        ] {
            let response = serde_json::to_value(
                dispatch_authorized(call(method, params), &state, &session).await,
            )
            .unwrap();
            assert_eq!(
                response.pointer(pointer),
                Some(&summary),
                "{method}: {response}"
            );
        }
        assert_eq!(cache(&state).await.lock().await.reads, 1);
    }
}
