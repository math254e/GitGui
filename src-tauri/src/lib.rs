mod git;
mod workspace;

use git::cache::{
    CommitFileDiffKey, CommitFileDiffLookup, CommitFilesKey, InFlightCommitFileDiff,
    SharedCommitFilesCache,
};
use git::command::GitError;
use git::repository::{
    load_commit_file_diff as load_diff_for_commit_file, load_commit_files_from_root,
    load_repository as load_repository_snapshot,
    load_working_tree_file_diff as load_diff_for_working_tree_file, CommitFile, CommitFileDiff,
    RepositorySnapshot,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use workspace::{SharedWorkspaceState, WorkspaceSnapshot};

const PREFETCH_COMMIT_DIFF_LIMIT: usize = 6;

#[tauri::command]
async fn load_repository(path: String) -> Result<RepositorySnapshot, GitError> {
    tauri::async_runtime::spawn_blocking(move || load_repository_snapshot(&path))
        .await
        .map_err(|error| GitError {
            message: format!("Failed to join repository task: {error}"),
            stderr: String::new(),
            status: None,
        })?
}

#[tauri::command]
async fn load_commit_files(
    cache: State<'_, SharedCommitFilesCache>,
    path: String,
    commit_hash: String,
) -> Result<Vec<CommitFile>, GitError> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        load_commit_files_cached(&cache, &path, &commit_hash)
    })
    .await
    .map_err(|error| GitError {
        message: format!("Failed to join commit files task: {error}"),
        stderr: String::new(),
        status: None,
    })?
}

#[tauri::command]
async fn prefetch_first_commit_files(
    cache: State<'_, SharedCommitFilesCache>,
    repo_root: String,
    commit_hashes: Vec<String>,
) -> Result<(), String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        prefetch_first_commit_files_blocking(&cache, &repo_root, &commit_hashes)
            .map_err(format_git_error)
    })
    .await
    .map_err(|error| format!("Failed to join commit files prefetch task: {error}"))?
}

#[tauri::command]
async fn load_commit_file_diff(
    cache: State<'_, SharedCommitFilesCache>,
    path: String,
    commit_hash: String,
    parent_hash: Option<String>,
    file: CommitFile,
) -> Result<CommitFileDiff, GitError> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let result = load_commit_file_diff_cached(
            &cache,
            &path,
            &commit_hash,
            parent_hash.as_deref(),
            &file,
        );
        log_slow_task(
            "load_commit_file_diff",
            started,
            Some(format!("{} {}", short_hash(&commit_hash), file.path)),
        );
        result
    })
    .await
    .map_err(|error| GitError {
        message: format!("Failed to join commit file diff task: {error}"),
        stderr: String::new(),
        status: None,
    })?
}

#[tauri::command]
async fn prefetch_commit_file_diffs(
    cache: State<'_, SharedCommitFilesCache>,
    path: String,
    commit_hash: String,
    parent_hash: Option<String>,
) -> Result<(), String> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        prefetch_commit_file_diffs_blocking(&cache, &path, &commit_hash, parent_hash.as_deref())
            .map_err(format_git_error)
    })
    .await
    .map_err(|error| format!("Failed to join commit file diff prefetch task: {error}"))?
}

#[tauri::command]
async fn load_working_tree_file_diff(
    path: String,
    head_hash: Option<String>,
    file: CommitFile,
) -> Result<CommitFileDiff, GitError> {
    tauri::async_runtime::spawn_blocking(move || {
        load_diff_for_working_tree_file(&path, head_hash.as_deref(), &file)
    })
    .await
    .map_err(|error| GitError {
        message: format!("Failed to join working tree diff task: {error}"),
        stderr: String::new(),
        status: None,
    })?
}

#[tauri::command]
async fn restore_workspace(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || workspace::restore_workspace(&app, &state))
        .await
        .map_err(|error| format!("Failed to join workspace restore task: {error}"))?
}

#[tauri::command]
async fn import_legacy_workspace(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    legacy_state: serde_json::Value,
) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace::import_legacy_workspace(&app, &state, legacy_state)
    })
    .await
    .map_err(|error| format!("Failed to join workspace import task: {error}"))?
}

#[tauri::command]
async fn open_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    path: String,
) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || workspace::open_repository(&app, &state, path))
        .await
        .map_err(|error| format!("Failed to join repository open task: {error}"))?
}

