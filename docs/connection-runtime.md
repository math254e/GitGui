# Connection runtime

GitGui's client runtime is T3 Code's client runtime, adapted to Git. This
document describes the runtime as it exists here. The vendoring rules, the
upstream snapshot, and the per-file divergences live in
[t3code-vendoring.md](./t3code-vendoring.md).

## Concurrent request lifetime

The session correlates responses by request ID; independent reads may finish
out of order. Pending registration and cleanup are protected from interruption.
Timeouts and caller interruption remove the pending entry and, when the welcome
advertises `rpc.cancel`, send `{ "type": "cancel", "id": "request-…" }`.
Older protocol-v2 servers receive no cancellation notification. This is an
additive capability, so the protocol version remains 2.

Cancellation belongs to the current socket and applies only to read methods.
The server answers a cancelled read's original ID with `request_cancelled`;
missing, completed, repeated, and mutation cancellations are ignored. Late
responses cannot complete another call. The Promise bridge accepts an
`AbortSignal` for file diffs and hunk previews and interrupts their Effect calls.
The viewer aborts both requests when selection changes or it is destroyed.
Session termination fails all pending calls and sends no cancellation frames.

The Rust socket loop keeps reading frames and events while dispatches execute.
Each session admits at most 128 pending/running requests, with eight independent
reads, eight repository operation lanes, one prefetch, and one control request
able to run concurrently. Operation lanes preserve arrival order per repository,
including working-tree file diffs that prepare hunk continuations and lock-sensitive
hunk/discard/amend previews. Ordinary file diffs remain independent reads. The existing server-wide
repository mutex still serializes operations from different sessions. Ordering
between different sockets is determined by that mutex, not a global wire order.
Read snapshots retain their existing semantics when another session mutates.

Overload returns `server_busy` without closing the socket. Reusing a pending or
running ID returns `duplicate_request_id`; clients must keep IDs unique for
the session. Parse failures, scope checks, Git errors, binary JSON, and event
delivery continue through their existing protocol paths.

Cancellation removes queued reads immediately. Started dispatches retain their
slots and repository guards until completion, and their late responses are
suppressed. Disconnect drops queued work and detaches started dispatches so a
live blocking worker cannot lose its lock. A mutation already dispatched may
complete after disconnect; clients must revalidate rather than replay it.

Commit-diff hints retain the one-target protocol limit from issue #7. File-list
hints validate every supplied hash but process at most one. Both report the
number actually processed in `count`. Their separate slot keeps a
large hint out of the interactive read queue. Only one additional hint may
wait; excess hints receive `server_busy` so prefetch cannot fill session
admission capacity. This deliberately trades cache
warming for bounded work; choosing which target to warm remains GitGui policy.
Git subprocesses still have no cancellation/deadline support: up to eight
already-started obsolete reads per session can delay further reads until a
worker finishes. This change bounds their count, not their execution time.

Regression coverage lives in `rpc/session.test.ts` and the server's
`rpc_queue.rs`/`rpc_tests.rs`, including out-of-order errors, aborts/timeouts,
late replies, bounded admission, mutation order, and a disconnect during a
blocked pre-commit hook.

## One transport retry owner

The [supervisor](../packages/client-runtime/src/connection/supervisor.ts) owns
transport retry policy; resolving an endpoint and opening an RPC session are
single attempts. Transient failures retry with jittered exponential backoff,
capped at five minutes, that resets only after a connection stays up. Without
jitter, every client of a restarted server reconnects in the same second; with
a short cap, a client that can never connect retries all day. Offline states
and authentication failures wait for a wakeup instead of spending attempts on
unchanged conditions.

Foregrounding, an explicit retry, and an offline report probe the established
session, and only a failed probe reconnects. Offline reports are often wrong,
for example for a loopback server. Foregrounding also wakes a pending retry
immediately and leaves an ordinary in-flight attempt alone.

The [registry](../packages/client-runtime/src/connection/registry.ts) scopes
connections by environment. An involuntary disconnect retains the registration
and cached data. Explicit removal closes the scope and clears credentials,
projections, and platform-owned state such as drafts.

Platform discovery follows T3's catalog polling pattern: it refreshes every
three seconds and on foreground/online signals. Discovery failures are typed
and leave the last successful registration intact; an initial failure can
recover before any supervisor exists. Port changes replace the primary target,
while unchanged discovery does not replace a healthy supervisor. An explicit
desktop restart installs the prepared endpoint immediately. This catalog
refresh does not open sockets or own transport retries.

## The layers

```text
EnvironmentRegistry
  -> EnvironmentSupervisor
     -> ConnectionDriver
        -> ConnectionResolver
        -> RpcSessionFactory
```

- The backend-issued `EnvironmentId`, not a URL hash, identifies an
  environment.
- The resolver prepares endpoint and authentication information.
- The driver and the session factory perform one attempt and never retry.
- The supervisor is the only retry owner.
- Transient failures retry indefinitely with capped backoff.
- Auth, permission, invalid configuration, and incompatible protocol failures
  block until external state changes.
