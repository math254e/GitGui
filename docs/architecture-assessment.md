# Architecture map and assessment

Snapshot: `origin/main` at `4c8c8bd`, reviewed 2026-11-08. This is a source
inspection of the main flows, not a security audit or a proof that every failure
case is covered. Selected tests were run; the full suite was not.

## System boundaries

```text
Svelte routes/components
  -> WorkspaceStore (presentation, interactions, actions)
  -> ApplicationWorkspace (application-wide tabs)
  -> WebApplicationRuntime / EnvironmentWorkspaceData
  -> ClientWorkspace (per-environment repository data and invalidations)
  -> client-runtime registry -> supervisor -> driver -> resolver / RPC session
  -> HTTP authentication + WebSocket RPC
  -> gitgui-server (auth, admission, handlers, catalog, events)
  -> gitgui-core (Git domain, parsing, caches) -> installed git / filesystem

Electron -> manages local server, credentials, native APIs, SSH and updates
Electron SSH -> tunnel -> ordinary HTTP/WebSocket server connection
```

This is a dependency and responsibility map, not a literal call stack: the
store reads several workspace/runtime projections directly. Electron is not in
the path of ordinary Git RPC. The Rust protocol crate generates shared wire
shapes; Electron bridge contracts are separate.

## State ownership and lifecycle

| State | Owner | Persistence or lifetime |
| --- | --- | --- |
| Environment identity, repository catalog and host paths | Server | Server data directory; identity and catalog JSON |
| Authentication grants and sessions | Server auth | `auth.sqlite3` for persistent auth data; sessions have their own lifetime |
| Connection registrations, profiles, credentials | Registry and platform adapters | Desktop protected credential store; browser origin storage |
| Application-wide tab order and active tab | `ApplicationWorkspace` / `WorkspaceTabCoordinator` | Browser local storage, including legacy migration and removal journal |
| Repository snapshots, loading/errors, refresh and invalidation | `ClientWorkspace`, one per environment | Memory; selected metadata and cached catalog in local storage |
| Session activation and hydration generation | `EnvironmentWorkspaceData` | Memory; superseded activation is aborted |
| Selection, dialogs, drafts, pending actions and presentation | Svelte `WorkspaceStore` | Mostly in memory, with selected preferences persisted |
| Git caches and repository watcher events | Rust server/core | Server process memory |

The root layout opts into external tab ownership. The application coordinator
projects tab targets into each environment workspace. The per-environment
workspace still supports a legacy tab ownership mode; it also maintains the
repository IDs needed to hydrate its own data. Those representations are related
but do not all claim to be the current authoritative application tab list.
See `apps/web/src/lib/client-runtime/application-workspace.ts`,
`apps/web/src/lib/connection/environment-workspace.ts`, and
`apps/web/src/lib/client-runtime/workspace.ts`.

On session replacement, the supervisor increments its connection generation;
the environment workspace aborts its prior activation, attaches the replacement
session and hydrates repository data. ClientWorkspace also uses per-request and
lifecycle generations to reject stale responses. Server watcher events are
batched into status or snapshot invalidations, and the client coalesces and
revalidates them. A lagging WebSocket event receiver is closed so the client
can reconnect and rehydrate. Removal involves a registry lease and a persisted
removal journal to avoid deleting data for a replacement registration.

## Request and Git lifecycle

1. The resolver prepares endpoint and authentication information. HTTP
   exchanges a credential for a scoped session; the client obtains a short-lived
   ticket for the WebSocket. The supervisor owns reconnection.
2. The server admits socket requests in a bounded per-session queue. Reads,
   prefetch, control and repository-ordered requests have different lanes.
   The queue classifies operations using the server's method-to-scope mapping.
3. Dispatch checks the session's scope, enters the server work barrier, validates
   parameters and resolves repository IDs against the server catalog.
4. Mutations use server-wide repository locks, including across sessions; the
   blocking Git work runs on Tokio's blocking pool. Some linked-worktree/stash
   operations also coordinate on the common Git directory.
5. Many mutations reload a snapshot and return it. A refresh failure after an
   applied mutation is marked separately, so the caller must not assume the
   operation itself failed. Watchers provide further invalidations for external
   and local changes.
6. Read cancellation suppresses a running response or removes a queued read;
   it does not terminate an already-started Git worker. Started dispatches
   retain their locks after socket disconnect until they finish.

