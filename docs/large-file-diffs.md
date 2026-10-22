# Large-file diffs

Text files remain viewable regardless of line count, line length, or byte size.
The former 64 KiB / 500-line / 8 KiB-per-line omission limits and the separate
256 KiB hunk-patch limit have been removed. These limits prevented ordinary
source files from being reviewed.

## Loading and ownership

1. `gitgui-core` reads complete UTF-8 contents from the worktree, index, or commit
   blob. NUL-containing binary reads stop early; invalid UTF-8 retains the
   existing binary state. Read failures remain errors rather than empty files.
2. Core asks installed Git to diff the exact text snapshot being returned. It
   writes the two sides to an owned temporary directory and runs
   `git -c core.autocrlf=false diff --no-index` with explicit Myers/context
   options and external diff/textconv disabled. Temporary names never contain
   repository paths, and the directory is released when the operation returns.
   Identical text needs no subprocess. This avoids recomputing the diff in
   JavaScript and avoids rereading a changing worktree for its display patch.
3. `gitgui-protocol::CommitFileDiff.patch` is an additive, optional unified
   patch. It is absent for binary/unavailable contents and empty for identical
   text. Rust generates TypeScript as usual. Older clients can ignore the field;
   current clients can compute display diffs in a worker when an older server
   returns complete contents without a patch. Legacy `omittedContent` is still
   accepted, with a prompt to update the server; current servers never emit it.
4. `apps/web/src/lib/diff/parse.worker.ts` parses the patch with Pierre's
   `processFile`, including full contents. Line arrays are hydrated before
   returning, so expanding context does not split files on the UI thread.
   Changing the selection or unmounting aborts and terminates the worker.
   Parsing failures show Retry; there is no synchronous fallback.
   Working/index diff views wait for the continued Git hunk review before the
   first parse. Raw snapshot comparisons can treat LF index text versus CRLF
   worktree text as a full rewrite, whereas Git applies repository attributes
   and clean filters. Showing both patches in succession changes the displayed
   code. Only the reviewed patch is initially parsed; explicit review failure
   or unavailability permits the snapshot fallback with hunk actions disabled.
   File mode can still show full contents while the review is pending.
   Background repository refreshes and later reviewed-hunk responses retain
   the displayed rows until replacement parsing finishes. Equal contents and
   equal reviewed revisions reuse their existing response objects, preserving
   highlighting and scroll position. Only a new document selection or explicit
   Retry clears the viewer. Mutable views still revalidate after status reads,
   including coarse index notifications that do not identify a path. Transport
   request generations are separate from selection generations so unchanged
   revalidation does not invalidate mounted hunk controls. Actions remain
   enabled for the displayed review during unchanged background revalidation.
   A changed selected-file request key, replacement contents or review patch,
   review failure, or active mutation blocks actions until the review matches
   again. Background transport activity alone does not disable controls. Every
   application still revalidates its revision on the server before writing.
5. A separate Pierre `WorkerPoolManager` with one worker handles highlighting.
   The script is a Vite `?worker` entry so package side-effect metadata cannot
   tree-shake it into an empty production bundle. Both light/dark themes are
   initialized together. Worker initialization failure shows Retry.
   The repository page starts initialization before file selection and keeps
   the pool alive across viewer mounts. The page and viewers release their
   leases on unmount; the last release terminates the worker. Failed startup
   can be retried. Cold CodeView rendering still requires an initialized pool.
6. Pierre `CodeView` virtualizes visible rows for Hunks, Inline, Split, and File
   views. Layout, wrapping, and appearance reuse the parsed metadata. Inputs
   above 256 Ki characters across both sides, or above 20,000 lines in the
   renderer, display as plain text. Lines longer than 1,000 characters skip
   syntax tokenization. These are highlighting budgets: full text, context,
   layouts, line selection, and Git hunk actions remain available.
   Every parsed result (and file-content snapshot) has its own item/cache
   identity. Reusing an item for different contents lets Pierre retain the
   previous highlighted text until replacement highlighting finishes. Fresh
   items show current plain text immediately; unchanged responses and layout
   changes keep their existing identities.
   Hunk action DOM is mounted only for annotation slots in the rendered window
   through Pierre's public `onPostRender` callback. Its `renderAnnotation`
   callback otherwise eagerly creates controls for every hunk, including those
   off screen. Selection state stays in Svelte when controls leave the window.

