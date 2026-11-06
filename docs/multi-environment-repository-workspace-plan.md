# Repository workspaces across environments

Date: 2026-11-04. Status: implementation started with shared workspace
primitives, duplicate-safe worktree switching, persistent independent catalog
projections per environment, tab metadata migration primitives, and a Rust
identity parser. The multi-environment UI, catalog identity discovery and
application-wide tab ownership are not yet connected.

Implementation note: the application coordinator now releases reservations
when their source tab closes or either involved environment is removed. An
older preparation cannot release a newer reservation for the same target.
Legacy migration orders unselected environments deterministically. Scoped URL
construction and legacy ambiguity resolution are available as helpers, but
are not mounted routes: the existing UI still uses its selected environment
and per-environment tab writer. These helpers do not yet provide the planned
multi-environment behavior. No vendored T3 file or snapshot was changed.

## Goal and agreed interactions

Organize GitGui around repositories available across environments, with each
open tab bound to one actual checkout. There is no application-wide active
environment. Selecting a tab determines only the context displayed by that tab.

The agreed product behavior is:

- The repositories home groups copies of the same repository and identifies
  which environments contain them. Multiple locations remain accessible.
- A repository's environment/location section goes at the top of its sidebar.
  Hide it when the repository is only local; keep the existing Worktrees section.
- An environment with one repository location is one root-level selectable row.
  Only environments with multiple locations have an expandable parent row.
- Clicking a location switches the current tab to that repository/environment.
  Its context menu offers **Open in new tab**.
- The worktree context menu also offers **Open in new tab**.
- A specific checkout can appear in only one application tab. Trying to open it
  again, or switch another tab to it, produces an error. It must not merge tabs,
  silently close a tab, or silently focus the existing tab instead.
- Different environments, different clones in the same environment, and
  different linked worktrees may be open simultaneously.

The following sections distinguish those requirements from proposed technical
translations and remaining presentation choices. This document does not approve
unrelated Git features or implementation work.

## Research baseline

- GitGui: `D:/ProgrammingProjects/GitGui`, branch `main`, HEAD
  `d11075e7c52f64c5ea50898c19e38f388dd8d465`. Git reported a clean tree before
  this document was added. The earlier supplied baseline `11149a2...` and dirty
  index description no longer matched the checkout; no state was reverted.
- T3 Code: `D:/GitHub/PictureTagingApp.references/t3code`, HEAD
  `70cd258d8aac43ea57494527b00bf36de3efa6c0`.
- GitGui's vendored runtime remains pinned to
  `1688f965682d331da16a8c39f049592361f69c8d`. This research does not resync it
  or change Effect / `@effect/vitest` 4.0.5.
- Read `AGENTS.md`, the full remote reliability plan, the applicable architecture
  and runtime documents, and T3's workspace-layout, connection-runtime, remote,
  and environment-auth internals documents. Source behavior below takes
  precedence over broad or stale roadmap descriptions.

All investigation was local source inspection. No application build, development
stack, browser session, SSH connection, Agentbox action, or deployment was used.

## What T3 actually does

Paths in this table are relative to the T3 checkout at the commit above.

