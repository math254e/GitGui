use super::working_tree::HunkContext;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

const MAX_ENTRIES: usize = 64;
const MAX_BYTES: usize = 16 * 1024 * 1024;

/// Only server-owned preconditions live here, never file contents or patches.
/// Reuse requires fresh Git patch generation and content-based validation.
#[derive(Default)]
pub struct HunkReviewCache {
    entries: VecDeque<Entry>,
    bytes: usize,
}

pub type SharedHunkReviewCache = Arc<Mutex<HunkReviewCache>>;

struct Entry {
    root: String,
    context: Arc<HunkContext>,
    id: String,
    revision: Option<String>,
    bytes: usize,
}

impl HunkReviewCache {
    pub fn evict_repo(&mut self, root: &str) {
        self.entries.retain(|entry| {
            if entry.root == root {
                self.bytes -= entry.bytes;
                false
            } else {
                true
            }
        });
    }

    pub fn get_context(
        &self,
        root: &str,
        path: &str,
        staged: bool,
        id: &str,
    ) -> Option<Arc<HunkContext>> {
        self.entries
            .iter()
            .rev()
            .find(|entry| {
                entry.root == root && entry.id == id && entry.context.matches(path, staged)
            })
            .map(|entry| Arc::clone(&entry.context))
    }

    pub fn get_review(
        &self,
        root: &str,
        path: &str,
        staged: bool,
        revision: &str,
    ) -> Option<Arc<HunkContext>> {
        self.entries
            .iter()
            .rev()
            .find(|entry| {
                entry.root == root
                    && entry.revision.as_deref() == Some(revision)
                    && entry.context.matches(path, staged)
            })
            .map(|entry| Arc::clone(&entry.context))
    }

    pub fn insert(&mut self, root: &str, context: HunkContext, revision: Option<String>) {
        let id = context.id();
        let bytes = context.byte_size() + root.len() + id.len() + 64;
        if bytes > MAX_BYTES {
            return;
        }
        self.entries.retain(|entry| {
            let keep = !(entry.root == root && entry.id == id);
            if !keep {
                self.bytes -= entry.bytes;
            }
            keep
        });
        while self.entries.len() >= MAX_ENTRIES || self.bytes + bytes > MAX_BYTES {
            if let Some(entry) = self.entries.pop_front() {
                self.bytes -= entry.bytes;
            }
        }
        self.bytes += bytes;
        self.entries.push_back(Entry {
            root: root.into(),
            context: Arc::new(context),
            id,
            revision,
            bytes,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{command::GitCommand, working_tree::load_working_tree_file_view};

    #[test]
    fn contexts_are_scoped_bounded_and_eviction_only_requires_fresh_preparation() {
        let repo = tempfile::tempdir().unwrap();
        GitCommand::run(&["init", "-q"], Some(repo.path())).unwrap();
        std::fs::write(repo.path().join("file.txt"), "new\n").unwrap();
        let root = repo.path().to_str().unwrap();
        let (_, context) = load_working_tree_file_view(root, None, "file.txt", false).unwrap();
        let context = context.unwrap();
        let id = context.id();
        let review = context.complete().unwrap();
        let mut cache = HunkReviewCache::default();
        cache.insert(root, context.clone(), Some(review.preview.revision.clone()));
        assert!(cache.get_context(root, "file.txt", false, &id).is_some());
        assert!(cache.get_context("other", "file.txt", false, &id).is_none());
        assert!(cache.get_context(root, "other.txt", false, &id).is_none());
        assert!(cache.get_context(root, "file.txt", true, &id).is_none());
        assert!(cache.get_review(root, "file.txt", false, &id).is_none());
        assert!(cache
            .get_review(root, "file.txt", false, &review.preview.revision)
            .is_some());
        cache.insert(&"x".repeat(MAX_BYTES), context.clone(), None);
        assert_eq!(cache.entries.len(), 1);
        for n in 0..MAX_ENTRIES {
            cache.insert(&format!("root-{n}"), context.clone(), None);
        }
        assert_eq!(cache.entries.len(), MAX_ENTRIES);
        assert!(cache.get_context(root, "file.txt", false, &id).is_none());
        assert_eq!(
            cache.bytes,
            cache.entries.iter().map(|entry| entry.bytes).sum()
        );
        assert!(cache.bytes <= MAX_BYTES);
        cache.evict_repo("root-0");
        assert!(cache
            .get_context("root-0", "file.txt", false, &id)
            .is_none());
        assert!(cache
            .get_context("root-1", "file.txt", false, &id)
            .is_some());
        assert_eq!(
            cache.bytes,
            cache.entries.iter().map(|entry| entry.bytes).sum()
        );
        // The evicted operation can still be freshly prepared and reviewed.
        assert_eq!(
            crate::git::working_tree::preview_hunks(root, "file.txt", false)
                .unwrap()
                .revision,
            review.preview.revision
        );
    }
}
