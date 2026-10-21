# T3 Code vendoring

GitGui's client runtime is T3 Code's client runtime, adapted to Git. The
upstream implementation is vendored file by file so that a later T3 Code
release can be copied over again and keep working.

- Upstream repository: `t3code`
- Upstream snapshot: `v0.1.2-nightly.20261021.3473`
- Upstream commit: `1688f965682d331da16a8c39f049592361f69c8d`
- Local checkout: `T3CODE_PATH`, or `/data/references/t3code`
- Manifest: `scripts/t3code-vendored.json`
- Sync check: `npm run vendor:sync` (fails on unrecorded drift in either mode)
- Copy verbatim bodies: `node scripts/vendor-t3code.mjs --write`
- Record reviewed adaptations: `node scripts/vendor-t3code.mjs --record-adaptations`

Every vendored file starts with a header that names the upstream file, the
upstream commit, and the divergences applied to it. Keep that header current
when a divergence changes. There are 30 vendored implementation files: eight
verbatim bodies and 22 adapted files. “Verbatim” permits only the provenance
header and the manifest's package-name replacements.

The check requires the checkout to be at the pinned commit, rejects dirty
upstream file contents, compares verbatim bodies, and verifies SHA-256 hashes
of both the upstream and GitGui versions of every adapted file. Updating a
hash records a reviewed adaptation; it does not establish behavioral parity.
The checks themselves have isolated fixture tests in
`scripts/vendor-t3code.test.mjs`, included in `npm test`.

## What is vendored

| Upstream file | GitGui file | Mode |
| --- | --- | --- |
| `packages/client-runtime/src/connection/wakeups.ts` | `packages/client-runtime/src/connection/wakeups.ts` | verbatim |
| `packages/client-runtime/src/connection/connectivity.ts` | `packages/client-runtime/src/connection/connectivity.ts` | verbatim |
| `packages/client-runtime/src/connection/profileStore.ts` | `packages/client-runtime/src/connection/profileStore.ts` | verbatim |
| `packages/client-runtime/src/connection/credentialStore.ts` | `packages/client-runtime/src/connection/credentialStore.ts` | verbatim |
| `packages/client-runtime/src/platform/source.ts` | `packages/client-runtime/src/platform/source.ts` | verbatim |
| `packages/client-runtime/src/errors/errorTrace.ts` | `packages/client-runtime/src/errors/errorTrace.ts` | verbatim |
| `packages/client-runtime/src/errors/safeLog.ts` | `packages/client-runtime/src/errors/safeLog.ts` | verbatim |
| `packages/shared/src/hostClassification.ts` | `packages/shared/src/hostClassification.ts` | verbatim |
| `packages/client-runtime/src/connection/model.ts` | `packages/client-runtime/src/connection/model.ts` | adapted |
| `packages/client-runtime/src/connection/catalog.ts` | `packages/client-runtime/src/connection/catalog.ts` | adapted |
| `packages/client-runtime/src/connection/routes.ts` | `packages/client-runtime/src/connection/routes.ts` | adapted |
| `packages/client-runtime/src/connection/errors.ts` | `packages/client-runtime/src/connection/errors.ts` | adapted |
| `packages/client-runtime/src/connection/compatibility.ts` | `packages/client-runtime/src/connection/compatibility.ts` | adapted |
| `packages/client-runtime/src/connection/resolver.ts` | `packages/client-runtime/src/connection/resolver.ts` | adapted |
| `packages/client-runtime/src/connection/driver.ts` | `packages/client-runtime/src/connection/driver.ts` | adapted |
| `packages/client-runtime/src/connection/supervisor.ts` | `packages/client-runtime/src/connection/supervisor.ts` | adapted |
| `packages/client-runtime/src/connection/registry.ts` | `packages/client-runtime/src/connection/registry.ts` | adapted |
| `packages/client-runtime/src/connection/layer.ts` | `packages/client-runtime/src/connection/layer.ts` | adapted |
| `packages/client-runtime/src/rpc/protocol.ts` | `packages/client-runtime/src/rpc/protocol.ts` | adapted |
| `packages/client-runtime/src/rpc/session.ts` | `packages/client-runtime/src/rpc/session.ts` | adapted |
| `packages/client-runtime/src/rpc/client.ts` | `packages/client-runtime/src/rpc/client.ts` | adapted |
| `packages/client-runtime/src/rpc/http.ts` | `packages/client-runtime/src/rpc/http.ts` | adapted |
| `packages/client-runtime/src/environment/descriptor.ts` | `packages/client-runtime/src/environment/descriptor.ts` | adapted |
| `packages/client-runtime/src/environment/endpoint.ts` | `packages/client-runtime/src/environment/endpoint.ts` | adapted |
| `packages/client-runtime/src/errors/network.ts` | `packages/client-runtime/src/errors/network.ts` | adapted |
| `packages/client-runtime/src/errors/transport.ts` | `packages/client-runtime/src/errors/transport.ts` | adapted |
| `packages/client-runtime/src/authorization/remote.ts` | `packages/client-runtime/src/authorization/remote.ts` | adapted |
| `packages/client-runtime/src/authorization/service.ts` | `packages/client-runtime/src/authorization/service.ts` | adapted |
| `packages/client-runtime/src/platform/capabilities.ts` | `packages/client-runtime/src/platform/capabilities.ts` | adapted |
| `packages/client-runtime/src/platform/persistence.ts` | `packages/client-runtime/src/platform/persistence.ts` | adapted |

