# GitGui Rearchitecture Implementation Plan

Status: local desktop gate complete; direct-remote gate in progress.

This is the assignable task plan for moving GitGui toward a T3-inspired client/host architecture while keeping SvelteKit, Tauri, and Rust. It is intentionally implementation-oriented. It does not authorize a relay build yet.

Reference architecture: [t3-architecture-reference.md](t3-architecture-reference.md).

## Implementation checkpoint — 2026-08-15

Completed:

- Waves 0–4: architecture boundaries, Rust workspace/core, canonical protocol, standalone server, server-owned persistent repository catalog, read-only Git RPCs, generated TypeScript contracts, browser-safe client runtime, local bootstrap security, Tauri process management, one-time legacy migration, Svelte UI cutover, and removal of the old direct-Tauri Git/workspace implementation.
- Gate A: the standalone host passes manual WebSocket/RPC and stop/restart persistence smoke checks.
- Gate B: the desktop host passes development and installed-MSI sidecar startup/readiness/shutdown smoke checks. The packaged server is installed beside the desktop executable, and bootstrap credentials are not exposed in command-line arguments.

In progress:

- Wave 5 / Gate C: direct-remote endpoint configuration, pairing, durable remote authentication, TLS/WSS exposure, compatibility handling, and reconnect UX.

Still deferred:

- Wave 6 hosted deployment until the direct-remote security boundary is usable.
- Wave 7 relay and any Convex decision.
- Automated test expansion, per the current project direction.

## Scope and guardrails

### In scope

- A reusable Rust GitGui server that can run under Tauri or independently on a remote PC.
- A SvelteKit client runtime that connects to local and remote servers through one protocol.
- Tauri-owned local server lifecycle and desktop integrations.
- Direct remote pairing and direct HTTP/WebSocket operation.
- A hosted SvelteKit client that can connect to a direct remote server.

### Deferred

- T3-style relay implementation.
- Convex selection or implementation for relay/control-plane infrastructure.
- Public multi-tenant account architecture.
- Provider/agent features from T3 Code.
- Automated test expansion. Tests can be added later; current verification is build, typecheck, and manual smoke checks.

### Non-negotiable stack boundary

Do not replace SvelteKit, Tauri, or Rust with Electron, Node.js, React, or Effect. T3 Code supplies the architecture reference, not the implementation stack.

### Locked implementation decisions

- Use a root Cargo workspace.
- Place Git/domain logic in `crates/gitgui-core`.
- Place canonical serde wire contracts in `crates/gitgui-protocol`.
- Place the independently runnable Axum server and CLI in `crates/gitgui-server`.
- Keep `src-tauri` as the desktop shell and server process manager.
- Put shared browser-safe connection code in `src/lib/client-runtime`.
- Generate TypeScript protocol types from Rust into `src/lib/generated`; do not maintain duplicate handwritten contracts.
- Use Tokio, Axum, serde/serde_json, standard browser WebSockets, JSON messages, and tracing.
- Reserve HTTP for `/health`, `/ready`, `/info`, and future bootstrap needs; use `/ws` for typed requests, responses, and ordered events.
- Complete the local server-to-Svelte vertical slice before pairing, remote exposure, hosted deployment, mutations, or relay work.
- Keep the host repository catalog authoritative in the Rust server; keep open tabs, recents, active tab, and layout state in each client per environment.
- Require a Tauri-issued unguessable local bootstrap session and browser-origin restrictions before cutting repository RPCs over to the desktop webview.

## Work sequencing

The tasks below are grouped into waves. A task is complete only when its acceptance conditions are met and the relevant manual smoke check has been performed.

```text
Wave 0: decisions and boundaries
             |
             v
Wave 1: Rust core and standalone server
             |
             +--> Wave 2: protocol and server transport
             |          |
             |          v
             |      Wave 3: Svelte client runtime
             |          |
             |          v
             |      Wave 4: Tauri local host integration
             |
             +--> Wave 5: direct remote pairing
                            |
                            v
                        Wave 6: hosted web client
                            |
                            v
                      Wave 7: relay design gate only
```

Tasks within a wave may be assigned independently when their listed dependencies are satisfied.

## Wave 0 — architecture and contracts

### ARCH-001 — Freeze the implementation boundary

Depends on: none.

Deliverables:

