# GitGui architecture

## Target shape

GitGui uses the same fundamental process boundary as T3 Code, translated from Node/React to Rust/Svelte:

```text
                           one HTTP/WebSocket connection
SvelteKit client runtime  <----------------------------->  Rust gitgui-server
        ^                                                        |
        |                                                        v
        |                                                   gitgui-core
        |                                                        |
        |                                                        v
        |                                                installed git + filesystem
        |
Electron main process
  - loads the web client
  - supervises the primary local server
  - stores desktop credentials and connection metadata
  - manages SSH sessions and port forwards
  - owns native dialogs, lifecycle, and updates
```

The Rust server is the application backend. Electron is a thin desktop host, not a second backend and not a proxy for ordinary repository traffic. The Svelte client never runs Git commands or accesses repositories directly.

The desktop shell opens the application at the root of its `gitgui://` scheme.
The path belongs to the client router.

This is the implemented repository architecture. Electron is the only desktop
shell; the Rust server remains independently runnable and the browser client
uses the same connection runtime without Electron.

## Source of truth

For frontend/backend separation, Electron responsibilities, environments, connection supervision, authentication, reconnect behavior, and SSH, inspect the current local T3 Code checkout before designing or changing those systems:

```text
D:\GitHub\PictureTagingApp.references\t3code
```

The primary references are:

- `docs/internals/workspace-layout.md`
- `docs/internals/connection-runtime.md`
- `docs/internals/remote.md`
- `docs/internals/environment-auth.md`
- `apps/desktop`
- `packages/client-runtime`
- `packages/ssh`

Copy T3 Code's concepts, terminology, layering, and infrastructure where they apply to these concerns. Translate its server implementation to Rust and its UI integration to Svelte. Do not copy its product model or VCS implementation; GitGui's Git behavior is designed separately.

## Ownership boundaries

### Rust server

`gitgui-server` runs independently of Electron and owns:

- stable backend/environment identity;
- authentication and authorization;
- the repository catalog and filesystem paths;
- protocol request dispatch and ordered events;
- repository watching and cache invalidation;
- serving the hosted client when configured;
- readiness, health, version, and capability reporting.

### Rust Git core

`gitgui-core` owns:

- execution of the installed Git executable;
- repository discovery and validation;
- parsing untrusted Git output;
- status, history, diff, graph, branch, remote, and mutation behavior;
- domain caches that are valid within one backend environment.

### Protocol

`gitgui-protocol` is the canonical wire contract. Rust types generate the browser-safe TypeScript contracts consumed by the client. Desktop IPC contracts are separate because they describe Electron capabilities, not Git RPC.

