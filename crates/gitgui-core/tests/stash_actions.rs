//! Production action APIs against the installed Git in isolated repositories.
use gitgui_core::git::{
    command::git_command,
    stash::{StashError, StashTarget, STASH_ENCODING_HEADER},
    stash_actions::{
        apply_stash, branch_from_stash, drop_stash, pop_stash, StashActionFailure,
        StashMutationOutcome as Outcome, StashRestoreOutcome as Restore, StashState as State,
    },
};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Output, Stdio},
};
use tempfile::TempDir;

struct Repo(TempDir);

impl Repo {
    fn new() -> Self {
        let repo = Self(tempfile::tempdir().unwrap());
        repo.git(&["init", "-q"]);
        repo.git(&["config", "user.name", "Stash action fixture"]);
        repo.git(&["config", "user.email", "stash-action@example.invalid"]);
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.write("selected.txt", "A\n");
        repo.write("other.txt", "original\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "base"]);
        repo
    }

    fn root(&self) -> &str {
        self.0.path().to_str().unwrap()
    }
    fn write(&self, path: &str, value: &str) {
        fs::write(self.0.path().join(path), value).unwrap();
    }
    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.0.path().join(path)).unwrap()
    }

    fn output(&self, args: &[&str], input: Option<&[u8]>, index: Option<&Path>) -> Output {
        let mut command = git_command();
        command
            .current_dir(self.0.path())
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.0.path().join("no-global-config"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(index) = index {
            command.env("GIT_INDEX_FILE", index);
        }
        let mut child = command.spawn().unwrap();
        if let Some(input) = input {
            child.stdin.take().unwrap().write_all(input).unwrap();
        }
        drop(child.stdin.take());
        child.wait_with_output().unwrap()
    }

    fn git_input(&self, args: &[&str], input: Option<&[u8]>, index: Option<&Path>) -> String {
        let output = self.output(args, input, index);
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim_end().into()
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_input(args, None, None)
    }

    fn target(&self, number: usize) -> StashTarget {
        let selector = format!("stash@{{{number}}}");
        let expected_oid = self.git(&["rev-parse", &selector]);
        StashTarget {
            selector,
            expected_oid,
        }
    }

    fn stash(&self, file: &str, content: &str) -> StashTarget {
        self.write(file, content);
        self.git(&["stash", "push", "-u", "-m", content.trim()]);
        self.target(0)
    }

    fn hook(&self, name: &str, body: &str) {
        let path = self.0.path().join(".git/hooks").join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn commit_object(&self, tree: &str, parents: &[&str], header: Option<&str>) -> String {
        let mut raw = format!("tree {tree}\n");
        for parent in parents {
            raw.push_str(&format!("parent {parent}\n"));
        }
        raw.push_str("author Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n");
        if let Some(header) = header {
            raw.push_str(header);
            raw.push('\n');
        }
        raw.push_str("\nfixture\n");
        self.git_input(
            &["hash-object", "-w", "-t", "commit", "--stdin"],
            Some(raw.as_bytes()),
            None,
        )
    }

    fn tree(&self, original: &str, changes: &[(&str, Option<(&str, &str)>)]) -> String {
        let directory = tempfile::tempdir().unwrap();
        let index = directory.path().join("index");
        self.git_input(&["read-tree", original], None, Some(&index));
        for (path, entry) in changes {
            if let Some((mode, value)) = entry {
                let blob = self.git_input(
                    &["hash-object", "-w", "--stdin"],
                    Some(value.as_bytes()),
                    None,
                );
                self.git_input(
                    &["update-index", "--add", "--cacheinfo", mode, &blob, path],
                    None,
                    Some(&index),
                );
            } else {
                self.git_input(
                    &["update-index", "--force-remove", "--", path],
                    None,
                    Some(&index),
                );
            }
        }
        self.git_input(&["write-tree"], None, Some(&index))
    }

    // Independent durable fixture, not a call to the selected-push worker.
    fn custom(
        &self,
        changes: &[(&str, Option<(&str, &str)>)],
        saved: &[(&str, Option<(&str, &str)>)],
    ) -> StashTarget {
        self.custom_with_untracked(changes, saved, &[])
    }

    fn custom_with_untracked(
        &self,
        changes: &[(&str, Option<(&str, &str)>)],
        saved: &[(&str, Option<(&str, &str)>)],
        untracked: &[(&str, Option<(&str, &str)>)],
    ) -> StashTarget {
        let original = self.git(&["rev-parse", "HEAD"]);
        let baseline_tree = self.tree(&original, changes);
        let baseline = self.commit_object(&baseline_tree, &[&original], None);
        let index = self.commit_object(&baseline_tree, &[&baseline], None);
        let worktree = self.tree(&baseline, saved);
        let mut parents = vec![baseline.as_str(), index.as_str()];
        let untracked_commit;
        if !untracked.is_empty() {
            let empty = self.git_input(&["mktree"], Some(b""), None);
            let tree = self.tree(&empty, untracked);
            untracked_commit = self.commit_object(&tree, &[], None);
            parents.push(&untracked_commit);
        }
        let stash = self.commit_object(&worktree, &parents, Some(STASH_ENCODING_HEADER));
        self.git(&["stash", "store", "-m", "custom", &stash]);
        self.target(0)
    }

    fn inverse(&self) -> StashTarget {
        self.custom(
            &[("selected.txt", Some(("100644", "B\n")))],
            &[("selected.txt", Some(("100644", "A\n")))],
        )
    }
}

#[test]
fn reviewed_older_apply_retains_pop_removes_and_drop_deletes_only_one() {
    for action in ["apply", "pop", "drop"] {
        let repo = Repo::new();
        let older = repo.stash("selected.txt", "saved older\n");
        let latest = repo.stash("other.txt", "saved latest\n");
        let target = repo.target(1);
        assert_eq!(target.expected_oid, older.expected_oid);
        let result = match action {
            "apply" => apply_stash(repo.root(), &target),
            "pop" => pop_stash(repo.root(), &target),
            _ => drop_stash(repo.root(), &target),
        }
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        assert_eq!(
            result.restore,
            if action == "drop" {
                Restore::NotAttempted
            } else {
                Restore::Succeeded
            }
        );
        assert_eq!(
            repo.read("selected.txt"),
            if action == "drop" {
                "A\n"
            } else {
                "saved older\n"
            }
        );
        assert_eq!(repo.read("other.txt"), "original\n");
        assert_eq!(repo.target(0).expected_oid, latest.expected_oid);
        assert!(result.branch.is_none() && result.error.is_none());
        if action == "apply" {
            assert_eq!(result.stash_state, State::Retained);
            assert_eq!(repo.target(1).expected_oid, older.expected_oid);
        } else {
            assert_eq!(result.stash_state, State::Removed);
            assert_eq!(
                repo.git(&["stash", "list", "--format=%H"]),
                latest.expected_oid
            );
        }
    }
}

#[test]
fn stale_targets_invalid_selectors_and_reflog_movement_are_pre_mutation_errors() {
    let repo = Repo::new();
    let first = repo.stash("selected.txt", "first\n");
    repo.stash("other.txt", "second\n");
    let before = repo.git(&["stash", "list", "--format=%H"]);
    for call in [apply_stash, pop_stash, drop_stash] {
        assert!(matches!(
            call(repo.root(), &first),
            Err(StashError::TargetChanged)
        ));
    }
    assert!(matches!(
        branch_from_stash(repo.root(), &first, "stale"),
        Err(StashError::TargetChanged)
    ));
    assert_eq!(repo.git(&["stash", "list", "--format=%H"]), before);
    assert_eq!(repo.read("selected.txt"), "A\n");
    let mut invalid = repo.target(0);
    invalid.selector = "refs/stash".into();
    assert!(matches!(
        drop_stash(repo.root(), &invalid),
        Err(StashError::Invalid(_))
    ));
    let captured = repo.target(1);
    repo.git(&["stash", "drop", "stash@{0}"]);
    assert!(matches!(
        pop_stash(repo.root(), &captured),
        Err(StashError::TargetChanged)
    ));
    assert_eq!(repo.target(0).expected_oid, captured.expected_oid);
}

#[test]
fn apply_and_pop_report_real_conflicts_and_keep_stash() {
    for pop in [false, true] {
        let repo = Repo::new();
        let target = repo.stash("selected.txt", "saved\n");
        repo.write("selected.txt", "committed destination\n");
        repo.git(&["add", "selected.txt"]);
        repo.git(&["commit", "-qm", "destination"]);
        let result = if pop {
            pop_stash(repo.root(), &target)
        } else {
            apply_stash(repo.root(), &target)
        }
        .unwrap();
        assert_eq!(result.outcome, Outcome::Conflicts);
        assert_eq!(result.restore, Restore::Conflicts);
        assert_eq!(result.stash_state, State::Retained);
        assert_eq!(result.error, Some(StashActionFailure::RestoreConflicts));
        assert_eq!(
            repo.git(&["diff", "--name-only", "--diff-filter=U"]),
            "selected.txt"
        );
        assert_eq!(repo.target(0).expected_oid, target.expected_oid);
        // An already-unmerged destination is refused before another apply.
        assert!(matches!(
            apply_stash(repo.root(), &target),
            Err(StashError::Invalid(_))
        ));
    }
}

#[test]
fn untracked_collision_is_partial_not_a_conflict_and_never_removes_stash() {
    for pop in [false, true] {
        let repo = Repo::new();
        repo.write("selected.txt", "tracked saved\n");
        let target = repo.stash("new.txt", "saved untracked\n");
        repo.write("new.txt", "destination untracked\n");
        let result = if pop {
            pop_stash(repo.root(), &target)
        } else {
            apply_stash(repo.root(), &target)
        }
        .unwrap();
        assert_eq!(result.outcome, Outcome::Partial);
        assert_eq!(result.restore, Restore::Failed);
        assert_eq!(result.stash_state, State::Retained);
        assert_eq!(repo.read("new.txt"), "destination untracked\n");
        assert_eq!(repo.read("selected.txt"), "tracked saved\n");
        assert!(repo.git(&["ls-files", "-u"]).is_empty());
        assert_eq!(repo.target(0).expected_oid, target.expected_oid);
    }
}

#[test]
fn removal_failure_preserves_successful_restore_receipt() {
    let repo = Repo::new();
    let target = repo.stash("selected.txt", "saved\n");
    repo.write(".git/refs/stash.lock", "held by fixture");
    let result = pop_stash(repo.root(), &target).unwrap();
    assert_eq!(result.outcome, Outcome::Partial);
    assert_eq!(result.restore, Restore::Succeeded);
    assert_eq!(result.stash_state, State::Retained);
    assert_eq!(result.error, Some(StashActionFailure::RemovalFailed));
    assert_eq!(repo.read("selected.txt"), "saved\n");
    assert_eq!(repo.target(0).expected_oid, target.expected_oid);
    let delete = drop_stash(repo.root(), &target).unwrap();
    assert_eq!(delete.restore, Restore::NotAttempted);
    assert_eq!(delete.error, Some(StashActionFailure::RemovalFailed));
}

#[test]
fn existing_in_progress_operations_are_refused_without_mutation() {
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
        "BISECT_START",
    ] {
        let repo = Repo::new();
        let target = repo.stash("selected.txt", "saved\n");
        repo.write(&format!(".git/{marker}"), "fixture");
        assert!(
            matches!(pop_stash(repo.root(), &target), Err(StashError::Invalid(_))),
            "{marker}"
        );
        assert_eq!(repo.read("selected.txt"), "A\n");
        assert_eq!(repo.target(0).expected_oid, target.expected_oid);
    }
}

