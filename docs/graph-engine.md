# Git Graph Engine

This document describes the current commit-graph architecture and the behavior
that future graph changes must preserve.

## Reference implementations

The layout behavior is based on Gitamine's temporal topological ordering and
straight-branch lane algorithm. GitGud is the reference for integrating a dense
graph into a desktop history table: one viewport-sized canvas, DOM-backed rows,
and rendering only the visible edge range.

Research baselines:

- `pvigier/gitamine@0f66a960b1e52a5e9faba2cb791e5dfddabb3a29`
- `zeuros/gitgud@202e2fc576a22689befb1f0d0308408070ac4678`

Useful upstream files:

- Gitamine `src/renderer/helpers/repo-wrapper.ts`
- Gitamine `src/renderer/helpers/commit-graph.ts`
- Gitamine `src/renderer/components/graph-canvas.tsx`
- GitGud `src/app/components/logs/logs.component.ts`
- GitGud `src/app/components/logs/logs.component.html`
- GitGud `src/app/components/logs/logs-canvas-drawer.ts`

Gitamine and GitGud are GPL-licensed projects. They are behavioral and
architectural references, not source dependencies. GitGui's implementation is
written independently in Rust and TypeScript and does not copy their source.

## Ownership and data flow

There is one canonical graph layout:

```text
installed Git -> Rust commit parser -> Rust graph engine -> protocol snapshot
                                                     -> Svelte row metadata
                                                     -> canvas renderer
```

- `crates/gitgui-core/src/git/graph.rs` owns ordering, lane assignment, edge
  classification, graph width, and the actual HEAD lane.
- `RepositorySnapshot.graph` carries those decisions through the existing
  protocol. No client-side topology is authoritative.
- `src/lib/components/GitGraph.svelte` joins graph positions to commit and ref
  metadata and owns selection, hover state, scrolling, and column sizing.
- `src/lib/git-graph/canvas-renderer.ts` turns graph coordinates into pixels. It
  does not assign rows or lanes.

The canvas is deliberately presentational. Moving topology back into Svelte
would create a second graph engine and can make rows, refs, HEAD, and edges
disagree with the server.

## Graph contract

```rust
pub struct CommitGraph {
    pub commits: Vec<GraphCommit>,
    pub edges: Vec<GraphEdge>,
    pub width: usize,
    pub head_lane: Option<usize>,
}

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

Rows are one-based because row zero is available to the client for a synthetic
working-tree/index node. Lanes are zero-based. `width` is the maximum allocated
lane count, including empty lanes retained for visual stability.

An edge runs from a child commit to a parent commit. The first parent is a
`Normal` edge; every additional parent is a `Merge` edge. Parents outside the
loaded history window are intentionally omitted.

`head_lane` is present only when the real status HEAD object exists in the
loaded graph. The client must use `status.headOid` and `head_lane` together; the
first visible commit is not necessarily HEAD.

## Commit ordering

The engine produces a deterministic temporal topological order:

1. It sorts candidates by descending commit timestamp and then ascending hash.
2. It builds child adjacency from the ordered parent lists.
3. It visits children before emitting their parent.
4. It uses an iterative traversal so a very deep linear history does not risk a
   call-stack overflow.

The timestamp is a preference, not a correctness rule. A child always appears
above its known parent even when clocks are skewed. Child adjacency uses first
parent, timestamp, and hash tie-breakers so equivalent input in a different
collection order produces the same graph.

## Lane assignment

The straight-branch algorithm maintains an array of active lane slots:

- A commit replaces the lowest usable first-parent child lane when possible.
- Otherwise it takes the nearest empty lane to a related child.
- Empty slots are retained and reused; removing a branch never shifts another
  active branch sideways.
- A root clears its lane after placement.
- When HEAD is part of the loaded history, lane zero is reserved by a synthetic
  index node until the HEAD commit replaces it. Disconnected roots therefore
  cannot displace HEAD.
- When HEAD is absent, the synthetic lane is not allocated and ordinary history
  begins in lane zero.

Merge children contribute forbidden lanes. Active edge spans record the lanes
that have become occupied while those spans are open, preventing a later merge
edge from passing through a commit node. Span expiry uses a min-priority queue,
avoiding a full retain-and-scan of every queued span for every graph row.

## Rendering

The history table keeps branch labels and messages as ordinary DOM content for
accessibility, selection, and text layout. A single high-DPI canvas overlays
only the graph column.

The canvas:

- is sized to the scroll viewport rather than the full repository history;
- is repositioned and redrawn as the history container scrolls;
- skips edges and nodes outside the viewport with a small overscan;
- renders normal edges primarily in the child lane and merge edges primarily in
  the parent lane;
- uses lane color as the strongest visual signal;
- renders merge commits with a center mark and stash commits as dashed squares;
- attaches the dashed working-tree node to the actual HEAD lane;
- redraws emphasis for selected and hovered commit rows.

The graph column grows to fit `graph.width`, while still respecting the user's
resized column width. Row height, lane spacing, and padding remain UI constants;
they are not protocol concerns.

## Required invariants and coverage

The Rust tests cover linear histories, forks and rejoins, first-parent edge
classification, lane reuse, skewed timestamps, deterministic input
permutations, disconnected roots, missing HEAD, octopus merges, and truncated
parents.

The shared invariant checks require:

- one unique graph row and position per loaded commit;
- every known child above its parent;
- every lane inside `graph.width`;
- no commit node inside the vertical segment used by a normal or merge edge.

When extending the engine, add the smallest DAG fixture that demonstrates the
new topology and run the invariant checks against it. Visual verification should
also cover scrolling, selection, a dirty working tree, and at least one merge.

## Intentional limits

- Stash metadata is layered onto graph commits by hash. Internal index and
  untracked-file helper commits are removed before graph layout, while the
  user-facing stash remains a dashed graph node without a Branch-column badge.
- The graph is computed for the commits loaded in the snapshot. Edges to history
  outside that set stop at the boundary.
- Canvas hit testing is unnecessary because each commit already has a full-width
  DOM row for pointer and keyboard interaction.
- The current renderer redraws the visible graph on scroll. If histories become
  large enough to require row virtualization, preserve the same backend graph
  contract and virtualize the DOM rows independently.
