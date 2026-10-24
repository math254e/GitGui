//! Isolated object fixtures exercise the production decoder, loader and inspector.
use gitgui_core::git::{
    command::GitCommand,
    repository::load_repository,
    stash::{
        decode_stash, list_stashes, read_stash_info, resolve_stash, StashEncoding, StashError,
        StashTarget, STASH_ENCODING_HEADER,
    },
    stash_inspection::{list_stash_files, load_stash_file_diff, STASH_CONTENT_LIMIT},
    stash_inspection_cache::{StashInspectionCache, StashValidation},
};
use std::fs;
use tempfile::TempDir;

struct Repo {
    dir: TempDir,
    head: String,
    tree: String,
}

fn cached_fixture(repo: &Repo) -> StashTarget {
    let tree = repo.tree(&[
        ("selected.txt", b"saved\n"),
        ("unrelated.txt", b"original\n"),
    ]);
    let i = repo.commit(&repo.tree, &[&repo.head], None, "saved index");
    let u_tree = repo.tree(&[("new.txt", b"saved untracked\n")]);
    let u = repo.commit(&u_tree, &[], None, "saved untracked");
    let w = repo.commit(&tree, &[&repo.head, &i, &u], None, "saved worktree");
    repo.store(&w, "On main: cache fixture")
}

#[test]
fn cached_inspection_keeps_reflog_labels_fresh_and_rejects_shifted_and_deleted_targets() {
    let repo = Repo::new("sha1");
    let target = cached_fixture(&repo);
    let cache = StashInspectionCache::default();
    assert_eq!(
        cache.files(repo.root(), &target).unwrap().0.message,
        "cache fixture"
    );
    assert_eq!(
        cache
            .diff(repo.root(), &target, "selected.txt")
            .unwrap()
            .modified_content,
        "saved\n"
    );
    // Updating a ref to the same OID is a no-op. Move away and back so Git
    // writes a new reflog label while the reviewed target identity stays equal.
    repo.store(&repo.head, "temporary ref update");
    repo.store(&target.expected_oid, "On main: relabeled entry");
    assert_eq!(
        cache.files(repo.root(), &target).unwrap().0.message,
        "relabeled entry"
    );
    let replacement = repo.commit(
        &repo.tree,
        &[
            &repo.head,
            &repo.commit(&repo.tree, &[&repo.head], None, "index"),
        ],
        None,
        "replacement",
    );
    repo.store(&replacement, "On main: newer");
    assert!(matches!(
        cache.files(repo.root(), &target),
        Err(StashError::TargetChanged)
    ));
    assert!(matches!(
        cache.diff(repo.root(), &target, "selected.txt"),
        Err(StashError::TargetChanged)
    ));
    let moved = StashTarget {
        selector: "stash@{1}".into(),
        ..target.clone()
    };
    assert_eq!(
        cache.files(repo.root(), &moved).unwrap().0.message,
        "relabeled entry"
    );
    // An unqualified selector must never fall through to a branch named stash.
    repo.git(&["branch", "stash", &target.expected_oid]);
    repo.git(&["update-ref", "-d", "refs/stash"]);
    assert!(matches!(
        cache.diff(repo.root(), &target, "selected.txt"),
        Err(StashError::TargetChanged)
    ));
}

#[test]
fn cached_inspection_audits_all_objects_in_background_and_retains_rejections() {
    for kind in ["commit", "tree", "blob"] {
        let repo = Repo::new("sha1");
        let target = cached_fixture(&repo);
        let cache = StashInspectionCache::default();
        cache.files(repo.root(), &target).unwrap();
        cache.diff(repo.root(), &target, "selected.txt").unwrap();
        let oid = match kind {
            "commit" => repo.git(&["rev-parse", &format!("{}^2", target.expected_oid)]),
            "tree" => repo.tree.clone(),
            _ => repo.git(&["rev-parse", "HEAD:unrelated.txt"]),
        };
        let path = repo
            .dir
            .path()
            .join(".git/objects")
            .join(&oid[..2])
            .join(&oid[2..]);
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        // Immutable cached reads do not audit objects unrelated to this view.
        assert_eq!(cache.files(repo.root(), &target).unwrap().1.len(), 2);
        assert_eq!(
            cache
                .diff(repo.root(), &target, "selected.txt")
                .unwrap()
                .modified_content,
            "saved\n"
        );
        assert_eq!(
            cache.validate_cached(repo.root(), &target).unwrap(),
            StashValidation::Rejected,
            "{kind}"
        );
        assert!(cache.is_rejected(repo.root(), &target.expected_oid));
        assert!(cache.files(repo.root(), &target).is_err(), "{kind}");
        assert!(
            cache.diff(repo.root(), &target, "selected.txt").is_err(),
            "{kind}"
        );
        fs::write(&path, bytes).unwrap();
        // One rejected generation never silently becomes a successful read or
        // repeatedly publishes rejection. Explicit eviction permits repair.
        assert_eq!(
            cache.validate_cached(repo.root(), &target).unwrap(),
            StashValidation::Unchanged
        );
        assert!(cache.files(repo.root(), &target).is_err());
        cache.evict_repo(repo.root());
        assert_eq!(cache.files(repo.root(), &target).unwrap().1.len(), 2);
    }
}

#[test]
fn cached_inspection_is_repository_scoped_and_does_not_follow_new_replacement_refs() {
    let first = Repo::new("sha1");
    let second = Repo::new("sha1");
    let target = cached_fixture(&first);
    let other_target = cached_fixture(&second);
    assert_eq!(target.expected_oid, other_target.expected_oid);
    let cache = StashInspectionCache::default();
    cache.files(first.root(), &target).unwrap();
    cache.diff(first.root(), &target, "selected.txt").unwrap();
    first.git(&["replace", &target.expected_oid, &first.head]);
    assert_eq!(
        cache
            .diff(first.root(), &target, "selected.txt")
            .unwrap()
            .modified_content,
        "saved\n"
    );
    let oid = second.git(&["rev-parse", "HEAD:unrelated.txt"]);
    fs::remove_file(
        second
            .dir
            .path()
            .join(".git/objects")
            .join(&oid[..2])
            .join(&oid[2..]),
    )
    .unwrap();
    assert_eq!(
        cache.files(second.root(), &other_target).unwrap().1.len(),
        2
    );
    assert_eq!(
        cache.validate_cached(second.root(), &other_target).unwrap(),
        StashValidation::Rejected
    );
    assert!(cache.files(second.root(), &other_target).is_err());
    assert_eq!(cache.files(first.root(), &target).unwrap().1.len(), 2);
    assert!(cache.diff(first.root(), &target, "unrelated.txt").is_err());
    assert!(cache
        .diff(first.root(), &target, "../selected.txt")
        .is_err());
}

#[test]
fn cached_inspection_reads_selected_objects_lazily_without_poisoning_unrelated_files() {
    let repo = Repo::new("sha1");
    let target = cached_fixture(&repo);
    let cache = StashInspectionCache::default();
    cache.files(repo.root(), &target).unwrap();
    let oid = repo.git(&[
        "rev-parse",
        &format!("{}:selected.txt", target.expected_oid),
    ]);
    let path = repo
        .dir
        .path()
        .join(".git/objects")
        .join(&oid[..2])
        .join(&oid[2..]);
    let bytes = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(cache.diff(repo.root(), &target, "selected.txt").is_err());
    assert_eq!(cache.files(repo.root(), &target).unwrap().1.len(), 2);
    assert_eq!(
        cache
            .diff(repo.root(), &target, "new.txt")
            .unwrap()
            .modified_content,
        "saved untracked\n"
    );
    assert!(!cache.is_rejected(repo.root(), &target.expected_oid));
    fs::write(&path, bytes).unwrap();
    assert_eq!(
        cache
            .diff(repo.root(), &target, "selected.txt")
            .unwrap()
            .modified_content,
        "saved\n"
    );
}