Git still owns selectable hunk generation and application. The continued
working-tree preview supplies display metadata from the reviewed Git patch,
parsed in a worker using the same contents. Full revision hashing and stale
content/index/HEAD checks remain required for mutations. Binary files, conflicts,
renames, mode changes, symlinks, and submodules retain their existing action
rules. No client patch becomes executable input to the server.

The commit diff cache still enforces its 100-entry / 16 MiB retention budget,
now including patches. A response larger than the cache budget is returned
without retaining it. The hunk continuation cache retains only preconditions,
never file contents or patches. RPC admission and prefetch limits are unchanged.

## Verification

Rust coverage checks full 100,000-line contents across working/index/root-commit,
commit/worktree, rename, and deletion views; long lines; early binary detection;
large patch output; and reviewed hunk staging/unstaging. Cache/wire coverage
checks complete contents, patch retention, and older responses without `patch`.
Client tests check worker cancellation, success/failure/transfer cleanup,
100,000-line patch parsing, hydrated context, CRLF, and missing final newlines.

Local browser checks on 2026-10-22 reused the existing Vite session and mounted
the real Svelte viewer with controlled RPC fixtures. Git generated the patches.
Cases included the previously blocked `CommitFileDiffViewer.svelte` commit,
100,000-line rewrites (2.8 MB per side), sparse edits (3.0 MB per side), additions
(2.5 MB), 6,000 lines of dense code, 256 KiB lines, and 10,000 separate hunks.
Hunks/Inline/Split/File layouts, wrapping, scrolling to the end, hunk callbacks,
offscreen hunk selection, and switching away from an intentionally expensive
legacy parse all worked. The 10,000-hunk case mounted five action controls at
the end of the file. No observed UI tasks exceeded 50 ms in the final sample; this is
local evidence, not a latency guarantee. Screenshot capture used an isolated
Edge browser after the shared preview screenshot operation timed out twice.

A subsequent controlled refresh with highlighting delayed 2.4 seconds reproduced
old code remaining visible for 2.5 seconds with a reused item ID. Separate item
identities showed the replacement text within 53 ms in the same check. With
repository renderer resources warmed, the actual latest-commit component fixture
showed its first rows in 70 ms and another commit in 63 ms, using one highlight
worker across both viewer mounts. These fixture timings exclude Git/RPC latency.
Lifecycle tests cover shared leases, early unmount, pending startup cancellation,
failed startup, and Retry. Cache identities include the viewer instance so a
remount cannot reuse another document's highlighted contents.

The unstaged CRLF case was reproduced separately against the actual edited
component: its snapshot patch contained 883 deleted and 1,001 added lines,
while Git's normalized review contained 57 deleted and 175 added lines. A
delayed-review browser comparison checks that the initial snapshot is never
parsed/displayed and staging is enabled only for the final reviewed display.

## Remaining costs

This is complete-file transfer, not a streaming or paged protocol. Server
snapshot buffers, temporary disk space, JSON transfer, structured cloning, and
client line arrays still scale with file size. Workers isolate expensive
parsing/highlighting, and virtualization bounds mounted rows; they do not make
arbitrary inputs free. Extremely large generated files can still incur memory,
disk, and serialization costs. A future streaming design must preserve Git's
snapshot and reviewed-mutation semantics rather than reintroduce source-file
omission as a substitute for responsive rendering.

`node scripts/measure-diff-parsing.mjs` compares Git patch generation and Pierre
patch parsing on complete rewrites. Browser responsiveness requires measuring
the real worker/viewer path as above.

For the local complete-rewrite CPU sample, 5,000 lines took 59 ms for Git and
5 ms to parse its patch; 100,000 lines took 118 ms for Git and 86 ms to parse.
Application patch parsing runs in the worker. These times exclude transfer,
snapshot file writes, highlighting, and browser layout.