| Concern | Inspected source | Observed behavior and GitGui translation |
| --- | --- | --- |
| Repository identity | `apps/server/src/project/RepositoryIdentityResolver.ts` and its tests | Resolves the Git top-level directory, reads fetch remotes, chooses `upstream`, then `origin`, then the alphabetically first remaining remote. No usable remote means no logical identity. Rust should own this resolution in GitGui. |
| URL matching | `packages/shared/src/git.ts`, `normalizeGitRemoteUrl`, and `git.test.ts` | Trims trailing slashes and `.git`, lowercases, and normalizes supported URL and SCP forms to host/path. Tests intentionally equate HTTP/SSH ports. Use those matching semantics for grouping, with the credential-redaction adaptation described below. |
| Logical versus physical projects | `packages/client-runtime/src/state/projectGrouping.ts` and its tests | Logical key is the normalized repository identity; physical key includes environment and normalized workspace path. Grouping retains every physical clone. Without identity, projects remain physically scoped. |
| Multiple clones on one environment | `packages/client-runtime/src/state/projectGrouping.test.ts` | Explicitly verifies three paths in one environment survive as three selectable members of one logical group. Do not key locations by environment alone. |
| Home/sidebar grouping projection | `apps/web/src/sidebarProjectGrouping.ts`, `environmentGrouping.test.ts` | Adds environment labels and local/mixed/remote presence to groups while retaining member project refs. The representative is presentation/default-selection data, not an execution target for all members. |
| Scoped references | `packages/client-runtime/src/environment/scoped.ts`, `state/models.ts`, `state/projectEntities.ts` | Projects and threads carry an EnvironmentId. Aggregated project state iterates the environment catalog and scopes every member. Identical local IDs from two servers do not collide. |
| Routes | `apps/web/src/threadRoutes.ts`, `routes/_chat.$environmentId.$threadId.tsx` | Canonical routes include the owning environment. Routes resolve scoped objects rather than consulting a global current server. Translate to environment-scoped repository routes. |
| Environment selector | `apps/web/src/components/ChatView.tsx`, `BranchToolbar.tsx`, `BranchToolbarEnvironmentSelector.tsx` | Builds candidates from the current logical group, but the chat selector deduplicates to one physical project per environment. Changing environment changes draft context, and started conversations lock that context. This selector cannot be copied as GitGui's multi-clone selector. |
| Worktree context | `apps/web/src/hooks/useActiveProjectTarget.ts`, `hooks/useHandleNewThread.ts`, `components/Sidebar.tsx` | Effective filesystem context is the thread's worktree path or its physical project's workspace root, always with EnvironmentId. Draft reuse and cleanup are conversation behavior. Copy context scoping, not draft reuse or conversation-owned worktree deletion. |
| Data lifetime | `packages/client-runtime/src/state/runtime.ts`, `state/shell.ts`, `rpc/client.ts`, `connection/registry.ts` | Environment-scoped queries/commands use the registry; commands resolve the current session and subscriptions follow replacement sessions. Lightweight shell data and sync state are separate from connection state and detailed views. |
| Desktop/SSH boundary | `apps/desktop/src/ssh/DesktopSshEnvironment.ts`, `packages/ssh/src/tunnel.ts` | Desktop adapts discovery, prompts and the scoped SSH manager. Ordinary application views consume environment endpoints. No new desktop Git or grouping service is needed. |

T3's grouping is automatic correlation of already-known projects. These sources
do not implement a filesystem-wide search for every clone on every host.
GitGui's translation is to combine the repository catalogs of registered
environments. Searching unconfigured folders is a separate feature, outside
this proposal.

T3 does not supply the requested GitGui repository-tab policy. Its navigation
units are projects, conversations and drafts; browser-preview tabs and right-panel
tabs are different features. The single-checkout-per-tab rule, tab replacement,
and environment section placement are GitGui product decisions.

### Matching details to preserve

Use T3's remote preference and normalized key, including its handling of forks
with an `upstream` remote. Do not invent matching by folder name, branch name,
commit history, an SSH alias, or the first matching URL among all remotes.
For example, SSH and HTTPS URLs for the same host/owner/repository group
together. Different Git transport routes to the same EnvironmentId do not
produce additional locations.

The key is best effort: lowercasing can conflate case-sensitive paths, ignoring
ports can conflate separately hosted repositories, and SSH aliases are not
resolved into canonical Git-host names. Preserve T3's selected behavior and
document these limits. A key is never authorization, a filesystem locator, or
an RPC routing identifier, so even an imperfect group retains separate targets.
No new grouping override UI is part of the initial scope; T3's optional grouping
modes and overrides are reference material, not an approved settings expansion.

## Current GitGui gaps confirmed in source

