# Stash features

## Status and boundary

Interactive inspection now uses lightweight Git comparisons and a bounded
OID-keyed cache, with recent-stash/file preparation and strict verification in
the Rust backend's background queue. Snapshot stash metadata is batched, and
the details panel preserves cached trees while identity is rechecked. See the
current section of [stash-inspection-implementation.md](stash-inspection-implementation.md)
for the read guarantees, command budgets, external-source references, and queue
lifecycle. The original feature-validation counts below predate this optimization.

Selected capture, the shared decoder, targeted actions, combined saved inspection,
UI, and final server/protocol integration are implemented. The server maps public
core domain results to canonical generated contracts, authorizes five mutations
with `repository:operate` and two reads with `repository:read`, and advertises
the seven method capabilities. Independent core/UI review and platform limits
are recorded in the individual implementation documents. See
[stash-server-integration.md](stash-server-integration.md) for locking, validation,
invalidation, compatibility, and final integration verification.

Final independent reviews are complete with no unresolved findings, including
the raw-tree decoder, staged cleanup, receipt validation, server integration,
and deterministic common-lock worker-entry proof. Verification passed on Windows:

- Core: 104 unit tests and 69 integration tests; one existing measurement ignored.
- Server: 44 library tests at default concurrency after the final proof fix;
  the independent reviewer also reran the focused lock fixture successfully.
- Protocol: five contract tests; client RPC: six tests.
- Web: 284 tests, with one existing live test skipped; production build passed.
- Workspace checks, server all-targets check, and whitespace checks passed.

Live visual verification and Unix-only fixtures remain unexecuted. No reusable
development session was available, and no services were started. Existing build
warnings and the documented upstream vendor-checkout mismatch remain. All work
is uncommitted; no PR was opened.

`crates/gitgui-protocol/src/lib.rs` owns the wire definitions.
`STASH_FEATURE_METHOD_NAMES` is a named subset of accepted `WS_METHOD_NAMES`.
Each accepted registry contains every method exactly once. The client method
table agrees with the generated accepted registry; availability still requires
the matching advertised capability rather than merely a known method name.

The current T3 checkout at
`D:\GitHub\PictureTagingApp.references\t3code`, commit
`70cd258d8aac43ea57494527b00bf36de3efa6c0`, was inspected: workspace-layout and
connection-runtime internals, and `packages/client-runtime/src/rpc/{protocol,client}.ts`.
T3's application-owned selection and current-environment mutation boundary map to
the existing Svelte workspace and shared RPC client. No connection, retry,
session, credential, or Electron lifecycle changes are needed. GitGui owns stash
behavior. The existing adapted RPC table is extended to avoid a parallel RPC
implementation; its provenance and vendoring manifest record this divergence.

## Accepted interaction

- Both Staged and Unstaged sections offer stash from a file context menu.
  A clicked selected row targets that section's selected files. Clicking outside
  the current selection targets only the clicked file. Staged saves only those
  paths' staged changes, preserving unstaged edits. Unstaged saves only those
  paths' unstaged changes, preserving the index. Explicitly selected untracked
  files work in Unstaged. Unrelated files and index entries remain unchanged.
  An empty explicit selection is rejected; it never becomes stash-all. The
  existing toolbar stash-all remains available.
- Sidebar and graph offer Apply, Pop, Delete, and Create branch from stash.
  Apply retains the entry. Pop removes it only after complete restoration.
  Delete requires confirmation. Branch creation starts at the saved original
  base, creates and switches to a new branch, restores saved index/worktree and
  untracked contents, and removes the entry only on full success. Pop/Delete
  use a compact review; branch creation explains successful removal.
- Capture environment, repository, selector, and expected full OID when opening
  the action. Never resolve a submitted action from whichever tab, selection,
  or latest entry happens to be current later. Toolbar Pop explicitly captures
  the latest entry independently of graph/sidebar selection, then uses targeted
  Pop. Conflicts and partial failures refresh relevant views while retaining
  the stash; no force, discard, rollback-by-destruction, or automatic retry.
- Clicking a stash in either surface selects one shared stash item. Extend the
  existing history details, file tree, and diff viewer to show combined saved
  changes including saved untracked files. Diffs are read-only. A stash is not
  represented by a fabricated `CommitInfo`. Removal clears selection and its
  diff without selecting the next stash.