#[test]
fn cached_custom_inspection_preserves_inverse_baseline_and_untracked_content_in_both_oid_formats() {
    for format in ["sha1", "sha256"] {
        let repo = Repo::new(format);
        let u = repo.commit(
            &repo.tree(&[("new.txt", b"saved untracked\n")]),
            &[],
            None,
            "untracked",
        );
        let (target, _, _) = repo.inverse(Some(&u));
        let cache = StashInspectionCache::default();
        let (info, files) = cache.files(repo.root(), &target).unwrap();
        assert_eq!(info.base_hash, repo.head);
        assert_eq!(files.len(), 2);
        for _ in 0..2 {
            let diff = cache.diff(repo.root(), &target, "selected.txt").unwrap();
            assert_eq!(diff.original_content, "B\n");
            assert_eq!(diff.modified_content, "A\n");
            assert_eq!(
                cache
                    .diff(repo.root(), &target, "new.txt")
                    .unwrap()
                    .modified_content,
                "saved untracked\n"
            );
        }
    }
}
impl Repo {
    fn new(format: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Self {
            dir,
            head: String::new(),
            tree: String::new(),
        };
        repo.git(&[
            "init",
            "-q",
            "-b",
            "main",
            &format!("--object-format={format}"),
        ]);
        repo.git(&["config", "user.name", "Inspection fixture"]);
        repo.git(&["config", "user.email", "inspection@example.invalid"]);
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.tree = repo.tree(&[("selected.txt", b"A\n"), ("unrelated.txt", b"original\n")]);
        repo.head = repo.commit(&repo.tree, &[], None, "original HEAD");
        repo.git(&["update-ref", "HEAD", &repo.head]);
        repo.git(&["read-tree", &repo.head]);
        repo.git(&["checkout-index", "-a"]);
        repo
    }
    fn root(&self) -> &str {
        self.dir.path().to_str().unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        GitCommand::run(args, Some(self.dir.path()))
            .unwrap()
            .trim_end()
            .into()
    }
    fn input(&self, args: &[&str], bytes: &[u8]) -> String {
        GitCommand::run_with_stdin(args, Some(self.dir.path()), bytes)
            .unwrap()
            .trim_end()
            .into()
    }
    fn blob(&self, bytes: &[u8]) -> String {
        self.input(&["hash-object", "-w", "--stdin"], bytes)
    }
    fn tree(&self, files: &[(&str, &[u8])]) -> String {
        let mut raw = Vec::new();
        for (path, bytes) in files {
            raw.extend_from_slice(format!("100644 blob {}\t{path}\0", self.blob(bytes)).as_bytes());
        }
        self.input(&["mktree", "-z"], &raw)
    }
    fn raw_tree(&self, entries: &[(&str, &str, &str)]) -> String {
        let mut raw = Vec::new();
        for (mode, name, oid) in entries {
            raw.extend_from_slice(format!("{mode} {name}\0").as_bytes());
            raw.extend(
                (0..oid.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&oid[i..i + 2], 16).unwrap()),
            );
        }
        self.input(
            &["hash-object", "-w", "--literally", "-t", "tree", "--stdin"],
            &raw,
        )
    }
    fn raw(&self, raw: &str) -> String {
        self.input(
            &["hash-object", "-w", "-t", "commit", "--stdin"],
            raw.as_bytes(),
        )
    }
    fn commit(&self, tree: &str, parents: &[&str], header: Option<&str>, message: &str) -> String {
        let mut raw = format!("tree {tree}\n");
        for parent in parents {
            raw.push_str(&format!("parent {parent}\n"));
        }
        raw.push_str("author Inspection fixture <inspection@example.invalid> 1700000000 +0000\ncommitter Inspection fixture <inspection@example.invalid> 1700000000 +0000\n");
        if let Some(header) = header {
            raw.push_str(header);
            raw.push('\n');
        }
        raw.push_str(&format!("\n{message}\n"));
        self.raw(&raw)
    }
    fn store(&self, oid: &str, subject: &str) -> StashTarget {
        self.git(&[
            "update-ref",
            "--create-reflog",
            "-m",
            subject,
            "refs/stash",
            oid,
        ]);
        StashTarget {
            selector: "stash@{0}".into(),
            expected_oid: oid.into(),
        }
    }
    fn tag(&self, oid: &str, kind: &str) -> String {
        self.input(&["hash-object", "-w", "-t", "tag", "--stdin"],
            format!("object {oid}\ntype {kind}\ntag inspection\ntagger Inspection <inspection@example.invalid> 1700000000 +0000\n\ntagged object\n").as_bytes())
    }
    fn inverse(&self, untracked: Option<&str>) -> (StashTarget, String, String) {
        let p_tree = self.tree(&[("selected.txt", b"B\n"), ("unrelated.txt", b"original\n")]);
        let p = self.commit(&p_tree, &[&self.head], None, "patch baseline");
        let i = self.commit(&p_tree, &[&p], None, "saved index");
        let mut parents = vec![p.as_str(), i.as_str()];
        if let Some(u) = untracked {
            parents.push(u);
        }
        let w = self.commit(
            &self.tree,
            &parents,
            Some(STASH_ENCODING_HEADER),
            "saved inverse",
        );
        (self.store(&w, "On main: inverse"), p, i)
    }
}

#[test]
fn custom_inverse_uses_patch_baseline_and_hides_helpers_but_keeps_original_head() {
    let repo = Repo::new("sha1");
    // Live unrelated index/worktree edits are not involved in saved inspection.
    fs::write(repo.dir.path().join("unrelated.txt"), "unrelated staging\n").unwrap();
    repo.git(&["add", "unrelated.txt"]);
    fs::write(repo.dir.path().join("unrelated.txt"), "unrelated working\n").unwrap();
    let u_tree = repo.tree(&[("new file.txt", b"saved untracked\n")]);
    let u = repo.commit(&u_tree, &[], None, "untracked");
    let (target, p, i) = repo.inverse(Some(&u));
    let layout = resolve_stash(repo.root(), &target).unwrap();
    assert_eq!(layout.encoding, StashEncoding::SelectedUnstagedV1);
    assert_eq!(layout.original_head_oid, repo.head);
    assert_eq!(layout.baseline_oid, p);
    let info = read_stash_info(repo.root(), &target).unwrap();
    assert_eq!(info.base_hash, repo.head);
    assert_eq!(info.message, "inverse");
    let files = list_stash_files(repo.root(), &target).unwrap();
    assert_eq!(files.len(), 2);
    assert!(files
        .iter()
        .any(|f| f.path == "selected.txt" && f.status == "M"));
    assert!(!files.iter().any(|f| f.path == "unrelated.txt"));
    let diff = load_stash_file_diff(repo.root(), &target, "selected.txt").unwrap();
    assert_eq!(diff.original_content, "B\n");
    assert_eq!(diff.modified_content, "A\n");
    assert!(diff.patch.unwrap().contains("-B\n+A"));
    let diff = load_stash_file_diff(repo.root(), &target, "new file.txt").unwrap();
    assert_eq!(diff.original_content, "");
    assert_eq!(diff.modified_content, "saved untracked\n");
    assert!(load_stash_file_diff(repo.root(), &target, "unrelated.txt").is_err());
    let snapshot = load_repository(repo.root()).unwrap();
    assert_eq!(snapshot.stashes.len(), 1);
    assert_eq!(snapshot.stashes[0].base_hash, repo.head);
    for helper in [&p, &i, &u] {
        assert!(!snapshot.commits.iter().any(|c| &c.hash == helper));
    }
    assert!(snapshot.commits.iter().any(|c| c.hash == repo.head));
    assert!(snapshot
        .commits
        .iter()
        .any(|c| c.hash == target.expected_oid));
    assert!(snapshot
        .graph
        .edges
        .iter()
        .any(|edge| edge.from == target.expected_oid && edge.to == repo.head));
    assert_eq!(repo.git(&["show", ":unrelated.txt"]), "unrelated staging");
    assert_eq!(
        fs::read_to_string(repo.dir.path().join("unrelated.txt")).unwrap(),
        "unrelated working\n"
    );
}