| Current code | Consequence |
| --- | --- |
| `apps/web/src/lib/connection/runtime.ts`: one `selectedEnvironmentId`, `sessionWatcher`, `activeSession`, and `workspace`; `applySelection()` clears the old workspace | Supervisors can coexist, but the application can render/hydrate only one environment workspace. Environment switching currently replaces the complete data context. |
| `apps/web/src/lib/client-runtime/workspace.ts`: per-environment `openRepositoryIds` and `activeRepositoryId`; session-bound client | Tabs and hydrated data are coupled to one environment and one RPC session. Recreating that workspace is unsuitable as the owner of application tabs spanning environments. |
| The same file: `switchRepositoryPathOperation()` filters out both old and replacement IDs before inserting the replacement | Switching to a worktree already open elsewhere can collapse two tabs. This conflicts directly with the requested duplicate error. |
| `apps/web/src/lib/workspace/types.ts`, `components/TopMenu.svelte` | Tabs use a bare repository ID; the tab type has no EnvironmentId. Equal repository IDs from different hosts can collide. |
| `workspace/routes.ts`, `repository-routing.ts`, `routes/repo/[repositoryId]/+page.svelte`, `workspace/deep-links.ts` | Repository routes and deep links identify only the local repository ID and rely on selected-environment state. |
| `workspace/workspace-store.svelte.ts`: catalog refresh, active client/workspace, action queues, scroll and prefetch maps | The home catalog and several caches assume one environment. Queued action closures such as stage/unstage resolve mutable `this.client`; adding mixed-environment tabs without changing this can send work to the wrong server. |
| `components/settings/ConnectionsSettingsPanel.svelte` | Environment selection lives in Settings as **Use**. Connection setup already exists, but its selection action changes the entire workspace. |
| `components/StartView.svelte` | Renders one catalog without environment identity/presence and treats open/create as generic actions. |
| `chooseRepository()` / `browseCreateRepositoryLocation()` | Desktop capability alone selects a client-local folder picker, even when the executing server is remote. The resulting client path is sent to that server. |
| `crates/gitgui-protocol/src/lib.rs`: `RepositorySummary` | Has canonical paths, host-local ID, name, `isWorktree`, and optional `missing`, but no repository matching identity or explicit clone/worktree-family identity. |
| `crates/gitgui-server/src/lib.rs`: `repository_summaries()` and catalog upsert | Catalog list returns configured entries; it currently checks missing directories, rather than resolving identities. Existing IDs are derived from canonical checkout roots and preserved on upsert. |
| `components/Sidebar.svelte`, `WorktreeTree.svelte`, `workspace/worktree-menu.ts` | Worktrees already have a compact tree and keyboard context menus. Switching is currently double-click; context menu has rename/removal, but no open-in-new-tab action. |

These are a migration within the completed Electron/client-runtime architecture,
not a reason to add another connection manager, global backend selector, or
desktop Git proxy.

## Identity and model

Keep four different concepts explicit:

| Concept | Identity | Owner / use |
| --- | --- | --- |
| Logical repository group | T3-compatible normalized remote key, or a physically scoped fallback | Derived client grouping; never a mutation target. |
| Clone/worktree family | EnvironmentId plus an opaque key for the canonical Git common directory | Rust-derived relationship between one clone's main checkout and its linked worktrees. Separate clones in one environment have separate families. |
| Checkout target | `{ environmentId, repositoryId }` | One canonical server catalog entry, including an opened linked worktree. All repository RPCs target this pair. |
| Application tab | Stable client-generated `tabId`, with a checkout target | Client-owned ordering and view state; replacing the checkout keeps the tab's position and tabId. |

The server already assigns different repository IDs to distinct checkout roots,
including worktrees. Preserve those IDs and their existing catalog entries.
Never replace them with a logical grouping key. Composite client keys should use
unambiguous tuple encoding, such as JSON arrays, rather than concatenating paths
and identifiers with an unchecked separator.

Proposed client-only shapes:

```ts
type ScopedRepositoryRef = {
  environmentId: string;
  repositoryId: string;
};

type RepositoryTab = {
  tabId: string;
  target: ScopedRepositoryRef;
};

type ApplicationWorkspace = {
  tabs: readonly RepositoryTab[];
  activeTabId: string | null;
};
```

Snapshots, selections, commit drafts, scroll positions, filters and in-flight
operations belong to the checkout key. A replacement tab must not carry a
different checkout's draft, selection or pending review into its new target.
Returning to a previously visited checkout can reuse its own saved view state.

### Minimal server metadata

Extend existing `RepositorySummary` additively, starting in Rust and generating
TypeScript. Proposed optional fields are:

- `repositoryIdentity`: a safe canonical comparison key and optional display
  name, derived using T3's remote selection/normalization.
- `worktreeFamily`: an opaque family key and canonical main-worktree root,
  resolved by installed Git from the common directory and worktree metadata.

