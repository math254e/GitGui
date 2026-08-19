use super::repository::CommitInfo;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

const INDEX_NODE: &str = "__gitgui_index__";

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

/// Produces a deterministic temporal topological order.
///
/// Recent commits are considered first, but children are always emitted before
/// their parents. Parent order is therefore safe for graph drawing even when
/// commit timestamps are skewed by rebases, cherry-picks, or incorrect clocks.
pub(crate) fn sort_commits(mut commits: Vec<CommitInfo>) -> Vec<CommitInfo> {
    commits.sort_by(compare_commits);

    let commit_by_hash: HashMap<&str, &CommitInfo> = commits
        .iter()
        .map(|commit| (commit.hash.as_str(), commit))
        .collect();
    let children = build_children(&commits);
    let mut sorted = Vec::with_capacity(commits.len());
    let mut seen = HashSet::with_capacity(commits.len());

    for commit in &commits {
        if seen.contains(commit.hash.as_str()) {
            continue;
        }

        let mut stack = vec![(commit.hash.as_str(), false)];

        while let Some((hash, expanded)) = stack.pop() {
            if expanded {
                if let Some(commit) = commit_by_hash.get(hash) {
                    sorted.push((*commit).clone());
                }
                continue;
            }

            if !seen.insert(hash) {
                continue;
            }

            stack.push((hash, true));

            if let Some(child_hashes) = children.get(hash) {
                for child_hash in child_hashes.iter().rev() {
                    if !seen.contains(child_hash.as_str()) {
                        stack.push((child_hash.as_str(), false));
                    }
                }
            }
        }
    }

    sorted
}

