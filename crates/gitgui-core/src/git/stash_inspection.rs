//! Read-only saved-object inspection. No worktree access or live hunk handles.
use super::{
    repository::{classify_content, file_diff, CommitFile, CommitFileDiff, FileContent},
    stash::{
        invalid, read_git, validate_saved_path, StashError, StashObjects, StashTarget, TreeEntry,
    },
};

const METADATA_LIMIT: usize = 32 * 1024 * 1024;
/// Larger saved files receive a bounded explanatory payload rather than partial text.
pub const STASH_CONTENT_LIMIT: usize = 8 * 1024 * 1024;

pub fn list_stash_files(root: &str, target: &StashTarget) -> Result<Vec<CommitFile>, StashError> {
    Ok(StashInspection::load(root, target)?.files)
}

pub(crate) struct StashInspection {
    pub objects: StashObjects,
    pub files: Vec<CommitFile>,
}

impl StashInspection {
    pub fn load(root: &str, target: &StashTarget) -> Result<Self, StashError> {
        let objects = StashObjects::load(root, target)?;
        Self::from_objects(root, objects)
    }

    pub fn load_oid(root: &str, oid: &str) -> Result<Self, StashError> {
        Self::from_objects(root, StashObjects::load_oid(root, oid)?)
    }

    fn from_objects(root: &str, objects: StashObjects) -> Result<Self, StashError> {
        let files = files(root, &objects)?;
        Ok(Self { objects, files })
    }

    pub fn file(&self, path: &str) -> Result<&CommitFile, StashError> {
        self.files
            .iter()
            .find(|file| file.path == path)
            .ok_or_else(|| invalid("Path is not a saved stash change").into())
    }

    pub fn diff(&self, root: &str, path: &str) -> Result<CommitFileDiff, StashError> {
        validate_saved_path(path)?;
        let file = self.file(path)?;
        let original_path = file.original_path.as_deref().unwrap_or(path);
        let original = if file.status.starts_with('A') {
            FileContent::Text(String::new())
        } else {
            content(root, self.objects.before.get(original_path))?
        };
        let modified = if file.status.starts_with('D') {
            FileContent::Text(String::new())
        } else {
            content(
                root,
                self.objects
                    .untracked
                    .get(path)
                    .or_else(|| self.objects.after.get(path)),
            )?
        };
        Ok(file_diff(
            if file.status.starts_with('A') {
                None
            } else {
                Some(original_path.into())
            },
            path.into(),
            original,
            modified,
        )?)
    }
}

fn files(root: &str, objects: &StashObjects) -> Result<Vec<CommitFile>, StashError> {
    let layout = &objects.layout;
    let raw = read_git(
        root,
        &[
            "diff-tree",
            "--no-commit-id",
            "-r",
            "-z",
            "--name-status",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=none",
            "--no-relative",
            "--no-color",
            &layout.baseline_oid,
            &layout.stash_oid,
            "--",
        ],
        METADATA_LIMIT,
    )?;
    let mut fields = raw.split(|b| *b == 0).filter(|v| !v.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let status =
            std::str::from_utf8(status).map_err(|_| invalid("Invalid saved file status"))?;
        if !matches!(
            status.as_bytes().first(),
            Some(b'A' | b'M' | b'D' | b'R' | b'C' | b'T')
        ) {
            return Err(invalid("Unsupported saved file status").into());
        }
        let mut next_path = || -> Result<String, StashError> {
            let path = fields
                .next()
                .and_then(|s| std::str::from_utf8(s).ok())
                .ok_or_else(|| invalid("Invalid saved file path"))?;
            validate_saved_path(path)?;
            Ok(path.to_owned())
        };
        let first = next_path()?;
        let (path, original_path) = if status.starts_with(['R', 'C']) {
            (next_path()?, Some(first))
        } else {
            (first, None)
        };
        files.push(CommitFile {
            path,
            original_path,
            status: status.into(),
        });
    }
    for path in objects.untracked.keys() {
        files.push(CommitFile {
            path: path.clone(),
            original_path: None,
            status: "A".into(),
        });
    }
    Ok(files)
}