The family metadata is a concrete GitGui adaptation: T3 projects retain one
physical project while conversations refer to worktree paths; GitGui registers
individual checkout paths as catalog entries. The relationship is needed to
avoid presenting every opened linked worktree as a new independent clone and to
correlate linked worktrees without a Git remote. Do not infer it from the display
name or assume every `.git` file is the same kind of repository layout.

Keep wire metadata small. The frontend does not need full remote configuration
or raw remote URLs to group. T3 includes a locator with `remoteUrl`; GitGui should
omit that raw locator and redact credentials before deriving any persisted or
displayed key. Unsupported URL shapes that cannot be safely normalized/redacted
produce no cross-host identity. Never carry a remote token into labels, logs,
cache keys, URLs or screenshots. This is a security adaptation, not a different
preferred-remote matching policy.

Resolve metadata in the Rust Git core/server, using the existing bounded Git
runner. Cache successful and negative identity results, initially following
T3's one-minute TTL, with bounded concurrency and invalidation after observed
Git configuration changes. Work outside catalog write locks. One inaccessible
repository must not fail the rest of the catalog. Missing directories retain
their entries and last known identity with explicit availability/freshness.

Existing `repositories.list`, open and snapshot responses carry the metadata;
no identity-search RPC or new discovery service is needed. An additive capability
can distinguish support from an individual repository having no usable remote.
Older servers remain usable through physical fallback grouping.

No remote means no automatic cross-environment or independent-clone match,
following T3. Known linked worktrees can share the physically scoped family
fallback; unrelated no-remote clones remain separate.

## Ownership and data flow

### Keep the existing connection runtime

Retain one registry, one supervisor per environment, and the existing resolver,
driver and session factory. Saved registrations can already run independently.
Tab clicks never create supervisors, reconnect loops, SSH processes or sockets.

Replace the Svelte adapter's single selected workspace projection with a map of
environment projections. Each projection contains connection state, catalog/sync
state, current generation and checkout data. Catalog observers follow
`EnvironmentRegistry.followStream`, including supervisor replacement. The
application root mounts these once; components receive structured state and
scoped actions.

The former selected-environment setting becomes a migration input only.
Connection Settings continues to add, inspect, retry and remove environments;
its global **Use** action disappears. Explicit environment choice within an
Open/Create form is scoped to that operation and is not a new global selection.

### One application tab owner

Evolve the existing framework-independent workspace layer so there is exactly
one application tab owner. Keep its Git refresh, discard-checkpoint, cache and
partial-failure logic, but move open/close/select/replace decisions to the
application workspace. Per-environment repository data stores do not keep a
second authoritative tab list or an active environment selection.

The Svelte workspace store projects the active tab's checkout data and shared
tab list. It must not store the only live client or destroy background tabs
when the active tab changes. This is a focused ownership change, not a rewrite
of Git product behavior or a requirement to copy React Atom hooks into Svelte.

Framework-independent domain logic belongs in `packages/client-runtime`; the
current plain TypeScript under `apps/web/src/lib/client-runtime` supplies the
existing implementation to adapt. Move only the modules involved in this
ownership change as needed, preserve their tests, and leave Svelte bindings and
presentation in `apps/web`. There must not be competing old and new tab owners.

### Lightweight catalog aggregation

Maintain one catalog projection per registered environment, whether or not any
of its repositories are open. Fetch `repositories.list` on first readiness,
generation replacement, explicit refresh and foreground revalidation. Coalesce
invalidation/foreground bursts. Apply local open/create/remove results directly
to that environment's projection; relevant snapshot invalidations can mark its
identity/catalog metadata stale.

Aggregate all successful projections incrementally. A slow/offline server must
not delay a healthy local or remote catalog. Keep last successful catalog data
separate from connection and synchronization state, following T3's shell-state
model. Initial catalog failure is not proof that an environment has no repos.

Persist a versioned, non-secret catalog cache per EnvironmentId so known remote
locations survive a restart while offline. This is the narrow translation of
T3's environment shell cache; full histories and diffs do not need disk caching
for this feature. Explicit removal clears that environment's cache through the
existing owned-data cleanup boundary. A generation/session change does not.

Existing events do not announce every catalog edit made by another client.
Reconnect, foreground and explicit refresh provide reconciliation for this first
scope. Do not claim immediate cross-client catalog discovery, or add polling
that opens snapshots/history for every catalog entry. A future catalog event
requires concrete evidence of need and its own narrow protocol change.

