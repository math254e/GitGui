# Branch context menus

Local branches in the sidebar and branch badges in the graph expose **Rename
branch…** and **Delete branch…**. A commit's context menu exposes **Create branch
here…**, plus submenus for the local branches pointing to that commit. Folder
rows and remote refs do not offer local rename/delete actions.

Creation uses the selected commit's object ID, rather than whichever commit is
selected elsewhere in the UI. The dialog identifies the starting commit and
defaults **Switch to this branch** to checked. Unchecking it creates only the
branch. The toolbar's Branch action starts from HEAD using the same dialog.
Git validates names and rejects duplicates. Local missing-input validation stays
in the form; submitted operations close the dialog immediately and report
success or failure through Sonner.

Dialogs use the app's compact square controls and active palette. Inputs show a
regular border without a focus highlight or glow. The ordinary delete
confirmation has no helper paragraph; the unmerged confirmation retains one
short warning in normal text.

Renaming changes only the local branch name and preserves Git's branch config
and reflog through `git branch --move`. Existing names are never overwritten.
The current branch may be renamed.

Deletion first requires confirmation of the named local branch. Rust follows
Git's safe-delete merge rule (the resolved upstream when present, otherwise
HEAD). Unmerged branches return the structured `branch_not_merged` error,
without mutation. A Sonner warning offers **Review deletion**, which opens a
second confirmation explaining that commits may become difficult to recover
and requires a separate **Delete anyway** action. Force is never enabled for
unrelated failures. Deleting a branch checked out in any worktree
is rejected by Rust even with force enabled. Linked-worktree branches instead
offer the worktree actions below. Remote
branches are unaffected.

The additive `git.branch.rename` and `git.branch.delete` RPCs require
`repository:operate` and advertise matching capabilities. Older servers keep
these menu actions disabled. Both methods require the expected branch tip and
operate on literal local refs, rejecting a moved branch or a checkout alias.
They share the existing repository mutation lock and return before the client
refreshes, so a refresh failure cannot trigger a repeated mutation. External
Git processes do not share that lock; the tip check rejects observed changes,
but is not an atomic transaction with arbitrary external ref updates.

Dialogs and open menus are scoped to the repository and environment that opened
them. Repository or environment changes dismiss them. Submitted branch,
worktree, stash, discard, repository-opening, and theme dialogs close before
their operation runs. Results appear through Sonner. Mutation errors preserve
the cached repository view; successful mutations with
failed refreshes use the existing refresh-only retry notification.
Result notifications are emitted after refresh and pending-state cleanup, so
the operation status text clears when its Sonner result appears.

Verification covers branch tips and upstream preservation, duplicate and invalid
names, checkout aliases, current and linked-worktree deletion, safe and forced
deletion, stale tips, and creation at a chosen commit with and without checkout.
An authenticated WebSocket test verifies both mutation methods reject read-only
sessions and require explicit force for unmerged deletion. Browser checks on
Windows exercised the context menus, keyboard access, dialogs, cancellation,
duplicate-name errors, stale deletion rejection, and checkout defaults. Fault
injection verified a successful rename with a failed repository refresh: the
dialog closed, the refresh-only retry recovered, and rename was not repeated.
The production web build, TypeScript/Svelte checks, server library tests, and
focused Git and protocol registry tests pass. A pre-existing accessibility
warning remains in `WorkingTreeFileList.svelte`.

## Worktree actions in branch and worktree menus

Right-clicking a linked-worktree branch in the sidebar or graph offers the same
actions as its entry in the Worktrees list:

- Rename the local branch.
- Remove this worktree, preserving its branch.
- Remove the worktree and delete its branch.

Removal confirms the exact directory and branch. It is unavailable for the main
worktree and the currently open worktree; switch to another worktree first.
Detached worktrees offer removal without branch actions. Menus preserve the
compact dialog style and use a wider menu for the full action labels. Branch
and worktree menu actions use the normal text color. The clicked row keeps its
hover highlight until the menu closes, matching the staging context menu.

`git.worktree.remove` requires `repository:operate` and its advertised capability.
Rust verifies that the path is a registered linked worktree of the selected
repository and that HEAD and its branch still match the review. Locked,
modified, and untracked worktrees are refused by Git; branch force never enables
`git worktree remove --force`. Ordinary Git removal semantics apply to ignored
files and submodules. A failed review does not remove a directory.

For combined removal, an unmerged branch produces a Sonner warning with
**Review deletion**, followed by the existing second explicit confirmation
before the worktree is removed. Branch deletion is checked again
after removal. A later deletion failure reports that the worktree was removed
and the branch was kept, rather than retrying directory removal. External Git
processes remain outside the server's repository locks.

On Windows, Git's recursive deletion can traverse npm directory junctions, then
leave dangling links behind and fail with `Directory not empty`. Before calling
Git removal, Rust finds directory reparse points without traversing them. If
any exist, Git must report a clean worktree and confirm every link is ignored;
only then are the links themselves detached. Their targets are untouched. A
non-ignored directory link is refused. Worktrees with both submodules and
directory links are refused before preparation, including uninitialized
gitlinks, so Git cannot fall back to traversing those links. Git repeats its
removal checks afterward.

Git can unregister a worktree even when directory deletion fails. After a
failed removal, Rust rechecks the registration and completes deletion using the platform's native
filesystem removal only if Git already unregistered the reviewed worktree. It
revalidates the exact canonical directory, rejects a replacement link or new
Git metadata, and removes junctions and symlinks without following their targets.
Bounded retries cover transient filesystem contention. Dirty and locked
worktrees still use Git's refusal; no worktree force is enabled. If cleanup
cannot finish, GitGui clears the stale catalog entry and reports the remaining
path through Sonner. Branch deletion proceeds only after filesystem cleanup
succeeds; otherwise the branch is kept.

An isolated diagnostic reproduced the exact error with Git for Windows
2.49.0 and a clean npm-style junction worktree. The preventive path removed the
same layout successfully and preserved a file reached through an external
junction target.

The server holds the source and registered target repository locks in a stable
order. Successful removal cleans matching catalog entries and caches; the
initiating client forgets their tabs, recents, and drafts without issuing a
second catalog deletion. Catalog persistence failures are reported as warnings
after successful worktree removal. Other clients revalidate through existing
repository refresh behavior.

Worktree verification covers literal paths with spaces and Unicode, keeping or
deleting the branch, locked/current/main worktrees, stale HEAD and branch
reviews, unrelated paths, detached checkouts, and branch deletion failures after
directory removal. A scoped WebSocket test verifies catalog cleanup without
requiring a second client deletion. Menu and workspace tests verify action parity,
capability guards, and forgetting removed entries. Browser checks exercise the
sidebar branch, graph badge, and worktree menus, renaming a checked-out branch,
removal cancellation, keeping the branch, combined removal of an open tab,
dirty worktree refusal, unmerged confirmation, and stale selection rejection.
