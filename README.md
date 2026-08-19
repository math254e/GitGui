# GitGui

GitGui is a modern Git desktop GUI inspired by tools like GitKraken, built as a visual interface over the installed Git executable.

## Technology Stack

- Tauri for the desktop shell
- SvelteKit and TypeScript for the UI
- Rust for repository logic and Git command execution
- System Git CLI for all Git behavior

## Architecture

```text
SvelteKit UI (Tauri webview or browser)
  -> GitGui Rust server (same-origin HTTP + WebSocket)
  -> gitgui-core repository services
  -> Git CLI
```

The Rust server can serve the compiled SvelteKit application alongside its API and WebSocket. This gives GitGui the same local-web shape as T3 Code: one process and one origin for the browser UI and the machine-local Git host. The Tauri desktop app still uses the same server as its local backend.

The server-owned repository catalog is persisted when the server is started with `--data-dir` (the desktop app configures this automatically). Every client connected to that server sees the same catalog on the home page. Open repository tabs and their active selection remain client-local.

To run the complete desktop app, use the single development command:

```text
npm run dev
```

This starts the Vite frontend and Tauri desktop shell; Tauri starts and manages the local GitGui server for the desktop window. Use `npm run ui:dev` only when you intentionally want the frontend without the desktop shell.

While `npm run dev` is running, open `http://127.0.0.1:3774` in a regular browser. The Tauri-managed GitGui server redirects that request to the Vite client at `http://localhost:1420` with the local connection details, so the browser uses the same backend and repository catalog as the desktop window.

To run the local browser version from the repository root:

```text
npm run web:serve
```

Then open `http://127.0.0.1:3774`. The standalone server auto-detects `./build/index.html`; use `--web-dir <path>` or `GITGUI_SERVER_WEB_DIR` when the compiled web app lives elsewhere.

The development web commands register the current repository automatically. To expose a different repository, run the standalone server with one or more explicit `--repository <path>` arguments.

Rust owns repository detection, command execution, parsing, state shaping, commit loading, and future graph algorithms. The frontend renders structured data returned by Rust and never shells out to Git directly.

The commit graph engine is intended to match Gitamine's graph behavior as closely as practical while keeping GitGui's own visual layer.

## Current Status

The current application implements the repository viewer foundation:

- Open a repository by path
- Open repositories with the native folder picker
- Restore open repository tabs per client
- Detect the repository root
- Show the current branch and ahead/behind counts
- Show changed files from `git status --porcelain=v2 --branch`
- Show recent commit history from `git log --all`
- View changed files and commit files with Monaco-powered file and diff views

## Planned Features

- Gitamine-aligned commit graph rendering
- Mismerge-powered conflict resolution
- Commit, checkout, merge, and rebase workflows
