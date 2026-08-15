# Roadmap

## Phase 1

- Create Tauri, SvelteKit, TypeScript, and Rust project
- Execute Git through a Rust command service
- Detect repository roots
- Parse repository status
- Load commit history
- Render repository path, branch, changed files, and commits

## Phase 2

- Add native folder selection
- Improve status parsing and file grouping
- Add file detail views
- Add refresh and repository switching controls

## Phase 3

- Research Gitamine's graph implementation and document the behavior baseline
- Implement the first graph engine iteration based on Gitamine's graph semantics
- Render commit lanes and edges
- Add branch and checkout interactions

## Future Ideas

- Monaco file and diff viewing
- Mismerge conflict resolution
- Commit creation workflows
- Merge and rebase workflows
- Remote fetch, pull, and push operations

## Deferred Technical Work

These items are intentionally deferred while the project remains a personal read-only viewer:

- Verify and correct commit rename parsing and rename diffs, including quoted and unusual paths.
- Add pagination or bounded history loading for large repositories instead of reloading all history on every refresh.

## Client/Host Rearchitecture

The approved architecture reference is [t3-architecture-reference.md](t3-architecture-reference.md), with the detailed assignable implementation backlog in [rearchitecture-plan.md](rearchitecture-plan.md).

- Keep SvelteKit for the UI and hosted web client.
- Keep Tauri as the desktop shell.
- Keep Rust as the backend and Git implementation.
- Add a Rust HTTP/WebSocket server that Tauri starts and manages.
- Add a shared typed protocol and client runtime for local and remote environments.
- Start with direct client-to-remote connections; do not build the relay yet.
- Treat the hosted web client as another client surface, not as a second backend.
- Revisit a T3-style relay and any Convex control-plane usage later.

Current state as of 2026-08-15:

- The local desktop migration is complete through the installed-sidecar smoke gate.
- The Svelte UI now uses the same typed HTTP/WebSocket client boundary intended for remote hosts.
- Direct Tauri Git/workspace commands and duplicate desktop caches have been removed.
- Direct-remote pairing, TLS/WSS exposure, and hosted browser connection UX are the active next phase.
- The relay remains deliberately unimplemented.