The tests `connection/supervisor.test.ts`, `connection/routes.test.ts`,
`connection/registry.test.ts`, and `connection/resolver.test.ts` are ported
from the same upstream files.

## What is GitGui's own

These files have no T3 Code counterpart, because GitGui's domain or its
platform differs:

| File | Why |
| --- | --- |
| `packages/client-runtime/src/rpc/promise.ts` | The promise view of the Effect session that the Svelte workspace layer consumes. T3 Code's React layer consumes Effect directly. |
| `packages/client-runtime/src/rpc/events.ts` | The ordered event bus that the promise view uses. |
| `packages/client-runtime/src/platform/catalog.ts` | The client-owned connection catalog, persisted through a platform backend. |
| `packages/client-runtime/src/platform/records.ts` | The persisted record of one known environment. |
| `packages/contracts/src/environment.ts` | The Effect Schema contracts for the GitGui environment surface. |
| `packages/client-runtime/src/rpc/protocol.test.ts` | The test that keeps the typed method table and the Rust method registry in agreement. |
| `packages/client-runtime/src/rpc/session.test.ts` | The session's own rules: the request lifecycle, the handshake deadline, blocked against closed, and the event stream. |
| `packages/client-runtime/src/platform/catalog.test.ts` | Non-secret persistence, protected credential failures, route profiles, concurrent writes, and removal. |
| `packages/client-runtime/src/connection/errors.test.ts` | HTTP error classification with absent and present trace IDs. |
| `packages/client-runtime/src/rpc/http.test.ts` | Empty/nonstandard authentication errors stay typed; stalled success/error bodies time out, abort their sockets, and permit subsequent discovery. |

## The divergences

### GitGui has no relay

T3 Code reaches remote environments through T3 Connect, a managed relay. GitGui
does not have a relay, so the relay branches are gone:

- `RelayConnectionTarget` and `RelayConnectionRegistration` are gone.
- The relay route id, kind, rank, and label are gone from `routes.ts`.
- The relay branches of `mergeLearnedRoutes` and `routesAfterRemoving` are gone.
- The supervisor never restarts a managed relay account and never traces a
  relay attempt.
- `removeRelayEnvironments` is gone from the registry.
- The relay discovery watcher and the onboarding layer are gone from the
  connection layer.

A relay environment in T3 Code is a client, a route, and a credential
management problem. In GitGui, a remote environment is a bearer route, an SSH
route, or a learned route that the server advertises.

### GitGui has no DPoP and no cloud account

- The DPoP token exchange, the DPoP WebSocket ticket, the DPoP access-token
  store, and the DPoP socket URL helpers are gone.
- `authorizeDpop` and `authorizeDpopHttp` are gone; only `authorizeBearer`
  remains.
