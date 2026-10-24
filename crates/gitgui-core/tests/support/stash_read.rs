use super::*;
use crate::git::command::{test_metrics, GitCommand};
use tempfile::TempDir;

struct Repo(TempDir);
impl Repo {
    fn new(format: &str) -> Self {
        let repo = Self(tempfile::tempdir().unwrap());
        repo.git(&["init", "-q", &format!("--object-format={format}")]);
        repo
    }
    fn root(&self) -> &str {
        self.0.path().to_str().unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        GitCommand::run(args, Some(self.0.path()))
            .unwrap()
            .trim()
            .into()
    }
    fn input(&self, args: &[&str], bytes: &[u8]) -> String {
        GitCommand::run_with_stdin(args, Some(self.0.path()), bytes)
            .unwrap()
            .trim()
            .into()
    }
    fn blob(&self, bytes: &[u8]) -> String {
        self.input(&["hash-object", "-w", "--stdin"], bytes)
    }
    fn tree(&self, entries: &[(&str, &str, &str)]) -> String {
        let records = entries
            .iter()
            .map(|(path, mode, oid)| {
                format!(
                    "{mode} {} {oid}\t{path}\0",
                    if *mode == "160000" { "commit" } else { "blob" }
                )
            })
            .collect::<String>();
        self.input(&["mktree", "-z", "--missing"], records.as_bytes())
    }
    fn commit(&self, tree: &str, parents: &[&str], encoding: bool) -> String {
        let mut raw = format!("tree {tree}\n");
        for parent in parents {
            raw.push_str(&format!("parent {parent}\n"));
        }
        raw.push_str("author Test <test@example.invalid> 1234567890 +0000\ncommitter Test <test@example.invalid> 1234567890 +0000\n");
        if encoding {
            raw.push_str(super::super::stash::STASH_ENCODING_HEADER);
            raw.push('\n');
        }
        raw.push_str("\nsaved\n");
        self.input(
            &["hash-object", "-w", "-t", "commit", "--stdin"],
            raw.as_bytes(),
        )
    }
    fn store(&self, oid: &str) -> StashTarget {
        self.git(&[
            "update-ref",
            "--create-reflog",
            "-m",
            "On main: fast fixture",
            "refs/stash",
            oid,
        ]);
        StashTarget {
            selector: "stash@{0}".into(),
            expected_oid: oid.into(),
        }
    }
    fn native(&self, before: &str, after: &str, untracked: Option<&str>) -> String {
        let h = self.commit(before, &[], false);
        let i = self.commit(before, &[&h], false);
        let mut parents = vec![h.as_str(), i.as_str()];
        let u = untracked.map(|tree| self.commit(tree, &[], false));
        if let Some(u) = &u {
            parents.push(u);
        }
        self.commit(after, &parents, false)
    }
}

#[test]
fn native_raw_records_preserve_rename_deletion_type_binary_untracked_and_metadata() {
    let repo = Repo::new("sha1");
    let before = repo.blob(b"before\n");
    let after = repo.blob(b"after\n");
    let renamed = repo.blob(b"distinct renamed content\n");
    let binary = repo.blob(b"before\0binary");
    let binary_after = repo.blob(b"after\0binary");
    let target_text = repo.blob(b"target");
    let base = repo.tree(&[
        ("a.txt", "100644", &before),
        ("deleted.txt", "100644", &before),
        ("old.txt", "100644", &renamed),
        ("binary", "100644", &binary),
        ("kind", "100644", &target_text),
    ]);
    let saved = repo.tree(&[
        ("a.txt", "100644", &after),
        ("new.txt", "100644", &renamed),
        ("binary", "100644", &binary_after),
        ("kind", "120000", &target_text),
    ]);
    let u = repo.tree(&[("new\tline\n.txt", "100644", &after)]);
    let oid = repo.native(&base, &saved, Some(&u));
    let target = repo.store(&oid);
    test_metrics::take();
    let plan = StashReadPlan::load_oid(repo.root(), &oid).unwrap();
    assert_eq!(test_metrics::take().0, 4);
    assert_eq!(plan.files.len(), 6);
    assert_eq!(
        plan.info(repo.root(), &target).unwrap().message,
        "fast fixture"
    );
    let renamed = plan
        .files
        .iter()
        .find(|file| file.path == "new.txt")
        .unwrap();
    assert_eq!(renamed.original_path.as_deref(), Some("old.txt"));
    assert_eq!(renamed.status, "R100");
    assert!(plan
        .files
        .iter()
        .any(|file| file.path == "kind" && file.status == "T"));
    let diff = plan.diff(repo.root(), "a.txt").unwrap();
    assert_eq!(diff.original_content, "before\n");
    assert_eq!(diff.modified_content, "after\n");
    assert_eq!(
        plan.diff(repo.root(), "new.txt")
            .unwrap()
            .original_path
            .as_deref(),
        Some("old.txt")
    );
    assert!(plan.diff(repo.root(), "binary").unwrap().is_binary);
    assert!(plan
        .diff(repo.root(), "deleted.txt")
        .unwrap()
        .modified_content
        .is_empty());
    assert_eq!(
        plan.diff(repo.root(), "kind").unwrap().modified_content,
        "target"
    );
    assert_eq!(
        plan.diff(repo.root(), "new\tline\n.txt")
            .unwrap()
            .modified_content,
        "after\n"
    );
    assert!(plan.diff(repo.root(), "../a.txt").is_err());
    assert!(plan.diff(repo.root(), "not-saved").is_err());
    repo.git(&["update-ref", "-d", "refs/stash"]);
    assert!(matches!(
        plan.info(repo.root(), &target),
        Err(StashError::TargetChanged) | Err(StashError::Invalid(_))
    ));
}

