use super::command::{git_command, GitCommand, GitError};
use super::graph::{build_commit_graph, sort_commits};
pub use super::graph::{CommitGraph, GraphCommit, GraphEdge, GraphEdgeType};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;

pub const DIFF_MAX_BYTES: usize = 64 * 1024;
pub const DIFF_MAX_LINES: usize = 500;
pub const DIFF_MAX_LINE_BYTES: usize = 8 * 1024;
const PREVIEW_MAX_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmittedDiffContent {
    pub reason: String,
    pub max_bytes_per_side: usize,
    pub max_lines_per_side: usize,
    pub max_line_bytes: usize,
    pub original_preview: String,
    pub modified_preview: String,
}

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
    pub worktrees: Vec<WorktreeInfo>,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub head_oid: Option<String>,
    pub branch: Option<String>,
    pub current: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted_content: Option<OmittedDiffContent>,
}

pub fn load_repository(path: &str) -> Result<RepositorySnapshot, GitError> {
    let info = detect_repository(path)?;
    let root = Path::new(&info.root);
    let status = repository_status(root)?;
    // A stash is user-facing history, but its index and optional untracked-file
    // parents are Git implementation details. Keep the stash commit and omit
    // those helper commits before ordering and laying out the canonical graph.
    let (stashes, stash_helper_hashes) = load_stashes(root).unwrap_or_default();
    let worktrees = load_worktrees(root)?;
    let commits = sort_commits(
        load_commits(root, status.head_oid.as_deref(), &stashes, &worktrees)?
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
        worktrees,
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
    // Merge commits have more than one possible comparison base. Keep the
    // file list aligned with the commit diff viewer by comparing to the first
    // parent, which presents the merge as one ordinary two-way change.
    let output = GitCommand::run(
        &[
            "show",
            "--name-status",
            "--format=",
            "--find-renames",
            "--diff-merges=first-parent",
            commit_hash,
        ],
        Some(root),
    )?;

    Ok(output.lines().filter_map(parse_commit_file).collect())
}

/// Lists paths that differ between a commit and the current working directory.
pub fn load_commit_working_tree_files(
    repo_root: &str,
    commit_hash: &str,
) -> Result<Vec<CommitFile>, GitError> {
    let root = Path::new(repo_root);
    let output = GitCommand::run(
        &["diff", "--name-status", "--find-renames", commit_hash, "--"],
        Some(root),
    )?;
    let mut files: Vec<CommitFile> = output.lines().filter_map(parse_commit_file).collect();
    // `git diff <commit>` omits untracked paths, though they are part of the
    // visible working directory. Include them as additions for this view.
    for changed in repository_status(root)?.changed_files {
        if changed.index_status == "?" && !files.iter().any(|file| file.path == changed.path) {
            files.push(CommitFile {
                path: changed.path,
                original_path: None,
                status: "A".into(),
            });
        }
    }
    Ok(files)
}

/// Loads one file's contents from a commit and the current working directory.
pub fn load_commit_working_tree_file_diff(
    repo_root: &str,
    commit_hash: &str,
    file: &CommitFile,
) -> Result<CommitFileDiff, GitError> {
    let root = Path::new(repo_root);
    let original_path = file.original_path.as_deref().unwrap_or(&file.path);
    let original_content = if file.status.starts_with('A') {
        FileContent::Text(String::new())
    } else {
        load_file_at_revision(root, commit_hash, original_path)?
    };
    let modified_content = if file.status.starts_with('D') {
        FileContent::Text(String::new())
    } else {
        load_file_from_working_tree(root, &file.path)?
    };
    let is_binary = original_content.is_binary() || modified_content.is_binary();
    let omitted_content = omitted_content(&original_content, &modified_content, is_binary);
    let message = if is_binary {
        Some("Binary file content cannot be displayed.".to_string())
    } else {
        original_content.message().or_else(|| modified_content.message()).map(ToString::to_string)
    };

    Ok(CommitFileDiff {
        original_path: if file.status.starts_with('A') {
            None
        } else {
            Some(original_path.to_string())
        },
        modified_path: file.path.clone(),
        original_content: if omitted_content.is_some() {
            String::new()
        } else {
            original_content.into_text()
        },
        modified_content: if omitted_content.is_some() {
            String::new()
        } else {
            modified_content.into_text()
        },
        is_binary,
        message,
        omitted_content,
    })
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
        load_file_at_revision(root, parent_hash.unwrap_or(commit_hash), original_path)?
    };

    let modified_content = if status == 'D' {
        FileContent::Text(String::new())
    } else {
        load_file_at_revision(root, commit_hash, &file.path)?
    };

    let is_binary = original_content.is_binary() || modified_content.is_binary();
    let omitted_content = omitted_content(&original_content, &modified_content, is_binary);
    let message = if is_binary {
        Some("Binary file content cannot be displayed.".to_string())
    } else {
        original_content.message().or_else(|| modified_content.message()).map(ToString::to_string)
    };

    Ok(CommitFileDiff {
        original_path: if status == 'A' {
            None
        } else {
            Some(original_path.to_string())
        },
        modified_path: file.path.clone(),
        original_content: if omitted_content.is_some() {
            String::new()
        } else {
            original_content.into_text()
        },
        modified_content: if omitted_content.is_some() {
            String::new()
        } else {
            modified_content.into_text()
        },
        is_binary,
        message,
        omitted_content,
    })
}

