# Stash server integration

The current inspection path returns lightweight changed-object plans from a
server-owned cache and schedules bounded background preparation/strict validation.
It keeps immutable data across ordinary stash reindexing, evicts on catalog
removal, and carries admission generations through queued/blocking work. Repository
display snapshots use batched stash commit metadata, without a whole saved-tree
audit. Scope, capability, protocol and mutation-lock behavior are unchanged. See
the current section of `stash-inspection-implementation.md` for the read contract,
queue limits, command counts, source references and remaining external-writer limits.

The following paragraph records the superseded shared-decoder optimization.
That inspection optimization routed both read handlers through a server-owned
`StashInspectionCache` in Git core. `git.stash.files` obtains its metadata and
files from one validated inspection; `git.stash.file_diff` reuses validated trees
and bounded diff results. Each call still checks the reviewed selector/OID and
cached object availability. The cache is scoped to this environment and roots,
and is evicted alongside existing read caches for stash mutations (including
known linked registrations) and repository removal. No scopes, capabilities,
wire shapes, Git mutation locking, or mutation receipts changed. Details and
measurements are in `stash-inspection-implementation.md`.

Fast-read/preparation verification on 2026-10-24: all 51 server library tests
passed with `--test-threads=4` (112.51 s). The default-concurrency run had 48 passes
and three deadline timeouts in existing RPC fixtures; all passed in the complete
bounded rerun without changing production behavior or deadlines. Seven preparation
tests cover priority/deduplication, queue bounds, same-stash file selection changes,
background rejection/event filtering, removal/reopening, and cross-repository
generation rescheduling. The independent reviews cleared all reported findings.

Post-optimization verification: the server library passed **44 tests at default
concurrency (82.91s)** when run without the core Git fixture suite alongside it.
The initial simultaneous core/server run had resource/deadline failures; the
independent rerun cleared all of them without modifying lifecycle behavior or
test deadlines. Workspace/all-target compilation and focused formatting passed.

The seven stash features are accepted, authorized and advertised by the standalone
Rust server. This completes the canonical-contract/client foundation without
changing the public core APIs, facade signatures, protocol version, Electron,
or connection/session/retry ownership. Existing uncommitted core/UI work was
preserved. GitGui owns the stash domain; T3 Code supplies the existing client
and server boundary concepts, not Git behavior.

## Boundary and compatibility

`crates/gitgui-server/src/stash.rs` maps the public `git::stash`,
`stash_selected`, `stash_actions` and `stash_inspection` domain APIs to Rust
protocol DTOs. Core has no protocol dependency. The five new mutations require
exactly `repository:operate`; files and file_diff require exactly
`repository:read`. Neither scope implies the other. The usual authenticated
HTTP/WebSocket session and ticket path remains authoritative.

Each method has its matching capability string. `STASH_FEATURE_METHOD_NAMES`
is now a clearly documented subset of accepted `WS_METHOD_NAMES`; it is no
longer reserved and is never concatenated with the accepted registry in tests.
Server capability filtering removes duplicates and unimplemented names. The
generator emits the accepted list and feature subset from Rust, and the existing
adapted client table/facade agree. Older servers still require capability gating;
targeted calls never fall back to latest Pop.

Legacy `git.stash.push` and `git.stash.pop` retain their request/result shapes,
stash-all/latest semantics, snapshot results, and defaults (including
`includeUntracked: true`). They now share the same stash mutation locks and
invalidation. Their existing refresh-failure diagnostic still records
`mutationSucceeded`; the new APIs return receipts instead of snapshots.
Legacy errors now use fixed safe diagnostics rather than exposing Git output.

## Validation and diagnostics

