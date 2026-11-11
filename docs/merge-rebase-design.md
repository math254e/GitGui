# Merge and rebase design

Status: design reference. The implementation and current limitations are
described in `branch-workflows.md`; rebase now starts directly onto a selected
commit without a review dialog. Command deadlines and a pre-rebase remote
baseline are not yet implemented.

## Scope and interaction

Support merging a selected branch into the current branch and rebasing the
current branch onto a selected branch. Squash merge, interactive rebase, and an
in-app conflict editor are deferred. Conflict resolution happens externally.

The branch sidebar and graph branch menus offer **Merge <source> into
<current>…** and **Rebase <current> onto <target>…**. Offer the same actions
for eligible local and remote-tracking branch refs, including branches attached
to another worktree; selecting a source never switches or modifies that
worktree. Extend the existing linked-worktree menu path as needed. Disable the
actions for the current branch, detached or unborn HEAD, an unsupported server,
or a conflicting operation. The server enforces these restrictions independently.

A review dialog shows the checkout, current branch, selected ref, both reviewed
commit IDs, and the direction of the operation. Merge permits fast-forward and
otherwise creates a merge commit. Rebase replays commits onto the chosen tip;
it rewrites commit IDs and does not implicitly push. A rebase may omit commits
Git considers already applied and, with the default linear replay, does not
preserve merge commits. Explain these effects, including when a published
branch may be affected. Do not silently enable autostash or change user's files
to make an operation start: require a clean index and tracked working tree,
and allow Git to reject untracked files that obstruct the operation.

The reviewed ref and HEAD are revalidated under the server mutation lock. A
stale review is rejected and must be reviewed again. Git commands use a
validated immutable source commit ID, so moving the selected source ref after
validation cannot silently change the chosen input. External processes do not
honor the server lock; validation is not atomic with changes to HEAD, the
index, worktree, or refs. Git's own locks and errors remain authoritative, and
the UI warns against concurrent Git operations during execution. Never claim
the preflight eliminates that race.

## Operation and recovery

Git's per-worktree metadata and index are the source of truth, including for
operations started outside GitGui. Extend the repository status with a typed,
optional operation state: kind, relevant branch or commit labels when safely
available, rebase progress when available, unresolved paths, and available
actions. Distinguish no operation, merge, rebase, and unsupported or unknown
operations; absence of readable metadata must not be mistaken for idle. Use
Git-resolved per-worktree paths, not a hardcoded `.git` directory. Detect
unmerged index entries as well as operation metadata. Unknown, malformed, or
inaccessible state blocks destructive actions and produces a useful error.
Treat merge or rebase initiated outside GitGui the same as one started here.

An operation row in the graph shows what is in progress; its context menu
offers recovery actions. The working tree lists conflicted files using existing
status presentation. External edits and staging
are reflected through the existing repository watcher, reconnect and foreground
revalidation; verify watches cover the relevant worktree Git metadata and add
coverage where necessary. Existing full-file staging may mark resolved files;
do not label a file resolved merely because conflict markers disappeared.
Git's index determines whether it remains unmerged. If the watch is delayed or
unavailable, offer refresh and retain existing recovery behavior.

Continue and Abort operate on the observed operation kind; rebase also offers
Skip with confirmation because it discards the current replayed commit's
changes. Confirm Abort and explain that Git attempts to restore the pre-operation
state and may discard resolution work or fail if the worktree changed. Never
add a forced cleanup fallback. Disable Continue when known unresolved entries
remain; still recheck on the server. Git may stop again at another conflict,
request manual editing, or fail for a different reason. Refresh and report the
resulting state rather than treating every nonzero exit as a conflict. A merge
that resolves conflicts must be able to create its merge commit without an
interactive editor; preserve Git's prepared message. A completed fast-forward,
merge, or rebase refreshes the full repository snapshot. Git's state must remain
recoverable after UI disconnect, process restart, or failed refresh.

Use noninteractive Git execution and explicitly handle hooks, signing, credential
helpers, editors, and configuration that cannot complete without interaction:
surface a bounded, actionable error and the actual resulting state; never hang
the server or blindly retry a mutation. Do not suppress hooks or signing
silently. Specify and test the exact command environment and timeout behavior
when implementing. Timeouts or lost responses have an **unknown outcome**:
refresh before allowing the user to decide the next action, never replay the
mutation automatically. Honor normal Git merge behavior with `--ff --no-edit`;
make linear rebase and the absence of automatic stash explicit in command
options rather than depending on configuration, including disabling automatic
updates of other branch refs. Do not invoke an interactive sequence editor.