#[test]
fn custom_inverse_uses_synthetic_baseline_and_original_head_for_metadata() {
    let repo = Repo::new("sha256");
    let a = repo.blob(b"A\n");
    let b = repo.blob(b"B\n");
    let a_tree = repo.tree(&[("file", "100644", &a)]);
    let b_tree = repo.tree(&[("file", "100644", &b)]);
    let h = repo.commit(&a_tree, &[], false);
    let p = repo.commit(&b_tree, &[&h], false);
    let i = repo.commit(&b_tree, &[&p], false);
    let w = repo.commit(&a_tree, &[&p, &i], true);
    let target = repo.store(&w);
    test_metrics::take();
    let plan = StashReadPlan::load_oid(repo.root(), &w).unwrap();
    assert_eq!(test_metrics::take().0, 4);
    assert_eq!(plan.layout.original_head_oid, h);
    assert_eq!(plan.info(repo.root(), &target).unwrap().base_hash, h);
    assert_eq!(plan.files.len(), 1);
    let diff = plan.diff(repo.root(), "file").unwrap();
    assert_eq!(diff.original_content, "B\n");
    assert_eq!(diff.modified_content, "A\n");
}

#[test]
fn foreground_cost_is_independent_of_unchanged_files_and_blobs_are_not_audited() {
    let repo = Repo::new("sha1");
    let unchanged = repo.blob(b"unchanged\n");
    let before = repo.blob(b"before\n");
    let after = repo.blob(b"after\n");
    for count in [0, 1000] {
        let names = (0..count)
            .map(|n| format!("unchanged-{n:04}"))
            .collect::<Vec<_>>();
        let mut entries = names
            .iter()
            .map(|name| (name.as_str(), "100644", unchanged.as_str()))
            .collect::<Vec<_>>();
        entries.push(("selected", "100644", &before));
        let base = repo.tree(&entries);
        entries.last_mut().unwrap().2 = &after;
        let saved = repo.tree(&entries);
        let oid = repo.native(&base, &saved, None);
        if count > 0 {
            std::fs::remove_file(
                repo.0
                    .path()
                    .join(".git/objects")
                    .join(&unchanged[..2])
                    .join(&unchanged[2..]),
            )
            .unwrap();
        }
        test_metrics::take();
        let plan = StashReadPlan::load_oid(repo.root(), &oid).unwrap();
        assert_eq!(test_metrics::take().0, 3);
        assert_eq!(plan.files.len(), 1);
        assert_eq!(
            plan.diff(repo.root(), "selected").unwrap().modified_content,
            "after\n"
        );
        assert!(plan.retained_bytes() < 4096);
    }
}

#[test]
fn malformed_records_and_literal_noncommit_stashes_are_rejected() {
    let oid = "1".repeat(40);
    let zero = "0".repeat(40);
    for raw in [
        format!(":000000 100644 {zero} {oid} A\0../escape\0"),
        format!(":000000 100644 {zero} {oid} A\0file"),
        format!(":000000 100644 {zero} {oid} Z\0file\0"),
        format!(":000000 100644 {zero} {oid} A\0file\0:000000 100644 {zero} {oid} A\0file\0"),
        format!(":100644 100644 {oid} {oid} R101\0old\0new\0"),
    ] {
        assert!(parse_changes(raw.as_bytes(), 40).is_err(), "{raw:?}");
    }
    let repo = Repo::new("sha1");
    let tree = repo.tree(&[]);
    let commit = repo.commit(&tree, &[], false);
    assert!(StashReadPlan::load_oid(repo.root(), &commit).is_err());
    let tag = repo.input(&["hash-object", "-w", "-t", "tag", "--stdin"], format!("object {commit}\ntype commit\ntag saved\ntagger Test <test@example.invalid> 1234567890 +0000\n\ntag\n").as_bytes());
    assert!(StashReadPlan::load_oid(repo.root(), &tag).is_err());
}