All seven canonical request DTOs, including nested targets, deny unknown fields.
There is no force/discard/restore-index option. Repository IDs must resolve in the
server catalog. Target selectors are canonical decimal `stash@{n}` strings and
expected OIDs are full hexadecimal SHA-1/SHA-256 IDs matching the repository's
installed-Git object format. Core resolves and compares the exact selector/OID
under mutation serialization and validates the entire saved layout. Missing or
replaced targets map to `stash_target_changed`, never a latest entry or OID search.
Branch names are bounded literal names checked with Git's `check-ref-format`;
aliases and option-like names are rejected. Core owns existing-branch collisions,
checkout safety and progress reporting.

Explicit selections contain 1–4096 unique paths, at most 1 MiB total path bytes.
Each path is at most 32 KiB and 128 slash components; messages are at most 4096
bytes. Empty/NUL/absolute paths and empty, dot or parent components are invalid.
Live selection excludes Git metadata and applies Windows filename restrictions
on Windows. Spaces, tabs, newlines, Unicode, option-looking and pathspec-looking
names remain literal on hosts supporting them; no trimming or shell expansion
is used. Saved-object reads also preserve backslashes and colons as object names
without interpreting them as host filesystem paths. Core validates live ancestry
and containment before capture/cleanup. Non-UTF-8 paths remain unsupported by the
existing String-based wire/domain model. Stash inspection keeps core's bounded
metadata/content behavior and cannot return live hunk continuation handles.

Malformed parameters use `invalid_params`. Target changes use
`stash_target_changed`. Valid requests refused by Git/layout/preflight checks use
`git_operation_failed` with a fixed safe message, never raw stdout, stderr,
arguments or repository-controlled diagnostics. Action receipt errors use the
core's typed static diagnostic messages. Selected partial receipts preserve the
saved stash and use a fixed cleanup diagnostic. A worker panic uses
`internal_error` with explicit unknown-completion guidance; it cannot promise that
no mutation happened or authorize a replay.

## Serialization and request lifetime

Lock order is **one registration's existing worktree mutation lock, then one
stash lock keyed by canonical common Git directory**. Git's
`rev-parse --path-format=absolute --git-common-dir` supplies that directory;
bounded UTF-8 output is decoded without trimming path whitespace and the actual
directory is filesystem-canonicalized, using the existing Windows path-key
normalization. Common metadata legitimately lies outside a linked worktree.
No renderer-supplied generic filesystem capability is introduced.

All five new mutations and both legacy stash methods take these locks. Existing
stage/commit/branch operations continue taking their per-registration lock.
Registration locks are deliberately distinct, even for linked worktrees. Stash
code never takes another registration while holding the common-directory lock.
The existing worktree-removal path continues acquiring its deduplicated
registration locks in sorted order, avoiding a double acquisition of one shared
Arc or an inversion between common and registration locks. Independent common
directories and independent environment state instances have independent locks.

Git work runs in `spawn_blocking`. Owned worktree/common guards move into the
actual mutation worker and remain there until it finishes, even if an awaiting
task is dropped. The existing `rpc_queue` retains started dispatches on cancel or
disconnect; mutation cancellation cannot abort or replay Git. Stash reads use
its ordinary cancellable read lane and retain their slot until their worker
finishes. They read immutable saved objects without acquiring mutation/hunk
preparation locks. No second scheduler or event bus was added.

## Receipts and invalidation

New mutation receipts preserve success, noChanges, conflicts, partial cleanup,
stash retention/removal, restore progress and surviving created branches. A
completed receipt never waits for snapshot/status/history refresh. Successful
restore followed by failed removal stays partial/retained/succeeded. Branch
creation/switch followed by failed restore preserves branch progress. Subsequent
read or publication failures cannot convert these results into failed mutations.

Before mutating, the server discovers known registrations sharing the common
directory, retaining the original registration even if discovery of a different
repository fails. After the worker, it evicts affected commit caches and live hunk
reviews and sends broad `Snapshot` invalidations through the existing repository
broadcast channel. Those hints cover stash catalogs, branches/history, status
and file views. They require no successful post-operation filesystem read.
Failures and panics also invalidate conservatively. Missing receivers and event
serialization errors do not replace the receipt. Watcher hints and explicit
invalidations use one short, synchronous sequence/publication guard on the
environment's existing channel, preserving event order without a new lifecycle.

