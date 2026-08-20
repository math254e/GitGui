# GitGui

GitGui is a modern Git desktop GUI built with SvelteKit, Tauri, Rust, and the
installed Git executable.

The project is inspired by T3 Code's client/host architecture, but is not being
converted to T3's React, Electron, Node.js, or Effect stack.

## Working principles

Prefer the smallest architecture that makes behavior obvious.

Keep complexity at system boundaries:

- Rust owns Git and repository behavior.
- The client renders structured state.
- Tauri owns desktop lifecycle and native integrations.
- The protocol remains the shared boundary between clients and servers.

Avoid speculative infrastructure. Direct local and remote connections come
before relays or cloud control planes.

Preserve existing work. Make focused changes and avoid unrelated cleanup.

## Glossary

- **you** — The coding assistant reading this file and making changes to GitGui.
- **we / us / me / I** — The people building and maintaining GitGui. These are
  who you are talking to now.
- **user** — The person using the GitGui application.
- **client** — The SvelteKit UI and shared client runtime.
- **desktop shell** — The Tauri application providing native integrations and
  managing the local server.
- **server** — The standalone Rust `gitgui-server` process.
- **host** — A machine running a GitGui server and providing repository access.
- **environment** — A client-side connection configuration for a local or remote
  GitGui host.
- **project** — The GitGui codebase and workspace being changed.
- **repository** — A Git repository opened or exposed through GitGui.
- **workspace** — The project directory being edited, or the client-owned UI
  state for open repositories, depending on context.
- **repository catalog** — The server-owned list of repositories available on a
  host.
- **protocol** — The typed JSON request, response, and event contract shared by
  clients and servers.

## Architecture boundaries

The fixed technology boundary is:

- SvelteKit and TypeScript for the UI and hosted web client.
- Tauri for the desktop shell and native integrations.
- Rust for Git operations, repository state, protocol handling, and the server.
- The installed `git` executable for Git behavior.

Important ownership rules:

- The frontend must not execute Git commands directly.
- Rust owns Git execution, parsing, repository snapshots, and future graph logic.
- `crates/gitgui-protocol` is the canonical wire contract.
- TypeScript protocol types are generated into `src/lib/generated`.
- `gitgui-server` must run without Tauri.
- Tauri manages the local server process; it does not define a second backend.
- The server owns the host repository catalog.
- The client owns tabs, recents, active selection, and layout.
- Direct remote connections come before relay work.
- Do not replace SvelteKit, Tauri, or Rust with another application stack.

## Where code lives

- `src/` — SvelteKit routes, components, styling, and client runtime.
- `src/lib/client-runtime/` — connections, environments, transport, and reconnects.
- `src/lib/generated/` — generated TypeScript protocol types.
- `src/lib/components/` — repository and Git UI.
- `crates/gitgui-core/` — Git execution, parsing, domain logic, and caches.
- `crates/gitgui-protocol/` — canonical Rust contracts and type generation.
- `crates/gitgui-server/` — standalone Axum server and RPC dispatch.
- `src-tauri/` — desktop lifecycle, server management, dialogs, and packaging.
- `docs/` — architecture decisions, plans, and roadmap.

Read the architecture documents before changing process boundaries, protocol
ownership, or client/server responsibilities.

## Ways to run GitGui

Before starting Vite, Tauri, `gitgui-server`, or any other development process,
check whether the user already has a development session running, including an
attached shared preview. Reuse the existing session and its processes. Do not
start a second development stack unless the user explicitly asks for one or
confirms that no reusable session exists.

### Desktop development

Use the single development command for the full desktop app. It prepares the
server sidecar, starts the Vite frontend, launches Tauri, and lets Tauri start
and manage the local GitGui server:

```sh
npm run dev
```

The Tauri window loads the SvelteKit/Vite development server at:

```text
http://localhost:1420
```

For frontend-only work without the desktop shell, use:

```sh
npm run ui:dev
```

The UI may not have a GitGui server in this mode unless one is provided
separately.

### Browser client with a separate development server

Terminal 1:

```sh
npm run server:dev
```

Terminal 2:

```sh
npm run ui:dev
```

Open:

```text
http://localhost:1420/?server=http://127.0.0.1:3774
```

Use this when working on the browser client and Rust server independently.

### Combined browser mode

```sh
npm run web:serve
```

This builds the SvelteKit app and starts the Rust server, which serves the
compiled app and API from one origin.

Open:

```text
http://127.0.0.1:3774
```

The standalone server auto-detects `./build/index.html`. Use `--web-dir <path>`
or `GITGUI_SERVER_WEB_DIR` when the compiled frontend is elsewhere.

### Standalone Rust server

```sh
cargo run -p gitgui-server -- --port 3774
```

Useful options include:

```sh
cargo run -p gitgui-server -- --port 3774 --repository <path>
cargo run -p gitgui-server -- --data-dir <path>
cargo run -p gitgui-server -- --web-dir <path>
```

The server can run independently of the desktop shell. Be careful when binding
to non-loopback interfaces or using persistent data directories.

### Tauri development

`npm run dev` is the canonical desktop development command. The
`tauri:dev` script remains available as an explicit alias for tooling that
already calls it directly.

### Frontend preview

```sh
npm run build
npm run preview
```

This previews the compiled frontend. Repository functionality still requires a
reachable GitGui server unless the app is served by `gitgui-server`.

### Desktop packaging

```sh
npm run tauri:build
```

This prepares the release server sidecar, builds the frontend, and packages the
desktop application.

## Development commands

- `npm run check` — SvelteKit and TypeScript validation.
- `npm run build` — frontend production build.
- `cargo check --workspace` — Rust workspace validation.
- `npm run protocol:generate` — regenerate TypeScript types after protocol changes.
- `git diff --check` — whitespace and patch validation.

## Change guidance

When changing the protocol:

1. Update Rust definitions in `crates/gitgui-protocol`.
2. Run `npm run protocol:generate`.
3. Update server dispatch and client usage.
4. Run Rust and frontend checks.

When changing server lifecycle behavior, verify readiness, reconnect, shutdown,
and restart behavior.

When changing repository behavior, consider unusual paths, inaccessible
repositories, malformed Git output, and partial refresh failures.

When changing the UI, keep it independent of Tauri-only imports so the hosted
web client remains buildable.

## Pull requests

- Do not open, merge, or publish a pull request unless explicitly requested.
- Use concise conventional commit titles, for example:
  `fix(server): preserve repository state after restart`.
- Keep one concern per pull request.
- The pull request description should explain:
  - the problem;
  - the implemented change;
  - how it was verified;
  - any known limitations or follow-up work.
- UI changes should include before/after screenshots.
- Motion, timing, or interaction changes should include a short recording.
- Architecture or protocol changes should update the relevant documentation.
- Do not hide unrelated work inside a feature or bug-fix pull request.

## Safety

- Inspect `git status` before making changes.
- Preserve unrelated changes.
- Do not use `reset --hard`, `checkout`, or `clean` destructively unless
  explicitly requested.
- Do not kill processes by name or pattern.
- Do not expose bootstrap tokens or session credentials in logs, arguments,
  generated bundles, or committed files.
- Use isolated server data directories for persistence and migration experiments.
- Do not bake local development origins into hosted production behavior.
- Treat repository paths, Git output, protocol messages, and persisted metadata
  as untrusted input.

## Style

Prefer clear names, small functions, and explicit ownership.

Comments should explain why a boundary or non-obvious behavior exists.

Keep UI components focused on presentation and interaction. Keep Git and
protocol decisions out of shared UI code.

If an existing rule conflicts with the task, call out the conflict before
weakening the architectural boundary.