- Offline state releases transport without consuming retry attempts.
- Foreground and wakeup probes active sessions.
- A replacement session advances an environment generation.
- Queries revalidate, subscriptions switch, and mutations resolve the current
  session after a generation change.
- Explicit environment removal disposes registration, credentials, session,
  supervisor, cache, and client workspace state.

## The GitGui envelope

The GitGui server is Rust and speaks the GitGui JSON envelope. A session
multiplexes three message kinds over one WebSocket:

- `welcome` — the server's environment identity, protocol version, and
  capabilities. A session that receives a welcome for another environment, or
  for an incompatible protocol version, is blocked.
- `response` — the answer to one request, addressed by the request's `id`.
- `event` — an ordered server event, addressed by a monotonic `sequence`.

A request is one JSON object with an `id`, a `method`, and its `params`. The
method names are canonical and live in
[contracts](../crates/gitgui-protocol/src/lib.rs), which publishes them as
`WS_METHOD_NAMES`; the generator writes them into the TypeScript contract, and
[rpc/protocol.ts](../packages/client-runtime/src/rpc/protocol.ts) maps every
method to its payload and its result. A call is therefore checked against the
server's own definitions, and a test fails when the two lists drift apart.

A session is ready once the welcome arrived and the server described itself.
A probe answers with `server.get_status`.

## The session's own rules

The session owns the request lifecycle, because the envelope has no framing of
its own:

- A request registers a pending entry, and the entry is removed on every exit:
  a response, a rejection, a timeout, an interruption, or a failed write. A
  closing session refuses new requests rather than registering them.
- Opening the socket and completing the handshake are separate stages, and the
  welcome has its own deadline. A server that accepts the socket and never
  greets fails the handshake instead of hanging the connection.
- The first reason to end the session wins. A deliberate block, such as an
  incompatible protocol version, stays blocked when the socket closes after
  it, so the supervisor does not retry the environment as a transient failure.
- The reader always reports the end of the session, and closing the scope
  closes the socket and clears the pending requests.
- The event stream is lossless and ordered, and the server's monotonic event
  sequence is watched. A hole is reported as a gap so the consumer can
  resynchronize, and the publication never blocks, so a slow subscriber
  cannot delay an RPC response on the same connection. Every consumer has its
  own scoped subscription. The promise client disposes its readers when its
  workspace is replaced; the session closes all subscriptions on shutdown.

## Authentication

Loopback is not authentication. Local and remote backends use the same session
model.

- The desktop shell creates the primary bootstrap credential and keeps it in
  the operating system's protected credential store.
- The client exchanges a bootstrap or pairing credential for a scoped bearer
  session through `POST /oauth/token`, retaining the server's credential grant.
  Bootstrap sessions include repository catalog management so the desktop can
  open/create/remove repositories; ordinary pairing sessions remain limited to
  reading and operating on repositories already available on the host.
- The client asks for a short-lived, single-use WebSocket ticket through
  `POST /api/auth/websocket-ticket` and puts it in the socket URL.
- Every RPC method is authorized against explicit GitGui scopes by the server.
- Durable tokens never appear in URLs, logs, generated bundles, crash reports,
  or ordinary desktop settings. Non-secret catalog records and credentials use
  separate backend operations; Electron protects credentials through its native
  bridge, while the browser uses separate origin-scoped credential storage.
- Discovery strips browser fragment credentials from history and retains them
  for authentication within the application layer. Existing bearer sessions are
  validated directly, including cached primary sessions; bootstrap and pairing
  credentials are exchanged. A primary session rejected after a server restart
  can use the desktop's current bootstrap grant. Permission and transient
  failures do not trigger credential exchange.
- SSH verifies the prepared environment identity, reuses a valid saved bearer,
  and issues/exchanges a one-time OS-owner pairing grant only for a missing or
  rejected bearer. Pairing is independent of launch and also works on reuse.
  Its repository-management scope does not include access administration. Permission failures
  and transient failures remain classified for the supervisor. Disconnect uses
  the complete SSH target (host, user, port, and identity file), so cleanup
  reaches exactly the bridge that was prepared.

The discovery and authentication surface is:

```text
GET  /.well-known/gitgui/environment
GET  /health
GET  /ready
POST /oauth/token
GET  /api/auth/session
POST /api/auth/websocket-ticket
GET  /ws
```

## The Svelte adapter

The runtime is framework-independent TypeScript. The web application mounts it
once at the application root in
[runtime.ts](../apps/web/src/lib/connection/runtime.ts), and the platform
services it needs live in
[platform.ts](../apps/web/src/lib/connection/platform.ts). Routes and
components never own sockets, retries, credentials, Electron detection, or SSH
behavior.

The workspace layer still speaks promises, so the runtime exposes one
promise view of the Effect session in
[rpc/promise.ts](../packages/client-runtime/src/rpc/promise.ts). That file is
the only bridge between the two worlds, and it is marked as such.

The adapter consumes the registry's `followStream` for both supervisor state and
sessions, including replacement of the entire supervisor. Saved selection waits
for asynchronous registration. Switching environments interrupts old watchers,
disposes old workspace/event readers, and invalidates asynchronous activation.