## Encoding, provenance and limits

The durable selected-unstaged encoding remains exactly the reviewed graph in
`stash-features.md`: original H differs from patch baseline P, W carries the
versioned raw header, inspection compares P→W plus U, and Branch starts at H and
restores selected index context. The integration never interprets a user message
as metadata. Native Git stash storage/apply/transfer compatibility and the native
`stash branch` baseline difference remain as documented there. Core APIs were
consumed unchanged and no domain files were patched by this integration.

The current local T3 checkout at
`D:\GitHub\PictureTagingApp.references\t3code`,
`70cd258d8aac43ea57494527b00bf36de3efa6c0`, was re-inspected for workspace-layout,
connection-runtime and RPC protocol boundaries. The accepted method-table
adaptation is recorded in its header, `t3code-vendoring.md` and only its local
manifest hash. The pinned upstream snapshot/hash and `effect`/`@effect/vitest`
versions remain unchanged. Full vendor sync still requires the pinned checkout;
this integration does not claim an upstream resync.

Application locks cannot serialize arbitrary external Git/filesystem writers.
Core's immutable identity and safety checks remain necessary; identical
delete/reinserted selector/OID pairs cannot be distinguished by this contract.
There are no durable operation IDs or exactly-once recovery. If transport is lost
before a receipt, inspect/refresh and require an explicit new action. Newly
registered or already inaccessible linked paths may not be discoverable during
one invalidation pass; existing watches and normal hydration remain authoritative.
Read validation may fail if external Git removes entries/objects during a read.

## Verification

Focused library fixtures use only temporary repositories/state and ephemeral
in-process listeners. They cover all seven dispatches, unique registries and
capabilities, exact independent scopes over ticket-authenticated production
WebSockets, selected-source receipts and preservation, no-op/empty/unknown
parameters, full SHA-1/SHA-256 targets, custom inverse/original-base branching,
saved untracked diffs, exact older entries and stale/missing targets, safe Delete,
Pop success/conflicts/partial restoration, surviving branch progress, linked and
legacy serialization, independent repositories/environments, shared ordered
invalidation, cache/hunk eviction, receipt survival after metadata disappears,
read scheduling/cancellation, started dispatch disconnect, dropped worker await,
and safe unknown completion on panic. Unix-only unusual-filename round trips are
compiled conditionally and were not executed on this Windows host.

Earlier verification on Windows with installed Git `2.49.0.windows.1`
(before the independent default-concurrency failure described below):

- `cargo test -p gitgui-server --lib -- --test-threads=4`: **44 passed**,
  including 21 stash integration tests and all 23 existing library tests;
  0 failed, 293.16 seconds for the final snapshot. The Unix-only additional
  unusual-filename round trip was not executed.
- `cargo check --workspace`: passed against the final code.
- `npm run protocol:generate`: passed; committed-output location regenerated
  deterministically, with no manual TypeScript contract changes.
- `cargo test -p gitgui-protocol`: all five contract tests passed, plus library,
  generator and documentation targets.
- `npm run test -w @gitgui/client-runtime -- src/rpc/protocol.test.ts src/rpc/stash.test.ts`:
  both files passed, six tests total.
- `npm run check`: all workspace checks passed, zero Svelte errors and the
  existing `WorkingTreeFileList.svelte` accessibility warning.
- `rustfmt --edition 2021 --check crates/gitgui-server/src/stash.rs` (including
  its new child test module) and `git diff --check`: passed.
- The adapted RPC-table local SHA-256 matches the manifest. `npm run vendor:sync`
  stops at the existing checkout mismatch (`70cd258...` versus pinned
  `1688f965...`); upstream pins/hashes were deliberately preserved.

