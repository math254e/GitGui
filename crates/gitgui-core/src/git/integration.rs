//! Inspection of Git's per-worktree integration state.
//!
//! Git, including Git invoked outside the server, is the source of truth.

use super::command::{GitCommand, GitError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationKind {
    Merge,
    Rebase,
    /// Another sequencer operation, or unmerged entries without known metadata.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationState {
    pub kind: IntegrationKind,
    pub unresolved_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationReview {
    pub current_ref: String,
    pub head_oid: String,
    pub target_ref: String,
    pub target_oid: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationAction {
    Merge,
    Rebase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryAction {
    Continue,
    Abort,
    Skip,
}

/// A command failure can still leave an operation in progress.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationOutcome {
    pub state: Option<IntegrationState>,
    pub failure: Option<GitError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewritePushReview {
    pub current_ref: String,
    pub local_oid: String,
    pub remote: String,
    pub destination_ref: String,
    pub remote_oid: String,
    pub destination_fingerprint: String,
    pub commits_removed: Option<u32>,
}

fn error(message: impl Into<String>) -> GitError {
    GitError {
        message: message.into(),
        stderr: String::new(),
        status: None,
    }
}

fn metadata_exists(root: &Path, name: &str) -> Result<bool, GitError> {
    let path = GitCommand::run_strict(&["rev-parse", "--git-path", name], root)?;
    let path = PathBuf::from(path.trim_end_matches(['\r', '\n']));
    let path = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(error("Git operation metadata is a symbolic link"))
        }
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(error(format!("Cannot inspect Git operation metadata: {e}"))),
    }
}

/// Inspect the selected checkout, not the shared Git directory of its family.
pub fn inspect(root: &str) -> Result<Option<IntegrationState>, GitError> {
    let root = Path::new(root);
    let merge = metadata_exists(root, "MERGE_HEAD")?;
    let rebase_merge = metadata_exists(root, "rebase-merge")?;
    let rebase_apply = metadata_exists(root, "rebase-apply")?;
    let applying = rebase_apply && metadata_exists(root, "rebase-apply/applying")?;
    let rebasing = rebase_apply && metadata_exists(root, "rebase-apply/rebasing")?;
    let rebase = rebase_merge || (rebasing && !applying);
    let other = metadata_exists(root, "CHERRY_PICK_HEAD")?
        || metadata_exists(root, "REVERT_HEAD")?
        || metadata_exists(root, "sequencer")?
        || (rebase_apply && !rebasing)
        || applying;
    let output = GitCommand::run_strict(&["ls-files", "--unmerged", "-z"], root)?;
    let mut unresolved_paths = Vec::new();
    for record in output.split('\0').filter(|record| !record.is_empty()) {
        let (_, path) = record
            .split_once('\t')
            .ok_or_else(|| error("Malformed unmerged index entry"))?;
        if !unresolved_paths.iter().any(|existing| existing == path) {
            unresolved_paths.push(path.to_owned());
        }
    }
    let kind = match (merge, rebase, other, unresolved_paths.is_empty()) {
        (false, false, false, true) => return Ok(None),
        (true, false, false, _) => IntegrationKind::Merge,
        (false, true, false, _) => IntegrationKind::Rebase,
        _ => IntegrationKind::Unknown,
    };
    Ok(Some(IntegrationState {
        kind,
        unresolved_paths,
    }))
}

/// Resolve a literal branch ref or a full commit ID; this does not mutate the checkout.
pub fn review(root: &str, target_ref: &str) -> Result<IntegrationReview, GitError> {
    let root = Path::new(root);
    let is_commit = super::stash::is_oid(target_ref);
    if !is_commit
        && !(target_ref.starts_with("refs/heads/") || target_ref.starts_with("refs/remotes/"))
    {
        return Err(error("Select a branch or a full commit object ID"));
    }
    if is_commit {
        let object_type = GitCommand::run_strict(&["cat-file", "-t", target_ref], root)?;
        if object_type.trim() != "commit" {
            return Err(error("The target must be a commit"));
        }
    } else {
        GitCommand::run(&["check-ref-format", target_ref], Some(root))?;
    }
    if inspect(
        root.to_str()
            .ok_or_else(|| error("Repository path is not UTF-8"))?,
    )?
    .is_some()
    {
        return Err(error("Finish the current Git operation first"));
    }
    let current_ref = GitCommand::run_strict(&["symbolic-ref", "--quiet", "HEAD"], root)?
        .trim_end_matches(['\r', '\n'])
        .to_owned();
    if !current_ref.starts_with("refs/heads/") {
        return Err(error("The current checkout is not on a local branch"));
    }
    if current_ref == target_ref {
        return Err(error("Select a different branch"));
    }
    let head_oid = GitCommand::run_strict(&["rev-parse", "--verify", "HEAD^{commit}"], root)?
        .trim()
        .to_owned();
    let target_oid = GitCommand::run_strict(
        &["rev-parse", "--verify", &format!("{target_ref}^{{commit}}")],
        root,
    )?
    .trim()
    .to_owned();
    Ok(IntegrationReview {
        current_ref,
        head_oid,
        target_ref: target_ref.to_owned(),
        target_oid,
    })
}

/// Start only the exact branch tips the user reviewed.
pub fn start(
    root: &str,
    expected: &IntegrationReview,
    action: IntegrationAction,
) -> Result<IntegrationOutcome, GitError> {
    if action == IntegrationAction::Merge && super::stash::is_oid(&expected.target_ref) {
        return Err(error("Select a branch to merge"));
    }
    let current = review(root, &expected.target_ref)?;
    if current != *expected {
        return Err(error(
            "The reviewed branches changed; review the operation again",
        ));
    }
    let path = Path::new(root);
    let dirty =
        GitCommand::run_strict(&["status", "--porcelain=v1", "--untracked-files=no"], path)?;
    if !dirty.is_empty() {
        return Err(error("Commit or stash tracked changes before starting"));
    }
    let args: Vec<&str> = match action {
        IntegrationAction::Merge => vec![
            "merge",
            "--ff",
            "--no-edit",
            "--no-squash",
            "--no-autostash",
            &expected.target_oid,
        ],
        IntegrationAction::Rebase => vec![
            "-c",
            "rebase.updateRefs=false",
            "rebase",
            "--no-rebase-merges",
            "--no-autostash",
            "--no-autosquash",
            "--no-fork-point",
            &expected.target_oid,
        ],
    };
    let failure = GitCommand::run_integration(&args, path).err();
    Ok(IntegrationOutcome {
        state: inspect(root).map_err(|_| {
            error("Git ran, but its resulting state could not be read; refresh before continuing")
        })?,
        failure,
    })
}

/// Recover only the kind of operation observed by the user.
pub fn recover(
    root: &str,
    expected: IntegrationKind,
    action: RecoveryAction,
) -> Result<IntegrationOutcome, GitError> {
    let state = inspect(root)?.ok_or_else(|| error("No integration operation is in progress"))?;
    if state.kind != expected || expected == IntegrationKind::Unknown {
        return Err(error(
            "The Git operation changed; refresh and review it again",
        ));
    }
    if action == RecoveryAction::Continue && !state.unresolved_paths.is_empty() {
        return Err(error(
            "Resolve and stage all conflicted files before continuing",
        ));
    }
    let verb = match expected {
        IntegrationKind::Merge => "merge",
        IntegrationKind::Rebase => "rebase",
        IntegrationKind::Unknown => unreachable!(),
    };
    let option = match action {
        RecoveryAction::Continue => "--continue",
        RecoveryAction::Abort => "--abort",
        RecoveryAction::Skip if expected == IntegrationKind::Rebase => "--skip",
        RecoveryAction::Skip => return Err(error("Skip is only available during a rebase")),
    };
    let failure = GitCommand::run_integration(&[verb, option], Path::new(root)).err();
    Ok(IntegrationOutcome {
        state: inspect(root).map_err(|_| {
            error("Git ran, but its resulting state could not be read; refresh before continuing")
        })?,
        failure,
    })
}

/// Review the configured upstream as an explicit destination; never infer a
/// destination from a cached remote-tracking tip.
pub fn review_rewrite_push(root: &str) -> Result<RewritePushReview, GitError> {
    let path = Path::new(root);
    if inspect(root)?.is_some() {
        return Err(error("Finish the current Git operation before pushing"));
    }
    let current_ref = GitCommand::run_strict(&["symbolic-ref", "--quiet", "HEAD"], path)?
        .trim()
        .to_owned();
    if !current_ref.starts_with("refs/heads/") {
        return Err(error("The current checkout is not on a branch"));
    }
    let local_oid = GitCommand::run_strict(&["rev-parse", "--verify", "HEAD^{commit}"], path)?
        .trim()
        .to_owned();
    let config = GitCommand::run_strict(
        &[
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)",
            &current_ref,
        ],
        path,
    )?;
    let (remote, destination_ref) = config
        .trim_end_matches(['\r', '\n'])
        .split_once('\0')
        .ok_or_else(|| error("Configure an upstream branch before reviewing a rewrite push"))?;
    if remote.is_empty()
        || remote.starts_with('-')
        || remote == "."
        || !destination_ref.starts_with("refs/heads/")
    {
        return Err(error(
            "Configure an unambiguous remote upstream branch before pushing",
        ));
    }
    GitCommand::run(&["check-ref-format", destination_ref], Some(path))?;
    // Never send the URL to the client: it may contain credentials.
    let urls = GitCommand::run_strict(&["remote", "get-url", "--push", "--all", remote], path)
        .map_err(|_| error("Unable to resolve the push destination"))?;
    let urls: Vec<_> = urls.lines().collect();
    if urls.len() != 1 || urls[0].is_empty() {
        return Err(error("The remote must have exactly one push destination"));
    }
    let fetch_urls = GitCommand::run_strict(&["remote", "get-url", "--all", remote], path)
        .map_err(|_| error("Unable to resolve the fetch destination"))?;
    let fetch_urls: Vec<_> = fetch_urls.lines().collect();
    if fetch_urls.len() != 1 || fetch_urls[0] != urls[0] {
        return Err(error(
            "Rewrite push requires matching, unambiguous fetch and push destinations",
        ));
    }
    let destination_fingerprint = format!("{:x}", Sha256::digest(urls[0].as_bytes()));
    let advertised = GitCommand::run_strict(
        &[
            "ls-remote",
            "--refs",
            "--exit-code",
            remote,
            destination_ref,
        ],
        path,
    )
    .map_err(|_| {
        error("Could not read the destination branch; check access and remote configuration")
    })?;
    let mut lines = advertised.lines();
    let (remote_oid, found_ref) = lines
        .next()
        .and_then(|line| line.split_once('\t'))
        .ok_or_else(|| error("The remote branch was not found"))?;
    if lines.next().is_some() || found_ref != destination_ref || !super::stash::is_oid(remote_oid) {
        return Err(error("The remote returned an invalid branch tip"));
    }
    let exclude = format!("^{local_oid}");
    let shallow = GitCommand::run_strict(&["rev-parse", "--is-shallow-repository"], path)?;
    let commits_removed = if shallow.trim() == "false" {
        GitCommand::run_strict(&["rev-list", "--count", remote_oid, &exclude], path)
            .ok()
            .and_then(|count| count.trim().parse::<u32>().ok())
    } else {
        None
    };
    Ok(RewritePushReview {
        current_ref,
        local_oid,
        remote: remote.to_owned(),
        destination_ref: destination_ref.to_owned(),
        remote_oid: remote_oid.to_owned(),
        destination_fingerprint,
        commits_removed,
    })
}

/// Git atomically checks the remote tip against the exact value reviewed.
pub fn push_rewrite(root: &str, expected: &RewritePushReview) -> Result<(), GitError> {
    let current = review_rewrite_push(root)?;
    if current != *expected {
        return Err(error(
            "The branch or push destination changed; review the push again",
        ));
    }
    let lease = format!(
        "--force-with-lease={}:{}",
        expected.destination_ref, expected.remote_oid
    );
    let refspec = format!("{}:{}", expected.local_oid, expected.destination_ref);
    GitCommand::run_integration(
        &[
            "push",
            "--no-mirror",
            "--no-follow-tags",
            "--recurse-submodules=no",
            &lease,
            &expected.remote,
            &refspec,
        ],
        Path::new(root),
    )
    .map(|_| ())
    .map_err(|_| {
        error("Push could not be confirmed; refresh and review the remote before retrying")
    })
}
