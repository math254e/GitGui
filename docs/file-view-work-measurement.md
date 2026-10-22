# Working-tree file-view work (#5)

**Issue #9 integration:** The large-file success measurements below describe
the pre-budget implementation. Large files now return omitted content and do
not support hunk continuations; the ignored historical measurement must be
adapted before comparing that case. Eligible files retain the shared continuation
path. See [bounded diff behavior](large-file-diffs.md).

## Implementation

The viewer requests `git.working_tree_file_diff` with optional `prepareHunks`.
Rust resolves the repository once and captures status (including HEAD), the
selected path's index stages, and a full worktree fingerprint. For an unstaged
view, the bytes read for that fingerprint also supply the displayed contents.
Both status letters are preserved when choosing the index/worktree contents.

The response includes an optional `hunkContextId`. The viewer displays the
contents, then passes that ID to the separate `git.hunk_preview` request. This
keeps slow Git patch generation out of the contents loading overlay. The
continuation shares the first request's status, index entry, and initial hash;
it generates the Git patch and rechecks HEAD, index stages, permissions, and
every worktree byte before returning actionable hunks. A file changed between
the two requests produces a preview error and requires refresh.

The server retains at most 64 continuations and 16 MiB of accounted string
payload. They contain path/status/index preconditions and hashes, never full
file contents or patches. Lookup is scoped by catalog operation root, path,
side, and context ID or reviewed revision. Cache locks cover only lookup and
insertion; repository operations retain the existing per-repository mutation
lock. Entries are recent in-memory operation state, not a general status cache.

Apply reuses those preconditions, generates a **fresh Git patch**, and checks
one current full revision against the reviewed state and patch fingerprint.
This retains rejection after edits (even same-size edits with restored mtime),
index changes, HEAD changes, and patch-affecting attribute/filter changes.
`git apply --check` and `git apply` still consume only Rust-selected Git hunks.
There is no client-supplied patch and no timestamp-only fast path. As before,
external Git/filesystem writers do not participate in GitGui's mutation lock;
the final validation and Git apply are separate operations, not a filesystem
transaction.

Missing/evicted contexts and older clients use fresh standalone preview/apply
preparation. New request/result fields are optional; an older server can ignore
them and the viewer falls back to a normal preview. A failed preview never hides
loaded contents. A staged view with a supplied outdated HEAD does not prepare
actions against a different HEAD. Path validation also runs when continuing a
request; displayed worktree symlinks are not followed outside the repository.
Binary files, renames, mode changes, symlinks, submodules, and conflicts retain
whole-file workflows. All NUL-separated index stages are checked, including
add/add conflicts whose status contains no `U`.

The existing T3 source's `docs/internals/workspace-layout.md` and
`docs/internals/connection-runtime.md` were inspected at
`D:/GitHub/PictureTagingApp.references/t3code`. This remains a GitGui-owned Git
domain operation over the ordinary Rust protocol; no connection/runtime or
Electron layering changed and no vendored files changed.

## Local measurement

Measured on 2026-10-22, Windows 10.0.26220, Git 2.49.0.windows.1,
Rust 1.96.0, debug build. Baseline commit:
`28495181b6e0513dba6db47ec96d421a6099dcd6`.

Before changing the implementation, test-only per-thread counters were added
at `git_command()` and the working-tree file read/hash sites. An ignored Rust
test created isolated real Git repositories, then executed the original
server file-diff sequence followed by preview and, when supported, apply. The
same fixtures now execute content loading, continuation completion, and apply
with the reviewed continuation. Setup Git processes and fixture writes are
excluded. No #3 instrumentation or other worktree was used.

Each cell is **Git launches / application whole-file reads / bytes read**.
Selection includes file contents plus completed preview, on the unstaged side.