#[test]
fn native_branch_starts_at_original_restores_index_and_removes_only_reviewed_entry() {
    let repo = Repo::new();
    let original = repo.git(&["rev-parse", "HEAD"]);
    repo.write("selected.txt", "staged\n");
    repo.git(&["add", "selected.txt"]);
    repo.write("new.txt", "native saved untracked\n");
    let older = repo.stash("selected.txt", "worktree\n");
    let newer = repo.stash("other.txt", "newer\n");
    repo.git(&["commit", "--allow-empty", "-qm", "later HEAD"]);
    let result = branch_from_stash(repo.root(), &repo.target(1), "restore-native").unwrap();
    assert_eq!(result.outcome, Outcome::Success);
    assert_eq!(result.stash_state, State::Removed);
    assert_eq!(result.restore, Restore::Succeeded);
    assert_eq!(result.branch.unwrap().name, "restore-native");
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), original);
    assert_eq!(repo.git(&["show", ":selected.txt"]), "staged");
    assert_eq!(repo.read("selected.txt"), "worktree\n");
    assert_eq!(repo.read("new.txt"), "native saved untracked\n");
    assert_eq!(repo.target(0).expected_oid, newer.expected_oid);
    assert!(!repo
        .git(&["stash", "list", "--format=%H"])
        .contains(&older.expected_oid));
}

