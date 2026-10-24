# Stash UI implementation (Task 5)

The details panel now retains a bounded immutable file-list presentation cache
(`workspace/stash-files-cache.ts`), keyed by client identity, repository ID and
stash OID. Revisited entries show their cached tree while the server rechecks the
captured selector/OID. Equal results reuse the array and mounted tree; failed
verification clears both display and cache. Aborted/superseded responses cannot
populate or evict a newer selection. Metadata replacement alone does not restart
the request. Retention is limited to 32 entries and approximately 2 MiB; backend
preparation remains server-owned. Focused cache/DOM tests and independent review
passed, along with 299 web tests (one existing live skip) and the production build.

Implemented in the shared checkout, on top of the pre-existing generated APIs
and stash-selection foundation. No Git semantics, connection runtime, Electron,
Rust, protocol contracts, or vendoring changes are part of this UI work.

## Behavior and ownership

- Staged and Unstaged file context menus use only their own section selection.
  Clicking outside that selection targets the clicked file. Multiple targets
  have a selected-file count. The review copies the source and literal paths,
  including both rename endpoints, with an optional message. Empty input cannot
  become stash-all. The toolbar Stash action retains its existing stash-all API.
- Sidebar tree rows and graph rows select the same real `StashInfo`. Both expose
  Apply, Pop, Delete, and Create branch from stash through the existing accessible
  context menu. Mouse and keyboard invocation work through the established menu
  implementation. Menu ownership, context keys, destruction checks, and retained
  row backgrounds prevent a menu from acting on a different repository or host.
  Opening a stash context menu preserves the current selection and open diff;
  clicking/activating a row selects it separately.
- Apply submits immediately and retains the saved entry. Pop/Delete/Branch open
  a compact square review with the captured entry. Delete starts on Cancel and
  states that the entry is removed without applying it. Branch explains the
  original base, switching, saved staging context, and removal only on success.
  No encoding details appear in the product UI. Submitted reviews close before
  the request completes; results use Sonner after the action status clears.
- Toolbar Pop captures the current latest stash independently of selection. It
  always uses `stashPopTarget`, with review. Empty lists and unsupported servers
  disable Pop. There is no legacy targeted-pop fallback.
- Reviews bind environment/repository/selector/full OID. Submission rejects
  switched repositories/environments, removed/reindexed/replaced stashes, and
  changed destination branch/HEAD snapshots for Pop/Branch. The server must still
  enforce target identity and concurrent Git safety; the client cannot lock
  external Git activity using a cached snapshot.
- Mutations resolve the currently projected session at submission, then keep
  that environment's client/workspace across awaits. Completion refreshes that
  original workspace, never the newly selected host. Conflicts show Working
  Changes only when the original repository/environment is still active.
- Typed receipts retain success, conflicts, partial cleanup, stash retention or
  removal, and branch creation/switch/restore progress. A later refresh failure
  appends its details without replacing the mutation result or replaying it.
  Retry refresh resolves the current session for the same environment and refuses
  another active environment. Transport loss reports unknown completion, refreshes
  once, and never automatically replays a mutation. `noChanges` has an explicit
  result. Saved partial selected stashes identify incomplete cleanup and retention.
- Stash details show message, original branch, date, original base, and
  object ID. Combined saved files, including untracked entries supplied by the
  server, use the existing file tree. Both responsive route variants retain the
  current pane groups and resizing. Closing a diff keeps the stash selected.
- The existing diff viewer now accepts a stash source. Hunks/Inline/Split and
  Diff/File modes, binary/large-file behavior, worker parsing, and themes are
  retained. Stash requests never prepare hunk continuations; stage controls and
  mutation annotations are independently excluded for that source.
- File-list requests abort and reject superseded responses. Diff identity includes
  environment/repository/selector/OID/file, retains existing request guards, and
  reloads on client-session replacement. Removed/reindexed entries clear the
  selected file and stash. An initialization flag keeps that intentional clearing
  across later refreshes while still selecting initial content after a newly
  opened tab finishes loading. Workspace selections cannot cross environments
  with an identical repository ID.

The applicable current T3 sources were read before adapting the application
boundary: `docs/internals/connection-runtime.md` and
`apps/web/src/connection/runtime.ts` in the local T3 checkout. This follows its
application-owned selection and current-environment mutation boundary. No socket,
retry, credential, registry, supervisor, or vendored runtime changes were needed.

## Files

Changed existing files:

