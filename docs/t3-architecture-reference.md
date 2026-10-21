# T3 Code architecture reference for GitGui

## Purpose

T3 Code is GitGui's primary reference implementation for the structure around the application: frontend/backend separation, Electron, environments, connection preparation, authentication, sessions, reconnects, and SSH. We intend to copy its concepts, terminology, layering, and infrastructure as closely as practical for GitGui's needs.

This is not a broad statement that GitGui merely takes inspiration from T3 Code. For the concerns listed above, current T3 Code behavior is the default design. A divergence should have a concrete technical reason.

T3 Code is not the source of truth for Git semantics, Git graph behavior, repository workflows, or GitGui's product UI.

## Local source of truth

Use the checked-out repository at:

```text
D:\GitHub\PictureTagingApp.references\t3code
```

Always inspect the current checkout before changing one of the covered boundaries. The most relevant sources are:

```text
docs/internals/workspace-layout.md
docs/internals/connection-runtime.md
docs/internals/remote.md
docs/internals/environment-auth.md
apps/desktop
packages/client-runtime
packages/ssh
```

Supporting sources inside `apps/web` and contract/auth packages should be followed when the primary files point to them.

## Translation, not substitution

| T3 Code | GitGui |
| --- | --- |
| Node/TypeScript server | Rust `gitgui-server` |
| React client | SvelteKit client |
| Electron desktop | Electron desktop |
| T3 contracts | Rust-originated GitGui protocol plus generated TypeScript |
| T3 client runtime | TypeScript GitGui client runtime with matching boundaries/state model |
| T3 SSH package | GitGui Electron/Node SSH package adapted for the Rust server |
| T3 environment backend state | GitGui backend state directory, repository catalog, and Git caches |
| T3 VCS/product behavior | Not copied; GitGui-owned design |

The backend language difference does not justify redesigning client connection semantics. The Svelte difference does not justify placing runtime logic in components. Electron is used in the same general role and should reuse applicable desktop patterns directly.

## Core rule

One client communicates with one backend over HTTP/WebSocket. The backend owns the actual environment and filesystem. Remote access changes how the client reaches the backend, not where application logic runs.

For GitGui this means:

- `gitgui-server` runs Git and owns repositories;
- the Svelte client renders protocol state and issues protocol operations;
- Electron prepares local and SSH-backed connectivity;
- after preparation, primary, direct, Tailscale, and SSH connections use the same GitGui client/session API;
- neither Electron IPC nor SSH becomes a second Git application protocol.

## Workspace pattern

T3 Code separates server, web, and desktop applications and extracts reusable connection/SSH/contracts packages. GitGui should mirror that shape:

```text
apps/web                  SvelteKit client
apps/desktop              Electron main/preload
packages/client-runtime   connection and environment runtime
packages/contracts        generated protocol and bridge contracts
packages/ssh              desktop SSH infrastructure
packages/shared           small shared utilities
crates/gitgui-server      standalone Rust backend
crates/gitgui-core        Git domain
crates/gitgui-protocol    canonical wire contract
```

Rust crates remain a Cargo workspace; JavaScript applications and packages become npm workspaces.

## Environment model

Adopt T3's meaning: an environment is one running backend with one persistent state directory. Its identity belongs to the backend.

GitGui's backend descriptor and welcome data expose a stable `EnvironmentId`. The existing persisted server identity should become or map to this identity. A URL, forwarded port, hostname, credential, or desktop installation is not the identity.

Consequences:

- reconnecting to a new port preserves environment-scoped state;
- an SSH tunnel can be rebuilt without changing the environment;
- the same backend discovered through two valid routes reconciles to one environment;
- clearing a backend's state directory intentionally creates a new environment;
- client workspace and caches are keyed by backend identity, not endpoint text.

## Connection terminology

Use T3's separation of identity, configuration, credentials, and prepared transport:

- `ConnectionTarget`: strategy or route for reaching a backend.
- `ConnectionProfile`: non-secret route settings.
- `ConnectionCredential`: secret material.
- `ConnectionRegistration`: durable known-environment record.
- `PreparedConnection`: temporary resolved HTTP/WebSocket/auth details.
- `RpcSession`: one live authenticated transport.

Initial GitGui targets:

- `PrimaryConnectionTarget`
- `BearerConnectionTarget`
- `SshConnectionTarget`

Do not keep target names based on whether the client happens to be desktop or hosted. Do not create a Tailscale-specific runtime; Tailscale normally supplies a reachable address for a bearer connection. Add relay terminology only with actual relay support.

## Client runtime pattern

Copy the T3 layering:

```text
EnvironmentRegistry
  └─ EnvironmentSupervisor
       └─ ConnectionDriver
            ├─ ConnectionResolver
            └─ RpcSessionFactory
```

### Registry

The registry owns known connection registrations and one scoped supervisor for each environment. It reconciles registrations supplied by browser persistence, Electron primary setup, saved direct endpoints, and Electron SSH setup. Removing an environment disposes every environment-scoped resource.

### Supervisor

The supervisor owns desired connection state, network awareness, retries, blocked states, active/replacement sessions, stability reset, and wakeups. It is the only retry owner.

GitGui initially adopts T3's retry timing and stability behavior:

- transient delays: 3, 4, 8, then 16 seconds capped;
- retry transient failures indefinitely while connection is desired and network is online;
- reset attempts after 30 seconds of stable connection;
- stop retrying blocked auth/configuration/permission/version failures until external state changes;
- release transport while offline without consuming attempts;
- probe an active session after foreground/wakeup.

### Driver

The driver performs one preparation/open/synchronize cycle and reports stages. It does not contain a hidden retry loop.

### Resolver

The resolver transforms a target into a prepared connection. Primary resolution asks the Electron platform for local registration/bootstrap information. Bearer resolution uses direct endpoint/profile/credential data. SSH resolution asks Electron to ensure a bridge and returns forwarded local endpoints.

### Session factory

The session factory makes exactly one connection attempt and returns a session with readiness, probe, close, and closed-reason behavior. A failed attempt is reported to the supervisor.

### Session generation

Every replacement session advances a generation. Query caches revalidate against the new generation, long-lived subscriptions switch sessions, and mutations fetch the current session at execution. This prevents UI objects from holding stale WebSockets.

## Svelte integration

T3 mounts its connection runtime once and injects platform capabilities. GitGui should do the same with Svelte stores/context:

- create one runtime at the application root;
- provide browser or Electron platform services;
- expose derived environment and session state to components;
- keep transport, retry, credential, and environment reconciliation out of routes and components;
- scope repository workspace/query state by `EnvironmentId`.

The core runtime remains framework-independent. GitGui's runtime uses Effect, the same library and the same version T3 Code uses, and its client runtime is vendored from T3 Code file by file. See `docs/t3code-vendoring.md` for the vendored files and the recorded divergences, and `docs/connection-runtime.md` for the runtime as it exists here. The Svelte adapter in `apps/web/src/lib/connection` is the only framework-aware part.

## Electron pattern

Copy the role and security boundary of T3's `apps/desktop`:

- Electron main owns process and native lifecycle.
- A narrow preload bridge exposes typed capabilities.
- The renderer has no Node integration.
- The desktop uses a stable custom application origin.
- The local server is a child/service managed by the desktop, not embedded application logic.
- The renderer communicates directly with that server over HTTP/WebSocket.

GitGui Electron responsibilities:

- find the correct `gitgui-server` binary in development and packaged layouts;
- start/reuse, health-check, restart, and stop the primary local backend;
- create and safely deliver bootstrap credentials;
- provide the primary connection registration;
- persist environment metadata and protected credentials;
- provide native folder selection and desktop integration;
- manage SSH environments, prompts, and local forwards;
- own app updates, deep links, single-instance behavior, and window lifecycle.