#[test]
fn custom_inverse_branch_seeds_only_selected_context_and_preserves_unrelated_edits() {
    // Both destinations can independently match H or P before seeding.
    for (index_baseline, worktree_baseline) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let repo = Repo::new();
        let original = repo.git(&["rev-parse", "HEAD"]);
        let target = repo.inverse();
        if index_baseline {
            repo.write("selected.txt", "B\n");
            repo.git(&["add", "selected.txt"]);
        }
        repo.write(
            "selected.txt",
            if worktree_baseline { "B\n" } else { "A\n" },
        );
        repo.write("other.txt", "other staged\n");
        repo.git(&["add", "other.txt"]);
        repo.write("other.txt", "other worktree\n");
        repo.write("loose.txt", "unrelated untracked\n");
        let result = branch_from_stash(repo.root(), &target, "inverse").unwrap();
        assert_eq!(
            result.outcome,
            Outcome::Success,
            "{result:?}, {index_baseline}/{worktree_baseline}"
        );
        assert_eq!(result.stash_state, State::Removed);
        assert!(result.branch.unwrap().switched);
        assert_eq!(repo.git(&["rev-parse", "HEAD"]), original);
        assert_eq!(repo.git(&["show", ":selected.txt"]), "B");
        assert_eq!(repo.read("selected.txt"), "A\n");
        assert_eq!(repo.git(&["show", ":other.txt"]), "other staged");
        assert_eq!(repo.read("other.txt"), "other worktree\n");
        assert_eq!(repo.read("loose.txt"), "unrelated untracked\n");
    }
}

#[test]
fn custom_branch_preflight_rejects_unrelated_selected_index_or_worktree_changes() {
    for staged in [false, true] {
        let repo = Repo::new();
        let target = repo.inverse();
        repo.write("selected.txt", "unrelated edit\n");
        if staged {
            repo.git(&["add", "selected.txt"]);
            repo.write("selected.txt", "A\n");
        }
        let index = repo.git(&["write-tree"]);
        let worktree = repo.read("selected.txt");
        assert!(matches!(
            branch_from_stash(repo.root(), &target, "unsafe"),
            Err(StashError::Invalid(_))
        ));
        assert!(!repo
            .output(&["show-ref", "--verify", "refs/heads/unsafe"], None, None)
            .status
            .success());
        assert_eq!(repo.git(&["write-tree"]), index);
        assert_eq!(repo.read("selected.txt"), worktree);
        assert_eq!(repo.target(0).expected_oid, target.expected_oid);
    }
}

