# Responsive file discard

Discard still requires explicit review. Submission closes the dialog immediately;
only a validated backend receipt authorizes local row reconciliation. Pending
operation state clears before the result toast, independently of status refresh.
Transport errors and malformed receipts report unknown completion and never replay
the operation. Refresh recovery is read-only.

## Backend work

Preview and confirmed validation resolve the repository once, use the status
response's HEAD, and batch selected index queries. Fingerprints still include
HEAD, every selected index stage, permissions, and all worktree bytes (or the
symlink target). They remain compatible with reviews made before this change.

Ordinary contiguous tracked targets restore through one literal, NUL-delimited
pathspec stream, in groups of at most 64. The first group can reuse the complete
current-state validation only when it covers the whole selection. Later groups
revalidate before mutation. Both indexed and worktree filter attributes are
checked before hashing: either source of filters disables grouped restoration.
Attribute and index queries use bounded argument batches, including on Windows.
Attribute queries avoid the synchronous stdin/stdout streaming deadlock.

Every untracked deletion still performs a fresh full fingerprint immediately
before `remove_file`. No recursive deletion, reset, or clean is used. A filter
that changes a later tracked or untracked file causes refusal at that target.
A failed grouped restore is never retried: a fresh status/index read credits
only paths observed clean against their reviewed index and HEAD. Other paths
remain unresolved in the partial receipt.

The server status RPC resolves the root once, then reads status from that root.
It preserves the existing missing-repository error classification. No wire
contract or protocol version changed.

## Client reconciliation

The Svelte store captures the reviewed client, workspace, repository, and
environment. Dialog preview generations prevent late responses replacing newer
reviews. Session replacement invalidates its old dialog. Action identity allows
the original pending action to settle after environment selection changes without
clearing another action or running another environment's old queue.

`ClientWorkspace` captures a request/lifecycle checkpoint before dispatch, which
supersedes older status reads. A receipt updates only completed rows in the same
view generation: tracked rows retain their staged side and untracked rows can be
removed only after confirmed deletion. A newer watcher observation, refresh,
disconnect, removal, or snapshot prevents the receipt from replacing newer state.
Only affected paths invalidate mutable previews. Unrelated rows/history keep
their existing data, and status reads do not set the panel loading flags.

The existing 75 ms invalidation scheduler owns reconciliation. It coalesces
watcher/receipt demand per repository, pauses new background reads for an active
discard, retains newer events during reads, and unions paths with snapshot
precedence when deferring one repository behind another. A superseded full
refresh settles its loading flags and keeps its full metadata refresh demand.
Only one pending refresh-error callback is retained per repository. Closing or
disposing a workspace releases it.

Amend availability revalidates on full snapshots and unfiltered status observations
that can include Git workflow metadata. Targeted worktree row updates and synthetic
discard reconciliation do not enqueue another passive amend review. This prevents
amend reviews from queuing repository-lock work ahead of the next interactive
operation while still detecting merge/rebase blockers created or removed without
changing HEAD. Metadata observation counters are local to each open repository.

This stays in the existing Rust Git/server and Svelte workspace adapter boundaries.
The current T3 `workspace-layout.md` and `connection-runtime.md` were inspected;
their separation of domain data synchronization from connection/session ownership
is preserved. No vendored connection runtime, retry, socket, or Electron lifecycle
implementation changed.

## Reproducing measurements

Counters measure application-launched Git processes and explicit fingerprint
reads/bytes, excluding Git's internal reads and child processes. All fixtures use
temporary repositories; no actual user changes are discarded.

```sh
cargo test -p gitgui-core measure_discard_pipeline -- --ignored --nocapture --test-threads=1
cargo build -p gitgui-server --target-dir target/discard-benchmark
```

Run the opt-in mounted UI/RPC measurement from PowerShell:

```powershell
$env:GITGUI_DISCARD_IT = '1'
npm run test -w @gitgui/web -- src/lib/workspace/discard.live.test.ts
```

The UI fixture starts its own authenticated ephemeral test server on a random
port, sends bootstrap material through stdin, and stops only that child process.
It uses the real connection runtime/RPC client and mounted staging/dialog
components under Happy DOM. Icons and Sonner presentation are stubbed; row DOM
updates, pending state, dialog submission, and toast publication are measured.
It measures DOM reconciliation rather than physical browser paint. The existing
development UI and Electron-owned backend remain running and are not restarted.

The baseline UI comparison uses modules extracted from the base commit via
`git show HEAD:<path>` into temporary adjacent `discard-baseline.svelte.ts` and
`workspace.baseline.ts` files, with the original server binary. Set
`GITGUI_DISCARD_STORE_MODULE=./discard-baseline.svelte`,
`GITGUI_DISCARD_WORKSPACE_MODULE=../client-runtime/workspace.baseline`,
`GITGUI_DISCARD_BINARY=<baseline binary>`, and `GITGUI_DISCARD_LABEL=before`.
Remove those two generated source files after measuring; they are not shipped.

