//! Stash protocol boundary. Core owns capture, decoding, restoration and safety.
//! Lock order is one worktree registration, then its common Git directory.
//! Never acquire another registration while holding the common-directory lock:
//! worktree removal takes multiple registration locks in sorted order.
use super::*;
use gitgui_core::git::{
    command::{git_command, GitCommand},
    stash::{StashError, StashTarget},
    stash_actions as actions, stash_selected as selected,
};
use gitgui_protocol::{
    GitStashBranchParams, GitStashCreatedBranch, GitStashFileDiffParams, GitStashFileDiffResult,
    GitStashFilesResult, GitStashMutationOutcome, GitStashMutationResult,
    GitStashPushSelectedOutcome, GitStashPushSelectedParams, GitStashPushSelectedResult,
    GitStashRestoreOutcome, GitStashSelectionSource, GitStashState, GitStashTarget,
    GitStashTargetParams, RepositoryChangeKind, RepositoryChanged, EVENT_REPOSITORY_CHANGED,
};
use std::{collections::HashSet, io::Read, process::Stdio};

const MAX_PATHS: usize = 4096;
const MAX_PATH_BYTES: usize = 32_768;
const MAX_SELECTION_BYTES: usize = 1024 * 1024;

fn invalid(message: &str) -> ProtocolError {
    ProtocolError::new(error_codes::INVALID_PARAMS, message)
}

/// Saved object paths never touch the live filesystem. In particular tabs,
/// newlines, colons and backslashes are literal UTF-8 names on capable hosts.
fn validate_path(path: &str, live: bool) -> Result<(), ProtocolError> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.contains('\0')
        || path.split('/').count() > 128
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(invalid("Expected a literal repository-relative file path"));
    }
    if live
        && path
            .split('/')
            .any(|part| part.eq_ignore_ascii_case(".git"))
    {
        return Err(invalid("Git metadata cannot be selected"));
    }
    #[cfg(windows)]
    if live
        && (path.contains('\\')
            || path
                .chars()
                .any(|c| c < ' ' || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
            || path.split('/').any(|part| {
                let stem = part
                    .split('.')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_uppercase();
                part.ends_with(['.', ' '])
                    || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || stem
                        .strip_prefix("COM")
                        .or_else(|| stem.strip_prefix("LPT"))
                        .is_some_and(|n| {
                            matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                        })
            }))
    {
        return Err(invalid("Selected path is unsafe on this platform"));
    }
    Ok(())
}

fn validate_selection(params: &GitStashPushSelectedParams) -> Result<(), ProtocolError> {
    validate_repository_id(&params.repository_id)?;
    if params.paths.is_empty()
        || params.paths.len() > MAX_PATHS
        || params.paths.iter().map(String::len).sum::<usize>() > MAX_SELECTION_BYTES
    {
        return Err(invalid(
            "paths must contain between 1 and 4096 files within 1 MiB",
        ));
    }
    let mut unique = HashSet::new();
    for path in &params.paths {
        validate_path(path, true)?;
        if !unique.insert(path) {
            return Err(invalid("paths must not contain duplicate files"));
        }
    }
    if let Some(message) = &params.message {
        validate_optional_text(message, "message", 4096)?;
    }
    Ok(())
}

fn validate_target(target: &GitStashTarget) -> Result<(), ProtocolError> {
    let number = target
        .selector
        .strip_prefix("stash@{")
        .and_then(|s| s.strip_suffix('}'));
    if !number.is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 20
            && s.bytes().all(|b| b.is_ascii_digit())
            && s.parse::<usize>().is_ok_and(|n| n.to_string() == s)
    }) || !matches!(target.expected_oid.len(), 40 | 64)
        || !target.expected_oid.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(invalid(
            "Expected exact stash@{n} selector and full object ID",
        ));
    }
    Ok(())
}

fn domain_target(root: &str, target: &GitStashTarget) -> Result<StashTarget, ProtocolError> {
    let format = GitCommand::run(
        &["rev-parse", "--show-object-format"],
        Some(Path::new(root)),
    )
    .map_err(|_| git_failure_error("Repository object format could not be read"))?;
    let size = match format.trim() {
        "sha1" => 40,
        "sha256" => 64,
        _ => return Err(git_failure_error("Unsupported repository object format")),
    };
    if target.expected_oid.len() != size {
        return Err(invalid(
            "expectedOid must be a full object ID in this repository's format",
        ));
    }
    Ok(StashTarget {
        selector: target.selector.clone(),
        expected_oid: target.expected_oid.clone(),
    })
}