RPC responses may complete out of order and always echo the request ID. The
Rust server bounds concurrent reads and prefetch separately, preserves
per-repository mutation/preview order, and retains the existing global
repository locks. Read cancellation is an optional `rpc.cancel` capability on
the same authenticated socket. See [connection runtime](connection-runtime.md#concurrent-request-lifetime)
for admission limits, cancellation, and disconnect ownership.

### Svelte client

The client owns presentation and client-local workspace state:

- open tabs and ordering;
- active environment and repository selection;
- recents and layout preferences;
- query cache and optimistic UI state;
- rendering and user interaction.

It reaches Git and repository state only through the shared client runtime. Components and routes do not own sockets, retries, credentials, or SSH behavior. Desktop-only settings consume only the narrow typed preload capabilities.

#### Routing

The client is a SvelteKit single-page application. The URL selects what is on
screen and the client workspace owns which repositories are open.

```text
/                          Repositories home: the server catalog
/repo/[repositoryId]       One repository workspace
/new                       Create a repository
/settings                  Redirects to /settings/general
/settings/general          General preferences
/settings/appearance       Themes
/settings/connections      Environments, Git, and SSH
```

The repository identifier is the backend-issued id. The environment is not part
of the URL; it stays a client setting under Settings → Connections.

Every shell answers an unknown path with the application shell, so no shell has
to understand a route:

- the Rust server falls back from `ServeDir` to `index.html`;
- the Electron `gitgui://` handler falls back to `index.html` for any path
  that is not a static asset, and the window opens the scheme root;
- the development server serves the shell.

`apps/web/src/lib/workspace/` owns the client workspace: open tabs, the active
selection, pending Git actions, commit drafts, dialog state, and layout
preferences. The store is mounted once at the application root, next to the
connection runtime, and routes read it and call its actions. The route
vocabulary lives in `apps/web/src/lib/workspace/routes.ts` and the agreement
between the URL and the workspace is a pure function in
`apps/web/src/lib/workspace/repository-routing.ts`.

The desktop shell forwards a `gitgui://` deep link to the renderer.
`gitgui://repo/<repositoryId>` opens a repository and `gitgui://settings` opens
the settings; `apps/web/src/lib/workspace/deep-links.ts` resolves them.

The file viewer uses `@pierre/diffs` for syntax-highlighted file contents and
virtualized diffs. Rust supplies the original and modified contents through the
existing file-diff RPCs; the viewer computes display hunks from those contents.
Hunks collapses unchanged context, Inline expands it in a unified view, and
Split expands it side by side. Both diff and file views support line wrapping.
The browser-only renderer is loaded after the Svelte component mounts and is
disposed when that component is removed.
The viewer copies T3 Code's diff theming: the resolved appearance selects
`pierre-light` or `pierre-dark` syntax highlighting with the Shiki WASM engine.
T3's shared surface stylesheet is injected into the renderer's shadow root,
with code and destructive tokens translated to GitGui's semantic palette.
GitGui uses Pierre's Git green for additions because its success alias also
represents update notifications and can be blue. Row tints are lighter than
T3's; gutter text, split dividers, selection, hunk expansion, and scrollbars use
the same code surface and theme roles. The overrides also apply on the shadow
host so inherited computed surface variables update with custom palette edits.
Separator heights and bottom padding stay paired with virtualizer metrics.
The toolbar adapts to the viewer's width and exposes keyboard focus states.
Loading, binary, empty, unchanged, and retryable error states share the code
surface. File view displays the original contents for deleted files.

### Electron

Electron owns desktop-only capabilities:

- locating, packaging, launching, supervising, and stopping the local Rust server;
- safely delivering the local bootstrap credential;
- exposing the primary environment registration to the renderer;
- encrypted credential and connection-catalog persistence;
- native folder dialogs and operating-system integration;
- SSH host discovery, prompts, remote server launch/reuse, tunnels, and restoration;
- desktop lifecycle, deep links, updates, and window management.

Normal GitGui HTTP/WebSocket requests go directly from the renderer's client runtime to the selected server. They do not pass through Electron IPC.

## Environment and connection model

An environment is one running GitGui backend using one persistent state directory. Its stable UUID `EnvironmentId` is generated and persisted by the backend, then returned in the environment descriptor and protocol welcome. CLI runs use a per-user data directory by default; `--ephemeral` is the explicit opt-out. Changing an address or rebuilding an SSH tunnel does not create a new environment identity.

The client stores connection information separately from backend identity:

- `ConnectionTarget` describes how an environment may be reached.
- `ConnectionProfile` stores non-secret user configuration.
- `ConnectionCredential` stores secret authentication material.
- `ConnectionRegistration` associates a known environment with target/profile data.
- `PreparedConnection` is the resolver's temporary, connectable result.

Initial targets mirror T3's useful connection categories:

- `PrimaryConnectionTarget` for Electron's managed local backend.
- `BearerConnectionTarget` for a directly reachable authenticated backend.
- `SshConnectionTarget` for an Electron-managed SSH bridge.

Tailscale is an ordinary directly reachable endpoint, normally represented by a bearer target. A relay target is added only when a relay actually exists. “Hosted web” describes a client surface, not a connection target.

## Client connection runtime

The browser-safe runtime follows T3 Code's layering:

```text
EnvironmentRegistry
  -> one EnvironmentSupervisor per known environment
     -> ConnectionDriver
        -> ConnectionResolver
        -> RpcSessionFactory
```

- `ConnectionResolver` converts a target into a prepared endpoint and authentication setup. For SSH it asks the Electron platform adapter to ensure the bridge.
- `ConnectionDriver` performs one connection cycle and reports preparation, opening, and synchronization progress.
- `RpcSessionFactory` creates exactly one HTTP/WebSocket session and never retries.
- `EnvironmentSupervisor` is the sole owner of retry, offline, blocked, wakeup, and replacement-session behavior.
- `EnvironmentRegistry` owns known registrations and one scoped supervisor per environment.

The core runtime should be framework-independent TypeScript. Svelte gets a thin store/context adapter mounted once at the application root. Electron and hosted browser behavior are supplied through platform adapters.

Supervisor state is explicit:

```text
desired, network, phase, stage, attempt, generation, lastFailure, retryAt
```

Required behavior:

- transient failures retry indefinitely with capped backoff;
- authentication, configuration, permission, and unsupported-version failures become blocked until external input changes;
- going offline releases the active session without consuming retry attempts;
- an involuntary disconnect retains the environment registration and cached UI state;
- foreground/wakeup probes an active session and reconnects if stale;
- a stable connection resets the retry counter;
- explicit environment removal disposes its supervisor, session, registration, credentials, cache, and client workspace state;
- queries revalidate when the session generation changes;
- durable subscriptions switch to the replacement session;
- mutations resolve the current session at execution time.

No route or component implements its own retry loop.

Repository filesystem watching lives in the Rust server. Read-authorized
sessions receive ordered `repository.changed` invalidations. The session-scoped
client workspace reloads status for working-tree edits and a snapshot for Git
metadata changes, retaining history identity for status-only updates. It also
owns recovery refreshes and subscription disposal. See
[repository watching](repository-watching.md) for batching, failure recovery,
compatibility, and verification. Electron remains outside this traffic.

## Authentication and transport

Loopback is not authentication. The local and remote protocols use the same authenticated session model.

A backend that was started without a bootstrap credential does not require
authentication. It advertises `development-anonymous` in its environment
descriptor and answers a client that presents no credential with an anonymous
session. The browser client uses that path when it has no credential and the
environment says authentication is not required; every other environment needs
a bootstrap or pairing grant.

Recommended bootstrap flow, adapted from T3 Code:

1. Electron creates an unguessable bootstrap credential.
2. Electron passes it to the Rust server through a dedicated inherited pipe or file descriptor, not command-line arguments or logs.
3. The client exchanges the bootstrap credential over HTTP for a scoped bearer session.
4. The client requests a short-lived, single-use WebSocket ticket.
5. Only that short-lived ticket appears in the WebSocket URL.
6. Every RPC method checks the session's scopes.

The target server surface includes:

```text
GET  /.well-known/gitgui/environment
GET  /health
GET  /ready
POST /oauth/token
GET  /api/auth/session
POST /api/auth/websocket-ticket
GET  /ws
```

The environment descriptor reports identity, label, server and protocol versions, platform, architecture, capabilities, supported authentication/session methods, and advertised endpoints.

Initial GitGui scopes should express GitGui permissions, for example:

- `repository:read`
- `repository:operate`
- `repository:manage`
- `access:read`
- `access:write`

The authentication architecture is copied from T3 where useful; the permission vocabulary is GitGui-specific.

## SSH-managed environments

SSH remains entirely behind the Electron platform boundary:

1. Resolve the SSH host using system OpenSSH configuration and known-host behavior.
2. Connect and satisfy host-key/password prompts through Electron-owned UI.
3. Detect, launch, or reuse a remote `gitgui-server` bound to remote loopback.
4. Open a local port forward.
5. verify readiness and the remote environment descriptor.
6. Return local HTTP/WebSocket endpoints and authentication material to the normal connection resolver.
7. Restore the bridge before the supervisor reconnects after a drop.

The Svelte client and GitGui RPC protocol contain no SSH-specific Git behavior. Initially, the remote binary may be required on `PATH`; managed binary provisioning can be added behind the same SSH runner abstraction later.

The SSH launcher records its remote PID, selected port, ownership marker, and
state directory under `~/.gitgui`. A surviving managed process can therefore be
reused after an Electron crash. Disconnect and orderly shutdown stop only a
process carrying GitGui's `managed` marker. Unknown host keys require an
Electron confirmation; changed host keys remain hard failures.

## Target workspace

```text
apps/
  web/                    SvelteKit application and Svelte adapters
  desktop/                Electron main process, preload, and native services
packages/
  contracts/              generated server contracts and Electron bridge types
  client-runtime/         framework-independent environment/connection runtime
  ssh/                    Electron/Node SSH discovery, launch, and tunnels
  shared/                 narrowly shared TypeScript utilities
crates/
  gitgui-core/             Git execution and domain behavior
  gitgui-protocol/         canonical Rust wire contracts and type generation
  gitgui-server/           standalone Axum backend
```

The JavaScript side uses npm workspaces and Rust uses a Cargo workspace. This is
the active layout; the former root SvelteKit and Tauri desktop trees are no
longer runtime paths.

## Desktop lifecycle

Electron enforces a single application instance, forwards validated `gitgui://`
deep links over the narrow preload bridge, and owns update checks and
installation. Packaged builds enable updates only when
`GITGUI_UPDATE_FEED_URL` is a credential-free HTTPS URL. The renderer receives
typed update state and cannot configure arbitrary feeds.

## Security invariants

- Treat repository paths, Git output, protocol input, and persisted metadata as untrusted.
- Do not place durable bearer credentials or bootstrap secrets in URLs, logs, command arguments, or generated frontend bundles.
- Keep `contextIsolation` enabled, `nodeIntegration` disabled, and Electron renderer sandboxing enabled.
- Expose a narrow, typed preload bridge; do not expose Node or generic IPC.
- Validate renderer origins and navigation targets.
- Bind remotely launched servers to loopback behind the SSH tunnel unless the user explicitly configures direct exposure.
- Authorize every server operation; do not rely only on connection establishment.
