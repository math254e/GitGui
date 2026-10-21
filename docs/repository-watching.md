# Repository watching and history scale

## Repository invalidations

`gitgui-server` owns native filesystem watchers for catalogued repositories while
at least one read-authorized WebSocket session is connected. Watches include the
working directory, its Git directory, and its common Git directory. This covers
linked worktrees whose metadata lives outside their working directory. Removing
a repository releases its watch on the next catalog pass (within one second).
Shutdown and the last read session disconnecting release the watches.

The additive `repositories.watch` capability advertises `repository.changed`
events on the existing ordered WebSocket stream. The generated payload contains
only `repositoryId` and `kind`:

- `status`: reload `git.status`, replace the working-tree snapshot and its diff
  previews, and retain the existing commits, graph, refs, and stash objects.
- `snapshot`: reload that repository's complete snapshot because HEAD, refs,
  stashes, configuration, or worktree metadata may have changed.

A changed HEAD or branch discovered during a status read promotes it to a full
snapshot. Coarse native notifications may also request the stronger refresh.
Read scope is required to receive repository events. No new IPC or transport is
introduced, and protocol version 2 remains compatible with clients that ignore
the new events and servers that do not advertise them.

Notifications settle for 200 ms, with a one-second upper bound during continuous
changes. Each repository keeps one pending invalidation and at most 128 changed
paths. Snapshot invalidations dominate status invalidations. Lock files, object
storage, ordinary reflogs, and hook files are excluded. The stash reflog is
watched because dropping an older stash can leave `refs/stash` unchanged. Small batches containing only
ignored, untracked paths are filtered through Git's ignore rules; uncertain or
large batches conservatively invalidate status. Git reads disable optional index
writes so status queries cannot create watch/refresh loops.

The per-environment `ClientWorkspace` subscribes for the current RPC session,
coalesces invalidations, and serializes refreshes with tab operations. An event
arriving during a refresh schedules another refresh. Closed tabs and disposed
workspaces ignore late results; failed refreshes preserve the cached snapshot
and expose the repository error. Status refreshes replace the snapshot even
when Git status letters are unchanged, invalidating mutable diff/hunk previews.
The route no longer owns polling or focus listeners.

Sequence gaps revalidate open repositories. A client that falls behind the
server's bounded event queue is disconnected so the existing supervisor creates
a replacement session and rehydrates state. Watch creation failures retry and
invalidate every 30 seconds; native overflow/errors request a snapshot and a
watch rebuild. Client recovery runs every two minutes, or every 30 seconds with
older servers. Foreground and visibility changes revalidate open tabs.

This follows T3's session-scoped subscriptions and disposal ownership from
`docs/internals/connection-runtime.md` and
`packages/client-runtime/src/rpc/session.ts` in the local reference checkout.
GitGui retains plain TypeScript observables and owns its Git invalidation
payloads. No connection, authentication, retry, or SSH policy changes.

## History rendering

Rust remains the sole owner of commit ordering and lane layout. The history UI
keeps fixed 34-pixel rows, rendering only the viewport and eight rows of overscan
on each side. Spacer rows preserve the full scroll extent. Canvas nodes are
sliced to the viewport, and an immutable interval index finds intersecting
edges, including merges with both endpoints offscreen. Scroll/hover drawing is
scheduled once per animation frame.

Status-only updates retain history object identity and do not rebuild label or
render indexes. First-parent label assignment visits each assigned commit once;
nearest-descendant ghost labels are searched only when needed for the hovered or
selected commit. Shared commit lookup maps avoid rebuilding a full map for each
branch label.

The viewport anchors to a commit hash and pixel offset when history changes or
the working-tree row appears/disappears. Users at the top stay at the top. Jump
commands resolve rows by data, so offscreen commits need no DOM node. Arrow,
Page Up/Down, Home, and End navigation scrolls, selects, and focuses virtualized
rows. List items expose their full history position and count.

## Verification and limits

- Focused server tests cover notification classification, ignore rules,
  coalescing, external edits/renames/staging/commits, two independent
  repositories, linked metadata, removal, shutdown, WebSocket delivery, and
  read-scope filtering.
- Workspace tests cover batching, retained history identity, HEAD promotion,
  changes during refresh, refresh failures, gaps, independent environments,
  tab closure, disconnect disposal, and older-server polling.
- Graph tests cover a 100,000-row viewport and a long offscreen merge span.
  Rust verifies stable linear lanes when adding a new HEAD to 50,000 commits.
- Browser checks against the existing Vite session rendered 37 DOM commit rows
  for 100,000 commits (46 around the middle), exercised End/Home navigation,
  and preserved the viewed commit when the working-tree row changed. Before/
  after screenshots retain the existing graph appearance. A recording captures
  the virtualized interactions. Screenshot capture in the shared preview timed
  out; isolated headless Chrome captured screenshots against the same Vite app.
- TypeScript/Svelte checks, frontend production build, server tests, graph
  tests, and protocol checks pass on Windows. The complete Rust suite has four
  pre-existing working-tree test failures: Windows-invalid filenames and CRLF
  assumptions. An untouched archive of the current commit reproduces all four.

History loading and transfer still include all reachable public history; this
change virtualizes rendering without adding pagination. Native filesystem
notifications remain best effort, especially on network filesystems and through
external symlinks. Recovery refreshes provide eventual convergence. Native
watchers still consume OS resources for ignored subdirectories; filtering avoids
unnecessary client refreshes but does not remove those native registrations.
Existing revision checks remain authoritative for destructive actions.