#[test]
fn invalid_existing_and_unsafe_switch_destinations_do_not_create_branch() {
    let repo = Repo::new();
    let target = repo.stash("selected.txt", "saved\n");
    for name in ["", "HEAD", "@", "-bad", "bad name", "@{-1}", "../bad"] {
        assert!(
            matches!(
                branch_from_stash(repo.root(), &target, name),
                Err(StashError::Invalid(_))
            ),
            "{name}"
        );
    }
    repo.git(&["branch", "existing"]);
    assert!(matches!(
        branch_from_stash(repo.root(), &target, "existing"),
        Err(StashError::Invalid(_))
    ));
    assert!(matches!(
        branch_from_stash(repo.root(), &target, "existing/child"),
        Err(StashError::Invalid(_))
    ));
    repo.git(&["branch", "parent/child"]);
    assert!(matches!(
        branch_from_stash(repo.root(), &target, "parent"),
        Err(StashError::Invalid(_))
    ));
    repo.write("other.txt", "later committed\n");
    repo.git(&["add", "other.txt"]);
    repo.git(&["commit", "-qm", "later"]);
    repo.write("other.txt", "dirty destination\n");
    assert!(matches!(
        branch_from_stash(repo.root(), &target, "unsafe-switch"),
        Err(StashError::Invalid(_))
    ));
    assert!(!repo
        .output(
            &["show-ref", "--verify", "refs/heads/unsafe-switch"],
            None,
            None
        )
        .status
        .success());
    assert_eq!(repo.read("other.txt"), "dirty destination\n");
}

#[test]
fn branch_creation_and_switch_failures_report_exact_progress() {
    let repo = Repo::new();
    let target = repo.stash("selected.txt", "saved\n");
    repo.write(".git/refs/heads/blocked.lock", "held by fixture");
    let result = branch_from_stash(repo.root(), &target, "blocked").unwrap();
    assert_eq!(result.outcome, Outcome::Partial);
    assert_eq!(result.restore, Restore::NotAttempted);
    assert_eq!(result.error, Some(StashActionFailure::BranchCreationFailed));
    assert!(result.branch.is_none());
    repo.write(".git/HEAD.lock", "held by fixture");
    let result = branch_from_stash(repo.root(), &target, "created-only").unwrap();
    assert_eq!(result.outcome, Outcome::Partial);
    assert_eq!(result.restore, Restore::NotAttempted);
    assert_eq!(result.error, Some(StashActionFailure::BranchSwitchFailed));
    assert!(!result.branch.unwrap().switched);
    assert_eq!(
        repo.git(&["rev-parse", "created-only"]),
        repo.git(&["rev-parse", "HEAD"])
    );
    assert_eq!(repo.target(0).expected_oid, target.expected_oid);
}

#[test]
fn post_switch_context_edit_is_preserved_with_created_branch_failure_receipt() {
    let repo = Repo::new();
    let target = repo.inverse();
    repo.hook(
        "post-checkout",
        "printf 'concurrent edit\\n' > selected.txt",
    );
    let result = branch_from_stash(repo.root(), &target, "context-fails").unwrap();
    assert_eq!(result.outcome, Outcome::BranchCreatedRestoreFailed);
    assert_eq!(result.restore, Restore::Failed);
    assert_eq!(
        result.error,
        Some(StashActionFailure::ContextPreparationFailed)
    );
    assert!(result.branch.unwrap().switched);
    assert_eq!(repo.git(&["show", ":selected.txt"]), "A");
    assert_eq!(repo.read("selected.txt"), "concurrent edit\n");
    assert_eq!(repo.target(0).expected_oid, target.expected_oid);
}

#[test]
fn branch_restore_failure_retains_branch_stash_and_partial_files() {
    let repo = Repo::new();
    repo.write("selected.txt", "tracked saved\n");
    let target = repo.stash("new.txt", "saved untracked\n");
    repo.write("new.txt", "destination untracked\n");
    let result = branch_from_stash(repo.root(), &target, "restore-fails").unwrap();
    assert_eq!(result.outcome, Outcome::BranchCreatedRestoreFailed);
    assert_eq!(result.restore, Restore::Failed);
    assert_eq!(result.stash_state, State::Retained);
    assert!(result.branch.unwrap().switched);
    assert_eq!(repo.read("new.txt"), "destination untracked\n");
    assert_eq!(repo.read("selected.txt"), "tracked saved\n");
    assert_eq!(repo.target(0).expected_oid, target.expected_oid);
}

