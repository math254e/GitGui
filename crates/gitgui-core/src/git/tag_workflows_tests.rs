use super::command::{test_metrics, GitCommand};
use super::tag_operations::*;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn run(root: &Path, args: &[&str]) -> String {
    GitCommand::run(args, Some(root)).unwrap().trim().to_owned()
}
struct Fixture {
    _dir: tempfile::TempDir,
    local: PathBuf,
    peer: PathBuf,
    remote: PathBuf,
}
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let remote = dir.path().join("remote.git");
    let local = dir.path().join("local");
    let peer = dir.path().join("peer");
    run(
        dir.path(),
        &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
    );
    run(
        dir.path(),
        &["clone", remote.to_str().unwrap(), local.to_str().unwrap()],
    );
    for path in [&local] {
        run(path, &["config", "user.name", "Tag Test"]);
        run(path, &["config", "user.email", "tags@example.test"]);
        run(path, &["config", "tag.gpgSign", "false"]);
    }
    fs::write(local.join("file"), "base").unwrap();
    run(&local, &["add", "."]);
    run(&local, &["commit", "-m", "base"]);
    run(&local, &["push", "-u", "origin", "main"]);
    run(
        dir.path(),
        &["clone", remote.to_str().unwrap(), peer.to_str().unwrap()],
    );
    run(&peer, &["config", "user.name", "Tag Test"]);
    run(&peer, &["config", "user.email", "tags@example.test"]);
    run(&peer, &["config", "tag.gpgSign", "false"]);
    Fixture {
        _dir: dir,
        local,
        peer,
        remote,
    }
}

#[test]
fn main_push_sends_branch_and_lightweight_tags_with_one_network_command() {
    let f = fixture();
    let root = f.local.to_str().unwrap();
    run(&f.local, &["commit", "--allow-empty", "-m", "next"]);
    run(&f.local, &["tag", "release"]);
    test_metrics::take();
    assert!(push(root).unwrap().tag_error.is_none());
    assert_eq!(test_metrics::take().0, 3);
    let head = run(&f.local, &["rev-parse", "HEAD"]);
    assert_eq!(run(&f.remote, &["rev-parse", "refs/heads/main"]), head);
    assert_eq!(run(&f.remote, &["rev-parse", "refs/tags/release"]), head);
}

#[test]
fn fetch_returns_conflicts_without_overwriting_or_pruning_local_tags() {
    let f = fixture();
    let root = f.local.to_str().unwrap();
    run(&f.local, &["tag", "conflict"]);
    run(&f.local, &["tag", "local-only"]);
    let old = run(&f.local, &["rev-parse", "HEAD"]);
    run(
        &f.local,
        &[
            "config",
            "--add",
            "remote.origin.fetch",
            "+refs/tags/*:refs/tags/*",
        ],
    );
    run(&f.local, &["config", "remote.origin.pruneTags", "true"]);
    run(&f.peer, &["commit", "--allow-empty", "-m", "remote next"]);
    run(&f.peer, &["tag", "conflict"]);
    run(&f.peer, &["tag", "new-tag"]);
    run(&f.peer, &["push", "--tags", "origin", "main"]);
    let new = run(&f.peer, &["rev-parse", "HEAD"]);
    test_metrics::take();
    let result = fetch(root).unwrap();
    assert_eq!(test_metrics::take().0, 3);
    assert_eq!(result.conflicts.len(), 1);
    assert_eq!(result.conflicts[0].local_object_id, old);
    assert_eq!(result.conflicts[0].remote_object_id, new);
    assert_eq!(run(&f.local, &["rev-parse", "refs/tags/conflict"]), old);
    assert_eq!(run(&f.local, &["rev-parse", "refs/tags/local-only"]), old);
    assert_eq!(run(&f.local, &["rev-parse", "refs/tags/new-tag"]), new);
    assert_eq!(
        run(&f.local, &["rev-parse", "refs/remotes/origin/main"]),
        new
    );
    apply_fetched_tags(root, &result.conflicts).unwrap();
    assert_eq!(run(&f.local, &["rev-parse", "refs/tags/conflict"]), new);
    assert!(apply_fetched_tags(root, &result.conflicts).is_err());
}

