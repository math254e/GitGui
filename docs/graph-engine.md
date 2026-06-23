# Graph Engine Notes

This document is a living knowledge base for future commit graph work.

## References

- Gitamine is the behavioral source of truth for graph layout semantics, especially commit ordering, lane assignment, lane reuse, and edge routing.
- GitGui should reproduce Gitamine's graph behavior as closely as practical while keeping its own visual layer and application UI.
- Initial research baseline: `pvigier/gitamine@0f66a960b1e52a5e9faba2cb791e5dfddabb3a29`.
- Relevant Gitamine files:
  - `src/renderer/helpers/repo-wrapper.ts`
  - `src/renderer/helpers/commit-graph.ts`
  - `src/renderer/components/graph-canvas.tsx`

## Terminology

- DAG: Git history is a directed acyclic graph.
- Commit node: A visual representation of a Git commit.
- Parent edge: A connection from a commit to one of its parents.
- Lane: A stable horizontal graph position used to reduce visual crossings.

## Future Data Structures

```rust
pub struct GraphCommit {
    pub hash: String,
    pub row: usize,
    pub lane: usize,
}

pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub edge_type: GraphEdgeType,
}
```

## Edge Routing Ideas

- Use Gitamine's temporal topological ordering as the starting point for row assignment.
- Use Gitamine's straight-branch lane algorithm for column assignment.
- Distinguish branch children from merge children using parent order.
- Compute forbidden columns for merge edges so edges do not overlap commits or occupied branches.
- Prefer deterministic output so the graph does not jump between refreshes.

## Gitamine Behavior Baseline

Gitamine builds a repository topology before graph layout:

- `parents`: commit SHA to ordered parent SHAs.
- `children`: commit SHA to child SHAs.
- `shaToIndex`: commit SHA to its sorted row index.
- optional reference/stash metadata layered on top of commits.

Gitamine sorts commits with a temporal topological strategy:

- Start by sorting commits from newest to oldest by commit date.
- Run DFS over children before adding the current commit.
- Store the resulting list as the visual commit order.
- Rebuild `shaToIndex` from that order.

Gitamine's graph positions use a grid:

- `i`: row coordinate.
- `j`: lane/column coordinate.
- one commit per row.
- an extra synthetic `index` node at row `0`, lane `0`, connected to `HEAD`.
- real commits start at row `1`.

Gitamine's lane algorithm keeps an active branch array:

- Active lanes are either a commit SHA or empty.
- The synthetic `index` lane starts at column `0`.
- A commit can replace one branch child when that child uses the commit as first parent.
- If it cannot replace a child, it is inserted near an existing child lane.
- Empty lanes are reused when possible without shifting other active lanes.
- If no acceptable empty lane exists, a new lane is appended.
- Non-replaced branch children are removed from active lanes.
- Root commits are removed from active lanes after placement.

Gitamine classifies children by parent order:

- Branch child: this commit is the child's first parent.
- Merge child: this commit is not the child's first parent.

Gitamine avoids merge-edge overlaps by tracking active columns:

- It computes forbidden lane indices from merge children.
- A commit must not be placed in a forbidden lane.
- Active node sets are updated as commits are processed.
- A priority queue removes active-node tracking once the relevant parent span has passed.

Gitamine edge semantics:

- Edges connect every positioned commit to every positioned parent.
- First-parent edges are `Normal`.
- Non-first-parent edges are `Merge`.
- Rendering can choose different paths/colors for normal versus merge edges, but the backend should preserve the edge type.

Gitamine renderer details that are not backend semantics:

- Branch color palette.
- Canvas row and column pixel offsets.
- Dashed synthetic index node/edge styling.
- Visible-range canvas optimization.

## Research Questions

- What graph fixtures are needed to prove GitGui matches Gitamine behavior?
- Should GitGui include the synthetic `index` node in backend graph data, or should the Svelte renderer synthesize it from `HEAD`?