#[test]
fn external_reflog_movement_after_branch_switch_never_drops_replacement() {
    let repo = Repo::new();
    let older = repo.stash("selected.txt", "older\n");
    let latest = repo.stash("other.txt", "latest\n");
    let target = repo.target(1);
    repo.hook(
        "post-checkout",
        &format!("git stash store -m externally-moved {}", older.expected_oid),
    );
    let result = branch_from_stash(repo.root(), &target, "moved").unwrap();
    assert_eq!(result.outcome, Outcome::Partial);
    assert_eq!(result.restore, Restore::Succeeded);
    assert_eq!(
        result.error,
        Some(StashActionFailure::TargetChangedBeforeRemoval)
    );
    assert_eq!(result.stash_state, State::Retained);
    assert!(result.branch.unwrap().switched);
    assert_eq!(repo.target(1).expected_oid, latest.expected_oid);
    assert_eq!(repo.target(2).expected_oid, older.expected_oid);
    assert_eq!(repo.read("selected.txt"), "older\n");
}

#[test]
fn branch_removal_failure_preserves_created_branch_and_successful_restore() {
    let repo = Repo::new();
    let target = repo.stash("selected.txt", "saved\n");
    repo.write(".git/refs/stash.lock", "held by fixture");
    let result = branch_from_stash(repo.root(), &target, "remove-fails").unwrap();
    assert_eq!(result.outcome, Outcome::Partial);
    assert_eq!(result.restore, Restore::Succeeded);
    assert_eq!(result.error, Some(StashActionFailure::RemovalFailed));
    assert_eq!(result.stash_state, State::Retained);
    assert!(result.branch.unwrap().switched);
    assert_eq!(repo.read("selected.txt"), "saved\n");
    assert_eq!(repo.target(0).expected_oid, target.expected_oid);
}

#[test]
fn replacements_cannot_change_reviewed_native_apply_payload() {
    let repo = Repo::new();
    let target = repo.stash("selected.txt", "reviewed\n");
    let replacement = repo.stash("selected.txt", "replacement\n");
    repo.git(&["replace", &target.expected_oid, &replacement.expected_oid]);
    let reviewed = repo.target(1);
    let result = apply_stash(repo.root(), &reviewed).unwrap();
    assert_eq!(result.outcome, Outcome::Success);
    assert_eq!(repo.read("selected.txt"), "reviewed\n");
}

#[test]
fn custom_context_additions_deletions_and_literal_odd_paths_restore_at_original_head() {
    for path in [
        "space name.txt",
        "tab\tname.txt",
        "line\nname.txt",
        "日本語.txt",
        ":(glob)*.txt",
    ] {
        // Windows does not permit colons, '*' or literal newlines in filenames.
        if cfg!(windows) && path.bytes().any(|b| b < 32 || b"<>:\"|?*".contains(&b)) {
            continue;
        }
        let repo = Repo::new();
        let original = repo.git(&["rev-parse", "HEAD"]);
        let target = repo.custom(
            &[(path, Some(("100644", "baseline\n")))],
            &[(path, Some(("100644", "saved\n")))],
        );
        let result = branch_from_stash(repo.root(), &target, "literal-context").unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{path:?}: {result:?}");
        assert_eq!(repo.git(&["rev-parse", "HEAD"]), original);
        assert_eq!(repo.git(&["show", &format!(":{path}")]), "baseline");
        assert_eq!(repo.read(path), "saved\n");
    }
    let repo = Repo::new();
    let target = repo.custom(&[("selected.txt", None)], &[]);
    let result = branch_from_stash(repo.root(), &target, "deleted-context").unwrap();
    assert_eq!(result.outcome, Outcome::Success, "{result:?}");
    assert!(!repo
        .output(&["show", ":selected.txt"], None, None)
        .status
        .success());
    assert!(!repo.0.path().join("selected.txt").exists());
}

#[test]
fn custom_context_file_mode_is_restored_in_index() {
    let repo = Repo::new();
    let target = repo.custom(
        &[("selected.txt", Some(("100755", "B\n")))],
        &[("selected.txt", Some(("100755", "A\n")))],
    );
    let result = branch_from_stash(repo.root(), &target, "executable-context").unwrap();
    assert_eq!(result.outcome, Outcome::Success, "{result:?}");
    assert!(repo
        .git(&["ls-files", "--stage", "selected.txt"])
        .starts_with("100755 "));
    assert_eq!(repo.read("selected.txt"), "A\n");
}

#[test]
fn branch_conflicts_preserve_real_unmerged_entries_and_created_branch() {
    let repo = Repo::new();
    let target = repo.stash("selected.txt", "saved\n");
    repo.write("selected.txt", "staged destination\n");
    repo.git(&["add", "selected.txt"]);
    let result = branch_from_stash(repo.root(), &target, "branch-conflicts").unwrap();
    assert_eq!(
        result.outcome,
        Outcome::BranchCreatedRestoreFailed,
        "{result:?}"
    );
    assert_eq!(result.restore, Restore::Conflicts);
    assert_eq!(result.error, Some(StashActionFailure::RestoreConflicts));
    assert!(result.branch.unwrap().switched);
    assert_eq!(
        repo.git(&["diff", "--name-only", "--diff-filter=U"]),
        "selected.txt"
    );
    assert_eq!(repo.target(0).expected_oid, target.expected_oid);
}

