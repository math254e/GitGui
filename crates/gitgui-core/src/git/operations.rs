use super::command::{GitCommand, GitError};
use std::path::Path;

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

pub fn fetch(root: &str) -> Result<(), GitError> {
    GitCommand::run(&["fetch", "--prune"], Some(Path::new(root))).map(|_| ())
}

pub fn pull(root: &str) -> Result<(), GitError> {
    GitCommand::run(&["pull"], Some(Path::new(root))).map(|_| ())
}

pub fn push(root: &str) -> Result<(), GitError> {
    GitCommand::run(&["push"], Some(Path::new(root))).map(|_| ())
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
}