Security defaults:

```text
contextIsolation = true
nodeIntegration = false
sandbox = true
```

The preload bridge must not expose generic shell execution, arbitrary filesystem access, unrestricted IPC, or Git operations.

## Authentication pattern

Copy T3's distinction between durable credentials, bearer sessions, and short-lived WebSocket tickets.

Local bootstrap:

1. Electron creates an unguessable bootstrap secret.
2. It passes that secret to Rust through a dedicated inherited channel.
3. The client exchanges it for a scoped session.
4. The client obtains a short-lived, one-use ticket for opening the WebSocket.

Remote pairing follows the same session model after user authorization. Credentials are stored by the appropriate platform adapter, not in Svelte components or generated bundles.

GitGui defines its own scopes based on Git operations. Candidate initial scopes are:

```text
repository:read
repository:operate
repository:manage
access:read
access:write
```

Exact grants require method-level review. Readiness is not authorization, and loopback binding is not authentication.

## SSH pattern

Copy T3's rule that the desktop prepares SSH but the renderer speaks only the normal backend protocol.

Electron and `packages/ssh` own:

- OpenSSH config and known-host discovery;
- host resolution and connection command construction;
- password, passphrase, and host-key prompts;
- remote platform/architecture detection where needed;
- remote server detection, launch, reuse, and ownership tracking;
- remote loopback binding and local port forwarding;
- readiness polling and descriptor verification;
- tunnel restoration before RPC reconnection.

The prepared result supplied to the client runtime contains ordinary local HTTP/WebSocket endpoints and auth setup. The Svelte client has no SSH-specific application RPC.

Initially, remote users may install `gitgui-server` themselves. T3's managed binary approach can be adapted later without changing client runtime contracts.

## What should be copied closely

- Application/workspace separation into web, desktop, server, and shared packages.
- Stable backend-defined environment identity.
- Target/profile/credential/registration/prepared-connection vocabulary.
- Registry/supervisor/driver/resolver/session-factory layering.
- One retry owner and typed transient versus blocked failures.
- Offline and foreground/wakeup behavior.
- Environment-scoped lifecycle and cleanup.
- Session generation and replacement semantics.
- Authentication exchange and WebSocket tickets.
- Electron main/preload security and capability boundary.
- Desktop-managed SSH launch/tunnel/readiness/reconnect sequence.
- Direct endpoints and Tailscale as the same normal server runtime.

## What is translated

- Node backend process logic becomes Rust Axum server logic.
- TypeScript server contracts originate in Rust and generate TypeScript.
- React hooks/providers become Svelte stores/context.
- T3 server lifecycle commands launch `gitgui-server` rather than the T3 server.
- T3 permissions become GitGui repository/access scopes.
- T3 environment state becomes GitGui repository catalog and Git service state.

## What is not copied

- T3's agent, thread, provider, prompt, or coding-workspace product model.
- T3's VCS implementation or assumptions about coding-agent repositories.
- React UI components or design language.
- Node as the GitGui backend.
- Relay/control-plane infrastructure before GitGui needs it.
- Effect solely for stack parity.

These exclusions do not weaken T3's authority over the connection and desktop architecture.

## Review checklist

Before approving a change in the covered areas, answer:

- Which current T3 source was inspected?
- Does this preserve one client-to-one-backend HTTP/WebSocket model?
- Is environment identity backend-issued and independent of the endpoint?
- Is retry owned only by the supervisor?
- Are blocked and transient failures distinguished?
- Can hosted web compile without Electron?
- Does Electron expose only a narrow typed capability?
- Are durable secrets absent from URLs, logs, arguments, and bundles?
- Does SSH resolve to an ordinary prepared GitGui connection?
- If the implementation diverges from T3, what concrete GitGui constraint required it?
- Is the change about Git behavior? If so, was it designed from GitGui requirements rather than copied from T3?