fn domain_error(error: StashError) -> ProtocolError {
    match error {
        StashError::TargetChanged => ProtocolError::new(
            error_codes::STASH_TARGET_CHANGED,
            "The reviewed stash changed or is missing. Refresh and review it again.",
        ),
        // Neither raw Git output nor a path/argument-bearing GitError is safe
        // to expose at this boundary. Domain receipt diagnostics are separate.
        StashError::Invalid(_) => git_failure_error(
            "The stash could not be validated or inspected; no new action was completed",
        ),
    }
}

fn validate_branch(root: &str, name: &str) -> Result<(), ProtocolError> {
    validate_branch_argument(name, "name")?;
    if matches!(name, "@" | "HEAD") {
        return Err(invalid("name must be a literal new branch name"));
    }
    let status = git_command()
        .args(["check-ref-format", &format!("refs/heads/{name}")])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| git_failure_error("Branch name could not be checked"))?;
    if !status.success() {
        return Err(invalid("name must be a valid literal branch name"));
    }
    Ok(())
}

/// Git is authoritative about linked metadata. The common directory normally
/// lies outside a linked worktree, so containment beneath that worktree would
/// be incorrect. Canonicalize the actual directory, not a renderer-supplied path.
fn common_directory(root: &str) -> Result<String, ProtocolError> {
    let mut child = git_command()
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| git_failure_error("Repository metadata could not be located"))?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .expect("piped stdout")
        .take(MAX_PATH_BYTES as u64 + 1)
        .read_to_end(&mut bytes);
    let status = child
        .wait()
        .map_err(|_| git_failure_error("Repository metadata could not be located"))?;
    if read.is_err() || !status.success() || bytes.len() > MAX_PATH_BYTES {
        return Err(git_failure_error(
            "Repository metadata could not be located",
        ));
    }
    let output = std::str::from_utf8(&bytes)
        .map_err(|_| git_failure_error("Repository metadata path is not UTF-8"))?;
    let output = output.strip_suffix('\n').unwrap_or(output);
    #[cfg(windows)]
    let output = output.strip_suffix('\r').unwrap_or(output);
    if !Path::new(output).is_absolute() {
        return Err(git_failure_error(
            "Repository metadata path is not absolute",
        ));
    }
    let directory = fs::canonicalize(output)
        .map_err(|_| git_failure_error("Repository metadata is inaccessible"))?;
    if !directory.is_dir() || !directory.is_absolute() {
        return Err(git_failure_error("Repository metadata is inaccessible"));
    }
    let directory = directory
        .to_str()
        .ok_or_else(|| git_failure_error("Repository metadata path is not UTF-8"))?;
    Ok(path_key(directory))
}

