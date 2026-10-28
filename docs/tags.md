# Tags in the sidebar and graph

The sidebar order is Local branches, Remote branches, Tags, Worktrees, Stashes.
Tags use a flat list of complete names with natural version ordering. The Tags
section remembers its collapsed state per repository and environment. Selecting
a commit tag reveals its ref and navigates to that commit. Tags targeting trees
or blobs remain visible, with commit navigation unavailable.

Lightweight, annotated, and nested annotated tags share the existing snapshot
`CommitRef` contract. Rust peels nested targets in one batch rather than starting
a Git process per tag. Display names come from the literal `refs/tags/` suffix,
so a branch with the same name cannot introduce Git's disambiguation prefix.

The sidebar mounts only the viewport's rows plus six rows of overscan on either
side, at a fixed 26px height. Sorting depends on refs, and target lookups depend
on commits; working-tree status updates do not rebuild these indexes. Arrow,
Page Up/Down, Home, and End navigate the list, including rows outside the window.

The graph uses its existing target-to-refs index. Tag badges have a tag icon and
stay attached to their exact commit. Up to three tags render on a row; an
additional count points users to the full sidebar list. Tag refs do not take part
in branch lane labels or inferred branch ancestry.

Eye controls persist through the existing client-owned ref visibility settings.
Badges update immediately while the server computes filtered history, preserving
the existing graph until replacement lanes arrive. Ancestor targets are removed
from filtered-history requests without changing reachability, keeping thousands
of ancestral release tags from consuming thousands of RPC target slots. The
existing limit of 256 independent history roots still applies.

## Creation

A normal commit's context menu includes **Tag...**, beside **Branch...**.
The compact name dialog captures the commit's full object ID and its
repository/environment context when opened. Changing selection cannot change
that target. Local validation catches invalid or already known names immediately;
server failures preserve the input for correction. Creation is local and
lightweight; creating annotations and signing are outside this
slice.

The additive `git.tag.create` RPC advertises the matching capability and requires
the existing `repository:operate` scope. Its Rust parameters are `repositoryId`,
`name`, and `target` (a full SHA-1 or SHA-256 commit ID). Older servers disable the
menu action. Rust validates the full tag ref with installed Git and checks the
literal object type with replacement objects disabled.

Creation uses a prepared `update-ref --no-deref` create transaction. While holding
the ref lock, Rust rejects symbolic tags, including dangling refs that Git's
zero-old-ID check otherwise treats as absent. It never overwrites an existing tag
or changes HEAD, index, or worktree files. Direct ref creation keeps this action
lightweight regardless of `tag.gpgSign`. An aborted preparation closes and reaps
the Git child, releasing the lock.

The endpoint uses the existing repository mutation lock and returns the
repository summary and refreshed snapshot. The client applies that response
without a second snapshot request. Snapshot failures retain the existing
`mutationSucceeded` diagnostic, so UI recovery refreshes instead of replaying the
mutation.

## Deletion

Right-clicking a sidebar tag, or pressing Shift+F10 on its name, offers
**Delete tag…**. Confirmation names the local tag and starts with Cancel focused.
Deletion is available for lightweight, annotated, nested, and non-commit tags.
It does not delete remote tags. The menu preserves graph selection and its row
highlight while open, and closes when its sidebar context is disposed.

Snapshots include optional `CommitRef.objectId` for the literal unpeeled tag
object, collected in the existing ref listing without extra Git reads. The
`git.tag.delete` RPC takes `repositoryId`, `name`, and `expectedObjectId`, requires
`repository:operate`, and advertises its own capability. Older servers or refs
without a reviewed object ID keep deletion disabled.

Rust shares the prepared tag transaction with creation, deleting only when the
literal ref still matches the reviewed object ID under its ref lock. Replacing
an annotation is rejected even if its peeled commit is unchanged. Symbolic tag
refs are rejected, and a branch with the same short name is unaffected. The
mutation returns a snapshot for immediate client application; failures keep the
confirmation open with an error. Repository or environment changes dismiss the
confirmation and prevent a stale request.

## Checkout and remote synchronization

The sidebar menu offers **Checkout &lt;name&gt;** for commit tags and **Push tag** for a
reviewed tag. Checkout uses the reviewed object, peels it to a commit, and calls
`git switch --detach`; Git protects conflicting local changes. Success identifies
detached HEAD in the notification. Push sends only that tag's immutable reviewed
object to its full remote tag ref, with automatic following of other tags disabled.

Main Push includes branch updates and all local tags in one `git push --tags`
command with explicit branch refspecs. A single config read and HEAD read resolve
the configured remote and normal `push.default`/`remote.push` branch mappings.
This explicit selection is necessary because `--tags` alone suppresses Git's
default branch selection. A detached HEAD pushes tags only. Partially rejected
pushes return a warning instead of reporting complete success.

Main Fetch likewise uses one network command. It combines the configured branch
mappings with `--tags --porcelain --prune --no-prune-tags --refmap=`. Configured
force-tag mappings are excluded so they cannot bypass review. Local-only tags are
kept. Git fetches new tags and branches normally and reports rejected differing
tags as machine-readable old/new object IDs; no remote scan or per-tag Git calls
are needed. Unusual fetch mappings that write arbitrary local tag destinations
are rejected rather than silently bypassing this rule.

The response's optional `tagConflicts` opens a review dialog. **Keep local tags**
leaves conflicts unchanged; selected replacements use `git.tag.apply_fetch`.
That action applies already downloaded objects in a single prepared transaction,
checking every old object ID and rejecting symbolic refs. A stale local tag
aborts the entire batch. It needs two local Git processes regardless of batch
size: the prepared update and a batched symbolic-ref check. No second network
fetch occurs. Reviews are scoped to their repository/environment.

The `git.tag.checkout`, `git.tag.push`, and `git.tag.apply_fetch` capabilities
require `repository:operate`. `git.tag.details` requires `repository:read`.
Mutations return the existing snapshot shape for immediate application.

## Hover details

`DetailsHoverCard.svelte` owns the shared delayed, portalled card surface,
positioning, pointer retention, focus description, and Escape/scroll dismissal.
Its snippet content is shared by tag, branch, and stash cards.
`TagHoverDetails.svelte` supplies tag content from the current snapshot and
optional annotation metadata.

Lightweight cards require no additional Git command. Annotated cards wait 300ms
before requesting metadata. One bounded `for-each-ref` reads and verifies the
reviewed ref and annotation (at most 64 KiB). The workspace shares in-flight and
completed reads in a 64-entry cache keyed by environment, repository, name, and
immutable object ID; environment changes clear it. Repeated hovers reuse it.
Fields include type, full target ID, commit subject, author/tagger, date, and
annotation. A present signature is labelled unverified; hovering never starts
signature verification or loads another repository snapshot.

Local and remote-tracking branches use `BranchHoverDetails.svelte`: full branch
name, tip commit, author, date, and commit subject. Local branches also show
checked-out worktree paths; the current branch can show the snapshot's upstream
ahead/behind counts. Counts are never inferred for other branches.
`StashHoverDetails.svelte` shows the stash selector, message, creation date,
original branch (or Unknown), stash object ID, and original base commit with its
subject when available. These cards read only the existing snapshot and start
no RPC requests or Git commands.

`TreeDetailsHoverCard.svelte` connects the virtualized branch/stash trees to the
same delayed card surface. Event delegation handles pointer and keyboard focus
inside the tree's shadow root without adding listeners per row. Folders and
branch visibility controls do not open cards. Opening a context menu, changing
repository/environment, scrolling, recycling a hovered row, or disposing the
tree dismisses its card without changing selection.
