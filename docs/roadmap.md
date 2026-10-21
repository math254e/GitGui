# GitGui roadmap

## Current position

The frontend/backend/desktop migration is complete. GitGui now has:

- a standalone Rust `gitgui-server` and Git-owned `gitgui-core`;
- a canonical Rust protocol with generated TypeScript contracts;
- an `apps/web` SvelteKit client;
- a framework-independent `packages/client-runtime` environment registry,
  resolver, session factory, driver, and supervisor;
- an `apps/desktop` Electron shell with secure preload, local server
  supervision, protected credential storage, and lifecycle management;
- `packages/ssh` for Electron-managed remote server launch and port forwarding;
- one HTTP/WebSocket session model for primary, bearer/direct, Tailscale, and
  SSH-prepared environments.

The previous desktop shell and root-level SvelteKit layout are removed. The normal
development command is now `npm run dev`.

## Verified migration gates

- Rust workspace tests and checks pass.
- Protocol generation and all TypeScript/Svelte checks pass.
- Web and Electron production builds pass.
- Standalone server readiness and descriptor discovery pass.
- Bootstrap-to-bearer exchange, authenticated session inspection, and
  single-use WebSocket ticket issuance pass.
- Electron uses direct renderer-to-server HTTP/WebSocket traffic; Git RPC does
  not cross preload IPC.
- Runtime retry, blocked, offline, wakeup, generation, and removal behavior is
  centralized in the environment supervisor/registry.
- Direct and SSH onboarding verifies discovery, authentication, and a live RPC
  session before saving the registration.
- Environment IDs are persisted UUIDs, including standalone CLI runs by
  default, and switching environments cannot expose another environment's live
  workspace.
- SSH lifecycle tests cover persisted managed ownership/reuse contracts, and
  desktop tests cover deep-link and secure update-feed validation.

## Recent product work

- Working-tree hunk stage/unstage, reviewed discard, and commit amendment are
  complete; see [working-tree workflow](working-tree-workflow.md).
- Native repository watching now sends scoped status/snapshot invalidations.
- History rows are virtualized, canvas edges use a viewport index, and refreshes
  preserve history identity and commit scroll anchors. See
  [repository watching and history scale](repository-watching.md).

## Next product work

Continue GitGui-owned Git product development independently of the T3-shaped
transport architecture:

- complete repository mutations with confirmation and progress behavior;
- continue graph interaction improvements and measure history loading/transfer
  before introducing pagination;
- expand branch, tag, remote, stash, worktree, submodule, and conflict flows;
- harden unusual paths, malformed Git output, large repositories, and partial
  failures.

## Deferred until justified

- relay or cloud control-plane infrastructure;
- multi-user collaboration semantics beyond scoped access;
- replacing the installed Git executable with a Git library;
- adopting React or T3's product/VCS model;
- adopting Effect solely for architectural resemblance;
- managed remote binary provisioning beyond the current `PATH`-based SSH flow.