#[test]
fn native_external_stash_preserves_staged_unstaged_untracked_and_message_markers() {
    let repo = Repo::new("sha1");
    fs::write(repo.dir.path().join("selected.txt"), "staged\n").unwrap();
    repo.git(&["add", "selected.txt"]);
    fs::write(repo.dir.path().join("selected.txt"), "working\n").unwrap();
    fs::write(repo.dir.path().join("new.txt"), "new\n").unwrap();
    repo.git(&["stash", "push", "-u", "-m", STASH_ENCODING_HEADER]);
    let target = StashTarget {
        selector: "stash@{0}".into(),
        expected_oid: repo.git(&["rev-parse", "refs/stash"]),
    };
    assert_eq!(
        resolve_stash(repo.root(), &target).unwrap().encoding,
        StashEncoding::Native
    );
    let files = list_stash_files(repo.root(), &target).unwrap();
    assert_eq!(files.len(), 2);
    let diff = load_stash_file_diff(repo.root(), &target, "selected.txt").unwrap();
    assert_eq!(diff.original_content, "A\n");
    assert_eq!(diff.modified_content, "working\n");
    assert_eq!(list_stashes(repo.root()).unwrap().len(), 1);
}

#[test]
fn native_inverse_keeps_native_baseline_semantics_and_custom_inverse_remains_visible() {
    let repo = Repo::new("sha1");
    let index_tree = repo.tree(&[("selected.txt", b"B\n"), ("unrelated.txt", b"original\n")]);
    let i = repo.commit(&index_tree, &[&repo.head], None, "index B");
    let w = repo.commit(&repo.tree, &[&repo.head, &i], None, "native inverse");
    let native = repo.store(&w, "native inverse");
    assert_eq!(
        resolve_stash(repo.root(), &native).unwrap().baseline_oid,
        repo.head
    );
    // Native combined inspection is H -> W, which has no net tracked change.
    assert!(list_stash_files(repo.root(), &native).unwrap().is_empty());
    let (custom, _, _) = repo.inverse(None);
    assert_eq!(list_stash_files(repo.root(), &custom).unwrap().len(), 1);
    let inverse = load_stash_file_diff(repo.root(), &custom, "selected.txt").unwrap();
    assert_eq!(
        (
            inverse.original_content.as_str(),
            inverse.modified_content.as_str()
        ),
        ("B\n", "A\n")
    );
}

#[test]
fn selected_untracked_only_layout_adds_no_baseline_context_to_the_file_list() {
    let repo = Repo::new("sha1");
    let p = repo.commit(&repo.tree, &[&repo.head], None, "baseline");
    let i = repo.commit(&repo.tree, &[&p], None, "index");
    let u_tree = repo.tree(&[("only new.txt", b"new\n")]);
    let u = repo.commit(&u_tree, &[], None, "untracked");
    let w = repo.commit(
        &repo.tree,
        &[&p, &i, &u],
        Some(STASH_ENCODING_HEADER),
        "untracked only",
    );
    let target = repo.store(&w, "untracked only");
    let files = list_stash_files(repo.root(), &target).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(
        (files[0].path.as_str(), files[0].status.as_str()),
        ("only new.txt", "A")
    );
}

#[test]
fn selectors_are_exact_full_oid_reviewed_and_stale_or_missing_is_distinct() {
    let repo = Repo::new("sha1");
    let (target, _, _) = repo.inverse(None);
    for selector in [
        "HEAD",
        "stash",
        "stash@{0}^1",
        "stash@{00}",
        "stash@{-1}",
        "stash@{0}\n",
    ] {
        assert!(matches!(
            resolve_stash(
                repo.root(),
                &StashTarget {
                    selector: selector.into(),
                    ..target.clone()
                }
            ),
            Err(StashError::Invalid(_))
        ));
    }
    for oid in [&target.expected_oid[..8], "--help"] {
        assert!(matches!(
            resolve_stash(
                repo.root(),
                &StashTarget {
                    expected_oid: oid.into(),
                    ..target.clone()
                }
            ),
            Err(StashError::Invalid(_))
        ));
    }
    assert!(matches!(
        resolve_stash(
            repo.root(),
            &StashTarget {
                expected_oid: repo.head.clone(),
                ..target.clone()
            }
        ),
        Err(StashError::TargetChanged)
    ));
    assert!(matches!(
        resolve_stash(
            repo.root(),
            &StashTarget {
                selector: "stash@{1}".into(),
                ..target.clone()
            }
        ),
        Err(StashError::TargetChanged)
    ));
    repo.git(&["update-ref", "-d", "refs/stash"]);
    assert!(matches!(
        resolve_stash(repo.root(), &target),
        Err(StashError::TargetChanged)
    ));
}

#[test]
fn unknown_duplicate_continued_malformed_headers_and_forged_layouts_are_refused() {
    let repo = Repo::new("sha1");
    let (_, p, i) = repo.inverse(None);
    for header in [
        "gitgui-stash-encoding future-v2",
        "gitgui-stash-encoding selected-unstaged-v1\ngitgui-stash-encoding selected-unstaged-v1",
        "gitgui-stash-encoding selected-unstaged-v1\n continued",
        "gitgui-stash-encoding selected-unstaged-v1\n\tcontinued",
        "gitgui-stash-encoding\tselected-unstaged-v1",
        "gitgui-stash-encoding",
        "gitgui-stash-encoding selected-unstaged-v1 ",
    ] {
        let w = repo.commit(&repo.tree, &[&p, &i], Some(header), "untrusted");
        let target = repo.store(&w, "invalid");
        assert!(
            matches!(
                resolve_stash(repo.root(), &target),
                Err(StashError::Invalid(_))
            ),
            "{header:?}"
        );
        assert!(list_stashes(repo.root())
            .unwrap()
            .iter()
            .all(|s| s.hash != w));
    }
    // Message text never selects the custom baseline, even on a custom-shaped graph.
    let w = repo.commit(&repo.tree, &[&p, &i], None, STASH_ENCODING_HEADER);
    let layout = decode_stash(repo.root(), &w).unwrap();
    assert_eq!(layout.encoding, StashEncoding::Native);
    assert_eq!(layout.original_head_oid, p);
    // Native index must have exactly the baseline parent.
    let bad_i = repo.commit(&repo.tree, &[&repo.head], None, "wrong parent");
    let wrong_parent = repo.commit(
        &repo.tree,
        &[&p, &bad_i],
        Some(STASH_ENCODING_HEADER),
        "bad",
    );
    assert!(decode_stash(repo.root(), &wrong_parent).is_err());
    let bad_i = repo.commit(&repo.tree, &[&p], None, "wrong tree");
    let wrong_tree = repo.commit(
        &repo.tree,
        &[&p, &bad_i],
        Some(STASH_ENCODING_HEADER),
        "bad",
    );
    assert!(decode_stash(repo.root(), &wrong_tree).is_err());
    let extra_parent = repo.commit(
        &repo.tree,
        &[&p, &i, &repo.head, &repo.head],
        Some(STASH_ENCODING_HEADER),
        "bad",
    );
    assert!(decode_stash(repo.root(), &extra_parent).is_err());
    let missing = "1".repeat(repo.head.len());
    let bad_p = repo.commit(&repo.tree, &[&missing], None, "missing H");
    let bad_i = repo.commit(&repo.tree, &[&bad_p], None, "saved index");
    let missing_h = repo.commit(
        &repo.tree,
        &[&bad_p, &bad_i],
        Some(STASH_ENCODING_HEADER),
        "bad",
    );
    assert!(decode_stash(repo.root(), &missing_h).is_err());
    for baseline_parents in [vec![], vec![repo.head.as_str(), repo.head.as_str()]] {
        let p = repo.commit(&repo.tree, &baseline_parents, None, "invalid P");
        let i = repo.commit(&repo.tree, &[&p], None, "index");
        let w = repo.commit(&repo.tree, &[&p, &i], Some(STASH_ENCODING_HEADER), "bad");
        assert!(decode_stash(repo.root(), &w).is_err());
    }
}

