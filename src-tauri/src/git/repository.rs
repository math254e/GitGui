use super::command::{GitCommand, GitError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub path: String,
    pub root: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub info: RepositoryInfo,
    pub status: RepositoryStatus,
    pub commits: Vec<CommitInfo>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    pub current_branch: Option<String>,
    pub head_oid: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changed_files: Vec<ChangedFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub timestamp: i64,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileDiff {
    pub original_path: Option<String>,
    pub modified_path: String,
    pub original_content: String,
    pub modified_content: String,
    pub is_binary: bool,
    pub message: Option<String>,
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

pub fn load_commit_files(path: &str, commit_hash: &str) -> Result<Vec<CommitFile>, GitError> {
    let info = detect_repository(path)?;
    let root = Path::new(&info.root);
    let output = GitCommand::run(
        &["show", "--name-status", "--format=", commit_hash],
        Some(root),
    )?;

    Ok(output.lines().filter_map(parse_commit_file).collect())
}

pub fn load_commit_file_diff(
    path: &str,
    commit_hash: &str,
    file: &CommitFile,
) -> Result<CommitFileDiff, GitError> {
    let info = detect_repository(path)?;
    let root = Path::new(&info.root);
    let parent_hash = first_parent(root, commit_hash)?;
    let status = file.status.chars().next().unwrap_or('M');
    let original_path = file.original_path.as_deref().unwrap_or(&file.path);

    let original_content = if status == 'A' || parent_hash.is_none() {
        FileContent::Text(String::new())
    } else {
        load_file_at_revision(root, parent_hash.as_deref().unwrap_or(commit_hash), original_path)
    };

    let modified_content = if status == 'D' {
        FileContent::Text(String::new())
    } else {
        load_file_at_revision(root, commit_hash, &file.path)
    };

    let is_binary = original_content.is_binary() || modified_content.is_binary();
    let message = if is_binary {
        Some("Binary file content cannot be displayed.".to_string())
    } else {
        original_content
            .message()
            .or_else(|| modified_content.message())
            .map(ToString::to_string)
    };

    Ok(CommitFileDiff {
        original_path: if status == 'A' {
            None
        } else {
            Some(original_path.to_string())
        },
        modified_path: file.path.clone(),
        original_content: original_content.into_text(),
        modified_content: modified_content.into_text(),
        is_binary,
        message,
    })
}

pub fn load_working_tree_file_diff(path: &str, file: &CommitFile) -> Result<CommitFileDiff, GitError> {
    let info = detect_repository(path)?;
    let root = Path::new(&info.root);
    let head_hash = current_head(root);
    let status = primary_status(&file.status);
    let original_path = file.original_path.as_deref().unwrap_or(&file.path);

    let original_content = if status == '?' || status == 'A' || head_hash.is_none() {
        FileContent::Text(String::new())
    } else {
        load_file_at_revision(root, head_hash.as_deref().unwrap_or("HEAD"), original_path)
    };

    let modified_content = if status == 'D' {
        FileContent::Text(String::new())
    } else {
        load_file_from_working_tree(root, &file.path)
    };

    let is_binary = original_content.is_binary() || modified_content.is_binary();
    let message = if is_binary {
        Some("Binary file content cannot be displayed.".to_string())
    } else {
        original_content
            .message()
            .or_else(|| modified_content.message())
            .map(ToString::to_string)
    };

    Ok(CommitFileDiff {
        original_path: if status == '?' || status == 'A' {
            None
        } else {
            Some(original_path.to_string())
        },
        modified_path: file.path.clone(),
        original_content: original_content.into_text(),
        modified_content: modified_content.into_text(),
        is_binary,
        message,
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
    let output = GitCommand::run(
        &["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
        Some(root),
    )?;
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
            let fields: Vec<&str> = line.splitn(if record_type == '2' { 10 } else { 9 }, ' ').collect();
            let status = fields.get(1)?;
            let path_index = if record_type == '2' { 9 } else { 8 };
            let path = fields.get(path_index)?.to_string();
            let original_path = if record_type == '2' {
                path.split('\t').nth(1).map(unquote_git_path)
            } else {
                None
            };
            let path = path.split('\t').next().unwrap_or(&path);

            Some(ChangedFile {
                path: unquote_git_path(path),
                original_path,
                index_status: status.chars().next().unwrap_or('.').to_string(),
                worktree_status: status.chars().nth(1).unwrap_or('.').to_string(),
            })
        }
        'u' => {
            let fields: Vec<&str> = line.splitn(11, ' ').collect();
            let status = fields.get(1)?;
            let path = fields.get(10)?;

            Some(ChangedFile {
                path: unquote_git_path(path),
                original_path: None,
                index_status: status.chars().next().unwrap_or('U').to_string(),
                worktree_status: status.chars().nth(1).unwrap_or('U').to_string(),
            })
        }
        '?' | '!' => Some(ChangedFile {
            path: unquote_git_path(line.get(2..)?),
            original_path: None,
            index_status: record_type.to_string(),
            worktree_status: record_type.to_string(),
        }),
        _ => None,
    }
}

fn unquote_git_path(path: &str) -> String {
    let trimmed = path.trim();

    if !(trimmed.starts_with('"') && trimmed.ends_with('"')) {
        return trimmed.to_string();
    }

    let mut decoded = Vec::new();
    let mut chars = trimmed[1..trimmed.len() - 1].chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            let mut buffer = [0; 4];
            decoded.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
            continue;
        }

        let Some(next) = chars.next() else {
            decoded.push(b'\\');
            continue;
        };

        if ('0'..='7').contains(&next) {
            let mut octal = String::from(next);

            for _ in 0..2 {
                if let Some(peeked) = chars.peek() {
                    if ('0'..='7').contains(peeked) {
                        octal.push(chars.next().unwrap());
                    }
                }
            }

            if let Ok(byte) = u8::from_str_radix(&octal, 8) {
                decoded.push(byte);
            }
            continue;
        }

        match next {
            'n' => decoded.push(b'\n'),
            't' => decoded.push(b'\t'),
            'r' => decoded.push(b'\r'),
            '"' => decoded.push(b'"'),
            '\\' => decoded.push(b'\\'),
            other => {
                let mut buffer = [0; 4];
                decoded.extend_from_slice(other.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }

    String::from_utf8_lossy(&decoded).into_owned()
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

fn parse_commit_file(line: &str) -> Option<CommitFile> {
    let mut parts = line.split('\t');
    let status = parts.next()?.to_string();
    let first_path = parts.next()?;
    let second_path = parts.next();

    Some(CommitFile {
        path: second_path.unwrap_or(first_path).to_string(),
        original_path: second_path.map(ToString::to_string),
        status,
    })
}

enum FileContent {
    Text(String),
    Binary,
    Missing(String),
}

impl FileContent {
    fn is_binary(&self) -> bool {
        matches!(self, Self::Binary)
    }

    fn message(&self) -> Option<&str> {
        match self {
            Self::Missing(message) => Some(message),
            _ => None,
        }
    }

    fn into_text(self) -> String {
        match self {
            Self::Text(content) => content,
            Self::Binary | Self::Missing(_) => String::new(),
        }
    }
}

fn first_parent(root: &Path, commit_hash: &str) -> Result<Option<String>, GitError> {
    let output = GitCommand::run(&["show", "-s", "--format=%P", commit_hash], Some(root))?;
    Ok(output.split_whitespace().next().map(ToString::to_string))
}

fn current_head(root: &Path) -> Option<String> {
    GitCommand::run(&["rev-parse", "--verify", "HEAD"], Some(root))
        .ok()
        .map(|output| output.trim().to_string())
        .filter(|hash| !hash.is_empty())
}

fn primary_status(status: &str) -> char {
    let mut chars = status.chars();
    let index_status = chars.next().unwrap_or('M');
    let worktree_status = chars.next().unwrap_or('.');

    if worktree_status != '.' {
        worktree_status
    } else {
        index_status
    }
}

fn load_file_at_revision(root: &Path, revision: &str, file_path: &str) -> FileContent {
    let spec = format!("{revision}:{file_path}");
    let output = match Command::new("git")
        .args(["show", &spec])
        .current_dir(root)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return FileContent::Missing(format!("Failed to execute git: {error}"));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return FileContent::Missing(if stderr.is_empty() {
            format!("git show {spec} failed")
        } else {
            stderr
        });
    }

    if output.stdout.contains(&0) {
        return FileContent::Binary;
    }

    match String::from_utf8(output.stdout) {
        Ok(content) => FileContent::Text(content),
        Err(_) => FileContent::Binary,
    }
}

fn load_file_from_working_tree(root: &Path, file_path: &str) -> FileContent {
    let full_path = root.join(file_path);
    let bytes = match fs::read(&full_path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return FileContent::Missing(format!(
                "Failed to read {}: {error}",
                full_path.display()
            ));
        }
    };

    if bytes.contains(&0) {
        return FileContent::Binary;
    }

    match String::from_utf8(bytes) {
        Ok(content) => FileContent::Text(content),
        Err(_) => FileContent::Binary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ordinary_modified_file() {
        let file = parse_changed_file("1 .M N... 100644 100644 100644 1234567 1234567 src/main.rs").unwrap();

        assert_eq!(file.path, "src/main.rs");
        assert_eq!(file.original_path, None);
        assert_eq!(file.index_status, ".");
        assert_eq!(file.worktree_status, "M");
    }

    #[test]
    fn parses_staged_added_file_with_spaces() {
        let file = parse_changed_file("1 A. N... 000000 100644 100644 0000000 89abcde docs/new file.md").unwrap();

        assert_eq!(file.path, "docs/new file.md");
        assert_eq!(file.index_status, "A");
        assert_eq!(file.worktree_status, ".");
    }

    #[test]
    fn parses_renamed_file_with_original_path() {
        let file = parse_changed_file(
            "2 R. N... 100644 100644 100644 1234567 89abcde R100 src/new name.rs\tsrc/old name.rs",
        )
        .unwrap();

        assert_eq!(file.path, "src/new name.rs");
        assert_eq!(file.original_path, Some("src/old name.rs".to_string()));
        assert_eq!(file.index_status, "R");
        assert_eq!(file.worktree_status, ".");
    }

    #[test]
    fn parses_unmerged_conflict_file() {
        let file = parse_changed_file(
            "u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 src/conflict.txt",
        )
        .unwrap();

        assert_eq!(file.path, "src/conflict.txt");
        assert_eq!(file.original_path, None);
        assert_eq!(file.index_status, "U");
        assert_eq!(file.worktree_status, "U");
    }

    #[test]
    fn parses_untracked_and_ignored_files() {
        let untracked = parse_changed_file("? untracked file.txt").unwrap();
        let ignored = parse_changed_file("! ignored file.log").unwrap();

        assert_eq!(untracked.path, "untracked file.txt");
        assert_eq!(untracked.index_status, "?");
        assert_eq!(untracked.worktree_status, "?");
        assert_eq!(ignored.path, "ignored file.log");
        assert_eq!(ignored.index_status, "!");
        assert_eq!(ignored.worktree_status, "!");
    }

    #[test]
    fn unquotes_git_octal_paths() {
        let file = parse_changed_file(r#"1 .M N... 100644 100644 100644 1234567 1234567 "src/quote\040and\011tab.rs""#)
            .unwrap();

        assert_eq!(file.path, "src/quote and\ttab.rs");
    }
}