Cargo used isolated `%TEMP%/gitgui-stash-server-integration-20261023-a91f`
and `%TEMP%/gitgui-stash-server-protocol-20261023-a91f` output directories.
One overlapping rerun hit `LNK1104` while the preceding library executable was
still running; after that suite exited normally, the sequential final run above
passed. No running app executable was replaced or process terminated.

## Default-concurrency timeout follow-up (2026-10-23)

The later independent integrated validation failed with default Rust test
concurrency: **40 passed, 4 timed out**. The affected fixtures were
`rpc_tests::same_repository_mutations_keep_wire_order` (10-second response wait),
`common_directory_lock_serializes_linked_and_legacy_stashes_and_keeps_worktree_lock`
(30-second independent selected stash),
`dropped_mutation_await_keeps_both_guards_until_started_blocking_worker_finishes`
(30-second guard reacquisition after a real selected stash), and
`cancel_and_disconnect_cannot_abandon_started_selected_or_legacy_stash_dispatches`
(30-second guard reacquisition after a real RPC mutation). The earlier four-thread
pass did not resolve this failure and was insufficient final validation.

The implementation follow-up reproduced **41 passed, 3 failed in 98.66 seconds**
using `cargo test -p gitgui-server --lib --target-dir
target/stash-final-validation-20261023-1742`, with no thread-count option or
`RUST_TEST_THREADS` override. All three stash failures occurred at the same
30-second deadlines; the wire-order fixture passed this time. The original
dropped-await fixture then passed alone in **5.20 seconds**. This establishes
load-dependent fixture timing: the same actual selected save exceeded 30 seconds
under concurrent Git work, while the isolated fixture finished in about five.
The independent core validation also reported 715.49 seconds for its inspection
suite, consistent with substantial Git/process load.

Inspection found no server locking, cancellation or lifecycle defect. Production
`mutate` moves both owned guards into the actual blocking worker; socket cancel
and disconnect retain started dispatches. No production implementation, timeout,
architecture, core, protocol, client/runtime or UI code changed in this follow-up.
The initial fix edited only the two server test files and this document; the
explicitly authorized watcher-fixture extension below also edits the test
section of `crates/gitgui-server/src/watching.rs`.

The fixture changes preserve explicit concurrency and behavioral assertions:

- The dropped-await fixture uses the real `mutate` worker with a started
  notification, bounded blocking gate and completion marker. It checks both
  guards before and after cancelling the await, checks that the callback has not
  finished, releases it and then checks both guards and completion. It no longer
  runs another selected stash to prove guard ownership. Dropping the gate sender
  on a failing assertion releases the worker; its receive also has a 30-second
  bound. Post-release guard waits remain bounded at 15 seconds.
- The linked/legacy fixture explicitly polls the actual dispatches until
  suspended and checks their distinct worktree guards. The final proof follow-up
  below additionally requires each actual common-lock acquisition to report
  `Pending` after metadata discovery, before an independent repository enters
  the real `mutate` worker with a cheap callback. This removes an unnecessary
  independent selected-save workload. After common-lock release, actual linked
  selected Push, legacy Push and queued Stage still run concurrently to
  completion. Their receipts, legacy snapshot shape, two shared stashes and final
  clean index remain asserted.
- Cancel/disconnect still runs actual selected Push, legacy Push and legacy Pop
  through the production WebSocket loop. It checks retained worktree ownership
  after socket exit, then waits for the existing repository invalidation emitted
  after worker completion. It checks that event's repository/kind, immediate
  availability of both guards and the actual saved/removed stash state.
- Metadata/progress and real Git completion waits use the shared 120-second
  fixture bound:
  concurrent linked dispatch completion, independent-worker metadata discovery,
  initial worker metadata discovery, disconnected RPC completion and the two
  stage/unstage wire responses. The measured default suite took 98.66 seconds and
  actual selected work exceeded 30 seconds, justifying this finite outer bound.
  Ordinary RPC receive and socket-exit bounds stay unchanged. There is no global
  serialization, thread-count override or added sleep.

