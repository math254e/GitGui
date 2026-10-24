# Stash decoding and read-only inspection

## Fast foreground reads and background preparation

Interactive RPCs now use `stash_read::StashReadPlan`, not the strict restoration
decoder. A plan reads literal commit metadata in bounded batches, asks Git for
NUL-delimited raw changed-file records, and lists the optional untracked tree.
It retains only changed paths, modes, and before/after object IDs. Selecting a
file reads only its saved blobs. No unchanged tree/blob audit blocks display.
The separate strict decoder and public strict inspection APIs remain available
for mutations, explicit validation, and corruption fixtures.

This follows the inspected SourceGit and Git Extensions implementation patterns:

- [SourceGit stash selection](https://github.com/sourcegit-scm/sourcegit/blob/cb11d68782117ec4590a5863cdf3ffd25e15b1f7/src/ViewModels/StashesPage.cs)
  reuses revision comparison and loads the selected diff separately.
- [Git Extensions stash file listing](https://github.com/gitextensions/gitextensions/blob/96ef2d6edd8515f30bc1d71ecf4d5a1d619b74be/src/app/GitCommands/Git/GitModule.cs#L2550-L2694)
  uses raw diff records and appends optional saved untracked additions.
- [Git Cola stash preview](https://github.com/git-cola/git-cola/blob/265e3fad4bf2a5fb1a0192fac5082997cadbfa68/cola/models/stash.py)
  delegates summary/patch generation directly to Git. No external code was copied.

Cold native file-list cache reads require five Git invocations (selector, two
commit batches, tracked comparison, reflog label); saved untracked files add one.
Warm lists require two, and warm diffs one. The server's object-format check adds
one invocation to each RPC; these core counts are not whole-RPC counts. A missing
unchanged blob and 1,000 unchanged files do not increase foreground command count.
Invalid/oversized commit metadata in one display-list batch is isolated through
bounded per-object fallback so healthy stash entries keep their real selectors.

`StashInspectionCache` retains 32 plans/32 MiB and 100 diffs/16 MiB. Concurrent
loads share foreground slots; strict verification has independent state and never
occupies those slots. Git runs outside cache locks. Normal mutations retain
immutable OID-keyed results while cancelling selector-specific queued work.
Catalog removal evicts the root. Admission generations are captured before Git
and checked under the eviction lock before insertion; old queued or in-flight
reads cannot repopulate a removed/reopened catalog. Shutdown invalidates all
admissions. Global admission generations conservatively cancel unrelated queued
jobs after removal; unchanged catalogs reschedule in the new generation.

The server owns one bounded preparation queue: three recent file lists, up to two
likely file diffs after a selection, and strict verification when idle. Interactive
stash requests prevent new speculative jobs from starting, including when their
blocking worker outlives a cancelled RPC await. A started background operation can
finish concurrently with foreground work; it does not hold a mutation lock or a
foreground worker slot. Obsolete selection/repository jobs cannot publish results.
Successful verification is silent. The first rejected plan publishes an existing
repository-change event; subsequent snapshots omit that rejected entry. Rejected
state is bounded with the cached plan and resets on eviction/reopening. Cached
success relies on Git object immutability; reads are not transactions with external
object-database writers, and mutation checks still run against current state.

`load_repository_for_display` uses batched stash commit metadata rather than full
saved-tree validation. Existing `load_repository` remains strict for callers that
request that guarantee. Custom unstaged entries still display P -> W and report
original H; history helper projection/adopted-helper preservation is shared.

The details panel has a separate 32-entry/2 MiB presentation cache scoped by
client identity, repository ID, and OID. It shows an existing immutable tree while
the current selector/OID is rechecked, reuses equal arrays, and clears failed
verification. Superseded responses cannot publish or populate this cache.

Final Windows verification (2026-10-24): the complete core suite passed 122 unit
tests and 74 integration tests, with one existing measurement ignored. The
independent core/cache review passed its 49-test group; the UI suite passed 299
tests (one existing live skip), and the production build passed. Scope-specific
reviews cleared the fast parser, cache admission, UI, and preparation lifecycle.

An isolated production-API timing fixture (one tracked change plus one saved
untracked file) measured the current strict uncached files/two-open sequence at
100 Git invocations / 7.05 s. The foreground cache sequence used 13 invocations
(6 cold list + 6 first file + 1 repeat) / 917 ms: cold list 517 ms, first file
342 ms. These are local core timings, exclude the server's per-RPC format query,
and are not end-to-end UI guarantees. Deterministic tests assert command budgets
and unchanged-file independence instead of unstable wall-clock thresholds.

Server verification passed all 51 library tests with `--test-threads=4` (112.51 s),
including all seven preparation tests. The default-concurrency attempt passed 48
and hit three pre-existing RPC-fixture deadline bounds: branch mutation response,
failed-mutation lane release, and disconnect/active-worker lock release. All three
passed in the full four-thread rerun. No production or deadline changes were made
in response. This host's default-concurrency fixture reliability remains a limit;
the controlled-concurrency result does not claim the default run passed. Logs are
retained under `target/stash-fast-final-{core,server,server-bounded,timing}.log`.

## Earlier shared-decoder cache (superseded)

The following records describe the earlier optimization and its validation.
The foreground manifest audits and mutation-wide stash-cache eviction described
here are superseded by the implementation above.

`stash_inspection_cache.rs` supplies a server-owned, repository-root/OID-scoped
cache for the two stash inspection RPCs. The wire contract and mutation APIs
are unchanged. On a cold read, `StashObjects` retains the baseline, worktree,
and untracked trees already validated by the shared decoder. File enumeration,
metadata, and subsequent per-file content lookup reuse that single validated
snapshot rather than independently decoding and flattening every tree again.
The standalone inspection entry points also reuse decoder trees within a call.

The cache retains at most 32 inspection entries within a conservative 32 MiB
metadata budget, plus 100 file diffs within a separate 16 MiB payload budget.
Oversized results are returned without retention. Failed loads and incomplete
object manifests are not cached. Concurrent cold reads of one root/OID share a
`OnceLock`; Git work runs outside the global cache locks. Diff publication checks
that its inspection slot is still current, so an evicted slot cannot repopulate
the diff cache. Concurrent first-time diff payloads may be computed independently.

Every read resolves the qualified live `refs/stash@{n}` against the reviewed OID.
Cache hits freshly batch-check the literal types and availability of every object
validated by the decoder, including unchanged saved paths, with replacement
objects disabled. Submodule targets remain external objects, as before. This
detects removal/corruption that makes objects unreadable
without rescanning saved trees. Cached layouts rely on Git's content-addressed
object immutability; cache hits do not reread every tree's bytes to detect manual
object-database rewrites under an unchanged OID. Cold reads retain all raw-tree,
parent-layout, path, overlap, object-type, size and depth validation. Reflog
labels are read fresh for every file-list response, even for the same object.
Missing-object failures evict the affected inspection and repository diff data.
Stash mutations invalidate affected linked registrations through the existing
invalidation path; catalog removal evicts that root as well. Ordinary repository
refreshes do not invalidate immutable saved-file results. External Git changes
remain outside an atomic transaction, as before; no mutation is cached or replayed.

The production-API measurement fixture contains one modified tracked file and
one saved untracked file. Loading metadata/files and opening the modified file
twice originally required **163 Git processes / 12.73s** on this Windows host.
Shared reads plus caching use **32 processes / 2.45s**: 23 for a cold file list,
7 for the first diff, and 2 for the repeated diff. These are local fixture timings,
not UI latency guarantees; the deterministic assertion checks process reduction
and that a warmed diff performs only target resolution and one manifest batch.

Focused regressions cover cache bounds/LRU/oversized results, concurrent cold
reads, fresh reflog metadata, reindex/removal and ambiguous selector rejection,
missing commits/trees/unchanged blobs, repository separation, replacement refs,
custom inverse baselines, untracked contents, and SHA-1/SHA-256.

Verification: `cargo test -p gitgui-core` passed 108 unit tests (one existing
measurement ignored) and all 73 integration tests, including 33 inspection
fixtures. The final focused `cargo test -p gitgui-core --lib stash_inspection_cache`
passed all five cache tests, including the two later-added eviction/partial-manifest
cases. `cargo check --workspace --all-targets`, scoped rustfmt checks, and
`git diff --check` passed. No frontend/protocol changes, development service
starts, or mutations of the shared checkout were needed.

The final server-library rerun, without the core suite competing for Git
processes, passed **44/44 tests at default concurrency in 82.91s**. The initial
parallel run had three RPC/lifecycle deadline failures and one watcher Git
subprocess failure under load (40 passed / 4 failed). All four passed in the
rerun; no production lifecycle changes or test deadline adjustments were made.

Task 4 owns `crates/gitgui-core/src/git/stash.rs`,
`src/git/stash_inspection.rs`, the focused stash/history loader changes in
`src/git/repository.rs`, `tests/stash_inspection.rs`, this document, and the two
module declarations in `src/lib.rs`. Concurrent selected-push and action modules
are separate work. No protocol, server, generated contract, client, or UI changes
are part of this task. No services, commits, PRs, worktrees, or process termination
are required.

## Shared public domain API

The shared decoder is ready. Paths are module-qualified under
`gitgui_core::git::stash`:

```rust
pub const STASH_ENCODING_HEADER: &str =
    "gitgui-stash-encoding selected-unstaged-v1";
pub const SELECTED_UNSTAGED_ENCODING: &str = "selected-unstaged-v1";

pub enum StashEncoding { Native, SelectedUnstagedV1 }
pub struct StashTarget {
    pub selector: String,
    pub expected_oid: String,
}
pub enum StashError { TargetChanged, Invalid(GitError) }
// impl From<GitError> for StashError
pub struct StashLayout {
    pub stash_oid: String,
    pub original_head_oid: String,
    pub baseline_oid: String,
    pub index_oid: String,
    pub untracked_oid: Option<String>,
    pub encoding: StashEncoding,
}

pub fn resolve_stash(root: &str, target: &StashTarget)
    -> Result<StashLayout, StashError>;
pub fn decode_stash(root: &str, oid: &str)
    -> Result<StashLayout, StashError>;
pub fn read_stash_info(root: &str, target: &StashTarget)
    -> Result<StashInfo, StashError>;
pub fn list_stashes(root: &str) -> Result<Vec<StashInfo>, GitError>;
```

The inspection module exports:

```rust
pub const STASH_CONTENT_LIMIT: usize = 8 * 1024 * 1024;
pub fn list_stash_files(root: &str, target: &StashTarget)
    -> Result<Vec<CommitFile>, StashError>;
pub fn load_stash_file_diff(root: &str, target: &StashTarget, path: &str)
    -> Result<CommitFileDiff, StashError>;
```

`GitError` comes from `git::command`; `StashInfo`, `CommitFile`, and
`CommitFileDiff` are existing core repository types. No protocol dependency or
wire mapping is introduced. Diff results contain the existing content, binary,
message, and patch fields, with no live hunk continuation or mutation authority.

## Validation and saved-content semantics

Selectors must have canonical `stash@{n}` syntax with a nonnegative decimal index
and no leading zeros except `0`. Expected IDs must be full 40- or 64-digit hex
IDs. Missing/reindexed selectors or a different full OID produce `TargetChanged`;
bad syntax and invalid layouts produce `Invalid`. Internally, both resolution
and metadata reads use `refs/stash@{n}` so a branch named `stash` cannot substitute
for a missing stash ref. Public selectors remain `stash@{n}`. Direct decoding
accepts only full literal IDs. Targeted reads resolve the reviewed target before
using its immutable objects; info also checks the OID in the reflog metadata read.

All saved-object Git invocations disable replacements. The decoder reads raw
commit headers, checks tree/parent ordering and object references, and selects
custom semantics only for the exact, single, noncontinued supported raw header.
Unknown, duplicate, continued, and malformed encoding headers are errors.
Message and reflog marker text never select a format. Custom `P` must have sole
parent `H`; `I` must have sole parent `P` and the same tree as `P`. Native `I`
must have sole parent `H=P`. `W` must have exactly two or three ordered parents;
optional `U` must be parentless. Custom helper commits cannot themselves carry
the custom header. Referenced commits, recursively enumerated trees, and blobs
are checked for existence and exact literal type: annotated tags cannot stand
in for commits or trees. Recursive tree reads retain directory records and
validate the root and every subtree's actual binary records before flattening.
Basenames, canonical modes, fixed-width object IDs, duplicate names, and Git's
directory-aware sibling order are checked at their real record boundaries;
literal `/` inside a basename cannot masquerade as a nested path. Duplicate
directories with distinct children (or no children) are rejected too. Gitlinks
may reference objects in another repository and
therefore need not resolve locally.

Untracked paths must be disjoint from all tracked snapshot entries (`P`, `I`,
and `W`), including directory/file prefix collisions. Duplicate or overlapping
entries inside one tree are refused. This deliberately follows the design's
strict disjoint-layout rule; native entries with an untracked path overlapping
an entry in any tracked snapshot are also refused, rather than selecting an
ambiguous payload. The selected staged-deletion/untracked-replacement layout
works because its path is removed from `P`, `I`, and `W` and exists only in `U`.

Inspection compares `P -> W` using rename-aware, NUL-delimited Git tree metadata
and adds `U` paths as additions. It never compares custom `H -> P` as a saved
change. Thus custom `H=A, P=I=B, W=A` displays the inverse `B -> A`; native
`H=P=A, I=B, W=A` retains native combined semantics and has no net tracked diff.
Only paths present in that saved change list can be requested. Renames preserve
the source path; deletions use an empty modified side. Blob OIDs are read
directly, without revision/path expressions, textconv, external diff commands,
worktree file reads, index reads, or symlink traversal. Existing content
classification and temporary-file patch computation are reused.

Saved-path validation is deliberately separate from live `safe_path`: UTF-8
spaces, tabs, newlines, Unicode, leading dashes, colons, glob-looking names, and
backslashes remain literal object names. Empty/NUL paths and empty, `.` or `..`
slash components are refused. Non-UTF-8 Git paths are explicitly unsupported by
the existing String-based domain/wire model and are refused rather than decoded
lossily. Symlinks display their saved link text; submodules receive an explanatory
payload.

Raw commit/reflog-subject reads are capped at 1 MiB, tree/file-list/reflog metadata
at 32 MiB per Git result, and each displayed blob at 8 MiB. Raw tree batch output
also has a cumulative 32 MiB budget per snapshot validation. Returned tree paths
are limited to 128 components. Object-type batches contain at most 256 unique
OIDs with a 32 KiB output cap. Input is written while stdout is drained, avoiding
Windows anonymous-pipe deadlocks. Oversized metadata is
an error; oversized blobs produce empty content and an explanatory message with
no patch. Text below that bound is complete; NUL/non-UTF-8 content uses the
existing binary payload. Patches are computed from those bounded inputs using
the existing repository machinery. Child stdout closes on metadata-limit failure
and the owned Git subprocess is reaped; no process-kill operation is used.

## Repository loader

The production stash loader uses the shared decoder without weaker fallback
parsing. Unsupported/corrupt entries are omitted from the actionable stash list.
`StashInfo.base_hash` is original `H`, while `index_hash` is `I`. Hidden helper
candidates include custom `P`, `I`, and optional `U`; real `H` and its history
remain. Before filtering, the loader walks the unprojected history from branches,
remote refs, tags, current HEAD, worktree heads, and stash original HEADs.
Reachable helpers and their ancestry are ordinary adopted history and remain
visible. This includes native `git stash branch` starting at synthetic `P` while
another stash still references that helper. The visible stash graph first-parent
edge bypasses `P` only while it is hidden; adopted `P` retains its real edges.
Commit history metadata now uses fixed NUL-delimited fields, so control characters
inside a stash message cannot inject graph rows. Graph traversal also disables
replacement objects.

These are read operations, not a transaction with arbitrary external Git. An
external process can move a reflog or delete objects while a read is running.
Immutable-object reads can safely finish for the OID validated at their start,
or fail if objects disappear; they do not claim to keep the selector locked.
Mutations still require the server's repository lock and their own state checks.
No server method or capability is enabled by this work.

## Verification

`tests/stash_inspection.rs` calls the production decoder/inspector/loader using
fresh temporary repositories and installed Git. It covers native and custom
inverse semantics; selected-only baseline context and untouched unrelated live
staging; untracked-only and combined content; staged deletion followed by an
untracked same-path replacement; exact/stale selectors; SHA-1 and SHA-256; unknown,
duplicate, continued and malformed headers; marker-message forgery; incorrect
parents/trees and missing commits/trees/blobs; replacement commits/blobs; graph
helper filtering/ancestry and control-character injection; rename/deletion
metadata; literal spaces/tabs/newlines/Unicode; path rejection and non-UTF-8
refusal; symlinks/modes/submodules; binary and complete moderate-sized text; and
oversized-content payloads.

The existing repository helper-parent test now exercises the production decoder
against an actual native stash rather than an obsolete string parser.

Validation passed:

- `cargo test -p gitgui-core --test stash_inspection --target-dir target/stash-inspection-validation-final -- --test-threads=4`:
  17 passed, including the final layout-sharing loader path.
- `cargo test -p gitgui-core --lib --target-dir target/stash-inspection-validation -- --test-threads=4`:
  93 passed, one existing measurement ignored. This included the concurrent
  selected-stash module's tests as present at that build.
- After the loader stopped duplicating layout validation,
  `cargo test -p gitgui-core --lib git::repository::tests --target-dir target/stash-inspection-validation -- --test-threads=4`:
  all 26 repository tests passed again.
- `cargo check -p gitgui-core` and `git diff --check` passed. Git reports only
  CRLF conversion notices for other workers' generated files.

Windows concurrent workers briefly locked the shared unit-test executable
(`LNK1104`); isolated Cargo output directories avoided that lock without
interrupting another worker. No processes or development services were stopped.

## Independent review round 1 responses

All five findings were addressed within the decoder, focused repository loader,
inspection fixtures, and this document. Public domain signatures and layouts are
unchanged; concurrent selected-push/actions consumers need no adaptation.

1. **P1, annotated-tag peeling:** every saved commit gets a literal `cat-file -t`
   check before raw commit parsing. Snapshot root trees and recursive directory
   references receive exact tree checks; leaf objects receive exact blob checks.
   All commands disable replacement objects. Production fixtures substitute
   annotated tags at W/P/I/H/U and their tree references, including the reported
   P-parent case, and verify invalid entries cannot poison repository loading.
2. **P2, ambiguous stash selector:** both rev-parse and targeted reflog metadata
   use fully qualified stash selectors. A fixture creates a branch named `stash`
   at W, checks correct metadata while refs/stash exists, deletes refs/stash,
   and verifies both targeted APIs return `TargetChanged`.
3. **P2, adopted helper history:** history rooted at ordinary refs, current and
   linked worktree heads, or another stash's original HEAD wins over helper
   filtering, including ancestor helpers. Production fixtures adopt I through a
   branch (also preserving P), adopt P through a nested annotated tag and detached
   HEAD, and run native stash branch with a retained duplicate entry. Private I/U
   remain hidden, real H survives, and inspection continues comparing only P->W.
   Existing repository tests cover detached linked-worktree history roots.
4. **P2, duplicate directories:** `ls-tree -r -t -z` retains recursive directory
   records; duplicate paths and file/directory overlaps are checked before any
   flattened map is returned. Metadata and accepted path depth are bounded.
   Fixtures cover duplicate directories with distinct children, nested duplicate
   directories, duplicate empty directories, and a tag masquerading as a subtree.
5. **P2, repeated validation:** one bounded reflog read supplies selectors, OIDs,
   and subjects for the listing. A per-listing validation context shares parsed
   commits and validated snapshot trees by OID, and deduplicates successful
   tree/blob type checks by OID. A conservative 64 MiB retention budget disables
   further cache insertion when full; validation still runs. Nothing persists
   across calls or repositories at that review stage. Standalone targeted reads keep independent
   validation; the repository loader consumes the listing's validated layouts.

Bulk metadata uses Git's actual `%gD` selectors. Git can omit non-commit reflog
entries, so enumerating the returned rows would incorrectly renumber older
stashes. A regression inserts an annotated-tag entry between valid stashes and
checks the older valid selector stays `stash@{2}` and resolves successfully.

Deterministic performance evidence uses the existing per-thread Git subprocess
counter, with 1,000 files referring to one shared blob and repeated H/P/I/W trees:
one-entry listing uses **13** subprocesses, three-entry listing **17**, and three
independent info reads **45**. Each additional W adds only its literal type and
raw commit reads. A separate fixture checks 300 distinct blobs in **two** bounded
batches (256+44); repeating those checks in the same validation context starts
**zero** subprocesses. No wall-clock threshold is asserted. Another production
fixture deletes a loose blob after a successful listing and verifies the next
listing rejects it, proving there is no stale process-global validity cache.

Remaining limits: reads are not transactions with external Git; cache reuse
within one listing assumes immutable object identity for that read, and a later
read validates again. Distinct snapshot root trees still need their own bounded
recursive listing, although repeated referenced-object type checks are shared.
Git performs recursive enumeration before Rust checks returned path depth; the
stdout cap also bounds oversized metadata. This is layout validation, not a full
repository-wide fsck. Non-UTF-8 paths and existing displayed-content limits remain.
Git's reflog walker may omit non-commit entries; they are never actionable and
remaining records retain their actual selectors. No new API, service, migration,
or architecture boundary was introduced. There are no known unresolved objections
to the five findings; fresh independent review remains the parent's next step.

Review-fix validation (isolated Cargo outputs, no shared test executable replacement):

- `cargo test -p gitgui-core --lib git::stash::tests --target-dir target/stash-review-fixes-expanded -- --nocapture`:
  two passed, including subprocess-count evidence above.
- `cargo check -p gitgui-core --target-dir target/stash-review-fixes-expanded`:
  passed, including concurrent action/selected modules as present during the check.
- `git diff --check`: passed; only other workers' generated-file CRLF notices.
- `cargo test -p gitgui-core --test stash_inspection --target-dir target/stash-review-fixes -- --test-threads=4`:
  all 24 passed. After the final nested-tag history refinement, the strengthened
  `adopted_helpers_and_ancestry` fixture passed separately in
  `target/stash-review-fixes-expanded`.
- `cargo test -p gitgui-core --lib git::repository::tests --target-dir target/stash-review-fixes-expanded -- --test-threads=4`:
  all 26 passed after the final history refinement.

## Independent review round 2 responses

Both new P2 findings are fixed within this task's files. The five round 1 fixes
remain intact; no public API, protocol, server, UI, or mutation behavior changes.

1. **Valid non-commit tags blocked repository loading:** the ordinary-history
   root pass now fully peels tags without requiring a commit, then checks the
   literal resulting type. Tree/blob targets are valid refs and are excluded
   from history roots; commit targets still adopt helpers and their ancestry.
   Missing objects or unexpected types still fail rather than being silently
   swallowed. This peeling applies only to ordinary refs, never to the stash's
   exact-type graph validation. A production fixture creates lightweight,
   annotated, and nested tags to both trees and blobs, loads before and after a
   real native stash, then adopts the native index helper through nested tags
   and verifies full and filtered history retain it and original HEAD.
2. **Unsorted saved trees reached Git's diff traversal:** recursive `ls-tree`
   records are checked in their stored order, separately for each directory,
   before a validated flattened tree can enter the cache or reach inspection's
   `diff-tree`. Comparison uses raw name bytes with a trailing `/` for
   directories, matching Git's
   [`base_name_compare`](https://github.com/git/git/blob/master/tree.c).
   An unsorted directory produces `Invalid`, without reordering or fallback.
   The state for sibling ordering is local to the existing bounded tree read;
   object-type batches, per-listing caches, and retention limits are unchanged.

Production decoder/inspection regressions cover the reported identical-blob
`a`/`z` false-rename case, with a valid control yielding only `A z` and its
correct saved content. SHA-1 and SHA-256 fixtures reject unsorted W, native
baseline, custom P/I baseline, independent I, custom H, U, and nested U trees.
They also reject plain-name-sorted `b` (directory), `b.` (file), including an
empty directory. All targeted entry points must report the ordering error, and
bulk listing must omit each invalid snapshot while retaining the valid one.
Valid native and custom fixtures cover file-name prefixes, directory-name
prefixes (`b.`, `b/`, `b0`), recursive and empty directories, executable/symlink/
gitlink modes, Unicode, tabs, and newlines. Git's own `mktree` sorting is the
independent oracle for the hand-encoded valid tree.

Remaining limits are unchanged: reads do not lock out external Git, non-UTF-8
paths remain unsupported, existing metadata/content/depth bounds still apply,
and this decoder does not perform repository-wide fsck. No development services
were started, no processes were terminated, and no commits, PRs, or worktrees
were made.

Before the fixes, the expanded inspection suite reproduced exactly the two
reported findings: non-commit tags failed repository loading with
`Could not read saved Git object`, and the unsorted W was accepted. The other
25 tests passed, including the canonical-directory-order control.

Validation uses isolated output directories
`target/stash-inspection-round2-20261023-8c32` and
`target/stash-inspection-round2-check-20261023-8c32`:

- `cargo check -p gitgui-core`: passed against the updated shared snapshot.
- `rustfmt --edition 2021 --check` on `stash.rs` and
  `tests/stash_inspection.rs`: passed. The modified `load_repository` function
  also passes a separate stdin formatting check. Whole-file `repository.rs`
  checking reports existing formatting differences in unrelated sections;
  those sections were preserved.
- `git diff --check`: passed, with only other files' LF/CRLF notices.

The first full library run (100 tests) had 98 passing, one existing ignored
measurement, and one failure in the concurrently edited selected-push module:
`staged_repeated_context_inverse_cannot_relocate_cleanup_or_clean_other_paths`
returned `Success` rather than `Partial`. No selected-push file was edited by
this task. A recompile against that worker's current files passes the focused
test (one passing, 103 filtered out); the full updated library suite is rerun.

## Final decoder P2: actual raw tree-entry boundaries

The round 2 ordering check inferred directories by splitting flattened
`ls-tree` paths. That did not prove actual entry boundaries: raw root entries
`z`, then literal basename `a/b` bypassed sibling comparison and could reach
`diff-tree`, producing a false rename against a legitimate nested `a/b`.
Sorted slash-containing basenames were also incorrectly accepted.

The decoder now reads actual binary tree records with replacement-disabled
`cat-file --batch`, for the root and every directory OID enumerated by the
existing bounded recursive listing. It validates each record's canonical mode,
NUL-terminated UTF-8 basename, and 20-byte SHA-1 or 32-byte SHA-256 object ID
boundary. Empty, slash-containing, dot, dot-dot, truncated, and malformed records
are rejected. A per-directory name set rejects duplicates even when a file and
directory with the same name are separated by other entries. Stored sibling
order is checked using raw name bytes and a trailing slash for directories.
Only then can a flattened snapshot map be built or cached. Git output is never
reordered, and corrupt snapshots never get an alternate inspection baseline.

Raw reads contain at most 256 unique tree OIDs per subprocess and at most 32 MiB
of aggregate output per snapshot. Literal type checks run before raw batch
reads; the added batches fetch tree bytes without per-file blob payloads.
Successful raw-tree validation is cached by OID in the same per-listing context and
shares its existing conservative 64 MiB retention budget. Shared subtrees are
not reread across different snapshot roots. No additional Rust recursion or
per-file subprocess loop is introduced; blob type checking remains deduplicated
and bounded, and displayed blob reads keep their existing limits.

Production API regressions cover SHA-1 and SHA-256, raw roots `z,a/b` and
`a/b,z`, slash-containing directory entries, direct/nested U, and quoted names
containing slashes. Decode, reviewed resolution, info, file listing, and diff
reads return `Invalid`; bulk listing omits malformed entries and retains the
valid control. The control uses genuine nested `a/b`, dot/control filenames,
and a literal backslash basename, and reports only the correct `A z` with saved
content. Further fixtures reject empty/dot/dot-dot names, empty path components,
noncanonical/invalid modes, embedded NUL/truncated name records, short/long OID
records, nonadjacent duplicate directories, and file/directory name collisions.
Existing canonical `b.,b/,b0`, Unicode/control filename, duplicate-directory,
exact-type, replacement-object, and all-snapshot-role ordering fixtures remain.

Deterministic batching checks pass: 300 unique raw trees use two type batches
and two content batches, repeating the same set starts zero subprocesses, and
a new root referencing a cached subtree reads only the new root. The existing
1,000-file fixture now uses **14** subprocesses for one listed stash, **18** for
three, and **48** for three independent info reads. Raw validation adds one
batch to each independent flat-tree validation; each additional W in a shared
listing still adds only its literal type and raw commit reads.

Only `src/git/stash.rs`, `tests/stash_inspection.rs`, and this document change
in this fix. Public APIs and the inspection implementation are unchanged.
Repository, selected/actions, server/protocol, and UI work are preserved.
Remaining limits: reads are not transactions with external Git; non-UTF-8 paths
remain unsupported; metadata/content/depth caps remain; Git still performs
bounded-output recursive enumeration before Rust checks path depth; validation
is scoped to the saved layout rather than repository-wide fsck. A fresh
independent review follows this implementation response.

Final-fix verification used isolated Cargo outputs (no shared executable was
replaced):

- `cargo test -p gitgui-core --test stash_inspection --target-dir target/stash-decoder-raw-records-final-20261023-d681 -- --test-threads=4`:
  **29 passed**, including all existing inspection fixtures and both new
  SHA-1/SHA-256 raw-record fixtures.
- `cargo test -p gitgui-core --lib git::stash::tests --target-dir target/stash-decoder-raw-records-20261023-d681 -- --nocapture`:
  **3 passed**, including the bounded type/raw batches and listing reuse counts
  above.
- `cargo check -p gitgui-core --target-dir target/stash-decoder-raw-records-check-20261023-d681`:
  passed.
- `rustfmt --edition 2021 --check` on the two owned Rust files and
  `git diff --check`: passed. Since the owned implementation files were already
  untracked at task start, their trailing whitespace was also checked directly;
  none was found. Git reports only other workers' LF/CRLF conversion notices.

The broader core suite was not repeated: the requested complete inspection
suite, focused batching tests, and core check passed without a new concern
requiring broader validation. No services, commits, PRs, worktrees, delegation,
or process termination were used.
