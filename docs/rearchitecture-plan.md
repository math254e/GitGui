# Electron and client/host architecture

## Status

Implemented. This document records the completed translation of the applicable
T3 Code architecture to GitGui. T3 was used as the source for process
boundaries, environments, connection runtime, Electron responsibilities, and
SSH flow. Git operations, repository state, graph behavior, and Git UX remain
GitGui-owned.

## Runtime boundary

```text
SvelteKit + client-runtime  <---- HTTP/WebSocket ---->  gitgui-server
                                                               |
                                                         gitgui-core
                                                               |
                                                    installed git/filesystem

Electron main/preload: local server, credentials, SSH, lifecycle, native APIs
```

There is one client-to-one-server session per environment. Electron is not an
application proxy and ordinary Git RPC never crosses Electron IPC.

## Workspace

```text
apps/web/                    SvelteKit client
apps/desktop/                Electron main, preload, native services
packages/contracts/          generated protocol and desktop bridge types
packages/client-runtime/    browser-safe connection/runtime state
packages/ssh/                system OpenSSH and tunnel implementation
packages/shared/             narrow shared TypeScript utilities
crates/gitgui-core/          Git execution and domain behavior
crates/gitgui-protocol/      canonical Rust wire contract and generation
crates/gitgui-server/        standalone Axum backend
```

## Environment and connection model

The server persists a stable `EnvironmentId`. A client registration stores the
target used to reach that backend, while credentials remain separate and are
stored by the desktop using OS-protected storage.

The client runtime layers are:

```text
EnvironmentRegistry
  -> EnvironmentSupervisor
     -> ConnectionDriver
        -> ConnectionResolver
        -> RpcSessionFactory
```

The session factory performs one attempt. The supervisor alone owns retries,
offline handling, blocked failures, foreground probes, replacement generations,
and disposal. Svelte receives a single root-mounted adapter and does not own
sockets, credentials, SSH, or retry loops.

Supported targets are primary/local, direct bearer, and desktop-managed SSH.
Tailscale is represented by the direct bearer target. Hosted web is a client
surface, not a backend target.

## Authentication

Electron passes the local bootstrap credential to the server through stdin,
never as an argument or log value. Clients exchange bootstrap or pairing
credentials for scoped bearer sessions over HTTP. WebSockets use short-lived,
single-use tickets, and the server checks explicit GitGui scopes on every RPC.

The server exposes readiness, environment discovery, token exchange, session,
ticket, and WebSocket endpoints. Loopback is not treated as authentication.

## Electron

Electron main starts and supervises the packaged or development Rust binary,
waits for its readiness signal, owns encrypted connection state, and shuts down
only processes it started. Preload exposes a narrow typed bridge for primary
bootstrap, connection registrations, credentials, folder dialogs, and SSH.
The renderer runs with context isolation, no Node integration, and sandboxing.

## SSH

The Electron-owned SSH service resolves system OpenSSH configuration, handles
interactive prompts, launches or reuses a loopback-bound remote
`gitgui-server`, creates a local forward, checks the descriptor, and returns a
normal HTTP/WebSocket endpoint. If the bridge drops, the resolver restores it
before the supervisor creates a replacement session. The renderer and protocol
contain no SSH-specific application behavior.

Managed remote PID, port, and ownership metadata survive an Electron crash.
The launcher reuses a live managed backend and only terminates servers carrying
its managed marker. Unknown host keys and password/passphrase requests are
handled through Electron prompts; changed host keys are rejected.

## Verification

The completed migration is covered by Rust workspace tests,
generated-contract checks, Svelte/TypeScript checks, web and Electron builds,
standalone readiness/authentication smoke tests, and inspection that no normal
Git RPC path uses Electron IPC. Runtime tests cover offline startup, capped
indefinite retry, blocked authentication, replacement generations, independent
environments, and complete removal. SSH and desktop tests cover ownership
markers, launch-result validation, deep links, and update-feed validation.
Future boundary changes must extend this failure-lifecycle coverage.
