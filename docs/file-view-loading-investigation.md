# File view loading and staging investigation

**Scope:** Code investigation and bounded runtime diagnostics for slow file-view loads and file/hunk staging refreshes. The code paths below are confirmed; the diagnostics provide measurements but do not benchmark a repository on their own.

**Issue #4 implementation update:** The serial-dispatch and uncancelled-selection
findings below describe the original investigation snapshot. The socket now
dispatches independent reads concurrently with bounded admission, preserves
per-repository operation order and existing global mutexes, and handles
selection cancellation through the shared session. Prefetch validates full
hints but warms at most one target in its own lane. Queued cancelled reads and
disconnected requests are dropped; started blocking workers finish with their
slots/locks intact. See [request lifetime](connection-runtime.md#concurrent-request-lifetime)
for the protocol, limits, failure tests, and remaining subprocess-timeout limits.
Updates from the related diagnostics, prefetch, refresh, and invalidation work
are retained below. The scheduling changes do not establish measured latency
improvements on their own.

**#5 implementation update:** Working-tree file views now share operation
preconditions through a bounded continuation, and apply reuses those
preconditions while regenerating Git's patch and validating current contents.
See [implementation and measured before/after work](file-view-work-measurement.md).
The original investigation below describes the baseline, not the optimized path.

## Summary

The clearest systemic bottleneck is that the Rust WebSocket handler awaits one RPC to completion before reading the next request on that connection. The client can send multiple requests, but a slow request—including an eager prefetch or an obsolete file selection—blocks every request behind it.

Several paths amplify that queueing:

- Opening a working-tree file starts both a file-diff request and a hunk-preview request. Both independently run repository status. The preview also runs diff generation, repeated index/HEAD lookups, and two full-file revision hashes.
- Applying one hunk recomputes the full preview for stale-revision safety, then checks and applies the patch. The client now requests status only; the workspace promotes to a full repository snapshot if HEAD or the current branch changed.
- Whole-file stage/unstage loads a full snapshot on the server and returns it. The route now adopts that returned snapshot rather than requesting another one.
- Selecting a commit can queue eager prefetch of every changed file's full diff (up to 256 targets) ahead of the file the user opens.
- Snapshot changes do not always invalidate a file diff: the viewer key uses status metadata, not snapshot identity or a content revision.

The viewer normally has a 30-second RPC timeout, so a slow request should eventually become an error. Git subprocesses have no timeout, and the serial WebSocket handler can remain blocked behind a subprocess after the client has timed out. Large synchronous parsing/rendering can also block the browser main thread.

## Request paths

### Working-tree file selection

`CommitFileDiffViewer.loadDiff` sends `git.working_tree_file_diff` and, for working-tree or staged sources, starts `git.hunk_preview` without awaiting it. The intent is for hunk support not to keep loaded contents behind the loading overlay ([`CommitFileDiffViewer.svelte`](../apps/web/src/lib/components/CommitFileDiffViewer.svelte#L131)).

The server processes requests serially per WebSocket: `handle_socket` awaits `process_request_result`, which awaits dispatch before the loop reads another frame ([`lib.rs`](../crates/gitgui-server/src/lib.rs#L682), [`lib.rs`](../crates/gitgui-server/src/lib.rs#L793)). The two calls therefore do not execute concurrently on that connection. Switching files also does not cancel an earlier RPC; the viewer only ignores a late result by comparing its local request counter ([`CommitFileDiffViewer.svelte`](../apps/web/src/lib/components/CommitFileDiffViewer.svelte#L143)).

The file-diff handler resolves the repository, loads fresh status, locates the file, then reads both file contents ([`lib.rs`](../crates/gitgui-server/src/lib.rs#L1978)). Status runs `git status --porcelain=v2 --branch --untracked-files=all` ([`repository.rs`](../crates/gitgui-core/src/git/repository.rs#L353)). Content is loaded whole from Git/index or the working tree; there is no size limit or partial-read path ([`repository.rs`](../crates/gitgui-core/src/git/repository.rs#L283), [`repository.rs`](../crates/gitgui-core/src/git/repository.rs#L841), [`repository.rs`](../crates/gitgui-core/src/git/repository.rs#L872)).

### Hunk preview and application

For selectable text changes, one `preview_hunks` call does approximately eight Git subprocess invocations in the common path: two HEAD/index lookups for the pre-revision, repository resolution and status, another index lookup, Git diff, then two more HEAD/index lookups for the post-revision. The revision calculation hashes the entire file each time ([`working_tree.rs`](../crates/gitgui-core/src/git/working_tree.rs#L114), [`working_tree.rs`](../crates/gitgui-core/src/git/working_tree.rs#L160)). Filesystem metadata checks and file reads are additional work.

`apply_hunks` recomputes that preview to validate the client revision, then executes `git apply --check` and `git apply` ([`working_tree.rs`](../crates/gitgui-core/src/git/working_tree.rs#L268)). Thus an apply is about ten Git subprocesses in the common path, in addition to the earlier preview and working-tree diff used to populate the viewer. These counts are code-path counts, not measured timings.

After the hunk RPC succeeds, the route refreshes status. `ClientWorkspace.refreshStatus` retains commit, graph, ref, stash, and worktree data when HEAD and the current branch are unchanged; a changed HEAD or branch promotes the operation to `repositories.refresh` and a complete snapshot ([`workspace-store.svelte.ts`](../apps/web/src/lib/workspace/workspace-store.svelte.ts#L1241), [`workspace.ts`](../apps/web/src/lib/client-runtime/workspace.ts#L176)).

### Whole-file stage/unstage

`git.stage` and `git.unstage` use `run_git_action`. That server helper performs the mutation, loads a full snapshot while holding the repository mutation lock, then returns the snapshot with the result ([`lib.rs`](../crates/gitgui-server/src/lib.rs#L1483), [`lib.rs`](../crates/gitgui-server/src/lib.rs#L1821)). The shared route action now adopts that returned snapshot into the workspace instead of requesting another full refresh ([`workspace-store.svelte.ts`](../apps/web/src/lib/workspace/workspace-store.svelte.ts#L1195), [`workspace.ts`](../apps/web/src/lib/client-runtime/workspace.ts#L469)).

Filesystem notifications can also produce a `repository.changed` status invalidation. The watcher emits debounced status/snapshot events, and the workspace schedules a status refresh for status events ([`watching.rs`](../crates/gitgui-server/src/watching.rs#L284), [`workspace.ts`](../apps/web/src/lib/client-runtime/workspace.ts#L111)). When stage/unstage returns its post-mutation snapshot, the workspace adopts it and consumes invalidations already queued for that repository. A watcher event delivered after adoption can still trigger a status read, preserving convergence for later external changes.

### Commit diff prefetch

At the time of this investigation, selecting a commit started a full-diff prefetch for every listed path. Issue #7 changed this path: commit selection now loads only the file list, and the selected file's diff is loaded by the viewer when opened. Unselected files do not start background diff work, so a stale commit selection cannot leave a queued batch ahead of the current file selection on the serial WebSocket.

The retained prefetch RPC is a best-effort performance hint capped at one target per request, so callers can stop between complete-diff loads. The shared recent diff cache is bounded to 100 entries and 16 MiB of cached text payload; an individual diff larger than that byte budget is returned to its direct caller but is not retained in the cache. This bounds cache retention, while direct user-requested diffs remain complete.

## Correctness and loading-state findings

### Same-status content changes can leave stale data in the viewer

The workspace replaces the snapshot after status refresh even when status letters stay identical, with the intent of invalidating mutable previews ([`workspace.ts`](../apps/web/src/lib/client-runtime/workspace.ts#L176)). The viewer's request key instead consists of repository, source, HEAD/commit, path, original path, and file status ([`CommitFileDiffViewer.svelte`](../apps/web/src/lib/components/CommitFileDiffViewer.svelte#L203)). It does not include snapshot identity, content revision, or a file-content fingerprint. An edit or partial hunk stage that leaves those key fields unchanged will not reload the file diff or hunk preview. Server revision validation should reject a stale hunk mutation, but the user can continue seeing old content and controls.

### A normal slow RPC has a timeout, but backend work does not

The client default request timeout is 30 seconds ([`client.ts`](../packages/client-runtime/src/rpc/client.ts#L63)). The Git command runner spawns a child and waits for it without a deadline or cancellation hook ([`command.rs`](../crates/gitgui-core/src/git/command.rs#L41)). If a Git command stalls, the viewer request can time out on the client while the server remains blocked processing that request and does not reach later requests. Separately, file parsing is synchronous after the data arrives; a large diff can block rendering and timer callbacks ([`CommitFileDiffViewer.svelte`](../apps/web/src/lib/components/CommitFileDiffViewer.svelte#L292)).

At the time of the original investigation, no per-RPC or per-Git-command
duration instrumentation was present. The diagnostics below add measurements
for these paths.

## Recommended tasks

These follow-up tasks were filed as GitHub issues. Priority order is suggested; measure before choosing the final implementation design.

1. [Instrument file-view load and stage latency](https://github.com/math254e/GitGui/issues/3). Record client request queue/round-trip time, server dispatch and Git command duration, response byte count, and client parse/render duration.
2. [Keep obsolete file requests and prefetch from blocking interactive RPCs](https://github.com/math254e/GitGui/issues/4). Rework per-connection dispatch/concurrency and bound or cancel stale file requests while preserving mutation ordering and repository locks.
3. [Reduce repeated Git and full-file work for working-tree diffs and hunks](https://github.com/math254e/GitGui/issues/5). Share status work, reduce repeated lookups and whole-file hashes, and retain stale-patch protection.
4. [Avoid full repository reloads after working-tree mutations](https://github.com/math254e/GitGui/issues/6). Refresh status after hunk changes and consume snapshots already returned by whole-file stage/unstage.
5. [Make commit diff prefetch bounded and prioritize the selected file](https://github.com/math254e/GitGui/issues/7). Implemented with on-demand file diffs, a one-target best-effort server prefetch cap, and a byte-bounded diff cache.
6. [Invalidate file diff and hunk preview when content changes with unchanged status](https://github.com/math254e/GitGui/issues/8). Include an explicit content generation/revision in invalidation.
7. [Define a responsive rendering path for very large files](https://github.com/math254e/GitGui/issues/9). Measure parse/render behavior, then add a suitable size threshold or alternate rendering path.

## Verification boundary

Issue #6 implements the targeted refresh changes described above. The rest of
The original investigation used static source inspection only and did not benchmark a repository or inspect a live dev session. The diagnostics below add runtime measurements; no baseline repository benchmark is included in this change.

## Runtime diagnostics

The file-view path now emits structured measurements at these boundaries:

- The browser client logs selected RPC method, wait for the socket writer,
  round-trip duration, response frame bytes, and success/failure. It measures
  file diffs, hunk previews, stage/unstage, hunk application, and repository
  refresh. Only the fixed method name and numeric measurements are logged.
- The Rust server logs dispatch duration and serialized response bytes for the
  same methods. The Git command runner logs a coarse allowlisted command
  category, duration, stdout/stderr byte counts, and exit code. It does not log
  command arguments, paths, stdin patches, or output text.
- Hunk application additionally logs preview validation, patch check, and patch
  application durations. Refresh has its own RPC dispatch duration, separating
  the post-mutation refresh from the hunk mutation.
- The viewer logs diff parse and render durations separately and a bounded
  character-size estimate. It does not log diff contents or file paths.

Use the client round-trip duration with the corresponding server dispatch
duration and response bytes: the time outside dispatch is socket queueing plus
wire transfer. A nonzero client writer wait identifies local send backpressure;
large response bytes indicate transfer volume. These signals bound the likely
cause but do not provide an exact server-side queue duration or network transfer
duration. Server requests remain serial on one WebSocket, as documented above.
Diagnostic records are emitted at debug-console / info-tracing levels and do
not alter RPC responses or behavior.