pub fn load_working_tree_file_diff(
    repo_root: &str,
    head_hash: Option<&str>,
    file: &CommitFile,
    staged: bool,
) -> Result<CommitFileDiff, GitError> {
    load_working_tree_file_diff_with_content(repo_root, head_hash, file, staged, None)
}

pub(crate) fn load_working_tree_file_diff_with_content(
    repo_root: &str,
    head_hash: Option<&str>,
    file: &CommitFile,
    staged: bool,
    worktree_content: Option<Vec<u8>>,
) -> Result<CommitFileDiff, GitError> {
    let root = Path::new(repo_root);
    super::working_tree::safe_path(root, &file.path)?;
    if let Some(path) = &file.original_path {
        super::working_tree::safe_path(root, path)?;
    }
    let index_status = file.status.chars().next().unwrap_or('.');
    let worktree_status = file.status.chars().nth(1).unwrap_or('.');
    let status = if staged {
        index_status
    } else {
        worktree_status
    };
    let original_path = file.original_path.as_deref().unwrap_or(&file.path);

    let original_content = if staged {
        if index_status == '?' || index_status == 'A' || head_hash.is_none() {
            FileContent::Text(String::new())
        } else {
            load_file_at_revision(root, head_hash.unwrap_or("HEAD"), original_path)?
        }
    } else if worktree_status == '?' {
        FileContent::Text(String::new())
    } else {
        // The index is always the base for unstaged changes, including before
        // the repository's first commit.
        match load_file_from_index(root, &file.path) {
            Err(_) if matches!(file.status.as_str(), "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") => FileContent::Missing("Resolve conflicts before selecting hunks.".into()),
            result => result?,
        }
    };

    let modified_content = if status == 'D' {
        FileContent::Text(String::new())
    } else if staged {
        load_file_from_index(root, &file.path)?
    } else if let Some(bytes) = worktree_content {
        let limited = bytes.len() > DIFF_MAX_BYTES;
        classify_content(bytes, limited)
    } else {
        load_file_from_working_tree(root, &file.path)?
    };

    let is_binary = original_content.is_binary() || modified_content.is_binary();
    let omitted_content = omitted_content(&original_content, &modified_content, is_binary);
    let message = if is_binary {
        Some("Binary file content cannot be displayed.".to_string())
    } else {
        original_content.message().or_else(|| modified_content.message()).map(ToString::to_string)
    };

    Ok(CommitFileDiff {
        original_path: if status == '?' || status == 'A' {
            None
        } else if !staged && status_is_present(index_status) && index_status != '?' {
            Some(file.path.clone())
        } else {
            Some(original_path.to_string())
        },
        modified_path: file.path.clone(),
        original_content: if omitted_content.is_some() {
            String::new()
        } else {
            original_content.into_text()
        },
        modified_content: if omitted_content.is_some() {
            String::new()
        } else {
            modified_content.into_text()
        },
        is_binary,
        message,
        omitted_content,
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
            if oid != "(initial)" {
                status.head_oid = Some(oid.to_string());
            }
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
    // Porcelain paths can legitimately begin or end with spaces.
    let trimmed = path;

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

fn load_commits(
    root: &Path,
    head_hash: Option<&str>,
    stashes: &[StashInfo],
    worktrees: &[WorktreeInfo],
) -> Result<Vec<CommitInfo>, GitError> {
    // Only user-facing history roots belong in the graph. Private tool refs
    // (including checkpoint refs in future namespaces) must not seed traversal.
    // Detached worktree heads and older stashes have no branch or tag ref.
    let additional_roots = head_hash
        .into_iter()
        .chain(
            worktrees
                .iter()
                .filter_map(|worktree| worktree.head_oid.as_deref()),
        )
        .chain(stashes.iter().map(|stash| stash.hash.as_str()))
        // Git reports an all-zero HEAD for an unborn worktree.
        .filter(|hash| !hash.is_empty() && !hash.bytes().all(|byte| byte == b'0'))
        .map(|hash| format!("{hash}\n"))
        .collect::<String>();
    let output = GitCommand::run_with_stdin(
        &[
            "log",
            "--branches",
            "--remotes",
            "--tags",
            "--stdin",
            "--date=unix",
            "--pretty=format:%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e",
        ],
        Some(root),
        additional_roots.as_bytes(),
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

fn load_worktrees(root: &Path) -> Result<Vec<WorktreeInfo>, GitError> {
    let output = GitCommand::run(&["worktree", "list", "--porcelain"], Some(root))?;
    Ok(parse_worktrees(&output, root))
}

fn parse_worktrees(output: &str, current_root: &Path) -> Vec<WorktreeInfo> {
    let mut worktrees = Vec::new();
    let mut current: Option<WorktreeInfo> = None;

    for line in output.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(worktree) = current.take() {
                worktrees.push(worktree);
            }
            continue;
        }

        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(worktree) = current.take() {
                worktrees.push(worktree);
            }

            let path = path.trim().to_string();
            current = (!path.is_empty()).then(|| WorktreeInfo {
                current: same_path(Path::new(&path), current_root),
                path,
                head_oid: None,
                branch: None,
            });
            continue;
        }

        let Some(worktree) = current.as_mut() else {
            continue;
        };

        if let Some(head_oid) = line.strip_prefix("HEAD ") {
            let head_oid = head_oid.trim();
            if !head_oid.is_empty() {
                worktree.head_oid = Some(head_oid.to_string());
            }
        } else if let Some(branch) = line.strip_prefix("branch ") {
            let branch = branch
                .trim()
                .strip_prefix("refs/heads/")
                .unwrap_or(branch.trim());
            if !branch.is_empty() {
                worktree.branch = Some(branch.to_string());
            }
        }
    }

    worktrees
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());

    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }

    #[cfg(not(windows))]
    {
        left == right
    }
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
    Omitted { preview: String, reason: String },
}