- Context menu text has normal weight; row hover remains through dismissal.
  Dialogs are compact, square, and use the active theme. Inputs have no glow or
  focus highlight; warning bodies use normal readable text. Submitted dialogs
  close immediately. Results use Sonner, after clearing operation status.

## Exact new API

All JSON fields are camelCase. These are the generated types, with formatting
expanded for readability; Rust is authoritative. `StashInfo`, `CommitFile`,
`CommitFileDiff`, and `ProtocolError` are existing generated DTOs.

```ts
type GitStashTarget = { selector: string; expectedOid: string };
type GitStashSelectionSource = "staged" | "unstaged";
type GitStashPushSelectedParams = {
  repositoryId: string;
  source: GitStashSelectionSource;
  paths: string[];
  message?: string;
};
type GitStashPushSelectedOutcome = "success" | "noChanges" | "partial";
type GitStashPushSelectedResult = {
  repositoryId: string;
  outcome: GitStashPushSelectedOutcome;
  stash: StashInfo | null;
  error: ProtocolError | null;
};
type GitStashTargetParams = { repositoryId: string; target: GitStashTarget };
type GitStashBranchParams = {
  repositoryId: string;
  target: GitStashTarget;
  name: string;
};
type GitStashMutationOutcome =
  | "success" | "conflicts" | "partial" | "branchCreatedRestoreFailed";
type GitStashState = "retained" | "removed";
type GitStashRestoreOutcome = "notAttempted" | "succeeded" | "conflicts" | "failed";
type GitStashCreatedBranch = { name: string; switched: boolean };
type GitStashMutationResult = {
  repositoryId: string;
  target: GitStashTarget;
  outcome: GitStashMutationOutcome;
  stashState: GitStashState;
  restore: GitStashRestoreOutcome;
  branch: GitStashCreatedBranch | null;
  error: ProtocolError | null;
};
type GitStashFilesResult = { stash: StashInfo; files: CommitFile[] };
type GitStashFileDiffParams = {
  repositoryId: string;
  target: GitStashTarget;
  filePath: string;
};
type GitStashFileDiffResult = { diff: CommitFileDiff };
```

| Wire method | Input | Output | Required scope |
| --- | --- | --- | --- |
| `git.stash.push_selected` | `GitStashPushSelectedParams` | `GitStashPushSelectedResult` | `repository:operate` |
| `git.stash.apply` | `GitStashTargetParams` | `GitStashMutationResult` | `repository:operate` |
| `git.stash.pop_target` | `GitStashTargetParams` | `GitStashMutationResult` | `repository:operate` |
| `git.stash.drop` | `GitStashTargetParams` | `GitStashMutationResult` | `repository:operate` |
| `git.stash.branch` | `GitStashBranchParams` | `GitStashMutationResult` | `repository:operate` |
| `git.stash.files` | `GitStashTargetParams` | `GitStashFilesResult` | `repository:read` |
| `git.stash.file_diff` | `GitStashFileDiffParams` | `GitStashFileDiffResult` | `repository:read` |

The existing `GitGuiClient` exposes these Promise signatures. Reads optionally
accept the existing `AbortSignal` mechanism; mutations do not accept cancellation.

```ts
stashPushSelected(params: GitStashPushSelectedParams): Promise<GitStashPushSelectedResult>;
stashApply(params: GitStashTargetParams): Promise<GitStashMutationResult>;
stashPopTarget(params: GitStashTargetParams): Promise<GitStashMutationResult>;
stashDrop(params: GitStashTargetParams): Promise<GitStashMutationResult>;
stashBranch(params: GitStashBranchParams): Promise<GitStashMutationResult>;
getStashFiles(params: GitStashTargetParams, signal?: AbortSignal): Promise<GitStashFilesResult>;
getStashFileDiff(params: GitStashFileDiffParams, signal?: AbortSignal): Promise<GitStashFileDiffResult>;
```

## Outcome rules for implementation