- `apps/web/src/lib/components/CommitFileDiffViewer.svelte`
- `apps/web/src/lib/components/GitGraph.svelte`
- `apps/web/src/lib/components/HistoryToolbar.svelte`
- `apps/web/src/lib/components/Sidebar.svelte`
- `apps/web/src/lib/components/WorkingTreeFileList.svelte`
- `apps/web/src/lib/components/WorkingTreePanel.svelte`
- `apps/web/src/lib/components/file-diff-request-key.ts`
- `apps/web/src/lib/workspace/types.ts` (extends the existing foundation)
- `apps/web/src/lib/workspace/workspace-store.svelte.ts` (preserves the foundation)
- `apps/web/src/routes/repo/[repositoryId]/+page.svelte`
- `apps/web/vitest.config.ts` (compiles rune modules for real store tests; virtual
  SvelteKit page/navigation/environment fixtures, no running app required)

Added files:

- `apps/web/src/lib/components/StashDetailsPanel.svelte`
- `apps/web/src/lib/components/StashReviewDialog.svelte`
- `apps/web/src/lib/components/StashTree.svelte`
- `apps/web/src/lib/components/file-diff-source.ts`
- `apps/web/src/lib/components/file-diff-source.test.ts`
- `apps/web/src/lib/workspace/stash-menu.ts`
- `apps/web/src/lib/workspace/stash-operations.ts`
- `apps/web/src/lib/workspace/stash-operations.test.ts`
- `apps/web/src/lib/workspace/stash-read.ts`
- `apps/web/src/lib/workspace/stash-store.test.ts`
- `docs/stash-ui-implementation.md`

`stash-selection.ts` and its five tests were already present and are preserved.
Other pre-existing or concurrently produced changes are outside this handoff.

## Server integration

The UI calls the foundation facade only. Each feature independently requires the
matching advertised wire capability:

| Capability | Facade |
| --- | --- |
| `git.stash.push_selected` | `stashPushSelected` |
| `git.stash.apply` | `stashApply` |
| `git.stash.pop_target` | `stashPopTarget` |
| `git.stash.drop` | `stashDrop` |
| `git.stash.branch` | `stashBranch` |
| `git.stash.files` | `getStashFiles` |
| `git.stash.file_diff` | `getStashFileDiff` |

Known facade methods do not establish support. Parent integration must publish
capabilities only after installing the authorized handlers, shared decoder,
correct original-base snapshot loader, repository serialization/invalidation,
and combined inspection. The UI sends `{repositoryId, target:{selector,
expectedOid}}`, explicit selected source/paths, and branch name exactly as defined
in the canonical contracts. It consumes receipts rather than inferring Git
success from refresh or executing any cleanup itself.

The current projected UI session does not expose authorization scopes. Capabilities
and the authenticated environment/session gate the UI; per-method scope checks
remain the server's responsibility. The existing generic stash-all flow is
unchanged. This change does not move reserved methods into accepted registries.

## Validation and limitations

- `npm run check`: passed, with zero errors and the existing
  `WorkingTreeFileList.svelte` accessibility warning.
- `npm run test -w @gitgui/web`: 140 passed, one live test skipped. The new stash
  tests comprise 19 real-store cases, 11 pure/state cases, and three diff-source
  cases, in addition to the five existing selection-foundation tests.
  Real rune-based store tests exercise
  toolbar targeting, selected capture, stale submission, environment switches,
  replacement sessions, branch restore failures, late conflicts, receipt/removal
  handling, and refresh-only retry. Pure tests exercise section targeting,
  unusual/rename paths, all receipt variants, cancellation, read-only source
  routing, and request identity. The existing live restart test remains skipped.
- `npm run build -w @gitgui/web`: passed. The build also reports the existing
  file-list accessibility warning, chunk-size warnings, and a compiler-generated
  pure-annotation/source-map warning in the workspace store; these did not block
  static output generation.
- `git diff --check`: passed.

Browser status/open were checked through the shared T3 preview tools. No existing
app preview was attached, and no listener was found on the documented development
ports 1420/3774 or usual Vite port 5173. Services were not started. No screenshots,
recordings, or visual end-to-end validation are claimed. No stash action was run
against the user's repository. Server/Git integration remains the parent's work;
capability-gated features remain disabled until those handlers are advertised.

## Independent review round 1

All four UI findings were addressed within the web UI and tests. The shared
context-menu utility received the focused accessibility fix requested by review.
No mutation replay, force/discard behavior, selected cleanup, decoder, Git
semantics, connection runtime, or protocol implementation was changed.

