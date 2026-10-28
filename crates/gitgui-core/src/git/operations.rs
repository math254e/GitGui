use super::command::{git_command, GitCommand, GitError};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::Stdio,
};

pub fn init_repository(
    root: &str,
    initial_branch: Option<&str>,
    initialize_lfs: bool,
) -> Result<(), GitError> {
    let mut init_args = vec!["init".to_string()];
    if let Some(initial_branch) = initial_branch {
        init_args.push("--initial-branch".to_string());
        init_args.push(initial_branch.to_string());
    }
    GitCommand::run_owned(&init_args, Some(Path::new(root)))?;

    if initialize_lfs {
        GitCommand::run(&["lfs", "install", "--local"], Some(Path::new(root)))?;
    }

    Ok(())
}

pub fn stage(root: &str, paths: &[String]) -> Result<(), GitError> {
    let mut args = vec!["--literal-pathspecs".to_string(), "add".to_string()];
    if paths.is_empty() {
        args.push("--all".to_string());
    } else {
        args.push("--".to_string());
        args.extend(paths.iter().cloned());
    }
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

pub fn unstage(root: &str, paths: &[String]) -> Result<(), GitError> {
    let has_head =
        GitCommand::run(&["rev-parse", "--verify", "HEAD"], Some(Path::new(root))).is_ok();
    let mut args = if has_head {
        vec![
            "--literal-pathspecs".to_string(),
            "restore".to_string(),
            "--staged".to_string(),
            "--".to_string(),
        ]
    } else {
        vec![
            "--literal-pathspecs".to_string(),
            "rm".to_string(),
            "--cached".to_string(),
            "--force".to_string(),
            "-r".to_string(),
            "--".to_string(),
        ]
    };
    if paths.is_empty() {
        args.push(".".to_string());
    } else {
        args.extend(paths.iter().cloned());
    }
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

pub fn commit(root: &str, message: &str) -> Result<(), GitError> {
    GitCommand::run_with_stdin(
        &["commit", "--file=-"],
        Some(Path::new(root)),
        message.as_bytes(),
    )
    .map(|_| ())
}

pub fn fetch(root: &str) -> Result<super::tag_operations::TagFetchOutcome, GitError> {
    super::tag_operations::fetch(root)
}

pub fn pull(root: &str) -> Result<(), GitError> {
    GitCommand::run(&["pull"], Some(Path::new(root))).map(|_| ())
}

pub fn push(root: &str) -> Result<super::tag_operations::PushOutcome, GitError> {
    super::tag_operations::push(root)
}

pub fn list_local_branches(root: &str) -> Result<Vec<String>, GitError> {
    let output = GitCommand::run(
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        Some(Path::new(root)),
    )?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

pub fn validate_branch_name(root: &str, name: &str) -> Result<(), GitError> {
    GitCommand::run(
        &["check-ref-format", "--branch", name],
        Some(Path::new(root)),
    )
    .map(|_| ())
}

pub fn create_branch(
    root: &str,
    name: &str,
    start_point: Option<&str>,
    checkout: bool,
) -> Result<(), GitError> {
    validate_branch_name(root, name)?;
    let mut args = if checkout {
        vec![
            "switch".to_string(),
            "--create".to_string(),
            name.to_string(),
        ]
    } else {
        vec!["branch".to_string(), name.to_string()]
    };
    if let Some(start_point) = start_point {
        args.push(start_point.to_string());
    }
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

pub fn switch_branch(root: &str, name: &str, merge: bool) -> Result<(), GitError> {
    validate_branch_name(root, name)?;
    let mut args = vec!["switch".to_string()];
    if merge {
        args.push("--merge".to_string());
    }
    args.push(name.to_string());
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

/// Create a lightweight tag at the exact commit reviewed in the graph.
pub fn create_tag(root: &str, name: &str, target: &str) -> Result<(), GitError> {
    if !super::stash::is_oid(target) {
        return Err(tag_error("A tag target must be a full commit object ID"));
    }
    let reference = tag_reference(root, name)?;
    let kind = GitCommand::run(
        &["--no-replace-objects", "cat-file", "-t", target],
        Some(Path::new(root)),
    )?;
    if kind.trim() != "commit" {
        return Err(tag_error("A graph tag must point directly to a commit"));
    }
    change_tag_ref(
        root,
        &reference,
        &format!("create {reference} {target}"),
        "create",
    )
}

/// Delete the exact unpeeled tag object reviewed by the client, atomically.
pub fn delete_tag(root: &str, name: &str, expected_object_id: &str) -> Result<(), GitError> {
    if !super::stash::is_oid(expected_object_id) || expected_object_id.bytes().all(|b| b == b'0') {
        return Err(tag_error("The reviewed tag must have a full object ID"));
    }
    let reference = tag_reference(root, name)?;
    change_tag_ref(
        root,
        &reference,
        &format!("delete {reference} {expected_object_id}"),
        "delete",
    )
}

fn tag_error(message: &str) -> GitError {
    GitError {
        message: message.to_string(),
        stderr: String::new(),
        status: None,
    }
}

fn tag_reference(root: &str, name: &str) -> Result<String, GitError> {
    if name.is_empty() || name.starts_with('-') || name.len() > 1024 {
        return Err(tag_error("Invalid tag name"));
    }
    let reference = format!("refs/tags/{name}");
    GitCommand::run(&["check-ref-format", &reference], Some(Path::new(root)))?;
    Ok(reference)
}

fn change_tag_ref(
    root: &str,
    reference: &str,
    command: &str,
    operation: &str,
) -> Result<(), GitError> {
    change_tag_refs(root, &[reference.to_owned()], command, operation)
}

pub(super) fn change_tag_refs(
    root: &str,
    references: &[String],
    command: &str,
    operation: &str,
) -> Result<(), GitError> {
    let invalid = |message: &str| tag_error(&format!("Could not {operation} tag: {message}"));
    // Hold the ref lock while checking symbolic refs: Git treats a dangling
    // symref as absent even for a no-deref create. EOF aborts before any write.
    let mut child = git_command()
        .current_dir(root)
        .args(["update-ref", "--no-deref", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| invalid("could not start Git"))?;
    let result = (|| {
        let mut output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| invalid("Git output is unavailable"))?,
        );
        child
            .stdin
            .as_mut()
            .ok_or_else(|| invalid("Git input is unavailable"))?
            .write_all(format!("start\n{command}\nprepare\n").as_bytes())
            .map_err(|_| invalid("could not prepare the ref transaction"))?;
        for expected in ["start: ok\n", "prepare: ok\n"] {
            let mut line = String::new();
            output
                .read_line(&mut line)
                .map_err(|_| invalid("could not read Git progress"))?;
            if line != expected {
                return Err(invalid(
                    "the tag changed, already exists, or is locked. Refresh and try again.",
                ));
            }
        }
        if references.len() > 1 {
            // These batch replacements compare nonzero old IDs, so dangling
            // symrefs cannot pass prepare. Inspect other symrefs in one read.
            let refs = GitCommand::run(
                &[
                    "for-each-ref",
                    "--format=%(refname)%09%(symref)",
                    "refs/tags/",
                ],
                Some(Path::new(root)),
            )?;
            let names = references
                .iter()
                .map(String::as_str)
                .collect::<std::collections::HashSet<_>>();
            if refs
                .lines()
                .filter_map(|line| line.split_once('\t'))
                .any(|(name, target)| !target.is_empty() && names.contains(name))
            {
                return Err(invalid("symbolic tag refs cannot be modified"));
            }
        } else {
            for reference in references {
                match GitCommand::run(
                    &["symbolic-ref", "--quiet", "--no-recurse", reference],
                    Some(Path::new(root)),
                ) {
                    Ok(_) => return Err(invalid("symbolic tag refs cannot be modified")),
                    Err(error) if error.status == Some(1) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"commit\n")
            .map_err(|_| invalid("could not commit the ref transaction"))?;
        let mut line = String::new();
        output
            .read_line(&mut line)
            .map_err(|_| invalid("could not read Git progress"))?;
        if line != "commit: ok\n" {
            return Err(invalid("could not commit the ref transaction"));
        }
        Ok(())
    })();
    drop(child.stdin.take());
    let status = child.wait().map_err(|_| invalid("could not finish Git"))?;
    result?;
    if !status.success() {
        return Err(invalid("the ref transaction failed"));
    }
    Ok(())
}

fn branch_error(message: &str) -> GitError {
    GitError {
        message: message.to_string(),
        stderr: String::new(),
        status: None,
    }
}

/// Use a literal full ref: `check-ref-format --branch` accepts checkout aliases
/// such as @{-1}, which must never retarget a reviewed rename or deletion.
pub(super) fn reviewed_branch(
    root: &str,
    name: &str,
    expected_target: &str,
) -> Result<String, GitError> {
    let reference = format!("refs/heads/{name}");
    if name.starts_with('-') {
        return Err(branch_error("Invalid local branch name"));
    }
    GitCommand::run(&["check-ref-format", &reference], Some(Path::new(root)))?;
    let target = GitCommand::run(
        &["rev-parse", "--verify", &reference],
        Some(Path::new(root)),
    )?;
    if target.trim() != expected_target {
        return Err(branch_error(
            "This branch changed. Close the dialog and review it again.",
        ));
    }
    Ok(reference)
}

pub fn rename_branch(
    root: &str,
    name: &str,
    new_name: &str,
    expected_target: &str,
) -> Result<(), GitError> {
    reviewed_branch(root, name, expected_target)?;
    // Validate the literal destination as well; never overwrite an existing ref.
    if new_name.starts_with('-') {
        return Err(branch_error("Invalid local branch name"));
    }
    GitCommand::run(
        &["check-ref-format", &format!("refs/heads/{new_name}")],
        Some(Path::new(root)),
    )?;
    GitCommand::run(
        &["branch", "--move", "--", name, new_name],
        Some(Path::new(root)),
    )
    .map(|_| ())
}

#[derive(Debug, PartialEq, Eq)]
pub enum BranchDeleteOutcome {
    Deleted,
    NotMerged,
}

pub fn delete_branch(
    root: &str,
    name: &str,
    expected_target: &str,
    force: bool,
) -> Result<BranchDeleteOutcome, GitError> {
    let reference = reviewed_branch(root, name, expected_target)?;
    let cwd = Some(Path::new(root));
    let worktrees = GitCommand::run(&["worktree", "list", "--porcelain"], cwd)?;
    if worktrees
        .lines()
        .any(|line| line.strip_prefix("branch ") == Some(reference.as_str()))
    {
        return Err(branch_error("This branch is checked out in a worktree. Switch that worktree to another branch first."));
    }
    if !force && !branch_is_merged(root, &reference)? {
        return Ok(BranchDeleteOutcome::NotMerged);
    }
    GitCommand::run(
        &["branch", if force { "-D" } else { "-d" }, "--", name],
        cwd,
    )?;
    Ok(BranchDeleteOutcome::Deleted)
}

pub(super) fn branch_is_merged(root: &str, reference: &str) -> Result<bool, GitError> {
    // Match Git's safe-delete rule: the resolved upstream, otherwise HEAD.
    // Exit status, rather than translated stderr, identifies ancestry.
    let cwd = Some(Path::new(root));
    let upstream = GitCommand::run(&["for-each-ref", "--format=%(upstream)", reference], cwd)?;
    let upstream = upstream.trim();
    let base = if !upstream.is_empty()
        && GitCommand::run(
            &["rev-parse", "--verify", &format!("{upstream}^{{commit}}")],
            cwd,
        )
        .is_ok()
    {
        upstream
    } else {
        "HEAD"
    };
    match GitCommand::run(&["merge-base", "--is-ancestor", reference, base], cwd) {
        Ok(_) => Ok(true),
        Err(error) if error.status == Some(1) => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn stash_push(
    root: &str,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<(), GitError> {
    let mut args = vec!["stash".to_string(), "push".to_string()];
    if include_untracked {
        args.push("--include-untracked".to_string());
    }
    if let Some(message) = message {
        args.push("--message".to_string());
        args.push(message.to_string());
    }
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

pub fn stash_pop(root: &str) -> Result<(), GitError> {
    GitCommand::run(&["stash", "pop"], Some(Path::new(root))).map(|_| ())
}

#[cfg(test)]
mod branch_tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) -> String {
        GitCommand::run(args, Some(root))
            .unwrap()
            .trim()
            .to_string()
    }

    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        git(dir.path(), &["config", "user.name", "GitGui Test"]);
        git(dir.path(), &["config", "user.email", "test@example.com"]);
        git(dir.path(), &["config", "core.autocrlf", "false"]);
        git(dir.path(), &["commit", "--allow-empty", "-qm", "base"]);
        dir
    }

    #[test]
    fn rename_preserves_tip_and_upstream_and_refuses_existing_names() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        git(repo.path(), &["branch", "feature/old"]);
        git(
            repo.path(),
            &["branch", "--set-upstream-to=main", "feature/old"],
        );
        let tip = git(repo.path(), &["rev-parse", "HEAD"]);
        rename_branch(root, "feature/old", "feature/ny-æøå", &tip).unwrap();
        assert_eq!(git(repo.path(), &["rev-parse", "feature/ny-æøå"]), tip);
        assert_eq!(
            git(repo.path(), &["config", "branch.feature/ny-æøå.merge"]),
            "refs/heads/main"
        );
        assert!(rename_branch(root, "feature/ny-æøå", "main", &tip).is_err());
        assert_eq!(git(repo.path(), &["rev-parse", "main"]), tip);
        rename_branch(root, "main", "renamed-main", &tip).unwrap();
        assert_eq!(
            git(repo.path(), &["branch", "--show-current"]),
            "renamed-main"
        );
    }

    #[test]
    fn delete_requires_separate_force_for_unmerged_commits() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        git(repo.path(), &["switch", "-c", "feature/unmerged"]);
        git(repo.path(), &["commit", "--allow-empty", "-qm", "unmerged"]);
        let tip = git(repo.path(), &["rev-parse", "HEAD"]);
        git(repo.path(), &["switch", "main"]);
        assert_eq!(
            delete_branch(root, "feature/unmerged", &tip, false).unwrap(),
            BranchDeleteOutcome::NotMerged
        );
        assert_eq!(git(repo.path(), &["rev-parse", "feature/unmerged"]), tip);
        assert_eq!(
            delete_branch(root, "feature/unmerged", &tip, true).unwrap(),
            BranchDeleteOutcome::Deleted
        );
        assert!(GitCommand::run(
            &["show-ref", "--verify", "refs/heads/feature/unmerged"],
            Some(repo.path())
        )
        .is_err());
        let main = git(repo.path(), &["rev-parse", "main"]);
        git(repo.path(), &["branch", "merged"]);
        assert_eq!(
            delete_branch(root, "merged", &main, false).unwrap(),
            BranchDeleteOutcome::Deleted
        );
    }

    #[test]
    fn deletion_matches_git_upstream_merge_rules() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        git(repo.path(), &["switch", "-c", "feature"]);
        git(repo.path(), &["commit", "--allow-empty", "-qm", "new"]);
        let tip = git(repo.path(), &["rev-parse", "HEAD"]);
        git(repo.path(), &["branch", "published"]);
        git(repo.path(), &["branch", "--set-upstream-to=published"]);
        git(repo.path(), &["switch", "main"]);
        assert_eq!(
            delete_branch(root, "feature", &tip, false).unwrap(),
            BranchDeleteOutcome::Deleted
        );
        git(repo.path(), &["branch", "feature", &tip]);
        git(repo.path(), &["config", "branch.feature.remote", "."]);
        git(
            repo.path(),
            &["config", "branch.feature.merge", "refs/heads/missing"],
        );
        assert_eq!(
            delete_branch(root, "feature", &tip, false).unwrap(),
            BranchDeleteOutcome::NotMerged
        );
    }

    #[test]
    fn reviewed_actions_reject_stale_tips_aliases_and_invalid_names() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        let old = git(repo.path(), &["rev-parse", "HEAD"]);
        git(repo.path(), &["branch", "feature"]);
        git(repo.path(), &["commit", "--allow-empty", "-qm", "next"]);
        git(repo.path(), &["branch", "-f", "feature", "HEAD"]);
        assert!(rename_branch(root, "feature", "renamed", &old).is_err());
        assert!(delete_branch(root, "feature", &old, true).is_err());
        let tip = git(repo.path(), &["rev-parse", "feature"]);
        for name in [
            "@{-1}",
            "--all",
            "refs/remotes/origin/main",
            "bad..name",
            "bad name",
        ] {
            assert!(delete_branch(root, name, &tip, true).is_err());
        }
        assert!(rename_branch(root, "feature", "bad..name", &tip).is_err());
        assert_eq!(git(repo.path(), &["rev-parse", "feature"]), tip);
    }

    #[test]
    fn checked_out_branches_cannot_be_deleted_even_with_force() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        let tip = git(repo.path(), &["rev-parse", "HEAD"]);
        assert!(delete_branch(root, "main", &tip, true).is_err());
        let linked = tempfile::tempdir().unwrap();
        let linked_path = linked.path().join("linked");
        git(
            repo.path(),
            &[
                "worktree",
                "add",
                "-b",
                "linked",
                linked_path.to_str().unwrap(),
            ],
        );
        for force in [false, true] {
            assert!(delete_branch(root, "linked", &tip, force).is_err());
        }
        assert_eq!(git(repo.path(), &["rev-parse", "linked"]), tip);
    }

    #[test]
    fn create_from_commit_respects_checkout_and_preserves_dirty_changes() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        let base = git(repo.path(), &["rev-parse", "HEAD"]);
        git(repo.path(), &["commit", "--allow-empty", "-qm", "next"]);
        std::fs::write(repo.path().join("untracked.txt"), "keep me").unwrap();
        create_branch(root, "from-base", Some(&base), false).unwrap();
        assert_eq!(git(repo.path(), &["rev-parse", "from-base"]), base);
        assert_eq!(git(repo.path(), &["branch", "--show-current"]), "main");
        create_branch(root, "checkout-base", Some(&base), true).unwrap();
        assert_eq!(
            git(repo.path(), &["branch", "--show-current"]),
            "checkout-base"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("untracked.txt")).unwrap(),
            "keep me"
        );
        assert!(create_branch(root, "from-base", Some(&base), true).is_err());
        assert!(create_branch(root, "bad..name", Some(&base), false).is_err());
    }

    #[test]
    fn create_tag_uses_reviewed_commit_without_signing_checkout_or_overwrite() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        let base = git(repo.path(), &["rev-parse", "HEAD"]);
        git(repo.path(), &["commit", "--allow-empty", "-qm", "next"]);
        let head = git(repo.path(), &["rev-parse", "HEAD"]);
        std::fs::write(repo.path().join("dirty file.txt"), "keep me").unwrap();
        let status = git(repo.path(), &["status", "--porcelain"]);
        git(repo.path(), &["config", "tag.gpgSign", "true"]);
        create_tag(root, "releases/v1.0.0", &base).unwrap();
        assert_eq!(
            git(repo.path(), &["rev-parse", "refs/tags/releases/v1.0.0"]),
            base
        );
        assert_eq!(
            git(
                repo.path(),
                &["cat-file", "-t", "refs/tags/releases/v1.0.0"]
            ),
            "commit"
        );
        assert_eq!(git(repo.path(), &["rev-parse", "HEAD"]), head);
        assert_eq!(git(repo.path(), &["branch", "--show-current"]), "main");
        assert_eq!(git(repo.path(), &["status", "--porcelain"]), status);
        assert!(create_tag(root, "releases/v1.0.0", &head).is_err());
        assert_eq!(
            git(repo.path(), &["rev-parse", "refs/tags/releases/v1.0.0"]),
            base
        );
    }

    #[test]
    fn delete_tag_handles_lightweight_annotated_nested_and_non_commit_tags() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        let head = git(repo.path(), &["rev-parse", "HEAD"]);
        git(repo.path(), &["config", "tag.gpgSign", "false"]);
        create_tag(root, "lightweight", &head).unwrap();
        git(
            repo.path(),
            &["tag", "-a", "annotated", "-m", "release", &head],
        );
        git(
            repo.path(),
            &[
                "tag",
                "-a",
                "nested",
                "-m",
                "nested release",
                "refs/tags/annotated",
            ],
        );
        let tree = git(repo.path(), &["rev-parse", "HEAD^{tree}"]);
        git(repo.path(), &["tag", "tree", &tree]);
        let blob = GitCommand::run_with_stdin(
            &["hash-object", "-w", "--stdin"],
            Some(repo.path()),
            b"blob tag",
        )
        .unwrap();
        git(repo.path(), &["tag", "blob", blob.trim()]);
        std::fs::write(repo.path().join("local.txt"), "keep me").unwrap();
        let status = git(repo.path(), &["status", "--porcelain"]);
        for name in ["nested", "annotated", "lightweight", "tree", "blob"] {
            let reference = format!("refs/tags/{name}");
            let object = git(repo.path(), &["rev-parse", &reference]);
            delete_tag(root, name, &object).unwrap();
            assert!(
                GitCommand::run(&["show-ref", "--verify", &reference], Some(repo.path())).is_err()
            );
        }
        assert_eq!(git(repo.path(), &["rev-parse", "HEAD"]), head);
        assert_eq!(git(repo.path(), &["status", "--porcelain"]), status);
        assert_eq!(git(repo.path(), &["branch", "--show-current"]), "main");
    }

    #[test]
    fn delete_tag_rejects_replaced_annotations_stale_targets_and_symbolic_refs() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        let head = git(repo.path(), &["rev-parse", "HEAD"]);
        git(repo.path(), &["config", "tag.gpgSign", "false"]);
        git(repo.path(), &["tag", "-a", "reviewed", "-m", "old", &head]);
        let reviewed = git(repo.path(), &["rev-parse", "refs/tags/reviewed"]);
        git(
            repo.path(),
            &["tag", "-f", "-a", "reviewed", "-m", "new", &head],
        );
        let replacement = git(repo.path(), &["rev-parse", "refs/tags/reviewed"]);
        assert_ne!(replacement, reviewed);
        for expected in [&reviewed, &head, "HEAD", &"0".repeat(40)] {
            assert!(delete_tag(root, "reviewed", expected).is_err());
            assert_eq!(
                git(repo.path(), &["rev-parse", "refs/tags/reviewed"]),
                replacement
            );
        }
        for destination in ["refs/heads/main", "refs/heads/missing"] {
            git(
                repo.path(),
                &["symbolic-ref", "refs/tags/alias", destination],
            );
            assert!(delete_tag(root, "alias", &head).is_err());
            assert_eq!(
                git(
                    repo.path(),
                    &["symbolic-ref", "--no-recurse", "refs/tags/alias"]
                ),
                destination
            );
        }
        for name in ["--all", "../heads/main", "bad name"] {
            assert!(delete_tag(root, name, &head).is_err());
        }
        assert_eq!(git(repo.path(), &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn create_tag_rejects_invalid_names_refs_and_non_commit_objects() {
        let repo = repository();
        let root = repo.path().to_str().unwrap();
        let head = git(repo.path(), &["rev-parse", "HEAD"]);
        for name in [
            "",
            "--force",
            "bad..name",
            "bad name",
            "bad\nname",
            "bad.lock",
            "../heads/main",
        ] {
            assert!(create_tag(root, name, &head).is_err(), "{name:?}");
        }
        let tree = git(repo.path(), &["rev-parse", "HEAD^{tree}"]);
        for target in ["HEAD", &head[..8], &"f".repeat(40), &tree] {
            assert!(
                create_tag(root, "invalid-target", target).is_err(),
                "{target}"
            );
        }
        assert_eq!(git(repo.path(), &["tag", "--list"]), "");
        for destination in ["refs/heads/main", "refs/heads/missing"] {
            git(
                repo.path(),
                &["symbolic-ref", "refs/tags/alias", destination],
            );
            assert!(create_tag(root, "alias", &head).is_err());
            assert_eq!(
                git(
                    repo.path(),
                    &["symbolic-ref", "--no-recurse", "refs/tags/alias"]
                ),
                destination
            );
        }
        assert!(GitCommand::run(
            &["show-ref", "--verify", "refs/heads/missing"],
            Some(repo.path())
        )
        .is_err());
    }


}
