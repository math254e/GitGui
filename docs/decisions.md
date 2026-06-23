# Architecture Decisions

## ADR-001: Use System Git

GitGui executes the installed `git` binary for all repository operations.

This keeps behavior aligned with Git itself and avoids introducing a second Git implementation such as libgit2, gitoxide, or a custom object parser.

## ADR-002: Rust Owns Repository Logic

Rust owns Git command execution, parsing, repository state, commit loading, and future graph generation.

The frontend consumes structured data from Tauri commands and does not execute Git commands directly.

## ADR-003: Implement the Graph Engine in Rust

Future graph layout code should be implemented in Rust and exposed as typed data to the frontend.

This keeps graph algorithms close to parsed repository data and allows the Svelte UI to focus on presentation.

## ADR-004: Treat Gitamine as the Graph Behavior Baseline

GitGui's commit graph should match Gitamine's graph behavior as closely as practical, including ordering, lane assignment, lane reuse, and merge edge routing semantics.

GitGui's visual layer may differ to fit this application's Svelte/Tauri interface.
