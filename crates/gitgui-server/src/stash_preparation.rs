//! Read preparation is speculative: one background job, no mutation locks, and
//! no dependency from an interactive request onto verification.
use super::*;
use gitgui_core::git::{
    repository::CommitFile, stash::StashTarget, stash_inspection_cache::StashValidation,
};
use std::{collections::VecDeque, sync::Weak};
use tokio::sync::Notify;

const QUEUE_LIMIT: usize = 64;
const RECENT_STASHES: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Work {
    Diff(String),
    Files,
    Validate,
}

impl Work {
    fn priority(&self) -> u8 {
        match self {
            Self::Diff(_) => 0,
            Self::Files => 1,
            Self::Validate => 2,
        }
    }
}

#[derive(Clone)]
struct Job {
    root: String,
    repository_id: String,
    target: StashTarget,
    epoch: u64,
    cache_generation: u64,
    selection: u64,
    work: Work,
}

#[derive(Default)]
struct Root {
    epoch: u64,
    cache_generation: u64,
    selection: u64,
    selected: String,
    catalog: Vec<(String, String)>,
}

#[derive(Default)]
struct Queue {
    roots: HashMap<String, Root>,
    jobs: VecDeque<Job>,
    next_epoch: u64,
    foreground: usize,
    stopped: bool,
}

#[derive(Default)]
pub(super) struct Preparation {
    queue: std::sync::Mutex<Queue>,
    notify: Notify,
}

pub(super) struct Foreground {
    owner: Arc<Preparation>,
    pub epoch: u64,
    pub selection: u64,
}

impl Drop for Foreground {
    fn drop(&mut self) {
        let mut queue = self.owner.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.foreground -= 1;
        drop(queue);
        self.owner.notify.notify_one();
    }
}

impl Queue {
    fn root(&mut self, root: &str) -> &mut Root {
        if !self.roots.contains_key(root) {
            self.next_epoch += 1;
            self.roots.insert(
                root.into(),
                Root {
                    epoch: self.next_epoch,
                    ..Root::default()
                },
            );
        }
        self.roots.get_mut(root).unwrap()
    }

    fn push(&mut self, job: Job) {
        if self.stopped
            || self.jobs.iter().any(|old| {
                old.root == job.root
                    && old.epoch == job.epoch
                    && old.cache_generation == job.cache_generation
                    && old.target.selector == job.target.selector
                    && old.target.expected_oid == job.target.expected_oid
                    && old.work == job.work
            })
        {
            return;
        }
        let index = self
            .jobs
            .iter()
            .position(|old| old.work.priority() >= job.work.priority())
            .unwrap_or(self.jobs.len());
        self.jobs.insert(index, job);
        self.jobs.truncate(QUEUE_LIMIT);
    }

    fn current(&self, job: &Job) -> bool {
        !self.stopped
            && self.roots.get(&job.root).is_some_and(|root| {
                root.epoch == job.epoch
                    && root.cache_generation == job.cache_generation
                    && (!matches!(job.work, Work::Diff(_))
                        || (root.selected == job.target.expected_oid
                            && root.selection == job.selection))
            })
    }

    fn take(&mut self) -> Option<Job> {
        if self.foreground != 0 || self.stopped {
            return None;
        }
        while let Some(job) = self.jobs.pop_front() {
            if self.current(&job) {
                return Some(job);
            }
        }
        None
    }
}

impl Preparation {
    pub fn foreground(
        self: &Arc<Self>,
        root: &str,
        oid: &str,
        cache_generation: u64,
    ) -> Foreground {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.foreground += 1;
        let state = queue.root(root);
        if state.cache_generation > cache_generation {
            return Foreground {
                owner: self.clone(),
                epoch: 0,
                selection: 0,
            };
        }
        if state.cache_generation != cache_generation {
            state.cache_generation = cache_generation;
            state.catalog.clear();
        }
        state.selected = oid.into();
        state.selection += 1;
        let epoch = state.epoch;
        let selection = state.selection;
        queue.jobs.retain(|job| {
            job.root != root
                || (job.cache_generation == cache_generation && !matches!(job.work, Work::Diff(_)))
        });
        Foreground {
            owner: self.clone(),
            epoch,
            selection,
        }
    }