Focused reruns used the same target directory, with one test per command:

```text
cargo test -p gitgui-server --lib --target-dir target/stash-final-validation-20261023-1742 stash::tests::common_directory_lock_serializes_linked_and_legacy_stashes_and_keeps_worktree_lock -- --exact --nocapture
cargo test -p gitgui-server --lib --target-dir target/stash-final-validation-20261023-1742 stash::tests::dropped_mutation_await_keeps_both_guards_until_started_blocking_worker_finishes -- --exact
cargo test -p gitgui-server --lib --target-dir target/stash-final-validation-20261023-1742 stash::tests::cancel_and_disconnect_cannot_abandon_started_selected_or_legacy_stash_dispatches -- --exact
cargo test -p gitgui-server --lib --target-dir target/stash-final-validation-20261023-1742 rpc_tests::same_repository_mutations_keep_wire_order -- --exact
```

All four passed (one passed, 43 filtered out in each command), respectively in
**12.01, 0.64, 10.47 and 1.95 seconds**. Test count remains 44; no tests were
removed, ignored or added.

The first full default-concurrency rerun after those changes passed every stash
and RPC fixture, but finished with **43 passed, 1 failed in 108.62 seconds**:
`watching::tests::native_changes_are_scoped_and_watches_follow_removal_and_shutdown`
failed at its final `rx.try_recv().is_err()` assertion (`watching.rs:495` in the
original fixture). The original watcher test then passed alone in **6.48
seconds**. The user explicitly expanded ownership to this watcher test fixture,
while retaining the prohibition on watcher production changes.

The watcher fixture assumed its catalog-removal pass had run after a fixed
1.3-second sleep. The real loop may still be awaiting Git metadata discovery or
ignore filtering at that point, so the sleep established no synchronization
with removal. The fixture now registers its already-created linked worktree and
awaits that registration's initial Snapshot invalidation. The watcher catalog
pass removes retired watches before creating the new one, so this existing
event proves removal was observed before either subsequent filesystem edit.
The first post-edit event must belong to the independent repository; the test
no longer silently skips unexpected repository IDs while looking for it. The
original no-extra-event and shutdown assertions remain, and all watcher
deadlines remain unchanged (8-second event waits and 2-second shutdown wait).
Failure diagnostics now include any unexpected event. The original failed
assertion did not retain its payload, so the exact native event behind that
failure is unavailable; no production watcher defect was established.

The synchronized watcher fixture passed alone in **6.18 seconds** using:

```text
cargo test -p gitgui-server --lib --target-dir target/stash-final-validation-20261023-1742 watching::tests::native_changes_are_scoped_and_watches_follow_removal_and_shutdown -- --exact --nocapture
```

Final verification after the watcher fixture fix:

```text
cargo test -p gitgui-server --lib --target-dir target/stash-final-validation-20261023-1742
cargo check -p gitgui-server --all-targets --target-dir target/stash-final-validation-20261023-1742
rustfmt --edition 2021 --check crates/gitgui-server/src/stash/tests.rs crates/gitgui-server/src/rpc_tests.rs
git diff --check
```

The full server library suite passed with **44 passed, 0 failed, 0 ignored,
0 filtered out in 110.51 seconds**, using default test concurrency and no
`RUST_TEST_THREADS` override. The server all-targets check, scoped rustfmt and
whitespace checks passed. The changed watcher test function was also extracted
without its module indentation to `%TEMP%/gitgui-server-timeout-baseline-20261023-0846/watcher-fixture-format.rs`
and checked with `rustfmt --edition 2021 --check` on that path. Existing formatting
outside that fixture was preserved, including production watcher code. Test
count remains 44, including 21 stash tests; no tests were added, removed or
ignored. These results resolve the reproduced failures in this implementation
run and are ready for independent verification.

