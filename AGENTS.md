# GitGui

GitGui is a modern Git desktop and web client. Its target stack is SvelteKit,
TypeScript, Electron, Rust, and the installed Git executable.

The frontend/backend/desktop/remote architecture follows T3 Code as closely as
practical. Translate T3's Node server to the Rust `gitgui-server` and its React
integration to Svelte. Use Electron in the same architectural role as T3 Code.

Do not copy T3's product, agent, thread, or VCS behavior. Git operations and
repository UX remain GitGui-owned.

## Architecture state

The Electron/client-runtime migration is complete. `apps/web` is the SvelteKit
client, `apps/desktop` is the Electron shell, and the Rust workspace contains
the standalone backend and Git core. Keep future changes within these target
boundaries.

## Working principles

Prefer the smallest implementation that preserves the selected architecture.

Keep complexity at system boundaries:

- Rust owns Git, repositories, authentication, and server state.
- The shared client runtime owns environments, sessions, and reconnects.
- Svelte renders structured state and user interaction.
- Electron owns desktop lifecycle, native integration, local server supervision,
  protected credentials, and SSH.
- The protocol remains the common boundary for local and remote servers.

Preserve existing work. Make focused changes and avoid unrelated cleanup.

## T3 Code source of truth

Before changing workspace structure, client/server boundaries, environments,
remote connectivity, authentication, reconnect behavior, Electron lifecycle,
or SSH, inspect the current local checkout:

```text
D:\GitHub\PictureTagingApp.references\t3code
```

Start with:

- `docs/internals/workspace-layout.md`
- `docs/internals/connection-runtime.md`
- `docs/internals/remote.md`
- `docs/internals/environment-auth.md`
- `apps/desktop`
- `packages/client-runtime`
- `packages/ssh`

Do not rely on memory when the checkout can answer a question. Copy applicable
concepts, terminology, layering, lifecycle, and tests closely. If GitGui needs
to diverge, document the concrete reason rather than silently redesigning the
system.

T3 Code is not the architecture source for Git commands, Git graph behavior,
branch workflows, or repository product design.

## Glossary

- **you** — The coding assistant reading this file and changing GitGui.
- **we / us / me / I** — The people building and maintaining GitGui.
- **user** — A person using the GitGui application.
- **client** — The SvelteKit UI and shared TypeScript client runtime.
- **desktop shell** — Electron main/preload and desktop-only services.
- **server** — The standalone Rust `gitgui-server` process.
- **host** — A machine running a GitGui server and exposing repositories.
- **environment** — One running backend using one persistent state directory.
- **EnvironmentId** — Stable UUID issued and persisted by that backend.
- **connection target** — A strategy for reaching an environment.
- **connection profile** — Non-secret settings for a target.
- **connection credential** — Secret authentication material.
- **connection registration** — A client's durable known-environment record.
- **prepared connection** — Temporary resolved endpoint/auth information.
- **RPC session** — One live authenticated HTTP/WebSocket connection.
- **environment supervisor** — Sole retry/session owner for one environment.
- **environment registry** — Catalog of registrations and scoped supervisors.
- **repository catalog** — Server-owned repositories available on one host.
- **protocol** — Typed JSON request, response, event, and auth contracts shared
  by clients and servers.

## Fixed target architecture

- SvelteKit and TypeScript are the client stack.
- Electron is the desktop shell.
- Rust owns Git domain behavior and the backend.
- The installed `git` executable supplies Git behavior.
- `gitgui-server` must run without Electron.
- Electron manages the primary local server; it is not another backend.
- Normal GitGui requests go directly from the client runtime to the selected
  server over HTTP/WebSocket, never through Electron IPC.
- `crates/gitgui-protocol` is the canonical wire contract.
- TypeScript server contracts are generated from Rust definitions.
- Electron bridge contracts are separate from Git RPC contracts.
- The server owns repository catalogs, filesystem access, and shared host state.
- The client owns tabs, recents, active selection, and layout per environment.
- Direct remote and Tailscale connections are ordinary authenticated endpoints.
- Electron owns SSH setup; the Svelte client sees a forwarded normal endpoint.
- Relay/control-plane infrastructure is deferred until concretely required.