See `crates/gitgui-server/src/rpc_queue.rs`, `src/lib.rs`, `src/watching.rs`,
and `src/stash.rs`. Queue limits are per socket, not a global limit on all
sessions; repository locks serve a separate cross-session purpose.

## Representative feature paths

- **Stage:** `WorkspaceStore.stageFile` -> client `git.stage` -> server validates
  paths and takes the repository mutation lock -> core runs `git add` with
  literal pathspecs -> server returns the refreshed snapshot. A client can
  adopt that snapshot and consume corresponding queued invalidation.
- **Switch branch:** the same action machinery calls `git.branch.switch`,
  passing the user preference for merge behavior. The server validates the
  branch argument, runs the core operation under the mutation lock, and returns
  a snapshot. The shared action machinery handles pending state and errors.
- **History and diffs:** server snapshot and graph handlers call core repository
  and graph code. The file viewer requests the appropriate commit, working-tree,
  or stash diff through the client. Git-generated patch and contents are parsed
  in a worker and rendered through a virtualized diff renderer. The component
  owns request/selection cancellation and hunk-review presentation state.
- **Selected stash:** the store captures an environment/repository context and
  reviewed selection, invokes the typed client, and interprets a structured
  receipt. The stash server validates selection size and paths, coordinates
  worktree/common-directory locks, and delegates capture and restoration logic
  to core. Existing stash actions check reviewed selectors against object IDs.
  This is a distinct workflow rather than the ordinary mutation/snapshot path.

## Assessment and priorities

1. **Browser credential persistence — confirmed exposure and policy mismatch to
   resolve.** `LocalStorageCatalogBackend.writeCredential` serializes bearer
   credentials to `localStorage`; it is separate from catalog records but not
   encrypted or protected from scripts running in the origin. The desktop
   backend uses the narrow protected-storage bridge. Assess credential lifetime,
   browser threat model and supported hosted flows against the project's rule
   that durable tokens must not be in ordinary plaintext settings. Do not assume
   all stored tokens are durable: lifetime depends on the issued credential.
   A change here touches authentication and connection lifecycle and must follow
   the T3 source-of-truth and failure-test requirements.
2. **RPC authorization coverage — confirmed structural risk, not a confirmed
   bypass.** The method registry, dispatch, scope map and queue classification
   must agree. `authorization_error` allows a method with no mapped scope to
   proceed to dispatch; unknown methods currently fall through to method-not-found,
   but a future dispatched method omitted from the scope map would not be
   rejected there. The existing `every_registered_method_is_dispatched` test
   checks one direction, and feature-specific tests check selected scopes. A
   source-level comparison found all 50 registered method constants in the
   current scope mapping; it does not verify that each assigned scope is correct
   or prove dispatch has no extra methods. Add
   an exhaustive authorization invariant before considering a design change:
   every registered/dispatched method must have the intended scope, with an
   explicit policy for any intentionally unscoped method. Also test lane semantics
   for mutations and previews. Check for exceptions before enforcing it.
3. **Workspace coupling — observed maintainability pressure.** The roughly
   2,650-line Svelte store coordinates unrelated feature workflows and imports
   component types. Application-wide and legacy per-environment tab handling
   coexist. Map dependencies and ownership before extracting a cohesive feature
   controller or shared presentation types; do not remove legacy migration or
   change tab lifecycle without evidence and failure tests.
4. **Server concentration — observed maintainability pressure.** The roughly
   5,000-line server `lib.rs` combines configuration, transport, scope mapping,
   handlers, state, persistence, and conversion. Existing extracted auth,
   watcher, queue and stash modules show useful seams. Separate one cohesive
   area at a time only when a real change needs it; preserve admission, lock,
   cancellation, scope and update-barrier semantics.
5. **Documentation drift — confirmed.** The architecture document described
   unscoped routes and per-store tab ownership after canonical environment-scoped
   routes and application-wide tabs had landed. Its routing section is corrected
   alongside this assessment. Other historical planning documents may also be
   stale and should be checked when used.

The runtime and server have nontrivial existing tests for offline and blocked
connections, generation replacement, removal recovery, watcher isolation,
cancellation, ordering and feature-specific authorization. These are evidence
of intentional lifecycle design, not proof of complete coverage. Next review
should inventory actual end-to-end failure coverage and inspect cross-session
and linked-worktree lock ordering, plus the browser credential lifecycle. No
broad refactor is justified from file size alone.