The existing isolated Cargo target was reused only after checking that no Cargo
process owned it. All spawned test commands ran sequentially and their sessions
were observed through exit before another Cargo command used that target. No
root Git mutation, services, delegation, process termination, commits, PRs or
workspace worktrees were used. Temporary fixture repositories, linked worktrees
and ephemeral listeners remain isolated.

Fresh parent review and an independent default-concurrency server rerun are still
required before overall completion. Core/frontend suites were not repeated in
this test-only follow-up. Unix-only filename coverage remains unexecuted on this
Windows host, and finite integration bounds cannot guarantee completion under
arbitrary host starvation.

### Final common-lock proof follow-up (2026-10-23)

The final P2 review identified a fixture assurance gap, not a production defect.
Racing shared RPC completion against the cheap independent callback did not
exclude shared worker entry: a bypassed lock could admit slow Git work that
still lost that race. The preceding default-concurrency passes therefore did
not establish this particular serialization claim.

The fixture now scopes a separate test-only progress channel to each actual
selected/legacy dispatch future using `tokio::task_local!`. There is no global
mutable observer, server-state field, production callback API, or cross-test
registration. A `poll_fn` wrapper polls the actual common-lock acquisition
future and reports its first `Pending`; this occurs after Git common-directory
discovery and lock lookup, not at an earlier metadata-worker suspension.
Both requests must report that checkpoint while the fixture retains
`common_guard`. The wrapper returns the actual future's poll result unchanged.

Immediately after acquisition returns, `CommonLockAcquired` is sent before any
further await or blocking-worker submission. The actual operation worker also
sends `WorkerEntered` immediately before its callback. Thus a skipped/bypassed
lock cannot hide behind slow affected-repository discovery, a queued worker or
slow Git completion. Before releasing the common guard, the fixture requires
both pending checkpoints, polls all three real dispatches while the independent
worker completes, rejects any subsequent progress, and checks both worktree
guards remain held. After release it requires the acquired/entered signals for
both workers as well as the existing real selected receipt, legacy snapshot,
Stage result, two shared stashes and clean linked index.

All instrumentation references in `stash.rs` use `#[cfg(test)]`; its helpers and
task-local storage live in the existing test-only module. Non-test compilation
only splits the existing lock acquisition expression into its future and await,
without changing lock order, ownership or worker behavior. No new blocking
gates, sleeps or global serialization were introduced. Progress waits and real
Git completion keep the justified finite 120-second bound. On a failed pending
proof the owned dispatch futures are dropped, cancelling their lock waits;
there is no gated worker that requires a cleanup signal. The settled dropped-
await, watcher-removal and actual RPC cancel/disconnect fixtures are unchanged.

Negative regression used an isolated source copy at
`%TEMP%/gitgui-common-lock-negative-20261023-1232`, containing the current Cargo
workspace manifests and crates, including existing uncommitted code. Replacing
the common lock with an unrelated mutex for only the linked selected request
failed in **1.00 second** with `selected must wait on the held common lock before
worker entry`: actual `Some(CommonLockAcquired)`, expected
`Some(CommonLockPending)`. The analogous legacy-only bypass failed at the same
checkpoint in **0.99 seconds**, naming `legacy`. Neither failure depends on
worker completion. Both commands ran exactly one fixture, with 43 filtered out.
The copy was restored byte-for-byte; SHA-256 checks confirmed both shared source
files were unchanged across the mutations. No bypass was written to the shared
checkout.

The first positive focused run passed **1 test, 43 filtered out in 12.09 seconds**.
Returning from the negative copy to the same Cargo output directory unexpectedly
reused the legacy-mutant executable (Cargo reported no compilation). That
accidental full run (**42 passed, 2 failed in 101.77 seconds**, with the expected
legacy checkpoint and missing-common-guard failures) is excluded from positive
validation; it was allowed to exit normally. Final shared-source validation uses
a fresh dedicated target directory to prevent artifact reuse across source roots.