- The cloud session, the relay device identity, and the analytics device id
  are gone from the platform capabilities.
- The client owner parameters, which hashed a cloud account, are gone.

GitGui's desktop shell owns a bootstrap credential and exchanges it for a
scoped bearer session through `POST /oauth/token`.

### The GitGui server is Rust and speaks the GitGui envelope

T3 Code's server is TypeScript and speaks `effect/rpc`. GitGui's server is
Rust and speaks the GitGui JSON envelope: `welcome`, `response`, and `event`
messages, with requests addressed by `id`, `method`, and `params`.

- `rpc/protocol.ts` declares the method registry and the payload and result of
  every method instead of an `effect/rpc` group. The method names come from
  the Rust protocol crate, which publishes them as `WS_METHOD_NAMES`; the
  generator writes them into the contract, and a test fails when the typed
  table and the registry drift apart. So a method, its payload, and its result
  are checked against the server's own definitions, which is what `effect/rpc`
  gives T3 Code.
- `rpc/session.ts` multiplexes requests, responses, and events over
  `effect/socket` instead of building an `RpcClient.Protocol`.
- `rpc/client.ts` exposes one `request` and one `subscribeEvents` instead of a
  tag union. Both are typed by the method table.
- `rpc/http.ts` decodes one schema per endpoint instead of using an `HttpApi`
  group client, because the GitGui server's REST surface is plain JSON.

### The session owns the request lifecycle and the handshake deadline

T3 Code's session delegates the request lifecycle to `effect/rpc`. The GitGui
session owns it, and the rules are:

- Every request removes its pending entry on every exit: a response, a
  rejection, a timeout, an interruption, or a failed write. A closing session
  refuses new requests instead of registering them.
- Opening the socket and completing the handshake are separate stages. The
  welcome has its own deadline, so a server that accepts the socket and never
  greets cannot hang the connection.
- A blocked session stays blocked. The first reason to end the session wins,
  so the socket close that follows a deliberate rejection does not turn it into
  a transient failure.
- The reader always reports the end of the session, however it ended, and
  closing the scope closes the socket and clears the pending requests.
- The event stream is lossless and ordered, and the server's monotonic event
  sequence is watched, so a missing event is reported as a gap instead of
  leaving the client with a hole. The publication never blocks, so a slow
  subscriber cannot delay an RPC response on the same connection.
- Each consumer acquires its own scoped PubSub subscription, as T3's server
  configuration stream does. Active consumers receive broadcasts rather than
  competing for one queue; closing the session closes the hubs. GitGui's
  promise client explicitly disposes its event and gap readers when its
  workspace is replaced.

### GitGui's protocol version is fixed

T3 Code negotiates an orchestration protocol version through a query
parameter. GitGui's protocol version is fixed, so `compatibility.ts` compares
the server's advertised version against the client's and adds no query
parameter.

### GitGui's environment descriptor carries the advertised routes

T3 Code learns direct routes from the session's initial server configuration.
The GitGui environment descriptor carries the routes the server advertises, so
the resolver attaches the descriptor to the prepared connection and the
supervisor learns routes from it.

### GitGui's catalog and credentials are client-owned

- The GitHub routing permission reset is gone: GitGui does not route requests
  through a source-control host.
- The environment cache store is gone: GitGui caches no server-owned snapshots.
- A credential is keyed by its environment, not by its connection. Every route
  of one environment shares the credential the environment issued.
- The desktop shell persists the client-owned registration record verbatim; it
  does not interpret the record. Pairing-time registrations carry credentials,
  but persisted records contain only targets and profiles. Credential writes
  complete through the separate credential backend before a registration can
  connect. Earlier records are scrubbed after moving their credential to that
  backend. Browser credentials use separate origin-scoped storage; Electron
  uses its protected credential bridge.
- All retained routes keep independent profiles, including learned routes.
  Catalog updates share a lock across environments, following T3's single
  catalog update boundary. Removed routes drop their profiles, and explicit
  environment removal clears its credential and client workspace metadata.