### Current-session calls and subscriptions

Adapt the existing Promise boundary to execute through
`registry.run(environmentId, request(method, params))`. This already resolves
the supervisor's current session. Use the corresponding registry-following
event boundary for durable subscriptions. Preserve the single Promise bridge;
do not introduce a separate transport implementation or a retrying UI client.

Environment data stores survive session loss. Session readers and cancellation
handles are generation-scoped; a new generation replaces them and revalidates
only its environment's catalog and demanded checkout data. Event sequences are
interpreted within that session generation, including the existing gap recovery.
Keep last snapshots visible with stale/offline status and disable unavailable
mutations. Reconnect never replays an uncertain mutation.

Full repository data is demanded by open tabs, with bounded background refresh
and prefetch. Catalog aggregation needs identities and summaries, not every
repository's history. Closing a tab releases its demand and cancellable reads;
it does not remove the catalog entry or stop an environment/SSH bridge. Started
Git mutations retain the current server-owned completion and locking rules.

### Commands and reviews capture their target

Every command, queue item, context menu and review must capture its scoped
checkout target when initiated. Deferred callbacks must not read mutable
`this.client`, the then-active tab, or an application selected-environment field.
Resolve the current session for that captured environment at execution time.

Queue lanes, pending UI, cancellation, receipts and refresh results are keyed
by scoped checkout. Server operation ordering remains authoritative. A menu
opened for Agentbox cannot operate on a local checkout after a tab change;
a completed local action cannot replace a remote tab's snapshot. Review
continuations remain generation-bound where the protocol requires it and must
be reacquired rather than sent to a replacement session.

This applies to all existing Git features, not just Open: stage/unstage, commit,
amend/discard, branch/tag actions, stash, worktree removal, diff loaders, graph
filters, scroll keys, prefetch signatures and capability checks.

## Navigation and uniqueness

Use an environment-qualified repository route, proposed as
`/repo/<environmentId>/<repositoryId>`. Keep tabId client-local so links identify
a real checkout rather than a transient browser session. T3's environment/thread
routes are the architectural reference.

Routing selects an existing matching tab or creates its one view when absent.
Selecting a top-bar tab or following a route to an existing tab is navigation,
not an attempt to create a duplicate. Explicit **Open in new tab** is a creation
attempt and must produce an error if its target is already owned.

Centralize the following operations in the application workspace:

| Operation | Result |
| --- | --- |
| Select an existing tab | Activates it without changing its target. |
| Switch current tab to its own checkout | No-op. |
| Switch current tab to a different unused checkout | Replaces only that tab's target, preserving tab order/tabId. |
| Switch current tab to a checkout owned by another tab | Error; neither tab changes. |
| Open a checkout in a new tab when unused | Adds and activates one tab. |
| Open a checkout already open in any tab | Error, including when invoked on the current worktree. |
| Open another clone on the same environment | Allowed; the canonical checkout differs. |
| Open another worktree of the same clone | Allowed; the canonical checkout differs. |
| Open equal repository IDs from different environments | Allowed; their scoped references differ. |
| Close a tab | Removes that tab/demand; choose the next existing tab or home without reopening the closed route. |

Duplicate errors should use the existing compact error toast, for example
“This checkout is already open” with the environment and path as supporting
text. Keep the original operation visibly unchanged. Do not disable the menu
item as the only response; the user's requested attempted action gets an error.

### Race-safe replacement

1. Capture source tabId, source target and a navigation revision.
2. For a known target, check ownership before doing unnecessary work. For an
   unregistered worktree/path, use existing `repositories.open` on the captured
   environment to obtain the canonical summary/ID and initial snapshot.
3. Recheck the source revision and reserve the returned scoped canonical target
   in the single tab coordinator. Two simultaneous opens cannot both reserve it.
   Aliased paths are checked again after canonical resolution.
4. Prepare the checkout data, then persist/publish the next application tab
   state through one serialized commit. Keep the old tab until this succeeds.
5. Navigate and transfer data demand. Release the reservation on every failure,
   cancellation, stale source, removal or shutdown.

Do not hold an application-wide lock while a remote request hangs. Short
reservations/reducer commits preserve uniqueness while unrelated tabs remain
usable. A duplicate resolved through `repositories.open` may have updated that
server's catalog; rejecting the duplicate must not remove a shared catalog
entry as a supposed rollback.