    pub fn snapshot(
        &self,
        repository: &ConfiguredRepository,
        stashes: &[ProtocolStashInfo],
        cache_generation: u64,
    ) {
        let catalog = stashes
            .iter()
            .take(RECENT_STASHES)
            .map(|stash| (stash.selector.clone(), stash.hash.clone()))
            .collect::<Vec<_>>();
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let root = queue.root(&repository.operation_path);
        if root.cache_generation > cache_generation
            || (root.catalog == catalog && root.cache_generation == cache_generation)
        {
            return;
        }
        root.catalog = catalog.clone();
        root.cache_generation = cache_generation;
        let epoch = root.epoch;
        let selection = root.selection;
        queue.jobs.retain(|job| {
            job.root != repository.operation_path || job.cache_generation == cache_generation
        });
        for (selector, expected_oid) in catalog.into_iter().rev() {
            queue.push(Job {
                root: repository.operation_path.clone(),
                repository_id: repository.summary.id.clone(),
                target: StashTarget {
                    selector,
                    expected_oid,
                },
                epoch,
                cache_generation,
                selection,
                work: Work::Files,
            });
        }
        drop(queue);
        self.notify.notify_one();
    }

    pub fn after_read(
        &self,
        repository: &ConfiguredRepository,
        target: StashTarget,
        paths: &[String],
        expected_epoch: u64,
        cache_generation: u64,
        selection: u64,
    ) {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let Some(root) = queue.roots.get(&repository.operation_path) else {
            return;
        };
        if root.epoch != expected_epoch || root.cache_generation != cache_generation {
            return;
        }
        let epoch = root.epoch;
        let current_selection = root.selection == selection;
        let job = Job {
            root: repository.operation_path.clone(),
            repository_id: repository.summary.id.clone(),
            target,
            epoch,
            cache_generation,
            selection,
            work: Work::Validate,
        };
        queue.push(job.clone());
        for path in paths
            .iter()
            .take(if current_selection { 2 } else { 0 })
            .rev()
        {
            queue.push(Job {
                work: Work::Diff(path.clone()),
                ..job.clone()
            });
        }
        drop(queue);
        self.notify.notify_one();
    }

    pub fn forget(&self, root: &str) {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.roots.remove(root);
        queue.jobs.retain(|job| job.root != root);
    }

    pub fn stop(&self) {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.stopped = true;
        queue.jobs.clear();
        drop(queue);
        self.notify.notify_one();
    }

    fn current(&self, job: &Job) -> bool {
        self.queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .current(job)
    }
}