- **P1, uncertain mutation completion:** `stash-operations.ts` now treats only
  known pre-mutation rejection codes as definite failures. Actual adapter codes
  `request_timeout`, `transport`, and `client_error`, session closure, malformed
  responses, and unknown failures warn that completion is unknown. Both typed
  client/RPC errors and error envelopes preserve the diagnostic. The warning
  requires inspection before an explicit new attempt; automatic follow-up and
  Retry refresh only read state. Helper regressions exercise all three shapes
  and known server rejections; real-store tests exercise the actual error codes,
  warning timing after pending clears, failed refresh, and refresh-only retry.
- **P2, sidebar menu lifetime:** `StashRow.svelte` no longer selects a stash
  while opening its context menu. Graph stash menus follow the same rule. This
  preserves the current open diff and the small-screen sidebar instance while
  retaining the captured stash, context key, owner, and menu-row highlight.
  A mounted real-row regression reproduces the route's conditional sidebar
  owners and exercises right-click, Shift+F10, keyboard Pop, independent click
  selection, context replacement, and component destruction.
- **P2, keyboard menu access:** `contextMenu.ts` focuses the first enabled item,
  owns navigation in capture phase, and supports Up/Down wrapping, Home/End,
  Enter/Space, Right/Left submenus, Escape, and Tab dismissal. Headers, separators,
  and disabled items are skipped. Existing hover/click submenus, owner-scoped
  dismissal, and safe focus restoration remain. Five deterministic DOM tests
  exercise the actual utility, including focus stolen by a background graph row,
  immediate keyboard activation, pointer selection, and removed focus targets.
- **P2, removal before refresh:** a removal receipt immediately clears selected
  stash entries at the removed numeric selector or any older selector, together
  with their open file. It selects no replacement and preserves newer selections,
  including duplicate OIDs. Invalidation includes known linked-worktree tabs
  identified by server-reported worktree paths in the same environment; unrelated
  tabs and another environment's matching IDs are preserved. Real-store tests
  cover toolbar Pop of `stash@{0}` while inspecting `stash@{1}`, refresh failure,
  duplicate OIDs, linked/unrelated tabs, and late environment replacement.
  Mounted real details/diff components verify that removal aborts both reads,
  closing only the diff aborts its read while keeping stash details, and late
  results cannot repopulate closed views. Rendering workers and the decorative
  close icon are stubbed for those lifetime tests.

Review-round files: `stash-operations.ts` and its tests, `StashRow.svelte`,
`GitGraph.svelte`, `contextMenu.ts` and its new DOM tests,
`workspace-store.svelte.ts`, `stash-store.test.ts`, the new `stash-row.test.ts`
and two Svelte lifecycle fixtures under `components/__tests__`, this document,
and the web Vitest configuration. `apps/web/package.json` and the root lockfile
add the development-only Happy DOM dependency needed for actual DOM/lifecycle
tests; it adds no production runtime dependency.

Validation: full `npm run test -w @gitgui/web` passed **167 tests**, with the
existing live restart test skipped. `npm run check` passed (all workspace
checks; zero Svelte errors and the existing file-list accessibility warning).
The root check command also invokes the existing protocol generator; no manual
protocol edits are part of this round.
`npm run build -w @gitgui/web` passed and generated static output, with the
existing accessibility, chunk-size, and compiler annotation/source-map warnings.
`git diff --check` passed.

Shared T3 preview status/open were checked again: no reusable app session was
attached, and no listener existed on ports 1420, 3774, or 5173. No services were
started, no stash operations were performed against the shared checkout, and
there are no new screenshots, recordings, or live visual verification claims.

## Independent review round 2: P1 successful malformed receipts

The successful RPC envelope does not validate its result payload. Previously an
object without `stashState` could be formatted as selected-push success, and a
`removed` flag could invalidate selection before receipt identity was checked.
`stash-operations.ts` now validates the untrusted result against the submitted
action and captured repository/target before notification formatting or any
receipt-driven effect. The store supplies the submitted branch name and performs
removal invalidation only in the validated-receipt callback, before refresh.

Validation follows the generated contracts and the outcome rules in
`stash-features.md`. Selected push requires complete saved-entry metadata (full
SHA-1/SHA-256 IDs, selector, nullable index/branch, message and integer timestamp),
the correct repository, and consistent success/noChanges/partial/error fields.
Targeted receipts require the exact captured repository, selector and full OID;
the existing target contract uses lowercase IDs. Outcomes, restoration and
retention states must be recognized and consistent with Apply/Pop/Delete/Branch.
Branch creation must match the submitted name, with a boolean switch status and
valid progress. Incomplete outcomes require a diagnostic with string code/message
and retain the stash. Required nullable fields cannot silently be omitted.
Compatible extra fields remain allowed; they do not select a receipt's action or
authorize removal. Receipt identity is compared with the captured request, not a
live catalog that may already have changed after the mutation.