#[test]
fn malformed_untracked_parent_and_overlap_are_refused() {
    let repo = Repo::new("sha1");
    let bad_u = repo.commit(&repo.tree, &[], None, "overlapping");
    let (target, _, _) = repo.inverse(Some(&bad_u));
    assert!(resolve_stash(repo.root(), &target).is_err());
    let tree = repo.tree(&[("new.txt", b"new\n")]);
    let bad_u = repo.commit(&tree, &[&repo.head], None, "parented U");
    let (target, _, _) = repo.inverse(Some(&bad_u));
    assert!(resolve_stash(repo.root(), &target).is_err());
}

#[test]
fn staged_deletion_then_selected_untracked_same_path_is_only_an_untracked_addition() {
    let repo = Repo::new("sha1");
    let p_tree = repo.tree(&[("unrelated.txt", b"original\n")]);
    let p = repo.commit(&p_tree, &[&repo.head], None, "selected deletion baseline");
    let i = repo.commit(&p_tree, &[&p], None, "saved index");
    let u_tree = repo.tree(&[("selected.txt", b"untracked replacement\n")]);
    let u = repo.commit(&u_tree, &[], None, "untracked");
    let w = repo.commit(&p_tree, &[&p, &i, &u], Some(STASH_ENCODING_HEADER), "saved");
    let target = repo.store(&w, "saved");
    let files = list_stash_files(repo.root(), &target).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, "A");
    let diff = load_stash_file_diff(repo.root(), &target, "selected.txt").unwrap();
    assert_eq!(diff.original_content, "");
    assert_eq!(diff.modified_content, "untracked replacement\n");
}

#[test]
fn renames_deletions_and_literal_unusual_paths_use_saved_blobs_only() {
    let repo = Repo::new("sha1");
    let odd = " space\tnewline\n日本語 :[literal]*.txt ";
    let w_tree = repo.tree(&[(odd, b"A\n")]);
    let i = repo.commit(&repo.tree, &[&repo.head], None, "index");
    let w = repo.commit(&w_tree, &[&repo.head, &i], None, "native");
    let target = repo.store(&w, "On main: control\u{1e}fake\u{1f}subject");
    let files = list_stash_files(repo.root(), &target).unwrap();
    let renamed = files.iter().find(|f| f.path == odd).unwrap();
    assert!(renamed.status.starts_with('R'));
    assert_eq!(renamed.original_path.as_deref(), Some("selected.txt"));
    assert!(files
        .iter()
        .any(|f| f.path == "unrelated.txt" && f.status == "D"));
    let diff = load_stash_file_diff(repo.root(), &target, odd).unwrap();
    assert_eq!(diff.original_path.as_deref(), Some("selected.txt"));
    assert_eq!(diff.modified_path, odd);
    assert_eq!(diff.original_content, "A\n");
    assert_eq!(diff.modified_content, "A\n");
    assert_eq!(
        load_stash_file_diff(repo.root(), &target, "unrelated.txt")
            .unwrap()
            .modified_content,
        ""
    );
    assert_eq!(list_stashes(repo.root()).unwrap().len(), 1);
    let snapshot = load_repository(repo.root()).unwrap();
    assert_eq!(snapshot.stashes.len(), 1);
    assert!(snapshot.stashes[0].message.contains("fake"));
    for path in [
        "../selected.txt",
        "/selected.txt",
        "selected.txt\0",
        "selected.txt/../unrelated.txt",
        ":(glob)*",
    ] {
        assert!(load_stash_file_diff(repo.root(), &target, path).is_err());
    }
}

#[test]
fn replacement_refs_cannot_change_decode_or_saved_content() {
    let repo = Repo::new("sha1");
    let (target, p, _) = repo.inverse(None);
    // Replace the baseline with an otherwise valid commit that changes the tree.
    let replacement = repo.commit(&repo.tree, &[&repo.head], None, "replacement");
    repo.git(&["replace", &p, &replacement]);
    assert_eq!(
        resolve_stash(repo.root(), &target)
            .unwrap()
            .original_head_oid,
        repo.head
    );
    assert_eq!(
        load_stash_file_diff(repo.root(), &target, "selected.txt")
            .unwrap()
            .original_content,
        "B\n"
    );
    let old_blob = repo.git(&[
        "--no-replace-objects",
        "rev-parse",
        &format!("{p}:selected.txt"),
    ]);
    let new_blob = repo.blob(b"replacement contents\n");
    repo.git(&["replace", &old_blob, &new_blob]);
    assert_eq!(
        load_stash_file_diff(repo.root(), &target, "selected.txt")
            .unwrap()
            .original_content,
        "B\n"
    );
    repo.git(&["replace", &target.expected_oid, &replacement]);
    assert_eq!(
        resolve_stash(repo.root(), &target).unwrap().encoding,
        StashEncoding::SelectedUnstagedV1
    );
    let snapshot = load_repository(repo.root()).unwrap();
    assert!(snapshot
        .commits
        .iter()
        .any(|c| c.hash == target.expected_oid));
    assert!(!snapshot.commits.iter().any(|c| c.hash == p));
}

#[test]
fn missing_tree_commit_and_blob_objects_are_refused_by_production_decoder() {
    let repo = Repo::new("sha1");
    let (_, p, i) = repo.inverse(None);
    let missing = "2".repeat(repo.head.len());
    let w = repo.commit(&repo.tree, &[&missing, &i], None, "missing baseline");
    assert!(decode_stash(repo.root(), &w).is_err());
    let w = repo.commit(
        &missing,
        &[&p, &i],
        Some(STASH_ENCODING_HEADER),
        "missing tree",
    );
    assert!(decode_stash(repo.root(), &w).is_err());
    let raw = format!("100644 blob {missing}\tmissing.txt\0");
    let tree = repo.input(&["mktree", "-z", "--missing"], raw.as_bytes());
    let w = repo.commit(
        &tree,
        &[&p, &i],
        Some(STASH_ENCODING_HEADER),
        "missing blob",
    );
    assert!(decode_stash(repo.root(), &w).is_err());
}

#[test]
fn binary_and_large_text_are_bounded_without_reading_live_files() {
    let repo = Repo::new("sha1");
    let large = vec![b'x'; STASH_CONTENT_LIMIT + 1];
    let moderate = "line\n".repeat(100_000);
    let tree = repo.tree(&[
        ("binary.dat", b"before\0after"),
        ("large.txt", &large),
        ("moderate.txt", moderate.as_bytes()),
        ("invalid-utf8", &[255, 254]),
    ]);
    let u = repo.commit(&tree, &[], None, "untracked");
    let (target, _, _) = repo.inverse(Some(&u));
    let binary = load_stash_file_diff(repo.root(), &target, "binary.dat").unwrap();
    assert!(binary.is_binary);
    assert!(binary.patch.is_none());
    assert_eq!(binary.modified_content, "");
    assert!(
        load_stash_file_diff(repo.root(), &target, "invalid-utf8")
            .unwrap()
            .is_binary
    );
    let large = load_stash_file_diff(repo.root(), &target, "large.txt").unwrap();
    assert!(large.message.unwrap().contains("inspection limit"));
    assert!(large.modified_content.is_empty());
    assert!(large.patch.is_none());
    let moderate_diff = load_stash_file_diff(repo.root(), &target, "moderate.txt").unwrap();
    assert_eq!(moderate_diff.modified_content, moderate);
    assert!(moderate_diff.patch.unwrap().contains("+line"));
}