pub fn load_stash_file_diff(
    root: &str,
    target: &StashTarget,
    path: &str,
) -> Result<CommitFileDiff, StashError> {
    validate_saved_path(path)?;
    StashInspection::load(root, target)?.diff(root, path)
}

fn content(root: &str, entry: Option<&TreeEntry>) -> Result<FileContent, StashError> {
    let entry = entry.ok_or_else(|| invalid("Missing saved tree entry"))?;
    if entry.mode == "160000" {
        return Ok(FileContent::Missing(
            "Submodule content cannot be displayed.".into(),
        ));
    }
    let size = read_git(root, &["cat-file", "-s", &entry.oid], 128)?;
    let size = std::str::from_utf8(&size)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .ok_or_else(|| invalid("Invalid saved blob size"))?;
    if size > STASH_CONTENT_LIMIT as u64 {
        return Ok(FileContent::Missing(format!(
            "Saved file exceeds the {} MiB inspection limit.",
            STASH_CONTENT_LIMIT / 1024 / 1024
        )));
    }
    Ok(classify_content(read_git(
        root,
        &["cat-file", "blob", &entry.oid],
        STASH_CONTENT_LIMIT,
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{
        command::{test_metrics, GitCommand},
        stash::read_stash_info,
    };

    #[test]
    fn inspection_read_cost() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let git = |args: &[&str]| GitCommand::run(args, Some(dir.path())).unwrap();
        git(&["init", "-q"]);
        git(&["config", "user.name", "Stash inspection test"]);
        git(&["config", "user.email", "inspection@example.invalid"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(dir.path().join("file.txt"), "before\n").unwrap();
        git(&["add", "."]);
        git(&["-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
        std::fs::write(dir.path().join("file.txt"), "after\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "untracked\n").unwrap();
        git(&["stash", "push", "-u", "-m", "saved"]);
        let target = StashTarget {
            selector: "stash@{0}".into(),
            expected_oid: git(&["rev-parse", "refs/stash"]).trim().into(),
        };
        test_metrics::take();
        let started = std::time::Instant::now();
        read_stash_info(root, &target).unwrap();
        assert_eq!(list_stash_files(root, &target).unwrap().len(), 2);
        for _ in 0..2 {
            assert_eq!(
                load_stash_file_diff(root, &target, "file.txt")
                    .unwrap()
                    .modified_content,
                "after\n"
            );
        }
        let uncached = test_metrics::take().0;
        eprintln!(
            "uncached stash files plus two file opens: {uncached} Git processes, {:?}",
            started.elapsed()
        );
        let cache = crate::git::stash_inspection_cache::StashInspectionCache::default();
        let started = std::time::Instant::now();
        assert_eq!(cache.files(root, &target).unwrap().1.len(), 2);
        let cold = test_metrics::take().0;
        let cold_time = started.elapsed();
        let diff_started = std::time::Instant::now();
        assert_eq!(
            cache
                .diff(root, &target, "file.txt")
                .unwrap()
                .modified_content,
            "after\n"
        );
        let first_diff = test_metrics::take().0;
        let first_diff_time = diff_started.elapsed();
        assert_eq!(
            cache
                .diff(root, &target, "file.txt")
                .unwrap()
                .modified_content,
            "after\n"
        );
        let repeat_diff = test_metrics::take().0;
        eprintln!("cached stash files plus two file opens: {} Git processes ({cold} + {first_diff} + {repeat_diff}), {:?}", cold + first_diff + repeat_diff, started.elapsed());
        eprintln!("cold file list: {cold_time:?}; first selected file: {first_diff_time:?}");
        assert!(cold + first_diff + repeat_diff < uncached);
        // Warm display does not audit unchanged saved objects.
        assert_eq!(cold, 6);
        assert_eq!(repeat_diff, 1);
    }
}