Catalog records retain profiles for every saved or learned route. Updates share
a catalog lock across environments. Earlier records containing inline credentials
are moved to the credential backend and rewritten without the secret. Explicit
removal clears the credential, registration, profiles, and environment workspace
metadata while leaving other environments intact. Disposed workspaces cannot
rewrite metadata after a delayed load.

Each explicitly added direct or SSH route gets an independent persisted
connection ID. Adding a different address to the same environment retains the
previous routes; the registry still deduplicates repeated addresses. SSH route
identity includes the identity file, matching the desktop manager, so different
keys for the same host/user/port remain separate options.

Selection has one source of truth in its separate client setting. Catalog
writes never replace it with a stale catalog snapshot; removing the selected
saved environment clears it. If removal fails while the session remains
registered, the adapter reattaches its workspace. A failed catalog write does
not delete the credential first. The desktop store writes a cloned candidate
state and publishes its cache only after the atomic file replacement succeeds.
Failed writes or renames leave cached registrations and credentials intact, and
later mutations start from the last committed state.

HTTP error bodies are validated before classification. Empty or nonstandard
401 bodies remain authentication failures without a schema defect. The HTTP
deadline covers the complete request, success/error body read, and JSON/schema
decoding. A peer that sends headers and stalls its body cannot block discovery
polls indefinitely; timeout interrupts and aborts the body read.

The server's CORS allowlist includes Effect's default `b3` and `traceparent`
request headers, following T3 Code's `apps/server/src/httpCors.ts`. Both the
Electron renderer and hosted browser client enforce preflight checks, including
for discovery. Only configured client origins are allowed. Node-based live
tests do not enforce browser CORS; the server regression test exercises renderer
preflights for discovery, token exchange, and WebSocket tickets.

SSH authentication cancellation/rejection and host-trust cancellation/rejection
are blocked failures requiring external action. The preload reconstructs typed
categories from bounded IPC results; diagnostic text is not the classification
contract. Network failures remain
transient. Cancelling a prompt therefore does not start a repeated prompt loop.
An explicit retry asks the supervisor to attempt the connection again.

## Desktop-managed SSH acquisition

The scoped SSH source set is pinned separately from the client runtime; see
[source compatibility](ssh-source-compatibility.md), [host runner](ssh-host-runner.md)
and [host authentication](ssh-auth.md). The Rust helper contract is private and
versioned independently of Git RPC. Normal descriptor/auth/Git traffic continues
directly over HTTP/WebSocket to the locally reserved loopback forward.

The shared onboarding service verifies a temporary authenticated RPC welcome and
initial info response before persistence. Electron atomically replaces the
non-secret registration and its protected credential. New registrations are
durably staged disabled, the host acquisition is claimed, the record is enabled,
and ownership is handed off before the ordinary supervisor is published. This
commit/activation boundary is masked against interruption. Failed claim leaves
a disabled record that can be retried or removed, including after restart.

The gateway installs a scope finalizer before its first IPC call, using a UUID
reserved by the renderer. Interruption therefore cancels actual desktop work
even if no launch result was received. Successful ownership handoff disarms the
temporary scope. A replacement RPC connection claims and takes ownership before
releasing the prior handle for that connection ID; a failed attempt preserves
the old handle. This does not add a reconnect loop. The supervisor remains the
only retry owner, and uncertain mutations are never replayed.

Cancellation and explicit-disconnect IPC have a 20-second outer budget, enclosing the desktop's bounded
host cleanup and local tunnel termination. Lost replies/rejections report
`cleanup-pending`, and shared resources can report `retained`; settings display
the outcome without claiming observed remote exit. Desktop journals retain the
non-secret acquisition/instance/locator information needed for reconciliation.

Saved SSH profiles retain an explicit canonical remote data-directory locator
after identity validation. Old profiles use the exact legacy key only to locate
their existing directory; conflicting identity or unverifiable old ownership
blocks instead of launching against another catalog. New routes use the ordinary
per-user environment, independently of SSH alias, port or identity-file changes.
EnvironmentId and ConnectionId retain their existing meanings.

Settings also exposes optional existing-directory recovery. It requires the
saved environment ID before acquiring that directory, and carries the expected
identity through onboarding so a mismatch fails before credential exchange.
This selects existing state; it does not establish ownership of a pre-helper
process whose ownership evidence is missing.

Discovery/auth JSON is schema-decoded from a bounded 256 KiB stream; redirects
are rejected, and deadlines include headers and body consumption. A descriptor
and the saved expected identity must agree before any credential is sent or a
new pairing grant is requested.

For the primary restart regression, build the Rust binary and run:

```sh
cargo build -p gitgui-server
GITGUI_IT=1 npm run test -w @gitgui/web -- src/lib/connection/restart.live.test.ts
```

This opt-in test uses real servers with isolated persistent state and a desktop
bridge fixture. It verifies automatic crash recovery, explicit restart onto a
new port, and reopening with cached credentials. It stops only its own server
processes. It does not exercise Electron itself or a real SSH transport.