/// Assigns one stable lane to every commit using Gitamine's straight-branch
/// semantics. Empty lane slots are retained and reused; active lanes never
/// shift merely because another branch ends.
pub(crate) fn build_commit_graph(commits: &[CommitInfo], head_hash: Option<&str>) -> CommitGraph {
    let children = build_children(commits);
    let commit_by_hash: HashMap<&str, &CommitInfo> = commits
        .iter()
        .map(|commit| (commit.hash.as_str(), commit))
        .collect();
    let row_by_hash: HashMap<&str, usize> = commits
        .iter()
        .enumerate()
        .map(|(index, commit)| (commit.hash.as_str(), index + 1))
        .collect();
    let head_hash = head_hash.filter(|hash| row_by_hash.contains_key(*hash));
    let mut positions: HashMap<String, (usize, usize)> = HashMap::with_capacity(commits.len());
    let mut graph_commits = Vec::with_capacity(commits.len());
    let mut branches: Vec<Option<String>> = if head_hash.is_some() {
        vec![Some(INDEX_NODE.to_string())]
    } else {
        Vec::new()
    };
    let mut active_nodes: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut expirations: BinaryHeap<Reverse<(usize, String)>> = BinaryHeap::new();

    if let Some(head_hash) = head_hash {
        active_nodes.insert(INDEX_NODE.to_string(), HashSet::new());
        expirations.push(Reverse((row_by_hash[head_hash], INDEX_NODE.to_string())));
    }

    for (index, commit) in commits.iter().enumerate() {
        let row = index + 1;
        let commit_hash = commit.hash.as_str();
        let child_hashes = children
            .get(commit_hash)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let branch_children: Vec<&str> = child_hashes
            .iter()
            .map(String::as_str)
            .filter(|child_hash| {
                commit_by_hash
                    .get(child_hash)
                    .and_then(|child| child.parents.first())
                    .is_some_and(|first_parent| first_parent == commit_hash)
            })
            .collect();
        let merge_children: Vec<&str> = child_hashes
            .iter()
            .map(String::as_str)
            .filter(|child_hash| {
                commit_by_hash
                    .get(child_hash)
                    .and_then(|child| child.parents.first())
                    .is_some_and(|first_parent| first_parent != commit_hash)
            })
            .collect();
        let forbidden_lanes =
            forbidden_lanes_for_merge_children(&merge_children, &positions, &active_nodes);

        let commit_to_replace = if Some(commit_hash) == head_hash {
            Some((INDEX_NODE, 0))
        } else {
            branch_children
                .iter()
                .filter_map(|child_hash| {
                    positions
                        .get(*child_hash)
                        .map(|(_, lane)| (*child_hash, *lane))
                })
                .filter(|(_, lane)| !forbidden_lanes.contains(lane))
                .min_by_key(|(_, lane)| *lane)
        };

        let lane = if let Some((_, replace_lane)) = commit_to_replace {
            branches[replace_lane] = Some(commit_hash.to_string());
            replace_lane
        } else if let Some(child_hash) = child_hashes.first() {
            let near_lane = positions
                .get(child_hash)
                .map(|(_, lane)| *lane)
                .unwrap_or(0);
            insert_commit_near_lane(&mut branches, commit_hash, near_lane, &forbidden_lanes)
        } else {
            insert_commit_near_lane(&mut branches, commit_hash, 0, &HashSet::new())
        };

        while let Some(Reverse((remove_row, node_hash))) = expirations.peek() {
            if *remove_row >= row {
                break;
            }

            let node_hash = node_hash.clone();
            expirations.pop();
            active_nodes.remove(&node_hash);
        }

        let mut occupied_lanes = vec![lane];
        occupied_lanes.extend(
            branch_children
                .iter()
                .filter_map(|child_hash| positions.get(*child_hash).map(|(_, lane)| *lane)),
        );

        for active_node in active_nodes.values_mut() {
            active_node.extend(occupied_lanes.iter().copied());
        }

        if let Some(remove_row) = commit
            .parents
            .iter()
            .filter_map(|parent_hash| row_by_hash.get(parent_hash.as_str()).copied())
            .max()
        {
            active_nodes.insert(commit_hash.to_string(), HashSet::new());
            expirations.push(Reverse((remove_row, commit_hash.to_string())));
        }

        for child_hash in &branch_children {
            if commit_to_replace.is_some_and(|(replaced, _)| replaced == *child_hash) {
                continue;
            }

            if let Some((_, child_lane)) = positions.get(*child_hash) {
                branches[*child_lane] = None;
            }
        }

        if commit.parents.is_empty() {
            branches[lane] = None;
        }

        positions.insert(commit_hash.to_string(), (row, lane));
        graph_commits.push(GraphCommit {
            hash: commit_hash.to_string(),
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

fn compare_commits(first: &CommitInfo, second: &CommitInfo) -> std::cmp::Ordering {
    second
        .timestamp
        .cmp(&first.timestamp)
        .then_with(|| first.hash.cmp(&second.hash))
}

fn build_children(commits: &[CommitInfo]) -> HashMap<String, Vec<String>> {
    let known_hashes: HashSet<&str> = commits.iter().map(|commit| commit.hash.as_str()).collect();
    let commit_by_hash: HashMap<&str, &CommitInfo> = commits
        .iter()
        .map(|commit| (commit.hash.as_str(), commit))
        .collect();
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

    for (parent_hash, child_hashes) in &mut children {
        child_hashes.sort_by(|first_hash, second_hash| {
            let first = commit_by_hash[first_hash.as_str()];
            let second = commit_by_hash[second_hash.as_str()];
            let first_parent_rank = usize::from(first.parents.first() != Some(parent_hash));
            let second_parent_rank = usize::from(second.parents.first() != Some(parent_hash));

            first_parent_rank
                .cmp(&second_parent_rank)
                .then_with(|| compare_commits(first, second))
        });
    }

    children
}

fn forbidden_lanes_for_merge_children(
    merge_children: &[&str],
    positions: &HashMap<String, (usize, usize)>,
    active_nodes: &HashMap<String, HashSet<usize>>,
) -> HashSet<usize> {
    merge_children
        .iter()
        .filter_map(|child_hash| {
            positions
                .get(*child_hash)
                .map(|(row, _)| (*row, *child_hash))
        })
        .min_by_key(|(row, _)| *row)
        .and_then(|(_, child_hash)| active_nodes.get(child_hash).cloned())
        .unwrap_or_default()
}

fn insert_commit_near_lane(
    branches: &mut Vec<Option<String>>,
    commit_hash: &str,
    lane: usize,
    forbidden_lanes: &HashSet<usize>,
) -> usize {
    if branches.is_empty() {
        branches.push(Some(commit_hash.to_string()));
        return 0;
    }

    let mut distance = 1;

    while lane >= distance || lane + distance < branches.len() {
        let right_lane = lane + distance;

        if right_lane < branches.len()
            && branches[right_lane].is_none()
            && !forbidden_lanes.contains(&right_lane)
        {
            branches[right_lane] = Some(commit_hash.to_string());
            return right_lane;
        }

        if lane >= distance {
            let left_lane = lane - distance;

            if branches[left_lane].is_none() && !forbidden_lanes.contains(&left_lane) {
                branches[left_lane] = Some(commit_hash.to_string());
                return left_lane;
            }
        }

        distance += 1;
    }

    branches.push(Some(commit_hash.to_string()));
    branches.len() - 1
}

fn build_graph_edges(
    commits: &[CommitInfo],
    positions: &HashMap<String, (usize, usize)>,
) -> Vec<GraphEdge> {
    let mut edges = Vec::new();

    for commit in commits {
        if !positions.contains_key(&commit.hash) {
            continue;
        }

        for (parent_index, parent_hash) in commit.parents.iter().enumerate() {
            if !positions.contains_key(parent_hash) {
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

    fn assert_graph_invariants(commits: &[CommitInfo], graph: &CommitGraph) {
        let positions: HashMap<&str, (usize, usize)> = graph
            .commits
            .iter()
            .map(|commit| (commit.hash.as_str(), (commit.row, commit.lane)))
            .collect();
        let rows: HashSet<usize> = graph.commits.iter().map(|commit| commit.row).collect();

        assert_eq!(positions.len(), commits.len());
        assert_eq!(rows.len(), commits.len());
        assert!(graph.commits.iter().all(|commit| commit.lane < graph.width));

        for commit in commits {
            let (child_row, _) = positions[commit.hash.as_str()];

            for parent_hash in &commit.parents {
                if let Some((parent_row, _)) = positions.get(parent_hash.as_str()) {
                    assert!(
                        child_row < *parent_row,
                        "{} must be above {}",
                        commit.hash,
                        parent_hash
                    );
                }
            }
        }

        for edge in &graph.edges {
            let (from_row, from_lane) = positions[edge.from.as_str()];
            let (to_row, to_lane) = positions[edge.to.as_str()];
            let vertical_lane = match edge.edge_type {
                GraphEdgeType::Normal => from_lane,
                GraphEdgeType::Merge => to_lane,
            };

            assert!(from_row < to_row);
            assert!(!graph.commits.iter().any(|commit| {
                commit.row > from_row && commit.row < to_row && commit.lane == vertical_lane
            }));
        }
    }

    #[test]
    fn keeps_linear_history_in_lane_zero() {
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
        assert_graph_invariants(&commits, &graph);
    }

    #[test]
    fn places_branch_in_second_lane_and_rejoins_after_merge() {
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
        assert_graph_invariants(&commits, &graph);
    }

    #[test]
    fn marks_first_parent_edges_as_normal_and_other_parent_edges_as_merge() {
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
    fn reuses_empty_lanes_without_shifting_active_lanes() {
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
        assert_graph_invariants(&commits, &graph);
    }

    #[test]
    fn keeps_children_above_parents_when_timestamps_are_skewed() {
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

    #[test]
    fn output_is_stable_for_permuted_input() {
        let first = vec![
            commit("a", &[], 1),
            commit("b", &["a"], 2),
            commit("c", &["a"], 3),
            commit("m", &["b", "c"], 4),
        ];
        let second = vec![
            first[2].clone(),
            first[0].clone(),
            first[3].clone(),
            first[1].clone(),
        ];

        let first = sort_commits(first);
        let second = sort_commits(second);
        let first_graph = build_commit_graph(&first, Some("m"));
        let second_graph = build_commit_graph(&second, Some("m"));

        assert_eq!(
            first.iter().map(|commit| &commit.hash).collect::<Vec<_>>(),
            second.iter().map(|commit| &commit.hash).collect::<Vec<_>>()
        );
        assert_eq!(
            first_graph
                .commits
                .iter()
                .map(|commit| (&commit.hash, commit.row, commit.lane))
                .collect::<Vec<_>>(),
            second_graph
                .commits
                .iter()
                .map(|commit| (&commit.hash, commit.row, commit.lane))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn reserves_lane_zero_for_head_when_another_root_is_newer() {
        let commits = sort_commits(vec![
            commit("head-root", &[], 1),
            commit("other-root", &[], 2),
        ]);
        let graph = build_commit_graph(&commits, Some("head-root"));

        assert_eq!(graph_commit(&graph, "other-root").lane, 1);
        assert_eq!(graph_commit(&graph, "head-root").lane, 0);
        assert_eq!(graph.head_lane, Some(0));
        assert_graph_invariants(&commits, &graph);
    }

    #[test]
    fn starts_at_lane_zero_when_head_is_not_in_history() {
        let commits = sort_commits(vec![commit("a", &[], 1)]);
        let graph = build_commit_graph(&commits, Some("missing"));

        assert_eq!(graph_commit(&graph, "a").lane, 0);
        assert_eq!(graph.head_lane, None);
        assert_eq!(graph.width, 1);
    }

    #[test]
    fn supports_octopus_merges_and_missing_parents() {
        let commits = sort_commits(vec![
            commit("a", &[], 1),
            commit("b", &["a"], 2),
            commit("c", &["a"], 3),
            commit("d", &["a", "missing"], 4),
            commit("m", &["b", "c", "d"], 5),
        ]);
        let graph = build_commit_graph(&commits, Some("m"));

        assert_eq!(
            graph.edges.iter().filter(|edge| edge.from == "m").count(),
            3
        );
        assert!(!graph.edges.iter().any(|edge| edge.to == "missing"));
        assert_graph_invariants(&commits, &graph);
    }
}
