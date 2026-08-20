use super::command::{git_command, GitCommand, GitError};
use super::graph::{build_commit_graph, sort_commits};
pub use super::graph::{CommitGraph, GraphCommit, GraphEdge, GraphEdgeType};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

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
    pub graph: CommitGraph,
    pub refs: Vec<CommitRef>,
    pub stashes: Vec<StashInfo>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryGraph {
    pub commits: Vec<CommitInfo>,
    pub graph: CommitGraph,
}

/// Lightweight repository result for server status requests.
///
/// This deliberately contains no commit history, graph, or ref data. It is
/// the reusable core operation used by the standalone server's first Git RPC
/// slice.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatusSnapshot {
    pub info: RepositoryInfo,
    pub status: RepositoryStatus,
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
pub struct StashInfo {
    pub hash: String,
    pub selector: String,
    pub base_hash: String,
    pub index_hash: Option<String>,
    pub branch: Option<String>,
    pub message: String,
    pub timestamp: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    pub name: String,
    pub short_name: String,
    pub target: String,
    pub ref_type: CommitRefType,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommitRefType {
    LocalBranch,
    RemoteBranch,
    Tag,
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
    let status = repository_status(root)?;
    // A stash is user-facing history, but its index and optional untracked-file
    // parents are Git implementation details. Keep the stash commit and omit
    // those helper commits before ordering and laying out the canonical graph.
    let (stashes, stash_helper_hashes) = load_stashes(root).unwrap_or_default();
    let commits = sort_commits(
        load_commits(root)?
            .into_iter()
            .filter(|commit| !stash_helper_hashes.contains(&commit.hash))
            .collect(),
    );
    let graph = build_commit_graph(&commits, status.head_oid.as_deref());
    let refs = load_refs(root)?;

    Ok(RepositorySnapshot {
        status,
        graph,
        refs,
        stashes,
        commits,
        info,
    })
}

/// Loads only the commits reachable from the requested targets and lays out a
/// graph for that reduced history. Target hashes are treated as untrusted
/// lookups; unknown targets simply contribute no commits.
pub fn load_repository_graph(
    path: &str,
    target_hashes: &[String],
) -> Result<RepositoryGraph, GitError> {
    let snapshot = load_repository(path)?;
    let commits = reachable_commits(&snapshot.commits, target_hashes);
    let graph = build_commit_graph(&commits, snapshot.status.head_oid.as_deref());

    Ok(RepositoryGraph { commits, graph })
}

fn reachable_commits(commits: &[CommitInfo], target_hashes: &[String]) -> Vec<CommitInfo> {
    let commit_by_hash: HashMap<&str, &CommitInfo> = commits
        .iter()
        .map(|commit| (commit.hash.as_str(), commit))
        .collect();
    let mut pending = target_hashes.to_vec();
    let mut reachable = HashSet::new();

    while let Some(hash) = pending.pop() {
        if !reachable.insert(hash.clone()) {
            continue;
        }

        if let Some(commit) = commit_by_hash.get(hash.as_str()) {
            pending.extend(commit.parents.iter().cloned());
        }
    }

    commits
        .iter()
        .filter(|commit| reachable.contains(&commit.hash))
        .cloned()
        .collect()
}

/// Resolves a path to its Git repository without loading history or status.
pub fn resolve_repository(path: &str) -> Result<RepositoryInfo, GitError> {
    detect_repository(path)
}

/// Resolves a repository and loads only its current working-tree status.
pub fn load_repository_status(path: &str) -> Result<RepositoryStatusSnapshot, GitError> {
    let info = detect_repository(path)?;
    let status = repository_status(Path::new(&info.root))?;

    Ok(RepositoryStatusSnapshot { info, status })
}

pub fn load_commit_files_from_root(
    repo_root: &str,
    commit_hash: &str,
) -> Result<Vec<CommitFile>, GitError> {
    let root = Path::new(repo_root);
    let output = GitCommand::run(
        &["show", "--name-status", "--format=", commit_hash],
        Some(root),
    )?;

    Ok(output.lines().filter_map(parse_commit_file).collect())
}

pub fn load_commit_file_diff(
    repo_root: &str,
    commit_hash: &str,
    parent_hash: Option<&str>,
    file: &CommitFile,
) -> Result<CommitFileDiff, GitError> {
    let root = Path::new(repo_root);
    let status = file.status.chars().next().unwrap_or('M');
    let original_path = file.original_path.as_deref().unwrap_or(&file.path);

    let original_content = if status == 'A' || parent_hash.is_none() {
        FileContent::Text(String::new())
    } else {
        load_file_at_revision(root, parent_hash.unwrap_or(commit_hash), original_path)
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

pub fn load_working_tree_file_diff(
    repo_root: &str,
    head_hash: Option<&str>,
    file: &CommitFile,
) -> Result<CommitFileDiff, GitError> {
    let root = Path::new(repo_root);
    let status = primary_status(&file.status);
    let original_path = file.original_path.as_deref().unwrap_or(&file.path);

    let original_content = if status == '?' || status == 'A' || head_hash.is_none() {
        FileContent::Text(String::new())
    } else {
        load_file_at_revision(root, head_hash.unwrap_or("HEAD"), original_path)
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
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
        ],
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
            let fields: Vec<&str> = line
                .splitn(if record_type == '2' { 10 } else { 9 }, ' ')
                .collect();
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
            "--exclude=refs/t3/checkpoints/**",
            "--exclude=refs/codex/turn-diffs/checkpoints/**",
            "--all",
            "--date=unix",
            "--pretty=format:%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e",
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

fn load_stashes(root: &Path) -> Result<(Vec<StashInfo>, HashSet<String>), GitError> {
    let output = GitCommand::run(
        &["stash", "list", "--format=%gd%x1f%H%x1f%ct%x1f%gs%x1e"],
        Some(root),
    )?;
    let mut stashes = Vec::new();
    let mut helper_hashes = HashSet::new();

    for record in output.split('\x1e') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }

        let mut parts = record.split('\x1f');
        let Some(selector) = parts
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(hash) = parts
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let timestamp = parts.next().unwrap_or_default().trim().parse().unwrap_or(0);
        let subject = parts.next().unwrap_or_default().trim();
        let Ok((base_hash, index_hash, stash_helper_hashes)) = stash_parent_hashes(root, hash)
        else {
            continue;
        };
        let (branch, message) = parse_stash_subject(subject);

        helper_hashes.extend(stash_helper_hashes);
        stashes.push(StashInfo {
            hash: hash.to_string(),
            selector: selector.to_string(),
            base_hash,
            index_hash,
            branch,
            message,
            timestamp,
        });
    }

    Ok((stashes, helper_hashes))
}

fn stash_parent_hashes(
    root: &Path,
    stash_hash: &str,
) -> Result<(String, Option<String>, Vec<String>), GitError> {
    let output = GitCommand::run_owned(
        &[
            "rev-list".to_string(),
            "--parents".to_string(),
            "-n".to_string(),
            "1".to_string(),
            stash_hash.to_string(),
        ],
        Some(root),
    )?;

    parse_stash_parent_hashes(stash_hash, &output)
}

fn parse_stash_parent_hashes(
    stash_hash: &str,
    output: &str,
) -> Result<(String, Option<String>, Vec<String>), GitError> {
    let mut parents = output.split_whitespace().skip(1);
    let base_hash = parents
        .next()
        .map(ToOwned::to_owned)
        .ok_or_else(|| GitError {
            message: format!("stash {stash_hash} has no base commit"),
            stderr: String::new(),
            status: None,
        })?;
    let helper_hashes: Vec<String> = parents.map(ToOwned::to_owned).collect();
    let index_hash = helper_hashes.first().cloned();

    Ok((base_hash, index_hash, helper_hashes))
}

fn parse_stash_subject(subject: &str) -> (Option<String>, String) {
    let Some((prefix, message)) = subject.split_once(": ") else {
        return (None, subject.to_string());
    };

    let branch = prefix
        .strip_prefix("WIP on ")
        .or_else(|| prefix.strip_prefix("On "))
        .map(ToOwned::to_owned);

    if branch.is_some() {
        (branch, message.to_string())
    } else {
        (None, subject.to_string())
    }
}

fn load_refs(root: &Path) -> Result<Vec<CommitRef>, GitError> {
    let output = GitCommand::run(
        &[
            "for-each-ref",
            "--format=%(refname)%09%(refname:short)%09%(objectname)%09%(*objectname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        Some(root),
    )?;

    Ok(output.lines().filter_map(parse_commit_ref).collect())
}

fn parse_commit_ref(line: &str) -> Option<CommitRef> {
    let mut parts = line.split('\t');
    let name = parts.next()?.trim();
    let short_name = parts.next()?.trim();
    let object_name = parts.next()?.trim();
    let peeled_object_name = parts.next().unwrap_or_default().trim();
    let target = if peeled_object_name.is_empty() {
        object_name
    } else {
        peeled_object_name
    };

    if name.is_empty() || short_name.is_empty() || target.is_empty() {
        return None;
    }

    if name.ends_with("/HEAD") {
        return None;
    }

    let ref_type = if name.starts_with("refs/heads/") {
        CommitRefType::LocalBranch
    } else if name.starts_with("refs/remotes/") {
        CommitRefType::RemoteBranch
    } else if name.starts_with("refs/tags/") {
        CommitRefType::Tag
    } else {
        return None;
    };

    Some(CommitRef {
        name: name.to_string(),
        short_name: short_name.to_string(),
        target: target.to_string(),
        ref_type,
    })
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
    let output = match git_command()
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
        let file = parse_changed_file("1 .M N... 100644 100644 100644 1234567 1234567 src/main.rs")
            .unwrap();

        assert_eq!(file.path, "src/main.rs");
        assert_eq!(file.original_path, None);
        assert_eq!(file.index_status, ".");
        assert_eq!(file.worktree_status, "M");
    }

    #[test]
    fn parses_staged_added_file_with_spaces() {
        let file =
            parse_changed_file("1 A. N... 000000 100644 100644 0000000 89abcde docs/new file.md")
                .unwrap();

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
        let file = parse_changed_file(
            r#"1 .M N... 100644 100644 100644 1234567 1234567 "src/quote\040and\011tab.rs""#,
        )
        .unwrap();

        assert_eq!(file.path, "src/quote and\ttab.rs");
    }

    #[test]
    fn parses_local_branch_ref() {
        let parsed = parse_commit_ref("refs/heads/main\tmain\tabc123\t").unwrap();

        assert_eq!(parsed.name, "refs/heads/main");
        assert_eq!(parsed.short_name, "main");
        assert_eq!(parsed.target, "abc123");
        assert_eq!(parsed.ref_type, CommitRefType::LocalBranch);
    }

    #[test]
    fn parses_remote_branch_ref() {
        let parsed = parse_commit_ref("refs/remotes/origin/main\torigin/main\tabc123\t").unwrap();

        assert_eq!(parsed.short_name, "origin/main");
        assert_eq!(parsed.ref_type, CommitRefType::RemoteBranch);
    }

    #[test]
    fn parses_tag_ref() {
        let parsed = parse_commit_ref("refs/tags/v1.0.0\tv1.0.0\tabc123\t").unwrap();

        assert_eq!(parsed.short_name, "v1.0.0");
        assert_eq!(parsed.target, "abc123");
        assert_eq!(parsed.ref_type, CommitRefType::Tag);
    }

    #[test]
    fn parses_peeled_tag_target_when_available() {
        let parsed =
            parse_commit_ref("refs/tags/v1.0.0\tv1.0.0\ttag-object\tcommit-object").unwrap();

        assert_eq!(parsed.target, "commit-object");
        assert_eq!(parsed.ref_type, CommitRefType::Tag);
    }

    #[test]
    fn ignores_malformed_and_remote_head_refs() {
        assert_eq!(parse_commit_ref("refs/heads/main\tmain").is_none(), true);
        assert_eq!(
            parse_commit_ref("refs/remotes/origin/HEAD\torigin\tabc123\t").is_none(),
            true
        );
        assert_eq!(
            parse_commit_ref("refs/notes/test\ttest\tabc123\t").is_none(),
            true
        );
    }

    #[test]
    fn parses_stash_subject_with_generated_branch_prefix() {
        assert_eq!(
            parse_stash_subject("WIP on dev: preserve local changes"),
            (
                Some("dev".to_string()),
                "preserve local changes".to_string()
            )
        );
        assert_eq!(
            parse_stash_subject("On main: quick fix"),
            (Some("main".to_string()), "quick fix".to_string())
        );
    }

    #[test]
    fn keeps_custom_stash_subject_without_branch_metadata() {
        assert_eq!(
            parse_stash_subject("release preparation"),
            (None, "release preparation".to_string())
        );
    }

    #[test]
    fn identifies_all_internal_stash_parent_commits() {
        let (base_hash, index_hash, helper_hashes) =
            parse_stash_parent_hashes("stash", "stash base index untracked").unwrap();

        assert_eq!(base_hash, "base");
        assert_eq!(index_hash.as_deref(), Some("index"));
        assert_eq!(helper_hashes, vec!["index", "untracked"]);
    }

    #[test]
    fn reachable_commits_keep_only_selected_history() {
        let commit = |hash: &str, parents: &[&str]| CommitInfo {
            hash: hash.to_string(),
            parents: parents.iter().map(|parent| (*parent).to_string()).collect(),
            author: "Test Author".to_string(),
            timestamp: 0,
            message: hash.to_string(),
        };
        let commits = vec![
            commit("feature-tip", &["feature-base"]),
            commit("other-tip", &["root"]),
            commit("feature-base", &["root"]),
            commit("root", &[]),
        ];

        let selected = reachable_commits(&commits, &["feature-tip".to_string()]);

        assert_eq!(
            selected
                .into_iter()
                .map(|commit| commit.hash)
                .collect::<Vec<_>>(),
            vec!["feature-tip", "feature-base", "root"]
        );
    }
}
