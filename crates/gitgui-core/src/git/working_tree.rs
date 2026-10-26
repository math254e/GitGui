//! Reviewed working-tree mutations. Git owns patch generation and application;
//! clients send hunk indices and fingerprints, never executable patches.
use super::{
    command::{GitCommand, GitError},
    repository::{
        load_repository_status, load_working_tree_file_diff_with_content, ChangedFile, CommitFile,
        CommitFileDiff,
    },
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Component, Path},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub id: u32,
    pub header: String,
    pub patch: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkPreview {
    pub file_path: String,
    pub staged: bool,
    pub revision: String,
    pub patch: String,
    pub hunks: Vec<Hunk>,
    pub unavailable_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardFile {
    pub path: String,
    pub untracked: bool,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardOutcome {
    pub completed_paths: Vec<String>,
    pub remaining_paths: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendInfo {
    pub head_oid: Option<String>,
    pub summary: String,
    pub description: String,
    pub blocked_reason: Option<String>,
}

fn error(message: impl Into<String>) -> GitError {
    GitError {
        message: message.into(),
        stderr: String::new(),
        status: None,
    }
}

// Parent symlinks must never turn a repository-relative request into filesystem
// access outside the repository. A final symlink may be restored/deleted itself.
pub(crate) fn safe_path(root: &Path, path: &str) -> Result<(), GitError> {
    if path.is_empty()
        || path.starts_with(['/', '\\'])
        || path.as_bytes().get(1) == Some(&b':')
        || path.bytes().any(|b| b.is_ascii_control())
        || path.split(['/', '\\']).any(|s| matches!(s, ".." | ".git"))
    {
        return Err(error("Invalid repository-relative path"));
    }
    let components = Path::new(path).components().collect::<Vec<_>>();
    let mut parent = root.to_path_buf();
    for (i, component) in components.iter().enumerate() {
        if !matches!(component, Component::Normal(_)) {
            return Err(error("Invalid repository-relative path"));
        }
        parent.push(component.as_os_str());
        if i + 1 < components.len() {
            match fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err(error("File path crosses a symlink or non-directory"))
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(error(format!("Cannot inspect file path: {e}"))),
            }
        }
    }
    Ok(())
}

fn index_entry(root: &Path, path: &str) -> Result<String, GitError> {
    GitCommand::run(
        &[
            "--literal-pathspecs",
            "ls-files",
            "--stage",
            "-z",
            "--",
            path,
        ],
        Some(root),
    )
}

fn revision(root: &Path, path: &str) -> Result<String, GitError> {
    safe_path(root, path)?;
    let head = GitCommand::run(&["rev-parse", "--verify", "HEAD"], Some(root)).unwrap_or_default();
    let entry = index_entry(root, path)?;
    revision_with_inputs(root, path, head.trim(), &entry, None)
}

fn revision_with_inputs(
    root: &Path,
    path: &str,
    head: &str,
    entry: &str,
    mut contents: Option<&mut Vec<u8>>,
) -> Result<String, GitError> {
    safe_path(root, path)?;
    let mut hash = Sha256::new();
    hash.update(head);
    hash.update([0]);
    hash.update(entry);
    hash.update([0]);
    match fs::symlink_metadata(root.join(path)) {
        Ok(meta) if meta.is_dir() => {
            return Err(error(
                "Directories and submodules require their own workflow",
            ))
        }
        Ok(meta) if meta.file_type().is_symlink() => {
            hash.update(b"symlink");
            hash.update(
                fs::read_link(root.join(path))
                    .map_err(|e| error(e.to_string()))?
                    .to_string_lossy()
                    .as_bytes(),
            );
        }
        Ok(meta) if meta.is_file() => {
            hash.update(b"file");
            hash.update(format!("{:?}", meta.permissions()));
            let mut file = fs::File::open(root.join(path)).map_err(|e| error(e.to_string()))?;
            let mut buffer = [0; 65536];
            let mut binary_content = false;
            #[cfg(test)]
            let mut read_bytes = 0;
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|e| error(e.to_string()))?;
                if count == 0 {
                    break;
                }
                #[cfg(test)]
                {
                    read_bytes += count;
                }
                hash.update(&buffer[..count]);
                if let Some(bytes) = contents.as_mut() {
                    if !binary_content {
                        binary_content = buffer[..count].contains(&0);
                        if binary_content {
                            // Continue fingerprinting for revision checks without
                            // retaining an entire binary file just to classify it.
                            bytes.clear();
                            bytes.push(0);
                        } else {
                            bytes.extend_from_slice(&buffer[..count]);
                        }
                    }
                }
            }
            #[cfg(test)]
            super::command::test_metrics::read(read_bytes);
        }
        Ok(_) => return Err(error("Unsupported filesystem entry")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            hash.update(b"missing");
        }
        Err(e) => return Err(error(format!("Cannot read file: {e}"))),
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn preview_hunks(root: &str, path: &str, staged: bool) -> Result<HunkPreview, GitError> {
    Ok(prepare_hunks(root, path, staged)?.preview)
}

/// Server-owned Git patch and its content-based precondition. Never deserialize
/// this from the client: only IDs and the opaque preview revision cross back.
#[derive(Clone, Debug)]
pub struct ReviewedHunks {
    pub preview: HunkPreview,
    pub context: HunkContext,
}

/// A short-lived continuation of the file-content request. It retains only
/// this path's status/index preconditions, never the file contents.
#[derive(Clone, Debug)]
pub struct HunkContext {
    root: String,
    revision_before: String,
    file: ChangedFile,
    entry: String,
    staged: bool,
}

impl HunkContext {
    pub fn id(&self) -> String {
        let mut hash = Sha256::new();
        for part in [
            self.root.as_str(),
            self.file.path.as_str(),
            self.revision_before.as_str(),
            self.file.index_status.as_str(),
            self.file.worktree_status.as_str(),
            self.file.original_path.as_deref().unwrap_or(""),
        ] {
            hash.update(part.as_bytes());
            hash.update([0]);
        }
        hash.update([u8::from(self.staged)]);
        format!("{:x}", hash.finalize())
    }

    pub fn matches(&self, path: &str, staged: bool) -> bool {
        self.file.path == path && self.staged == staged
    }

    pub fn byte_size(&self) -> usize {
        self.root.len()
            + self.revision_before.len()
            + self.file.path.len()
            + self.file.index_status.len()
            + self.file.worktree_status.len()
            + self.file.original_path.as_ref().map_or(0, String::len)
            + self.entry.len()
    }

    pub fn complete(&self) -> Result<ReviewedHunks, GitError> {
        build_hunk_review(self)
    }
}

pub fn prepare_hunks(root: &str, path: &str, staged: bool) -> Result<ReviewedHunks, GitError> {
    let (_, context) = load_working_tree_file_view(root, None, path, staged)?;
    context?.complete()
}

/// Prepares one file selection's status/index/content preconditions. Preview
/// can continue this operation later, but must revalidate the entire revision.
pub fn load_working_tree_file_view(
    root: &str,
    head: Option<&str>,
    path: &str,
    staged: bool,
) -> Result<(CommitFileDiff, Result<HunkContext, GitError>), GitError> {
    safe_path(Path::new(root), path)?;
    let snapshot = load_repository_status(root)?;
    let root_path = Path::new(&snapshot.info.root);
    let changed = snapshot
        .status
        .changed_files
        .iter()
        .find(|file| file.path == path || file.original_path.as_deref() == Some(path));
    let file = changed
        .map(|f| CommitFile {
            path: f.path.clone(),
            original_path: f.original_path.clone(),
            status: format!("{}{}", f.index_status, f.worktree_status),
        })
        .unwrap_or_else(|| CommitFile {
            path: path.into(),
            original_path: None,
            status: "MM".into(),
        });
    let path = file.path.as_str();
    let mut contents = Vec::new();
    let entry = index_entry(root_path, path)?;
    let staged_diff = if staged {
        Some(load_working_tree_file_diff_with_content(
            &snapshot.info.root,
            head.or(snapshot.status.head_oid.as_deref()),
            &file,
            staged,
            None,
        )?)
    } else {
        None
    };
    let before = revision_with_inputs(
        root_path,
        path,
        snapshot.status.head_oid.as_deref().unwrap_or(""),
        &entry,
        if staged { None } else { Some(&mut contents) },
    );
    let bytes = if !staged
        && before.is_ok()
        && fs::symlink_metadata(root_path.join(path)).is_ok_and(|m| m.is_file())
    {
        Some(contents)
    } else {
        None
    };
    let diff = match staged_diff {
        Some(diff) => diff,
        None => load_working_tree_file_diff_with_content(
            &snapshot.info.root,
            head.or(snapshot.status.head_oid.as_deref()),
            &file,
            staged,
            bytes,
        )?,
    };
    let context = before.and_then(|before| {
        if staged && head.is_some() && head != snapshot.status.head_oid.as_deref() {
            return Err(error("HEAD changed; refresh and review again"));
        }
        let file = changed
            .cloned()
            .ok_or_else(|| error("File has no changes; refresh the diff"))?;
        Ok(HunkContext {
            root: snapshot.info.root.clone(),
            revision_before: before,
            file,
            entry,
            staged,
        })
    });
    Ok((diff, context))
}

fn build_hunk_review(context: &HunkContext) -> Result<ReviewedHunks, GitError> {
    let root_path = Path::new(&context.root);
    let file = &context.file;
    let path = file.path.as_str();
    safe_path(root_path, path)?;
    let staged = context.staged;
    let entry = &context.entry;
    let side = if staged {
        &file.index_status
    } else {
        &file.worktree_status
    };
    let mut unavailable = None;
    if side == "." || side == " " || (staged && side == "?") {
        unavailable = Some("No changes on this side of the diff.".to_string());
    } else if file.index_status == "U"
        || file.worktree_status == "U"
        || entry.split('\0').filter(|l| !l.is_empty()).any(|l| {
            l.split_once('\t')
                .is_some_and(|(fields, _)| !fields.ends_with(" 0"))
        })
    {
        unavailable = Some("Resolve conflicts before selecting hunks.".to_string());
    } else if file.original_path.is_some() || matches!(side.as_str(), "R" | "C" | "T") {
        unavailable = Some("Renames and type changes use whole-file actions.".to_string());
    } else if entry.starts_with("120000 ")
        || entry.starts_with("160000 ")
        || fs::symlink_metadata(root_path.join(path)).is_ok_and(|m| !m.is_file())
    {
        unavailable = Some("Symlinks and submodules use whole-file actions.".to_string());
    }
    let mut patch = String::new();
    if unavailable.is_none() {
        let mut args = vec![
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--unified=3",
            "--inter-hunk-context=0",
            "--diff-algorithm=myers",
            "--no-indent-heuristic",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ];
        if staged {
            args.push("--cached");
        }
        if file.index_status == "?" {
            args.extend(["--no-index", "--", "/dev/null", path]);
            patch = GitCommand::run_diff(&args, root_path)?;
        } else {
            args.extend(["--", path]);
            patch = GitCommand::run_diff(&args, root_path)?;
        }
        if patch.contains("GIT binary patch")
            || patch.lines().any(|l| l.starts_with("Binary files "))
        {
            unavailable = Some("Binary files use whole-file actions.".to_string());
        } else if patch
            .lines()
            .any(|l| l.starts_with("old mode ") || l.starts_with("new mode "))
        {
            unavailable = Some("File mode changes use whole-file actions.".to_string());
        }
    }
    let mut hunks: Vec<Hunk> = Vec::new();
    if unavailable.is_none() {
        for line in patch.split_inclusive('\n') {
            if line.starts_with("@@ ") {
                hunks.push(Hunk {
                    id: hunks.len() as u32,
                    header: line.trim_end().to_string(),
                    patch: String::new(),
                });
            }
            if let Some(hunk) = hunks.last_mut() {
                hunk.patch.push_str(line);
            }
        }
        if hunks.is_empty() {
            unavailable = Some("No selectable text hunks; use whole-file actions.".to_string());
        }
    }
    if context.revision_before != revision(root_path, path)? {
        return Err(error(
            "File changed while loading its diff; refresh and review again",
        ));
    }
    let mut hash = Sha256::new();
    hash.update(&context.revision_before);
    hash.update(patch.as_bytes());
    let preview = HunkPreview {
        file_path: path.to_string(),
        staged,
        revision: format!("{:x}", hash.finalize()),
        patch,
        hunks,
        unavailable_reason: unavailable,
    };
    Ok(ReviewedHunks {
        preview,
        context: context.clone(),
    })
}

pub fn apply_hunks(
    root: &str,
    path: &str,
    staged: bool,
    expected_revision: &str,
    ids: &[u32],
) -> Result<(), GitError> {
    let started = std::time::Instant::now();
    let result = prepare_hunks(root, path, staged);
    let review = finish_hunk_validation(started, result)?;
    apply_reviewed_hunks(&review, expected_revision, ids)
}

/// A continuation reuses the original preconditions, generates a fresh Git
/// patch (including current filters/attributes), and compares HEAD, all index
/// stages, permissions, and every worktree byte against the reviewed state.
pub fn apply_cached_hunks(
    context: &HunkContext,
    expected_revision: &str,
    ids: &[u32],
) -> Result<(), GitError> {
    let started = std::time::Instant::now();
    let result = context.complete();
    let review = finish_hunk_validation(started, result)?;
    apply_reviewed_hunks(&review, expected_revision, ids)
}

fn finish_hunk_validation(
    started: std::time::Instant,
    result: Result<ReviewedHunks, GitError>,
) -> Result<ReviewedHunks, GitError> {
    tracing::info!(
        target: "gitgui::hunk_stage",
        phase = "preview_validation",
        elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
        "Hunk stage phase completed"
    );
    result
}

fn apply_reviewed_hunks(
    review: &ReviewedHunks,
    expected_revision: &str,
    ids: &[u32],
) -> Result<(), GitError> {
    let preview = &review.preview;
    if preview.revision != expected_revision {
        return Err(error("Selected hunks changed; refresh and review again"));
    }
    if let Some(reason) = &preview.unavailable_reason {
        return Err(error(reason.clone()));
    }
    let selected: HashSet<u32> = ids.iter().copied().collect();
    if selected.is_empty()
        || selected.len() != ids.len()
        || selected
            .iter()
            .any(|id| *id as usize >= preview.hunks.len())
    {
        return Err(error("Select valid, distinct hunks"));
    }
    let mut patch = String::new();
    for line in preview
        .patch
        .split_inclusive('\n')
        .take_while(|l| !l.starts_with("@@ "))
    {
        patch.push_str(line);
    }
    for hunk in &preview.hunks {
        if selected.contains(&hunk.id) {
            patch.push_str(&hunk.patch);
        }
    }
    let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
    if preview.staged {
        args.push("--reverse");
    }
    let mut check = args.clone();
    check.push("--check");
    let root = review.context.root.as_str();
    let patch_bytes = patch.len().min(u32::MAX as usize);
    let check_started = std::time::Instant::now();
    let check_result = GitCommand::run_with_stdin(&check, Some(Path::new(root)), patch.as_bytes());
    tracing::info!(
        target: "gitgui::hunk_stage",
        phase = "patch_check",
        elapsed_ms = check_started.elapsed().as_secs_f64() * 1000.0,
        patch_bytes,
        succeeded = check_result.is_ok(),
        "Hunk stage phase completed"
    );
    check_result?;
    let apply_started = std::time::Instant::now();
    let apply_result = GitCommand::run_with_stdin(&args, Some(Path::new(root)), patch.as_bytes());
    tracing::info!(
        target: "gitgui::hunk_stage",
        phase = "patch_apply",
        elapsed_ms = apply_started.elapsed().as_secs_f64() * 1000.0,
        patch_bytes,
        succeeded = apply_result.is_ok(),
        "Hunk stage phase completed"
    );
    apply_result.map(|_| ())
}

pub fn preview_discard(root: &str, paths: &[String]) -> Result<Vec<DiscardFile>, GitError> {
    Ok(prepare_discard(root, paths, false)?.files)
}

struct DiscardReview {
    root: String,
    files: Vec<DiscardFile>,
    entries: HashMap<String, String>,
    head: Option<String>,
    filtered: bool,
}

// Query selected index entries together, bounded below Windows' command-line
// limit. Keep each exact -z record: it is part of the reviewed fingerprint.
fn discard_path_batches(mut paths: &[String]) -> impl Iterator<Item = &[String]> {
    std::iter::from_fn(move || {
        if paths.is_empty() {
            return None;
        }
        let mut end = 0;
        let mut units = 0;
        while end < paths.len() && (end == 0 || units + paths[end].len() * 2 + 3 < 16_000) {
            units += paths[end].len() * 2 + 3;
            end += 1;
        }
        let (batch, rest) = paths.split_at(end);
        paths = rest;
        Some(batch)
    })
}

fn discard_index_entries(
    root: &Path,
    paths: &[String],
) -> Result<HashMap<String, String>, GitError> {
    let mut entries = HashMap::<String, String>::new();
    for batch in discard_path_batches(paths) {
        let mut args = vec!["--literal-pathspecs", "ls-files", "--stage", "-z", "--"];
        args.extend(batch.iter().map(String::as_str));
        let output = GitCommand::run(&args, Some(root))?;
        for record in output.split_terminator('\0') {
            let (_, path) = record
                .split_once('\t')
                .ok_or_else(|| error("Malformed index entry"))?;
            let entry = entries.entry(path.to_string()).or_default();
            entry.push_str(record);
            entry.push('\0');
        }
    }
    Ok(entries)
}

fn prepare_discard(
    root: &str,
    paths: &[String],
    check_filters: bool,
) -> Result<DiscardReview, GitError> {
    if paths.is_empty() {
        return Err(error("Discard requires explicit file paths"));
    }
    let mut seen = HashSet::new();
    for path in paths {
        safe_path(Path::new(root), path)?;
        if !seen.insert(path) {
            return Err(error("Duplicate discard path"));
        }
    }
    let snapshot = load_repository_status(root)?;
    let root = snapshot.info.root;
    let status = snapshot.status;
    let entries = discard_index_entries(Path::new(&root), paths)?;
    // Resolve filters before fingerprinting, so the last expensive work before
    // an ordinary batch restore is its complete content validation.
    let filtered = if check_filters && paths.iter().filter(|p| entries.contains_key(*p)).count() > 1
    {
        let mut filtered = false;
        // Checkout prefers indexed attributes. Ordinary check-attr prefers the
        // worktree, so either source must conservatively disable batching.
        for batch in discard_path_batches(paths) {
            for cached in [false, true] {
                // check-attr streams output; use bounded argv rather than
                // filling stdin before the synchronous runner drains stdout.
                let mut args = vec!["--literal-pathspecs", "check-attr", "-z", "filter", "--"];
                if cached {
                    args.insert(2, "--cached");
                }
                args.extend(batch.iter().map(String::as_str));
                let attributes = GitCommand::run(&args, Some(Path::new(&root)))?;
                filtered |= attributes
                    .split_terminator('\0')
                    .collect::<Vec<_>>()
                    .chunks(3)
                    .any(|record| {
                        record.len() != 3 || !matches!(record[2], "unspecified" | "unset")
                    });
            }
        }
        filtered
    } else {
        false
    };
    let mut files = Vec::new();
    for path in paths {
        let file = status
            .changed_files
            .iter()
            .find(|f| &f.path == path)
            .ok_or_else(|| error(format!("{path}: no unstaged changes; refresh")))?;
        let entry = entries.get(path).map(String::as_str).unwrap_or("");
        if file.worktree_status == "." || file.worktree_status == " " {
            return Err(error(format!("{path}: no unstaged changes")));
        }
        if matches!(file.worktree_status.as_str(), "R" | "C")
            || entry.starts_with("160000 ")
            || file.index_status == "U"
            || file.worktree_status == "U"
            || entry
                .split('\0')
                .filter(|l| !l.is_empty())
                .any(|l| l.split_once('\t').is_some_and(|(f, _)| !f.ends_with(" 0")))
        {
            return Err(error(format!(
                "{path}: discard requires a resolved ordinary file; use its dedicated workflow"
            )));
        }
        if (file.index_status == "?") != entry.is_empty() {
            return Err(error(format!("{path}: index changed; review again")));
        }
        files.push(DiscardFile {
            path: path.clone(),
            untracked: file.index_status == "?",
            revision: revision_with_inputs(
                Path::new(&root),
                path,
                status.head_oid.as_deref().unwrap_or(""),
                entry,
                None,
            )?,
        });
    }
    Ok(DiscardReview {
        root,
        files,
        entries,
        head: status.head_oid,
        filtered,
    })
}

pub fn discard(
    root: &str,
    expected: &[DiscardFile],
    delete_untracked: bool,
) -> Result<DiscardOutcome, GitError> {
    let paths = expected.iter().map(|f| f.path.clone()).collect::<Vec<_>>();
    let review = prepare_discard(root, &paths, true)?;
    let current = &review.files;
    let root = Path::new(&review.root);
    for (old, new) in expected.iter().zip(current) {
        if old.revision != new.revision || old.untracked != new.untracked {
            return Err(error(format!(
                "{} changed since confirmation; review again",
                old.path
            )));
        }
        if old.untracked && !delete_untracked {
            return Err(error("Untracked deletion requires explicit confirmation"));
        }
    }
    // Filters can change a later target while restoring an earlier one. Keep
    // per-file validation/restoration for these repositories. Ordinary tracked
    // files share one literal NUL-delimited restore without command-line limits.
    let filtered = review.filtered;
    let mut completed = Vec::new();
    let mut i = 0;
    while i < current.len() {
        let file = &current[i];
        let mut end = i + 1;
        if !file.untracked && !filtered {
            while end < current.len() && !current[end].untracked && end - i < 64 {
                end += 1;
            }
        }
        // Check again immediately before touching each target, since external
        // editors and Git processes do not participate in the server lock. The
        // first ordinary restore uses the full prevalidation above. Deletions
        // always rehash immediately before remove_file, including after filters.
        let mut restore_attempted = false;
        let result = (|| {
            if i != 0 || end != current.len() || file.untracked || filtered {
                let head = GitCommand::run(&["rev-parse", "--verify", "HEAD"], Some(root))
                    .unwrap_or_default();
                let entries = discard_index_entries(root, &paths[i..end])?;
                for target in &current[i..end] {
                    let entry = entries.get(&target.path).map(String::as_str).unwrap_or("");
                    if revision_with_inputs(root, &target.path, head.trim(), entry, None)?
                        != target.revision
                    {
                        return Err(error("File changed during discard"));
                    }
                }
            }
            if file.untracked {
                fs::remove_file(root.join(&file.path)).map_err(|e| error(e.to_string()))
            } else {
                let input = paths[i..end]
                    .iter()
                    .flat_map(|p| p.bytes().chain([0]))
                    .collect::<Vec<_>>();
                restore_attempted = true;
                GitCommand::run_with_stdin(
                    &[
                        "--literal-pathspecs",
                        "restore",
                        "--worktree",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ],
                    Some(root),
                    &input,
                )
                .map(|_| ())
            }
        })();
        if let Err(e) = result {
            // Git may restore part of a batch before failing. Never replay it.
            // Only credit paths now clean against the SAME index; changed or
            // unreadable paths remain explicit unresolved targets.
            if restore_attempted && end - i > 1 {
                if let (Ok(snapshot), Ok(entries)) = (
                    load_repository_status(&review.root),
                    discard_index_entries(root, &paths[i..end]),
                ) {
                    for target in &current[i..end] {
                        let dirty = snapshot.status.changed_files.iter().any(|f| {
                            f.path == target.path
                                && !matches!(f.worktree_status.as_str(), "." | " ")
                        });
                        if !dirty
                            && snapshot.status.head_oid == review.head
                            && entries.get(&target.path) == review.entries.get(&target.path)
                        {
                            completed.push(target.path.clone());
                        }
                    }
                }
            }
            return Ok(DiscardOutcome {
                remaining_paths: paths
                    .iter()
                    .filter(|p| !completed.contains(p))
                    .cloned()
                    .collect(),
                completed_paths: completed,
                error: Some(format!("{}: {} {}", file.path, e.message, e.stderr)),
            });
        }
        completed.extend(paths[i..end].iter().cloned());
        i = end;
    }
    Ok(DiscardOutcome {
        completed_paths: completed,
        remaining_paths: Vec::new(),
        error: None,
    })
}

pub fn amend_info(root: &str) -> Result<AmendInfo, GitError> {
    let path = Path::new(root);
    let head = load_repository_status(root)?.status.head_oid;
    let mut blocked = if head.is_none() {
        Some("There is no commit to amend.".to_string())
    } else {
        None
    };
    for state in [
        "MERGE_HEAD",
        "rebase-merge",
        "rebase-apply",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "sequencer",
    ] {
        let state_path = GitCommand::run(&["rev-parse", "--git-path", state], Some(path))?;
        if path.join(state_path.trim()).exists() {
            blocked = Some(
                "Finish the current merge, rebase, cherry-pick, or revert before amending."
                    .to_string(),
            );
            break;
        }
    }
    let message = if let Some(oid) = &head {
        GitCommand::run(&["show", "-s", "--format=%B", oid], Some(path))?
    } else {
        String::new()
    };
    let (summary, description) = message
        .trim_end()
        .split_once('\n')
        .unwrap_or((message.trim_end(), ""));
    Ok(AmendInfo {
        head_oid: head,
        summary: summary.to_string(),
        description: description.trim_start_matches('\n').to_string(),
        blocked_reason: blocked,
    })
}

pub fn amend(root: &str, expected_head: &str, message: &str) -> Result<(), GitError> {
    let info = amend_info(root)?;
    if let Some(reason) = info.blocked_reason {
        return Err(error(reason));
    }
    if info.head_oid.as_deref() != Some(expected_head) {
        return Err(error(
            "HEAD changed after loading the amend message; review again",
        ));
    }
    GitCommand::run_with_stdin(
        &["commit", "--amend", "--file=-"],
        Some(Path::new(root)),
        message.as_bytes(),
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::operations;

    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        git(dir.path(), &["config", "user.name", "GitGui Test"]);
        git(dir.path(), &["config", "user.email", "test@example.com"]);
        git(dir.path(), &["config", "core.autocrlf", "false"]);
        dir
    }
    fn git(root: &Path, args: &[&str]) -> String {
        GitCommand::run(args, Some(root)).unwrap()
    }
    fn base_file(root: &Path, name: &str) {
        fs::write(
            root.join(name),
            (1..=30).map(|n| format!("line {n}\n")).collect::<String>(),
        )
        .unwrap();
        git(root, &["--literal-pathspecs", "add", "--", name]);
        git(root, &["commit", "-q", "-m", "base"]);
    }

    #[test]
    fn stages_and_unstages_selected_hunks_without_changing_worktree() {
        let repo = repository();
        let root = repo.path();
        let name = "odd [file].txt";
        base_file(root, name);
        let content = fs::read_to_string(root.join(name))
            .unwrap()
            .replace("line 2\n", "first\nextra\n")
            .replace("line 28\n", "last\n");
        fs::write(root.join(name), &content).unwrap();
        let preview = preview_hunks(root.to_str().unwrap(), name, false).unwrap();
        assert_eq!(preview.hunks.len(), 2);
        apply_hunks(root.to_str().unwrap(), name, false, &preview.revision, &[1]).unwrap();
        let indexed = git(root, &["show", &format!(":{name}")]);
        assert!(indexed.contains("last\n"));
        assert!(!indexed.contains("first\n"));
        assert_eq!(fs::read_to_string(root.join(name)).unwrap(), content);
        let staged = preview_hunks(root.to_str().unwrap(), name, true).unwrap();
        apply_hunks(root.to_str().unwrap(), name, true, &staged.revision, &[0]).unwrap();
        assert_eq!(git(root, &["diff", "--cached"]), "");
        assert_eq!(fs::read_to_string(root.join(name)).unwrap(), content);

        operations::stage(root.to_str().unwrap(), &[name.into()]).unwrap();
        let staged = preview_hunks(root.to_str().unwrap(), name, true).unwrap();
        assert_eq!(staged.hunks.len(), 2);
        apply_hunks(root.to_str().unwrap(), name, true, &staged.revision, &[1]).unwrap();
        let indexed = git(root, &["show", &format!(":{name}")]);
        assert!(indexed.contains("first\n"));
        assert!(!indexed.contains("last\n"));
        assert_eq!(fs::read_to_string(root.join(name)).unwrap(), content);
    }

    #[test]
    fn rejects_stale_and_invalid_hunk_selections() {
        let repo = repository();
        let root = repo.path();
        base_file(root, "file.txt");
        fs::write(root.join("file.txt"), "changed\n").unwrap();
        let preview = preview_hunks(root.to_str().unwrap(), "file.txt", false).unwrap();
        assert!(apply_hunks(
            root.to_str().unwrap(),
            "file.txt",
            false,
            &preview.revision,
            &[99]
        )
        .is_err());
        assert!(apply_hunks(
            root.to_str().unwrap(),
            "file.txt",
            false,
            &preview.revision,
            &[0, 0]
        )
        .is_err());
        fs::write(root.join("file.txt"), "newer\n").unwrap();
        assert!(apply_hunks(
            root.to_str().unwrap(),
            "file.txt",
            false,
            &preview.revision,
            &[0]
        )
        .unwrap_err()
        .message
        .contains("changed"));
        assert_eq!(git(root, &["diff", "--cached"]), "");
    }

    #[test]
    fn file_view_continuations_stage_and_unstage_eligible_text_and_untracked_files() {
        for untracked in [false, true] {
            let repo = repository();
            let root = repo.path();
            let r = root.to_str().unwrap();
            if !untracked {
                base_file(root, "file [1].txt");
            }
            let content = format!("changed\n{}", "long line\n".repeat(250));
            fs::write(root.join("file [1].txt"), &content).unwrap();
            let (diff, context) =
                load_working_tree_file_view(r, None, "file [1].txt", false).unwrap();
            assert_eq!(diff.modified_content, content);
            assert!(!diff.is_binary);
            let context = context.unwrap();
            let review = context.complete().unwrap();
            assert_eq!(
                review.preview.patch,
                preview_hunks(r, "file [1].txt", false).unwrap().patch
            );
            apply_cached_hunks(&context, &review.preview.revision, &[0]).unwrap();
            assert_eq!(git(root, &["show", ":file [1].txt"]), content);
            let (diff, context) =
                load_working_tree_file_view(r, None, "file [1].txt", true).unwrap();
            assert_eq!(diff.modified_content, content);
            let context = context.unwrap();
            let review = context.complete().unwrap();
            apply_cached_hunks(&context, &review.preview.revision, &[0]).unwrap();
            assert_eq!(git(root, &["diff", "--cached"]), "");
            assert_eq!(
                fs::read_to_string(root.join("file [1].txt")).unwrap(),
                content
            );
        }
    }

    #[test]
    fn continuations_reject_same_size_timestamp_restored_edits_and_external_index_or_head_changes()
    {
        for change in ["bytes", "index", "head"] {
            let repo = repository();
            let root = repo.path();
            let r = root.to_str().unwrap();
            base_file(root, "file.txt");
            fs::write(root.join("file.txt"), "reviewed\n").unwrap();
            let (_, context) = load_working_tree_file_view(r, None, "file.txt", false).unwrap();
            let context = context.unwrap();
            let preview = context.complete().unwrap().preview;
            match change {
                "bytes" => {
                    let modified = fs::metadata(root.join("file.txt"))
                        .unwrap()
                        .modified()
                        .unwrap();
                    fs::write(root.join("file.txt"), "external\n").unwrap();
                    fs::OpenOptions::new()
                        .write(true)
                        .open(root.join("file.txt"))
                        .unwrap()
                        .set_times(fs::FileTimes::new().set_modified(modified))
                        .unwrap();
                }
                "index" => {
                    fs::write(root.join("file.txt"), "indexed\n").unwrap();
                    git(root, &["add", "file.txt"]);
                    fs::write(root.join("file.txt"), "reviewed\n").unwrap();
                }
                "head" => {
                    git(root, &["commit", "--allow-empty", "-qm", "external"]);
                }
                _ => unreachable!(),
            }
            let index_before = git(root, &["ls-files", "--stage"]);
            assert!(context.complete().unwrap_err().message.contains("changed"));
            assert!(apply_cached_hunks(&context, &preview.revision, &[0]).is_err());
            assert_eq!(git(root, &["ls-files", "--stage"]), index_before);
        }
    }

    #[test]
    fn cached_apply_regenerates_git_patch_after_attribute_changes() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        base_file(root, "file.txt");
        fs::write(root.join("file.txt"), "reviewed\n").unwrap();
        let review = prepare_hunks(r, "file.txt", false).unwrap();
        fs::write(root.join(".gitattributes"), "file.txt -diff\n").unwrap();
        assert!(apply_cached_hunks(&review.context, &review.preview.revision, &[0]).is_err());
        assert_eq!(git(root, &["diff", "--cached"]), "");
    }

    #[test]
    fn shared_view_preserves_binary_rename_deletion_and_add_add_conflict_behavior() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        base_file(root, "file.txt");
        fs::write(root.join("file.txt"), b"binary\0content").unwrap();
        let (diff, context) = load_working_tree_file_view(r, None, "file.txt", false).unwrap();
        assert!(diff.is_binary);
        assert!(context
            .unwrap()
            .complete()
            .unwrap()
            .preview
            .unavailable_reason
            .unwrap()
            .contains("Binary"));
        fs::remove_file(root.join("file.txt")).unwrap();
        let (diff, context) = load_working_tree_file_view(r, None, "file.txt", false).unwrap();
        assert!(diff.modified_content.is_empty());
        assert!(diff.message.is_none());
        assert_eq!(context.unwrap().complete().unwrap().preview.hunks.len(), 1);
        git(root, &["restore", "file.txt"]);
        git(root, &["mv", "file.txt", "renamed.txt"]);
        let (diff, context) = load_working_tree_file_view(r, None, "renamed.txt", true).unwrap();
        assert_eq!(diff.original_path.as_deref(), Some("file.txt"));
        assert_eq!(diff.original_content, diff.modified_content);
        assert!(context
            .unwrap()
            .complete()
            .unwrap()
            .preview
            .unavailable_reason
            .unwrap()
            .contains("Renames"));

        let oid = git(root, &["rev-parse", "HEAD:file.txt"]);
        let conflict = format!(
            "0 {}\trenamed.txt\n100644 {} 2\trenamed.txt\n100644 {} 3\trenamed.txt\n",
            "0".repeat(40),
            oid.trim(),
            oid.trim()
        );
        GitCommand::run_with_stdin(
            &["update-index", "--index-info"],
            Some(root),
            conflict.as_bytes(),
        )
        .unwrap();
        let (_, context) = load_working_tree_file_view(r, None, "renamed.txt", false).unwrap();
        assert!(context
            .unwrap()
            .complete()
            .unwrap()
            .preview
            .unavailable_reason
            .unwrap()
            .contains("conflicts"));
    }

    #[test]
    fn shared_view_rejects_unsafe_paths_and_stale_staged_head() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        for path in ["../outside", ".git/config", "C:\\outside", "/outside"] {
            assert!(load_working_tree_file_view(r, None, path, false).is_err());
        }
        base_file(root, "file.txt");
        let old_head = git(root, &["rev-parse", "HEAD"]);
        fs::write(root.join("file.txt"), "staged\n").unwrap();
        git(root, &["add", "file.txt"]);
        git(root, &["commit", "--allow-empty", "-qm", "external"]);
        fs::write(root.join("file.txt"), "next\n").unwrap();
        git(root, &["add", "file.txt"]);
        let (diff, context) =
            load_working_tree_file_view(r, Some(old_head.trim()), "file.txt", true).unwrap();
        assert_eq!(diff.modified_content, "next\n");
        assert!(context.unwrap_err().message.contains("HEAD changed"));
    }

    #[test]
    fn supports_addition_and_unstage_before_first_commit_and_deletion() {
        let repo = repository();
        let root = repo.path();
        let root_str = root.to_str().unwrap();
        fs::write(root.join("new file.txt"), "new\n").unwrap();
        let p = preview_hunks(root_str, "new file.txt", false).unwrap();
        apply_hunks(root_str, "new file.txt", false, &p.revision, &[0]).unwrap();
        assert_eq!(git(root, &["show", ":new file.txt"]), "new\n");
        let p = preview_hunks(root_str, "new file.txt", true).unwrap();
        apply_hunks(root_str, "new file.txt", true, &p.revision, &[0]).unwrap();
        assert_eq!(git(root, &["ls-files"]), "");
        assert_eq!(
            fs::read_to_string(root.join("new file.txt")).unwrap(),
            "new\n"
        );
        operations::stage(root_str, &["new file.txt".into()]).unwrap();
        operations::unstage(root_str, &["new file.txt".into()]).unwrap();
        operations::stage(root_str, &["new file.txt".into()]).unwrap();
        git(root, &["commit", "-q", "-m", "base"]);
        fs::remove_file(root.join("new file.txt")).unwrap();
        let p = preview_hunks(root_str, "new file.txt", false).unwrap();
        apply_hunks(root_str, "new file.txt", false, &p.revision, &[0]).unwrap();
        let p = preview_hunks(root_str, "new file.txt", true).unwrap();
        apply_hunks(root_str, "new file.txt", true, &p.revision, &[0]).unwrap();
        assert_eq!(git(root, &["show", ":new file.txt"]), "new\n");
        assert!(!root.join("new file.txt").exists());
    }

    #[test]
    fn discard_preserves_index_and_requires_explicit_untracked_deletion() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        base_file(root, "file.txt");
        fs::write(root.join("file.txt"), "staged\n").unwrap();
        git(root, &["add", "file.txt"]);
        fs::write(root.join("file.txt"), "unstaged\n").unwrap();
        fs::write(root.join("untracked.txt"), "keep\n").unwrap();
        let p = preview_discard(r, &["file.txt".into(), "untracked.txt".into()]).unwrap();
        assert!(discard(r, &p, false).is_err());
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "unstaged\n"
        );
        let result = discard(r, &p[..1], false).unwrap();
        assert!(result.error.is_none());
        assert_eq!(git(root, &["show", ":file.txt"]), "staged\n");
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "staged\n"
        );
        assert!(root.join("untracked.txt").exists());
        discard(r, &p[1..], true).unwrap();
        assert!(!root.join("untracked.txt").exists());
    }

    #[test]
    fn discard_prevalidates_entire_batch_and_restores_deleted_files() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        base_file(root, "file.txt");
        fs::write(root.join("file.txt"), "unstaged\n").unwrap();
        fs::write(root.join("another.txt"), "first\n").unwrap();
        let p = preview_discard(r, &["file.txt".into(), "another.txt".into()]).unwrap();
        fs::write(root.join("another.txt"), "changed\n").unwrap();
        assert!(discard(r, &p, true).is_err());
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "unstaged\n"
        );
        fs::remove_file(root.join("file.txt")).unwrap();
        let p = preview_discard(r, &["file.txt".into()]).unwrap();
        discard(r, &p, false).unwrap();
        assert!(fs::read_to_string(root.join("file.txt"))
            .unwrap()
            .starts_with("line 1\n"));
    }

    #[test]
    fn amend_preserves_unstaged_contents_and_blocks_stale_head_and_repository_states() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        assert!(amend_info(r).unwrap().blocked_reason.is_some());
        base_file(root, "file.txt");
        let info = amend_info(r).unwrap();
        let head = info.head_oid.unwrap();
        fs::write(root.join("file.txt"), "unstaged\n").unwrap();
        amend(r, &head, "reworded\n\nbody").unwrap();
        assert_eq!(amend_info(r).unwrap().summary, "reworded");
        assert_eq!(amend_info(r).unwrap().description, "body");
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "unstaged\n"
        );
        assert!(git(root, &["show", "HEAD:file.txt"]).starts_with("line 1\n"));
        assert!(amend(r, &head, "stale").is_err());
        let head = amend_info(r).unwrap().head_oid.unwrap();
        fs::write(root.join(".git/MERGE_HEAD"), &head).unwrap();
        assert!(amend(r, &head, "blocked").is_err());
        fs::remove_file(root.join(".git/MERGE_HEAD")).unwrap();
        for state in [
            "rebase-merge",
            "rebase-apply",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "sequencer",
        ] {
            let state_path = root.join(".git").join(state);
            if matches!(state, "rebase-merge" | "rebase-apply" | "sequencer") {
                fs::create_dir(&state_path).unwrap();
                assert!(amend_info(r).unwrap().blocked_reason.is_some());
                fs::remove_dir(&state_path).unwrap();
            } else {
                fs::write(&state_path, &head).unwrap();
                assert!(amend_info(r).unwrap().blocked_reason.is_some());
                fs::remove_file(&state_path).unwrap();
            }
        }
        git(root, &["switch", "--detach", "-q"]);
        git(root, &["add", "file.txt"]);
        amend(r, &head, "detached").unwrap();
        assert_eq!(git(root, &["show", "HEAD:file.txt"]), "unstaged\n");
    }

    #[cfg(unix)]
    #[test]
    fn cannot_follow_parent_symlinks_or_delete_ignored_files() {
        let repo = repository();
        let outside = tempfile::tempdir().unwrap();
        let root = repo.path();
        let r = root.to_str().unwrap();
        fs::write(outside.path().join("precious"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
        assert!(preview_discard(r, &["link/precious".into()]).is_err());
        assert!(preview_hunks(r, "link/precious", false).is_err());
        assert!(load_working_tree_file_view(r, None, "link/precious", false).is_err());
        std::os::unix::fs::symlink(outside.path().join("precious"), root.join("leaf")).unwrap();
        let (diff, _) = load_working_tree_file_view(r, None, "leaf", false).unwrap();
        assert!(diff.modified_content.is_empty());
        assert!(diff.message.unwrap().contains("Symlinks"));
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/precious"), "reviewed\n").unwrap();
        let (_, context) = load_working_tree_file_view(r, None, "nested/precious", false).unwrap();
        fs::rename(root.join("nested"), root.join("original-nested")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("nested")).unwrap();
        assert!(context.unwrap().complete().is_err());
        fs::write(root.join(".gitignore"), "ignored\n").unwrap();
        fs::write(root.join("ignored"), "keep").unwrap();
        assert!(preview_discard(r, &["ignored".into()]).is_err());
        let p = preview_discard(r, &["link".into()]).unwrap();
        discard(r, &p, true).unwrap();
        assert_eq!(
            fs::read_to_string(outside.path().join("precious")).unwrap(),
            "keep"
        );
        assert!(!root.join("link").exists());
    }

    #[test]
    fn unstage_before_first_commit_preserves_later_edits_and_index_diff_base() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        fs::write(root.join("new.txt"), "staged\n").unwrap();
        operations::stage(r, &["new.txt".into()]).unwrap();
        fs::write(root.join("new.txt"), "later\n").unwrap();
        let diff = crate::git::repository::load_working_tree_file_diff(
            r,
            None,
            &crate::git::repository::CommitFile {
                path: "new.txt".into(),
                original_path: None,
                status: "AM".into(),
            },
            false,
        )
        .unwrap();
        assert_eq!(diff.original_content, "staged\n");
        operations::unstage(r, &["new.txt".into()]).unwrap();
        assert_eq!(git(root, &["ls-files"]), "");
        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "later\n");
    }

    #[test]
    fn git_hunks_respect_crlf_normalization_and_missing_final_newline() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        fs::write(root.join(".gitattributes"), "*.txt text eol=crlf\n").unwrap();
        fs::write(root.join("crlf.txt"), "before\r\nlast").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "base"]);
        fs::write(root.join("crlf.txt"), "after\r\nlast").unwrap();
        let (diff, context) = load_working_tree_file_view(r, None, "crlf.txt", false).unwrap();
        assert_eq!(diff.modified_content, "after\r\nlast");
        let context = context.unwrap();
        let p = context.complete().unwrap().preview;
        apply_cached_hunks(&context, &p.revision, &[0]).unwrap();
        assert_eq!(git(root, &["show", ":crlf.txt"]), "after\nlast");
        assert_eq!(fs::read(root.join("crlf.txt")).unwrap(), b"after\r\nlast");
    }

    #[test]
    fn discard_and_stage_treat_unusual_paths_as_literal_file_names() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        let spaced = if cfg!(windows) {
            " spaced .txt"
        } else {
            " spaced .txt "
        };
        let pattern = if cfg!(windows) {
            "[literal].txt"
        } else {
            "*.txt"
        };
        for name in [spaced, pattern, "-option.txt"] {
            fs::write(root.join(name), "base\n").unwrap();
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "base"]);
        for name in [spaced, pattern, "-option.txt"] {
            fs::write(root.join(name), "changed\n").unwrap();
        }
        let p = preview_hunks(r, pattern, false).unwrap();
        apply_hunks(r, pattern, false, &p.revision, &[0]).unwrap();
        assert_eq!(git(root, &["show", ":-option.txt"]), "base\n");
        let p = preview_discard(r, &[spaced.into(), "-option.txt".into()]).unwrap();
        discard(r, &p, false).unwrap();
        assert_eq!(fs::read_to_string(root.join(spaced)).unwrap(), "base\n");
        assert_eq!(fs::read_to_string(root.join(pattern)).unwrap(), "changed\n");
    }

    #[test]
    fn binary_hunks_are_disabled_and_amend_hook_failures_do_not_change_head() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        base_file(root, "file.txt");
        fs::write(root.join("file.txt"), b"binary\0content").unwrap();
        assert!(preview_hunks(r, "file.txt", false)
            .unwrap()
            .unavailable_reason
            .unwrap()
            .contains("Binary"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let hook = root.join(".git/hooks/pre-commit");
            fs::write(&hook, "#!/bin/sh\necho hook-rejected >&2\nexit 1\n").unwrap();
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
            let head = amend_info(r).unwrap().head_oid.unwrap();
            let e = amend(r, &head, "rejected").unwrap_err();
            assert!(e.stderr.contains("hook-rejected"));
            assert_eq!(
                amend_info(r).unwrap().head_oid.as_deref(),
                Some(head.as_str())
            );
        }
    }

    #[test]
    fn discard_reports_completed_and_remaining_paths_after_external_change() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        base_file(root, "file.txt");
        fs::write(root.join(".gitattributes"), "file.txt filter=change-next\n").unwrap();
        git(
            root,
            &[
                "config",
                "filter.change-next.smudge",
                "cat; printf newer > next.txt",
            ],
        );
        fs::write(root.join("file.txt"), "unstaged\n").unwrap();
        fs::write(root.join("next.txt"), "before\n").unwrap();
        let p = preview_discard(r, &["file.txt".into(), "next.txt".into()]).unwrap();
        let result = discard(r, &p, true).unwrap();
        assert_eq!(result.completed_paths, ["file.txt"]);
        assert_eq!(result.remaining_paths, ["next.txt"]);
        assert!(result.error.unwrap().contains("changed"));
        assert_eq!(fs::read_to_string(root.join("next.txt")).unwrap(), "newer");
    }

    #[test]
    fn discard_preserves_staged_rename_and_its_indexed_contents() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        base_file(root, "old.txt");
        git(root, &["mv", "old.txt", "new.txt"]);
        fs::write(root.join("new.txt"), "unstaged rename edit\n").unwrap();
        let p = preview_discard(r, &["new.txt".into()]).unwrap();
        discard(r, &p, false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("new.txt")).unwrap(),
            git(root, &["show", ":new.txt"])
        );
        assert_eq!(
            load_repository_status(r).unwrap().status.changed_files[0].index_status,
            "R"
        );
        assert!(!root.join("old.txt").exists());
    }

    #[test]
    fn discard_batches_tracked_paths_and_reduces_processes_and_fingerprint_reads() {
        use super::super::command::test_metrics;
        for count in [1, 20] {
            let repo = repository();
            let root = repo.path();
            let r = root.to_str().unwrap();
            let paths = (0..count)
                .map(|i| format!("file [{i}].txt"))
                .collect::<Vec<_>>();
            for path in &paths {
                fs::write(root.join(path), "base\n").unwrap();
            }
            git(root, &["add", "."]);
            git(root, &["commit", "-qm", "base"]);
            for path in &paths {
                fs::write(root.join(path), "edit\n").unwrap();
            }
            test_metrics::take();
            let review = preview_discard(r, &paths).unwrap();
            assert_eq!(test_metrics::take(), (3, count, count * 5));
            let result = discard(r, &review, false).unwrap();
            assert_eq!(
                test_metrics::take(),
                (if count == 1 { 4 } else { 6 }, count, count * 5)
            );
            assert_eq!(result.completed_paths, paths);
            assert!(result.remaining_paths.is_empty());
            assert!(result.error.is_none());
            let info = crate::git::repository::resolve_repository(r).unwrap();
            crate::git::repository::load_repository_status_from_root(&info.root).unwrap();
            assert_eq!(test_metrics::take(), (2, 0, 0));
            for path in &paths {
                assert_eq!(fs::read_to_string(root.join(path)).unwrap(), "base\n");
            }
        }
    }

    #[test]
    fn discard_refuses_same_size_new_bytes_index_and_head_changes() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        base_file(root, "file.txt");
        fs::write(root.join("file.txt"), "first\n").unwrap();
        let review = preview_discard(r, &["file.txt".into()]).unwrap();
        fs::write(root.join("file.txt"), "later\n").unwrap();
        assert!(discard(r, &review, false).is_err());
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "later\n"
        );
        fs::write(root.join("file.txt"), "first\n").unwrap();
        git(root, &["add", "file.txt"]);
        fs::write(root.join("file.txt"), "later\n").unwrap();
        assert!(discard(r, &review, false).is_err());
        let review = preview_discard(r, &["file.txt".into()]).unwrap();
        git(root, &["commit", "--allow-empty", "-qm", "new HEAD"]);
        assert!(discard(r, &review, false).is_err());
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "later\n"
        );
    }

    #[test]
    fn filtered_discard_revalidates_later_tracked_files_and_never_replays() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        for path in ["first.txt", "next.txt"] {
            fs::write(root.join(path), "base\n").unwrap();
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(
            root.join(".gitattributes"),
            "first.txt filter=change-next\n",
        )
        .unwrap();
        git(
            root,
            &[
                "config",
                "filter.change-next.smudge",
                "cat; printf newer > next.txt",
            ],
        );
        for path in ["first.txt", "next.txt"] {
            fs::write(root.join(path), "edit\n").unwrap();
        }
        let review = preview_discard(r, &["first.txt".into(), "next.txt".into()]).unwrap();
        let result = discard(r, &review, false).unwrap();
        assert_eq!(result.completed_paths, ["first.txt"]);
        assert_eq!(result.remaining_paths, ["next.txt"]);
        assert!(result.error.unwrap().contains("changed"));
        assert_eq!(fs::read_to_string(root.join("next.txt")).unwrap(), "newer");
    }

    #[test]
    fn indexed_filter_attributes_cannot_be_hidden_by_worktree_attributes() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        fs::write(
            root.join(".gitattributes"),
            "first.txt filter=change-next\n",
        )
        .unwrap();
        for path in ["first.txt", "next.txt"] {
            fs::write(root.join(path), "base\n").unwrap();
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join(".gitattributes"), "first.txt -filter\n").unwrap();
        git(
            root,
            &[
                "config",
                "filter.change-next.smudge",
                "cat; printf newer > next.txt",
            ],
        );
        for path in ["first.txt", "next.txt"] {
            fs::write(root.join(path), "edit\n").unwrap();
        }
        // Restoring the attributes first enables the indexed filter even on
        // Git versions that otherwise consult the disabled worktree version.
        let paths = [".gitattributes".into(), "first.txt".into(), "next.txt".into()];
        assert!(prepare_discard(r, &paths, true).unwrap().filtered);
        let review = preview_discard(r, &paths).unwrap();
        let result = discard(r, &review, false).unwrap();
        assert_eq!(result.completed_paths, [".gitattributes", "first.txt"]);
        assert_eq!(result.remaining_paths, ["next.txt"]);
        assert!(result.error.unwrap().contains("changed"));
        assert_eq!(fs::read_to_string(root.join("next.txt")).unwrap(), "newer");
    }

    #[cfg(windows)]
    #[test]
    fn discard_batch_reports_partial_git_restore_failure_without_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        let paths = ["a.txt".to_string(), "b.txt".to_string()];
        for path in &paths {
            fs::write(root.join(path), "base\n").unwrap();
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        for path in &paths {
            fs::write(root.join(path), "edit\n").unwrap();
        }
        let review = preview_discard(r, &paths).unwrap();
        // Permit reading/writing, but refuse deletion while this handle lives.
        // Git can restore a.txt, then cannot unlink b.txt for checkout.
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(root.join("b.txt"))
            .unwrap();
        let result = discard(r, &review, false).unwrap();
        assert!(result.error.is_some());
        assert_eq!(result.completed_paths, ["a.txt"]);
        assert_eq!(result.remaining_paths, ["b.txt"]);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "base\n");
        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "edit\n");
        drop(held);
    }

    #[test]
    fn large_files_support_reviewed_hunk_staging_and_unstaging() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        let content = "const value = 42;\n".repeat(100_000);
        fs::write(root.join("large.ts"), &content).unwrap();
        for staged in [false, true] {
            let (diff, context) = load_working_tree_file_view(r, None, "large.ts", staged).unwrap();
            assert_eq!(diff.modified_content, content);
            let context = context.unwrap();
            let review = context.complete().unwrap();
            assert!(review.preview.patch.len() > 256 * 1024);
            assert_eq!(review.preview.hunks.len(), 1);
            apply_cached_hunks(&context, &review.preview.revision, &[0]).unwrap();
            if !staged { assert_eq!(git(root, &["show", ":large.ts"]), content); }
        }
        assert!(git(root, &["ls-files"]).is_empty());
        assert_eq!(fs::read_to_string(root.join("large.ts")).unwrap(), content);
    }

    #[test]
    fn generated_patches_preserve_long_lines_and_large_outputs() {
        let repo = repository();
        let root = repo.path();
        let content = format!("{}\n{}", "x".repeat(32_768), "const value = 42;\n".repeat(100_000));
        fs::write(root.join("large.ts"), &content).unwrap();
        let patch = GitCommand::run_diff(
            &["diff", "--no-index", "--", "/dev/null", "large.ts"], root,
        ).unwrap();
        assert!(patch.len() > 256 * 1024);
        assert!(patch.lines().count() > 100_000);
        assert!(patch.lines().any(|line| line.len() > 32_768));
    }
}
