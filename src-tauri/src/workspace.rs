use crate::git::repository::{load_repository, RepositorySnapshot};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

const MAX_RECENT_REPOS: usize = 10;
const WORKSPACE_FILE_NAME: &str = "workspace-state.json";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub active_repo_id: Option<String>,
    pub open_repos: Vec<WorkspaceRepo>,
    pub recent_repos: Vec<RecentRepo>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepo {
    pub id: String,
    pub title: String,
    pub snapshot: RepositorySnapshot,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub root: String,
    pub title: String,
    pub snapshot: Option<RepositorySnapshot>,
}

#[derive(Default)]
pub struct WorkspaceState {
    active_repo_id: Option<String>,
    open_repos: Vec<WorkspaceRepo>,
    recent_repos: Vec<RecentRepo>,
}

pub type SharedWorkspaceState = Arc<Mutex<WorkspaceState>>;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkspace {
    open_repo_paths: Vec<String>,
    active_repo_path: Option<String>,
    recent_repos: Vec<StoredRecentRepo>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecentRepo {
    root: String,
    title: String,
    #[serde(default)]
    snapshot: Option<serde_json::Value>,
}

impl WorkspaceState {
    fn snapshot(&self) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            active_repo_id: self.active_repo_id.clone(),
            open_repos: self.open_repos.clone(),
            recent_repos: self.recent_repos.clone(),
        }
    }

    fn upsert_open_snapshot(&mut self, snapshot: RepositorySnapshot, activate: bool) {
        let id = snapshot.info.root.clone();
        let title = repo_title(&id);

        if let Some(repo) = self.open_repos.iter_mut().find(|repo| repo.id == id) {
            repo.title = title;
            repo.snapshot = snapshot.clone();
            repo.error = None;
        } else {
            self.open_repos.push(WorkspaceRepo {
                id: id.clone(),
                title,
                snapshot: snapshot.clone(),
                error: None,
            });
        }

        self.upsert_recent_snapshot(snapshot);

        if activate {
            self.active_repo_id = Some(id);
        }
    }

    fn upsert_recent_snapshot(&mut self, snapshot: RepositorySnapshot) {
        let root = snapshot.info.root.clone();
        let recent_repo = RecentRepo {
            title: repo_title(&root),
            root: root.clone(),
            snapshot: Some(snapshot),
        };

        self.recent_repos.retain(|repo| repo.root != root);
        self.recent_repos.insert(0, recent_repo);
        self.recent_repos.truncate(MAX_RECENT_REPOS);
    }

    fn close_repository(&mut self, repo_id: &str) {
        let repo_index = self.open_repos.iter().position(|repo| repo.id == repo_id);
        let Some(repo_index) = repo_index else {
            return;
        };

        let was_active = self.active_repo_id.as_deref() == Some(repo_id);
        self.open_repos.remove(repo_index);

        if was_active {
            self.active_repo_id = self
                .open_repos
                .get(repo_index.min(self.open_repos.len().saturating_sub(1)))
                .map(|repo| repo.id.clone());
        }
    }

    fn remove_recent_repository(&mut self, root: &str) {
        self.recent_repos.retain(|repo| repo.root != root);
        self.open_repos.retain(|repo| repo.id != root);

        if self.active_repo_id.as_deref() == Some(root) {
            self.active_repo_id = None;
        }
    }

    fn select_repository(&mut self, repo_id: &str) {
        if self.open_repos.iter().any(|repo| repo.id == repo_id) {
            self.active_repo_id = Some(repo_id.to_string());
        }
    }

    fn update_open_repo_error(&mut self, repo_id: &str, error: String) {
        if let Some(repo) = self.open_repos.iter_mut().find(|repo| repo.id == repo_id) {
            repo.error = Some(error);
        }
    }

    fn load_from_disk(app: &AppHandle) -> Result<Self, String> {
        let path = workspace_file_path(app)?;

        if !path.exists() {
            return Ok(Self::default());
        }

        let contents = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read workspace state: {error}"))?;
        let stored: StoredWorkspace = serde_json::from_str(&contents)
            .map_err(|error| format!("Failed to parse workspace state: {error}"))?;
        Self::from_stored(stored)
    }

    fn from_stored(stored: StoredWorkspace) -> Result<Self, String> {
        let mut state = Self {
            active_repo_id: None,
            open_repos: Vec::new(),
            recent_repos: normalize_recent_repos(stored.recent_repos),
        };

        for path in stored.open_repo_paths {
            if let Ok(snapshot) = load_repository(&path) {
                let id = snapshot.info.root.clone();
                state.open_repos.push(WorkspaceRepo {
                    title: repo_title(&id),
                    id,
                    snapshot,
                    error: None,
                });
            }
        }

        state.active_repo_id = stored
            .active_repo_path
            .and_then(|active_path| {
                state
                    .open_repos
                    .iter()
                    .find(|repo| repo.id == active_path)
                    .map(|repo| repo.id.clone())
            })
            .or_else(|| state.open_repos.first().map(|repo| repo.id.clone()));
        Ok(state)
    }

    fn save_to_disk(&self, app: &AppHandle) -> Result<(), String> {
        let path = workspace_file_path(app)?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create workspace state directory: {error}"))?;
        }

        let stored = StoredWorkspace {
            open_repo_paths: self.open_repos.iter().map(|repo| repo.id.clone()).collect(),
            active_repo_path: self.active_repo_id.clone(),
            recent_repos: self
                .recent_repos
                .iter()
                .map(|repo| StoredRecentRepo {
                    root: repo.root.clone(),
                    title: repo.title.clone(),
                    snapshot: repo
                        .snapshot
                        .as_ref()
                        .and_then(|snapshot| serde_json::to_value(snapshot).ok()),
                })
                .collect(),
        };
        let contents = serde_json::to_string_pretty(&stored)
            .map_err(|error| format!("Failed to serialize workspace state: {error}"))?;
        fs::write(path, contents)
            .map_err(|error| format!("Failed to write workspace state: {error}"))
    }
}