#[tauri::command]
async fn open_recent_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    root: String,
) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace::open_recent_repository(&app, &state, root)
    })
    .await
    .map_err(|error| format!("Failed to join recent repository open task: {error}"))?
}

#[tauri::command]
async fn close_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    cache: State<'_, SharedCommitFilesCache>,
    repo_id: String,
) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = workspace::close_repository(&app, &state, repo_id.clone())?;
        evict_repo_cache(&cache, &repo_id)?;
        Ok(snapshot)
    })
    .await
    .map_err(|error| format!("Failed to join repository close task: {error}"))?
}

#[tauri::command]
async fn remove_recent_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    cache: State<'_, SharedCommitFilesCache>,
    root: String,
) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = workspace::remove_recent_repository(&app, &state, root.clone())?;
        evict_repo_cache(&cache, &root)?;
        Ok(snapshot)
    })
    .await
    .map_err(|error| format!("Failed to join recent repository remove task: {error}"))?
}

#[tauri::command]
async fn select_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    repo_id: String,
) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace::select_repository(&app, &state, repo_id)
    })
    .await
    .map_err(|error| format!("Failed to join repository select task: {error}"))?
}

#[tauri::command]
async fn refresh_workspace_repositories(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || workspace::refresh_open_repositories(&app, &state))
        .await
        .map_err(|error| format!("Failed to join repositories refresh task: {error}"))?
}

