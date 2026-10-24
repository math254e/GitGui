//! Executable format proof, not selected-push/action implementations. All Git
//! mutations below run inside fresh temporary repositories. Keep this fixture
//! independent of protocol types and the future three stash operation modules.
use std::{
    fs,
    io::Write,
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

const ENCODING: &str = "gitgui-stash-encoding selected-unstaged-v1";

struct Repo(TempDir);

impl Repo {
    fn new() -> Self {
        let repo = Self(tempfile::tempdir().unwrap());
        repo.git(&["init", "-q"]);
        repo.git(&["config", "user.name", "Stash fixture"]);
        repo.git(&["config", "user.email", "stash@example.invalid"]);
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.write("selected.txt", "A\n");
        repo.write("unrelated.txt", "original\n");
        repo.git(&["add", "--", "selected.txt", "unrelated.txt"]);
        repo.git(&["commit", "-qm", "original HEAD"]);
        repo
    }

    fn output(&self, args: &[&str], input: Option<&str>) -> Output {
        let mut command = Command::new("git");
        command
            .current_dir(self.0.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.0.path().join("absent-config"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        // Close stdin before waiting, including commands with no input.
        drop(child.stdin.take());
        child.wait_with_output().unwrap()
    }

    fn git_input(&self, args: &[&str], input: Option<&str>) -> String {
        let output = self.output(args, input);
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end()
            .to_string()
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_input(args, None)
    }

    fn write(&self, path: &str, content: &str) {
        fs::write(self.0.path().join(path), content).unwrap();
    }

    fn commit(&self, tree: &str, parents: &[&str], header: Option<&str>, message: &str) -> String {
        let mut raw = format!("tree {tree}\n");
        for parent in parents {
            raw.push_str(&format!("parent {parent}\n"));
        }
        raw.push_str("author Stash fixture <stash@example.invalid> 1700000000 +0000\n");
        raw.push_str("committer Stash fixture <stash@example.invalid> 1700000000 +0000\n");
        if let Some(header) = header {
            raw.push_str(header);
            raw.push('\n');
        }
        raw.push_str(&format!("\n{message}\n"));
        self.git_input(
            &["hash-object", "-w", "-t", "commit", "--stdin"],
            Some(&raw),
        )
    }

    // Construct trees with an isolated index: the repository's real index,
    // including unrelated staged content, is never used as a snapshot tree.
    fn tree_with(&self, base: &str, changes: &[(&str, Option<&str>)]) -> String {
        let index = self.0.path().join(".git").join("fixture-index");
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(self.0.path())
                .env("GIT_INDEX_FILE", &index)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout)
                .unwrap()
                .trim_end()
                .to_string()
        };
        run(&["read-tree", base]);
        for (path, contents) in changes {
            if let Some(contents) = contents {
                let blob = self.git_input(&["hash-object", "-w", "--stdin"], Some(contents));
                run(&[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    "100644",
                    &blob,
                    path,
                ]);
            } else {
                run(&["update-index", "--force-remove", "--", path]);
            }
        }
        run(&["write-tree"])
    }

    fn assert_inverse(&self) {
        assert_eq!(self.git(&["show", ":selected.txt"]), "B");
        assert_eq!(
            fs::read_to_string(self.0.path().join("selected.txt")).unwrap(),
            "A\n"
        );
        assert_eq!(self.git(&["show", ":unrelated.txt"]), "other staged");
        assert_eq!(
            fs::read_to_string(self.0.path().join("unrelated.txt")).unwrap(),
            "other worktree\n"
        );
        assert_eq!(
            self.git(&["diff", "--name-only"]),
            "selected.txt\nunrelated.txt"
        );
    }
}

struct Saved {
    original: String,
    baseline: String,
    stash: String,
}

fn save_inverse(repo: &Repo, untracked: bool) -> Saved {
    let original = repo.git(&["rev-parse", "HEAD"]);
    repo.write("selected.txt", "B\n");
    repo.write("unrelated.txt", "other staged\n");
    repo.git(&["add", "--", "selected.txt", "unrelated.txt"]);
    repo.write("selected.txt", "A\n");
    repo.write("unrelated.txt", "other worktree\n");
    let before_index = repo.git(&["write-tree"]);
    let tree = repo.tree_with(&original, &[("selected.txt", Some("B\n"))]);
    let baseline = repo.commit(&tree, &[&original], None, "selected index baseline");
    let index = repo.commit(&tree, &[&baseline], None, "selected index");
    let worktree = repo.tree_with(&baseline, &[("selected.txt", Some("A\n"))]);
    let untracked_commit = if untracked {
        repo.write("new file.txt", "untracked\n");
        let empty = repo.git_input(&["mktree"], Some(""));
        let tree = repo.tree_with(&empty, &[("new file.txt", Some("untracked\n"))]);
        Some(repo.commit(&tree, &[], None, "selected untracked"))
    } else {
        None
    };
    let mut parents = vec![baseline.as_str(), index.as_str()];
    if let Some(untracked) = untracked_commit.as_deref() {
        parents.push(untracked);
    }
    let stash = repo.commit(&worktree, &parents, Some(ENCODING), "On main: inverse");
    repo.git(&["stash", "store", "-m", "inverse", &stash]);
    let raw = repo.git(&["cat-file", "commit", &stash]);
    let (headers, _) = raw.split_once("\n\n").unwrap();
    assert_eq!(headers.lines().filter(|line| *line == ENCODING).count(), 1);
    assert_eq!(repo.git(&["rev-parse", &format!("{stash}^1^1")]), original);
    assert_eq!(repo.git(&["rev-parse", &format!("{stash}^2^1")]), baseline);
    assert_eq!(
        repo.git(&["rev-parse", &format!("{stash}^2^{{tree}}")]),
        tree
    );
    assert_eq!(repo.git(&["write-tree"]), before_index);
    repo.assert_inverse();
    // Proof cleanup: change only the selected worktree to its saved index.
    // Production cleanup needs race/error checks; this is a fixed fixture.
    repo.git(&["restore", "--worktree", "--", "selected.txt"]);
    if untracked {
        fs::remove_file(repo.0.path().join("new file.txt")).unwrap();
    }
    assert_eq!(repo.git(&["write-tree"]), before_index);
    assert_eq!(repo.git(&["diff", "--name-only"]), "unrelated.txt");
    assert_eq!(
        repo.git(&["show", &format!("{baseline}:unrelated.txt")]),
        "original"
    );
    assert_eq!(
        repo.git(&["show", &format!("{stash}:unrelated.txt")]),
        "original"
    );
    Saved {
        original,
        baseline,
        stash,
    }
}

#[test]
fn inverse_is_visible_and_native_apply_preserves_staging_and_untracked() {
    for with_index in [false, true] {
        let repo = Repo::new();
        let saved = save_inverse(&repo, true);
        // Original-HEAD inspection would hide the inverse entirely.
        assert!(repo
            .git(&["diff", &saved.original, &saved.stash])
            .is_empty());
        let patch = repo.git(&["stash", "show", "-p", "--include-untracked", &saved.stash]);
        assert!(patch.contains("-B\n+A"), "{patch}");
        assert!(patch.contains("+untracked"), "{patch}");
        let args = if with_index {
            vec!["stash", "apply", "--index", saved.stash.as_str()]
        } else {
            vec!["stash", "apply", saved.stash.as_str()]
        };
        repo.git(&args);
        repo.assert_inverse();
        assert_eq!(repo.git(&["rev-parse", "HEAD"]), saved.original);
        assert_eq!(repo.git(&["rev-parse", "refs/stash"]), saved.stash);
        assert_eq!(
            fs::read_to_string(repo.0.path().join("new file.txt")).unwrap(),
            "untracked\n"
        );
        repo.git(&["fsck", "--no-reflogs"]);
    }
}

#[test]
fn original_head_branch_seeds_only_selected_baseline_then_restores_inverse() {
    let repo = Repo::new();
    let saved = save_inverse(&repo, true);
    // Start selected path clean at H; unrelated staged/worktree changes remain.
    repo.git(&[
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        "selected.txt",
    ]);
    repo.git(&["switch", "-c", "original-base", &saved.original]);
    // Derive prerequisite paths from H..B, never seed the unrelated index.
    assert_eq!(
        repo.git(&["diff", "--name-only", &saved.original, &saved.baseline]),
        "selected.txt"
    );
    repo.git(&[
        "restore",
        &format!("--source={}", saved.baseline),
        "--staged",
        "--worktree",
        "--",
        "selected.txt",
    ]);
    repo.git(&["stash", "apply", "--index", &saved.stash]);
    repo.assert_inverse();
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), saved.original);
    assert_eq!(repo.git(&["branch", "--show-current"]), "original-base");
    repo.git(&["stash", "drop", "stash@{0}"]);
    assert!(repo.git(&["stash", "list"]).is_empty());
}

