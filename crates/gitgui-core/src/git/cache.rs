use super::command::GitError;
use super::repository::{CommitFile, CommitFileDiff};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};

const RECENT_COMMIT_FILE_LIST_LIMIT: usize = 500;
const RECENT_COMMIT_FILE_DIFF_LIMIT: usize = 100;
const RECENT_COMMIT_FILE_DIFF_BYTE_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommitFilesKey {
    pub repo_root: String,
    pub commit_hash: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommitFileDiffKey {
    pub repo_root: String,
    pub commit_hash: String,
    pub parent_hash: Option<String>,
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
}

#[derive(Default)]
pub struct CommitFilesCache {
    recent: HashMap<CommitFilesKey, Vec<CommitFile>>,
    recent_order: VecDeque<CommitFilesKey>,
    recent_diffs: HashMap<CommitFileDiffKey, CommitFileDiff>,
    recent_diff_bytes: usize,
    recent_diff_order: VecDeque<CommitFileDiffKey>,
    in_flight_diffs: HashMap<CommitFileDiffKey, InFlightCommitFileDiff>,
    file_list_epochs: HashMap<String, Arc<()>>,
}

pub type SharedCommitFilesCache = Arc<Mutex<CommitFilesCache>>;
pub type InFlightCommitFileDiff = Arc<(Mutex<Option<Result<CommitFileDiff, GitError>>>, Condvar)>;
pub struct FileListEpoch(Arc<()>);

pub enum CommitFileDiffLookup {
    Cached(CommitFileDiff),
    Loading(InFlightCommitFileDiff),
    StartLoad(InFlightCommitFileDiff),
}

impl CommitFilesCache {
    pub fn get(&mut self, key: &CommitFilesKey) -> Option<Vec<CommitFile>> {
        let files = self.recent.get(key)?.clone();
        self.touch_recent(key);
        Some(files)
    }

    pub fn insert_recent(&mut self, key: CommitFilesKey, files: Vec<CommitFile>) {
        self.recent.insert(key.clone(), files);
        self.touch_recent(&key);
        self.evict_recent();
    }

    /// Retain this token while loading outside the cache lock. Eviction retires
    /// it so a late read cannot repopulate a removed repository's cache.
    pub fn file_list_epoch(&mut self, repo_root: &str) -> FileListEpoch {
        FileListEpoch(
            self.file_list_epochs
                .entry(repo_root.to_owned())
                .or_insert_with(|| Arc::new(()))
                .clone(),
        )
    }

    pub fn insert_recent_if_current(
        &mut self,
        key: CommitFilesKey,
        files: Vec<CommitFile>,
        epoch: &FileListEpoch,
    ) -> bool {
        if !self
            .file_list_epochs
            .get(&key.repo_root)
            .is_some_and(|current| Arc::ptr_eq(current, &epoch.0))
        {
            return false;
        }
        self.insert_recent(key, files);
        true
    }

    pub fn get_diff(&mut self, key: &CommitFileDiffKey) -> Option<CommitFileDiff> {
        let diff = self.recent_diffs.get(key)?.clone();
        self.touch_recent_diff(key);
        Some(diff)
    }

    pub fn get_or_start_diff(&mut self, key: &CommitFileDiffKey) -> CommitFileDiffLookup {
        if let Some(diff) = self.recent_diffs.get(key).cloned() {
            self.touch_recent_diff(key);
            return CommitFileDiffLookup::Cached(diff);
        }

        if let Some(in_flight) = self.in_flight_diffs.get(key) {
            return CommitFileDiffLookup::Loading(in_flight.clone());
        }

        let in_flight = Arc::new((Mutex::new(None), Condvar::new()));
        self.in_flight_diffs.insert(key.clone(), in_flight.clone());
        CommitFileDiffLookup::StartLoad(in_flight)
    }

    pub fn insert_diff(&mut self, key: CommitFileDiffKey, diff: CommitFileDiff) {
        let size = commit_file_diff_size(&diff);
        if size > RECENT_COMMIT_FILE_DIFF_BYTE_LIMIT {
            self.remove_recent_diff(&key);
            self.recent_diff_order.retain(|existing| existing != &key);
            return;
        }

        self.remove_recent_diff(&key);
        self.recent_diffs.insert(key.clone(), diff);
        self.recent_diff_bytes = self.recent_diff_bytes.saturating_add(size);
        self.touch_recent_diff(&key);
        self.evict_recent_diffs();
    }

    pub fn finish_diff_load(
        &mut self,
        key: &CommitFileDiffKey,
        owner: &InFlightCommitFileDiff,
        result: Result<CommitFileDiff, GitError>,
    ) -> bool {
        // An evicted worker must not finish a newer load with the same key.
        if !self
            .in_flight_diffs
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, owner))
        {
            return false;
        }
        let Some(in_flight) = self.in_flight_diffs.remove(key) else {
            return false;
        };

        if let Ok(diff) = &result {
            self.insert_diff(key.clone(), diff.clone());
        }

        let (state, ready) = &*in_flight;
        let state_result = state.lock();
        if let Ok(mut state) = state_result {
            *state = Some(result);
            ready.notify_all();
        }
        true
    }

    pub fn evict_repo(&mut self, repo_root: &str) {
        self.file_list_epochs.remove(repo_root);
        self.recent.retain(|key, _| key.repo_root != repo_root);
        self.recent_order.retain(|key| key.repo_root != repo_root);
        self.recent_diffs
            .retain(|key, _| key.repo_root != repo_root);
        self.recent_diff_bytes = self.recent_diffs.values().map(commit_file_diff_size).sum();
        self.recent_diff_order
            .retain(|key| key.repo_root != repo_root);

        let evicted_in_flight = self
            .in_flight_diffs
            .extract_if(|key, _| key.repo_root == repo_root)
            .map(|(_, in_flight)| in_flight)
            .collect::<Vec<_>>();

        for in_flight in evicted_in_flight {
            let (state, ready) = &*in_flight;
            if let Ok(mut state) = state.lock() {
                *state = Some(Err(GitError {
                    message: "Repository was closed before the diff finished loading.".to_string(),
                    stderr: String::new(),
                    status: None,
                }));
                ready.notify_all();
            }
        }
    }

    fn touch_recent(&mut self, key: &CommitFilesKey) {
        self.recent_order.retain(|existing| existing != key);
        self.recent_order.push_back(key.clone());
    }

    fn evict_recent(&mut self) {
        while self.recent.len() > RECENT_COMMIT_FILE_LIST_LIMIT {
            let Some(oldest) = self.recent_order.pop_front() else {
                break;
            };

            self.recent.remove(&oldest);
        }
    }

    fn touch_recent_diff(&mut self, key: &CommitFileDiffKey) {
        self.recent_diff_order.retain(|existing| existing != key);
        self.recent_diff_order.push_back(key.clone());
    }

    fn evict_recent_diffs(&mut self) {
        while self.recent_diffs.len() > RECENT_COMMIT_FILE_DIFF_LIMIT
            || self.recent_diff_bytes > RECENT_COMMIT_FILE_DIFF_BYTE_LIMIT
        {
            let Some(oldest) = self.recent_diff_order.pop_front() else {
                break;
            };

            self.remove_recent_diff(&oldest);
        }
    }

    fn remove_recent_diff(&mut self, key: &CommitFileDiffKey) {
        if let Some(diff) = self.recent_diffs.remove(key) {
            self.recent_diff_bytes = self
                .recent_diff_bytes
                .saturating_sub(commit_file_diff_size(&diff));
        }
    }
}