## Optional push after rebase

Offer a separate, unchecked option to review pushing the rewritten branch.
Finishing or continuing a rebase never pushes automatically. The ordinary push
path stays available; this flow is only for an explicitly reviewed rewrite.
If a rebase pauses, closes, or starts externally, the push review can be opened
later for the current branch; it must make no assumption that an earlier
transient UI state still exists.

Resolve the actual configured push destination, including remote and full
destination ref; display both. If no unambiguous existing upstream push
destination can be established, do not guess: explain that configuration or a
normal first push is needed. Read the actual destination ref from the remote,
not just the cached remote-tracking ref, and compare with a recorded pre-rebase
remote tip if available. Show the reviewed local tip and remote tip, whether
the remote changed since the earlier observation, and a meaningful description
of commits that would cease to be reachable from that remote branch when the
comparison is available. If history is shallow, inaccessible, or otherwise
insufficient for a reliable comparison, say so and do not claim that all
affected commits have been identified. Warn that collaborators may have based
work on the old history. No recorded baseline proves that a rewrite is safe.

Confirmation applies to the exact remote, destination ref, local commit and
remote commit displayed. Re-resolve and validate the destination and local
branch before push; use the reviewed immutable local object ID as the source
and Git's explicit `--force-with-lease=<full-ref>:<expected-remote-oid>` for the
destination. A changed or deleted remote ref rejects the lease; re-read and
require a new review, never fall back to unconditional force. Reject changed
local branch, changed push configuration, or an unresolved/multiple push URL
before invoking Git. Git may reject protected branches or authentication; show
the error without retrying with broader permissions. If a response is lost,
query and present current state without assuming a retry is safe. Do not put
credentials in RPC payloads, URLs displayed in the UI, or logs; reuse existing
server-side Git authentication. The lease protects concurrent updates, not
collaborators who already consumed old history.

## Boundaries and contracts

Rust core owns operation inspection, preflight, Git invocation, and structured
outcomes. Server RPC handlers validate repository access and arguments, use the
existing mutation serialization and authorization conventions, and publish
repository invalidations. Serialize review-sensitive mutations for the same
checkout; audit shared-ref and linked-worktree interactions against existing
locks rather than assuming a per-registration lock covers the whole family.
External processes remain outside these locks. Do not hold a server lock while
waiting for the user to resolve conflicts or confirm a push.

Define additive Rust protocol types and generate TypeScript contracts. Proposed
methods are `git.integrate.review`, `git.integrate.start`,
`git.integrate.continue`, `git.integrate.abort`, `git.integrate.skip`,
`git.rewritePush.review`, and `git.rewritePush.push`. Exact naming should follow
the existing protocol registry during implementation. Read-only inspection and
review use the applicable repository read scope; all operations and push use
`repository:operate`. Advertise capabilities for integration and rewrite push;
older servers must keep unsupported controls disabled. Requests carry repository
identity, operation kind and reviewed expectations, not shell fragments or
credentials. Validate refs as literal refs and IDs as Git object IDs, pass
arguments without a shell, and sanitize user-visible remote information.

Responses distinguish completed, stopped with an inspected state, rejected stale
review, Git failure with resulting state, and unknown outcome. A successful
mutation followed by refresh failure remains successful; offer refresh only.
Client workspace state owns request and refresh coordination per environment
and repository; Svelte owns dialogs and presentation. No new Electron bridge,
connection runtime, or transport behavior is needed.

## Verification and delivery

Implement in vertical slices: (1) inspect operation state and watch external
changes, (2) reviewed merge and its recovery, (3) reviewed rebase and its
recovery, (4) independently reviewed optional rewrite push. Update the existing
branch workflow documentation when behavior ships.

Use real temporary Git repositories and local bare remotes to test fast-forward,
merge commit, already-up-to-date, divergent rebase, multiple conflict stops,
external resolution and staging, continue, skip, abort, restart and externally
started operations. Cover dirty and untracked files, unusual paths, detached
HEAD, unborn branches, malformed or inaccessible metadata, linked worktrees,
unmerged index without recognized operation, stale refs, competing mutations,
hooks, signing/editor failures, and partial refresh or lost responses. Test
push review against remote movement and deletion, changed local tip or push
configuration, shallow history, rejected force push, and authentication errors;
assert no unconditional force or automatic retry. Cover RPC authorization,
capability negotiation, generated contracts, and independent repositories and
environments. UI tests verify operation direction, confirmation, external state
refresh, control availability, and the unchecked optional push. Run the relevant
Rust, protocol generation, frontend, and patch checks for implementation.