#[test]
fn native_branch_uses_synthetic_baseline_a_documented_divergence() {
    let repo = Repo::new();
    let saved = save_inverse(&repo, false);
    repo.git(&[
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        "selected.txt",
        "unrelated.txt",
    ]);
    repo.git(&["stash", "branch", "native-base", "stash@{0}"]);
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), saved.baseline);
    assert_ne!(saved.baseline, saved.original);
    assert_eq!(repo.git(&["show", ":selected.txt"]), "B");
    assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "");
    assert!(repo.git(&["diff", "--", "selected.txt"]).contains("-B\n+A"));
}

#[test]
fn native_apply_at_original_head_cannot_reconstruct_inverse_without_context() {
    let repo = Repo::new();
    let saved = save_inverse(&repo, false);
    repo.git(&[
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        "selected.txt",
        "unrelated.txt",
    ]);
    repo.git(&["stash", "apply", "--index", &saved.stash]);
    // A->A is already applied according to Git; only branch baseline seeding
    // can restore index B/worktree A at original HEAD A.
    assert_eq!(repo.git(&["show", ":selected.txt"]), "A");
    let status = repo.git(&["status", "--porcelain"]);
    assert!(status.is_empty(), "{status}");
}

#[test]
fn staged_only_uses_ordinary_head_baseline_and_excludes_unrelated_index() {
    let repo = Repo::new();
    let original = repo.git(&["rev-parse", "HEAD"]);
    repo.write("selected.txt", "B\n");
    repo.write("unrelated.txt", "other staged\n");
    repo.git(&["add", "--", "selected.txt", "unrelated.txt"]);
    repo.write("selected.txt", "unstaged\n");
    let selected = repo.tree_with(&original, &[("selected.txt", Some("B\n"))]);
    let index = repo.commit(&selected, &[&original], None, "selected staged index");
    let stash = repo.commit(
        &selected,
        &[&original, &index],
        None,
        "On main: staged only",
    );
    let patch = repo.git(&["stash", "show", "-p", &stash]);
    assert!(patch.contains("-A\n+B"));
    assert!(!patch.contains("unstaged"));
    assert!(!patch.contains("unrelated.txt"));
    // No production staged cleanup is implemented by this format proof.
    repo.git(&[
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        "selected.txt",
        "unrelated.txt",
    ]);
    repo.git(&["stash", "apply", "--index", &stash]);
    assert_eq!(repo.git(&["show", ":selected.txt"]), "B");
    assert!(repo.git(&["diff", "--name-only"]).is_empty());
    assert_eq!(
        repo.git(&["diff", "--cached", "--name-only"]),
        "selected.txt"
    );
}