Invalid results, including `null` and `{}`, yield the existing unknown-completion
warning after pending clears. They authorize no removal or conflict-navigation
effects. The original bound workspace receives one ordinary refresh; subsequent
Retry refresh is read-only and retains the existing environment/session guards.
No mutation is automatically repeated. Valid receipts keep their completed
outcome even when that separate refresh fails.

Focused helper tests cover required fields, malformed metadata/diagnostics,
unknown enums, identity mismatches, SHA-256, nullable/optional fields, compatible
extensions, and all documented result/progress variants. Real rune-based store
tests resolve malformed successful result payloads for targeted and selected
actions; verify warning timing, unchanged inspection before refresh, one refresh
and one mutation; exercise wrong branches and inconsistent removal; and verify
refresh-only recovery across environment changes. They also cover catalog
reindexing before a valid receipt arrives and all valid result variants with a
failed refresh. Older failure fixtures now include the required safe diagnostics.

This round changes only `stash-operations.ts`, `workspace-store.svelte.ts`, their
two stash test files, and this document. Concurrent Rust/server/protocol/package
work was preserved. No services, live Git mutations, visual checks, delegation,
commits, or pull requests were needed.

Validation: `npm run test -w @gitgui/web` passed **284 tests**, with the existing
live restart test skipped. `npm run check --workspaces --if-present` passed all
workspace checks, with zero Svelte errors and the existing file-list accessibility
warning. The workspace checks intentionally omit the root command's protocol
generation step, leaving that shared output to the server integrator. Production
build was not repeated for this receipt-validation-only change. `git diff --check`
passed. These are UI consumer tests; live server/Git integration remains outside
this round, and the protocol still supplies no durable operation ID for recovery.

## Sidebar tree consistency

The stash list now uses `@pierre/trees`, matching the existing branch and worktree
sections: 26px compact rows, 13px text, square selection backgrounds, matching
padding, and an archive icon. Each row shows its message on one truncated line;
the tooltip retains the selector, original branch and base details. Details and
review dialogs also keep the selector in hover text instead of visible labels,
and selected-stash success notifications show only the message. Entries
remain in server-provided newest-first order. Their identities combine selector
and full OID; messages and branch names cannot introduce directory nesting.

`StashTree.svelte` replaces the former `StashRow.svelte`. Mouse and keyboard menus
preserve the selected stash and open diff, retain the clicked row's highlight,
and revalidate the captured context before invoking an action. Shared menu focus
restoration now follows shadow roots back to the invoking tree row. Snapshot
refresh restores the selected path without emitting a selection action. Clicking
or pressing Enter on the selected row reopens its details. Accessible row labels
follow refreshed metadata instead of exposing the tree's opaque identity paths.

The renamed `stash-tree.test.ts` and `StashTreeLifecycle.svelte` cover menu
lifetime, focus restoration, context replacement, duplicate/slash-containing
labels, ordering, snapshot refresh, and selected-row activation. The full web
suite passed **286 tests**, with the existing live test skipped. Web check and
production build passed with the existing accessibility/compiler/chunk warnings.
The existing Vite session was reused for a sample-data sidebar DOM check; rows
in all three sections measured 26px with 13px text. Screenshot verification was
unavailable: collaborative preview snapshots timed out twice, and the separate
HTML renderer could not reach the local Vite session (`ERR_SOCKS_CONNECTION_FAILED`).
No development services or real repository mutations were needed.

## Stable stash file inspection during refresh

Repository snapshots replace stash metadata objects even when the saved entry
is unchanged. The details panel now derives scalar selector/OID dependencies
before starting its file request, so a routine snapshot refresh updates metadata
without cancelling the request, clearing files, or recreating the tree. Target,
repository, client-session, and explicit Retry changes still start a new read;
superseded responses remain guarded and aborted on teardown.

The real store/component regression reproduced a duplicate request before the
fix. It now verifies in-flight and completed reads across repeated snapshot
refreshes, including metadata changes and preservation of the tree instance.
Additional regressions cover stash/session replacement, late responses, and
manual Retry after an error. Full web tests passed **290 tests**, with the existing
live test skipped; web check passed with the existing accessibility warning, and
whitespace validation passed.