Reject authorization, malformed/empty paths, invalid names, unsupported inputs,
and stale targets before mutating. Request DTOs deny unknown fields, including
invented force options. A missing/replaced target uses `stash_target_changed`;
refresh and require a new reviewed action. This code is defined in the protocol.
The server must validate the selector as `stash@{n}` and the expected OID as a
full repository-format object ID, then compare under its mutation lock. The
client already rejects abbreviated OIDs and accepts full SHA-1/SHA-256 OIDs.

Return a mutation receipt after started work, including conflicts or partially
completed operations. The receipt is the operation result; later refresh is a
separate read. Do not turn a completed mutation into a failed mutation because
refresh failed. Keep the receipt for notification/reconciliation and never replay
it. If transport is lost before a receipt arrives, completion is unknown: refresh
and ask for an explicit new action, with no automatic replay. This API
does not provide durable operation IDs or exactly-once recovery.

| Operation/result | Required receipt meaning |
| --- | --- |
| Selected push success | `success`, non-null saved `stash`, null `error` |
| Selected push with no selected-side changes | `noChanges`, null `stash`, null `error`; no stash created |
| Selected push partly completed | `partial`, safe `error`; include saved `stash` whenever created, even if cleanup failed |
| Apply success | `success`, `retained`, `restore: succeeded`, null branch/error |
| Pop success | `success`, `removed`, `restore: succeeded`, null branch/error |
| Delete success | `success`, `removed`, `restore: notAttempted`, null branch/error |
| Apply/Pop conflicts | `conflicts`, `retained`, `restore: conflicts`, safe error |
| Restored but entry removal failed | `partial`, `retained`, `restore: succeeded`; never restore again automatically |
| Branch success | `success`, `removed`, `restore: succeeded`, branch `{name, switched: true}`, null error |
| Branch exists but switch failed | `partial`, `retained`, `restore: notAttempted`, branch `{name, switched: false}`, safe error |
| Branch created/switched but restore failed | `branchCreatedRestoreFailed`, `retained`, `restore: conflicts` or `failed`, branch `{name, switched: true}`, safe error |

`branch` is non-null only if this request created that branch. A failed restore
retains the stash. Partial/failure results have a safe operation diagnostic,
not raw sensitive command output. The DTOs permit combinations in order to stay
small; backend result construction and tests must enforce these invariants.
`restore: failed` may already have modified files/index. No failure receipt
authorizes cleanup, force, or retry.

Inspection compares saved tracked contents with the persisted **patch baseline**
defined below and adds the saved untracked tree. The original HEAD is a separate
identity. Do not use the default merge-commit file listing. Return path/rename
metadata and the existing bounded binary/text diff payload.
`GitStashFileDiffResult` has no hunk continuation, so inspection cannot authorize
live staging/discard operations. Reads validate target identity too. Apply/Pop
use ordinary Git stash restoration without `--index`; this API does not add an
index-restore toggle. Branch creation restores saved index context too, using
the explicit original-HEAD procedure below.

## Durable selected-stash encoding (review P1)

This is a format agreement and executable Git proof, not feature operations.
Use native Git commit/tree objects reachable from the stash reflog. There are
no sidecar files, Git notes, configuration keys, or client/session metadata to
copy to another host. `git stash store` publishes the complete object graph
before cleanup; retain the entry if cleanup is incomplete. A saved object is
not itself permission to overwrite a concurrently changed index or worktree.

Notation: `H` is original HEAD, `P` the patch-baseline commit, `I` the saved
index commit, `W` the stash/worktree commit, and optional `U` the untracked
commit. Ordered parents of `W` are `[P, I]` or `[P, I, U]`. `U` is parentless,
with a tree containing only selected untracked paths. Trees include modes and
deletions, not just file text. Build trees with private temporary indexes;
never snapshot the full real index and thereby leak unrelated staged content.

- **Selected staged:** ordinary stash shape, `P = H`; `tree(I)` starts at
  `tree(H)` and replaces only selected paths with their real-index entries.
  `I` has exactly parent `H`; `tree(W) = tree(I)`. There is no untracked parent
  for Staged. Thus tracked inspection/restoration sees only `H -> I`, without
  selected unstaged edits or unrelated staging. No custom header is needed.