#[test]
fn external_stash_message_marker_does_not_change_native_parent_meaning() {
    let repo = Repo::new();
    let original = repo.git(&["rev-parse", "HEAD"]);
    repo.write("selected.txt", "B\n");
    repo.git(&["add", "--", "selected.txt"]);
    repo.write("selected.txt", "C\n");
    repo.write("new file.txt", "untracked\n");
    repo.git(&["stash", "push", "-u", "-m", ENCODING]);
    let raw = repo.git(&["cat-file", "commit", "refs/stash"]);
    let (headers, message) = raw.split_once("\n\n").unwrap();
    assert!(!headers
        .lines()
        .any(|line| line.starts_with("gitgui-stash-encoding ")));
    assert!(message.contains(ENCODING));
    assert_eq!(repo.git(&["rev-parse", "refs/stash^1"]), original);
    let patch = repo.git(&["stash", "show", "-p", "--include-untracked"]);
    assert!(patch.contains("-A\n+C"));
    assert!(patch.contains("+untracked"));
    repo.git(&["stash", "apply", "--index"]);
    assert_eq!(repo.git(&["show", ":selected.txt"]), "B");
    assert!(repo.git(&["diff", "--", "selected.txt"]).contains("-B\n+C"));
}

#[test]
fn fetching_only_stash_ref_preserves_baseline_and_original_head_without_sidecars() {
    let source = Repo::new();
    let saved = save_inverse(&source, true);
    let destination = Repo::new();
    destination.git(&[
        "fetch",
        "--no-tags",
        source.0.path().to_str().unwrap(),
        "refs/stash:refs/stash",
    ]);
    // Resolve everything from the fetched ref rather than fixture memory.
    let raw = destination.git(&["cat-file", "commit", "refs/stash"]);
    assert!(raw
        .split_once("\n\n")
        .unwrap()
        .0
        .lines()
        .any(|line| line == ENCODING));
    let original = destination.git(&["rev-parse", "refs/stash^1^1"]);
    assert_eq!(original, saved.original);
    destination.git(&["switch", "--detach", &original]);
    destination.git(&[
        "restore",
        "--source=refs/stash^1",
        "--staged",
        "--worktree",
        "--",
        "selected.txt",
    ]);
    destination.git(&["stash", "apply", "--index", "refs/stash"]);
    assert_eq!(destination.git(&["show", ":selected.txt"]), "B");
    assert!(destination
        .git(&["diff", "--", "selected.txt"])
        .contains("-B\n+A"));
    assert_eq!(destination.git(&["rev-parse", "HEAD"]), original);
    assert_eq!(
        fs::read_to_string(destination.0.path().join("new file.txt")).unwrap(),
        "untracked\n"
    );
}

