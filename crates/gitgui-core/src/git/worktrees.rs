//! Reviewed removal of registered linked worktrees. Git authorizes removal;
//! native cleanup completes partial filesystem deletion after unregistration.
//! Branch force never implies permission to discard worktree contents.
use super::{
    command::{GitCommand, GitError},
    operations::{branch_is_merged, delete_branch, reviewed_branch, BranchDeleteOutcome},
};
use std::{fs, io, path::Path, thread, time::Duration};

#[derive(Debug)]
pub enum RemoveOutcome {
    NotMerged,
    Removed {
        branch_deleted: bool,
        warning: Option<String>,
    },
}

fn invalid(message: &str) -> GitError {
    GitError {
        message: message.to_string(),
        stderr: String::new(),
        status: None,
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions are reparse points too, even when not reported as symlinks.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(windows)]
fn prepare_junctions_for_removal(target: &Path) -> Result<(), GitError> {
    use std::{collections::HashSet, os::windows::fs::MetadataExt};

    let filesystem_error =
        |error: io::Error| invalid(&format!("Could not prepare worktree removal: {error}"));
    let mut directories = vec![target.to_path_buf()];
    let mut junctions = Vec::new();
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory).map_err(filesystem_error)? {
            let entry = entry.map_err(filesystem_error)?;
            if entry.file_name() == ".git" {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(filesystem_error)?;
            if is_link(&metadata) {
                // Directory junctions can report as symlinks in Rust while
                // Git follows them as directories. Handle every directory
                // reparse point without opening or traversing its target.
                if metadata.file_attributes() & 0x10 != 0 {
                    let path = entry.path();
                    let relative = path
                        .strip_prefix(target)
                        .ok()
                        .and_then(Path::to_str)
                        .ok_or_else(|| {
                            invalid("The worktree contains an unsupported junction path.")
                        })?
                        .replace('\\', "/");
                    junctions.push((path, relative));
                }
            } else if metadata.is_dir() {
                directories.push(entry.path());
            }
        }
    }
    if junctions.is_empty() {
        return Ok(());
    }
    // Check before changing even ignored links. Git repeats its own clean,
    // registration, lock, and submodule checks in the subsequent removal.
    let status = GitCommand::run(
        &[
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
        Some(target),
    )?;
    if !status.is_empty() {
        return Err(invalid("This worktree contains modified or untracked files. Commit or stash them before removing it."));
    }
    let index = GitCommand::run(&["ls-files", "--stage", "-z"], Some(target))?;
    let git_dir = GitCommand::run(&["rev-parse", "--absolute-git-dir"], Some(target))?;
    if index.split('\0').any(|entry| entry.starts_with("160000 "))
        || Path::new(git_dir.trim()).join("modules").is_dir()
    {
        // Avoid changing links in submodules or handing their junctions to
        // Git's unsafe directory walk, including uninitialized gitlinks.
        return Err(invalid("Worktrees containing submodules and directory links cannot be removed. Remove the submodules before removing this worktree."));
    }
    let mut input = Vec::new();
    for (_, relative) in &junctions {
        input.extend_from_slice(relative.as_bytes());
        input.push(0);
    }
    let ignored = match GitCommand::run_with_stdin(
        &["check-ignore", "--stdin", "-z"],
        Some(target),
        &input,
    ) {
        Ok(output) => output,
        Err(error) if error.status == Some(1) => String::new(),
        Err(error) => return Err(error),
    };
    let ignored: HashSet<_> = ignored
        .split('\0')
        .filter(|path| !path.is_empty())
        .collect();
    if junctions
        .iter()
        .any(|(_, relative)| !ignored.contains(relative.as_str()))
    {
        return Err(invalid("This worktree contains a junction that is not ignored by Git. Remove that link before removing the worktree."));
    }
    for (path, _) in junctions {
        let parent = path
            .parent()
            .ok_or_else(|| invalid("Invalid worktree junction path."))?;
        let metadata = fs::symlink_metadata(&path).map_err(filesystem_error)?;
        if !is_link(&metadata)
            || metadata.file_attributes() & 0x10 == 0
            || !fs::canonicalize(parent)
                .map_err(filesystem_error)?
                .starts_with(target)
        {
            return Err(invalid(
                "A worktree junction changed. Review the worktree before removing it.",
            ));
        }
        // RemoveDirectoryW unlinks the junction itself, never its target.
        fs::remove_dir(&path).map_err(filesystem_error)?;
    }
    Ok(())
}

fn finish_directory_removal(path: &Path, reviewed_target: &Path) -> io::Result<()> {
    for attempt in 0..3 {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if is_link(&metadata) || fs::canonicalize(path)? != reviewed_target {
            return Err(io::Error::other("The worktree directory was replaced."));
        }
        match fs::symlink_metadata(path.join(".git")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
            Ok(_) => return Err(io::Error::other("The folder still contains Git metadata.")),
        }
        // Native removal handles dangling junctions without following their
        // targets after Git's recursive directory walk could not finish.
        match fs::remove_dir_all(reviewed_target) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error)
                if attempt < 2
                    && matches!(
                        error.kind(),
                        io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::PermissionDenied
                    ) =>
            {
                thread::sleep(Duration::from_millis(100 * (attempt + 1)));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

pub fn remove(
    root: &str,
    path: &str,
    expected_head: &str,
    expected_branch: Option<&str>,
    delete_branch_after: bool,
    force_branch: bool,
) -> Result<RemoveOutcome, GitError> {
    let target = fs::canonicalize(path).map_err(|_| {
        invalid("This worktree is no longer available. Review the worktree list again.")
    })?;
    let current =
        fs::canonicalize(root).map_err(|_| invalid("The repository is no longer available."))?;
    if target == current {
        return Err(invalid(
            "Switch to another worktree before removing this one.",
        ));
    }
    if is_link(
        &fs::symlink_metadata(path)
            .map_err(|_| invalid("The worktree path could not be checked."))?,
    ) {
        return Err(invalid(
            "Refusing to remove a worktree through a symbolic link.",
        ));
    }
    // NUL framing preserves spaces, newlines, and Git's unquoted path bytes.
    let listing = GitCommand::run(
        &["worktree", "list", "--porcelain", "-z"],
        Some(Path::new(root)),
    )?;
    let mut registered = None;
    for (index, record) in listing.split("\0\0").enumerate() {
        let fields: Vec<_> = record.split('\0').collect();
        let Some(registered_path) = fields
            .first()
            .and_then(|field| field.strip_prefix("worktree "))
        else {
            continue;
        };
        if fs::canonicalize(registered_path).ok().as_ref() != Some(&target) {
            continue;
        }
        if index == 0 {
            return Err(invalid("The main worktree cannot be removed."));
        }
        if fields
            .iter()
            .any(|field| *field == "locked" || field.starts_with("locked "))
        {
            return Err(invalid(
                "This worktree is locked. Unlock it before removing it.",
            ));
        }
        registered = Some((
            fields.iter().find_map(|field| field.strip_prefix("HEAD ")),
            fields
                .iter()
                .find_map(|field| field.strip_prefix("branch refs/heads/")),
            registered_path,
        ));
        break;
    }
    let Some((head, branch, registered_path)) = registered else {
        return Err(invalid(
            "This path is not a registered linked worktree of this repository.",
        ));
    };
    if head != Some(expected_head) || branch != expected_branch {
        return Err(invalid(
            "This worktree changed. Close the dialog and review it again.",
        ));
    }
    if delete_branch_after {
        let name = branch.ok_or_else(|| invalid("A detached worktree has no branch to delete."))?;
        let reference = reviewed_branch(root, name, expected_head)?;
        if !force_branch && !branch_is_merged(root, &reference)? {
            return Ok(RemoveOutcome::NotMerged);
        }
    }
    #[cfg(windows)]
    prepare_junctions_for_removal(&target)?;
    // No --force: Git refuses modified/untracked files, locked worktrees, and
    // submodule cases that require force even after branch force was confirmed.
    if let Err(error) = GitCommand::run(&["worktree", "remove", "--", path], Some(Path::new(root)))
    {
        // Git removes its registration even when directory deletion fails.
        // Finish only the already-reviewed directory once Git accepted removal
        // and unregistered it. Dirty/locked-worktree refusals never reach this.
        let unregistered = GitCommand::run(
            &["worktree", "list", "--porcelain", "-z"],
            Some(Path::new(root)),
        )
        .map(|listing| {
            !listing.split("\0\0").any(|record| {
                record
                    .split('\0')
                    .next()
                    .and_then(|field| field.strip_prefix("worktree "))
                    == Some(registered_path)
            })
        })
        .unwrap_or(false);
        if !unregistered {
            return Err(error);
        }
        if let Err(cleanup_error) = finish_directory_removal(Path::new(path), &target) {
            let branch_note = if branch.is_some() {
                " The branch was kept."
            } else {
                ""
            };
            return Ok(RemoveOutcome::Removed {
                branch_deleted: false,
                warning: Some(format!(
                    "Git unregistered the worktree, but filesystem cleanup did not finish at {path}.{branch_note} Close apps using this folder and review the remaining files before deleting it. {}",
                    cleanup_error
                ).trim().to_string()),
            });
        }
    }
    if !delete_branch_after {
        return Ok(RemoveOutcome::Removed {
            branch_deleted: false,
            warning: None,
        });
    }
    match delete_branch(root, branch.unwrap(), expected_head, force_branch) {
        Ok(BranchDeleteOutcome::Deleted) => Ok(RemoveOutcome::Removed { branch_deleted: true, warning: None }),
        Ok(BranchDeleteOutcome::NotMerged) => Ok(RemoveOutcome::Removed {
            branch_deleted: false,
            warning: Some("Worktree removed; branch kept because its merge state changed. Review the branch before deleting it.".to_string()),
        }),
        Err(error) => Ok(RemoveOutcome::Removed {
            branch_deleted: false,
            warning: Some(format!("Worktree removed; branch deletion failed: {} {}", error.message, error.stderr).trim().to_string()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) -> String {
        GitCommand::run(args, Some(root))
            .unwrap()
            .trim()
            .to_string()
    }

    fn setup() -> (tempfile::TempDir, String, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.name", "Worktree Test"]);
        git(&root, &["config", "user.email", "worktree@example.test"]);
        git(&root, &["commit", "--allow-empty", "-qm", "base"]);
        let path = dir.path().join("linked tree [æ]");
        git(
            &root,
            &["worktree", "add", "-b", "feature", path.to_str().unwrap()],
        );
        let head = git(&root, &["rev-parse", "HEAD"]);
        (
            dir,
            root.to_str().unwrap().to_string(),
            path.to_str().unwrap().to_string(),
            head,
        )
    }

    #[test]
    fn remove_keeps_branch_unless_explicitly_selected() {
        for delete in [false, true] {
            let (_dir, root, path, head) = setup();
            let outcome = remove(&root, &path, &head, Some("feature"), delete, false).unwrap();
            assert!(
                matches!(outcome, RemoveOutcome::Removed { branch_deleted, warning: None } if branch_deleted == delete)
            );
            assert!(!Path::new(&path).exists());
            assert!(Path::new(&root).exists());
            assert_eq!(
                GitCommand::run(
                    &["show-ref", "--verify", "refs/heads/feature"],
                    Some(Path::new(&root))
                )
                .is_ok(),
                !delete
            );
        }
    }

    #[test]
    fn unmerged_confirmation_precedes_removal_and_branch_force_never_discards_files() {
        let (_dir, root, path, _) = setup();
        git(
            Path::new(&path),
            &["commit", "--allow-empty", "-qm", "unmerged"],
        );
        let head = git(Path::new(&path), &["rev-parse", "HEAD"]);
        assert!(matches!(
            remove(&root, &path, &head, Some("feature"), true, false).unwrap(),
            RemoveOutcome::NotMerged
        ));
        assert!(Path::new(&path).exists());
        let untracked = Path::new(&path).join("keep.txt");
        fs::write(&untracked, "keep me").unwrap();
        assert!(remove(&root, &path, &head, Some("feature"), true, true).is_err());
        assert_eq!(fs::read_to_string(&untracked).unwrap(), "keep me");
        fs::remove_file(&untracked).unwrap();
        assert!(matches!(
            remove(&root, &path, &head, Some("feature"), true, true).unwrap(),
            RemoveOutcome::Removed {
                branch_deleted: true,
                warning: None
            }
        ));
    }

    #[test]
    fn protected_worktrees_and_changed_reviews_cannot_be_removed() {
        let (_dir, root, path, head) = setup();
        assert!(remove(&root, &root, &head, Some("main"), false, false).is_err());
        assert!(remove(&path, &root, &head, Some("main"), false, false).is_err());
        assert!(remove(&root, &path, &"0".repeat(40), Some("feature"), false, false).is_err());
        assert!(remove(&root, &path, &head, Some("other"), false, false).is_err());
        git(Path::new(&root), &["worktree", "lock", &path]);
        assert!(remove(&root, &path, &head, Some("feature"), true, true).is_err());
        assert!(Path::new(&path).exists());
    }

    #[test]
    fn unrelated_paths_and_detached_branch_deletion_are_rejected() {
        let (dir, root, path, head) = setup();
        let outside = dir.path().join("unrelated");
        fs::create_dir(&outside).unwrap();
        assert!(remove(&root, outside.to_str().unwrap(), &head, None, false, false).is_err());
        assert!(outside.exists());
        git(Path::new(&path), &["switch", "--detach"]);
        assert!(remove(&root, &path, &head, None, true, true).is_err());
        assert!(matches!(
            remove(&root, &path, &head, None, false, false).unwrap(),
            RemoveOutcome::Removed {
                branch_deleted: false,
                warning: None
            }
        ));
    }

    #[test]
    fn branch_failure_after_removal_reports_partial_success() {
        let (_dir, root, path, head) = setup();
        let hook = Path::new(&root).join(".git/hooks/reference-transaction");
        fs::write(&hook, "#!/bin/sh\nwhile read old new ref; do\n  if [ \"$ref\" = refs/heads/feature ] && [ \"$new\" = 0000000000000000000000000000000000000000 ]; then exit 1; fi\ndone\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let outcome = remove(&root, &path, &head, Some("feature"), true, false).unwrap();
        assert!(matches!(
            outcome,
            RemoveOutcome::Removed {
                branch_deleted: false,
                warning: Some(_)
            }
        ));
        assert!(!Path::new(&path).exists());
        assert_eq!(git(Path::new(&root), &["rev-parse", "feature"]), head);
    }
}