#[test]
fn pop_rechecks_selector_after_external_reflog_movement_during_restore() {
    let repo = Repo::new();
    let older = repo.stash("selected.txt", "older\n");
    let latest = repo.stash("other.txt", "latest\n");
    let target = repo.target(1);
    repo.write(".git/info/attributes", "selected.txt filter=move-stash\n");
    repo.git(&[
        "config",
        "filter.move-stash.smudge",
        &format!(
            "git stash store -m externally-moved {}; cat",
            older.expected_oid
        ),
    ]);
    let result = pop_stash(repo.root(), &target).unwrap();
    assert_eq!(result.outcome, Outcome::Partial, "{result:?}");
    assert_eq!(result.restore, Restore::Succeeded);
    assert_eq!(
        result.error,
        Some(StashActionFailure::TargetChangedBeforeRemoval)
    );
    assert_eq!(repo.target(1).expected_oid, latest.expected_oid);
    assert_eq!(repo.target(2).expected_oid, older.expected_oid);
    assert_eq!(repo.read("selected.txt"), "older\n");
}

#[test]
fn context_seeding_failure_after_one_path_keeps_completed_context_and_foreign_edit() {
    let repo = Repo::new();
    repo.write("z.txt", "original z\n");
    repo.git(&["add", "z.txt"]);
    repo.git(&["commit", "-qm", "second context path"]);
    let target = repo.custom(
        &[
            ("selected.txt", Some(("100644", "B\n"))),
            ("z.txt", Some(("100644", "baseline z\n"))),
        ],
        &[
            ("selected.txt", Some(("100644", "A\n"))),
            ("z.txt", Some(("100644", "saved z\n"))),
        ],
    );
    repo.write(".git/info/attributes", "selected.txt filter=context-race\n");
    repo.git(&[
        "config",
        "filter.context-race.smudge",
        "printf 'concurrent z\\n' > z.txt; cat",
    ]);
    let result = branch_from_stash(repo.root(), &target, "partial-context").unwrap();
    assert_eq!(
        result.outcome,
        Outcome::BranchCreatedRestoreFailed,
        "{result:?}"
    );
    assert_eq!(result.restore, Restore::Failed);
    assert_eq!(
        result.error,
        Some(StashActionFailure::ContextPreparationFailed)
    );
    assert!(result.branch.unwrap().switched);
    assert_eq!(repo.git(&["show", ":selected.txt"]), "B");
    assert_eq!(repo.read("selected.txt"), "B\n");
    assert_eq!(repo.git(&["show", ":z.txt"]), "original z");
    assert_eq!(repo.read("z.txt"), "concurrent z\n");
    assert_eq!(repo.target(0).expected_oid, target.expected_oid);
}

#[test]
fn worktree_claim_between_creation_and_switch_is_respected() {
    let repo = Repo::new();
    let other = tempfile::tempdir().unwrap();
    let linked = other.path().join("linked");
    let linked_git_path = linked.to_str().unwrap().replace('\\', "/");
    let target = repo.stash("selected.txt", "saved\n");
    repo.hook("reference-transaction", &format!(
        "if test \"$1\" = committed && test ! -f .git/claimed-once; then\n  touch .git/claimed-once\n  git worktree add --quiet '{}' claimed\nfi\nexit 0", linked_git_path
    ));
    let result = branch_from_stash(repo.root(), &target, "claimed").unwrap();
    assert_eq!(result.outcome, Outcome::Partial, "{result:?}");
    assert_eq!(result.restore, Restore::NotAttempted);
    assert_eq!(result.error, Some(StashActionFailure::BranchSwitchFailed));
    assert!(!result.branch.unwrap().switched);
    assert_eq!(repo.read("selected.txt"), "A\n");
    assert_eq!(
        fs::read_to_string(linked.join("selected.txt")).unwrap(),
        "A\n"
    );
    assert_eq!(repo.target(0).expected_oid, target.expected_oid);
}

#[test]
fn invalid_snapshot_layout_is_refused_by_all_actions_including_delete() {
    let repo = Repo::new();
    let original = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["update-ref", "--create-reflog", "refs/stash", &original]);
    let target = repo.target(0);
    for action in [apply_stash, pop_stash, drop_stash] {
        assert!(matches!(
            action(repo.root(), &target),
            Err(StashError::Invalid(_))
        ));
    }
    assert!(matches!(
        branch_from_stash(repo.root(), &target, "invalid-snapshot"),
        Err(StashError::Invalid(_))
    ));
    assert_eq!(repo.target(0).expected_oid, original);
    assert_eq!(repo.read("selected.txt"), "A\n");
}

