# T3-Inspired Architecture Reference for GitGui

Status: approved direction; reference architecture only.

This document records the parts of T3 Code's architecture that GitGui intends to copy. It does not replace GitGui's technology choices.

## Fixed GitGui technology boundary

GitGui remains:

- SvelteKit for the UI and hosted web client.
- Tauri for the desktop shell.
- Rust for the Git implementation and backend server.

The T3 Code references in this document are architectural references. GitGui is not being converted to Electron, Node.js, React, Effect, or T3's provider/agent product model.

## Locked implementation shape

The initial repository/process layout is:

```text
Cargo.toml                     Rust workspace
crates/gitgui-core             Git operations and domain logic
crates/gitgui-protocol         Canonical Rust wire types and method names
crates/gitgui-server           Standalone Rust HTTP/WebSocket server and CLI
src-tauri                      Tauri desktop shell and server process manager
src/lib/client-runtime         Shared SvelteKit connection runtime
src/lib/generated              TypeScript protocol types generated from Rust
```

The separately runnable `gitgui-server` process is the backend used both by the local desktop and by remote clients. Tauri packages, starts, observes, and stops that process; it does not define a second application protocol.

The network implementation is locked to Tokio, Axum, serde/serde_json, standard browser WebSockets, and tracing. JSON is the first wire format. Rust protocol types are canonical and TypeScript types are generated from them rather than maintained as a handwritten duplicate.

## T3 architecture we are copying

T3 Code separates the product into a client surface, a server runtime, a connection layer, and an optional relay/control plane:

1. A desktop application manages a local backend server.
2. The backend exposes a network API rather than making the UI own all backend lifecycle details.
3. A shared contract/RPC boundary keeps client calls, server handlers, and pushed events aligned.
4. The client has a connection runtime that understands environments, readiness, reconnects, credentials, and sessions.
5. The same client surface can connect to a local backend or a remote backend.
6. A hosted web client can be used independently of the desktop shell.
7. A relay is an additional connectivity layer, not a prerequisite for the direct client-to-host model.

That separation is the important idea for GitGui. The implementation language and UI stack are intentionally different.

## T3 source map

These are the T3 Code areas used as references:

| T3 area | What it demonstrates | GitGui interpretation |
| --- | --- | --- |
| Desktop main process | Desktop-owned server lifecycle, saved environments, local auth, exposure, and native integration | Tauri owns the local Rust server process, lifecycle, native dialogs, local bootstrap, and desktop storage adapters |
| Server package and CLI | A runnable backend that can serve a client independently of the desktop UI | A Rust `gitgui-server` binary can run locally or on a remote PC |
| Architecture overview | WebSocket server, readiness state, ordered server pushes, and a central coordinator | Rust HTTP/WebSocket host with explicit readiness, ordered events, and one request dispatcher |
| Contracts/RPC package | One canonical method/event contract used by client and server | Rust serde protocol plus a generated or manually synchronized TypeScript client contract; no Effect dependency |
| Client runtime | Connection drivers, environment registry, resolver, supervisor, onboarding, pairing, and credential storage | A SvelteKit-compatible GitGui client runtime with transport, environment, reconnect, pairing, and credential boundaries |
| Remote documentation | Direct pairing to a reachable backend, with hosted pairing metadata not proxying traffic | Direct remote connections are the first remote milestone; relay is deferred |
| Relay package | Separate authenticated infrastructure for cloud-mediated connectivity | Future independent service; not part of the first remote implementation |