## Checks run

- `cargo test -p gitgui-server every_registered_method_is_dispatched` — passed.
- Client-runtime supervisor and removal tests — 17 passed.
- Web client workspace and application-workspace tests — 35 passed.
- `git diff --check` — passed.

## Follow-up: browser credentials

GitGui exchanges a one-use pairing grant for a scoped bearer session. The server
sets a 30-day session lifetime (`crates/gitgui-server/src/auth.rs`); a persistent
server stores a keyed digest and session metadata in SQLite, so that session can
survive server restarts. The browser `LocalStorageCatalogBackend` persists the
bearer value as JSON under an origin-scoped key and reads it after reload.
Environment removal deletes its key. Older catalog records containing inline
credentials are migrated into that same browser credential store. Electron uses
its separate bridge and OS-backed encryption. Origin storage separation does not
protect the browser bearer from scripts executing in that origin or someone with
access to the browser profile. Server-side expiry does not remove the local
value automatically. A 30-day recoverable bearer conflicts with the project
rule against durable tokens in ordinary plaintext settings.

The local T3 checkout at `/data/references/t3code` (`1688f96568`) documents
browser-cookie, bearer, and proof-bound session variants under the same scoped
session model (`docs/internals/environment-auth.md`), and hosted clients directly
connect to environments (`docs/internals/remote.md`). GitGui currently implements
bearer authentication and ticket-based WebSocket upgrades; T3's cookie support
cannot simply be enabled in this server.

Recommended follow-up: design browser authentication as a distinct adapter to
the existing server-owned session model. Evaluate a server-issued HttpOnly,
Secure cookie for supported same-origin deployments and explicitly resolve
cross-origin hosted clients, browser third-party-cookie restrictions, CORS,
CSRF/origin validation, HTTPS requirements, and session revocation before
implementation. An in-memory bearer is a smaller interim option, but requires
pairing again after a reload and does not stop malicious script from acting
while the page is open. `sessionStorage` still exposes the bearer to scripts
and is not protected credential storage. Whichever approach is selected must
cover migration/removal of existing stored credentials, scope preservation,
reconnect, and server restart without weakening the Electron path. No browser
authentication behavior was changed as part of this review.

## Follow-up: workspace lifecycle

Opening a repository first prepares its snapshot against a particular environment
service and generation. `WorkspaceTabCoordinator` persists the application tab
before publication; then `ApplicationWorkspace` projects its targets and any
matching prepared data to environment workspaces. A changed session generation
rejects the old preparation. Reconnect retains the application tab list while
`EnvironmentWorkspaceData` replaces its session and rehydrates its targets.
Explicit removal uses the registry's durable removal and journal; application
tab deletion is retried and acknowledged under the registry's removal protocol.

The root uses external tab ownership, but the legacy metadata reader is needed
for one-time tab migration, including an environment discovered late. Existing
tests cover failed tab persistence, session replacement, independent environments,
removal retry and migration. No safe deletion of the legacy path follows from
this trace alone. A future simplification should first establish whether the
legacy `ClientWorkspace` mode has any live callers beyond compatibility and
tests, then separate that decision from preserving the metadata migration.

## Follow-up: authorization guard

The server now rejects unmapped methods before queue admission and again at
authorized dispatch, preserving the method-not-found response for unknown names.
An independent inventory test requires an explicit reviewed scope for every
registered RPC, and a queue test checks ordered handling of mutation/management
methods and locking previews. The existing dispatch inventory test checks that
registered methods have handlers. These checks complement feature-level
behavioral authorization tests; the test inventory still requires review when
an RPC or its intended scope changes.

## Deeper investigation: desktop persistence and Git data

### Desktop state can be overwritten after an unsuccessful read

**Fixed after reproduction.** Previously, `DesktopStateStore.load()` caught
all file-read and JSON errors and cached an empty state; it also treated an
unsupported top-level schema as empty and silently filters invalid individual
records (`apps/desktop/src/state-store.ts`). A subsequent successful mutation
could clone that state and atomically replace `desktop-state.json`. Consequently,
malformed JSON or an unsupported schema can be overwritten with an incomplete
catalog and credentials after a normal save. A transient read failure could also
leave empty state cached for the process lifetime. An exploratory test reproduced
the overwrite. The store now initializes an empty state only for a missing file;
unreadable, malformed, unsupported, or invalid records fail without a write, and
later reads can retry after repair. Tests cover these failures and legacy version 1
files without environment names. The local T3
reference's `DesktopConnectionCatalogStore.readDocument` distinguishes NotFound
from read and document-decode errors.