- The platform registry's credential reads, replacements, and removals also use
  environment IDs. A saved registration shadowed by a platform registration is
  removed before the replacement credential is stored.
- `connection/errors.ts` omits absent HTTP trace IDs: GitGui's HTTP errors have
  no trace ID, and Effect's `optionalKey` rejects explicit `undefined`.
- `rpc/http.ts` schema-decodes error bodies and omits absent authentication
  reasons, so a bodyless or nonstandard 401 remains a typed authentication
  failure. GitGui's plain HTTP boundary must perform this decoding itself.
  The deadline encloses body decoding as well as receiving headers: unlike T3's
  `HttpApi` call, GitGui's raw request initially yields an unread response.

### GitGui's Svelte and authentication adapters

These adapters have no vendored counterpart. Browser primary discovery retains
its fragment credential in the lifetime of the application layer after stripping
history, so registration and authentication share it. Bearer inputs are
validated through `/api/auth/session`; bootstrap and pairing inputs are exchanged.
SSH restoration checks environment identity before using credentials, reuses a
valid saved bearer, and exchanges a supplied bootstrap only if needed. Permission
and transient failures do not trigger another exchange. Cached primary sessions
are likewise validated before reuse, recovering rejected sessions through the
current primary grant after a Rust server restart.

The platform catalog polls every three seconds, as T3's platform source does,
and also refreshes on foreground/online signals. GitGui reads the primary
through its desktop bridge or browser descriptor; typed discovery failures
retain the last successful registration. Explicit restart installs the returned
prepared endpoint immediately. The supervisor continues to own transport retry.
SSH disconnect carries the complete target identity used by preparation.
`connection/routes.ts` also includes `identityFile` in `sshTargetKey`, because
GitGui's desktop SSH manager supports separate connections selected by key.
T3's upstream route key omits this field.

The SSH adapter maps authentication and host-trust cancellation/rejection to
blocked errors, following T3's distinction between prompt/auth failures and
transport failures. GitGui currently identifies the manager's diagnostic
messages preserved by Electron IPC; network errors remain transient.

Explicit direct and SSH additions receive independent connection IDs, so one
environment can retain several routes of the same kind. Catalog selection is
stored separately and cannot be overwritten by stale catalog writes. Failed
removal reattaches the selected workspace; credential deletion follows a
successful catalog removal rather than preceding a potentially failed write.
The desktop store commits a cloned state by atomic file replacement before
publishing its cached state, so rejected writes cannot leak an uncommitted
registration or credential deletion into later reads or mutations.

Svelte watchers execute cancellation and consume the registry's `followStream`,
so both session and supervisor replacement are observed. A saved selection waits
for its registration before attaching. Switching environments disposes the old
workspace and promise readers, and asynchronous callbacks are guarded by the
selected environment and activation generation. Disposed workspaces cannot
recreate removed metadata after a pending load completes.

### TypeScript inference workarounds

Two upstream constructs do not typecheck under plain `tsc`, so they are
written differently here. The behavior is unchanged.

- `connection/driver.ts`: the route checks are forked in one `Effect.gen`
  block, because a `yield*` inside a conditional expression cannot be typed.
- `connection/registry.ts`: `catchTags` is written as `catch` with a named
  error type, because the pipe form cannot infer the error type when the
  callback has a contextual return type.

## Re-syncing with a newer T3 Code

1. Select a clean T3 Code checkout at the desired snapshot and inspect its changes.
2. Update the commit and tag in `scripts/t3code-vendored.json` and in all headers.
3. Run `npm run vendor:sync`. Read the drift report; use
   `node scripts/vendor-t3code.mjs --write` to copy changed verbatim bodies while
   preserving their headers. A rewrite intentionally still exits non-zero;
   rerun the check after reviewing it.
4. For every adapted file, apply the upstream change on top of the divergences
   recorded here, and update its header. Review every adapted body before
   accepting a new baseline.
5. Run `npm run check` and `npm test`.
6. Record the reviewed adapted hashes with
   `node scripts/vendor-t3code.mjs --record-adaptations`, then run
   `npm run vendor:sync` again. Commit the manifest with the reviewed changes.
