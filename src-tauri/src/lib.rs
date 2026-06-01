mod git;

use git::command::GitError;
use git::repository::{
    load_commit_file_diff as load_diff_for_commit_file,
    load_working_tree_file_diff as load_diff_for_working_tree_file,
    load_commit_files as load_commit_files_for_commit, load_repository as load_repository_snapshot,
    CommitFile, CommitFileDiff, RepositorySnapshot,
};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_repository,
            load_commit_files,
            load_commit_file_diff,
            load_working_tree_file_diff
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