- **Selected unstaged:** `P` is a synthetic commit with exactly parent `H`.
  `tree(P)` starts at `tree(H)` and replaces only selected tracked paths with
  their real-index entries (including removals). For selected untracked paths,
  also remove any `H` entry at that path: a staged deletion can leave a
  path untracked even though it exists in `H`. `I` has exactly parent `P`,
  and `tree(I) = tree(P)`. `tree(W)` starts at `tree(P)` and replaces those
  selected tracked paths with their worktree entries (including removals).
  Only `W` carries the single raw commit header
  `gitgui-stash-encoding selected-unstaged-v1`, before the blank line separating
  headers from the message. `U`, when present, holds only selected untracked
  contents. Unselected paths in every tracked snapshot retain `H` contents.
  Index content on selected paths is necessary baseline context, never an
  additional saved `H -> P` change in inspection or Apply/Pop.
- **Ordinary external/legacy stashes:** absence of that header means native
  semantics, `H = P = W^1`, saved index `W^2`, optional untracked `W^3`.
  Preserve compatibility with native stashes containing both staged and
  unstaged edits. A user message containing any marker has no meaning.

For the custom encoding, original HEAD is `W^1^1`, patch baseline is `W^1`,
saved index is `W^2`, and saved tracked content is `tree(W)`. The synthetic
commit is not original HEAD. `StashInfo.baseHash` continues to mean original
HEAD; `indexHash` continues to mean `W^2`. No wire metadata or selection field
is needed: the server resolves this layout from the reviewed immutable `W`
OID. Inspect `P -> W`, and combine `empty tree -> U` for untracked files.
Keep untracked paths disjoint from tracked snapshot entries; reject malformed
overlaps rather than silently choosing one payload. A selected untracked-only
snapshot may have `tree(P) = tree(H) = tree(I) = tree(W)` plus `U`.

The shared reader must inspect raw commit headers, never message text or the
reflog subject. For the custom header validate its exact supported value,
single occurrence, no continuation, `W`'s two/three ordered parents, `P`'s
single parent `H`, `I`'s sole parent `P`, equal `P/I` trees, and parentless `U`
when present. Resolve every referenced commit/tree and validate untracked
disjointness. An unknown version, duplicate/malformed header, invalid graph,
or missing object is an unsupported/corrupt snapshot: refuse restoration and
removal, retain the stash and report an error. Do not fall back to a different
baseline. Native stashes without this header retain native validation rules.
Use literal validated OIDs and disable replacement objects when validating
and consuming the graph so a replacement ref cannot change its interpretation.

This header is untrusted format data, not proof of GitGui authorship or an
instruction channel. Anyone can construct a valid Git object graph. It only
selects a bounded layout with the checks above; it cannot supply paths to run,
commands, authorization, cleanup instructions, or permission to discard data.
Commit messages remain arbitrary user text, even when identical to the header.

### Cleanup and restoration baseline

Unstaged cleanup changes only selected tracked worktree entries to the captured
real-index state, leaving the **entire** real index unchanged; remove selected
untracked files only after durable publication and content/race checks.
Unrelated files/index must remain unchanged. Staged cleanup removes only the
selected `H -> I` staged delta while preserving the selected `I -> worktree`
unstaged delta; overlapping/conflicting cleanup must retain the saved stash and
report `partial`, never discard work. Cleanup correctness remains downstream.

Apply and Pop pass the reviewed `W` to native stash restoration. Git uses
`tree(P)` as the three-way base and `tree(W)` as the tracked payload, plus `U`.
There is no separate `H -> P` replay. A changed destination can conflict or
already contain the change, as with ordinary Git stashes; native success is
the restoration result, not a promise to recreate the original index on any
destination. Pop removes only after successful restoration and target recheck.

For `HEAD=A, index=B, worktree=A`, this format saves `P=B, I=B, W=A` on the
selected path. Inspection shows `B -> A` even though `H -> W` is empty. Cleanup
leaves `index=B, worktree=B`; native Apply restores `index=B, worktree=A`.
The fixture checks both native Apply modes, retained stash, and unrelated
staged/unstaged content. `git stash show -p --include-untracked` also shows
the inverse and selected untracked additions correctly.

### Branch at original HEAD

GitGui must create/switch the branch at **H**, not at `P`. For the custom
encoding, prepare the selected baseline context before applying `W --index`:

1. Validate target/layout and branch name; preflight repository state. Derive
   prerequisite paths from the literal, NUL-delimited, rename-disabled tree
   diff `H -> P`, never from a message or a client-supplied metadata list.
