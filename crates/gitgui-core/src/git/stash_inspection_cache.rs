//! Bounded, immutable stash reads. Foreground lookups only recheck the live
//! selector; whole-object verification is explicit background work.
use super::{
    repository::{CommitFile, CommitFileDiff, StashInfo},
    stash::{invalid, resolve_stash_oid, validate_saved_path, StashError, StashTarget},
    stash_inspection::StashInspection,
    stash_read::StashReadPlan,
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

const ENTRY_LIMIT: usize = 32;
const BYTE_LIMIT: usize = 32 * 1024 * 1024;
const DIFF_LIMIT: usize = 100;
const DIFF_BYTE_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StashValidation {
    Verified,
    Rejected,
    Unchanged,
}

#[derive(Default)]
enum Validation {
    #[default]
    Unchecked,
    Running,
    Verified,
    Rejected(StashError),
}

#[derive(Default)]
struct ReadSlot {
    read: OnceLock<Result<Arc<StashReadPlan>, StashError>>,
    validation: Mutex<Validation>,
}
type Slot = Arc<ReadSlot>;
type DiffSlot = Arc<OnceLock<Result<CommitFileDiff, StashError>>>;

struct Entry {
    root: String,
    oid: String,
    slot: Slot,
}

struct DiffEntry {
    root: String,
    oid: String,
    path: String,
    slot: DiffSlot,
}
impl DiffEntry {
    fn retained_bytes(&self) -> usize {
        256 + self.root.len()
            + self.oid.len()
            + self.path.len()
            + self
                .slot
                .get()
                .and_then(|result| result.as_ref().ok())
                .map_or(0, diff_bytes)
    }
}

/// Owned by one server environment. Git runs outside cache locks. Cold reads
/// share a small foreground plan; strict verification never occupies its slot.
pub struct StashInspectionCache {
    recent: Mutex<VecDeque<Entry>>,
    diffs: Mutex<VecDeque<DiffEntry>>,
    generation: AtomicU64,
    entry_limit: usize,
    byte_limit: usize,
    diff_limit: usize,
    diff_byte_limit: usize,
}

impl Default for StashInspectionCache {
    fn default() -> Self {
        Self {
            recent: Mutex::default(),
            diffs: Mutex::default(),
            generation: AtomicU64::default(),
            entry_limit: ENTRY_LIMIT,
            byte_limit: BYTE_LIMIT,
            diff_limit: DIFF_LIMIT,
            diff_byte_limit: DIFF_BYTE_LIMIT,
        }
    }
}

fn accepted(slot: &ReadSlot) -> Result<(), StashError> {
    match &*slot
        .validation
        .lock()
        .map_err(|_| invalid("Saved validation unavailable"))?
    {
        Validation::Rejected(error) => Err(error.clone()),
        _ => Ok(()),
    }
}

fn diff_bytes(diff: &CommitFileDiff) -> usize {
    diff.original_content.len()
        + diff.modified_content.len()
        + diff.modified_path.len()
        + diff.original_path.as_ref().map_or(0, String::len)
        + diff.patch.as_ref().map_or(0, String::len)
        + diff.message.as_ref().map_or(0, String::len)
}

impl StashInspectionCache {
    /// Capture before repository discovery or enqueueing speculative work.
    /// Catalog removals conservatively invalidate queued work across roots.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn read_at(
        &self,
        root: &str,
        target: &StashTarget,
        generation: u64,
    ) -> Result<(Arc<StashReadPlan>, Slot), StashError> {
        self.read_at_using(root, generation, || resolve_stash_oid(root, target))
    }

    fn read_at_using(
        &self,
        root: &str,
        generation: u64,
        resolve: impl FnOnce() -> Result<String, StashError>,
    ) -> Result<(Arc<StashReadPlan>, Slot), StashError> {
        if self.generation() != generation {
            return Err(StashError::TargetChanged);
        }
        let oid = resolve()?;
        let slot = {
            let mut recent = self
                .recent
                .lock()
                .map_err(|_| invalid("Saved read cache unavailable"))?;
            if self.generation() != generation {
                return Err(StashError::TargetChanged);
            }
            let entry = recent
                .iter()
                .position(|entry| entry.root == root && entry.oid == oid)
                .and_then(|index| recent.remove(index))
                .unwrap_or_else(|| Entry {
                    root: root.into(),
                    oid: oid.clone(),
                    slot: Arc::default(),
                });
            let slot = entry.slot.clone();
            recent.push_back(entry);
            while recent.len() > self.entry_limit {
                recent.pop_front();
            }
            slot
        };
        accepted(&slot)?;
        let result = slot
            .read
            .get_or_init(|| StashReadPlan::load_oid(root, &oid).map(Arc::new))
            .clone();
        // Slot identity is this entry's generation. An evicted initializer may
        // finish for its caller, but is never inserted into a newer generation.
        self.trim_reads()?;
        accepted(&slot)?;
        Ok((result?, slot))
    }

    #[cfg(test)]
    fn inspection(
        &self,
        root: &str,
        target: &StashTarget,
    ) -> Result<Arc<StashReadPlan>, StashError> {
        self.read_at(root, target, self.generation())
            .map(|(plan, _)| plan)
    }

    fn trim_reads(&self) -> Result<(), StashError> {
        let mut recent = self
            .recent
            .lock()
            .map_err(|_| invalid("Saved read cache unavailable"))?;
        let cost = |entry: &Entry| {
            256 + entry.root.len()
                + entry.oid.len()
                + entry
                    .slot
                    .read
                    .get()
                    .and_then(|result| result.as_ref().ok())
                    .map_or(0, |plan| plan.retained_bytes())
        };
        recent.retain(|entry| match entry.slot.read.get() {
            Some(Ok(_)) => cost(entry) <= self.byte_limit,
            Some(Err(_)) => false,
            None => true,
        });
        while recent.iter().map(cost).sum::<usize>() > self.byte_limit {
            recent.pop_front();
        }
        Ok(())
    }

    pub fn files(
        &self,
        root: &str,
        target: &StashTarget,
    ) -> Result<(StashInfo, Vec<CommitFile>), StashError> {
        self.files_at(root, target, self.generation())
    }

    pub fn files_at(
        &self,
        root: &str,
        target: &StashTarget,
        generation: u64,
    ) -> Result<(StashInfo, Vec<CommitFile>), StashError> {
        let (plan, slot) = self.read_at(root, target, generation)?;
        // Reflog labels are mutable even when saved objects are unchanged.
        let info = plan.info(root, target)?;
        accepted(&slot)?;
        Ok((info, plan.files.clone()))
    }

    pub fn prepare_files(
        &self,
        root: &str,
        target: &StashTarget,
    ) -> Result<Vec<CommitFile>, StashError> {
        self.prepare_files_at(root, target, self.generation())
    }

    pub fn prepare_files_at(
        &self,
        root: &str,
        target: &StashTarget,
        generation: u64,
    ) -> Result<Vec<CommitFile>, StashError> {
        self.files_at(root, target, generation)
            .map(|(_, files)| files)
    }

    pub fn diff(
        &self,
        root: &str,
        target: &StashTarget,
        path: &str,
    ) -> Result<CommitFileDiff, StashError> {
        self.diff_at(root, target, path, self.generation())
    }

    pub fn diff_at(
        &self,
        root: &str,
        target: &StashTarget,
        path: &str,
        generation: u64,
    ) -> Result<CommitFileDiff, StashError> {
        validate_saved_path(path)?;
        let (plan, read_slot) = self.read_at(root, target, generation)?;
        if !plan.files.iter().any(|file| file.path == path) {
            return Err(invalid("Path is not a saved stash change").into());
        }
        let oid = &plan.layout.stash_oid;
        let diff_slot = {
            let recent = self
                .recent
                .lock()
                .map_err(|_| invalid("Saved read cache unavailable"))?;
            if self.generation() != generation {
                return Err(StashError::TargetChanged);
            }
            accepted(&read_slot)?;
            if !recent
                .iter()
                .any(|entry| Arc::ptr_eq(&entry.slot, &read_slot))
            {
                None
            } else {
                let mut diffs = self
                    .diffs
                    .lock()
                    .map_err(|_| invalid("Saved diff cache unavailable"))?;
                let entry = diffs
                    .iter()
                    .position(|entry| entry.root == root && &entry.oid == oid && entry.path == path)
                    .and_then(|index| diffs.remove(index))
                    .unwrap_or_else(|| DiffEntry {
                        root: root.into(),
                        oid: oid.clone(),
                        path: path.into(),
                        slot: Arc::default(),
                    });
                let slot = entry.slot.clone();
                diffs.push_back(entry);
                while diffs.len() > self.diff_limit {
                    diffs.pop_front();
                }
                Some(slot)
            }
        };
        let result = match diff_slot {
            Some(slot) => slot.get_or_init(|| plan.diff(root, path)).clone(),
            None => plan.diff(root, path),
        };
        {
            let mut diffs = self
                .diffs
                .lock()
                .map_err(|_| invalid("Saved diff cache unavailable"))?;
            diffs.retain(|entry| match entry.slot.get() {
                Some(Ok(_)) => entry.retained_bytes() <= self.diff_byte_limit,
                Some(Err(_)) => false,
                None => true,
            });
            while diffs.iter().map(DiffEntry::retained_bytes).sum::<usize>() > self.diff_byte_limit
            {
                diffs.pop_front();
            }
        }
        accepted(&read_slot)?;
        result
    }

    /// Verify a retained snapshot without delaying any foreground cache slot.
    /// Only the first rejection publishes a change. Eviction discards in-flight
    /// findings, so work from a closed repository cannot poison its replacement.
    pub fn validate_cached(
        &self,
        root: &str,
        target: &StashTarget,
    ) -> Result<StashValidation, StashError> {
        self.validate_cached_at(root, target, self.generation())
    }

    pub fn validate_cached_at(
        &self,
        root: &str,
        target: &StashTarget,
        generation: u64,
    ) -> Result<StashValidation, StashError> {
        self.validate_cached_using_at(root, target, generation, |plan| {
            Self::verify_plan(root, plan)
        })
    }

    #[cfg(test)]
    fn validate_cached_using(
        &self,
        root: &str,
        target: &StashTarget,
        verify: impl FnOnce(&StashReadPlan) -> Result<(), StashError>,
    ) -> Result<StashValidation, StashError> {
        self.validate_cached_using_at(root, target, self.generation(), verify)
    }

    fn validate_cached_using_at(
        &self,
        root: &str,
        target: &StashTarget,
        generation: u64,
        verify: impl FnOnce(&StashReadPlan) -> Result<(), StashError>,
    ) -> Result<StashValidation, StashError> {
        if self.generation() != generation {
            return Err(StashError::TargetChanged);
        }
        let oid = resolve_stash_oid(root, target)?;
        let (slot, plan) = {
            let recent = self
                .recent
                .lock()
                .map_err(|_| invalid("Saved read cache unavailable"))?;
            if self.generation() != generation {
                return Err(StashError::TargetChanged);
            }
            let Some(entry) = recent
                .iter()
                .find(|entry| entry.root == root && entry.oid == oid)
            else {
                return Ok(StashValidation::Unchanged);
            };
            let Some(Ok(plan)) = entry.slot.read.get() else {
                return Ok(StashValidation::Unchanged);
            };
            let mut validation = entry
                .slot
                .validation
                .lock()
                .map_err(|_| invalid("Saved validation unavailable"))?;
            if !matches!(*validation, Validation::Unchecked) {
                return Ok(StashValidation::Unchanged);
            }
            *validation = Validation::Running;
            (entry.slot.clone(), plan.clone())
        };
        let result = verify(&plan);
        let recent = self
            .recent
            .lock()
            .map_err(|_| invalid("Saved read cache unavailable"))?;
        let retained = recent.iter().any(|entry| Arc::ptr_eq(&entry.slot, &slot));
        if self.generation() != generation || !retained {
            // Removing a different repository advances the bounded global
            // generation too. Leave its retained snapshot eligible for a new
            // verification rather than stranding it in Running forever.
            if retained {
                let mut validation = slot
                    .validation
                    .lock()
                    .map_err(|_| invalid("Saved validation unavailable"))?;
                if matches!(*validation, Validation::Running) {
                    *validation = Validation::Unchecked;
                }
            }
            return Ok(StashValidation::Unchanged);
        }
        let mut validation = slot
            .validation
            .lock()
            .map_err(|_| invalid("Saved validation unavailable"))?;
        match result {
            Ok(()) => {
                *validation = Validation::Verified;
                Ok(StashValidation::Verified)
            }
            Err(error) => {
                *validation = Validation::Rejected(error);
                let mut diffs = self
                    .diffs
                    .lock()
                    .map_err(|_| invalid("Saved diff cache unavailable"))?;
                diffs.retain(|entry| !(entry.root == root && entry.oid == oid));
                Ok(StashValidation::Rejected)
            }
        }
    }

    fn verify_plan(root: &str, plan: &StashReadPlan) -> Result<(), StashError> {
        let strict = StashInspection::load_oid(root, &plan.layout.stash_oid)?;
        let a = &plan.layout;
        let b = &strict.objects.layout;
        if a.original_head_oid != b.original_head_oid
            || a.baseline_oid != b.baseline_oid
            || a.index_oid != b.index_oid
            || a.untracked_oid != b.untracked_oid
            || a.encoding != b.encoding
        {
            return Err(invalid("Saved stash metadata failed validation").into());
        }
        fn files(files: &[CommitFile]) -> Vec<(&str, Option<&str>, &str)> {
            let mut files = files
                .iter()
                .map(|file| {
                    (
                        file.path.as_str(),
                        file.original_path.as_deref(),
                        file.status.as_str(),
                    )
                })
                .collect::<Vec<_>>();
            files.sort_unstable();
            files
        }
        if files(&plan.files) != files(&strict.files) {
            return Err(invalid("Saved stash file list failed validation").into());
        }
        Ok(())
    }

    /// A bounded scheduling hint, never a repository read or an indication that
    /// a mutable selector still identifies this snapshot.
    pub fn prefetch_paths(&self, root: &str, oid: &str, after: Option<&str>) -> Vec<String> {
        let Ok(recent) = self.recent.lock() else {
            return Vec::new();
        };
        let Some(entry) = recent
            .iter()
            .find(|entry| entry.root == root && entry.oid.eq_ignore_ascii_case(oid))
        else {
            return Vec::new();
        };
        if accepted(&entry.slot).is_err() {
            return Vec::new();
        }
        let Some(Ok(plan)) = entry.slot.read.get() else {
            return Vec::new();
        };
        let start = match after {
            None => 0,
            Some(path) => match plan.files.iter().position(|file| file.path == path) {
                Some(index) => index + 1,
                None => return Vec::new(),
            },
        };
        plan.files
            .iter()
            .skip(start)
            .take(2)
            .map(|file| file.path.clone())
            .collect()
    }

    pub fn is_rejected(&self, root: &str, oid: &str) -> bool {
        self.recent.lock().ok().is_some_and(|recent| {
            recent
                .iter()
                .find(|entry| entry.root == root && entry.oid.eq_ignore_ascii_case(oid))
                .is_some_and(|entry| accepted(&entry.slot).is_err())
        })
    }

    pub fn evict_repo(&self, root: &str) {
        if let Ok(mut recent) = self.recent.lock() {
            self.generation.fetch_add(1, Ordering::AcqRel);
            recent.retain(|entry| entry.root != root);
            // Pair eviction with diff removal under the same generation lock.
            if let Ok(mut diffs) = self.diffs.lock() {
                diffs.retain(|entry| entry.root != root);
            }
        }
    }

    pub fn clear(&self) {
        if let Ok(mut recent) = self.recent.lock() {
            self.generation.fetch_add(1, Ordering::AcqRel);
            recent.clear();
            if let Ok(mut diffs) = self.diffs.lock() {
                diffs.clear();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::command::{test_metrics, GitCommand};
    use std::{sync::mpsc, time::Duration};

    struct Repo(tempfile::TempDir);
    impl Repo {
        fn new() -> Self {
            let repo = Self(tempfile::tempdir().unwrap());
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.name", "Cache fixture"]);
            repo.git(&["config", "user.email", "cache@example.invalid"]);
            repo.git(&["config", "core.autocrlf", "false"]);
            for path in ["one.txt", "two.txt"] {
                std::fs::write(repo.0.path().join(path), "before\n").unwrap();
            }
            repo.git(&["add", "."]);
            repo.git(&["-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
            repo
        }
        fn root(&self) -> &str {
            self.0.path().to_str().unwrap()
        }
        fn git(&self, args: &[&str]) -> String {
            GitCommand::run(args, Some(self.0.path()))
                .unwrap()
                .trim()
                .into()
        }
        fn stash(&self, value: &str) -> StashTarget {
            for path in ["one.txt", "two.txt"] {
                std::fs::write(self.0.path().join(path), format!("{value}\n")).unwrap();
            }
            self.git(&["stash", "push", "-m", value]);
            StashTarget {
                selector: "stash@{0}".into(),
                expected_oid: self.git(&["rev-parse", "refs/stash"]),
            }
        }
    }

    #[test]
    fn entry_count_byte_limits_lru_and_repository_eviction_bound_retention() {
        let repo = Repo::new();
        let mut a = repo.stash("a");
        let mut b = repo.stash("b");
        let c = repo.stash("c");
        a.selector = "stash@{2}".into();
        b.selector = "stash@{1}".into();
        let cache = StashInspectionCache {
            entry_limit: 2,
            ..Default::default()
        };
        let first_a = cache.inspection(repo.root(), &a).unwrap();
        let first_b = cache.inspection(repo.root(), &b).unwrap();
        assert!(Arc::ptr_eq(
            &first_a,
            &cache.inspection(repo.root(), &a).unwrap()
        ));
        cache.inspection(repo.root(), &c).unwrap();
        assert_eq!(
            cache
                .recent
                .lock()
                .unwrap()
                .iter()
                .map(|entry| entry.oid.clone())
                .collect::<Vec<_>>(),
            [a.expected_oid.clone(), c.expected_oid.clone()]
        );
        assert!(!Arc::ptr_eq(
            &first_b,
            &cache.inspection(repo.root(), &b).unwrap()
        ));
        cache.diff(repo.root(), &a, "one.txt").unwrap();
        cache.evict_repo(repo.root());
        assert!(cache.recent.lock().unwrap().is_empty());
        assert!(cache.diffs.lock().unwrap().is_empty());
        assert!(!Arc::ptr_eq(
            &first_a,
            &cache.inspection(repo.root(), &a).unwrap()
        ));
        let cost = first_a.retained_bytes() + 256 + repo.root().len() + a.expected_oid.len();
        let small = StashInspectionCache {
            byte_limit: cost,
            ..Default::default()
        };
        small.files(repo.root(), &a).unwrap();
        small.files(repo.root(), &b).unwrap();
        assert_eq!(small.recent.lock().unwrap().len(), 1);
        let oversized = StashInspectionCache {
            byte_limit: 1,
            ..Default::default()
        };
        assert_eq!(oversized.files(repo.root(), &a).unwrap().1.len(), 2);
        oversized.diff(repo.root(), &a, "one.txt").unwrap();
        assert!(oversized.recent.lock().unwrap().is_empty());
        assert!(oversized.diffs.lock().unwrap().is_empty());
    }

    #[test]
    fn cold_and_warm_reads_only_do_requested_work_and_share_diff_results() {
        let repo = Repo::new();
        let target = repo.stash("saved");
        let cache = StashInspectionCache::default();
        test_metrics::take();
        cache.files(repo.root(), &target).unwrap();
        assert_eq!(
            test_metrics::take().0,
            5,
            "identity, two commit batches, raw diff, reflog"
        );
        cache.files(repo.root(), &target).unwrap();
        assert_eq!(
            test_metrics::take().0,
            2,
            "warm list only checks identity and label"
        );
        let barrier = std::sync::Barrier::new(4);
        let calls = std::thread::scope(|scope| {
            let handles = (0..4)
                .map(|_| {
                    let (cache, target, barrier, root) = (&cache, &target, &barrier, repo.root());
                    scope.spawn(move || {
                        test_metrics::take();
                        barrier.wait();
                        assert_eq!(
                            cache
                                .diff(root, target, "one.txt")
                                .unwrap()
                                .modified_content,
                            "saved\n"
                        );
                        test_metrics::take().0
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .sum::<usize>()
        });
        assert_eq!(
            calls, 9,
            "four identity checks share four blob reads and one patch command"
        );
        cache.diff(repo.root(), &target, "one.txt").unwrap();
        assert_eq!(
            test_metrics::take().0,
            1,
            "warm diff only checks live identity"
        );
    }

    #[test]
    fn diff_count_and_byte_limits_keep_large_results_uncached() {
        let repo = Repo::new();
        let target = repo.stash("saved");
        let cache = StashInspectionCache {
            diff_limit: 1,
            ..Default::default()
        };
        cache.diff(repo.root(), &target, "one.txt").unwrap();
        cache.diff(repo.root(), &target, "two.txt").unwrap();
        assert_eq!(cache.diffs.lock().unwrap().len(), 1);
        test_metrics::take();
        cache.diff(repo.root(), &target, "two.txt").unwrap();
        assert_eq!(test_metrics::take().0, 1);
        cache.diff(repo.root(), &target, "one.txt").unwrap();
        assert!(test_metrics::take().0 > 1);
        let small = StashInspectionCache {
            diff_byte_limit: 1,
            ..Default::default()
        };
        small.diff(repo.root(), &target, "one.txt").unwrap();
        assert!(small.diffs.lock().unwrap().is_empty());
    }

    #[test]
    fn concurrent_first_reads_share_the_same_foreground_plan() {
        let repo = Repo::new();
        let target = repo.stash("saved");
        let cache = StashInspectionCache::default();
        let barrier = std::sync::Barrier::new(4);
        let values = std::thread::scope(|scope| {
            let handles = (0..4)
                .map(|_| {
                    let (cache, target, barrier, root) = (&cache, &target, &barrier, repo.root());
                    scope.spawn(move || {
                        barrier.wait();
                        cache.inspection(root, target).unwrap()
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(values.iter().all(|value| Arc::ptr_eq(value, &values[0])));
        assert_eq!(cache.recent.lock().unwrap().len(), 1);
    }

    #[test]
    fn eviction_during_an_in_flight_read_cannot_repopulate_entries() {
        use std::time::Instant;
        let repo = Repo::new();
        let target = repo.stash("saved");
        let plan = Arc::new(StashReadPlan::load_oid(repo.root(), &target.expected_oid).unwrap());
        let cache = StashInspectionCache::default();
        let slot = Slot::default();
        cache.recent.lock().unwrap().push_back(Entry {
            root: repo.root().into(),
            oid: target.expected_oid.clone(),
            slot: slot.clone(),
        });
        let (started, waiting) = mpsc::channel();
        let (release, released) = mpsc::channel();
        std::thread::scope(|scope| {
            let initializer_slot = slot.clone();
            let initializer = scope.spawn(move || {
                initializer_slot.read.get_or_init(|| {
                    started.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(30)).unwrap();
                    Ok(plan)
                });
            });
            waiting.recv_timeout(Duration::from_secs(30)).unwrap();
            let reader = scope.spawn(|| cache.diff(repo.root(), &target, "one.txt"));
            let deadline = Instant::now() + Duration::from_secs(30);
            while Arc::strong_count(&slot) < 4 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            let reader_entered = Arc::strong_count(&slot) >= 4;
            cache.evict_repo(repo.root());
            release.send(()).unwrap();
            initializer.join().unwrap();
            assert!(matches!(
                reader.join().unwrap(),
                Err(StashError::TargetChanged)
            ));
            assert!(
                reader_entered,
                "reader reached the acquired slot checkpoint"
            );
        });
        assert!(cache.recent.lock().unwrap().is_empty());
        assert!(cache.diffs.lock().unwrap().is_empty());
    }

    #[test]
    fn eviction_during_selector_resolution_cannot_admit_an_old_request() {
        let repo = Repo::new();
        let target = repo.stash("saved");
        let cache = StashInspectionCache::default();
        let generation = cache.generation();
        let (entered, started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        std::thread::scope(|scope| {
            let (read_cache, root, read_target) = (&cache, repo.root(), &target);
            let reader = scope.spawn(move || {
                read_cache.read_at_using(root, generation, || {
                    let oid = resolve_stash_oid(root, read_target)?;
                    entered.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(30)).unwrap();
                    Ok(oid)
                })
            });
            started.recv_timeout(Duration::from_secs(30)).unwrap();
            cache.evict_repo(repo.root());
            let reopened = cache.inspection(repo.root(), &target).unwrap();
            release.send(()).unwrap();
            assert!(matches!(
                reader.join().unwrap(),
                Err(StashError::TargetChanged)
            ));
            assert!(Arc::ptr_eq(
                &reopened,
                &cache.inspection(repo.root(), &target).unwrap()
            ));
        });
        assert_eq!(cache.recent.lock().unwrap().len(), 1);
        assert!(cache.diffs.lock().unwrap().is_empty());
    }

    #[test]
    fn queued_old_generation_cannot_read_or_validate_reopened_entries_and_clear_advances_generation(
    ) {
        let repo = Repo::new();
        let target = repo.stash("saved");
        let cache = StashInspectionCache::default();
        let generation = cache.generation();
        cache.files_at(repo.root(), &target, generation).unwrap();
        cache.evict_repo(repo.root());
        cache.files(repo.root(), &target).unwrap();
        test_metrics::take();
        assert!(matches!(
            cache.files_at(repo.root(), &target, generation),
            Err(StashError::TargetChanged)
        ));
        assert!(matches!(
            cache.prepare_files_at(repo.root(), &target, generation),
            Err(StashError::TargetChanged)
        ));
        assert!(matches!(
            cache.diff_at(repo.root(), &target, "one.txt", generation),
            Err(StashError::TargetChanged)
        ));
        assert!(matches!(
            cache.validate_cached_at(repo.root(), &target, generation),
            Err(StashError::TargetChanged)
        ));
        assert_eq!(
            test_metrics::take().0,
            0,
            "obsolete queued jobs must not launch Git"
        );
        assert_eq!(
            cache.validate_cached(repo.root(), &target).unwrap(),
            StashValidation::Verified
        );
        cache.diff(repo.root(), &target, "one.txt").unwrap();
        let current = cache.generation();
        cache.clear();
        assert_ne!(current, cache.generation());
        assert!(cache.recent.lock().unwrap().is_empty());
        assert!(cache.diffs.lock().unwrap().is_empty());
        assert!(matches!(
            cache.files_at(repo.root(), &target, current),
            Err(StashError::TargetChanged)
        ));
    }

    #[test]
    fn verification_is_once_per_generation_and_rejections_are_sticky() {
        let repo = Repo::new();
        let target = repo.stash("saved");
        let cache = StashInspectionCache::default();
        assert_eq!(
            cache.validate_cached(repo.root(), &target).unwrap(),
            StashValidation::Unchanged
        );
        cache.files(repo.root(), &target).unwrap();
        assert_eq!(
            cache.prefetch_paths(repo.root(), &target.expected_oid, None),
            ["one.txt", "two.txt"]
        );
        assert_eq!(
            cache.prefetch_paths(repo.root(), &target.expected_oid, Some("one.txt")),
            ["two.txt"]
        );
        assert!(cache
            .prefetch_paths(repo.root(), &target.expected_oid, Some("missing.txt"))
            .is_empty());
        assert_eq!(
            cache
                .validate_cached_using(repo.root(), &target, |_| {
                    cache.evict_repo("an-unrelated-repository");
                    Ok(())
                })
                .unwrap(),
            StashValidation::Unchanged,
            "an interrupted global generation must leave retained roots eligible for verification"
        );
        assert_eq!(
            cache.validate_cached(repo.root(), &target).unwrap(),
            StashValidation::Verified
        );
        assert_eq!(
            cache.validate_cached(repo.root(), &target).unwrap(),
            StashValidation::Unchanged
        );
        cache.evict_repo(repo.root());
        cache.files(repo.root(), &target).unwrap();
        assert_eq!(
            cache
                .validate_cached_using(repo.root(), &target, |_| Err(
                    invalid("rejected fixture").into()
                ))
                .unwrap(),
            StashValidation::Rejected
        );
        assert!(cache.files(repo.root(), &target).is_err());
        assert!(cache.is_rejected(repo.root(), &target.expected_oid));
        assert!(cache
            .prefetch_paths(repo.root(), &target.expected_oid, None)
            .is_empty());
        assert!(cache.diff(repo.root(), &target, "one.txt").is_err());
        assert_eq!(
            cache
                .validate_cached_using(repo.root(), &target, |_| panic!(
                    "must not replay rejected validation"
                ))
                .unwrap(),
            StashValidation::Unchanged
        );
        cache.evict_repo(repo.root());
        assert!(cache.files(repo.root(), &target).is_ok());
    }

    #[test]
    fn verification_never_blocks_foreground_and_evicted_findings_cannot_poison_reopened_entries() {
        let repo = Repo::new();
        let target = repo.stash("saved");
        let cache = StashInspectionCache::default();
        let original = cache.inspection(repo.root(), &target).unwrap();
        let (entered, started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        std::thread::scope(|scope| {
            let (verify_cache, root, verify_target) = (&cache, repo.root(), &target);
            let verifier = scope.spawn(move || {
                verify_cache.validate_cached_using(root, verify_target, |_| {
                    entered.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(30)).unwrap();
                    Err(invalid("obsolete verification").into())
                })
            });
            started.recv_timeout(Duration::from_secs(30)).unwrap();
            assert_eq!(
                cache.validate_cached(repo.root(), &target).unwrap(),
                StashValidation::Unchanged
            );
            assert!(Arc::ptr_eq(
                &original,
                &cache.inspection(repo.root(), &target).unwrap()
            ));
            assert_eq!(
                cache
                    .diff(repo.root(), &target, "one.txt")
                    .unwrap()
                    .modified_content,
                "saved\n"
            );
            cache.evict_repo(repo.root());
            let replacement = cache.inspection(repo.root(), &target).unwrap();
            assert!(!Arc::ptr_eq(&original, &replacement));
            release.send(()).unwrap();
            assert_eq!(
                verifier.join().unwrap().unwrap(),
                StashValidation::Unchanged
            );
            assert!(cache.files(repo.root(), &target).is_ok());
        });
    }
}