Browser back/forward should select the uniquely existing checkout view. Stale
history cannot target a removed environment or cause a just-closed tab to
reopen through a still-running route effect.

The single-tab guarantee is within one GitGui application workspace/window.
Cross-browser or cross-device exclusion would require a new distributed product
policy and is outside this request.

## Sidebar and home projection

### Environment section

Place the new compact section above Local branches. Derive it from the active
checkout's logical repository group across all known environment catalogs.

- Hide when the group is known only in the desktop primary/local environment,
  including multiple local copies. Worktrees stays available.
- Show for a remote-only repository as well as a local/remote group. “Only
  local” is the hiding rule; “more than one environment” is not the rule.
- One independent clone/location in an environment is a root row bearing the
  environment label. Multiple clones/locations get an expandable environment
  parent, with paths distinguishing the children.
- Each selectable row carries a concrete scoped target; environment parent
  rows only expand/collapse. Highlight the current location and expose its
  canonical path in accessible supporting text/hover details.
- Keep cached offline locations visible with a compact state label. Do not
  hide the section just because a remote disconnected.
- Click/Enter switches the current tab. Context-menu key / Shift+F10 and
  right-click offer **Open in new tab** with the captured target.

Proposed clone/worktree detail: list independent clone families in this section,
and show their linked worktrees in the existing Worktrees section for the
displayed clone. Registering a linked worktree must not inflate the count of
independent clone locations. The family row resolves to the displayed checkout
when already in that family, otherwise the registered main checkout, or the
available registered checkout if the main one is not in the catalog. The user
can open a specific linked worktree through Worktrees. This preserves two
useful navigation levels without duplicating all worktrees in both sections;
the precise row label/default checkout is a presentation proposal, not a
previously agreed requirement.

Local-only independent clones remain accessible from the grouped home entry's
location choices even though the environment section is hidden. No extra local
sidebar exception is needed.

Do not infer locality from an HTTP loopback URL: SSH forwards are loopback too.
Electron's primary registration identifies the desktop-local environment.
Browser-served primary environments may be remote to the browser; show their
actual host/environment label rather than “This computer” unless locality is
known. No host-machine identity service or new connection target kind is needed.

### Worktrees

Keep the selected clone's existing Worktrees section, branch/commit details and
destructive-action safeguards. Add **Open in new tab** as navigation, independent
of rename/delete permission. Use the same tab coordinator and canonical target
resolution as environment/location rows, so a checkout reached through either
section is recognized as the same open target.

Only the new environment/location rows were explicitly assigned single-click
switching. Preserve existing worktree double-click navigation for the initial
scope; add the requested context action without silently changing that gesture.
Keyboard navigation must have an activation path as well as a context menu.

Opening an unregistered path still requires the existing catalog-management
scope. A read/operate-only direct pairing can navigate registered worktrees but
cannot register a new path. Surface the limitation; do not broaden pairing scopes
or turn viewing a sidebar into automatic repository registration.

### Home and tab labels

Home gets one logical repository row with compact environment names/presence and
a location count where useful. Its location choices preserve every independent
clone. Clicking an explicit location uses the normal open operation and duplicate
rule. A group-level default may prefer its last-used location and otherwise the
local representative, following T3's representative concept; the exact compact
presentation still needs a UI decision.

Tabs remain compact and include enough environment/location/worktree context to
distinguish simultaneous views. Full paths belong in hover/accessibility text,
not oversized error banners. Do not add a second global environment selector.

Use existing theme tokens, sidebar row sizes, separators, focus treatment and
context-menu components. Status must be readable in supported light/dark themes
and understandable without color alone. Expansion/focus behavior must work by
keyboard; a folder with one child is deliberately avoided.

## Open/create paths and native capabilities

Home's Open and Create actions must choose an environment for that specific
operation, defaulting to a sensible recent/local choice without changing any
tab's environment. Pin that environment for the lifetime of the form/dialog.

The client-local native folder picker is valid only when the desktop primary
environment is the operation target. Remote actions use an explicitly labelled
host path field, which the existing server API can resolve. A true remote
directory browser is not currently exposed by GitGui's protocol and is outside
the initial implementation. T3's richer project browser is reference material,
not a reason to add speculative filesystem RPCs now.