There are no CI latency thresholds. Regression tests assert exact process/read
counts for 1 and 20 ordinary tracked files and test behavior with deferred replies.

## Measurements

Windows, debug Rust binaries, three samples per case, 4 KiB modified content per
file. Exact core work across preview / confirmed discard / explicit status:

- One tracked file: Git launches **5 / 8 / 3 → 3 / 4 / 2**; fingerprint
  reads **1 / 2 / 0 → 1 / 1 / 0** (12,288 → 8,192 bytes).
- Twenty tracked files: Git launches **62 / 122 / 3 → 3 / 6 / 2**; fingerprint
  reads **20 / 40 / 0 → 20 / 20 / 0** (245,760 → 163,840 bytes).

These counts exclude independent watcher/background requests. Filtered files,
mixed selections, long argument batches, deletions, and failure recovery retain
additional validation work. Untracked deletion deliberately retains its extra
pre-delete full read.

The isolated core pipeline's median confirmed-discard time fell from 679.81 to
236.62 ms for one file and from 11,279.66 to 366.89 ms for twenty files. Complete
status reconciliation is still measured separately, not included in the new
receipt/publication path.

Mounted UI/RPC samples (milliseconds, one fresh temporary repository/server/store
per sample; each array is in sample order):

- One file, before: receipt `[540.83, 758.08, 487.33]`, rendered rows
  `[926.11, 957.66, 687.47]`, result `[925.59, 957.14, 686.89]`.
- One file, after: receipt `[890.50, 578.45, 434.03]`, rendered rows
  `[894.56, 593.70, 437.04]`, result `[891.39, 579.04, 434.52]`.
- Twenty files, before: receipt `[10871.23, 10966.28, 10594.04]`, rendered rows
  `[11502.88, 11551.26, 11332.03]`, result `[11723.05, 11550.84, 11574.68]`.
- Twenty files, after: receipt `[405.28, 560.27, 361.16]`, rendered rows
  `[409.53, 563.83, 365.49]`, result `[405.55, 560.52, 361.55]`.

Median confirmation-to-render fell **926.11 → 593.70 ms** for one file and
**11,502.88 → 409.53 ms** for twenty files. After submission, dialog closure took
1.21–4.98 ms. All six after samples published the result within 1 ms of the
receipt without any intervening status, snapshot, or amend RPC. Before samples
issued one explicit status RPC, plus varying watcher/snapshot/amend reads while
discard was running. This is observed background work; the original discard
completion itself explicitly awaited status, not history. The benchmark does not
attribute all latency to a full history reload.

Wall-clock times vary substantially with host load, process startup, filesystem
notifications, and other services. The single-file end-to-end receipt samples
do not show a uniform speedup even though core process/read work is lower. The
deterministic reduction and immediate receipt-driven publication are the stable
improvements, rather than a claimed universal millisecond response.

## Independent review

Round 1 identified indexed attribute precedence, action cleanup across environment
selection, loading flags after superseded full reads, merging deferred invalidations,
and stale dialogs after session replacement. Each received an implementation fix
and regression coverage. Subsequent review checks these responses and the final
amend scheduling and measurement changes.

Round 2 cleared all five findings and identified that merge/rebase metadata also
arrives as status notifications. The fix retains amend revalidation for unfiltered
metadata observations, with a same-HEAD blocker creation/removal regression. Git
2.49 for Windows did not execute the indexed filter while a disabled worktree
attribute file remained untouched. The filter regression therefore restores the
reviewed attribute file first, verifies batching was disabled by indexed attributes,
and confirms the later edited target is refused. A real Windows held-handle test
also exercises partial grouped Git restoration without a retry.

Round 3 approved the implementation and regression coverage with no substantive
correctness findings remaining.

## Final validation

- Web suite: 321 passed; the six opt-in discard measurement cases passed
  separately, for both the baseline and final implementations.
- Working-tree core group: 23 passed on the group run, then the corrected
  indexed-attribute fixture passed its focused rerun (24 distinct cases).
  The ordinary 1/20-file process/read-count regression was also rerun after
  adding the exact two-process explicit-status assertion.
- Server library suite: 51 passed with `--test-threads=4`, including reviewed
  mutation/revision/literal-path checks, explicit scopes, watcher lifecycle,
  cancellation, and preservation of active mutation ownership after disconnect.
- `npm run check`, `npm run build`, `cargo check --workspace`, and
  `git diff --check` passed. Svelte reports the existing file-list accessibility
  warning; the build also reports a generated pure-annotation warning.
- The original UI listener and Electron-managed backend were left running.
  Generated baseline source modules were verified against HEAD and removed.
  No user repository was discarded, and no commit or pull request was created.

## Limits

Git and external editors do not share an atomic filesystem transaction. These
full validation checks refuse observed changes; they cannot lock out every edit
between the last check and Git/filesystem mutation. Watcher observations arriving
during the operation take precedence in the client. In that case, receipt/toast
completion can precede visible row removal until a fresh read succeeds. Unknown
completion requires inspection and a new explicit review before any retry.