#[test]
fn sha256_full_oids_are_supported() {
    let repo = Repo::new("sha256");
    let (target, _, _) = repo.inverse(None);
    assert_eq!(target.expected_oid.len(), 64);
    assert_eq!(
        resolve_stash(repo.root(), &target)
            .unwrap()
            .original_head_oid,
        repo.head
    );
    assert_eq!(
        load_stash_file_diff(repo.root(), &target, "selected.txt")
            .unwrap()
            .original_content,
        "B\n"
    );
}

#[test]
fn tree_directory_file_overlap_is_not_merged_silently() {
    let repo = Repo::new("sha1");
    let sub = repo.tree(&[("nested", b"new\n")]);
    let raw = format!("040000 tree {sub}\tselected.txt\0");
    let u_tree = repo.input(&["mktree", "-z"], raw.as_bytes());
    let u = repo.commit(&u_tree, &[], None, "untracked directory overlap");
    let (target, _, _) = repo.inverse(Some(&u));
    assert!(resolve_stash(repo.root(), &target).is_err());
}

#[test]
fn non_utf8_saved_paths_are_explicitly_refused_instead_of_aliasing() {
    let repo = Repo::new("sha1");
    let blob = repo.blob(b"new\n");
    let mut raw = format!("100644 blob {blob}\t").into_bytes();
    raw.extend_from_slice(&[255, 0]);
    let tree = repo.input(&["mktree", "-z"], &raw);
    let u = repo.commit(&tree, &[], None, "non-utf8 path");
    let (target, _, _) = repo.inverse(Some(&u));
    assert!(matches!(
        resolve_stash(repo.root(), &target),
        Err(StashError::Invalid(_))
    ));
}

#[test]
fn commit_message_controls_do_not_forge_stashes_or_history_rows() {
    let repo = Repo::new("sha1");
    let i = repo.commit(&repo.tree, &[&repo.head], None, "index");
    let message = format!(
        "On main: actual\u{1e}{}\u{1f}\u{1f}forged\u{1f}1\u{1f}message",
        "a".repeat(40)
    );
    let w = repo.commit(&repo.tree, &[&repo.head, &i], None, &message);
    let target = repo.store(&w, "On main: reviewed\u{1e}fake\u{1f}entry");
    let snapshot = load_repository(repo.root()).unwrap();
    assert_eq!(snapshot.stashes.len(), 1);
    assert_eq!(snapshot.stashes[0].hash, target.expected_oid);
    assert_eq!(snapshot.commits.len(), 2);
    assert!(snapshot
        .commits
        .iter()
        .any(|c| c.hash == w && c.message == message));
    assert!(snapshot
        .commits
        .iter()
        .all(|c| c.hash == w || c.hash == repo.head));
}

#[test]
fn saved_modes_symlinks_and_submodules_are_read_without_following_filesystem_paths() {
    let repo = Repo::new("sha1");
    let link = repo.blob(b"../../outside.txt");
    let executable = repo.blob(b"#!/bin/sh\n");
    let raw = format!("120000 blob {link}\tlink\0").into_bytes();
    let mut entries = raw;
    entries.extend_from_slice(format!("100755 blob {executable}\texecutable\0").as_bytes());
    entries.extend_from_slice(format!("160000 commit {}\tsubmodule\0", "3".repeat(40)).as_bytes());
    let tree = repo.input(&["mktree", "-z", "--missing"], &entries);
    let u = repo.commit(&tree, &[], None, "untracked modes");
    let (target, _, _) = repo.inverse(Some(&u));
    assert_eq!(
        load_stash_file_diff(repo.root(), &target, "link")
            .unwrap()
            .modified_content,
        "../../outside.txt"
    );
    assert_eq!(
        load_stash_file_diff(repo.root(), &target, "executable")
            .unwrap()
            .modified_content,
        "#!/bin/sh\n"
    );
    let submodule = load_stash_file_diff(repo.root(), &target, "submodule").unwrap();
    assert!(submodule.message.unwrap().contains("Submodule"));
    assert!(submodule.patch.is_none());
}

#[test]
fn stash_branch_name_cannot_substitute_for_the_stash_reflog() {
    let repo = Repo::new("sha1");
    let (target, _, _) = repo.inverse(None);
    repo.git(&["branch", "stash", &target.expected_oid]);
    // Metadata must come from refs/stash even while a same-named branch exists.
    assert_eq!(
        read_stash_info(repo.root(), &target).unwrap().message,
        "inverse"
    );
    assert_eq!(list_stashes(repo.root()).unwrap()[0].selector, "stash@{0}");
    repo.git(&["update-ref", "-d", "refs/stash"]);
    for result in [
        resolve_stash(repo.root(), &target).map(|_| ()),
        read_stash_info(repo.root(), &target).map(|_| ()),
    ] {
        assert!(matches!(result, Err(StashError::TargetChanged)));
    }
    assert!(list_stashes(repo.root()).unwrap().is_empty());
}

#[test]
fn skipped_non_commit_reflog_entries_do_not_reindex_valid_stashes() {
    let repo = Repo::new("sha1");
    let (older, p, i) = repo.inverse(None);
    let tag = repo.tag(&older.expected_oid, "commit");
    repo.store(&tag, "invalid tag entry");
    assert!(list_stashes(repo.root()).unwrap().is_empty());
    let newer = repo.commit(&repo.tree, &[&p, &i], Some(STASH_ENCODING_HEADER), "newer");
    repo.store(&newer, "newer");
    let infos = list_stashes(repo.root()).unwrap();
    assert_eq!(infos.len(), 2);
    assert_eq!(infos[0].selector, "stash@{0}");
    assert_eq!(infos[1].selector, "stash@{2}");
    assert_eq!(infos[1].hash, older.expected_oid);
    for info in infos {
        assert!(resolve_stash(
            repo.root(),
            &StashTarget {
                selector: info.selector,
                expected_oid: info.hash,
            }
        )
        .is_ok());
    }
}