### Stash read errors become an empty list

**Confirmed by control flow; partial-failure visibility risk.**
`gitgui-core/src/git/repository.rs::load_repository_impl` uses
`load_stashes(...).unwrap_or_default()`. If stash loading fails, the snapshot
reports no stashes and proceeds to build history without them; a genuinely empty
stash and a failed stash read are indistinguishable to the client. Other snapshot
sections propagate errors. The appropriate fix needs a product decision about
whether to fail the full snapshot or expose a partial error while retaining
usable status and history; it must also preserve compatibility and consider
refresh after an already-completed mutation. A concrete failing-Git fixture and
recovery test should precede a change.

### Cache eviction has a load-ownership race

**Fixed after unit-level reproduction; end-to-end impact was not established.**
The commit diff cache removes an in-flight entry on `evict_repo` and wakes its waiters. A new
request for the same key can start a replacement load before the original load
returns. Previously `finish_diff_load` identified the in-flight load by key only,
so the original worker could remove and complete the replacement entry with its
own result. Commit-file-list reads likewise inserted after loading without checking
whether their repository was evicted in the meantime. The relevant code is in
`crates/gitgui-core/src/git/cache.rs` and server `load_commit_*_cached` helpers.
A temporary deterministic unit experiment reproduced the sequence: start a
load, evict its repository, start a replacement for the same key, then complete
the original; the cache returns the original result as the replacement's cached
value. Completion now checks the specific in-flight owner; file-list reads use
a per-repository eviction token. An evicted initiating load returns an error.
Regression tests cover replacement owners, waiters and independent repositories.

### Filtered graph work is not bounded by visible graph size

**Confirmed behavior, performance concern pending measurement.**
`load_repository_graph` first invokes `load_repository`, which reads status,
worktrees, refs, stashes and full reachable commit history and builds the full
graph, before selecting reachable commits and building the filtered graph. The
client requests this when refs are hidden. The frontend virtualizes graph rows
and indexes visible edges, but that controls rendering cost, not this server
computation or payload. Profile representative large repositories before
optimizing.

An exploratory local debug-build measurement used an isolated synthetic linear
history of 10,000 commits, selecting an ancestor with 1,000 reachable commits.
Three `load_repository_graph` calls took 277, 270, and 273 ms. This confirms
measurable work in that fixture, but is not a production benchmark: it omits
network and UI costs, uses a warm local repository and a debug build, and does
not model merge-heavy history. Measure release builds on representative real
repositories before choosing an optimization.

### Cross-session and linked-worktree coordination

Socket request ordering is per session; `git_mutation_lock` coordinates a given
registration across sessions. Stash mutations additionally lock the canonical
common Git directory shared by linked worktrees and invalidate known linked
registrations. Worktree removal takes relevant registration locks in sorted
order; stash code explicitly avoids acquiring another registration lock while
holding the common lock. Tests exercise concurrent linked and legacy stashes,
worktree lock retention, disconnect and partial outcomes. This supports the
intended model for those paths, but is not proof that every shared-ref operation
across linked worktrees is serialized: ordinary branch/tag operations use their
registration lock, while Git supplies its own ref locks. Evaluate concrete
cross-worktree conflicts before extending lock scope.

### UI and desktop implementation shape

Git graph topology and lanes are calculated in Rust; the Svelte client builds
viewport/edge indexes and renders visible rows on canvas. Diff content and patch
originate on the server, with browser workers and virtualized rendering. The
1,236-line `GitGraph.svelte` and 1,000-line `CommitFileDiffViewer.svelte` still
mix interaction, presentation and asynchronous view coordination even though
helpers have been extracted. These are additional maintainability hotspots, not
proof that the backend/frontend boundary is crossed incorrectly.

Electron's backend manager owns the exact child process, readiness and descriptor
probe, passes bootstrap on stdin, and coordinates an update drain. SSH uses
OpenSSH, verifies the environment identity over its forwarded endpoint, and
tracks remote ownership and cleanup separately. Both have focused lifecycle
tests; a comprehensive audit of platform-specific process and SSH behavior is
still outstanding.
