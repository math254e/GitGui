use gitgui_core::git::{
    command::git_command,
    integration::{
        inspect, push_rewrite, recover, review, review_rewrite_push, start, IntegrationAction,
        IntegrationKind, RecoveryAction,
    },
};
use std::{fs, path::Path, process::Output};

#[test]
fn rewrite_push_requires_fresh_remote_review() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    let remote = dir.path().join("remote.git");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--bare", "-q"]);
    fixture(&root);
    git(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&root, &["push", "-qu", "origin", "other"]);
    let old = git(&root, &["rev-parse", "HEAD"]);
    git(&root, &["commit", "--amend", "-qm", "rewritten"]);
    let review = review_rewrite_push(root.to_str().unwrap()).unwrap();
    assert_eq!(review.remote_oid, old);
    let previous = git(&root, &["rev-parse", "HEAD~1"]);
    git(&remote, &["update-ref", "refs/heads/other", &previous]);
    assert!(push_rewrite(root.to_str().unwrap(), &review).is_err());
    let updated = review_rewrite_push(root.to_str().unwrap()).unwrap();
    push_rewrite(root.to_str().unwrap(), &updated).unwrap();
    assert_eq!(
        git(&remote, &["rev-parse", "refs/heads/other"]),
        updated.local_oid
    );
}

#[test]
fn merge_fast_forwards_and_rejects_dirty_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    let original = git(root, &["branch", "--format=%(refname:short)"])
        .lines()
        .find(|name| *name != "other")
        .unwrap()
        .to_owned();
    git(root, &["reset", "--hard", "HEAD~1"]);
    let root_str = root.to_str().unwrap();
    let reviewed = review(root_str, &format!("refs/heads/{original}")).unwrap();
    fs::write(root.join("conflict file.txt"), "local changes\n").unwrap();
    assert!(start(root_str, &reviewed, IntegrationAction::Merge).is_err());
    assert_eq!(git(root, &["rev-parse", "HEAD"]), reviewed.head_oid);
    git(root, &["restore", "conflict file.txt"]);
    let result = start(root_str, &reviewed, IntegrationAction::Merge).unwrap();
    assert!(result.failure.is_none());
    assert!(result.state.is_none());
    assert_eq!(git(root, &["rev-parse", "HEAD"]), reviewed.target_oid);
}

#[test]
fn skip_rebase_conflict_drops_only_the_current_replayed_commit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    let original = git(root, &["branch", "--format=%(refname:short)"])
        .lines()
        .find(|name| *name != "other")
        .unwrap()
        .to_owned();
    let root_str = root.to_str().unwrap();
    let reviewed = review(root_str, &format!("refs/heads/{original}")).unwrap();
    let started = start(root_str, &reviewed, IntegrationAction::Rebase).unwrap();
    assert_eq!(started.state.unwrap().kind, IntegrationKind::Rebase);
    let skipped = recover(root_str, IntegrationKind::Rebase, RecoveryAction::Skip).unwrap();
    assert!(skipped.failure.is_none(), "{:?}", skipped.failure);
    assert!(skipped.state.is_none());
    assert_eq!(git(root, &["rev-parse", "HEAD"]), reviewed.target_oid);
}

fn output(root: &Path, args: &[&str]) -> Output {
    git_command()
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", root.join("missing-global-config"))
        .output()
        .unwrap()
}

#[test]
fn review_requires_literal_other_branch_and_a_normal_checkout() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    let original = git(root, &["branch", "--format=%(refname:short)"])
        .lines()
        .find(|name| *name != "other")
        .unwrap()
        .to_owned();
    let target_ref = format!("refs/heads/{original}");
    let result = review(root.to_str().unwrap(), &target_ref).unwrap();
    assert_eq!(result.current_ref, "refs/heads/other");
    assert_eq!(result.target_oid, git(root, &["rev-parse", &target_ref]));
    assert!(review(root.to_str().unwrap(), &original).is_err());
    assert!(review(root.to_str().unwrap(), "refs/heads/other").is_err());
    git(root, &["switch", "--detach", "-q"]);
    assert!(review(root.to_str().unwrap(), &target_ref).is_err());
}

#[test]
fn rebase_accepts_a_full_commit_id_but_merge_still_requires_a_branch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    let root_str = root.to_str().unwrap();
    let target = git(root, &["rev-parse", "HEAD~1"]);
    let reviewed = review(root_str, &target).unwrap();
    assert_eq!(reviewed.target_oid, target);
    assert!(start(root_str, &reviewed, IntegrationAction::Merge).is_err());
    let outcome = start(root_str, &reviewed, IntegrationAction::Rebase).unwrap();
    assert!(outcome.failure.is_none());
    assert!(outcome.state.is_none());
    git(root, &["tag", "-a", "object-tag", "-m", "tag"]);
    let tag_oid = git(root, &["rev-parse", "refs/tags/object-tag"]);
    assert!(review(root_str, &tag_oid).is_err());
}

