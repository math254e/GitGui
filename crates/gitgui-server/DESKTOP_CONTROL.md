# Desktop-owned update control

This crate translates T3 Code's desktop-owned backend stop/readiness boundary
(`apps/desktop/src/backend/DesktopBackendManager.ts` and
`docs/internals/server-updates.md`) into a cooperative Rust Git-work drain.
GitGui needs this extra barrier because cancelling a Tokio task cannot stop its
already-started `spawn_blocking` Git worker. No remote updater or launcher is
introduced. The desktop remains responsible for installer orchestration and
observing the exact child process exit.

Enable only for the desktop-owned child with both:

```text
GITGUI_SERVER_BOOTSTRAP_STDIN=1
GITGUI_SERVER_DESKTOP_CONTROL=1
```

Send the bootstrap credential as the first stdin line and keep stdin open.
The same buffered reader consumes subsequent newline-delimited JSON:

```json
{"id":"prepare-1","command":"prepare-update"}
{"id":"resume-1","command":"resume"}
{"id":"stop-1","command":"shutdown"}
```

Git children must not inherit this stdin handle. `git_command()` defaults to
`Stdio::null()`; commands that send Git data explicitly select `Stdio::piped()`.
On Windows, inheriting the actively read control pipe can block even
`git rev-parse` indefinitely and make repository refresh time out. The process
integration test exercises real Git startup, refresh/snapshot RPCs, and control
shutdown with this pipe kept open throughout.

Replies are flushed stdout lines with the exact prefix
`GITGUI_SERVER_CONTROL=` followed by JSON containing `id`, `ok`, and an optional
static `message`. They never include the credential or original input. IDs must
be nonempty, have no control characters, and fit within 128 UTF-8 bytes. Input
lines are capped at 4096 bytes including the newline. Invalid/oversized frames
return `ok:false` with an empty ID; unknown commands with valid IDs retain their
ID. Overflow is discarded through the newline before parsing another frame.
The input queue is bounded to 16 frames.

`prepare-update` atomically pauses admission hostwide across every session and
background Git worker. All repository-scoped requests return the existing
`server_busy` error while paused, including reads: reads can start Git and
refresh cache/catalog state, so allowing them would prevent a reliable drain.
Server info/status remain usable. Started dispatches, including those detached
from disconnected WebSockets, keep their permits until their workers and catalog
writes finish. Watcher and stash preparation workers hold the same permits.

Preparation waits up to 30 seconds. Success holds the barrier until `resume` or
accepted `shutdown`. Timeout returns `ok:false` with
`Repository work is still busy; admissions resumed` and automatically restores
admission. It never aborts tasks or kills Git processes. `resume` is idempotent.
Pipe EOF/read failure or failed reply delivery also resumes admission, leaving
the server running so other clients cannot be permanently blocked by owner loss.

`shutdown` fails until preparation has succeeded. Once accepted, shutdown is
irreversible: the server flushes its acknowledgement, marks readiness false,
closes upgraded WebSockets, stops background work cooperatively, gracefully
stops HTTP, and awaits owned sockets and outstanding Git work before returning
from `run_with_control`. No Unix signal is required. The desktop must observe
successful process exit before installing; an acknowledgement alone is not
proof of exit. A prepare timeout can be followed by `resume`; an accepted
shutdown cannot be undone by a later `resume`.

Without both enabling variables, standalone bootstrap and signal-driven run
modes retain their ordinary behavior and have no command channel. Library
callers may use `run_with_control` with the narrow inherited-input parser; this
facility is never mounted on HTTP or Git RPC routes.
