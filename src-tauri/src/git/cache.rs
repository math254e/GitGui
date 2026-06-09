use super::command::GitError;
use super::repository::{CommitFile, CommitFileDiff};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};

const RECENT_COMMIT_FILE_LIST_LIMIT: usize = 500;
const RECENT_COMMIT_FILE_DIFF_LIMIT: usize = 100;

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
    recent_diff_order: VecDeque<CommitFileDiffKey>,
    in_flight_diffs: HashMap<CommitFileDiffKey, InFlightCommitFileDiff>,
}

pub type SharedCommitFilesCache = Arc<Mutex<CommitFilesCache>>;
pub type InFlightCommitFileDiff = Arc<(Mutex<Option<Result<CommitFileDiff, GitError>>>, Condvar)>;

pub enum CommitFileDiffLookup {
    Cached(CommitFileDiff),
    Loading(InFlightCommitFileDiff),
    StartLoad,
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
        CommitFileDiffLookup::StartLoad
    }

    pub fn insert_diff(&mut self, key: CommitFileDiffKey, diff: CommitFileDiff) {
        self.recent_diffs.insert(key.clone(), diff);
        self.touch_recent_diff(&key);
        self.evict_recent_diffs();
    }

    pub fn finish_diff_load(&mut self, key: &CommitFileDiffKey, result: Result<CommitFileDiff, GitError>) {
        let Some(in_flight) = self.in_flight_diffs.remove(key) else {
            return;
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
    }

    pub fn evict_repo(&mut self, repo_root: &str) {
        self.recent.retain(|key, _| key.repo_root != repo_root);
        self.recent_order.retain(|key| key.repo_root != repo_root);
        self.recent_diffs.retain(|key, _| key.repo_root != repo_root);
        self.recent_diff_order.retain(|key| key.repo_root != repo_root);

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
        while self.recent_diffs.len() > RECENT_COMMIT_FILE_DIFF_LIMIT {
            let Some(oldest) = self.recent_diff_order.pop_front() else {
                break;
            };

            self.recent_diffs.remove(&oldest);
        }
    }
}