impl FileContent {
    fn message(&self) -> Option<&str> {
        if let Self::Missing(message) = self { Some(message) } else { None }
    }
    fn is_binary(&self) -> bool {
        matches!(self, Self::Binary)
    }
    fn into_text(self) -> String {
        match self {
            Self::Text(content) => content,
            _ => String::new(),
        }
    }
    fn preview(&self) -> String {
        let text = match self {
            Self::Text(text) | Self::Omitted { preview: text, .. } => text,
            Self::Binary | Self::Missing(_) => return String::new(),
        };
        let mut end = text.len().min(PREVIEW_MAX_BYTES);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_string()
    }
}

fn omitted_content(
    original: &FileContent,
    modified: &FileContent,
    binary: bool,
) -> Option<OmittedDiffContent> {
    if binary {
        return None;
    }
    let reason = match (original, modified) {
        (FileContent::Omitted { reason, .. }, _) | (_, FileContent::Omitted { reason, .. }) => {
            reason.clone()
        }
        _ => return None,
    };
    Some(OmittedDiffContent {
        reason,
        max_bytes_per_side: DIFF_MAX_BYTES,
        max_lines_per_side: DIFF_MAX_LINES,
        max_line_bytes: DIFF_MAX_LINE_BYTES,
        original_preview: original.preview(),
        modified_preview: modified.preview(),
    })
}

