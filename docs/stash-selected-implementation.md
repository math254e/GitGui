# Selected-side stash implementation

The selected-side implementation lives in
`crates/gitgui-core/src/git/stash_selected.rs`. This review fix changes only that
module (including inline Git fixtures) and this document. Other workers own
shared exports, the decoder, inspection, actions and repository loader. No
server, protocol, generated contract, client, UI or toolbar stash-all
implementation is changed here.

## Public domain API

The API is in `gitgui_core::git::stash_selected` and has no protocol dependency:

```rust
pub enum StashSelectionSource { Staged, Unstaged }
pub enum StashPushSelectedOutcome { Success, NoChanges, Partial }

pub struct StashPushSelectedResult {
    pub outcome: StashPushSelectedOutcome,
    pub stash: Option<gitgui_core::git::repository::StashInfo>,
    pub error: Option<String>,
}

pub fn stash_push_selected(
    root: &str,
    source: StashSelectionSource,
    paths: &[String],
    message: Option<&str>,
) -> Result<StashPushSelectedResult, GitError>;
```

The source/outcome enums derive `Clone`, `Copy`, `Debug`, `PartialEq`, `Eq`.
The receipt derives `Clone`, `Debug`. Errors and receipt diagnostics are fixed,
bounded messages; neither contains raw Git stderr, command arguments or file
contents. The server adds the captured repository ID and maps the enums,
`StashInfo` and safe diagnostic to `GitStashPushSelectedResult`.

Empty selection, duplicates, invalid paths, unsupported repository/file states,
and preparation/publication failures return `Err(GitError)`. No selected-side
change returns `NoChanges` with no stash/error and never publishes a stash.
After publication every cleanup error returns `Partial` with the saved
`StashInfo` and a diagnostic. `Success` has a saved stash and no error. Refresh
is not part of the operation and cannot invalidate a returned receipt.

## Snapshot and publication

The implementation uses the installed Git through the existing `git_command()`
primitive. Its private adapter supplies binary stdin/stdout, literal pathspecs,
replacement disabling and per-command `GIT_INDEX_FILE`. It never changes global
process environment. `core.splitIndex=false` prevents private indexes from
creating shared-index bookkeeping; a copied split real index is expanded only
for the eventual staged-cleanup index replacement.

An exclusive real `index.lock` is held during capture, publication and cleanup.
All selected paths are validated/captured before writing snapshot blobs.
Original HEAD, real index bytes, selected raw worktree contents/types and modes
are captured. Git applies clean/smudge conversions for regular-file snapshots
and materialization. Unselected files are not read from the working tree.

Trees start from original HEAD in fresh private indexes, then replace only
explicit selected entries. They never start from the full staged tree:

- Staged writes native `W -> [H, I]`, with `I -> H` and equal I/W trees containing
  only the selected staged delta. No untracked parent or encoding header.
- Unstaged writes the resolved P1 graph: synthetic `P -> H`, `I -> P` with equal
  P/I trees containing selected real-index context; `W -> [P, I, U?]` replaces
  selected tracked entries with captured worktree entries. Parentless U contains
  only selected untracked entries. A staged deletion followed by an untracked
  replacement removes that path from P/I/W and saves its replacement only in U.
  W carries the shared `git::stash::STASH_ENCODING_HEADER` raw header.

The writer calls the shared `decode_stash(root, W)` before publication. It does
not implement a second decoder. Expected HEAD, entire index bytes and selected
worktree contents are rechecked, then `git stash store` durably publishes W and
its complete reachable graph before cleanup. No sidecar, message marker, note,
configuration key or client metadata defines the format. Temporary cleanup
recovery files described below are not encoding metadata.

The receipt is constructed from captured identities rather than a later
repository refresh. Before cleanup, the published OID is located in the current
stash reflog so an ordinary concurrent insertion can update its receipt selector.
If it has disappeared, cleanup stops with a partial receipt. In that exceptional
external race the receipt retains its initial `stash@{0}` selector and original
OID; any later action must still revalidate selector plus expected OID. This
operation never drops any stash entry.

## Cleanup and concurrency

Unstaged cleanup restores selected tracked working files to their captured real
index entries and removes only captured, content-checked selected untracked
files. The real index is never written, including its unrelated entries,
extensions and stat data. Tests compare its bytes before/after.

Staged cleanup prepares and materializes the entire selected cleanup plan before
writing any live worktree/index contents. If a selected path has no unstaged
delta, its cleanup uses the exact captured HEAD entry, including additions,
deletions, binaries and supported type transitions. When both sides change a
regular file, cleanup computes `I -> H` and `I -> WT` using the same captured
index blob as baseline. Git's zero-context Myers diff supplies line coordinates;
the implementation validates every unchanged span against the complete raw
blobs, including final newline bytes. It splices both sets of disjoint edits at
those exact coordinates. It never applies a reverse patch against WT or searches
for matching context, so repeated blocks cannot relocate a cleanup hunk.

Intersecting or touching baseline ranges return partial, including inverse
edits, adjacent replacements, an insertion at a changed range's boundary, and
two insertions at the same boundary. Binary content changed on both sides,
unstaged edits on a staged addition/deletion, simultaneous mode changes, and
type/symlink transitions with additional unstaged changes are also refused.
`H=A, index=B, worktree=A` therefore saves B and keeps both live sides unchanged.
The same holds for undoing a staged edit in one repeated block and making the
same edit in a second block. Refusal on a later selected path also leaves earlier
selected paths unchanged. The saved stash and receipt remain available.

