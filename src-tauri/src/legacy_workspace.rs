use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const LEGACY_WORKSPACE_FILE_NAME: &str = "workspace-state.json";
const LEGACY_WORKSPACE_SOURCE: &str = "workspace-state.json";
const LEGACY_WORKSPACE_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyWorkspaceMigration {
    pub available: bool,
    pub source: String,
    pub version: u32,
    pub active_repository_path: Option<String>,
    pub open_repository_paths: Vec<String>,
    pub recent_repository_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLegacyWorkspace {
    #[serde(default)]
    open_repo_paths: Vec<String>,
    #[serde(default)]
    active_repo_path: Option<String>,
    #[serde(default)]
    recent_repos: Vec<StoredLegacyRecentRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLegacyRecentRepository {
    root: String,
}

pub fn read_migration(app: &AppHandle) -> Result<LegacyWorkspaceMigration, String> {
    let path = legacy_workspace_path(app)?;
    if !path.exists() {
        return Ok(empty_migration());
    }

    let contents = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Failed to read legacy workspace state at {}: {error}",
            path.display()
        )
    })?;
    let stored: StoredLegacyWorkspace = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "Failed to parse legacy workspace state at {}: {error}",
            path.display()
        )
    })?;

    Ok(LegacyWorkspaceMigration {
        available: true,
        source: LEGACY_WORKSPACE_SOURCE.to_string(),
        version: LEGACY_WORKSPACE_VERSION,
        active_repository_path: non_empty(stored.active_repo_path),
        open_repository_paths: unique_paths(stored.open_repo_paths),
        recent_repository_paths: unique_paths(
            stored
                .recent_repos
                .into_iter()
                .map(|repository| repository.root)
                .collect(),
        ),
    })
}

fn empty_migration() -> LegacyWorkspaceMigration {
    LegacyWorkspaceMigration {
        available: false,
        source: LEGACY_WORKSPACE_SOURCE.to_string(),
        version: LEGACY_WORKSPACE_VERSION,
        active_repository_path: None,
        open_repository_paths: Vec::new(),
        recent_repository_paths: Vec::new(),
    }
}

fn legacy_workspace_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(LEGACY_WORKSPACE_FILE_NAME))
        .map_err(|error| format!("Failed to locate app data directory: {error}"))
}

fn non_empty(path: Option<String>) -> Option<String> {
    path.filter(|path| !path.trim().is_empty())
}

fn unique_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| !path.trim().is_empty() && seen.insert(path.clone()))
        .collect()
}