| Fixture | Selection before | Selection after | Apply before | Apply after |
| --- | --- | --- | --- | --- |
| Tracked text, 17 bytes | 12 / 3 / 51 | 7 / 2 / 34 | 10 / 2 / 34 | 5 / 1 / 17 |
| Untracked text, 17 bytes | 12 / 3 / 51 | 6 / 2 / 34 | 10 / 2 / 34 | 5 / 1 / 17 |
| Large tracked text, 5,600,008 bytes | 12 / 3 / 16,800,024 | 7 / 2 / 11,200,016 | 10 / 2 / 11,200,016 | 5 / 1 / 5,600,008 |
| Binary, 14 bytes | 12 / 3 / 42 | 7 / 2 / 28 | Disabled | Disabled |
| Merge conflict, 46 bytes | 11 / 3 / 138 | 6 / 2 / 92 | Disabled | Disabled |

For tracked selection plus apply this removes 10 of 22 Git launches and 2 of
5 application full-file reads. Cache misses still benefit from sharing HEAD
from status and reusing the initial index entry within standalone preparation.

Reproduce the optimized measurement with:

```sh
cargo test -p gitgui-core measure_file_view_work -- --ignored --nocapture
```

The fixture disables `core.autocrlf`, inserts one changed line into the large
file's 400,000 original lines, uses a NUL byte for binary fallback, and creates
a real merge conflict. Rename behavior is covered separately by regression
tests. The counters measure application-launched Git processes, file opens for
full-content reading, and their fixture byte lengths. They exclude Git's own
reads, OS cache hits, Git-spawned helpers, server transport/queueing, watchers,
post-mutation repository refresh, and browser transfer/parse/render work.
Single-run elapsed times were noisy: large-file selection was about 894 ms
before and 967 ms after, while apply was about 1,056 ms before and 842 ms after.
These establish reduced work, not an end-to-end latency claim or a statistical
benchmark. The frontend's very-large-file rendering remains separate work.

## Verification

Initial verification before integrating newer `main`: `cargo test --workspace`
passed (61 active tests; the explicit measurement is
ignored by default). `npm run check`, `npm run build`,
`npm run test -w @gitgui/client-runtime -w @gitgui/web` (130 passed, two opt-in
live tests skipped), `cargo check --workspace`, and `git diff --check` passed.
The production build emitted nonfatal Rollup annotation/source-map warnings.
Focused tests also passed after moving CRLF/no-final-newline coverage onto the
continuation apply path and adding explicit cache removal.

Tests cover cache hits/misses, old requests without the new fields, cache
scope/size/eviction, external content/index/HEAD changes, attribute changes,
large tracked/untracked files, staged and unstaged actions, additions before
the first commit, deletions, binary fallback, renames, add/add conflicts, and
literal paths. The working-tree test fixture disables inherited autocrlf and
uses Windows-supported literal wildcard-like filenames on Windows, retaining
`*` and trailing-space filename coverage on Unix. Unix-only symlink tests were
extended for display and continued requests but cannot execute on this Windows
host. No browser latency or rendering benchmark was run.

Before pushing, this change was integrated with the newer `main` changes for
instrumentation, cancellation, concurrent RPC scheduling, and commit/worktree
comparison. Existing diagnostics are retained for both cached and fresh apply;
both file contents and their continued preview use the selection AbortSignal.
Commit/worktree comparison continues without hunk actions. Working-tree file
diffs that prepare continuations share the mutation lock, so the RPC queue places
them in the same repository-ordered lane as hunk preview and mutations; ordinary
file-diff reads retain independent scheduling. The original measurements
above remain tied to the recorded baseline, independent of those other changes.

After integration, all 52 core tests and 21 server tests pass with serial test
execution; an initial parallel run hit the existing timestamp-based temporary
directory fixture's `AlreadyExists` collision on Windows. Client/runtime tests
pass again (142 passed, two opt-in live tests skipped), as do frontend checks,
production build, Rust workspace checking, and whitespace checking. Re-running
the explicit measurement confirms the same Git-launch/read/byte counts above.
