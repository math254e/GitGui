mod git;

use git::command::GitError;
use git::repository::{load_repository as load_repository_snapshot, RepositorySnapshot};

#[tauri::command]
fn load_repository(path: String) -> Result<RepositorySnapshot, GitError> {
    load_repository_snapshot(&path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![load_repository])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
