//! Reviewed working-tree mutations. Git owns patch generation and application;
//! clients send hunk indices and fingerprints, never executable patches.
use super::{
    command::{GitCommand, GitError},
    repository::load_repository_status,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
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
fn safe_path(root: &Path, path: &str) -> Result<(), GitError> {
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
    let mut hash = Sha256::new();
    hash.update(
        GitCommand::run(&["rev-parse", "--verify", "HEAD"], Some(root)).unwrap_or_default(),
    );
    hash.update([0]);
    hash.update(index_entry(root, path)?);
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
            loop {
                let count = file.read(&mut buffer).map_err(|e| error(e.to_string()))?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
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
    let root_path = Path::new(root);
    let revision_before = revision(root_path, path)?;
    let status = load_repository_status(root)?.status;
    let file = status
        .changed_files
        .iter()
        .find(|f| f.path == path)
        .ok_or_else(|| error("File has no changes; refresh the diff"))?;
    let entry = index_entry(root_path, path)?;
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
        || entry.lines().any(|l| {
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
            "--binary",
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
    if revision_before != revision(root_path, path)? {
        return Err(error(
            "File changed while loading its diff; refresh and review again",
        ));
    }
    let mut hash = Sha256::new();
    hash.update(revision_before);
    hash.update(patch.as_bytes());
    Ok(HunkPreview {
        file_path: path.to_string(),
        staged,
        revision: format!("{:x}", hash.finalize()),
        patch,
        hunks,
        unavailable_reason: unavailable,
    })
}

pub fn apply_hunks(
    root: &str,
    path: &str,
    staged: bool,
    expected_revision: &str,
    ids: &[u32],
) -> Result<(), GitError> {
    let preview = preview_hunks(root, path, staged)?;
    if preview.revision != expected_revision {
        return Err(error("Selected hunks changed; refresh and review again"));
    }
    if let Some(reason) = preview.unavailable_reason {
        return Err(error(reason));
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
    if staged {
        args.push("--reverse");
    }
    let mut check = args.clone();
    check.push("--check");
    GitCommand::run_with_stdin(&check, Some(Path::new(root)), patch.as_bytes())?;
    GitCommand::run_with_stdin(&args, Some(Path::new(root)), patch.as_bytes()).map(|_| ())
}

pub fn preview_discard(root: &str, paths: &[String]) -> Result<Vec<DiscardFile>, GitError> {
    if paths.is_empty() {
        return Err(error("Discard requires explicit file paths"));
    }
    let status = load_repository_status(root)?.status;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for path in paths {
        if !seen.insert(path) {
            return Err(error("Duplicate discard path"));
        }
        let file = status
            .changed_files
            .iter()
            .find(|f| &f.path == path)
            .ok_or_else(|| error(format!("{path}: no unstaged changes; refresh")))?;
        let entry = index_entry(Path::new(root), path)?;
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
        files.push(DiscardFile {
            path: path.clone(),
            untracked: file.index_status == "?",
            revision: revision(Path::new(root), path)?,
        });
    }
    Ok(files)
}

pub fn discard(
    root: &str,
    expected: &[DiscardFile],
    delete_untracked: bool,
) -> Result<DiscardOutcome, GitError> {
    let paths = expected.iter().map(|f| f.path.clone()).collect::<Vec<_>>();
    let current = preview_discard(root, &paths)?;
    for (old, new) in expected.iter().zip(&current) {
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
    let mut completed = Vec::new();
    for (i, file) in current.iter().enumerate() {
        // Check again immediately before touching each target, since external
        // editors and Git processes do not participate in the server lock.
        let result = revision(Path::new(root), &file.path).and_then(|r| {
            if r != file.revision {
                return Err(error("File changed during discard"));
            }
            if file.untracked {
                fs::remove_file(Path::new(root).join(&file.path)).map_err(|e| error(e.to_string()))
            } else {
                GitCommand::run(
                    &[
                        "--literal-pathspecs",
                        "restore",
                        "--worktree",
                        "--",
                        &file.path,
                    ],
                    Some(Path::new(root)),
                )
                .map(|_| ())
            }
        });
        if let Err(e) = result {
            return Ok(DiscardOutcome {
                completed_paths: completed,
                remaining_paths: paths[i..].to_vec(),
                error: Some(format!("{}: {} {}", file.path, e.message, e.stderr)),
            });
        }
        completed.push(file.path.clone());
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
        let p = preview_hunks(r, "crlf.txt", false).unwrap();
        apply_hunks(r, "crlf.txt", false, &p.revision, &[0]).unwrap();
        assert_eq!(git(root, &["show", ":crlf.txt"]), "after\nlast");
        assert_eq!(fs::read(root.join("crlf.txt")).unwrap(), b"after\r\nlast");
    }

    #[test]
    fn discard_and_stage_treat_unusual_paths_as_literal_file_names() {
        let repo = repository();
        let root = repo.path();
        let r = root.to_str().unwrap();
        for name in [" spaced .txt ", "*.txt", "-option.txt"] {
            fs::write(root.join(name), "base\n").unwrap();
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "base"]);
        for name in [" spaced .txt ", "*.txt", "-option.txt"] {
            fs::write(root.join(name), "changed\n").unwrap();
        }
        let p = preview_hunks(r, "*.txt", false).unwrap();
        apply_hunks(r, "*.txt", false, &p.revision, &[0]).unwrap();
        assert_eq!(git(root, &["show", ":-option.txt"]), "base\n");
        let p = preview_discard(r, &[" spaced .txt ".into(), "-option.txt".into()]).unwrap();
        discard(r, &p, false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(" spaced .txt ")).unwrap(),
            "base\n"
        );
        assert_eq!(fs::read_to_string(root.join("*.txt")).unwrap(), "changed\n");
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

    #[cfg(unix)]
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
}