pub fn restore_workspace(
    app: &AppHandle,
    state: &SharedWorkspaceState,
) -> Result<WorkspaceSnapshot, String> {
    let restored_state = WorkspaceState::load_from_disk(app)?;
    let snapshot = restored_state.snapshot();
    *state
        .lock()
        .map_err(|_| "Workspace state is unavailable.".to_string())? = restored_state;
    Ok(snapshot)
}

pub fn import_legacy_workspace(
    app: &AppHandle,
    state: &SharedWorkspaceState,
    legacy_state: serde_json::Value,
) -> Result<WorkspaceSnapshot, String> {
    let stored: StoredWorkspace = serde_json::from_value(legacy_state)
        .map_err(|error| format!("Failed to parse legacy workspace state: {error}"))?;
    let imported_state = WorkspaceState::from_stored(stored)?;
    let snapshot = imported_state.snapshot();
    imported_state.save_to_disk(app)?;
    *state
        .lock()
        .map_err(|_| "Workspace state is unavailable.".to_string())? = imported_state;
    Ok(snapshot)
}

pub fn open_repository(
    app: &AppHandle,
    state: &SharedWorkspaceState,
    path: String,
) -> Result<WorkspaceSnapshot, String> {
    let snapshot = load_repository(&path).map_err(format_git_error)?;
    with_workspace(app, state, |workspace| {
        workspace.upsert_open_snapshot(snapshot, true);
        Ok(())
    })
}

pub fn open_recent_repository(
    app: &AppHandle,
    state: &SharedWorkspaceState,
    root: String,
) -> Result<WorkspaceSnapshot, String> {
    let cached_snapshot = {
        let workspace = state
            .lock()
            .map_err(|_| "Workspace state is unavailable.".to_string())?;
        workspace
            .recent_repos
            .iter()
            .find(|repo| repo.root == root)
            .and_then(|repo| repo.snapshot.clone())
    };
    let snapshot = match cached_snapshot {
        Some(snapshot) => snapshot,
        None => load_repository(&root).map_err(format_git_error)?,
    };

    with_workspace(app, state, |workspace| {
        workspace.upsert_open_snapshot(snapshot, true);
        Ok(())
    })
}

pub fn close_repository(
    app: &AppHandle,
    state: &SharedWorkspaceState,
    repo_id: String,
) -> Result<WorkspaceSnapshot, String> {
    with_workspace(app, state, |workspace| {
        workspace.close_repository(&repo_id);
        Ok(())
    })
}