Final shared-source verification used only
`target/stash-common-lock-proof-final-20261023-1232`:

```text
cargo test -p gitgui-server --lib --target-dir target/stash-common-lock-proof-final-20261023-1232 stash::tests::common_directory_lock_serializes_linked_and_legacy_stashes_and_keeps_worktree_lock -- --exact --nocapture
cargo test -p gitgui-server --lib --target-dir target/stash-common-lock-proof-final-20261023-1232
cargo check -p gitgui-server --all-targets --target-dir target/stash-common-lock-proof-final-20261023-1232
rustfmt --edition 2021 --check crates/gitgui-server/src/stash/tests.rs %TEMP%/gitgui-common-lock-negative-20261023-1232/stash-instrumentation-format.rs
git diff --check
```

The fresh focused run passed **1 test, 43 filtered out in 12.34 seconds**. The
full server library suite passed **44 tests, 0 failed, 0 ignored, 0 filtered out
in 110.15 seconds**, with default concurrency and `RUST_TEST_THREADS` confirmed
absent. The all-targets check passed, including production and test compilation.
Scoped rustfmt passed for the whole test file and exact new `stash.rs` spans
extracted into parsing wrappers; existing formatting elsewhere was preserved.
Whitespace checks include a direct trailing-whitespace scan of all three owned
files because they are currently untracked. Test count remains **44**, including
**21 stash tests enabled on Windows** (22 in source, one Unix-only); no tests were
added, removed or ignored.

This final proof fix edits exactly `crates/gitgui-server/src/stash.rs`,
`crates/gitgui-server/src/stash/tests.rs`, and this document. All existing
uncommitted feature and timeout work is preserved. No unrelated suites,
development services, process termination, delegation, commits, PRs or Git
worktrees were used. Fresh independent review subsequently closed the P2 with
no new findings. That reviewer reran the focused fixture successfully (one passed,
43 filtered out, 12.22 seconds), checked the non-test server library, scoped
formatting and whitespace, and confirmed source hashes remained unchanged.
Unix-only filename
coverage remains unexecuted on this Windows host, and the finite fixture bounds
cannot guarantee completion under arbitrary host starvation.

## Changed files in this integration

These changes extend the foundation already present in the shared checkout:

- `crates/gitgui-server/src/stash.rs` (new boundary/locking/receipt module)
- `crates/gitgui-server/src/stash/tests.rs` (new focused integration fixtures)
- `crates/gitgui-server/src/lib.rs` (dispatch, scope, capability and state wiring)
- `crates/gitgui-server/src/watching.rs` (shared sequence/publication owner)
- `crates/gitgui-server/src/rpc_tests.rs` (existing fixture helper visibility only)
- `crates/gitgui-protocol/src/lib.rs` (accepted registry and capability constants)
- `crates/gitgui-protocol/src/bin/generate-typescript.rs` (feature-subset comment)
- `crates/gitgui-protocol/tests/stash_contracts.rs` (accepted-registry assertions)
- `packages/contracts/src/protocol.ts` (generated output)
- `packages/client-runtime/src/rpc/protocol.ts` (accepted-table provenance/comments)
- `packages/client-runtime/src/rpc/protocol.test.ts` (registry/subset equality)
- `scripts/t3code-vendored.json` (only adapted protocol table's local hash)
- `docs/t3code-vendoring.md` (accepted-table divergence)
- `docs/stash-features.md` (final status and implemented ownership)
- `docs/stash-server-integration.md` (this document)

Core stash/inspection/selected/actions/repository files and exports, the client
promise facade, web components/workspace, and Electron were read without edits.
No commits, PRs, workspace worktrees, development services, delegation or process
termination were performed. Temporary fixture linked worktrees and listeners
were used only inside the isolated tests authorized for this integration.
