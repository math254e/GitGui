use super::command::{GitCommand, GitError};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub path: String,
    pub root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub info: RepositoryInfo,
    pub status: RepositoryStatus,
    pub commits: Vec<CommitInfo>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    pub current_branch: Option<String>,
    pub head_oid: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changed_files: Vec<ChangedFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub timestamp: i64,
    pub message: String,
}

pub fn load_repository(path: &str) -> Result<RepositorySnapshot, GitError> {
    let info = detect_repository(path)?;
    let root = Path::new(&info.root);

    Ok(RepositorySnapshot {
        status: repository_status(root)?,
        commits: load_commits(root)?,
        info,
    })
}

fn detect_repository(path: &str) -> Result<RepositoryInfo, GitError> {
    let selected_path = Path::new(path);
    let root = GitCommand::run(&["rev-parse", "--show-toplevel"], Some(selected_path))?;

    Ok(RepositoryInfo {
        path: selected_path.display().to_string(),
        root: root.trim().to_string(),
    })
}

fn repository_status(root: &Path) -> Result<RepositoryStatus, GitError> {
    let output = GitCommand::run(&["status", "--porcelain=v2", "--branch"], Some(root))?;
    let mut status = RepositoryStatus::default();

    for line in output.lines() {
        if let Some(branch) = line.strip_prefix("# branch.head ") {
            if branch != "(detached)" {
                status.current_branch = Some(branch.to_string());
            }
            continue;
        }

        if let Some(oid) = line.strip_prefix("# branch.oid ") {
            status.head_oid = Some(oid.to_string());
            continue;
        }

        if let Some(upstream) = line.strip_prefix("# branch.ab ") {
            for part in upstream.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    status.ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    status.behind = value.parse().unwrap_or(0);
                }
            }
            continue;
        }

        if let Some(file) = parse_changed_file(line) {
            status.changed_files.push(file);
        }
    }

    Ok(status)
}

fn parse_changed_file(line: &str) -> Option<ChangedFile> {
    let record_type = line.chars().next()?;

    match record_type {
        '1' | '2' => {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let status = fields.get(1)?;
            let path_index = if record_type == '2' { 9 } else { 8 };
            let path = fields.get(path_index..)?.join(" ");
            let original_path = if record_type == '2' {
                path.split('\t').nth(1).map(ToString::to_string)
            } else {
                None
            };

            Some(ChangedFile {
                path: path.split('\t').next().unwrap_or(&path).to_string(),
                original_path,
                index_status: status.chars().next().unwrap_or('.').to_string(),
                worktree_status: status.chars().nth(1).unwrap_or('.').to_string(),
            })
        }
        '?' | '!' => Some(ChangedFile {
            path: line.get(2..)?.to_string(),
            original_path: None,
            index_status: record_type.to_string(),
            worktree_status: record_type.to_string(),
        }),
        _ => None,
    }
}

fn load_commits(root: &Path) -> Result<Vec<CommitInfo>, GitError> {
    let output = GitCommand::run(
        &[
            "log",
            "--all",
            "--date=unix",
            "--pretty=format:%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e",
            "--max-count=200",
        ],
        Some(root),
    )?;

    Ok(output
        .split('\x1e')
        .filter_map(|record| {
            let record = record.trim();
            if record.is_empty() {
                return None;
            }

            let mut parts = record.split('\x1f');
            Some(CommitInfo {
                hash: parts.next()?.to_string(),
                parents: parts
                    .next()
                    .unwrap_or_default()
                    .split_whitespace()
                    .map(ToString::to_string)
                    .collect(),
                author: parts.next().unwrap_or_default().to_string(),
                timestamp: parts.next().unwrap_or("0").parse().unwrap_or(0),
                message: parts.next().unwrap_or_default().to_string(),
            })
        })
        .collect())
}