#[test]
fn selected_untracked_after_staged_deletion_is_only_in_untracked_tree() {
    let repo = Repo::new();
    let original = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["update-index", "--force-remove", "--", "selected.txt"]);
    repo.write("selected.txt", "untracked replacement\n");
    let tree = repo.tree_with(&original, &[("selected.txt", None)]);
    let baseline = repo.commit(&tree, &[&original], None, "selected index baseline");
    let index = repo.commit(&tree, &[&baseline], None, "selected index");
    let empty = repo.git_input(&["mktree"], Some(""));
    let untracked_tree =
        repo.tree_with(&empty, &[("selected.txt", Some("untracked replacement\n"))]);
    let untracked = repo.commit(&untracked_tree, &[], None, "selected untracked");
    let stash = repo.commit(
        &tree,
        &[&baseline, &index, &untracked],
        Some(ENCODING),
        "On main: untracked replacement",
    );
    assert!(repo.git(&["diff", &baseline, &stash]).is_empty());
    let patch = repo.git(&["stash", "show", "-p", "--include-untracked", &stash]);
    assert!(patch.contains("+untracked replacement"));
    assert!(!patch.contains("-A"));
    let saved_index = repo.git(&["write-tree"]);
    fs::remove_file(repo.0.path().join("selected.txt")).unwrap();
    repo.git(&["stash", "apply", &stash]);
    assert_eq!(repo.git(&["write-tree"]), saved_index);
    assert_eq!(
        repo.git(&["diff", "--cached", "--name-status"]),
        "D\tselected.txt"
    );
    assert_eq!(
        fs::read_to_string(repo.0.path().join("selected.txt")).unwrap(),
        "untracked replacement\n"
    );
}
