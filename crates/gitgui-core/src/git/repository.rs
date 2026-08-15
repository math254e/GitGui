use super::command::{git_command, GitCommand, GitError};
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
pub struct CommitGraph {
    pub commits: Vec<GraphCommit>,
    pub edges: Vec<GraphEdge>,
    pub width: usize,
    pub head_lane: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub hash: String,
    pub row: usize,
    pub lane: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub edge_type: GraphEdgeType,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GraphEdgeType {
    Normal,
    Merge,
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
    let commits = sort_commits(load_commits(root)?);
    let graph = build_commit_graph(&commits, status.head_oid.as_deref());
    let refs = load_refs(root)?;

    Ok(RepositorySnapshot {
        status,
        graph,
        refs,
        commits,
        info,
    })
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

fn sort_commits(mut commits: Vec<CommitInfo>) -> Vec<CommitInfo> {
    let children = build_children(&commits);
    let commit_by_hash: HashMap<String, CommitInfo> = commits
        .iter()
        .cloned()
        .map(|commit| (commit.hash.clone(), commit))
        .collect();
    let mut sorted = Vec::with_capacity(commits.len());
    let mut seen = HashSet::new();

    commits.sort_by(|first, second| {
        second
            .timestamp
            .cmp(&first.timestamp)
            .then_with(|| first.hash.cmp(&second.hash))
    });

    for commit in &commits {
        visit_commit_for_sort(
            &commit.hash,
            &commit_by_hash,
            &children,
            &mut seen,
            &mut sorted,
        );
    }

    sorted
}

fn visit_commit_for_sort(
    commit_hash: &str,
    commit_by_hash: &HashMap<String, CommitInfo>,
    children: &HashMap<String, Vec<String>>,
    seen: &mut HashSet<String>,
    sorted: &mut Vec<CommitInfo>,
) {
    if !seen.insert(commit_hash.to_string()) {
        return;
    }

    if let Some(child_hashes) = children.get(commit_hash) {
        for child_hash in child_hashes {
            visit_commit_for_sort(child_hash, commit_by_hash, children, seen, sorted);
        }
    }

    if let Some(commit) = commit_by_hash.get(commit_hash) {
        sorted.push(commit.clone());
    }
}

fn build_children(commits: &[CommitInfo]) -> HashMap<String, Vec<String>> {
    let known_hashes: HashSet<&str> = commits.iter().map(|commit| commit.hash.as_str()).collect();
    let mut children: HashMap<String, Vec<String>> = commits
        .iter()
        .map(|commit| (commit.hash.clone(), Vec::new()))
        .collect();

    for commit in commits {
        for parent_hash in &commit.parents {
            if known_hashes.contains(parent_hash.as_str()) {
                children
                    .entry(parent_hash.clone())
                    .or_default()
                    .push(commit.hash.clone());
            }
        }
    }

    children
}

fn build_commit_graph(commits: &[CommitInfo], head_hash: Option<&str>) -> CommitGraph {
    const INDEX_NODE: &str = "__gitgui_index__";

    let children = build_children(commits);
    let commit_by_hash: HashMap<&str, &CommitInfo> = commits
        .iter()
        .map(|commit| (commit.hash.as_str(), commit))
        .collect();
    let sha_to_index: HashMap<String, usize> = commits
        .iter()
        .enumerate()
        .map(|(index, commit)| (commit.hash.clone(), index + 1))
        .collect();
    let mut positions: HashMap<String, (usize, usize)> = HashMap::new();
    let mut graph_commits = Vec::with_capacity(commits.len());
    let mut branches: Vec<Option<String>> = vec![Some(INDEX_NODE.to_string())];
    let mut active_nodes: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut active_queue: Vec<(usize, String)> = Vec::new();
    let head_hash = head_hash.filter(|hash| sha_to_index.contains_key(*hash));

    active_nodes.insert(INDEX_NODE.to_string(), HashSet::new());

    if let Some(head_hash) = head_hash {
        if let Some(head_index) = sha_to_index.get(head_hash) {
            active_queue.push((*head_index, INDEX_NODE.to_string()));
        }
    }

    for (index, commit) in commits.iter().enumerate() {
        let row = index + 1;
        let commit_hash = commit.hash.clone();
        let empty_children = Vec::new();
        let child_hashes = children.get(&commit_hash).unwrap_or(&empty_children);
        let branch_children: Vec<&String> = child_hashes
            .iter()
            .filter(|child_hash| {
                commit_by_hash
                    .get(child_hash.as_str())
                    .and_then(|child| child.parents.first())
                    .is_some_and(|first_parent| first_parent == &commit_hash)
            })
            .collect();
        let merge_children: Vec<&String> = child_hashes
            .iter()
            .filter(|child_hash| {
                commit_by_hash
                    .get(child_hash.as_str())
                    .and_then(|child| child.parents.first())
                    .is_some_and(|first_parent| first_parent != &commit_hash)
            })
            .collect();
        let forbidden_lanes =
            forbidden_lanes_for_merge_children(&merge_children, &positions, &active_nodes);
        let mut commit_to_replace: Option<&str> = None;
        let mut replace_lane = usize::MAX;

        if Some(commit_hash.as_str()) == head_hash {
            commit_to_replace = Some(INDEX_NODE);
            replace_lane = 0;
        } else {
            for child_hash in &branch_children {
                let Some((_, child_lane)) = positions.get(child_hash.as_str()) else {
                    continue;
                };

                if !forbidden_lanes.contains(child_lane) && *child_lane < replace_lane {
                    commit_to_replace = Some(child_hash.as_str());
                    replace_lane = *child_lane;
                }
            }
        }

        let lane = if commit_to_replace.is_some() {
            branches[replace_lane] = Some(commit_hash.clone());
            replace_lane
        } else if let Some(child_hash) = child_hashes.first() {
            let near_lane = positions
                .get(child_hash.as_str())
                .map(|(_, lane)| *lane)
                .unwrap_or(0);
            insert_commit_near_lane(
                &mut branches,
                commit_hash.clone(),
                near_lane,
                &forbidden_lanes,
            )
        } else {
            insert_commit_near_lane(&mut branches, commit_hash.clone(), 0, &HashSet::new())
        };

        active_queue.retain(|(remove_row, node_hash)| {
            if *remove_row < row {
                active_nodes.remove(node_hash);
                false
            } else {
                true
            }
        });

        let mut lanes_to_add = vec![lane];
        for child_hash in &branch_children {
            if let Some((_, child_lane)) = positions.get(child_hash.as_str()) {
                lanes_to_add.push(*child_lane);
            }
        }

        for active_node in active_nodes.values_mut() {
            active_node.extend(lanes_to_add.iter().copied());
        }

        active_nodes.insert(commit_hash.clone(), HashSet::new());

        if let Some(remove_row) = commit
            .parents
            .iter()
            .filter_map(|parent_hash| sha_to_index.get(parent_hash).copied())
            .max()
        {
            active_queue.push((remove_row, commit_hash.clone()));
        }

        for child_hash in &branch_children {
            if Some(child_hash.as_str()) != commit_to_replace {
                if let Some((_, child_lane)) = positions.get(child_hash.as_str()) {
                    branches[*child_lane] = None;
                }
            }
        }

        if commit.parents.is_empty() {
            branches[lane] = None;
        }

        positions.insert(commit_hash.clone(), (row, lane));
        graph_commits.push(GraphCommit {
            hash: commit_hash,
            row,
            lane,
        });
    }

    let edges = build_graph_edges(commits, &positions);
    let head_lane = head_hash.and_then(|hash| positions.get(hash).map(|(_, lane)| *lane));

    CommitGraph {
        commits: graph_commits,
        edges,
        width: branches.len().max(1),
        head_lane,
    }
}

fn forbidden_lanes_for_merge_children(
    merge_children: &[&String],
    positions: &HashMap<String, (usize, usize)>,
    active_nodes: &HashMap<String, HashSet<usize>>,
) -> HashSet<usize> {
    let highest_child = merge_children
        .iter()
        .filter_map(|child_hash| {
            positions
                .get(child_hash.as_str())
                .map(|(row, _)| (*row, *child_hash))
        })
        .min_by_key(|(row, _)| *row)
        .map(|(_, child_hash)| child_hash);

    highest_child
        .and_then(|child_hash| active_nodes.get(child_hash.as_str()).cloned())
        .unwrap_or_default()
}

fn insert_commit_near_lane(
    branches: &mut Vec<Option<String>>,
    commit_hash: String,
    lane: usize,
    forbidden_lanes: &HashSet<usize>,
) -> usize {
    let mut distance = 1;

    while lane >= distance || lane + distance < branches.len() {
        let right_lane = lane + distance;

        if right_lane < branches.len()
            && branches[right_lane].is_none()
            && !forbidden_lanes.contains(&right_lane)
        {
            branches[right_lane] = Some(commit_hash);
            return right_lane;
        }

        if lane >= distance {
            let left_lane = lane - distance;

            if branches[left_lane].is_none() && !forbidden_lanes.contains(&left_lane) {
                branches[left_lane] = Some(commit_hash);
                return left_lane;
            }
        }

        distance += 1;
    }

    branches.push(Some(commit_hash));
    branches.len() - 1
}

fn build_graph_edges(
    commits: &[CommitInfo],
    positions: &HashMap<String, (usize, usize)>,
) -> Vec<GraphEdge> {
    let known_hashes: HashSet<&str> = commits.iter().map(|commit| commit.hash.as_str()).collect();
    let mut edges = Vec::new();

    for commit in commits {
        if !positions.contains_key(&commit.hash) {
            continue;
        }

        for (parent_index, parent_hash) in commit.parents.iter().enumerate() {
            if !known_hashes.contains(parent_hash.as_str()) || !positions.contains_key(parent_hash)
            {
                continue;
            }

            edges.push(GraphEdge {
                from: commit.hash.clone(),
                to: parent_hash.clone(),
                edge_type: if parent_index == 0 {
                    GraphEdgeType::Normal
                } else {
                    GraphEdgeType::Merge
                },
            });
        }
    }

    edges
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

    fn commit(hash: &str, parents: &[&str], timestamp: i64) -> CommitInfo {
        CommitInfo {
            hash: hash.to_string(),
            parents: parents.iter().map(|parent| parent.to_string()).collect(),
            author: "Test Author".to_string(),
            timestamp,
            message: format!("Commit {hash}"),
        }
    }

    fn graph_commit<'a>(graph: &'a CommitGraph, hash: &str) -> &'a GraphCommit {
        graph
            .commits
            .iter()
            .find(|commit| commit.hash == hash)
            .unwrap()
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
    fn graph_keeps_linear_history_in_lane_zero() {
        let commits = sort_commits(vec![
            commit("a", &[], 1),
            commit("b", &["a"], 2),
            commit("c", &["b"], 3),
        ]);
        let graph = build_commit_graph(&commits, Some("c"));

        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.hash.as_str())
                .collect::<Vec<_>>(),
            vec!["c", "b", "a"]
        );
        assert_eq!(graph.width, 1);
        assert_eq!(graph.head_lane, Some(0));
        assert!(graph.commits.iter().all(|commit| commit.lane == 0));
    }

    #[test]
    fn graph_places_branch_in_second_lane_and_rejoins_after_merge() {
        let commits = sort_commits(vec![
            commit("a", &[], 1),
            commit("b", &["a"], 2),
            commit("c", &["a"], 3),
            commit("m", &["b", "c"], 4),
        ]);
        let graph = build_commit_graph(&commits, Some("m"));

        assert_eq!(graph_commit(&graph, "m").lane, 0);
        assert_eq!(graph_commit(&graph, "b").lane, 0);
        assert_eq!(graph_commit(&graph, "c").lane, 1);
        assert_eq!(graph_commit(&graph, "a").lane, 0);
        assert_eq!(graph.width, 2);
    }

    #[test]
    fn graph_marks_first_parent_edges_as_normal_and_other_parent_edges_as_merge() {
        let commits = sort_commits(vec![
            commit("a", &[], 1),
            commit("b", &["a"], 2),
            commit("c", &["a"], 3),
            commit("m", &["b", "c"], 4),
        ]);
        let graph = build_commit_graph(&commits, Some("m"));

        assert_eq!(
            graph
                .edges
                .iter()
                .find(|edge| edge.from == "m" && edge.to == "b")
                .map(|edge| &edge.edge_type),
            Some(&GraphEdgeType::Normal)
        );
        assert_eq!(
            graph
                .edges
                .iter()
                .find(|edge| edge.from == "m" && edge.to == "c")
                .map(|edge| &edge.edge_type),
            Some(&GraphEdgeType::Merge)
        );
    }

    #[test]
    fn graph_reuses_empty_lanes_without_shifting_active_lanes() {
        let commits = sort_commits(vec![
            commit("a", &[], 1),
            commit("b", &["a"], 2),
            commit("c", &["a"], 3),
            commit("d", &["b"], 4),
            commit("e", &["d", "c"], 5),
            commit("f", &["e"], 6),
        ]);
        let graph = build_commit_graph(&commits, Some("f"));

        assert_eq!(graph_commit(&graph, "f").lane, 0);
        assert_eq!(graph_commit(&graph, "e").lane, 0);
        assert_eq!(graph_commit(&graph, "d").lane, 0);
        assert_eq!(graph_commit(&graph, "c").lane, 1);
        assert_eq!(graph_commit(&graph, "a").lane, 0);
    }

    #[test]
    fn temporal_topological_sort_keeps_children_above_newer_parents() {
        let commits = sort_commits(vec![
            commit("parent-with-newer-timestamp", &[], 10),
            commit(
                "child-with-older-timestamp",
                &["parent-with-newer-timestamp"],
                1,
            ),
        ]);

        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.hash.as_str())
                .collect::<Vec<_>>(),
            vec!["child-with-older-timestamp", "parent-with-newer-timestamp"]
        );
    }
}