#[tauri::command]
async fn refresh_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    repo_id: String,
) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace::refresh_repository(&app, &state, repo_id)
    })
    .await
    .map_err(|error| format!("Failed to join repository refresh task: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SharedWorkspaceState::default())
        .manage(SharedCommitFilesCache::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            restore_workspace,
            import_legacy_workspace,
            open_workspace_repository,
            open_recent_workspace_repository,
            close_workspace_repository,
            remove_recent_workspace_repository,
            select_workspace_repository,
            refresh_workspace_repositories,
            refresh_workspace_repository,
            load_repository,
            load_commit_files,
            prefetch_first_commit_files,
            load_commit_file_diff,
            prefetch_commit_file_diffs,
            load_working_tree_file_diff
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn commit_file_diff_key(
    repo_root: &str,
    commit_hash: &str,
    parent_hash: Option<&str>,
    file: &CommitFile,
) -> CommitFileDiffKey {
    CommitFileDiffKey {
        repo_root: repo_root.to_string(),
        commit_hash: commit_hash.to_string(),
        parent_hash: parent_hash.map(ToString::to_string),
        path: file.path.clone(),
        original_path: file.original_path.clone(),
        status: file.status.clone(),
    }
}

fn evict_repo_cache(cache: &SharedCommitFilesCache, repo_root: &str) -> Result<(), String> {
    cache
        .lock()
        .map_err(|_| "Commit file cache is unavailable.".to_string())?
        .evict_repo(repo_root);

    Ok(())
}

fn load_commit_file_diff_cached(
    cache: &SharedCommitFilesCache,
    repo_root: &str,
    commit_hash: &str,
    parent_hash: Option<&str>,
    file: &CommitFile,
) -> Result<CommitFileDiff, GitError> {
    let key = commit_file_diff_key(repo_root, commit_hash, parent_hash, file);
    let lookup = cache
        .lock()
        .map_err(|_| GitError {
            message: "Commit file cache is unavailable.".to_string(),
            stderr: String::new(),
            status: None,
        })?
        .get_or_start_diff(&key);

    match lookup {
        CommitFileDiffLookup::Cached(diff) => {
            log_cache_hit(
                "commit_diff",
                Some(format!("{} {}", short_hash(commit_hash), file.path)),
            );
            Ok(diff)
        }
        CommitFileDiffLookup::Loading(in_flight) => wait_for_diff_load(in_flight),
        CommitFileDiffLookup::StartLoad => {
            let result = load_diff_for_commit_file(repo_root, commit_hash, parent_hash, file);
            cache
                .lock()
                .map_err(|_| GitError {
                    message: "Commit file cache is unavailable.".to_string(),
                    stderr: String::new(),
                    status: None,
                })?
                .finish_diff_load(&key, result.clone());

            result
        }
    }
}

fn wait_for_diff_load(in_flight: InFlightCommitFileDiff) -> Result<CommitFileDiff, GitError> {
    let (state, ready) = &*in_flight;
    let mut state = state.lock().map_err(|_| GitError {
        message: "Commit file diff load state is unavailable.".to_string(),
        stderr: String::new(),
        status: None,
    })?;

    while state.is_none() {
        state = ready.wait(state).map_err(|_| GitError {
            message: "Commit file diff load state is unavailable.".to_string(),
            stderr: String::new(),
            status: None,
        })?;
    }

    state.clone().expect("diff load state should be ready")
}

fn is_commit_file_diff_cached(
    cache: &SharedCommitFilesCache,
    repo_root: &str,
    commit_hash: &str,
    parent_hash: Option<&str>,
    file: &CommitFile,
) -> Result<bool, GitError> {
    let key = commit_file_diff_key(repo_root, commit_hash, parent_hash, file);
    Ok(cache
        .lock()
        .map_err(|_| GitError {
            message: "Commit file cache is unavailable.".to_string(),
            stderr: String::new(),
            status: None,
        })?
        .get_diff(&key)
        .is_some())
}

fn load_commit_files_cached(
    cache: &SharedCommitFilesCache,
    repo_root: &str,
    commit_hash: &str,
) -> Result<Vec<CommitFile>, GitError> {
    let key = CommitFilesKey {
        repo_root: repo_root.to_string(),
        commit_hash: commit_hash.to_string(),
    };

    if let Some(files) = cache
        .lock()
        .map_err(|_| GitError {
            message: "Commit file cache is unavailable.".to_string(),
            stderr: String::new(),
            status: None,
        })?
        .get(&key)
    {
        return Ok(files);
    }

    let files = load_commit_files_from_root(repo_root, commit_hash)?;
    cache
        .lock()
        .map_err(|_| GitError {
            message: "Commit file cache is unavailable.".to_string(),
            stderr: String::new(),
            status: None,
        })?
        .insert_recent(key, files.clone());

    Ok(files)
}

fn prefetch_commit_file_diffs_blocking(
    cache: &SharedCommitFilesCache,
    repo_root: &str,
    commit_hash: &str,
    parent_hash: Option<&str>,
) -> Result<(), GitError> {
    let started = Instant::now();
    let files = load_commit_files_cached(cache, repo_root, commit_hash)?;
    let mut prefetched = 0;

    for file in files {
        if prefetched >= PREFETCH_COMMIT_DIFF_LIMIT {
            break;
        }

        if is_commit_file_diff_cached(cache, repo_root, commit_hash, parent_hash, &file)? {
            continue;
        }

        load_commit_file_diff_cached(cache, repo_root, commit_hash, parent_hash, &file)?;
        prefetched += 1;
    }

    log_prefetch(
        "commit_diffs",
        started,
        prefetched,
        Some(short_hash(commit_hash).to_string()),
    );
    Ok(())
}

fn prefetch_first_commit_files_blocking(
    cache: &SharedCommitFilesCache,
    repo_root: &str,
    commit_hashes: &[String],
) -> Result<(), GitError> {
    for commit_hash in commit_hashes {
        load_commit_files_cached(cache, repo_root, commit_hash)?;
    }

    Ok(())
}

fn format_git_error(error: GitError) -> String {
    let details = if error.stderr.is_empty() {
        String::new()
    } else {
        format!(" {}", error.stderr)
    };

    format!("{}{}", error.message, details)
}

fn short_hash(hash: &str) -> &str {
    hash.get(..8).unwrap_or(hash)
}

fn log_slow_task(task: &str, started: Instant, detail: Option<String>) {
    #[cfg(debug_assertions)]
    {
        let elapsed = started.elapsed();

        if elapsed >= Duration::from_millis(750) {
            if let Some(detail) = detail {
                eprintln!("[perf] {task} took {}ms: {detail}", elapsed.as_millis());
            } else {
                eprintln!("[perf] {task} took {}ms", elapsed.as_millis());
            }
        }
    }
}

fn log_prefetch(task: &str, started: Instant, count: usize, detail: Option<String>) {
    #[cfg(debug_assertions)]
    {
        let elapsed = started.elapsed();

        if let Some(detail) = detail {
            eprintln!(
                "[perf] prefetch {task} warmed {count} in {}ms: {detail}",
                elapsed.as_millis()
            );
        } else {
            eprintln!(
                "[perf] prefetch {task} warmed {count} in {}ms",
                elapsed.as_millis()
            );
        }
    }
}

fn log_cache_hit(cache: &str, detail: Option<String>) {
    #[cfg(debug_assertions)]
    {
        if let Some(detail) = detail {
            eprintln!("[perf] {cache} cache hit: {detail}");
        } else {
            eprintln!("[perf] {cache} cache hit");
        }
    }
}
