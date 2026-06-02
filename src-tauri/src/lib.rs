mod git;
mod workspace;

use git::command::GitError;
use git::repository::{
    load_commit_file_diff as load_diff_for_commit_file,
    load_working_tree_file_diff as load_diff_for_working_tree_file,
    load_commit_files as load_commit_files_for_commit, load_repository as load_repository_snapshot,
    CommitFile, CommitFileDiff, RepositorySnapshot,
};
use tauri::{AppHandle, State};
use workspace::{SharedWorkspaceState, WorkspaceSnapshot};

#[tauri::command]
fn load_repository(path: String) -> Result<RepositorySnapshot, GitError> {
    load_repository_snapshot(&path)
}

#[tauri::command]
fn load_commit_files(path: String, commit_hash: String) -> Result<Vec<CommitFile>, GitError> {
    load_commit_files_for_commit(&path, &commit_hash)
}

#[tauri::command]
fn load_commit_file_diff(
    path: String,
    commit_hash: String,
    file: CommitFile,
) -> Result<CommitFileDiff, GitError> {
    load_diff_for_commit_file(&path, &commit_hash, &file)
}

#[tauri::command]
fn load_working_tree_file_diff(
    path: String,
    file: CommitFile,
) -> Result<CommitFileDiff, GitError> {
    load_diff_for_working_tree_file(&path, &file)
}

#[tauri::command]
fn restore_workspace(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
) -> Result<WorkspaceSnapshot, String> {
    workspace::restore_workspace(&app, &state)
}

#[tauri::command]
fn import_legacy_workspace(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    legacy_state: serde_json::Value,
) -> Result<WorkspaceSnapshot, String> {
    workspace::import_legacy_workspace(&app, &state, legacy_state)
}

#[tauri::command]
fn open_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    path: String,
) -> Result<WorkspaceSnapshot, String> {
    workspace::open_repository(&app, &state, path)
}

#[tauri::command]
fn open_recent_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    root: String,
) -> Result<WorkspaceSnapshot, String> {
    workspace::open_recent_repository(&app, &state, root)
}

#[tauri::command]
fn close_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    repo_id: String,
) -> Result<WorkspaceSnapshot, String> {
    workspace::close_repository(&app, &state, repo_id)
}

#[tauri::command]
fn remove_recent_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    root: String,
) -> Result<WorkspaceSnapshot, String> {
    workspace::remove_recent_repository(&app, &state, root)
}

#[tauri::command]
fn select_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    repo_id: String,
) -> Result<WorkspaceSnapshot, String> {
    workspace::select_repository(&app, &state, repo_id)
}

#[tauri::command]
fn refresh_workspace_repositories(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
) -> Result<WorkspaceSnapshot, String> {
    workspace::refresh_open_repositories(&app, &state)
}

#[tauri::command]
fn refresh_workspace_repository(
    app: AppHandle,
    state: State<'_, SharedWorkspaceState>,
    repo_id: String,
) -> Result<WorkspaceSnapshot, String> {
    workspace::refresh_repository(&app, &state, repo_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SharedWorkspaceState::default())
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
            load_commit_file_diff,
            load_working_tree_file_diff
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