Primary references: [T3 architecture overview](https://github.com/pingdotgg/t3code/blob/main/docs/architecture/overview.md), [T3 desktop entry point](https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/desktop/src/main.ts), [T3 RPC contracts](https://raw.githubusercontent.com/pingdotgg/t3code/main/packages/contracts/src/rpc.ts), [T3 client connection runtime](https://raw.githubusercontent.com/pingdotgg/t3code/main/packages/client-runtime/src/connection/index.ts), and [T3 remote model](https://github.com/pingdotgg/t3code/blob/main/REMOTE.md).

## GitGui target shape

```text
                         Local desktop
                  +-------------------------+
                  | SvelteKit UI in Tauri   |
                  |                         |
                  | Tauri desktop host     |
                  |  - starts Rust server  |
                  |  - readiness/lifecycle |
                  |  - native integrations |
                  +------------+------------+
                               |
                               | HTTP/WebSocket
                               v
                  +-------------------------+
                  | Rust GitGui server     |
                  |  - typed protocol      |
                  |  - request dispatcher  |
                  |  - ordered push bus    |
                  |  - host/repo catalog   |
                  |  - Git core            |
                  +------------+------------+
                               |
                 direct HTTP/WSS connection first
                               |
                               v
                  +-------------------------+
                  | Remote PC               |
                  | Rust GitGui server      |
                  +-------------------------+

                  Hosted SvelteKit web app
                               |
                               +--> direct remote server first
                               +--> future GitGui/T3-style relay
```

## Component responsibilities

### SvelteKit client runtime

The UI should not need to know whether it is talking to a local server or a remote server. A small client runtime should own:

- connection configuration and environment identity;
- HTTP and WebSocket transport;
- server readiness and welcome handshake;
- request/response correlation;
- ordered server events and subscriptions;
- reconnect and connection-state transitions;
- pairing and credential exchange;
- a server capability/version result used by the UI;
- an adapter boundary so Tauri-only APIs never enter the hosted web build.

### Tauri desktop shell

Tauri remains the native application boundary. Its new architectural role is to manage the local Rust server and provide desktop-only capabilities:

- start or attach to the local server;
- wait for a health/readiness endpoint;
- provide a local bootstrap credential/session;
- stop or restart the server with the desktop lifecycle;
- expose native folder selection and OS integration;
- persist non-secret environment metadata;
- use secure OS storage for secrets where available;
- package the SvelteKit client and Rust server together.

Tauri should not become the shared remote protocol. The protocol belongs to the Rust server and client runtime so the hosted web client can use it too.

### Rust GitGui server

The server should be usable without Tauri. It owns:

- HTTP routes and WebSocket sessions;
- protocol validation and dispatch;
- readiness/health state;
- ordered push events;
- host-level configuration and repository catalog;
- Git operations and filesystem access;
- authentication/session checks;
- a headless command-line entry point for remote installation and operation.

### Repository and workspace ownership

The Rust server owns the repository catalog for its machine: canonical roots, stable repository IDs, allowed-root policy, and later catalog persistence. It computes snapshots and owns in-memory Git/diff caches.

Each client owns its own workspace presentation per environment: open tabs and order, recent repository IDs, active tab, and layout preferences. Selected commits/files remain UI memory. The server does not store a globally active repository because multiple clients may use the same host independently.

The local desktop folder picker supplies a host-local path to an administrative `repositories.open` call. Hosted and direct-remote clients initially select repositories already exposed by `repositories.list`; a browser file picker cannot choose paths on the remote host.

### Future relay

The relay is a later transport option between a client and a remote Rust server. It should not be mixed into the first direct-connection design. Its future responsibilities may include authenticated rendezvous, connection brokering, and byte forwarding, but its data path, trust model, hosting, and cost need an explicit design decision first.

Convex is not selected as the relay implementation. It may be evaluated later for control-plane metadata, but the relay decision is deferred.

## Protocol shape

The first public protocol has one canonical Rust definition:

```text
client -> server: request { id, method, params }
server -> client: response { id, ok, result | error }
server -> client: event { sequence, type, payload }
server -> client: welcome { protocol_version, server_id, capabilities }
```

The initial serialization format is JSON. The protocol requirements are:

- stable request IDs;
- explicit success and error envelopes;
- typed method parameters and results;
- typed pushed events;
- monotonic event sequence values per session or host;
- protocol and server version information;
- capability negotiation for future clients;
- clear authentication and pairing boundaries.

The first routes are:

```text
GET /health
GET /ready
GET /info
WS  /ws
```

HTTP owns process health, readiness, and bootstrap server information. JSON request/response RPC and ordered server events use the WebSocket connection.

## First vertical slice

The first end-to-end migration slice is deliberately narrow:

1. Start `gitgui-server` independently.
2. Report readiness over HTTP.
3. Establish a WebSocket connection and send a welcome message.
4. Implement `server.get_info`, `repositories.list`, and `vcs.status`.
5. Have Tauri start or attach to the local server.
6. Have the SvelteKit client runtime connect and render a repository list and status.

Pairing, remote exposure, Git mutations, hosted deployment, and relay work begin only after this local slice works.

## Read-only migration surface

After the first status slice, the current desktop viewer migrates through these server methods:

```text
repositories.open
repositories.get_snapshot
repositories.refresh
vcs.commit_files
vcs.commit_file_diff
vcs.working_tree_file_diff
vcs.prefetch_commit_files
vcs.prefetch_commit_diffs
```

`repositories.refresh` returns per-repository success or error results so one inaccessible repository does not erase every open tab. Prefetch calls are performance hints only; normal reads remain correct without them.

The existing Tauri `workspace-state.json` is migrated once by resolving its paths through idempotent `repositories.open` calls, then storing returned repository IDs in client metadata. Legacy snapshots are ignored and recomputed. The old file remains as a fallback until the new desktop flow survives restart and the former Tauri workspace commands can be removed.

## Direct remote model for the first release

The initial remote experience does not need a relay:

1. Install or run `gitgui-server` on the remote PC.
2. The remote server listens on a user-selected interface and port.
3. The local desktop or hosted SvelteKit client adds the remote endpoint.
4. A one-time pairing code or invitation is exchanged over the direct connection.
5. The client receives a scoped session credential and stores it through its credential adapter.
6. The client uses HTTP/WebSocket directly to the remote Rust server.

This requires deliberate transport security and exposure rules. Local development may use HTTP on a private network, but the product design must leave room for HTTPS/WSS and certificate handling before public deployment.

## Immediate local security boundary

Loopback binding is the development default, but loopback is not authentication. Before the desktop webview is cut over to repository RPCs, the local server must require an unguessable bootstrap session issued by Tauri and restrict accepted browser origins.

Repository paths are administrative inputs. Read operations accept server-issued repository IDs, never arbitrary roots. `repositories.open` is a host-administration capability. Repository-relative file paths must reject absolute paths and traversal, and revision-like inputs must not be accepted as Git command options.

## Explicitly not copied from T3 Code

- Electron as the desktop shell.
- Node.js as the GitGui server runtime.
- React as the UI framework.
- Effect as the RPC/schema implementation.
- T3's AI provider, agent, terminal, or project-domain behavior.
- T3's exact monorepo/build tooling requirements.
- T3 Connect's hosted relay as part of the first remote milestone.

## Decision summary

| Decision | Outcome |
| --- | --- |
| Desktop shell | Keep Tauri |
| UI | Keep SvelteKit |
| Backend/server | Rust |
| Local architecture | Tauri manages a local Rust server |
| Remote architecture, first | Direct client-to-remote Rust server |
| Hosted web architecture | Same SvelteKit client, no Tauri dependency |
| Protocol | Shared typed HTTP/WebSocket boundary |
| Relay | Future design and implementation phase |
| Convex | Not chosen for relay; possible future control-plane evaluation |
| Automated tests | Intentionally deferred for now; use build/typecheck/manual smoke checks during implementation |