#[test]
fn tag_checkout_is_detached_and_preserves_changes_on_failure() {
    let f = fixture();
    let root = f.local.to_str().unwrap();
    let base = run(&f.local, &["rev-parse", "HEAD"]);
    run(&f.local, &["tag", "release"]);
    fs::write(f.local.join("file"), "next").unwrap();
    run(&f.local, &["commit", "-am", "next"]);
    fs::write(f.local.join("file"), "dirty").unwrap();
    assert!(checkout(root, "release", &base).is_err());
    assert_eq!(fs::read_to_string(f.local.join("file")).unwrap(), "dirty");
    fs::write(f.local.join("file"), "next").unwrap();
    checkout(root, "release", &base).unwrap();
    assert_eq!(run(&f.local, &["rev-parse", "HEAD"]), base);
    assert!(GitCommand::run(&["symbolic-ref", "--quiet", "HEAD"], Some(&f.local)).is_err());
}

#[test]
fn annotation_hover_is_one_bounded_read_and_checks_the_reviewed_object() {
    let f = fixture();
    let root = f.local.to_str().unwrap();
    run(
        &f.local,
        &[
            "tag",
            "-a",
            "annotated",
            "-m",
            "Release message\n\nMore detail",
        ],
    );
    let object = run(&f.local, &["rev-parse", "refs/tags/annotated"]);
    test_metrics::take();
    let result = details(root, "annotated", &object).unwrap();
    assert_eq!(test_metrics::take().0, 1);
    assert!(result.annotated);
    assert_eq!(result.tagger.as_deref(), Some("Tag Test"));
    assert!(result.message.unwrap().contains("More detail"));
    let head = run(&f.local, &["rev-parse", "HEAD"]);
    assert!(details(root, "annotated", &head).is_err());
}

#[test]
fn selected_tag_push_uses_reviewed_object_and_does_not_push_other_tags() {
    let f = fixture();
    let root = f.local.to_str().unwrap();
    run(&f.local, &["tag", "selected"]);
    run(&f.local, &["tag", "-a", "other", "-m", "other release"]);
    run(&f.local, &["config", "push.followTags", "true"]);
    let object = run(&f.local, &["rev-parse", "HEAD"]);
    push_tag(root, "selected", &object).unwrap();
    assert_eq!(run(&f.remote, &["tag", "--list"]), "selected");
    run(&f.local, &["commit", "--allow-empty", "-m", "next"]);
    run(&f.local, &["tag", "-f", "selected"]);
    assert!(push_tag(root, "selected", &object).is_err());
}

#[test]
fn reviewed_replacement_batch_is_constant_work_and_rejects_stale_local_refs_atomically() {
    let f = fixture();
    let root = f.local.to_str().unwrap();
    let old = run(&f.local, &["rev-parse", "HEAD"]);
    run(&f.local, &["commit", "--allow-empty", "-m", "next"]);
    let new = run(&f.local, &["rev-parse", "HEAD"]);
    let commands = (0..20)
        .map(|i| format!("create refs/tags/t{i} {old}\n"))
        .collect::<String>();
    GitCommand::run_with_stdin(
        &["update-ref", "--stdin"],
        Some(&f.local),
        commands.as_bytes(),
    )
    .unwrap();
    let conflicts = (0..20)
        .map(|i| TagFetchConflict {
            name: format!("t{i}"),
            local_object_id: old.clone(),
            remote_object_id: new.clone(),
        })
        .collect::<Vec<_>>();
    run(&f.local, &["update-ref", "refs/tags/t19", &new]);
    assert!(apply_fetched_tags(root, &conflicts).is_err());
    assert_eq!(run(&f.local, &["rev-parse", "refs/tags/t0"]), old);
    run(&f.local, &["update-ref", "refs/tags/t19", &old]);
    test_metrics::take();
    apply_fetched_tags(root, &conflicts).unwrap();
    assert_eq!(test_metrics::take().0, 2);
    assert_eq!(run(&f.local, &["rev-parse", "refs/tags/t0"]), new);
}
