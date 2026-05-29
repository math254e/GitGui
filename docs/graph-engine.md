# Graph Engine Notes

This document is a living knowledge base for future commit graph work.

## References

- Gitamine is a useful reference for graph layout ideas, especially lane assignment and edge routing.
- GitGui should not reproduce Gitamine's UI. The goal is to learn from graph layout techniques and build an implementation that fits this application.

## Terminology

- DAG: Git history is a directed acyclic graph.
- Commit node: A visual representation of a Git commit.
- Parent edge: A connection from a commit to one of its parents.
- Lane: A stable horizontal graph position used to reduce visual crossings.

## Future Data Structures

```rust
pub struct GraphCommit {
    pub hash: String,
    pub lane: usize,
}

pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub points: Vec<(f32, f32)>,
}
```

## Edge Routing Ideas

- Assign lanes from newest to oldest commits.
- Keep first-parent history visually stable.
- Route merge edges around active lanes where possible.
- Prefer deterministic output so the graph does not jump between refreshes.

## Research Questions

- How should lane reuse work after branches merge?
- How much layout work should happen in Rust versus the renderer?
- What is the minimal graph data needed for smooth Svelte rendering?
