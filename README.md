# GitGui

GitGui is a Git desktop and web client built around one independently runnable Rust backend. The target application stack is:

- SvelteKit and TypeScript for the client.
- Electron for the desktop shell.
- Rust for Git behavior, repository state, the protocol, and the server.
- The installed `git` executable for Git operations.

The frontend/backend/desktop/remote architecture follows the current T3 Code implementation as closely as practical. T3 Code is the reference for application structure, environments, connection supervision, authentication, reconnects, Electron lifecycle, and SSH-managed remote backends. GitGui does not copy T3 Code's product or VCS behavior; Git semantics remain GitGui-owned.

## Architecture

```text
SvelteKit client
  -> shared client runtime
     -> HTTP/WebSocket
        -> gitgui-server
           -> gitgui-core
              -> installed git executable

Electron desktop
  -> loads the SvelteKit client
  -> starts and supervises the primary local gitgui-server
  -> manages credentials, native prompts, SSH, and local port forwards
```

One client talks to one server over HTTP/WebSocket. The server owns the actual host environment, repository catalog, filesystem access, and Git execution. Remote access changes how the client reaches that server; it does not move Git logic into Electron or the browser.

The same client API is used for:

- the primary backend managed by Electron;
- a directly reachable authenticated backend, including one reached over Tailscale;
- a backend reached through an Electron-managed SSH tunnel.

See [architecture](docs/architecture.md), [T3 architecture reference](docs/t3-architecture-reference.md), and the [migration record](docs/rearchitecture-plan.md).

## Architecture status

The Electron/client-runtime migration is complete. The repository now uses the
T3-shaped frontend/backend/desktop boundaries: the standalone Rust
`gitgui-server` owns Git and server state, the SvelteKit client uses the shared
TypeScript connection runtime, and Electron supervises the local server and
owns SSH/native capabilities.

The shared connection runtime is T3 Code's connection runtime, adapted to Git
and vendored file by file with Effect, so a later T3 Code release can be copied
over. See [the vendoring record](docs/t3code-vendoring.md) and
[the connection runtime](docs/connection-runtime.md).

The previous desktop shell and root-level SvelteKit layout have been removed. Local,
direct/Tailscale, and Electron-managed SSH environments all enter the same
HTTP/WebSocket client session model.

## Current development commands

These commands describe the completed workspace:

```sh
npm install
npm run dev
```

`npm run dev` launches the Electron shell, Vite client, and locally managed
Rust server.

For browser development with a separate server:

```sh
npm run server:dev
npm run ui:dev
```

Open `http://localhost:1420/?server=http://127.0.0.1:3774`.

For combined browser mode:

```sh
npm run web:serve
```

Open `http://127.0.0.1:3774`.

Run the Rust server independently with:

```sh
cargo run -p gitgui-server -- --port 3774
```

Standalone CLI runs use a persistent per-user state directory so the backend's
UUID `EnvironmentId` survives restarts. Use `--data-dir <path>` to select an
isolated environment or `--ephemeral` for a deliberately temporary server.

Useful validation commands:

```sh
npm run check
npm run test
npm run build
cargo check --workspace
npm run protocol:generate
git diff --check
```
