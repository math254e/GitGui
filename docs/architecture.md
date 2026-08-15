# Architecture

> This document describes the currently implemented architecture. The migration target is specified in [t3-architecture-reference.md](t3-architecture-reference.md), with implementation tasks in [rearchitecture-plan.md](rearchitecture-plan.md).

GitGui is structured as a desktop UI over the system Git executable. The application does not implement Git storage, refs, merge logic, or object parsing itself.

## Frontend Responsibilities

- Render repository state
- Handle user input
- Present commit history and file changes
- Integrate future UI tools such as Monaco and graph rendering

## Backend Responsibilities

- Execute Git commands through the system `git` binary
- Parse machine-readable Git output
- Return typed data to the frontend
- Own repository state and future graph layout logic

## Data Flow

```text
SvelteKit
  -> Tauri invoke
  -> Rust command handler
  -> Git service
  -> Git CLI
```

The frontend calls Tauri commands such as `load_repository`. Rust validates the path, detects the repository root, loads status and commits, then returns a `RepositorySnapshot`.

## Future Graph Engine

The graph engine should live in Rust and emit frontend-friendly structures such as `GraphCommit` and `GraphEdge`. The UI should render those structures without knowing Git CLI details.

## Planned Direction

The current direct Tauri invocation path will move toward a T3-inspired client/host model. Rust remains the backend. A separate Rust GitGui server will expose HTTP/WebSocket transport, readiness, a typed protocol, ordered server pushes, and host/repository catalog state. Tauri remains the desktop shell that manages the local server, while a shared client runtime connects the SvelteKit UI to local or remote environments.

A hosted SvelteKit client and direct remote connections come before any relay. Convex is not selected for the relay and will only be reconsidered later for control-plane metadata.