## Client runtime architecture

Follow T3 Code's layering:

```text
EnvironmentRegistry
  -> EnvironmentSupervisor
     -> ConnectionDriver
        -> ConnectionResolver
        -> RpcSessionFactory
```

Rules:

- The backend-generated `EnvironmentId`, not a URL hash, identifies an
  environment.
- Use primary, bearer, and SSH connection targets initially.
- Tailscale uses the bearer/direct target; “hosted web” is a client surface,
  not a target type.
- The resolver prepares endpoint/auth information.
- The driver and session factory perform one attempt and never retry.
- The supervisor is the only retry owner.
- Transient failures retry indefinitely with capped backoff.
- Auth, permission, invalid configuration, and incompatible protocol failures
  block until external state changes.
- Offline state releases transport without consuming retry attempts.
- Foreground/wakeup probes active sessions.
- A replacement session advances an environment generation.
- Queries revalidate, subscriptions switch, and mutations resolve the current
  session after a generation change.
- Explicit environment removal disposes registration, credentials, session,
  supervisor, cache, and client workspace state.

Implement the shared runtime as framework-independent TypeScript. A thin Svelte
store/context adapter is mounted once at the application root. Routes and
components must not own sockets, retries, credentials, Electron detection, or
SSH behavior.

Use plain TypeScript lifecycle primitives initially: `AbortController`, explicit
disposables, serialized async operations, and observable stores. Do not add
Effect solely to match T3's implementation library; copy the boundaries,
semantics, and applicable tests.

## Authentication and transport

Loopback is not authentication. Local and remote backends use the same session
model.

- Electron creates the primary bootstrap credential.
- Pass it to Rust through a dedicated inherited pipe/file descriptor, not a
  command argument or log.
- Exchange bootstrap/pairing credentials over HTTP for scoped bearer sessions.
- Use short-lived, single-use WebSocket tickets in WebSocket URLs.
- Authorize every RPC method against explicit GitGui scopes.
- Never expose durable tokens in URLs, logs, generated bundles, crash reports,
  or ordinary plaintext settings.

The target discovery/auth surface includes:

```text
GET  /.well-known/gitgui/environment
GET  /health
GET  /ready
POST /oauth/token
GET  /api/auth/session
POST /api/auth/websocket-ticket
GET  /ws
```

The environment descriptor carries stable identity, label, server/protocol
versions, platform/architecture, capabilities, authentication methods, and
advertised endpoints.

## Electron boundary

Electron main owns:

- secure BrowserWindow and custom application-origin setup;
- local Rust binary discovery, packaging, start, readiness, restart, and stop;
- bootstrap delivery and primary registration;
- protected credential and connection-catalog persistence;
- native dialogs, deep links, updates, and desktop lifecycle;
- SSH discovery, prompts, remote server setup, tunnels, and restoration.

Use secure renderer defaults:

- `contextIsolation: true`
- `nodeIntegration: false`
- renderer sandbox enabled
- bundled narrow preload bridge
- explicit origin/navigation validation

Expose typed capabilities such as primary bootstrap, connection registrations,
protected credentials, folder selection, and SSH setup. Do not expose Node,
generic filesystem access, arbitrary process execution, unrestricted IPC, or
Git operations.

## SSH behavior

Adapt T3 Code's desktop-managed SSH flow:

1. Resolve/connect using system OpenSSH configuration and known hosts.
2. Handle host-key, password, and passphrase prompts through Electron.
3. Detect, launch, or reuse a remote `gitgui-server` bound to loopback.
4. Open a local port forward.
5. Check readiness and stable environment identity.
6. Return ordinary local HTTP/WebSocket endpoints to the connection resolver.
7. Restore the SSH bridge before the supervisor creates a replacement session.

Initially the remote server may be required on `PATH`. Later binary provisioning
must remain behind the same SSH runner abstraction. Track ownership and stop
only remote server processes GitGui started and owns.

## Target workspace