Gate actions by the target server's capabilities and granted scopes, not solely
by `isDesktop`. Existing remote Create can use its typed host-path form when
authorized; do not add clone behavior or enable the currently disabled Clone
button as part of this change. Client-local settings such as a default projects
directory must not silently become remote-host paths.

## Persistence, startup and removal

Introduce a versioned application-workspace record containing ordered tabs,
scoped targets and activeTabId, plus scoped view-state references as needed.
Keep per-environment recents and catalog caches environment-owned. One serialized
writer commits application tabs; per-environment data stores do not also persist
their own authoritative open/active lists.

Migrate once from the existing `gitgui.workspace` records for every known
environment, not only `gitgui.selectedEnvironment.v3`:

1. Read and validate legacy metadata without deleting or rewriting it.
2. Wrap each saved local repository ID in its owning EnvironmentId. Preserve
   each environment's tab order and recents. Since legacy data has no cross-host
   ordering, concatenate the formerly selected environment first, then the
   remaining registrations deterministically.
3. Deduplicate equal scoped targets while preserving distinct environments,
   clones and worktrees. Use the formerly selected environment's active tab
   as the initial application selection when valid.
4. Persist the new record and migration version before publishing it. On write
   failure preserve the old records and report the failure; do not start two tab
   writers. Successful migration is idempotent and leaves legacy records intact
   until a separately deliberate cleanup.
5. Restore tabs as placeholders before network hydration. An offline environment
   does not cause its tabs to be discarded. Resolve/hydrate each independently;
   keep missing directories visible using the existing Missing treatment.

The new startup route takes precedence over a last-active fallback. New scoped
links work directly. For old `/repo/<repositoryId>` routes/deep links, consult
the legacy selected environment once when available; otherwise resolve only
when there is exactly one known matching scoped checkout. Ambiguity must offer
an environment/location choice, never guess a host. Keep old-link parsing as a
narrow compatibility path rather than retaining global selection in new code.

Explicit environment removal uses the existing registry ownership boundary.
After durable registration removal succeeds, remove only that environment's
tabs, recents, cached summaries and drafts; select another surviving tab or home.
Make derived workspace pruning idempotent at startup, so a crash between catalog
removal and workspace persistence cannot resurrect an unregistered environment.
Do not optimistically clear unrelated tabs before persistence can fail. Removal
also invalidates pending target reservations so late requests cannot recreate it.

Ordinary disconnect/reconnect retains tabs, selections and cache. Connection
retry stays environment-scoped. Retry must never restart the primary server
when a remote tab fails. Environment removal does not delete repository files,
stop foreign remote servers or mutate another environment's state.

## Implementation sequence for later approval

| Phase | Work | Exit condition |
| --- | --- | --- |
| A: metadata and identity | Rust identity resolver and clone-family metadata; additive generated summary types; cache and matching fixtures derived from T3 tests | Correct grouping data without loading full history, no ID/catalog migration and no credential exposure. |
| B: scoped data ownership | Environment map in the runtime adapter; current-session Promise operations; independent catalog/cache/sync state; adapt existing workspace refresh logic | Two environments remain independently usable across failures/generation replacement; no global selected-client dependency. |
| C: application tabs/routes | One tab owner, scoped targets, reservations, atomic replacement, per-target state/action queues, scoped routes/deep-link compatibility and metadata migration | Same-checkout duplicates always error; different clones/environments/worktrees coexist; delayed operations cannot retarget. |
| D: UI projection | Grouped home, top-of-sidebar environment section, single-row/group rules, worktree context action, distinguishable tabs, operation-scoped Open/Create | Exact agreed interactions, compact accessible theme-consistent presentation, correct host path semantics. |
| E: failure and visual qualification | Focused integration tests, supported theme/keyboard checks, hosted-web build, isolated multi-environment scenarios | Required matrix below passes; remaining platform limitations accurately recorded. |

Likely touch points are `crates/gitgui-core`, `crates/gitgui-protocol`, the server
catalog in `crates/gitgui-server`, `packages/client-runtime` domain/Promise
boundaries, `apps/web/src/lib/connection/runtime.ts`, the existing workspace
and metadata modules, route/deep-link helpers, StartView/TopMenu/Sidebar and
WorktreeTree/context menus. Existing server dispatch and Git mutation behavior
should remain focused on the current APIs.

