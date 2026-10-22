# File view loading and staging investigation

**Scope:** Read-only code investigation of slow file-view loads and file/hunk staging refreshes. No runtime profiling was performed, so the code paths below are confirmed while their relative runtime cost remains unmeasured.

## Summary

The clearest systemic bottleneck is that the Rust WebSocket handler awaits one RPC to completion before reading the next request on that connection. The client can send multiple requests, but a slow request—including an eager prefetch or an obsolete file selection—blocks every request behind it.

Several paths amplify that queueing:

- Opening a working-tree file starts both a file-diff request and a hunk-preview request. Both independently run repository status. The preview also runs diff generation, repeated index/HEAD lookups, and two full-file revision hashes.
- Applying one hunk recomputes the full preview for stale-revision safety, then checks and applies the patch. The client subsequently requests a full repository snapshot, rebuilding history and graph for a working-tree-only change.
- Whole-file stage/unstage loads a full snapshot on the server and returns it, but the route discards the response and requests a second full snapshot.
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

After the hunk RPC succeeds, the route calls `refreshAfterMutation` ([`+page.svelte`](../apps/web/src/routes/+page.svelte#L1119)). That calls `repositories.refresh`, whose server implementation invokes `load_snapshot`; `load_snapshot` calls `load_repository`, which loads status, stashes, worktrees, commits, graph layout, and refs ([`+page.svelte`](../apps/web/src/routes/+page.svelte#L1165), [`lib.rs`](../crates/gitgui-server/src/lib.rs#L1219), [`lib.rs`](../crates/gitgui-server/src/lib.rs#L3221), [`repository.rs`](../crates/gitgui-core/src/git/repository.rs#L133)). This is broad work for a hunk that only changes the index or working tree.

### Whole-file stage/unstage

`git.stage` and `git.unstage` use `run_git_action`. That server helper performs the mutation, loads a full snapshot while holding the repository mutation lock, then returns the snapshot with the result ([`lib.rs`](../crates/gitgui-server/src/lib.rs#L1483), [`lib.rs`](../crates/gitgui-server/src/lib.rs#L1821)). The shared route action awaits but discards the mutation result and then makes another full refresh request ([`+page.svelte`](../apps/web/src/routes/+page.svelte#L1127), [`+page.svelte`](../apps/web/src/routes/+page.svelte#L1165)). This establishes two full snapshot loads for whole-file stage/unstage.

Filesystem notifications can also produce a `repository.changed` status invalidation. The watcher emits debounced status/snapshot events, and the workspace schedules a status refresh for status events ([`watching.rs`](../crates/gitgui-server/src/watching.rs#L284), [`workspace.ts`](../apps/web/src/lib/client-runtime/workspace.ts#L111)). If an index notification is observed during a mutation, it can cause a further status read after the explicit refresh; this is timing-dependent and is lighter than a full snapshot refresh.

### Commit diff prefetch

Selecting a commit starts prefetch. The route first loads the commit file list, then requests diffs for every listed path ([`+page.svelte`](../apps/web/src/routes/+page.svelte#L927), [`+page.svelte`](../apps/web/src/routes/+page.svelte#L1050)). The server accepts up to 256 targets and processes them sequentially, loading complete diffs ([`lib.rs`](../crates/gitgui-server/src/lib.rs#L2105), [`lib.rs`](../crates/gitgui-server/src/lib.rs#L2143)). Because this is one request on the same serial WebSocket, the file the user selects can wait behind the entire batch.

The diff cache holds at most 100 recent file diffs, while a prefetch can contain 256 targets ([`cache.rs`](../crates/gitgui-core/src/git/cache.rs#L5)). Large batches can therefore do work for entries that are evicted before the user opens them.

## Correctness and loading-state findings

### Same-status content changes can leave stale data in the viewer

The workspace replaces the snapshot after status refresh even when status letters stay identical, with the intent of invalidating mutable previews ([`workspace.ts`](../apps/web/src/lib/client-runtime/workspace.ts#L176)). The viewer's request key instead consists of repository, source, HEAD/commit, path, original path, and file status ([`CommitFileDiffViewer.svelte`](../apps/web/src/lib/components/CommitFileDiffViewer.svelte#L203)). It does not include snapshot identity, content revision, or a file-content fingerprint. An edit or partial hunk stage that leaves those key fields unchanged will not reload the file diff or hunk preview. Server revision validation should reject a stale hunk mutation, but the user can continue seeing old content and controls.

### A normal slow RPC has a timeout, but backend work does not

The client default request timeout is 30 seconds ([`client.ts`](../packages/client-runtime/src/rpc/client.ts#L63)). The Git command runner spawns a child and waits for it without a deadline or cancellation hook ([`command.rs`](../crates/gitgui-core/src/git/command.rs#L41)). If a Git command stalls, the viewer request can time out on the client while the server remains blocked processing that request and does not reach later requests. Separately, file parsing is synchronous after the data arrives; a large diff can block rendering and timer callbacks ([`CommitFileDiffViewer.svelte`](../apps/web/src/lib/components/CommitFileDiffViewer.svelte#L292)).

No per-RPC or per-Git-command duration instrumentation was found in these paths. The code supports the bottlenecks above, but cannot identify which dominates on a specific repository without runtime measurements.

## Recommended tasks

These follow-up tasks were filed as GitHub issues. Priority order is suggested; measure before choosing the final implementation design.

1. [Instrument file-view load and stage latency](https://github.com/math254e/GitGui/issues/3). Record client request queue/round-trip time, server dispatch and Git command duration, response byte count, and client parse/render duration.
2. [Keep obsolete file requests and prefetch from blocking interactive RPCs](https://github.com/math254e/GitGui/issues/4). Rework per-connection dispatch/concurrency and bound or cancel stale file requests while preserving mutation ordering and repository locks.
3. [Reduce repeated Git and full-file work for working-tree diffs and hunks](https://github.com/math254e/GitGui/issues/5). Share status work, reduce repeated lookups and whole-file hashes, and retain stale-patch protection.
4. [Avoid full repository reloads after working-tree mutations](https://github.com/math254e/GitGui/issues/6). Refresh status after hunk changes and consume snapshots already returned by whole-file stage/unstage.
5. [Make commit diff prefetch bounded and prioritize the selected file](https://github.com/math254e/GitGui/issues/7). Prioritize interactive work and bound the count/bytes of sequential full-diff prefetch.
6. [Invalidate file diff and hunk preview when content changes with unchanged status](https://github.com/math254e/GitGui/issues/8). Include an explicit content generation/revision in invalidation.
7. [Define a responsive rendering path for very large files](https://github.com/math254e/GitGui/issues/9). Measure parse/render behavior, then add a suitable size threshold or alternate rendering path.

## Verification boundary

This investigation used static source inspection only. It did not benchmark a repository, inspect a live dev session, or change code. The most important unknown is the measured split between server-side Git/status/refresh time and client-side transfer/parse/render time.