```text
apps/web/                     SvelteKit client and Svelte adapters
apps/desktop/                 Electron main, preload, and native services
packages/contracts/           generated protocol and desktop bridge types
packages/client-runtime/      browser-safe connection runtime
packages/ssh/                 Electron/Node SSH implementation
packages/shared/              narrow TypeScript utilities
crates/gitgui-core/           Git execution, parsing, and domain logic
crates/gitgui-protocol/       canonical Rust contracts and generation
crates/gitgui-server/         standalone Axum backend
docs/                         architecture, plans, and domain design
```

The target paths above are the active workspace layout. Do not reintroduce a
second desktop shell or root-level client implementation.

## Current run modes

Before starting Vite, Electron, `gitgui-server`, or any development process,
check whether the user already has a development session, including an
attached shared preview. Reuse it. Do not start a second stack unless
explicitly asked or no reusable session exists.

### Current desktop development

```sh
npm run dev
```

This starts the Electron development stack and its managed Rust server.

### Browser client and separate server

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

### Combined browser mode

```sh
npm run web:serve
```

Open `http://127.0.0.1:3774`.

### Standalone server

```sh
cargo run -p gitgui-server -- --port 3774
```

Useful current options include:

```sh
cargo run -p gitgui-server -- --port 3774 --repository <path>
cargo run -p gitgui-server -- --data-dir <path>
cargo run -p gitgui-server -- --web-dir <path>
```

Use isolated data directories for persistence and migration experiments.

## Development commands

- `npm run check` — current SvelteKit and TypeScript validation.
- `npm run build` — current frontend production build.
- `cargo check --workspace` — Rust workspace validation.
- `npm run protocol:generate` — regenerate TypeScript protocol types.
- `git diff --check` — whitespace and patch validation.

Commands and paths must be updated when workspace migration lands. Do not invent
future commands in user-facing docs before they exist.

## Change guidance

When changing distributed architecture:

1. Read the applicable current T3 sources.
2. Identify the T3 concept and exact GitGui translation.
3. Preserve the one-client/one-server protocol boundary.
4. Record any concrete divergence.
5. Add lifecycle/failure tests, not only success-path tests.
6. Update architecture documentation in the same change.

When changing the protocol:

1. Update Rust definitions in `crates/gitgui-protocol`.
2. Run `npm run protocol:generate`.
3. Update server dispatch and client usage.
4. Verify compatibility, authorization, Rust, and frontend checks.

When changing server lifecycle behavior, verify cold start, readiness timeout,
crash, reconnect, shutdown, and process ownership.

When changing client connection behavior, verify transient retry, blocked
failure, offline transitions, foreground wakeup, generation replacement,
explicit removal, and at least two independent environments.

When changing repository behavior, consider unusual paths, inaccessible
repositories, malformed Git output, large output, and partial refresh failures.

When changing UI, keep shared code independent of Electron imports so hosted
web remains buildable.

## Pull requests

- Do not open, merge, or publish a pull request unless explicitly requested.
- Use concise conventional commit titles, such as
  `fix(server): preserve repository state after restart`.
- Keep one concern per pull request.
- Explain the problem, implementation, verification, limitations, and follow-up.
- Include before/after screenshots for visual changes.
- Include a short recording for material motion or interaction changes.
- Update architecture/protocol documents with relevant boundary changes.
- Do not hide unrelated work inside a feature or fix.

## Safety

- Inspect `git status` before making changes.
- Preserve unrelated changes.
- Do not use destructive `reset`, `checkout`, or `clean` operations unless the
  user explicitly requests them.
- Do not kill processes by name or pattern.
- Do not expose bootstrap tokens, bearer credentials, WebSocket tickets, or SSH
  secrets in logs, arguments, bundles, settings, or screenshots.
- Verify exact targets before deleting migration files or directories.
- Treat repository paths, Git output, protocol messages, remote endpoints, SSH
  responses, and persisted metadata as untrusted input.

## Style

Prefer clear names, small functions, and explicit ownership. Comments should
explain why a boundary or non-obvious lifecycle rule exists.

Keep Svelte components focused on presentation and interaction. Keep Git,
connection, authentication, and protocol decisions out of shared UI code.

If an existing implementation conflicts with the target architecture, call out
that migration state before weakening the target boundary.