- A short decision record stating that SvelteKit, Tauri, and Rust remain fixed.
- A list of T3 patterns being copied and a list of T3 technologies being excluded.
- Links from the roadmap and architecture docs to this plan.

Acceptance:

- A new contributor can determine the target stack without reading the T3 repository.
- No task in this plan requires Electron, Node.js, React, or Effect.

### ARCH-002 — Define ownership and process boundaries

Depends on: ARCH-001.

Deliverables:

- A responsibility map for SvelteKit, Tauri, Rust server, Rust Git core, and future relay.
- A lifecycle diagram for desktop startup, server readiness, reconnect, shutdown, and remote connection.
- A written rule that the hosted web client cannot import Tauri-only APIs.

Acceptance:

- Every current backend operation has an identified future owner.
- Local and remote connections use the same client-facing abstraction.

### ARCH-003 — Define the first protocol surface

Depends on: ARCH-002.

Deliverables:

- Initial method/event inventory.
- Request, response, error, welcome, lifecycle, and push-event envelope definitions.
- Rules for request IDs, protocol version, server ID, capabilities, and event ordering.

Initial method families:

- `server.get_info`
- `server.get_status`
- `repositories.list`
- `repositories.open`
- `repositories.refresh`
- `git.status`
- `git.diff`
- `git.log`
- `git.stage`
- `git.unstage`
- `git.commit`
- `git.fetch`
- `git.pull`
- `git.push`
- `git.branch.list`
- `git.branch.create`
- `git.branch.switch`
- `git.stash.push`
- `git.stash.pop`
- `events.subscribe`

Acceptance:

- Every method has a parameter shape, result shape, error behavior, and required capability.
- The protocol can represent server readiness and an ordered repository-refresh event.

## Wave 1 — Rust core and standalone server

### CORE-001 — Extract reusable GitGui Rust core

Depends on: ARCH-002.

Deliverables:

- A Rust core module/crate containing Git operations and domain types that do not depend on Tauri commands.
- A stable application state object that can be constructed by both Tauri and a standalone server.
- Explicit filesystem and process boundaries for repository operations.

Acceptance:

- The core can be compiled without the Tauri runtime.
- A standalone Rust entry point can construct the same core state.
- Existing Git behavior remains available through the new boundary.

### CORE-002 — Introduce the standalone Rust server target

Depends on: ARCH-003. Git-backed handlers additionally depend on CORE-001.

Deliverables:

- A `gitgui-server` binary or equivalent Rust package target.
- Configuration for bind address, port, data directory, and allowed repository roots.
- A server startup path independent of the desktop UI.

Acceptance:

- The server starts from a terminal on a development machine.
- Startup reports the bound address and server identity.
- The server can be stopped without leaving a child process running.

### CORE-003 — Add host and repository catalog state

Depends on: CORE-001.

Deliverables:

- Host identity and server metadata.
- Repository registration/listing state.
- Persistence format for non-secret host and repository metadata.
- Clear distinction between configured repositories and currently reachable repositories.

Acceptance:

- A fresh server can report an empty catalog.
- A configured repository can be listed and resolved by stable ID.
- Invalid or inaccessible paths produce typed errors.

## Wave 2 — protocol and server transport

### PROTO-001 — Implement protocol envelopes in Rust

Depends on: ARCH-003.

Deliverables:

- Serde types for request, response, error, welcome, event, and lifecycle messages.
- Version constants and capability identifiers.
- Validation for malformed messages and unknown methods.

Acceptance:

- Valid messages serialize and deserialize consistently.
- Malformed messages produce structured protocol errors.
- Unknown methods never reach Git operation code.

### PROTO-002 — Create the canonical method/event registry

Depends on: PROTO-001.

Deliverables:

- One registry mapping method names to handler contracts.
- One registry for event names and payload contracts.
- Documentation generated or maintained from the same source as the Rust dispatch boundary.

Acceptance:

- A method cannot be added to the dispatcher without a declared contract.
- Client-visible names are stable and namespaced.
- The registry records whether a method is local-only, remote-safe, or capability-gated.

### PROTO-003 — Expose matching TypeScript client contracts

Depends on: PROTO-001, PROTO-002.

Deliverables:

- TypeScript types for the public protocol.
- A deterministic generation step from canonical Rust definitions into `src/lib/generated`.
- No dependency on Effect or T3's contracts package.

Acceptance:

- SvelteKit can type a request and narrow the corresponding result/error/event.
- A protocol version mismatch is visible to the client.
- The contract path works in the hosted web build.

### HOST-001 — Add HTTP and WebSocket transport

Depends on: CORE-002, PROTO-001.

Deliverables:

- HTTP `GET /health`, `GET /ready`, and `GET /info` endpoints.
- WebSocket `/ws` session endpoint for JSON requests, responses, and server pushes.
- CORS/origin configuration appropriate for local desktop and hosted web use.

Acceptance:

- A browser-compatible client can establish a WebSocket session.
- A request receives the matching response ID.
- The server rejects malformed or unauthenticated requests consistently.

### HOST-002 — Implement readiness and welcome handshake

Depends on: HOST-001, PROTO-002.

Deliverables:

- Explicit server lifecycle states: starting, ready, stopping, stopped, failed.
- Readiness probe used by Tauri and other clients.
- Welcome message containing server ID, protocol version, capabilities, and session metadata.

Acceptance:

- Tauri can wait for readiness without guessing with a fixed sleep.
- The client can distinguish a server that is down, starting, incompatible, or ready.

### HOST-003 — Implement ordered push/event bus

Depends on: HOST-001, PROTO-002.

Deliverables:

- Server-side event bus with monotonic sequence values.
- Subscription filtering by event family and repository/server scope.
- Delivery behavior for slow or disconnected clients.

Acceptance:

- Repository changes are delivered in order within one session.
- A reconnect can detect that it may have missed events and request a refresh.
- No UI code depends on internal Rust channels.

### HOST-004 — Dispatch the first Git operation set

Depends on: CORE-001, PROTO-002, HOST-001.

Deliverables:

- Handlers for server info/status, repository listing/opening, and read-only Git status/diff/log.
- Structured errors for missing repository, invalid path, Git command failure, and permission failure.
- Repository scope checks before each operation.

Acceptance:

- A client can connect and render repository metadata through the protocol.
- Read-only Git operations work against a real local repository.
- Errors are shown as protocol errors rather than process crashes.

### HOST-007 — Roll out the first Git mutation set

Depends on: HOST-004, PROTO-002.

Deliverables:

- Implement `git.stage`, `git.unstage`, and `git.commit` for working-tree mutations.
- Implement `git.fetch`, `git.pull`, and `git.push` for remote synchronization.
- Implement `git.branch.list`, `git.branch.create`, and `git.branch.switch`.
- Implement `git.stash.push` and `git.stash.pop`.
- Return a fresh repository snapshot after each successful mutation and serialize mutations per repository.
- Preserve structured errors for conflicts, invalid paths, missing remotes, and Git command failures.

Acceptance:

- A client can stage, unstage, commit, fetch, pull, push, create or switch branches, and stash or pop changes through the protocol.
- Each successful mutation refreshes the affected repository state without requiring a second backend implementation.

Deferred Git actions:

- Amend commits.
- Interactive or partial staging.
- Stash apply or drop.
- Branch deletion.
- Progress streaming.

### HOST-005 — Add initial authentication/session boundary

Depends on: HOST-002, HOST-004.

Deliverables:

- Local bootstrap authentication mechanism.
- Session credential format and expiry/revocation behavior.
- Middleware that protects non-bootstrap methods.
- Explicit distinction between local trusted mode and remote paired mode.

Acceptance:

- An unauthenticated client cannot perform repository operations.
- Credentials are never logged in plaintext.
- The design supports replacing local bootstrap with remote pairing without changing Git handlers.

### HOST-006 — Add a headless server CLI

Depends on: CORE-002, HOST-002, HOST-005.

Deliverables:

- Commands for start, status, configure repository roots, and issue/revoke a pairing invitation.
- Human-readable output for manual operation.
- Non-zero exit codes for configuration, readiness, and authentication failures.

Acceptance:

- A remote PC can run the server without Tauri.
- An operator can discover the endpoint and create a first pairing invitation from the terminal.

## Wave 3 — SvelteKit client runtime

### CLIENT-001 — Create the GitGui connection client

Depends on: PROTO-003, HOST-002.

Deliverables:

- A client-facing `GitGuiClient` abstraction independent of Svelte components.
- Methods for connect, disconnect, request, subscribe, and inspect connection state.
- Typed results and typed server events.

Acceptance:

- A Svelte component can use the same client for local and remote endpoints.
- No component constructs raw WebSocket messages.

### CLIENT-002 — Implement transport drivers

Depends on: CLIENT-001, HOST-001.

Deliverables:

- HTTP request transport.
- WebSocket transport.
- Environment-specific URL handling for desktop-local, direct-remote, and hosted-web connections.
- Close/error normalization.

Acceptance:

- Transport failures become stable client states.
- The hosted build contains no Tauri-only transport dependency.

### CLIENT-003 — Implement the environment registry

Depends on: CLIENT-001.

Deliverables:

- Environment model with stable ID, display name, endpoint, kind, last-known status, and capability snapshot.
- Registry operations for add, remove, select, rename, and refresh.
- Storage adapter interface with separate metadata and secret storage.

Acceptance:

- The UI can switch environments without knowing storage details.
- A remote environment survives app restart when its metadata and credential are available.

### CLIENT-004 — Implement connection supervision and reconnect

Depends on: CLIENT-002, CLIENT-003.

Deliverables:

- Connection state machine for idle, connecting, ready, reconnecting, incompatible, unauthorized, and failed.
- Backoff and retry policy.
- Refresh-on-reconnect behavior when event sequence continuity is uncertain.

Acceptance:

- Temporary server restarts do not permanently strand the UI.
- The UI receives actionable state instead of an unhandled WebSocket exception.

### CLIENT-005 — Move Svelte UI reads behind the client runtime

Depends on: CLIENT-001, CLIENT-004, HOST-004.

Deliverables:

- Stores/loaders updated to consume `GitGuiClient`.
- Removal or isolation of direct Tauri command calls from shared UI code.
- Loading, empty, disconnected, and unauthorized states.

Acceptance:

- Existing local repository views render through the server protocol.
- The same view can be pointed at a second environment without a separate UI implementation.

## Wave 4 — Tauri desktop host integration

### DESKTOP-001 — Build the Tauri server manager

Depends on: HOST-002, CORE-002.

Deliverables:

- Tauri-side start/attach/stop/restart manager for the local Rust server.
- Child-process ownership and shutdown handling.
- Log routing suitable for desktop diagnostics.

Acceptance:

- Starting the desktop app starts or attaches to exactly one expected local server.
- Closing the desktop app cleans up the server according to the chosen lifecycle policy.

### DESKTOP-002 — Replace fixed-delay startup with readiness probing

Depends on: DESKTOP-001, HOST-002.

Deliverables:

- Readiness polling or event-driven startup completion.
- User-visible startup failure state.
- Recovery action for restart or view logs.

Acceptance:

- Slow startup works reliably.
- A failed server does not leave the UI in an infinite loading state.

### DESKTOP-003 — Add desktop storage and native adapters

Depends on: DESKTOP-001, CLIENT-003, HOST-005.

Deliverables:

- Non-secret environment metadata storage.
- Secure credential storage adapter where supported by the OS.
- Native folder-picker adapter exposed only through a narrow client boundary.

Acceptance:

- Hosted web compilation does not import the Tauri adapter.
- Desktop restart preserves configured environments without exposing secrets in ordinary files.

### DESKTOP-004 — Switch the desktop UI to the local server protocol

Depends on: CLIENT-005, DESKTOP-002, DESKTOP-003.

Deliverables:

- Local desktop environment created from the Tauri-provided server endpoint/session.
- Existing Git actions routed through the protocol.
- Removal of superseded direct command paths where safe.

Acceptance:

- The normal desktop flow works without a second backend implementation.
- Tauri-only features remain available through adapters, not shared protocol code.

## Wave 5 — direct remote connection and pairing

### REMOTE-001 — Add direct remote endpoint configuration

Depends on: CLIENT-003, CLIENT-004, HOST-006.

Deliverables:

- Remote endpoint form with scheme, host, port, and display name.
- Validation for HTTP/HTTPS and WS/WSS combinations.
- Clear warning for insecure non-local endpoints.

Acceptance:

- A client can save a reachable remote server endpoint.
- The client reports DNS, network, TLS, and server-protocol failures separately.

### REMOTE-002 — Implement direct pairing flow

Depends on: HOST-005, HOST-006, REMOTE-001.

Deliverables:

- One-time invitation/code creation on the remote host.
- Client-side pairing UI and exchange.
- Session credential issuance, storage, revocation, and rename/revoke controls.