#[test]
fn saved_gitlinks_do_not_read_external_commit_objects() {
    let repo = Repo::new("sha1");
    let old = "1".repeat(40);
    let new = "2".repeat(40);
    let base = repo.tree(&[("sub", "160000", &old)]);
    let saved = repo.tree(&[("sub", "160000", &new)]);
    let oid = repo.native(&base, &saved, None);
    repo.git(&["config", "diff.ignoreSubmodules", "all"]);
    let plan = StashReadPlan::load_oid(repo.root(), &oid).unwrap();
    let diff = plan.diff(repo.root(), "sub").unwrap();
    assert!(diff.message.unwrap().contains("Submodule"));
}

#[test]
fn display_metadata_batches_native_and_custom_entries_without_reading_saved_trees() {
    let repo = Repo::new("sha1");
    assert!(list_stashes_for_display(repo.root()).unwrap().is_empty());
    let a = repo.blob(b"A\n");
    let b = repo.blob(b"B\n");
    let a_tree = repo.tree(&[("file", "100644", &a)]);
    let b_tree = repo.tree(&[("file", "100644", &b)]);
    let native = repo.native(&a_tree, &b_tree, None);
    repo.store(&native);
    let h = repo.commit(&a_tree, &[], false);
    let p = repo.commit(&b_tree, &[&h], false);
    let i = repo.commit(&b_tree, &[&p], false);
    let custom = repo.commit(&a_tree, &[&p, &i], true);
    repo.store(&custom);
    let invalid = repo.commit(&a_tree, &[&h], false);
    repo.store(&invalid);
    // Missing saved trees are deliberately left to background verification.
    std::fs::remove_file(
        repo.0
            .path()
            .join(".git/objects")
            .join(&a_tree[..2])
            .join(&a_tree[2..]),
    )
    .unwrap();
    test_metrics::take();
    let entries = list_stashes_for_display(repo.root()).unwrap();
    assert_eq!(test_metrics::take().0, 4);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].0.selector, "stash@{1}");
    assert_eq!(entries[0].0.hash, custom);
    assert_eq!(entries[0].0.base_hash, h);
    assert_eq!(entries[1].0.selector, "stash@{2}");
    assert_eq!(entries[1].0.hash, native);
}

#[test]
fn stale_reindexed_metadata_is_rejected_and_display_omits_wrong_parent_types() {
    let repo = Repo::new("sha1");
    let blob = repo.blob(b"content\n");
    let tree = repo.tree(&[("file", "100644", &blob)]);
    let oid = repo.native(&tree, &tree, None);
    let target = repo.store(&oid);
    let plan = StashReadPlan::load_oid(repo.root(), &oid).unwrap();
    let h = repo.commit(&tree, &[], false);
    let bad = repo.commit(&tree, &[&h, &blob], false);
    repo.store(&bad);
    assert!(matches!(
        plan.info(repo.root(), &target),
        Err(StashError::TargetChanged)
    ));
    assert!(StashReadPlan::load_oid(repo.root(), &bad).is_err());
    let listed = list_stashes_for_display(repo.root()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].0.selector, "stash@{1}");
}

#[test]
fn display_isolates_oversized_commit_and_wrong_type_parent_from_healthy_entries() {
    let repo = Repo::new("sha1");
    let blob = repo.blob(b"content\n");
    let tree = repo.tree(&[("file", "100644", &blob)]);
    let h = repo.commit(&tree, &[], false);
    let i = repo.commit(&tree, &[&h], false);
    repo.git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    repo.git(&["update-ref", "refs/heads/main", &h]);
    let healthy = repo.native(&tree, &tree, None);
    repo.store(&healthy);
    let mut oversized = format!("tree {tree}\nparent {h}\nparent {i}\nauthor Test <test@example.invalid> 1234567890 +0000\ncommitter Test <test@example.invalid> 1234567890 +0000\n\n").into_bytes();
    oversized.resize(4 * COMMIT_LIMIT, b'x');
    let oversized = repo.input(
        &["hash-object", "-w", "-t", "commit", "--stdin"],
        &oversized,
    );
    repo.store(&oversized);
    let wrong_type = repo.blob(&vec![b'x'; 2 * COMMIT_LIMIT]);
    let wrong_parent = repo.commit(&tree, &[&h, &wrong_type], false);
    repo.store(&wrong_parent);
    let listed = list_stashes_for_display(repo.root()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].0.hash, healthy);
    assert_eq!(listed[0].0.selector, "stash@{2}");
    let snapshot = crate::git::repository::load_repository_for_display(repo.root()).unwrap();
    assert_eq!(snapshot.stashes.len(), 1);
    assert_eq!(snapshot.stashes[0].hash, healthy);
    assert_eq!(snapshot.stashes[0].selector, "stash@{2}");
}