#[test]
fn annotated_tags_cannot_stand_in_for_any_stash_commit_or_tree() {
    let repo = Repo::new("sha1");
    let (valid, p, i) = repo.inverse(None);
    let u_tree = repo.tree(&[("new.txt", b"new\n")]);
    let u = repo.commit(&u_tree, &[], None, "untracked");
    let tag_w = repo.tag(&valid.expected_oid, "commit");
    let tag_p = repo.tag(&p, "commit");
    let tag_i = repo.tag(&i, "commit");
    let tag_h = repo.tag(&repo.head, "commit");
    let tag_u = repo.tag(&u, "commit");
    let tag_tree = repo.tag(&repo.tree, "tree");
    let tagged_p_index = repo.commit(&repo.tree, &[&tag_p], None, "index");
    let tagged_h_baseline = repo.commit(&repo.tree, &[&tag_h], None, "baseline");
    let tagged_h_index = repo.commit(&repo.tree, &[&tagged_h_baseline], None, "index");
    let tree_baseline = repo.commit(&tag_tree, &[&repo.head], None, "baseline");
    let tree_baseline_index = repo.commit(&tag_tree, &[&tree_baseline], None, "index");
    let tree_index = repo.commit(&tag_tree, &[&p], None, "index");
    let tree_h = repo.commit(&tag_tree, &[], None, "HEAD");
    let tree_h_baseline = repo.commit(&repo.tree, &[&tree_h], None, "baseline");
    let tree_h_index = repo.commit(&repo.tree, &[&tree_h_baseline], None, "index");
    let tree_u = repo.commit(&tag_tree, &[], None, "untracked");
    let invalid = [
        tag_w,
        repo.commit(
            &repo.tree,
            &[&tag_p, &tagged_p_index],
            Some(STASH_ENCODING_HEADER),
            "tag P",
        ),
        repo.commit(
            &repo.tree,
            &[&p, &tag_i],
            Some(STASH_ENCODING_HEADER),
            "tag I",
        ),
        repo.commit(
            &repo.tree,
            &[&tagged_h_baseline, &tagged_h_index],
            Some(STASH_ENCODING_HEADER),
            "tag H",
        ),
        repo.commit(
            &repo.tree,
            &[&p, &i, &tag_u],
            Some(STASH_ENCODING_HEADER),
            "tag U",
        ),
        repo.commit(
            &tag_tree,
            &[&p, &i],
            Some(STASH_ENCODING_HEADER),
            "tag W tree",
        ),
        repo.commit(
            &repo.tree,
            &[&tree_baseline, &tree_baseline_index],
            Some(STASH_ENCODING_HEADER),
            "tag P tree",
        ),
        repo.commit(
            &repo.tree,
            &[&p, &tree_index],
            Some(STASH_ENCODING_HEADER),
            "tag I tree",
        ),
        repo.commit(
            &repo.tree,
            &[&tree_h_baseline, &tree_h_index],
            Some(STASH_ENCODING_HEADER),
            "tag H tree",
        ),
        repo.commit(
            &repo.tree,
            &[&p, &i, &tree_u],
            Some(STASH_ENCODING_HEADER),
            "tag U tree",
        ),
    ];
    for oid in invalid {
        assert!(
            matches!(decode_stash(repo.root(), &oid), Err(StashError::Invalid(_))),
            "{oid}"
        );
    }
    // The specific review repro must be omitted before history traversal.
    let bad = repo.commit(
        &repo.tree,
        &[&tag_p, &tagged_p_index],
        Some(STASH_ENCODING_HEADER),
        "bad baseline",
    );
    repo.store(&bad, "bad baseline");
    assert!(list_stashes(repo.root())
        .unwrap()
        .iter()
        .all(|stash| stash.hash != bad));
    assert!(load_repository(repo.root()).is_ok());
}

#[test]
fn duplicate_directory_records_with_distinct_children_are_refused_recursively() {
    let repo = Repo::new("sha1");
    let left = repo.tree(&[("left.txt", b"left\n")]);
    let right = repo.tree(&[("right.txt", b"right\n")]);
    // mktree permits duplicate directory records, even though fsck rejects them.
    let duplicate = repo.input(
        &["mktree", "-z"],
        format!("040000 tree {left}\tdir\0040000 tree {right}\tdir\0").as_bytes(),
    );
    let nested = repo.input(
        &["mktree", "-z"],
        format!("040000 tree {duplicate}\touter\0").as_bytes(),
    );
    let empty = repo.tree(&[]);
    let duplicate_empty = repo.input(
        &["mktree", "-z"],
        format!("040000 tree {empty}\tdir\0040000 tree {empty}\tdir\0").as_bytes(),
    );
    for tree in [&duplicate, &nested, &duplicate_empty] {
        let u = repo.commit(tree, &[], None, "duplicate directories");
        let (target, _, _) = repo.inverse(Some(&u));
        assert!(matches!(
            resolve_stash(repo.root(), &target),
            Err(StashError::Invalid(_))
        ));
        assert!(list_stashes(repo.root())
            .unwrap()
            .iter()
            .all(|stash| stash.hash != target.expected_oid));
    }
    // A directory reference must itself be a tree, not a tag that peels to one.
    let tag = repo.tag(&left, "tree");
    let raw = b"40000 dir\0"
        .to_vec()
        .into_iter()
        .chain(
            (0..tag.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&tag[i..i + 2], 16).unwrap()),
        )
        .collect::<Vec<_>>();
    let bad_tree = repo.input(
        &["hash-object", "-w", "--literally", "-t", "tree", "--stdin"],
        &raw,
    );
    let u = repo.commit(&bad_tree, &[], None, "tagged directory");
    let (target, _, _) = repo.inverse(Some(&u));
    assert!(resolve_stash(repo.root(), &target).is_err());
}

#[test]
fn adopted_helpers_and_ancestry_remain_visible_from_ordinary_history_roots() {
    let repo = Repo::new("sha1");
    let u_tree = repo.tree(&[("new.txt", b"new\n")]);
    let u = repo.commit(&u_tree, &[], None, "untracked");
    let (target, p, i) = repo.inverse(Some(&u));
    // A branch at I adopts both I and its parent P. U remains private.
    repo.git(&["branch", "adopted-index", &i]);
    let snapshot = load_repository(repo.root()).unwrap();
    for oid in [&repo.head, &p, &i] {
        assert!(snapshot.commits.iter().any(|commit| &commit.hash == oid));
    }
    assert!(!snapshot.commits.iter().any(|commit| commit.hash == u));
    assert!(snapshot
        .graph
        .edges
        .iter()
        .any(|edge| edge.from == i && edge.to == p));
    assert!(snapshot
        .graph
        .edges
        .iter()
        .any(|edge| edge.from == target.expected_oid && edge.to == p));
    repo.git(&["branch", "-D", "adopted-index"]);
    let nested_tag = repo.tag(&p, "commit");
    repo.git(&[
        "tag",
        "-a",
        "adopted-baseline",
        &nested_tag,
        "-m",
        "ordinary nested tag",
    ]);
    let snapshot = load_repository(repo.root()).unwrap();
    assert!(snapshot.commits.iter().any(|commit| commit.hash == p));
    assert!(!snapshot.commits.iter().any(|commit| commit.hash == i));
    repo.git(&["tag", "-d", "adopted-baseline"]);
    repo.git(&["switch", "--detach", &p]);
    let snapshot = load_repository(repo.root()).unwrap();
    assert_eq!(snapshot.status.head_oid.as_deref(), Some(p.as_str()));
    assert!(snapshot.commits.iter().any(|commit| commit.hash == p));
    assert!(snapshot
        .graph
        .edges
        .iter()
        .any(|edge| edge.from == p && edge.to == repo.head));
}

#[test]
fn native_stash_branch_adopts_the_synthetic_baseline_of_a_retained_entry() {
    let repo = Repo::new("sha1");
    let (retained, p, i) = repo.inverse(None);
    // Duplicate W with a different message; native branch drops this top entry
    // while the original entry still identifies P as a stash helper.
    let w = repo.commit(
        &repo.tree,
        &[&p, &i],
        Some(STASH_ENCODING_HEADER),
        "second inverse",
    );
    repo.store(&w, "second inverse");
    repo.git(&["stash", "branch", "native-branch", "stash@{0}"]);
    let snapshot = load_repository(repo.root()).unwrap();
    assert_eq!(snapshot.status.head_oid.as_deref(), Some(p.as_str()));
    assert!(snapshot.commits.iter().any(|commit| commit.hash == p));
    assert!(snapshot
        .commits
        .iter()
        .any(|commit| commit.hash == repo.head));
    assert!(snapshot
        .stashes
        .iter()
        .any(|stash| stash.hash == retained.expected_oid));
    assert!(!snapshot.commits.iter().any(|commit| commit.hash == i));
    // Inspection still shows only P -> W and never baseline context H -> P.
    assert_eq!(list_stash_files(repo.root(), &retained).unwrap().len(), 1);
}

#[test]
fn validation_cache_does_not_survive_a_listing_or_hide_later_missing_objects() {
    let repo = Repo::new("sha1");
    let (target, p, _) = repo.inverse(None);
    assert_eq!(list_stashes(repo.root()).unwrap().len(), 1);
    let blob = repo.git(&["rev-parse", &format!("{p}:selected.txt")]);
    let loose = repo
        .dir
        .path()
        .join(".git/objects")
        .join(&blob[..2])
        .join(&blob[2..]);
    fs::remove_file(loose).unwrap();
    assert!(list_stashes(repo.root()).unwrap().is_empty());
    assert!(resolve_stash(repo.root(), &target).is_err());
}