fn content_error(message: impl ToString) -> GitError {
    GitError {
        message: message.to_string(),
        stderr: String::new(),
        status: None,
    }
}

// Read one sentinel byte beyond the budget, including when a working file grows
// during the read. Never allocate based on untrusted metadata or blob size.
fn read_content(reader: impl Read) -> Result<(Vec<u8>, bool), GitError> {
    let mut bytes = Vec::new();
    reader
        .take((DIFF_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| content_error(format!("Failed to read file content: {e}")))?;
    let limited = bytes.len() > DIFF_MAX_BYTES;
    Ok((bytes, limited))
}

fn classify_content(mut bytes: Vec<u8>, limited: bool) -> FileContent {
    if bytes.contains(&0) {
        return FileContent::Binary;
    }
    if let Err(error) = std::str::from_utf8(&bytes) {
        if limited && error.error_len().is_none() {
            bytes.truncate(error.valid_up_to());
        } else {
            return FileContent::Binary;
        }
    }
    let text = String::from_utf8(bytes).expect("validated UTF-8");
    let reason = if limited {
        Some("A file side exceeds the byte limit.")
    } else if text.lines().count() > DIFF_MAX_LINES {
        Some("A file side exceeds the line limit.")
    } else if text
        .split('\n')
        .any(|line| line.len() > DIFF_MAX_LINE_BYTES)
    {
        Some("A line exceeds the line-length limit.")
    } else {
        None
    };
    match reason {
        Some(reason) => FileContent::Omitted {
            preview: text,
            reason: reason.to_string(),
        },
        None => FileContent::Text(text),
    }
}

fn status_is_present(status: char) -> bool {
    status != '.' && status != ' '
}

fn load_file_at_revision(
    root: &Path,
    revision: &str,
    file_path: &str,
) -> Result<FileContent, GitError> {
    load_file_from_git_spec(root, &format!("{revision}:{file_path}"))
}

fn load_file_from_index(root: &Path, file_path: &str) -> Result<FileContent, GitError> {
    load_file_from_git_spec(root, &format!(":{file_path}"))
}

fn load_file_from_git_spec(root: &Path, spec: &str) -> Result<FileContent, GitError> {
    let started = std::time::Instant::now();
    // cat-file emits raw blob bytes, without textconv or external diff helpers.
    // Stderr is not captured: diagnostics must not become another unbounded pipe.
    let mut child = git_command()
        .args(["cat-file", "blob", spec])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| content_error(format!("Failed to execute git: {e}")))?;
    let result = read_content(child.stdout.take().expect("piped stdout"));
    if result.as_ref().map_or(true, |(_, limited)| *limited) {
        // This is the exact child owned by this read; reap it even on read errors.
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|e| content_error(format!("Failed to wait for git: {e}")))?;
    let (bytes, limited) = result?;
    tracing::info!(target: "gitgui::git_command", category = "cat-file",
        elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
        stdout_bytes = bytes.len(), output_limited = limited, exit_code = status.code(),
        "Git subprocess completed");
    if !limited && !status.success() {
        return Err(content_error(format!(
            "Could not read Git blob {spec}; refresh and try again."
        )));
    }
    Ok(classify_content(bytes, limited))
}

