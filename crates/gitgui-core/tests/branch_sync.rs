use gitgui_core::git::{
    command::git_command,
    operations::{pull_branch, push_branch},
};
use std::{fs, path::Path};

fn git(path: &Path, args: &[&str]) -> String {
    let output = git_command()
        .current_dir(path)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", path.join("no-global-config"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn setup(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let remote = root.join("remote.git");
    let repo = root.join("repo");
    fs::create_dir(&remote).unwrap();
    fs::create_dir(&repo).unwrap();
    git(&remote, &["init", "--bare", "-q"]);
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.name", "Test"]);
    git(&repo, &["config", "user.email", "test@example.invalid"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    git(&repo, &["commit", "--allow-empty", "-qm", "base"]);
    git(
        &repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&repo, &["branch", "topic"]);
    git(&repo, &["push", "-qu", "origin", "topic"]);
    (repo, remote)
}

#[test]
fn push_and_fast_forward_a_non_current_branch() {
    let dir = tempfile::tempdir().unwrap();
    let (repo, remote) = setup(dir.path());
    let root = repo.to_str().unwrap();
    git(&repo, &["switch", "-q", "topic"]);
    git(&repo, &["commit", "--allow-empty", "-qm", "topic update"]);
    git(&repo, &["switch", "-q", "main"]);
    let topic = git(&repo, &["rev-parse", "refs/heads/topic"]);
    assert!(push_branch(root, "refs/heads/topic", &topic).is_ok());
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/topic"]), topic);
    assert_eq!(git(&repo, &["branch", "--show-current"]), "main");

    let writer = dir.path().join("writer");
    git(
        dir.path(),
        &[
            "clone",
            "-q",
            "-b",
            "topic",
            remote.to_str().unwrap(),
            writer.to_str().unwrap(),
        ],
    );
    git(&writer, &["config", "user.name", "Test"]);
    git(&writer, &["config", "user.email", "test@example.invalid"]);
    git(
        &writer,
        &["commit", "--allow-empty", "-qm", "remote update"],
    );
    git(&writer, &["push", "-q"]);
    assert!(pull_branch(root, "refs/heads/topic", &topic).is_ok());
    assert_eq!(
        git(&repo, &["rev-parse", "refs/heads/topic"]),
        git(&writer, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        git(&repo, &["rev-parse", "refs/remotes/origin/topic"]),
        git(&writer, &["rev-parse", "HEAD"])
    );
    assert_eq!(git(&repo, &["branch", "--show-current"]), "main");
    assert!(pull_branch(root, "refs/heads/topic", &topic).is_err());
}

#[test]
fn pull_rejects_divergence_and_a_branch_checked_out_elsewhere() {
    let dir = tempfile::tempdir().unwrap();
    let (repo, remote) = setup(dir.path());
    let root = repo.to_str().unwrap();
    let linked = dir.path().join("linked");
    git(
        &repo,
        &["worktree", "add", "-q", linked.to_str().unwrap(), "topic"],
    );
    let original = git(&repo, &["rev-parse", "refs/heads/topic"]);
    assert!(pull_branch(root, "refs/heads/topic", &original).is_err());
    git(&repo, &["worktree", "remove", linked.to_str().unwrap()]);

    let writer = dir.path().join("writer");
    git(
        dir.path(),
        &[
            "clone",
            "-q",
            "-b",
            "topic",
            remote.to_str().unwrap(),
            writer.to_str().unwrap(),
        ],
    );
    git(&writer, &["config", "user.name", "Test"]);
    git(&writer, &["config", "user.email", "test@example.invalid"]);
    git(
        &writer,
        &["commit", "--allow-empty", "-qm", "remote change"],
    );
    git(&writer, &["push", "-q"]);
    git(&repo, &["switch", "-q", "topic"]);
    git(&repo, &["commit", "--allow-empty", "-qm", "local change"]);
    git(&repo, &["switch", "-q", "main"]);
    let local = git(&repo, &["rev-parse", "refs/heads/topic"]);
    assert!(pull_branch(root, "refs/heads/topic", &local).is_err());
    assert_eq!(git(&repo, &["rev-parse", "refs/heads/topic"]), local);
    assert!(push_branch(root, "refs/heads/topic", &local).is_err());
    assert!(pull_branch(root, "refs/heads/main", &git(&repo, &["rev-parse", "main"])).is_err());
}