#[test]
fn non_commit_tags_do_not_break_stash_history_or_nested_commit_adoption() {
    let repo = Repo::new("sha1");
    let blob = repo.blob(b"tagged blob\n");
    for (kind, oid) in [("tree", repo.tree.as_str()), ("blob", blob.as_str())] {
        let annotated = repo.tag(oid, kind);
        let nested = repo.tag(&annotated, "tag");
        for (form, target) in [
            ("lightweight", oid),
            ("annotated", &annotated),
            ("nested", &nested),
        ] {
            repo.git(&["update-ref", &format!("refs/tags/{kind}-{form}"), target]);
        }
    }
    assert_eq!(load_repository(repo.root()).unwrap().commits.len(), 1);
    fs::write(repo.dir.path().join("selected.txt"), "saved\n").unwrap();
    repo.git(&["stash", "push", "-m", "native with non-commit tags"]);
    let snapshot = load_repository(repo.root()).unwrap();
    assert_eq!(snapshot.stashes.len(), 1);
    assert_eq!(snapshot.commits.len(), 2);
    assert_eq!(snapshot.refs.len(), 7); // main plus all six valid tags
    assert!(snapshot
        .commits
        .iter()
        .any(|commit| commit.hash == repo.head));
    let index = snapshot.stashes[0].index_hash.as_ref().unwrap();
    assert!(!snapshot.commits.iter().any(|commit| &commit.hash == index));

    // Non-commit tags must not interfere with a nested tag adopting a helper.
    let inner = repo.tag(index, "commit");
    let outer = repo.tag(&inner, "tag");
    repo.git(&["update-ref", "refs/tags/adopted-index", &outer]);
    let snapshot = load_repository(repo.root()).unwrap();
    assert!(snapshot.commits.iter().any(|commit| &commit.hash == index));
    let graph =
        gitgui_core::git::repository::load_repository_graph(repo.root(), &[index.clone()]).unwrap();
    assert!(graph.commits.iter().any(|commit| &commit.hash == index));
    assert!(graph.commits.iter().any(|commit| commit.hash == repo.head));
}

#[test]
fn unsorted_saved_trees_are_invalid_before_inspection_in_every_snapshot_role() {
    for format in ["sha1", "sha256"] {
        let repo = Repo::new(format);
        let blob = repo.blob(b"A\n");
        let baseline = repo.tree(&[("a", b"A\n")]);
        let h = repo.commit(&baseline, &[&repo.head], None, "baseline a");
        let i = repo.commit(&baseline, &[&h], None, "index a");
        let sorted = repo.tree(&[("a", b"A\n"), ("z", b"A\n")]);
        let valid_w = repo.commit(&sorted, &[&h, &i], None, "valid addition");
        let valid = repo.store(&valid_w, "valid addition");
        let files = list_stash_files(repo.root(), &valid).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            (files[0].path.as_str(), files[0].status.as_str()),
            ("z", "A")
        );
        let diff = load_stash_file_diff(repo.root(), &valid, "z").unwrap();
        assert_eq!(
            (
                diff.original_content.as_str(),
                diff.modified_content.as_str()
            ),
            ("", "A\n")
        );

        // Same entries as the valid tree, but Git's merge traversal can report
        // a false R100 a->z plus A a if this raw order reaches diff-tree.
        let unsorted = repo.raw_tree(&[("100644", "z", &blob), ("100644", "a", &blob)]);
        let unsorted_u = repo.raw_tree(&[("100644", "u-z", &blob), ("100644", "u-a", &blob)]);
        let nested = repo.raw_tree(&[("40000", "outer", &unsorted)]);
        let empty = repo.tree(&[]);
        // Plain lexical name sorting would accept this, but Git requires b.
        // before the directory b (compared as b/), even when it is empty.
        let unsorted_directory = repo.raw_tree(&[("40000", "b", &empty), ("100644", "b.", &blob)]);
        for role in [
            "W",
            "native baseline",
            "custom baseline",
            "I",
            "U",
            "custom H",
            "nested U",
            "directory U",
        ] {
            let h_tree = if matches!(role, "native baseline" | "custom H") {
                &unsorted
            } else {
                &baseline
            };
            let h = repo.commit(h_tree, &[&repo.head], None, "original");
            let custom = matches!(role, "custom baseline" | "custom H");
            let p_tree = if role == "custom baseline" {
                &unsorted
            } else {
                &baseline
            };
            let p = if custom {
                repo.commit(p_tree, &[&h], None, "custom baseline")
            } else {
                h.clone()
            };
            let i_tree = if role == "I" {
                &unsorted
            } else if custom {
                p_tree
            } else {
                h_tree
            };
            let i = repo.commit(i_tree, &[&p], None, "index");
            let u = match role {
                "U" => Some(repo.commit(&unsorted_u, &[], None, "untracked")),
                "nested U" => Some(repo.commit(&nested, &[], None, "nested untracked")),
                "directory U" => {
                    Some(repo.commit(&unsorted_directory, &[], None, "unsorted directory"))
                }
                _ => None,
            };
            let mut parents = vec![p.as_str(), i.as_str()];
            parents.extend(u.as_deref());
            let w = repo.commit(
                if role == "W" { &unsorted } else { &baseline },
                &parents,
                custom.then_some(STASH_ENCODING_HEADER),
                role,
            );
            let target = repo.store(&w, role);
            assert!(
                matches!(decode_stash(repo.root(), &w), Err(StashError::Invalid(error)) if error.message == "Unsorted saved tree entries"),
                "{format} {role}"
            );
            assert!(
                matches!(
                    resolve_stash(repo.root(), &target),
                    Err(StashError::Invalid(error)) if error.message == "Unsorted saved tree entries"
                ),
                "{format} {role}"
            );
            assert!(
                matches!(
                    list_stash_files(repo.root(), &target),
                    Err(StashError::Invalid(error)) if error.message == "Unsorted saved tree entries"
                ),
                "{format} {role}"
            );
            assert!(
                matches!(
                    load_stash_file_diff(repo.root(), &target, "z"),
                    Err(StashError::Invalid(error)) if error.message == "Unsorted saved tree entries"
                ),
                "{format} {role}"
            );
            let listed = list_stashes(repo.root()).unwrap();
            assert_eq!(listed.len(), 1, "{format} {role}");
            assert_eq!(listed[0].hash, valid_w);
        }
    }
}