2. Create/switch at `H`, preserving unrelated live work under normal safe Git
   checks. Copy `P`'s entries to the index and worktree **only** on prerequisite
   paths (including deletions). Each destination must match `H` or already
   match `P` in both index and worktree; otherwise refuse before branch creation
   where detectable. Recheck before writes; no overwrite of other edits.
3. Restore `W` with native `git stash apply --index`. Retain the entry on
   conflicts/failure, including context-seeding failure. Once switched, report
   `branchCreatedRestoreFailed` with the created branch and the correct restore
   progress (`restore: failed` for a context-seeding failure); leave completed
   changes in place. Drop only after full success
   and selector/OID revalidation, independently of later refresh.

For normal/staged-only stashes `P=H`, no extra baseline seeding is needed.
For the inverse case the result is branch HEAD=`A`, index=`B`, worktree=`A`:
the inverse remains an unstaged `B -> A` change. The selected `A -> B` staging
is prerequisite context. It is impossible to start at original HEAD `A`, keep
index=`A`, worktree=`A`, **and** represent the saved inverse. Restoring this
selected index context is the smallest consistent interpretation of the
approved "original base, restore saved index/worktree" branch behavior.
It does not introduce unrelated staging. The branch dialog must explain that
selected unstaged snapshots restore their selected index baseline too.

External Git compatibility has a concrete boundary: native `git stash show`,
`apply`, `apply --index`, storage, and transfer understand the native parent/tree
shape and preserve the custom header. Native `git stash branch` starts at `P`
and leaves that synthetic commit as branch HEAD; it does not implement GitGui's
original-HEAD branch semantics. GitGui must not delegate this case to native
`stash branch`. Likewise, native Apply at clean original `H=A` can report
"already applied" with index/worktree both `A`; it does not restore the `B`
index context. This is ordinary merge behavior, so GitGui Apply/Pop retains
that meaning while the explicit branch action restores context as described.

The local installed Git manual (`git-stash.html`, Discussion and branch
sections, Git `2.49.0.windows.1`) defines the native first-parent baseline and
second-parent index shape. The runnable primary evidence is
`crates/gitgui-core/tests/stash_encoding.rs`; it constructs the objects with
Git plumbing and exercises the actual installed Git, without implementing
selected push, inspection handlers, or action handlers.

## Compatibility and client selection

Legacy `stashPush(params: GitStashPushParams): Promise<GitStashPushResult>` and
`stashPop(repositoryId: string): Promise<GitStashPopResult>` keep their existing
wire methods, request shapes, result snapshots, and defaults (`includeUntracked`
defaults to true). The new selected push is a separate method, so an older server
cannot ignore a selection field and accidentally stash everything. Likewise, an
older server cannot ignore a reviewed target and pop its current latest entry.
Toolbar Pop uses a newly captured latest target with `stashPopTarget`
when supported. The legacy call remains available for compatibility; do not use it
as an automatic fallback for targeted operations. No protocol-version bump is
needed for additive, capability-gated methods.

`SelectedGraphItem` adds `{type: "stash"; stash: StashInfo}`. The workspace exposes
`selectedStash` and `selectStash(stash)`, with ordinary selection resets and no
Git read or mutation in the selection helper. The UI callers use this selection. Snapshot
reconciliation retains a stash and its selected file only when selector and OID
both match; otherwise it clears both without falling through to the next row.
Initial commit selection excludes stash objects.

`captureStashActionContext(environmentId, repositoryId, stash)` copies the reviewed
identity into a readonly `StashActionContext`. Downstream actions must bind that
environment's current session at execution time and refuse mismatched context;
capturing the IDs does not itself enforce routing. `stashContextPaths(clickedPath,
selectedPaths)` uses only the clicked section's selection and preserves literal
paths. The client facade independently refuses an empty selected-push list.

A selector and OID cannot distinguish identical reflog entries in every external
delete/reinsert race. The UI conservatively clears selection on reindex
instead of following the same OID to another selector. The server must recheck
before removing a restored entry and refuse a replacement. Exact reflog-entry
identity beyond the approved selector/OID pair would require a later contract
change; Git processes outside GitGui do not share its application lock.