impl ServerState {
    async fn stash_mutation_lock(&self, common: &str) -> Arc<Mutex<()>> {
        self.stash_mutation_locks
            .lock()
            .await
            .entry(common.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// One ordered stream for watcher hints and explicit mutation invalidation.
    /// Sending under this short synchronous guard preserves publication order.
    pub(super) fn publish_repository_change(&self, change: RepositoryChanged) {
        let mut sequence = self
            .repository_event_sequence
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *sequence += 1;
        if let Ok(payload) = serde_json::to_value(change) {
            let _ = self
                .repository_events
                .send(gitgui_protocol::OrderedEventEnvelope::new(
                    *sequence,
                    EVENT_REPOSITORY_CHANGED,
                    payload,
                ));
        }
    }

    fn invalidate_stash_repositories(&self, repositories: &[ConfiguredRepository]) {
        for repository in repositories {
            if let Ok(mut cache) = self.cache.lock() {
                cache.evict_repo(&repository.operation_path);
            }
            if let Ok(mut cache) = self.hunk_cache.lock() {
                cache.evict_repo(&repository.operation_path);
            }
            // Reflog positions changed, but immutable saved snapshots did not.
            self.stash_preparation.forget(&repository.operation_path);
            // Snapshot invalidation includes stash catalog, history/branches,
            // status and file views. No post-mutation filesystem read is needed.
            self.publish_repository_change(RepositoryChanged {
                repository_id: repository.summary.id.clone(),
                kind: RepositoryChangeKind::Snapshot,
                paths: None,
            });
        }
    }
}

/// The queue retains started dispatches on disconnect/cancel. Moving owned
/// guards into the blocking worker additionally prevents a dropped await from
/// releasing serialization while Git still runs.
async fn mutate<T, F>(
    state: &ServerState,
    repository_id: &str,
    operation: F,
) -> Result<T, ProtocolError>
where
    T: Send + 'static,
    F: FnOnce(&str) -> Result<T, ProtocolError> + Send + 'static,
{
    validate_repository_id(repository_id)?;
    let repository = state
        .repository(repository_id)
        .await
        .ok_or_else(|| repository_not_configured_error(repository_id))?;
    let worktree = state
        .git_mutation_lock(repository_id)
        .await
        .lock_owned()
        .await;
    let root = repository.operation_path.clone();
    let common = spawn_blocking(move || common_directory(&root))
        .await
        .map_err(|_| git_failure_error("Repository metadata worker failed"))??;
    let stash = state.stash_mutation_lock(&common).await.lock_owned();
    #[cfg(test)]
    let stash = tests::observe_common_lock(stash);
    let stash = stash.await;
    #[cfg(test)]
    let worker_progress = tests::mutation_progress();
    #[cfg(test)]
    tests::report_progress(
        &worker_progress,
        tests::MutationProgress::CommonLockAcquired,
    );
    let known = state.repositories.read().await.clone();
    let original = repository.clone();
    let affected = spawn_blocking(move || {
        let mut affected = vec![original.clone()];
        for candidate in known {
            if candidate.summary.id != original.summary.id
                && common_directory(&candidate.operation_path).is_ok_and(|key| key == common)
            {
                affected.push(candidate);
            }
        }
        affected
    })
    .await
    .unwrap_or_else(|_| vec![repository.clone()]);
    let result = spawn_blocking(move || {
        let _guards = (worktree, stash);
        #[cfg(test)]
        tests::report_progress(&worker_progress, tests::MutationProgress::WorkerEntered);
        operation(&repository.operation_path)
    })
    .await;
    // Even failures/panics may follow partial progress. Invalidation cannot
    // replace or discard a completed receipt, including when refresh is broken.
    state.invalidate_stash_repositories(&affected);
    result.map_err(|_| ProtocolError::new(error_codes::INTERNAL,
        "Stash worker failed; completion is unknown. Inspect repository state before another action."))?
}

pub(super) async fn legacy_action<T, F>(
    state: &ServerState,
    repository_id: &str,
    operation: F,
) -> Result<(RepositorySummary, RepositorySnapshot, T), ProtocolError>
where
    T: Send + 'static,
    F: FnOnce(&str) -> Result<T, GitError> + Send + 'static,
{
    validate_repository_id(repository_id)?;
    let repository = state
        .repository(repository_id)
        .await
        .ok_or_else(|| repository_not_configured_error(repository_id))?;
    // Preserve legacy snapshot results and their existing serialization through
    // refresh. Only the new methods promise a refresh-independent receipt.
    mutate(state, repository_id, move |root| {
        let value = operation(root).map_err(|_| git_failure_error("Git stash operation failed"))?;
        let snapshot = load_snapshot(&repository).map_err(|_| {
            applied_refresh_error(git_failure_error(
                "Repository snapshot could not be refreshed",
            ))
        })?;
        Ok((repository.summary, snapshot, value))
    })
    .await
}

fn receipt(
    repository_id: String,
    target: GitStashTarget,
    result: actions::StashMutationReceipt,
) -> GitStashMutationResult {
    GitStashMutationResult {
        repository_id,
        target,
        outcome: match result.outcome {
            actions::StashMutationOutcome::Success => GitStashMutationOutcome::Success,
            actions::StashMutationOutcome::Conflicts => GitStashMutationOutcome::Conflicts,
            actions::StashMutationOutcome::Partial => GitStashMutationOutcome::Partial,
            actions::StashMutationOutcome::BranchCreatedRestoreFailed => {
                GitStashMutationOutcome::BranchCreatedRestoreFailed
            }
        },
        stash_state: match result.stash_state {
            actions::StashState::Retained => GitStashState::Retained,
            actions::StashState::Removed => GitStashState::Removed,
        },
        restore: match result.restore {
            actions::StashRestoreOutcome::NotAttempted => GitStashRestoreOutcome::NotAttempted,
            actions::StashRestoreOutcome::Succeeded => GitStashRestoreOutcome::Succeeded,
            actions::StashRestoreOutcome::Conflicts => GitStashRestoreOutcome::Conflicts,
            actions::StashRestoreOutcome::Failed => GitStashRestoreOutcome::Failed,
        },
        branch: result.branch.map(|branch| GitStashCreatedBranch {
            name: branch.name,
            switched: branch.switched,
        }),
        error: result.error.map(|error| git_failure_error(error.message())),
    }
}

pub(super) async fn dispatch(
    id: String,
    method: &str,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let result: Result<Value, ProtocolError> = async {
        match method {
            METHOD_GIT_STASH_PUSH_SELECTED => {
                let p = parse_params::<GitStashPushSelectedParams>(params, method)?;
                validate_selection(&p)?;
                let repository_id = p.repository_id.clone();
                let result = mutate(state, &repository_id, move |root| {
                    let source = match p.source {
                        GitStashSelectionSource::Staged => selected::StashSelectionSource::Staged,
                        GitStashSelectionSource::Unstaged => selected::StashSelectionSource::Unstaged,
                    };
                    let saved = selected::stash_push_selected(root, source, &p.paths, p.message.as_deref())
                        .map_err(|_| git_failure_error("Selected changes could not be saved; no stash was published"))?;
                    Ok(GitStashPushSelectedResult {
                        repository_id: p.repository_id,
                        outcome: match saved.outcome {
                            selected::StashPushSelectedOutcome::Success => GitStashPushSelectedOutcome::Success,
                            selected::StashPushSelectedOutcome::NoChanges => GitStashPushSelectedOutcome::NoChanges,
                            selected::StashPushSelectedOutcome::Partial => GitStashPushSelectedOutcome::Partial,
                        },
                        stash: saved.stash.map(protocol_stash_info),
                        error: saved.error.map(|_| git_failure_error("The stash was saved, but selected-change cleanup was incomplete. Inspect the retained stash and working changes.")),
                    })
                }).await?;
                serde_json::to_value(result)
            }
            METHOD_GIT_STASH_APPLY | METHOD_GIT_STASH_POP_TARGET | METHOD_GIT_STASH_DROP | METHOD_GIT_STASH_BRANCH => {
                let (repository_id, target, name) = if method == METHOD_GIT_STASH_BRANCH {
                    let p = parse_params::<GitStashBranchParams>(params, method)?;
                    validate_branch_argument(&p.name, "name")?;
                    (p.repository_id, p.target, Some(p.name))
                } else {
                    let p = parse_params::<GitStashTargetParams>(params, method)?;
                    (p.repository_id, p.target, None)
                };
                validate_repository_id(&repository_id)?;
                validate_target(&target)?;
                let captured_id = repository_id.clone();
                let method = method.to_owned();
                let result = mutate(state, &repository_id, move |root| {
                    let domain_target = domain_target(root, &target)?;
                    let result = match method.as_str() {
                        METHOD_GIT_STASH_APPLY => actions::apply_stash(root, &domain_target),
                        METHOD_GIT_STASH_POP_TARGET => actions::pop_stash(root, &domain_target),
                        METHOD_GIT_STASH_DROP => actions::drop_stash(root, &domain_target),
                        _ => {
                            let name = name.as_deref().expect("branch name parsed");
                            validate_branch(root, name)?;
                            actions::branch_from_stash(root, &domain_target, name)
                        }
                    }.map_err(domain_error)?;
                    Ok(receipt(captured_id, target, result))
                }).await?;
                serde_json::to_value(result)
            }
            METHOD_GIT_STASH_FILES | METHOD_GIT_STASH_FILE_DIFF => {
                let (repository_id, target, file_path) = if method == METHOD_GIT_STASH_FILES {
                    let p = parse_params::<GitStashTargetParams>(params, method)?;
                    (p.repository_id, p.target, None)
                } else {
                    let p = parse_params::<GitStashFileDiffParams>(params, method)?;
                    validate_path(&p.file_path, false)?;
                    (p.repository_id, p.target, Some(p.file_path))
                };
                validate_repository_id(&repository_id)?;
                validate_target(&target)?;
                let cache_generation = state.stash_cache.generation();
                let repository = state.repository(&repository_id).await
                    .ok_or_else(|| repository_not_configured_error(&repository_id))?;
                let cache = state.stash_cache.clone();
                let foreground = state.stash_preparation.foreground(&repository.operation_path, &target.expected_oid, cache_generation);
                let preparation = state.stash_preparation.clone();
                return spawn_blocking(move || {
                    // Retain priority until the actual blocking worker exits,
                    // including when a read RPC is cancelled or disconnected.
                    let foreground = foreground;
                    let root = &repository.operation_path;
                    let target = domain_target(root, &target)?;
                    let after = file_path.as_deref();
                    let result = if let Some(ref path) = file_path {
                        let diff = cache.diff_at(root, &target, &path, cache_generation).map_err(domain_error)?;
                        serde_json::to_value(GitStashFileDiffResult { diff: protocol_diff(diff) })
                    } else {
                        let (stash, files) = cache.files_at(root, &target, cache_generation).map_err(domain_error)?;
                        serde_json::to_value(GitStashFilesResult {
                            stash: protocol_stash_info(stash), files: files.into_iter().map(protocol_commit_file).collect(),
                        })
                    }.map_err(|_| ProtocolError::new(error_codes::INTERNAL, "Stash response could not be encoded"))?;
                    let paths = cache.prefetch_paths(root, &target.expected_oid, after);
                    preparation.after_read(&repository, target, &paths, foreground.epoch, cache_generation, foreground.selection);
                    Ok(result)
                }).await.map_err(|_| git_failure_error("Stash inspection worker failed"))?;
            }
            _ => unreachable!("stash dispatch is restricted to accepted methods"),
        }.map_err(|_| ProtocolError::new(error_codes::INTERNAL, "Stash response could not be encoded"))
    }.await;
    match result {
        Ok(value) => response_success(id, value),
        Err(error) => ResponseEnvelope::error(id, error),
    }
}

#[cfg(test)]
mod tests;