#[test]
fn raw_tree_basename_boundaries_are_validated_before_saved_paths_are_flattened() {
    for format in ["sha1", "sha256"] {
        let repo = Repo::new(format);
        let blob = repo.blob(b"A\n");
        let child = repo.tree(&[
            (".dot", b"dot\n"),
            ("b", b"A\n"),
            ("control\u{1}\t\n", b"control\n"),
        ]);
        let baseline = repo.raw_tree(&[("40000", "a", &child), ("100644", "a\\b", &blob)]);
        let h = repo.commit(&baseline, &[&repo.head], None, "actual nested a/b");
        let i = repo.commit(&baseline, &[&h], None, "index");
        let valid_tree = repo.raw_tree(&[
            ("40000", "a", &child),
            ("100644", "a\\b", &blob),
            ("100644", "z", &blob),
        ]);
        let valid_w = repo.commit(&valid_tree, &[&h, &i], None, "valid nested tree");
        let valid = repo.store(&valid_w, "valid nested tree");
        assert!(decode_stash(repo.root(), &valid_w).is_ok());
        let files = list_stash_files(repo.root(), &valid).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            (files[0].path.as_str(), files[0].status.as_str()),
            ("z", "A")
        );
        let diff = load_stash_file_diff(repo.root(), &valid, "z").unwrap();
        assert_eq!(diff.original_content, "");
        assert_eq!(diff.modified_content, "A\n");

        // The first case reproduced R100 a/b -> z plus A a/b against a real
        // nested baseline. The second is correctly ordered but still corrupt.
        let unsorted_slash = repo.raw_tree(&[("100644", "z", &blob), ("100644", "a/b", &blob)]);
        let sorted_slash = repo.raw_tree(&[("100644", "a/b", &blob), ("100644", "z", &blob)]);
        let slash_directory = repo.raw_tree(&[("40000", "u/v", &child)]);
        let slash_u = repo.raw_tree(&[("100644", "u/v", &blob)]);
        let nested_u = repo.raw_tree(&[("40000", "outer", &slash_u)]);
        let quoted_slash = repo.raw_tree(&[("100644", "\"u/v\"", &blob)]);
        for (label, tree, untracked) in [
            ("unsorted slash W", &unsorted_slash, false),
            ("sorted slash W", &sorted_slash, false),
            ("slash directory W", &slash_directory, false),
            ("slash U", &slash_u, true),
            ("nested slash U", &nested_u, true),
            ("slash directory U", &slash_directory, true),
            ("quoted slash U", &quoted_slash, true),
        ] {
            let u = untracked.then(|| repo.commit(tree, &[], None, label));
            let mut parents = vec![h.as_str(), i.as_str()];
            parents.extend(u.as_deref());
            let w = repo.commit(
                if untracked { &baseline } else { tree },
                &parents,
                None,
                label,
            );
            let target = repo.store(&w, label);
            assert_invalid_saved_snapshot(&repo, &target, "a/b", &format!("{format} {label}"));
            let listed = list_stashes(repo.root()).unwrap();
            assert_eq!(listed.len(), 1, "{format} {label}");
            assert_eq!(listed[0].hash, valid_w);
        }
    }
}

fn assert_invalid_saved_snapshot(repo: &Repo, target: &StashTarget, path: &str, label: &str) {
    assert!(
        matches!(
            decode_stash(repo.root(), &target.expected_oid),
            Err(StashError::Invalid(_))
        ),
        "decode {label}"
    );
    assert!(
        matches!(
            resolve_stash(repo.root(), target),
            Err(StashError::Invalid(_))
        ),
        "resolve {label}"
    );
    assert!(
        matches!(
            read_stash_info(repo.root(), target),
            Err(StashError::Invalid(_))
        ),
        "info {label}"
    );
    assert!(
        matches!(
            list_stash_files(repo.root(), target),
            Err(StashError::Invalid(_))
        ),
        "files {label}"
    );
    assert!(
        matches!(
            load_stash_file_diff(repo.root(), target, path),
            Err(StashError::Invalid(_))
        ),
        "diff {label}"
    );
}

#[test]
fn malformed_raw_tree_records_are_refused_in_both_object_formats() {
    for format in ["sha1", "sha256"] {
        let repo = Repo::new(format);
        let blob = repo.blob(b"saved\n");
        let empty = repo.tree(&[]);
        let oid_bytes = (0..blob.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&blob[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let mut malformed = Vec::new();
        for prefix in [
            b"100644 \0".as_slice(),
            b"100644 .\0",
            b"100644 ..\0",
            b"100644 a//b\0",
            b"100644 a/../b\0",
            b"100644 /a\0",
            b"100644 a/\0",
            b"10064 a\0",
            b"0100644 a\0",
            b"100664 a\0",
            b"100644a\0",
            b"100644 a\0b\0",
            b"100644 a",
        ] {
            let mut raw = prefix.to_vec();
            raw.extend_from_slice(&oid_bytes);
            malformed.push(repo.input(
                &["hash-object", "-w", "--literally", "-t", "tree", "--stdin"],
                &raw,
            ));
        }
        for size in [0, oid_bytes.len() - 1, oid_bytes.len() + 1] {
            let mut raw = b"100644 a\0".to_vec();
            raw.extend(oid_bytes.iter().copied().chain([0]).take(size));
            malformed.push(repo.input(
                &["hash-object", "-w", "--literally", "-t", "tree", "--stdin"],
                &raw,
            ));
        }
        // Directory-aware order can separate identical names: b (file), b.,
        // b/ (directory). Raw duplicate detection must span the whole directory.
        malformed.push(repo.raw_tree(&[
            ("100644", "b", &blob),
            ("100644", "b.", &blob),
            ("40000", "b", &empty),
        ]));
        malformed.push(repo.raw_tree(&[
            ("40000", "b", &empty),
            ("100644", "b0", &blob),
            ("40000", "b", &empty),
        ]));
        let i = repo.commit(&repo.tree, &[&repo.head], None, "index");
        for (n, tree) in malformed.iter().enumerate() {
            let u = repo.commit(tree, &[], None, "malformed raw tree");
            let w = repo.commit(
                &repo.tree,
                &[&repo.head, &i, &u],
                None,
                &format!("malformed {n}"),
            );
            let target = repo.store(&w, "malformed raw tree");
            assert_invalid_saved_snapshot(&repo, &target, "a", &format!("{format} case {n}"));
        }
        assert!(
            list_stashes(repo.root()).unwrap().is_empty(),
            "listing {format}"
        );
    }
}

#[test]
fn canonical_tree_order_uses_raw_bytes_and_directory_slashes_at_each_depth() {
    let repo = Repo::new("sha1");
    let blob = repo.blob(b"saved\n");
    let empty = repo.tree(&[]);
    let child = repo.raw_tree(&[
        ("100644", "x.", &blob),
        ("40000", "x", &empty),
        ("100644", "x0", &blob),
    ]);
    let entries = [
        ("100644", "a", blob.as_str()),
        ("100644", "a.", blob.as_str()),
        ("100755", "a0", blob.as_str()),
        ("120000", "b.", blob.as_str()),
        ("40000", "b", child.as_str()),
        ("160000", "b0", repo.head.as_str()),
        ("100644", "empty.", blob.as_str()),
        ("40000", "empty", empty.as_str()),
        ("100644", "empty0", blob.as_str()),
        ("100644", "é.", blob.as_str()),
        ("40000", "é", child.as_str()),
        ("100644", "é0", blob.as_str()),
        ("100644", "🦀\t\n", blob.as_str()),
    ];
    let tree = repo.raw_tree(&entries);
    // Git's own mktree sorts the reversed records; its result is our oracle.
    let records = entries
        .iter()
        .rev()
        .map(|(mode, name, oid)| {
            let kind = match *mode {
                "40000" => "tree",
                "160000" => "commit",
                _ => "blob",
            };
            format!("{mode} {kind} {oid}\t{name}\0")
        })
        .collect::<String>();
    assert_eq!(tree, repo.input(&["mktree", "-z"], records.as_bytes()));
    let u = repo.commit(&tree, &[], None, "canonical untracked tree");
    let i = repo.commit(&repo.tree, &[&repo.head], None, "native index");
    let w = repo.commit(&repo.tree, &[&repo.head, &i, &u], None, "native saved tree");
    let target = repo.store(&w, "canonical native");
    assert_eq!(
        resolve_stash(repo.root(), &target).unwrap().encoding,
        StashEncoding::Native
    );
    let files = list_stash_files(repo.root(), &target).unwrap();
    assert_eq!(files.len(), 14);
    assert!(files.iter().all(|file| file.status == "A"));
    for path in ["a", "a.", "b/x.", "b/x0", "é/x.", "é0", "🦀\t\n"] {
        let diff = load_stash_file_diff(repo.root(), &target, path).unwrap();
        assert_eq!(diff.original_content, "");
        assert_eq!(diff.modified_content, "saved\n");
    }
    let (custom, _, _) = repo.inverse(Some(&u));
    assert_eq!(list_stash_files(repo.root(), &custom).unwrap().len(), 15);
}