fn commit_file_diff_size(diff: &CommitFileDiff) -> usize {
    [
        diff.original_path.as_ref().map_or(0, String::len),
        diff.modified_path.len(),
        diff.original_content.len(),
        diff.modified_content.len(),
        diff.message.as_ref().map_or(0, String::len),
        diff.patch.as_ref().map_or(0, String::len),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(path: &str) -> CommitFileDiffKey {
        CommitFileDiffKey {
            repo_root: "/repo".to_string(),
            commit_hash: "commit".to_string(),
            parent_hash: None,
            path: path.to_string(),
            original_path: None,
            status: "M".to_string(),
        }
    }

    fn diff(content: &str) -> CommitFileDiff {
        CommitFileDiff {
            original_path: None,
            modified_path: "file.txt".to_string(),
            original_content: content.to_string(),
            modified_content: String::new(),
            is_binary: false,
            message: None,
            patch: None,
        }
    }

    #[test]
    fn diff_cache_evicts_least_recent_entries_to_respect_byte_limit() {
        let mut cache = CommitFilesCache::default();
        let content = "x".repeat(8 * 1024 * 1024);
        let first = key("first.txt");
        let second = key("second.txt");

        cache.insert_diff(first.clone(), diff(&content));
        cache.insert_diff(second.clone(), diff(&content));

        assert!(cache.get_diff(&first).is_none());
        assert!(cache.get_diff(&second).is_some());
        assert!(cache.recent_diff_bytes <= RECENT_COMMIT_FILE_DIFF_BYTE_LIMIT);
    }

    #[test]
    fn native_patches_count_toward_the_cache_budget() {
        let mut entry = diff("");
        let base_size = commit_file_diff_size(&entry);
        entry.patch = Some("native patch".into());
        assert_eq!(commit_file_diff_size(&entry), base_size + 12);
        let mut cache = CommitFilesCache::default();
        cache.insert_diff(key("patch.txt"), entry);
        assert_eq!(cache.recent_diff_bytes, base_size + 12);
        cache.evict_repo("/repo");
        assert_eq!(cache.recent_diff_bytes, 0);
    }

    #[test]
    fn diff_larger_than_cache_budget_is_returned_uncached() {
        let mut cache = CommitFilesCache::default();
        let key = key("large.txt");

        cache.insert_diff(
            key.clone(),
            diff(&"x".repeat(RECENT_COMMIT_FILE_DIFF_BYTE_LIMIT + 1)),
        );

        assert!(cache.get_diff(&key).is_none());
        assert_eq!(cache.recent_diff_bytes, 0);
    }

    #[test]
    fn evicting_repository_releases_its_diff_cache_budget() {
        let mut cache = CommitFilesCache::default();
        let key = key("file.txt");
        cache.insert_diff(key.clone(), diff("contents"));

        cache.evict_repo("/repo");

        assert!(cache.get_diff(&key).is_none());
        assert_eq!(cache.recent_diff_bytes, 0);
    }

    #[test]
    fn evicted_diff_load_cannot_complete_replacement_or_its_waiters() {
        let mut cache = CommitFilesCache::default();
        let key = key("file.txt");
        let CommitFileDiffLookup::StartLoad(original) = cache.get_or_start_diff(&key) else {
            panic!("expected first load")
        };
        let CommitFileDiffLookup::Loading(old_waiter) = cache.get_or_start_diff(&key) else {
            panic!("expected old waiter")
        };
        cache.evict_repo("/repo");
        assert!(old_waiter.0.lock().unwrap().as_ref().unwrap().is_err());

        let CommitFileDiffLookup::StartLoad(replacement) = cache.get_or_start_diff(&key) else {
            panic!("expected replacement load")
        };
        let CommitFileDiffLookup::Loading(new_waiter) = cache.get_or_start_diff(&key) else {
            panic!("expected replacement waiter")
        };
        assert!(!cache.finish_diff_load(&key, &original, Ok(diff("old"))));
        assert!(new_waiter.0.lock().unwrap().is_none());
        assert!(cache.get_diff(&key).is_none());

        assert!(cache.finish_diff_load(&key, &replacement, Ok(diff("new"))));
        assert_eq!(
            new_waiter
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .as_ref()
                .unwrap()
                .original_content,
            "new"
        );
        assert_eq!(cache.get_diff(&key).unwrap().original_content, "new");
        assert!(old_waiter.0.lock().unwrap().as_ref().unwrap().is_err());
    }

    #[test]
    fn evicted_list_read_cannot_replace_new_data_or_affect_other_repositories() {
        let mut cache = CommitFilesCache::default();
        let key = CommitFilesKey {
            repo_root: "/repo".into(),
            commit_hash: "commit".into(),
        };
        let other = CommitFilesKey {
            repo_root: "/other".into(),
            commit_hash: "commit".into(),
        };
        let old = cache.file_list_epoch(&key.repo_root);
        let other_epoch = cache.file_list_epoch(&other.repo_root);
        cache.evict_repo("/repo");
        let new = cache.file_list_epoch(&key.repo_root);
        let file = |name: &str| CommitFile {
            path: name.into(),
            original_path: None,
            status: "M".into(),
        };
        assert!(cache.insert_recent_if_current(key.clone(), vec![file("new")], &new));
        assert!(!cache.insert_recent_if_current(key.clone(), vec![file("old")], &old));
        assert_eq!(cache.get(&key).unwrap()[0].path, "new");
        assert!(cache.insert_recent_if_current(other.clone(), vec![file("other")], &other_epoch));
        assert_eq!(cache.get(&other).unwrap()[0].path, "other");
    }

    #[test]
    fn eviction_wakes_old_waiter_and_replacement_wakes_its_own_waiter() {
        use std::sync::mpsc;
        use std::time::Duration;

        fn wait(
            in_flight: InFlightCommitFileDiff,
        ) -> (
            mpsc::Receiver<()>,
            mpsc::Receiver<bool>,
            std::thread::JoinHandle<()>,
        ) {
            let (ready_tx, ready_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            let handle = std::thread::spawn(move || {
                let mut value = in_flight.0.lock().unwrap();
                ready_tx.send(()).unwrap();
                while value.is_none() {
                    value = in_flight.1.wait(value).unwrap();
                }
                done_tx.send(value.as_ref().unwrap().is_ok()).unwrap();
            });
            (ready_rx, done_rx, handle)
        }

        let mut cache = CommitFilesCache::default();
        let key = key("file.txt");
        let CommitFileDiffLookup::StartLoad(old) = cache.get_or_start_diff(&key) else {
            panic!("expected old load")
        };
        let (ready, done, old_thread) = wait(old.clone());
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        cache.evict_repo("/repo");
        assert!(!done.recv_timeout(Duration::from_secs(2)).unwrap());
        old_thread.join().unwrap();
        let CommitFileDiffLookup::StartLoad(new) = cache.get_or_start_diff(&key) else {
            panic!("expected replacement load")
        };
        let (ready, done, new_thread) = wait(new.clone());
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(!cache.finish_diff_load(&key, &old, Ok(diff("old"))));
        assert!(done.try_recv().is_err());
        assert!(cache.finish_diff_load(&key, &new, Ok(diff("new"))));
        assert!(done.recv_timeout(Duration::from_secs(2)).unwrap());
        new_thread.join().unwrap();
    }
}