Acceptance:

- A new client can pair without manually copying a permanent secret into source code or config.
- A revoked pairing can no longer access repository operations.
- Pairing does not require a relay.

### REMOTE-003 — Add remote repository catalog and operations

Depends on: REMOTE-002, CLIENT-005, HOST-004.

Deliverables:

- Remote environment repository list and selection.
- Read-only operations against a remote repository.
- Mutating operations behind explicit UI actions and server authorization.

Acceptance:

- The user can select a remote repository and view its status/diff/log.
- The UI clearly identifies the active host and repository before mutation.

### REMOTE-004 — Handle remote compatibility and reconnect

Depends on: REMOTE-003, CLIENT-004, HOST-002.

Deliverables:

- Protocol/server version compatibility screen.
- Reconnect and refresh after remote restart or network interruption.
- Host capability display for operations unavailable on a remote server.

Acceptance:

- An incompatible remote is explained and cannot be used accidentally.
- A temporary network interruption results in recoverable UI state.

## Wave 6 — hosted SvelteKit client

### WEB-001 — Make the client browser-safe

Depends on: CLIENT-005, DESKTOP-003.

Deliverables:

- Build boundary that excludes Tauri imports from hosted routes/components.
- Browser storage/credential adapter with an explicit security policy.
- Hosted connection configuration.

Acceptance:

- The SvelteKit web build succeeds without Tauri runtime availability.
- The browser client can connect to a direct HTTPS/WSS remote server.

### WEB-002 — Add hosted direct pairing UX

Depends on: WEB-001, REMOTE-002.

Deliverables:

- Hosted sign-in/session bootstrap only if required by the chosen deployment model.
- Pairing form and direct connection flow.
- Clear origin, CORS, TLS, and mixed-content guidance.

Acceptance:

- A hosted browser can pair with a reachable remote server without the desktop app installed.
- No relay is silently introduced by the hosted flow.

### WEB-003 — Define and perform the first hosted deployment

Depends on: WEB-002.

Deliverables:

- Deployment target and environment configuration.
- HTTPS URL and WebSocket upgrade configuration.
- Short operator notes for deploying the SvelteKit client and exposing a remote server safely.

Acceptance:

- The deployed web client loads over HTTPS.
- A direct remote connection works end-to-end in a real browser.

## Wave 7 — relay design gate only

### FUTURE-001 — Write the relay architecture decision record

Depends on: REMOTE-004, WEB-003.

Deliverables:

- Comparison of direct-only, reverse-connection, and relay-mediated connection models.
- Trust model, authentication flow, reconnect semantics, observability, bandwidth, and cost estimates.
- Explicit decision on whether a relay is needed for the personal-project phase.

Acceptance:

- The relay decision is based on working direct remote behavior and identified limitations.
- The document does not assume Convex is the data path.

### FUTURE-002 — Evaluate Convex only for control-plane needs

Depends on: FUTURE-001.

Deliverables:

- Evaluation of whether Convex should store users, hosts, pairing metadata, presence, or relay coordination state.
- Security and operational comparison against a small dedicated service.
- No relay implementation before the evaluation is approved.

Acceptance:

- A separate decision records what, if anything, Convex owns.
- The Rust server protocol remains usable without Convex.

## Verification policy for this phase

Automated tests are intentionally not the current priority. Every completed task should still include proportionate non-test verification:

- Rust compile/check for changed crates.
- SvelteKit typecheck/build for changed client code.
- Manual smoke check of the affected local or remote flow.
- Protocol inspection using logs or a small manual client where useful.
- `git diff --check` before committing documentation or source changes.

Tests should be added later around protocol compatibility, authentication, Git operation safety, and reconnect behavior before the project becomes multi-user or public-facing.

## Completion gates

### Gate A — standalone local host

The Rust server starts independently, reports readiness, exposes the initial protocol, and serves repository read operations.

### Gate B — desktop host

Tauri starts/manages the server, and the desktop UI uses the same protocol as any other client.

### Gate C — direct remote

A second PC can run the Rust server, pair directly, browse a repository, and recover from a restart.

### Gate D — hosted web

The deployed SvelteKit client can connect directly to a remote server over the configured secure transport.

### Gate E — relay decision

Only after Gate D is working do we decide whether a T3-style relay is worth designing and building.