pub fn remove_recent_repository(
    app: &AppHandle,
    state: &SharedWorkspaceState,
    root: String,
) -> Result<WorkspaceSnapshot, String> {
    with_workspace(app, state, |workspace| {
        workspace.remove_recent_repository(&root);
        Ok(())
    })
}

pub fn select_repository(
    app: &AppHandle,
    state: &SharedWorkspaceState,
    repo_id: String,
) -> Result<WorkspaceSnapshot, String> {
    with_workspace(app, state, |workspace| {
        workspace.select_repository(&repo_id);
        Ok(())
    })
}

pub fn refresh_open_repositories(
    app: &AppHandle,
    state: &SharedWorkspaceState,
) -> Result<WorkspaceSnapshot, String> {
    let repo_ids = {
        let workspace = state
            .lock()
            .map_err(|_| "Workspace state is unavailable.".to_string())?;
        workspace
            .open_repos
            .iter()
            .map(|repo| repo.id.clone())
            .collect::<Vec<_>>()
    };
    let refresh_results = repo_ids
        .into_iter()
        .map(|repo_id| {
            let result = load_repository(&repo_id).map_err(format_git_error);
            (repo_id, result)
        })
        .collect::<Vec<_>>();

    with_workspace(app, state, |workspace| {
        for (repo_id, result) in refresh_results {
            match result {
                Ok(snapshot) => {
                    if workspace.open_repos.iter().any(|repo| repo.id == repo_id) {
                        workspace.upsert_open_snapshot(snapshot, false);
                    }
                }
                Err(error) => workspace.update_open_repo_error(&repo_id, error),
            }
        }

        Ok(())
    })
}

pub fn refresh_repository(
    app: &AppHandle,
    state: &SharedWorkspaceState,
    repo_id: String,
) -> Result<WorkspaceSnapshot, String> {
    let is_open = {
        let workspace = state
            .lock()
            .map_err(|_| "Workspace state is unavailable.".to_string())?;
        workspace.open_repos.iter().any(|repo| repo.id == repo_id)
    };

    if !is_open {
        let workspace = state
            .lock()
            .map_err(|_| "Workspace state is unavailable.".to_string())?;
        return Ok(workspace.snapshot());
    }

    let result = load_repository(&repo_id).map_err(format_git_error);
    with_workspace(app, state, |workspace| {
        match result {
            Ok(snapshot) => {
                if workspace.open_repos.iter().any(|repo| repo.id == repo_id) {
                    workspace.upsert_open_snapshot(snapshot, false);
                }
            }
            Err(error) => workspace.update_open_repo_error(&repo_id, error),
        }

        Ok(())
    })
}

fn with_workspace(
    app: &AppHandle,
    state: &SharedWorkspaceState,
    update: impl FnOnce(&mut WorkspaceState) -> Result<(), String>,
) -> Result<WorkspaceSnapshot, String> {
    let mut workspace = state
        .lock()
        .map_err(|_| "Workspace state is unavailable.".to_string())?;
    update(&mut workspace)?;
    workspace.save_to_disk(app)?;
    Ok(workspace.snapshot())
}

fn workspace_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to locate app data directory: {error}"))?
        .join(WORKSPACE_FILE_NAME))
}

fn repo_title(path: &str) -> String {
    path.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .filter(|title| !title.is_empty())
        .unwrap_or("Repository")
        .to_string()
}

fn normalize_recent_repos(recent_repos: Vec<StoredRecentRepo>) -> Vec<RecentRepo> {
    let mut normalized = Vec::new();

    for repo in recent_repos {
        if repo.root.is_empty()
            || normalized
                .iter()
                .any(|existing: &RecentRepo| existing.root == repo.root)
        {
            continue;
        }

        let snapshot = load_repository(&repo.root).ok();

        normalized.push(RecentRepo {
            title: if repo.title.is_empty() {
                repo_title(&repo.root)
            } else {
                repo.title
            },
            root: repo.root,
            snapshot,
        });

        if normalized.len() == MAX_RECENT_REPOS {
            break;
        }
    }

    normalized
}

fn format_git_error(error: crate::git::command::GitError) -> String {
    let details = if error.stderr.is_empty() {
        String::new()
    } else {
        format!(" {}", error.stderr)
    };

    format!("{}{}", error.message, details)
}