Any modified vendored file needs its divergence header and
`docs/t3code-vendoring.md` updated. Current T3 research is not permission to change
the runtime snapshot or dependency pins. New copied/adapted domain modules must
record the actual inspected source/commit and matching tests separately.

Implementation updates must also bring `docs/connection-runtime.md` and
`docs/architecture.md` into line with the new ownership model. Until then those
documents describe implemented behavior and this proposal describes future work.

## Validation requirements

### Grouping and location projection

- T3 parity fixtures: upstream before origin, alphabetical fallback, no remote,
  HTTPS/SSH/SCP equivalence, nested groups, forks with upstream, case/port
  normalization, invalid output and bounded slow/missing repositories.
- Two environments with equal bare repository IDs remain distinct targets.
- Multiple independent clones on one environment remain separate members;
  linked worktrees correlate to their own clone family, including without a
  remote. Symlink/alternate paths resolve to one canonical checkout.
- Group identity changes update presentation without closing, moving or
  retargeting existing tabs. Cache write failure does not erase live data.
- Local-only hides the environment section; remote-only identifies its host;
  a mixed group shows all locations. Single-location environments render flat;
  multiple-location environments expand. Offline cached members stay present.
- Multiple local clones remain accessible on home while the local-only sidebar
  section is hidden. No unnecessary filesystem scans or full-history loads.

### Tabs, operations and persistence

- Location switch changes one tab; open-in-new-tab leaves the source intact.
- Opening an existing target, switching onto another tab, rapid double actions,
  and main/worktree path aliases yield one tab plus a compact duplicate error.
  Switching the current tab to itself is a no-op.
- Delayed remote preparation, closing the source, a second switch, environment
  removal, failed data load and failed metadata save never lose the old tab or
  publish a stale new tab. Reservations release on every outcome.
- Context-menu targets and queued Git actions retain the initiating environment
  and checkout after tab changes. Receipts update only their source. A lost
  mutation reply is not replayed on reconnect.
- All state/cache keys that were bare repository IDs are audited, including
  scroll/filter/diff/prefetch/pending-action keys; capabilities and scopes are
  resolved for the actual target.
- Migration retains all environments' saved tabs/recents, preserves legacy
  records on failure, retries idempotently, and restores offline/missing tabs.
- Scoped routes, deep links, legacy ambiguous IDs, back/forward, close-active-tab
  and rapid route changes follow the single tab coordinator without reopen loops.

### Connection lifetime and presentation

- Two independent environments across transient retry, blocked auth/permission,
  offline/online, foreground wakeup and whole-supervisor/session replacement.
- Replacing one generation updates only that environment, switches its readers
  and invalidates its queries without stale cache overwrite or mutation replay.
- Closing the last tab leaves the registered environment/catalog intact and
  releases tab reads/prefetch. Explicit removal cleans only its owned state;
  failed removal preserves usable state and other environments.
- Remote Open/Create never use the local picker or a client-local default path;
  read/operate-only clients get accurate limits for unregistered worktrees.
- Light/dark theme contrast, keyboard activation/focus/context menus, compact
  duplicate errors and visible host/path disambiguation. Capture before/after
  screenshots and a short interaction recording during later UI qualification.

Run the repository's applicable frontend/runtime tests, protocol generation,
Rust checks/tests, `npm run check`, hosted-web build and `git diff --check` when
implementation is authorized. No checks were run as feature validation for this
research-only document. Reuse any existing development/preview session; do not
start or stop the user's stack. Any real SSH qualification must use isolated
owned fixtures and direct SSH for Agentbox, leaving the user's existing server
and data alone.

## Remaining presentation decisions

The architecture and tab uniqueness rule do not depend on these details:

- Exact compact environment indicators/location chooser on the grouped home row.
- Final section title (for example Environments or Locations), child labels, and
  the clone-family row's preferred checkout when no tab currently shows it.
- Exact environment/worktree text in tab subtitles.

The earlier extra toolbar selector is superseded by the requested sidebar
interaction. Remote directory browsing, automatic filesystem scans, manual
grouping controls, clone implementation, remote provisioning/update, relay and
cross-device tab exclusion are outside the initial scope.
