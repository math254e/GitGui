# Architecture

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