pub(super) async fn run(state_ref: Weak<ServerState>) {
    let Some(initial) = state_ref.upgrade() else {
        return;
    };
    let preparation = initial.stash_preparation.clone();
    drop(initial);
    loop {
        preparation.notify.notified().await;
        loop {
            // Coalesce refresh bursts; a new foreground request always gets
            // capacity before another speculative Git operation starts.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let Some(state) = state_ref.upgrade() else {
                return;
            };
            if state.lifecycle().await != ServerLifecycle::Ready {
                return;
            }
            let job = preparation
                .queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            let Some(job) = job else {
                break;
            };
            let cache = state.stash_cache.clone();
            drop(state);
            let work = job.clone();
            let result = spawn_blocking(move || match work.work {
                Work::Files => cache
                    .prepare_files_at(&work.root, &work.target, work.cache_generation)
                    .map(Some),
                Work::Diff(path) => cache
                    .diff_at(&work.root, &work.target, &path, work.cache_generation)
                    .map(|_| None),
                Work::Validate => cache
                    .validate_cached_at(&work.root, &work.target, work.cache_generation)
                    .map(|result| {
                        if result == StashValidation::Rejected {
                            Some(Vec::new())
                        } else {
                            None
                        }
                    }),
            })
            .await;
            if !preparation.current(&job) {
                continue;
            }
            let Some(state) = state_ref.upgrade() else {
                return;
            };
            if state.lifecycle().await != ServerLifecycle::Ready {
                return;
            }
            if let Ok(Ok(Some(files))) = result {
                if matches!(job.work, Work::Validate) {
                    state.publish_repository_change(gitgui_protocol::RepositoryChanged {
                        repository_id: job.repository_id,
                        kind: gitgui_protocol::RepositoryChangeKind::Snapshot,
                        paths: None,
                    });
                } else {
                    let paths = if preparation
                        .queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .roots
                        .get(&job.root)
                        .is_some_and(|root| root.selected == job.target.expected_oid)
                    {
                        files
                            .iter()
                            .take(2)
                            .map(|file: &CommitFile| file.path.clone())
                            .collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    };
                    if let Some(repository) = state.repository(&job.repository_id).await {
                        if repository.operation_path == job.root && preparation.current(&job) {
                            preparation.after_read(
                                &repository,
                                job.target,
                                &paths,
                                job.epoch,
                                job.cache_generation,
                                job.selection,
                            );
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(queue: &mut Queue, root: &str, oid: &str, work: Work) -> Job {
        let state = queue.root(root);
        let epoch = state.epoch;
        let selection = state.selection;
        Job {
            root: root.into(),
            repository_id: root.into(),
            target: StashTarget {
                selector: "stash@{0}".into(),
                expected_oid: oid.into(),
            },
            epoch,
            cache_generation: 0,
            selection,
            work,
        }
    }

    #[test]
    fn foreground_reserves_capacity_and_queue_prioritizes_and_deduplicates() {
        let preparation = Arc::new(Preparation::default());
        let foreground = preparation.foreground("repo", "selected", 0);
        let mut queue = preparation.queue.lock().unwrap();
        let validation = job(&mut queue, "repo", "selected", Work::Validate);
        let files = job(&mut queue, "repo", "selected", Work::Files);
        let diff = job(&mut queue, "repo", "selected", Work::Diff("a".into()));
        queue.push(validation);
        queue.push(files.clone());
        queue.push(files);
        queue.push(diff);
        assert_eq!(queue.jobs.len(), 3);
        assert!(queue.take().is_none());
        drop(queue);
        drop(foreground);
        let mut queue = preparation.queue.lock().unwrap();
        assert!(matches!(queue.take().unwrap().work, Work::Diff(_)));
        assert_eq!(queue.take().unwrap().work, Work::Files);
        assert_eq!(queue.take().unwrap().work, Work::Validate);
    }

    #[test]
    fn stale_selection_removal_reopen_and_shutdown_cannot_publish_old_work() {
        let preparation = Arc::new(Preparation::default());
        drop(preparation.foreground("repo", "a", 0));
        let old = job(
            &mut preparation.queue.lock().unwrap(),
            "repo",
            "a",
            Work::Diff("a".into()),
        );
        drop(preparation.foreground("repo", "b", 0));
        assert!(!preparation.current(&old));
        preparation.forget("repo");
        drop(preparation.foreground("repo", "a", 0));
        assert!(!preparation.current(&old));
        let current = job(
            &mut preparation.queue.lock().unwrap(),
            "repo",
            "a",
            Work::Files,
        );
        assert!(preparation.current(&current));
        preparation.stop();
        assert!(!preparation.current(&current));
    }

    #[test]
    fn speculative_queue_has_a_hard_bound() {
        let mut queue = Queue::default();
        for n in 0..100 {
            let next = job(&mut queue, "repo", &n.to_string(), Work::Files);
            queue.push(next);
        }
        assert_eq!(queue.jobs.len(), QUEUE_LIMIT);
    }

    #[test]
    fn changing_files_in_the_same_stash_discards_obsolete_diff_preparation() {
        let preparation = Arc::new(Preparation::default());
        let repository = ConfiguredRepository {
            operation_path: "repo".into(),
            summary: RepositorySummary {
                id: "repo".into(),
                name: "repo".into(),
                path: "repo".into(),
                root: "repo".into(),
                is_worktree: false,
            },
        };
        let target = StashTarget {
            selector: "stash@{0}".into(),
            expected_oid: "same snapshot".into(),
        };
        let first = preparation.foreground("repo", &target.expected_oid, 0);
        preparation.after_read(
            &repository,
            target.clone(),
            &["old next file".into()],
            first.epoch,
            0,
            first.selection,
        );
        let obsolete = preparation
            .queue
            .lock()
            .unwrap()
            .jobs
            .front()
            .unwrap()
            .clone();
        let second = preparation.foreground("repo", &target.expected_oid, 0);
        preparation.after_read(
            &repository,
            target.clone(),
            &["new next file".into()],
            second.epoch,
            0,
            second.selection,
        );
        // The old RPC or an old list prefetch can finish after the newer read.
        preparation.after_read(
            &repository,
            target,
            &["late obsolete file".into()],
            first.epoch,
            0,
            first.selection,
        );
        let queue = preparation.queue.lock().unwrap();
        assert!(!queue.current(&obsolete));
        let paths = queue
            .jobs
            .iter()
            .filter_map(|job| match &job.work {
                Work::Diff(path) => Some(path.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(paths, ["new next file"]);
    }

    #[tokio::test]
    async fn background_verification_rejects_bad_snapshot_once_and_filters_only_that_repository() {
        use crate::rpc_tests::{git, repository, state, GIT_FIXTURE_DEADLINE};
        let root = repository();
        git(root.path(), &["config", "core.autocrlf", "false"]);
        fs::write(root.path().join("unchanged.txt"), "baseline\n").unwrap();
        git(root.path(), &["add", "."]);
        git(root.path(), &["commit", "-m", "unchanged context"]);
        fs::write(root.path().join("file.txt"), "saved edit\n").unwrap();
        git(
            root.path(),
            &["stash", "push", "-m", "background inspection"],
        );
        let oid = git(root.path(), &["rev-parse", "refs/stash"]);
        let missing = git(root.path(), &["rev-parse", "HEAD:unchanged.txt"]);
        let state = state(root.path());
        let registration = state.repositories.read().await[0].clone();
        let target = StashTarget {
            selector: "stash@{0}".into(),
            expected_oid: oid,
        };
        // Removing an unchanged blob does not prevent a lightweight diff, but
        // the independent structural audit must eventually report it.
        fs::remove_file(
            root.path()
                .join(".git/objects")
                .join(&missing[..2])
                .join(&missing[2..]),
        )
        .unwrap();
        assert_eq!(
            state
                .stash_cache
                .files(&registration.operation_path, &target)
                .unwrap()
                .1
                .len(),
            1
        );
        let mut events = state.repository_events.subscribe();
        let mut snapshot = load_snapshot(&registration).unwrap();
        assert_eq!(snapshot.stashes.len(), 1);
        let generation = state.stash_cache.generation();
        state
            .prepare_stashes(&registration, &mut snapshot, generation)
            .await;
        let worker = tokio::spawn(run(Arc::downgrade(&state)));
        let event = tokio::time::timeout(GIT_FIXTURE_DEADLINE, events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.event, gitgui_protocol::EVENT_REPOSITORY_CHANGED);
        let change: gitgui_protocol::RepositoryChanged =
            serde_json::from_value(event.payload).unwrap();
        assert_eq!(change.repository_id, registration.summary.id);
        assert!(state
            .stash_cache
            .is_rejected(&registration.operation_path, &target.expected_oid));
        assert!(state
            .stash_cache
            .files(&registration.operation_path, &target)
            .is_err());
        let mut refreshed = load_snapshot(&registration).unwrap();
        state
            .prepare_stashes(&registration, &mut refreshed, generation)
            .await;
        assert!(refreshed.stashes.is_empty());
        assert_eq!(
            state
                .stash_cache
                .validate_cached(&registration.operation_path, &target)
                .unwrap(),
            StashValidation::Unchanged
        );
        assert!(events.try_recv().is_err());
        state.set_lifecycle(ServerLifecycle::Stopping).await;
        worker.await.unwrap();
    }

    #[tokio::test]
    async fn removed_registration_and_old_snapshot_cannot_recreate_preparation() {
        use crate::rpc_tests::{git, repository, state};
        let root = repository();
        git(root.path(), &["stash", "push", "-m", "old snapshot"]);
        let state = state(root.path());
        let registration = state.repositories.read().await[0].clone();
        let generation = state.stash_cache.generation();
        let mut old_snapshot = load_snapshot(&registration).unwrap();
        state
            .remove_repository(&registration.summary.id)
            .await
            .unwrap();
        state
            .prepare_stashes(&registration, &mut old_snapshot, generation)
            .await;
        assert!(state
            .stash_preparation
            .queue
            .lock()
            .unwrap()
            .roots
            .is_empty());
        state.upsert_repository(registration.clone()).await.unwrap();
        state
            .prepare_stashes(&registration, &mut old_snapshot, generation)
            .await;
        assert!(state
            .stash_preparation
            .queue
            .lock()
            .unwrap()
            .roots
            .is_empty());
        state
            .prepare_stashes(
                &registration,
                &mut old_snapshot,
                state.stash_cache.generation(),
            )
            .await;
        assert_eq!(state.stash_preparation.queue.lock().unwrap().jobs.len(), 1);
    }

    #[tokio::test]
    async fn removing_another_repository_reschedules_unchanged_catalog_in_new_generation() {
        use crate::rpc_tests::{git, repository, state};
        let retained = repository();
        git(retained.path(), &["stash", "push", "-m", "retained stash"]);
        let removed = repository();
        let state = state(retained.path());
        let registration = state.repositories.read().await[0].clone();
        let other = build_repository_catalog(&[removed.path().display().to_string()])
            .pop()
            .unwrap();
        let other = state.upsert_repository(other).await.unwrap();
        let generation = state.stash_cache.generation();
        let mut snapshot = load_snapshot(&registration).unwrap();
        state
            .prepare_stashes(&registration, &mut snapshot, generation)
            .await;
        let old = state
            .stash_preparation
            .queue
            .lock()
            .unwrap()
            .jobs
            .front()
            .unwrap()
            .clone();
        state.remove_repository(&other.summary.id).await.unwrap();
        let current = state.stash_cache.generation();
        assert_ne!(generation, current);
        state
            .prepare_stashes(&registration, &mut snapshot, current)
            .await;
        let queue = state.stash_preparation.queue.lock().unwrap();
        assert_eq!(queue.jobs.len(), 1);
        assert_eq!(queue.jobs[0].cache_generation, current);
        assert!(!queue.current(&old));
        assert!(queue.current(&queue.jobs[0]));
        drop(queue);
        // A late snapshot cannot overwrite the newly scheduled generation.
        state
            .prepare_stashes(&registration, &mut snapshot, generation)
            .await;
        assert_eq!(
            state.stash_preparation.queue.lock().unwrap().jobs[0].cache_generation,
            current
        );
    }
}