#[test]
fn start_merge_and_continue_after_external_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    let original = git(root, &["branch", "--format=%(refname:short)"])
        .lines()
        .find(|name| *name != "other")
        .unwrap()
        .to_owned();
    let root_str = root.to_str().unwrap();
    let reviewed = review(root_str, &format!("refs/heads/{original}")).unwrap();
    let outcome = start(root_str, &reviewed, IntegrationAction::Merge).unwrap();
    assert!(outcome.failure.is_some());
    assert_eq!(outcome.state.unwrap().kind, IntegrationKind::Merge);
    assert!(recover(root_str, IntegrationKind::Merge, RecoveryAction::Continue).is_err());
    fs::write(root.join("conflict file.txt"), "resolved\n").unwrap();
    git(root, &["add", "conflict file.txt"]);
    let outcome = recover(root_str, IntegrationKind::Merge, RecoveryAction::Continue).unwrap();
    assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
    assert!(outcome.state.is_none());
    assert_eq!(
        git(root, &["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
}

#[test]
fn rejects_stale_review_and_aborts_rebase() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    let original = git(root, &["branch", "--format=%(refname:short)"])
        .lines()
        .find(|name| *name != "other")
        .unwrap()
        .to_owned();
    let root_str = root.to_str().unwrap();
    let mut reviewed = review(root_str, &format!("refs/heads/{original}")).unwrap();
    let correct = reviewed.head_oid.clone();
    reviewed.head_oid = reviewed.target_oid.clone();
    assert!(start(root_str, &reviewed, IntegrationAction::Rebase).is_err());
    reviewed.head_oid = correct;
    let outcome = start(root_str, &reviewed, IntegrationAction::Rebase).unwrap();
    assert_eq!(outcome.state.unwrap().kind, IntegrationKind::Rebase);
    let outcome = recover(root_str, IntegrationKind::Rebase, RecoveryAction::Abort).unwrap();
    assert!(outcome.failure.is_none());
    assert!(outcome.state.is_none());
    assert_eq!(git(root, &["rev-parse", "HEAD"]), reviewed.head_oid);
}

fn git(root: &Path, args: &[&str]) -> String {
    let result = output(root, args);
    assert!(
        result.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

fn fixture(root: &Path) {
    git(root, &["init", "-q"]);
    git(root, &["config", "user.name", "Test"]);
    git(root, &["config", "user.email", "test@example.invalid"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    fs::write(root.join("conflict file.txt"), "base\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "base"]);
    git(root, &["branch", "other"]);
    fs::write(root.join("conflict file.txt"), "current\n").unwrap();
    git(root, &["commit", "-qam", "current"]);
    git(root, &["switch", "-q", "other"]);
    fs::write(root.join("conflict file.txt"), "other\n").unwrap();
    git(root, &["commit", "-qam", "other"]);
}

#[test]
fn detects_merge_and_external_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    assert!(inspect(root.to_str().unwrap()).unwrap().is_none());
    let original = git(root, &["branch", "--format=%(refname:short)"])
        .lines()
        .find(|name| *name != "other")
        .unwrap()
        .to_owned();
    assert!(!output(root, &["merge", "--no-edit", &original])
        .status
        .success());
    let state = inspect(root.to_str().unwrap()).unwrap().unwrap();
    assert_eq!(state.kind, IntegrationKind::Merge);
    assert_eq!(state.unresolved_paths, ["conflict file.txt"]);
    fs::write(root.join("conflict file.txt"), "resolved\n").unwrap();
    git(root, &["add", "conflict file.txt"]);
    assert!(inspect(root.to_str().unwrap())
        .unwrap()
        .unwrap()
        .unresolved_paths
        .is_empty());
    git(root, &["merge", "--abort"]);
    assert!(inspect(root.to_str().unwrap()).unwrap().is_none());
}

#[test]
fn detects_rebase_in_linked_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("main");
    let linked = dir.path().join("linked");
    fs::create_dir(&root).unwrap();
    fixture(&root);
    let original = git(&root, &["branch", "--format=%(refname:short)"])
        .lines()
        .find(|name| *name != "other")
        .unwrap()
        .to_owned();
    git(
        &root,
        &[
            "worktree",
            "add",
            "-qb",
            "linked",
            linked.to_str().unwrap(),
            &original,
        ],
    );
    assert!(!output(&linked, &["rebase", "other"]).status.success());
    let state = inspect(linked.to_str().unwrap()).unwrap().unwrap();
    assert_eq!(state.kind, IntegrationKind::Rebase);
    assert_eq!(state.unresolved_paths, ["conflict file.txt"]);
    assert!(inspect(root.to_str().unwrap()).unwrap().is_none());
    git(&linked, &["rebase", "--abort"]);
    assert!(inspect(linked.to_str().unwrap()).unwrap().is_none());
}

#[test]
fn does_not_treat_git_am_as_a_rebase() {
    let dir = tempfile::tempdir().unwrap();
    fixture(dir.path());
    let path = dir.path().join(".git/rebase-apply");
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("applying"), "").unwrap();
    assert_eq!(
        inspect(dir.path().to_str().unwrap()).unwrap().unwrap().kind,
        IntegrationKind::Unknown
    );
}

#[test]
fn unmerged_index_without_operation_is_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    let original = git(root, &["branch", "--format=%(refname:short)"])
        .lines()
        .find(|name| *name != "other")
        .unwrap()
        .to_owned();
    assert!(!output(root, &["merge", "--no-edit", &original])
        .status
        .success());
    fs::remove_file(root.join(".git/MERGE_HEAD")).unwrap();
    let state = inspect(root.to_str().unwrap()).unwrap().unwrap();
    assert_eq!(state.kind, IntegrationKind::Unknown);
    assert_eq!(state.unresolved_paths, ["conflict file.txt"]);
}