Disjoint edits, including legitimate offsets from insertions/deletions, preserve
the unstaged delta. Mode-only changes are handled independently; an unstaged
executable bit survives staged content cleanup. Computed blobs are already in
Git's canonical form, so cleanup hashes them without running clean filters a
second time, then uses the existing smudge/materialization path. Only selected
index entries are reset to H in a private copy of the real index, preserving
unrelated index contents and flags. That index is published through the owned
lock only after worktree cleanup and final HEAD/index checks. Dropping a
published lock cannot delete a successor process's lock.

Every file replacement checks current captured state, moves the final entry to
a temporary directory in the same parent, verifies moved contents, and creates
the replacement exclusively. It never writes through a final symlink or replaces
a racing newly created destination. Missing parent directories are recreated
only after validating each ancestor. A failed replacement attempts exclusive
hard-link recovery of the moved original. If recovery would overwrite another
entry, or the moved original changed, its bytes remain in
`.gitgui-stash-cleanup-*/original` beside the selected file and the receipt is
partial. Completed cleanup steps are not destructively rolled back.

The future server must hold its common-repository mutation lock. Git processes
respecting `index.lock` cannot stage during this operation, but external writers
and ref changes do not share the application lock. Rechecks detect captured-state
changes; they do not provide atomicity with arbitrary external Git/filesystem
operations. Ancestor validation is path based, not an OS-handle sandbox against
a malicious process swapping directories between system calls. There is no
claim of exactly-once execution or transaction-wide worktree rollback.

## Supported files and explicit refusals

Adds, deletions, explicit rename source/destination paths, regular/binary files,
Unicode, spaces, leading dashes and literal wildcard syntax are supported where
the host filesystem permits those names. Git entry/path lists are NUL delimited.
Unix also supports tabs, newlines, backslashes, executable bits and final
symlinks without reading symlink targets. Windows refuses final/tracked symlinks,
junction/reparse ancestors, reserved devices, alternate streams and names the
platform cannot represent, including tab/newline filenames. The Unix-specific
fixtures are present but cannot run on the current Windows host.

Selections must use the worktree root and explicit file spellings. Directories,
directory expansion, duplicate/unsafe paths, symlink ancestors, selected gitlinks
and paths inside submodules are rejected. Unborn HEAD, any unmerged index,
merge/cherry-pick/revert/rebase/sequencer state, sparse/assume-unchanged indexes
and intent-to-add entries are explicit safe refusals. The shared decoder also
refuses unsupported/corrupt graphs or non-UTF-8 saved tree paths before publication.
Unrelated ordinary staged/unstaged paths and other worktrees remain untouched.

Staged cleanup is deliberately conservative at line boundaries: even independent
edits on adjacent lines, or different changes within the same line, return
partial. A non-text diff or a diff that does not reconstruct the exact blobs is
also refused. These decisions use canonical Git contents, not inferred user edit
history. It never falls back to whole-file discard, broader selection or force.
Native restoration can also refuse a dirty destination; fixtures verify
preservation immediately after save and separately replay staged snapshots onto
a clean fixture destination.

## Verification

Commands run only against fresh temporary Git repositories, with no development
service startup:

```powershell
$stashReviewTarget = Join-Path $env:TEMP ("gitgui-stash-p1-" + [guid]::NewGuid().ToString("N"))
cargo test -p gitgui-core --target-dir $stashReviewTarget --lib git::stash_selected::tests -- --test-threads=4
cargo check -p gitgui-core --target-dir $stashReviewTarget
rustfmt --edition 2021 --check crates/gitgui-core/src/git/stash_selected.rs
git diff --check
```

The repeated-context P1 regression was first run against the original cleanup
through the public `stash_push_selected` API. It failed because that code
returned `Success` instead of `Partial`. After the fix, the first full run passed
all 26 existing fixtures plus that regression. The expanded regressions cover
positive/negative insertion/deletion offsets, missing final newlines, touching
replacement/insertion/deletion boundaries, staged-only and simultaneous binary
edits, CRLF filters, and non-UTF-8 blob bytes. The exact P1 fixture checks the
entire index byte-for-byte, selected and unselected live contents, saved staged
payload and equal stash/index snapshot trees, durable selector/OID, and refusal
before cleaning an earlier safe selected path.

Final validation on Windows with Git `2.49.0.windows.1` passed all **31**
selected-side fixtures in one full run (26 existing plus five new regressions;
0 failed; 247.54 seconds). Cargo used the isolated target directory
`%TEMP%/gitgui-stash-p1-f0f58d0b36044d57a49483ea3dbfaf9e`, leaving the shared
development target alone. `cargo check -p gitgui-core`, owned-file
`rustfmt --edition 2021 --check`, and `git diff --check` passed. Git reported
only existing LF/CRLF notices for other workers' files. Unix-only fixtures
remain unexecuted on this Windows host. No services, commits, PRs, worktrees,
delegation, process termination, shared exports or other modules were changed
by this fix.

Fixtures exercise production selected push for A/B/A inverse inspection and
native Apply with/without index; staged isolation and nonoverlapping cleanup;
staged overlap/inverse partial receipts; selected untracked entries and staged
deletion replacements; tracked/unstaged renames, adds, nested/tracked deletes;
literal/Unicode names on both sides; large binary contents; no-op/empty/invalid
selection; index/ref lock failures; post-publication content/untracked/index
races; linked-worktree independence; split indexes; unmerged/intent-to-add/
submodule refusals; Windows path/symlink refusals; and lock ownership after index
publication. Focused guard fixtures cover Git's warning-only mode mismatch,
unstaged executable-bit preservation and newly added file mode overlap.
Additional Unix-only fixtures cover links, modes, control
characters and symlink-ancestor escape refusal.

The shared encoding fixture remains the compatibility proof for Git-native
storage/transfer and original-HEAD branch behavior; action and inspection owners
verify their production readers/restorers separately. Server authorization,
capabilities, mutation serialization and protocol mapping remain parent-owned.