Validate all repository-relative paths on the server, with literal pathspecs,
safe Git arguments, and repository containment checks. Preserve spaces, tabs,
newlines, Unicode, and rename metadata. No shell interpolation, arbitrary refs,
durable secrets, or Electron IPC is added to the Git protocol. Server capabilities
gate the UI; method registration alone is insufficient.

## Implementation ownership

- `git::stash_selected` captures only explicit staged/unstaged paths and reports
  saved stashes even when cleanup is incomplete. See `stash-selected-implementation.md`.
- `git::stash` validates the shared durable layout, and `git::stash_inspection`
  returns combined saved files and bounded immutable diffs. The repository loader
  uses decoded original HEAD and filters unadopted helpers. See
  `stash-inspection-implementation.md`.
- `git::stash_actions` implements exact Apply/Pop/Delete/Branch with progress
  receipts. See `stash-actions-implementation.md`.
- The Svelte workspace, dialogs, file tree and diff viewer consume generated APIs
  and capabilities, preserving captured environment/repository/target identity.
  See `stash-ui-implementation.md`.
- `gitgui-server::stash` owns protocol validation, domain-to-wire conversion,
  common-directory plus worktree serialization, and existing-channel invalidation.
  All seven methods are accepted, scoped and advertised. Legacy methods retain
  their request/default/snapshot result shapes and share stash serialization.
  See `stash-server-integration.md`.

Core APIs and the seven facade signatures remain unchanged. Rust owns Git and
repository state; the browser runtime talks directly to the selected server.
Electron, connection/session/retry ownership and protocol version are unchanged.
The sections below record historical foundation/encoding validation; the status
above and the integration document describe the final implementation.

## Foundation validation

Passed `npm run protocol:generate`, `cargo check -p gitgui-protocol`,
`cargo test -p gitgui-protocol` (five contract tests), `npm run check`, the
focused client RPC registry/facade tests (six), workspace stash selection tests
(five), and `cargo test -p gitgui-server --lib every_registered_method_is_dispatched`.
`git diff --check` passed. The Svelte check reports one existing accessibility
warning in the untouched `WorkingTreeFileList.svelte`.

The initial server test command without `--lib` could not replace the running
`target/debug/gitgui-server.exe`; the library-only registry test passed without
touching that process. `npm run vendor:sync` is blocked by the local T3 checkout
being at `70cd258d8aac43ea57494527b00bf36de3efa6c0` instead of the pinned
`1688f965682d331da16a8c39f049592361f69c8d`. Only the reviewed local RPC-table
hash was updated; the upstream pin and upstream hash remain unchanged.

## Review P1 response and validation

P1 identified that original-HEAD inspection and restoration cannot represent
selected unstaged inverse changes. The fix separates original HEAD from the
patch baseline through a native stash graph plus one versioned raw commit
header. No new DTO fields, RPC methods, server capabilities, runtime changes,
or UI were added. Canonical Rust comments describe inspection/branch semantics;
the regenerated TypeScript documents `baseHash` as original HEAD rather than
the synthetic patch baseline.

`cargo test -p gitgui-core --test stash_encoding -- --test-threads=1` covers:
inverse `A/B/A` capture; inspection as `B -> A`; cleanup leaving index `B`;
native Apply with/without index; untracked combination; exclusion/preservation
of unrelated staging/worktree edits; original-HEAD branching with selected
baseline context; native branch's synthetic-HEAD divergence; native Apply's
already-applied result at clean original HEAD; staged-only native format;
external stash compatibility despite marker text in the message; and a fresh
repository fetching only `refs/stash` and reconstructing the original HEAD,
baseline and inverse without any sidecar. A selected untracked replacement
after staged deletion is also verified to appear only in `U`, preserving the
staged deletion on Apply. These are format proofs using
isolated temporary repositories, not backend rollout implementations.

Fix-round checks passed: all eight Git format fixtures on installed
`2.49.0.windows.1`, `npm run protocol:generate`, `cargo test -p gitgui-protocol`
(five contract tests plus doc tests), `npm run check` (zero errors; the same
existing `WorkingTreeFileList.svelte` accessibility warning), and
`git diff --check`. No production decoder, mutation handlers, or feature UI
were introduced in this fix round.
