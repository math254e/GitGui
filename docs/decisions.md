# Architecture decisions

This file records accepted architectural direction. Implementation status is
tracked in the roadmap.

## ADR-001 — Use the installed Git executable

GitGui uses the installed `git` executable rather than a Git library. This preserves compatibility with user configuration, credentials, hooks, extensions, and the behavior users see in the terminal.

## ADR-002 — Rust owns Git and repository behavior

The frontend never executes Git commands. `gitgui-core` owns execution, parsing, repository state, graph behavior, and mutations. The client consumes structured protocol data.

## ADR-003 — One standalone Rust backend is canonical

`gitgui-server` is the real application backend and must run without the desktop shell. It owns stable environment identity, authentication, the repository catalog, filesystem access, Git RPC, and server events. Electron supervises a local instance but does not provide a parallel Git backend.

## ADR-004 — Electron is the target desktop shell

Electron is the desktop host because GitGui follows T3 Code's desktop
lifecycle, preload boundary, connection platform, and SSH infrastructure
closely. Electron remains thin: normal application requests travel directly
from the renderer to `gitgui-server` over HTTP/WebSocket.

## ADR-005 — T3 Code is the reference for distributed application structure

The current checkout at `D:\GitHub\PictureTagingApp.references\t3code` is the primary implementation reference for:

- frontend/backend/desktop workspace structure;
- environment concepts and terminology;
- connection resolver, driver, session, supervisor, and registry boundaries;
- authentication, pairing, WebSocket tickets, and reconnect behavior;
- Electron main/preload responsibilities;
- SSH-managed remote environments.

GitGui should copy these concepts and infrastructure as much as practical, translating Node server work to Rust and React integration to Svelte. T3 Code's product, agent, thread, project, and VCS behavior are not GitGui requirements.

## ADR-006 — Backend identity is stable and endpoint-independent

An environment represents one backend with one persistent state directory. The backend generates and persists its `EnvironmentId`. Client registrations, addresses, tunnels, and credentials describe how to reach it but do not define its identity.

The persisted `server_id` field is retained as a wire/storage compatibility
alias, but new identities are UUIDs and `environmentId` is canonical. Identity
is never derived from an endpoint.

## ADR-007 — The shared client runtime owns connection behavior

The framework-independent TypeScript runtime owns environments, credentials, connection preparation, sessions, retries, offline handling, wakeups, and environment-scoped session generations. Svelte routes and components only consume runtime state through a thin adapter.

There is exactly one retry owner: `EnvironmentSupervisor`. A session factory performs one attempt. This avoids nested retries and inconsistent UI state.

## ADR-008 — The client runtime uses Effect, vendored from T3 Code

GitGui's client runtime uses Effect, the same library and the same version T3
Code uses. T3 Code's client runtime is vendored file by file, so a later T3
Code release can be copied over and keep working.

The reason is maintenance, not style. The connection runtime is the part of
GitGui that has to keep working against servers, networks, and operating
systems that change underneath it. Copying T3 Code's implementation, its
lifecycle rules, and its failure tests keeps that behavior identical to a
system that is used in production, and it makes an upstream change a merge
instead of a rewrite.

The vendored files, the recorded divergences, and the re-sync procedure live
in `docs/t3code-vendoring.md`. The runtime as it exists in GitGui is
described in `docs/connection-runtime.md`.

Where GitGui's domain differs from T3 Code's, the divergence is recorded in
the vendored file's header and in the vendoring document. The GitGui server
is Rust and speaks the GitGui envelope, so the RPC session multiplexes the
envelope over `effect/socket` instead of using `effect/rpc`.

## ADR-009 — Authentication uses exchangeable sessions and WebSocket tickets

Bootstrap and pairing credentials are exchanged over HTTP for scoped bearer sessions. WebSockets use short-lived, single-use tickets rather than durable credentials in URLs. Server methods enforce scopes.

Electron must pass the primary local bootstrap credential to Rust through a non-logging inherited channel, not a command-line argument.

## ADR-010 — SSH belongs to Electron, not the renderer protocol

Electron resolves SSH hosts, handles prompts, launches or reuses the remote Rust server, creates a local port forward, checks readiness, and restores the bridge before reconnect. The normal client runtime receives a prepared local endpoint and then uses the same HTTP/WebSocket protocol as every other environment.

## ADR-011 — Tailscale is direct connectivity

A Tailscale address is an ordinary directly reachable authenticated backend endpoint. It does not require a separate runtime or application protocol. Relay/control-plane infrastructure is deferred until direct and SSH connections are reliable and a concrete relay requirement exists.

## ADR-012 — Client and server state remain distinct

The server owns the host repository catalog and shared repository state. Each client owns tabs, recents, active selections, layout, and other presentation state per environment. Server state must not assume one globally active client or repository.

## ADR-013 — Protocol definitions originate in Rust

`crates/gitgui-protocol` is the canonical application wire contract. TypeScript contracts are generated. Electron bridge types are maintained separately because native desktop services are not Git RPC.

## ADR-014 — Git graph rendering remains GitGui-specific

T3 Code is not the reference for Git graph behavior. Graph extraction, lane assignment, rendering, performance, and interaction follow GitGui's graph design and appropriate Git GUI references.

## ADR-015 — The URL owns what is on screen

The SvelteKit client owns its routes. The URL selects what is displayed; the client workspace owns which repositories are open and remembers the last active repository so a cold start can resume into it.

The route vocabulary is written down once, in `apps/web/src/lib/workspace/routes.ts`, and the agreement between the URL and the workspace is a pure function in `apps/web/src/lib/workspace/repository-routing.ts` so it can be tested without a browser.

Routes use the path, not the fragment, in every shell. The Rust server, the Electron protocol handler, and the development server all answer an unknown path with the application shell, so no shell needs to understand the route. SvelteKit's `kit.router.type: 'hash'` remains available if the desktop shell ever stops serving the application files itself.

The environment is not part of the URL. A repository identifier is issued by the backend and already names one environment, and the environment remains a client setting under Settings → Connections.

The application workspace state lives in `apps/web/src/lib/workspace/`. It is mounted once at the application root, next to the connection runtime, and routes read it and call its actions. Routes never own sockets, retries, credentials, or Git mutations.