#[test]
fn failing_post_checkout_hook_reports_that_branch_did_switch() {
    let repo = Repo::new();
    let target = repo.stash("selected.txt", "saved\n");
    repo.hook("post-checkout", "exit 1");
    let result = branch_from_stash(repo.root(), &target, "hook-fails").unwrap();
    assert_eq!(result.outcome, Outcome::BranchCreatedRestoreFailed);
    assert_eq!(result.restore, Restore::Failed);
    assert_eq!(result.error, Some(StashActionFailure::BranchSwitchFailed));
    assert!(result.branch.unwrap().switched);
    assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), "refs/heads/hook-fails");
    assert_eq!(repo.read("selected.txt"), "A\n");
    assert_eq!(repo.target(0).expected_oid, target.expected_oid);
}

#[test]
fn custom_baseline_deletion_then_saved_untracked_replacement_restores_without_tracking_it() {
    let repo = Repo::new();
    let original = repo.git(&["rev-parse", "HEAD"]);
    let target = repo.custom_with_untracked(
        &[("selected.txt", None)],
        &[],
        &[(
            "selected.txt",
            Some(("100644", "saved untracked replacement\n")),
        )],
    );
    let result = branch_from_stash(repo.root(), &target, "untracked-replacement").unwrap();
    assert_eq!(result.outcome, Outcome::Success, "{result:?}");
    assert_eq!(result.stash_state, State::Removed);
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), original);
    assert!(!repo
        .output(&["show", ":selected.txt"], None, None)
        .status
        .success());
    assert_eq!(repo.read("selected.txt"), "saved untracked replacement\n");
    assert_eq!(
        repo.git(&["diff", "--cached", "--name-status"]),
        "D\tselected.txt"
    );
}

#[test]
fn custom_binary_context_is_seeded_and_restored_by_git_without_text_conversion() {
    let repo = Repo::new();
    repo.write("selected.txt", "A\0original\n");
    repo.git(&["add", "selected.txt"]);
    repo.git(&["commit", "-qm", "binary original"]);
    let target = repo.custom(
        &[("selected.txt", Some(("100644", "B\0baseline\n")))],
        &[("selected.txt", Some(("100644", "A\0original\n")))],
    );
    let result = branch_from_stash(repo.root(), &target, "binary-context").unwrap();
    assert_eq!(result.outcome, Outcome::Success, "{result:?}");
    assert_eq!(repo.git(&["show", ":selected.txt"]), "B\0baseline");
    assert_eq!(repo.read("selected.txt"), "A\0original\n");
}

#[test]
fn diff_display_configuration_cannot_corrupt_context_patch() {
    let repo = Repo::new();
    let target = repo.inverse();
    repo.git(&["config", "color.ui", "always"]);
    repo.git(&["config", "diff.context", "0"]);
    let result = branch_from_stash(repo.root(), &target, "display-config").unwrap();
    assert_eq!(result.outcome, Outcome::Success, "{result:?}");
    assert_eq!(repo.git(&["show", ":selected.txt"]), "B");
    assert_eq!(repo.read("selected.txt"), "A\n");
}

#[test]
fn explicit_index_policy_overrides_stash_configuration() {
    for action in ["apply", "pop", "branch"] {
        let repo = Repo::new();
        repo.write("selected.txt", "saved staged\n");
        repo.git(&["add", "selected.txt"]);
        let target = repo.stash("selected.txt", "saved worktree\n");
        repo.git(&[
            "config",
            "stash.index",
            if action == "branch" { "false" } else { "true" },
        ]);
        let result = match action {
            "apply" => apply_stash(repo.root(), &target),
            "pop" => pop_stash(repo.root(), &target),
            _ => branch_from_stash(repo.root(), &target, "explicit-index"),
        }
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{action}: {result:?}");
        assert_eq!(
            repo.git(&["show", ":selected.txt"]),
            if action == "branch" {
                "saved staged"
            } else {
                "A"
            }
        );
        assert_eq!(repo.read("selected.txt"), "saved worktree\n");
        assert_eq!(
            result.stash_state,
            if action == "apply" {
                State::Retained
            } else {
                State::Removed
            }
        );
    }
}

#[test]
fn symbolic_branch_refs_including_dangling_are_rejected_without_mutation() {
    for destination in ["other-unborn", "existing"] {
        let repo = Repo::new();
        let target = repo.inverse();
        let head = repo.git(&["symbolic-ref", "HEAD"]);
        if destination == "existing" {
            repo.git(&["branch", destination]);
        }
        let reference = format!("refs/heads/{destination}");
        repo.git(&["symbolic-ref", "refs/heads/requested", &reference]);
        let refs = repo.git(&["for-each-ref", "--format=%(refname) %(objectname)"]);
        assert!(matches!(
            branch_from_stash(repo.root(), &target, "requested"),
            Err(StashError::Invalid(_))
        ));
        assert_eq!(
            repo.git(&["symbolic-ref", "--no-recurse", "refs/heads/requested"]),
            reference
        );
        assert_eq!(
            repo.git(&["for-each-ref", "--format=%(refname) %(objectname)"]),
            refs
        );
        assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), head);
        assert_eq!(repo.read("selected.txt"), "A\n");
        assert_eq!(repo.git(&["show", ":selected.txt"]), "A");
        assert_eq!(repo.target(0).expected_oid, target.expected_oid);
    }
}