fn load_file_from_working_tree(root: &Path, file_path: &str) -> Result<FileContent, GitError> {
    let full_path = root.join(file_path);
    if fs::symlink_metadata(&full_path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Ok(FileContent::Missing("Symlinks use whole-file actions.".to_string()));
    }
    let file = fs::File::open(&full_path)
        .map_err(|e| content_error(format!("Failed to open {file_path}: {e}")))?;
    let (bytes, limited) = read_content(file)?;
    #[cfg(test)]
    super::command::test_metrics::read(bytes.len());
    Ok(classify_content(bytes, limited))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn content_limits_cover_bytes_lines_long_lines_and_utf8_boundaries() {
        let exact_bytes = format!("{}\n", "x".repeat(DIFF_MAX_LINE_BYTES - 1)).repeat(8);
        assert_eq!(exact_bytes.len(), DIFF_MAX_BYTES);
        let (bytes, limited) = read_content(exact_bytes.as_bytes()).unwrap();
        assert!(!limited);
        assert!(matches!(classify_content(bytes, limited), FileContent::Text(_)));
        let unicode = FileContent::Text(format!("{}€", "x".repeat(PREVIEW_MAX_BYTES - 1)));
        assert_eq!(unicode.preview().len(), PREVIEW_MAX_BYTES - 1);
        let at_limit = format!("{}\n", "x".repeat(130)).repeat(DIFF_MAX_LINES);
        assert!(matches!(
            classify_content(at_limit.into_bytes(), false),
            FileContent::Text(_)
        ));
        assert!(matches!(
            classify_content(b"x\n".repeat(DIFF_MAX_LINES + 1), false),
            FileContent::Omitted { .. }
        ));
        assert!(matches!(
            classify_content(vec![b'x'; DIFF_MAX_LINE_BYTES], false),
            FileContent::Text(_)
        ));
        assert!(matches!(
            classify_content(vec![b'x'; DIFF_MAX_LINE_BYTES + 1], false),
            FileContent::Omitted { .. }
        ));
        let (bytes, limited) = read_content(std::io::repeat(b'x')).unwrap();
        assert_eq!(bytes.len(), DIFF_MAX_BYTES + 1);
        assert!(limited);
        assert!(matches!(
            classify_content(bytes, limited),
            FileContent::Omitted { .. }
        ));
        let mut partial_utf8 = vec![b'x'; DIFF_MAX_BYTES];
        partial_utf8.push(0xe2);
        let content = classify_content(partial_utf8, true);
        assert!(matches!(content, FileContent::Omitted { .. }));
        assert!(content.preview().len() <= PREVIEW_MAX_BYTES);
        assert!(matches!(
            classify_content(vec![0xff], false),
            FileContent::Binary
        ));
        assert!(matches!(
            classify_content(vec![0; DIFF_MAX_BYTES + 1], true),
            FileContent::Binary
        ));
    }

    #[test]
    fn large_content_is_bounded_for_worktree_index_commit_rename_and_deletion() {
        let repository = new_test_repository();
        let root = repository.0.as_path();
        run_test_git(root, &["init", "-q", "-b", "main"]);
        run_test_git(root, &["config", "user.email", "test@example.com"]);
        run_test_git(root, &["config", "user.name", "GitGui Test"]);
        let path = "large [file] ü.txt";
        let large = "a normal line\n".repeat(100_000);
        fs::write(root.join(path), &large).unwrap();
        let mut file = CommitFile {
            path: path.to_string(),
            original_path: None,
            status: "??".to_string(),
        };
        let assert_omitted = |diff: CommitFileDiff| {
            assert!(!diff.is_binary);
            assert!(diff.original_content.is_empty() && diff.modified_content.is_empty());
            let omitted = diff.omitted_content.unwrap();
            assert!(omitted.original_preview.len() <= PREVIEW_MAX_BYTES);
            assert!(omitted.modified_preview.len() <= PREVIEW_MAX_BYTES);
        };
        assert_omitted(
            load_working_tree_file_diff(root.to_str().unwrap(), None, &file, false).unwrap(),
        );
        run_test_git(root, &["add", "--", path]);
        file.status = "A.".to_string();
        assert_omitted(
            load_working_tree_file_diff(root.to_str().unwrap(), None, &file, true).unwrap(),
        );
        run_test_git(root, &["commit", "-q", "-m", "large"]);
        let first = run_test_git(root, &["rev-parse", "HEAD"])
            .trim()
            .to_string();
        file.status = "A".to_string();
        assert_omitted(load_commit_file_diff(root.to_str().unwrap(), &first, None, &file).unwrap());
        assert_omitted(load_commit_working_tree_file_diff(root.to_str().unwrap(), &first, &file).unwrap());
        let renamed = "renamed large.txt";
        run_test_git(root, &["mv", "--", path, renamed]);
        run_test_git(root, &["commit", "-q", "-m", "rename"]);
        let second = run_test_git(root, &["rev-parse", "HEAD"])
            .trim()
            .to_string();
        file = CommitFile {
            path: renamed.to_string(),
            original_path: Some(path.to_string()),
            status: "R100".to_string(),
        };
        assert_omitted(
            load_commit_file_diff(root.to_str().unwrap(), &second, Some(&first), &file).unwrap(),
        );
        fs::remove_file(root.join(renamed)).unwrap();
        file.original_path = None;
        file.status = ".D".to_string();
        assert_omitted(
            load_working_tree_file_diff(root.to_str().unwrap(), Some(&second), &file, false)
                .unwrap(),
        );
        assert!(load_file_at_revision(root, "HEAD", "missing").is_err());
        assert!(load_file_from_working_tree(root, "missing").is_err());
    }

    #[test]
    fn normal_and_binary_content_keep_the_existing_contract() {
        let repository = new_test_repository();
        let root = repository.0.as_path();
        let file = CommitFile {
            path: "file.txt".to_string(),
            original_path: None,
            status: "??".to_string(),
        };
        fs::write(root.join(&file.path), "normal\n").unwrap();
        let normal =
            load_working_tree_file_diff(root.to_str().unwrap(), None, &file, false).unwrap();
        assert_eq!(normal.modified_content, "normal\n");
        assert!(normal.omitted_content.is_none());
        fs::write(root.join(&file.path), vec![0; DIFF_MAX_BYTES * 10]).unwrap();
        let binary =
            load_working_tree_file_diff(root.to_str().unwrap(), None, &file, false).unwrap();
        assert!(binary.is_binary);
        assert!(binary.omitted_content.is_none());
        assert!(binary.modified_content.is_empty());
    }

    struct TestRepository(std::path::PathBuf);

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn run_test_git(root: &Path, args: &[&str]) -> String {
        GitCommand::run(args, Some(root)).unwrap()
    }

    fn new_test_repository() -> TestRepository {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "gitgui-core-merge-test-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
        TestRepository(root)
    }

    #[test]
    fn graph_history_uses_public_refs_and_detached_worktree_heads() {
        let repository = new_test_repository();
        let root = repository.0.as_path();
        run_test_git(root, &["init", "-q", "-b", "main"]);
        run_test_git(root, &["config", "user.email", "test@example.com"]);
        run_test_git(root, &["config", "user.name", "GitGui Test"]);
        run_test_git(root, &["commit", "-q", "--allow-empty", "-m", "base"]);
        let base = run_test_git(root, &["rev-parse", "HEAD"])
            .trim()
            .to_string();
        let tree = run_test_git(root, &["rev-parse", "HEAD^{tree}"])
            .trim()
            .to_string();
        let sibling = |message: &str| {
            run_test_git(root, &["commit-tree", &tree, "-p", &base, "-m", message])
                .trim()
                .to_string()
        };

        // A real branch commit with a checkpoint-looking subject must survive.
        let branch = sibling("t3 checkpoint ref=refs/t3/checkpoints/legitimate-commit");
        run_test_git(root, &["update-ref", "refs/heads/feature", &branch]);
        let remote = sibling("remote only");
        run_test_git(
            root,
            &["update-ref", "refs/remotes/origin/feature", &remote],
        );
        let tag = sibling("lightweight tag only");
        run_test_git(root, &["tag", "lightweight", &tag]);
        let annotated_tag = sibling("annotated tag only");
        run_test_git(
            root,
            &["tag", "-a", "annotated", "-m", "release", &annotated_tag],
        );

        for name in [
            "refs/t3/checkpoints/test/turn/0",
            "refs/t3/orchestration-v2/checkpoints/test/ordinal/0",
            "refs/codex/turn-diffs/checkpoints/test",
            "refs/future-tool/snapshots/test",
        ] {
            let checkpoint = sibling(name);
            run_test_git(root, &["update-ref", name, &checkpoint]);
        }

        let detached = sibling("detached HEAD");
        run_test_git(root, &["switch", "-q", "--detach", &detached]);
        let linked_head = sibling("detached linked worktree");
        let linked_path = root.join("linked worktree");
        run_test_git(
            root,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                linked_path.to_str().unwrap(),
                &linked_head,
            ],
        );

        let snapshot = load_repository(root.to_str().unwrap()).unwrap();
        let actual: HashSet<String> = snapshot
            .commits
            .iter()
            .map(|commit| commit.hash.clone())
            .collect();
        let expected: HashSet<String> = [
            base,
            branch,
            remote,
            tag,
            annotated_tag,
            detached,
            linked_head,
        ]
        .into_iter()
        .collect();
        assert_eq!(actual, expected);
        assert_eq!(snapshot.graph.commits.len(), expected.len());
    }

    #[test]
    fn graph_history_keeps_all_stashes_without_helper_commits() {
        let repository = new_test_repository();
        let root = repository.0.as_path();
        run_test_git(root, &["init", "-q", "-b", "main"]);
        run_test_git(root, &["config", "user.email", "test@example.com"]);
        run_test_git(root, &["config", "user.name", "GitGui Test"]);
        std::fs::write(root.join("file.txt"), "base\n").unwrap();
        run_test_git(root, &["add", "file.txt"]);
        run_test_git(root, &["commit", "-q", "-m", "base"]);
        let base = run_test_git(root, &["rev-parse", "HEAD"])
            .trim()
            .to_string();

        for contents in ["first stash\n", "second stash\n"] {
            std::fs::write(root.join("file.txt"), contents).unwrap();
            run_test_git(root, &["stash", "push", "-q", "-m", contents.trim()]);
        }

        let snapshot = load_repository(root.to_str().unwrap()).unwrap();
        assert_eq!(snapshot.stashes.len(), 2);
        let actual: HashSet<&str> = snapshot
            .commits
            .iter()
            .map(|commit| commit.hash.as_str())
            .collect();
        let expected: HashSet<&str> = std::iter::once(base.as_str())
            .chain(snapshot.stashes.iter().map(|stash| stash.hash.as_str()))
            .collect();
        assert_eq!(actual, expected);
        assert_eq!(snapshot.graph.commits.len(), expected.len());
    }

    #[test]
    fn graph_history_handles_an_unborn_repository() {
        let repository = new_test_repository();
        let root = repository.0.as_path();
        run_test_git(root, &["init", "-q", "-b", "main"]);

        let snapshot = load_repository(root.to_str().unwrap()).unwrap();
        assert!(snapshot.status.head_oid.is_none());
        assert!(snapshot.commits.is_empty());
        assert!(snapshot.graph.commits.is_empty());
    }

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
    fn lists_merge_files_against_first_parent() {
        let repository = new_test_repository();
        let root = repository.0.as_path();

        run_test_git(root, &["init", "-q", "-b", "main"]);
        run_test_git(root, &["config", "user.email", "test@example.com"]);
        run_test_git(root, &["config", "user.name", "GitGui Test"]);

        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        run_test_git(root, &["add", "base.txt"]);
        run_test_git(root, &["commit", "-q", "-m", "base"]);

        run_test_git(root, &["switch", "-q", "-c", "feature"]);
        std::fs::write(root.join("feature.txt"), "feature\n").unwrap();
        run_test_git(root, &["add", "feature.txt"]);
        run_test_git(root, &["commit", "-q", "-m", "feature"]);

        run_test_git(root, &["switch", "-q", "main"]);
        std::fs::write(root.join("main.txt"), "main\n").unwrap();
        run_test_git(root, &["add", "main.txt"]);
        run_test_git(root, &["commit", "-q", "-m", "main"]);
        run_test_git(root, &["merge", "--no-ff", "-q", "feature", "-m", "merge"]);

        let merge_hash = run_test_git(root, &["rev-parse", "HEAD"]);
        let files = load_commit_files_from_root(root.to_str().unwrap(), merge_hash.trim()).unwrap();

        assert_eq!(
            files
                .into_iter()
                .map(|file| (file.path, file.original_path, file.status))
                .collect::<Vec<_>>(),
            vec![("feature.txt".to_string(), None, "A".to_string())]
        );
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
    fn loads_staged_and_unstaged_file_sides_separately() {
        let repository = new_test_repository();
        let root = repository.0.as_path();

        run_test_git(root, &["init", "-q", "-b", "main"]);
        run_test_git(root, &["config", "user.email", "test@example.com"]);
        run_test_git(root, &["config", "user.name", "GitGui Test"]);

        std::fs::write(root.join("split.txt"), "base\n").unwrap();
        run_test_git(root, &["add", "split.txt"]);
        run_test_git(root, &["commit", "-q", "-m", "base"]);

        std::fs::write(root.join("split.txt"), "staged\n").unwrap();
        run_test_git(root, &["add", "split.txt"]);
        std::fs::write(root.join("split.txt"), "staged\nunstaged\n").unwrap();

        let head_hash = run_test_git(root, &["rev-parse", "HEAD"]);
        let file = CommitFile {
            path: "split.txt".to_string(),
            original_path: None,
            status: "MM".to_string(),
        };

        let staged = load_working_tree_file_diff(
            root.to_str().unwrap(),
            Some(head_hash.trim()),
            &file,
            true,
        )
        .unwrap();
        assert_eq!(staged.original_content, "base\n");
        assert_eq!(staged.modified_content, "staged\n");

        let unstaged = load_working_tree_file_diff(
            root.to_str().unwrap(),
            Some(head_hash.trim()),
            &file,
            false,
        )
        .unwrap();
        assert_eq!(unstaged.original_content, "staged\n");
        assert_eq!(unstaged.modified_content, "staged\nunstaged\n");
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
    fn parses_worktree_porcelain_output() {
        let parsed = parse_worktrees(
            "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def456\ndetached\n",
            Path::new("/repo"),
        );

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].path, "/repo");
        assert_eq!(parsed[0].head_oid.as_deref(), Some("abc123"));
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert!(parsed[0].current);
        assert_eq!(parsed[1].path, "/repo-feature");
        assert_eq!(parsed[1].head_oid.as_deref(), Some("def456"));
        assert_eq!(parsed[1].branch, None);
        assert!(!parsed[1].current);
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

    #[test]
    fn commit_to_working_tree_comparison_includes_staged_unstaged_and_untracked_files() {
        let repository = new_test_repository();
        let root = repository.0.as_path();
        run_test_git(root, &["init", "-q", "-b", "main"]);
        run_test_git(root, &["config", "user.email", "test@example.com"]);
        run_test_git(root, &["config", "user.name", "GitGui Test"]);
        std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
        run_test_git(root, &["add", "tracked.txt"]);
        run_test_git(root, &["commit", "-q", "-m", "base"]);
        let base = run_test_git(root, &["rev-parse", "HEAD"])
            .trim()
            .to_string();
        std::fs::write(root.join("tracked.txt"), "staged\n").unwrap();
        run_test_git(root, &["add", "tracked.txt"]);
        std::fs::write(root.join("tracked.txt"), "working\n").unwrap();
        std::fs::write(root.join("new.txt"), "untracked\n").unwrap();

        let files = load_commit_working_tree_files(root.to_str().unwrap(), &base).unwrap();
        assert!(files.iter().any(|file| file.path == "tracked.txt"));
        assert!(files
            .iter()
            .any(|file| file.path == "new.txt" && file.status == "A"));
        let tracked = files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        let diff =
            load_commit_working_tree_file_diff(root.to_str().unwrap(), &base, tracked).unwrap();
        assert_eq!(diff.original_content, "base\n");
        assert_eq!(diff.modified_content, "working\n");
        let added = files.iter().find(|file| file.path == "new.txt").unwrap();
        let diff =
            load_commit_working_tree_file_diff(root.to_str().unwrap(), &base, added).unwrap();
        assert_eq!(diff.original_content, "");
        assert_eq!(diff.modified_content, "untracked\n");
    }
}