#[test]
fn concurrent_branch_ref_creation_is_preserved_including_dangling_symbolic_ref() {
    for symbolic in [false, true] {
        let repo = Repo::new();
        let target = repo.inverse();
        let head = repo.git(&["symbolic-ref", "HEAD"]);
        // Clean filters run during context preflight, after branch validation.
        repo.write(".git/info/attributes", "selected.txt filter=create-ref\n");
        repo.git(&["config", "filter.create-ref.clean", if symbolic {
            "if test ! -f .git/ref-created; then touch .git/ref-created; git symbolic-ref refs/heads/requested refs/heads/other-unborn; fi; cat"
        } else {
            "if test ! -f .git/ref-created; then touch .git/ref-created; git update-ref refs/heads/requested HEAD; fi; cat"
        }]);
        let result = branch_from_stash(repo.root(), &target, "requested").unwrap();
        assert!(repo.0.path().join(".git/ref-created").exists());
        assert_eq!(result.outcome, Outcome::Partial, "{symbolic}: {result:?}");
        assert_eq!(result.error, Some(StashActionFailure::BranchCreationFailed));
        assert_eq!(result.restore, Restore::NotAttempted);
        assert_eq!(result.stash_state, State::Retained);
        assert!(result.branch.is_none());
        assert!(!repo
            .0
            .path()
            .join(".git/refs/heads/requested.lock")
            .exists());
        if symbolic {
            assert_eq!(
                repo.git(&["symbolic-ref", "refs/heads/requested"]),
                "refs/heads/other-unborn"
            );
            assert!(!repo
                .output(
                    &["show-ref", "--verify", "refs/heads/other-unborn"],
                    None,
                    None
                )
                .status
                .success());
        } else {
            assert_eq!(
                repo.git(&["rev-parse", "requested"]),
                repo.git(&["rev-parse", "HEAD"])
            );
        }
        assert_eq!(repo.git(&["symbolic-ref", "HEAD"]), head);
        assert_eq!(repo.read("selected.txt"), "A\n");
        assert_eq!(repo.target(0).expected_oid, target.expected_oid);
    }
}

#[test]
fn custom_branch_from_clean_advanced_head_returns_to_original_before_seeding() {
    let repo = Repo::new();
    let original = repo.git(&["rev-parse", "HEAD"]);
    let target = repo.inverse();
    repo.write("selected.txt", "C\n");
    repo.git(&["add", "selected.txt"]);
    repo.git(&["commit", "-qm", "advanced selected path"]);
    repo.write("other.txt", "unrelated staged\n");
    repo.git(&["add", "other.txt"]);
    repo.write("other.txt", "unrelated worktree\n");
    let result = branch_from_stash(repo.root(), &target, "advanced-inverse").unwrap();
    assert_eq!(result.outcome, Outcome::Success, "{result:?}");
    assert_eq!(result.stash_state, State::Removed);
    assert!(result.branch.unwrap().switched);
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), original);
    assert_eq!(repo.git(&["show", ":selected.txt"]), "B");
    assert_eq!(repo.read("selected.txt"), "A\n");
    assert_eq!(repo.git(&["show", ":other.txt"]), "unrelated staged");
    assert_eq!(repo.read("other.txt"), "unrelated worktree\n");
}

#[test]
fn advanced_head_context_preflight_still_rejects_staged_unstaged_and_mode_edits() {
    for edit in ["staged", "unstaged", "filtered", "mode"] {
        let repo = Repo::new();
        let target = repo.inverse();
        repo.write("selected.txt", "C\n");
        repo.git(&["add", "selected.txt"]);
        repo.git(&["commit", "-qm", "advanced selected path"]);
        if edit == "mode" {
            repo.git(&["update-index", "--chmod=+x", "selected.txt"]);
        } else {
            repo.write("selected.txt", "foreign edit\n");
            if edit == "staged" {
                repo.git(&["add", "selected.txt"]);
                repo.write("selected.txt", "C\n");
            } else if edit == "filtered" {
                // Raw bytes match HEAD, but Git's clean result does not.
                repo.write("selected.txt", "C\n");
                repo.write(".git/info/attributes", "selected.txt filter=dirty\n");
                repo.git(&[
                    "config",
                    "filter.dirty.clean",
                    "printf 'filtered foreign edit\\n'; cat > /dev/null",
                ]);
            }
        }
        let head = repo.git(&["rev-parse", "HEAD"]);
        let index = repo.git(&["write-tree"]);
        let contents = repo.read("selected.txt");
        assert!(
            matches!(
                branch_from_stash(repo.root(), &target, "dirty-advanced"),
                Err(StashError::Invalid(_))
            ),
            "{edit}"
        );
        assert_eq!(repo.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(repo.git(&["write-tree"]), index);
        assert_eq!(repo.read("selected.txt"), contents);
        assert!(!repo
            .output(
                &["show-ref", "--verify", "refs/heads/dirty-advanced"],
                None,
                None
            )
            .status
            .success());
        assert_eq!(repo.target(0).expected_oid, target.expected_oid);
    }
}
