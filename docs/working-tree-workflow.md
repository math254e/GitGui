# Working-tree workflow

Behavior decisions were confirmed by Mathies. Implementation is in progress on
`feat/working-tree-workflow`.

## Agreed behavior

- Keep existing whole-file staging and unstaging, and add selection of whole
  diff hunks in both the unstaged and staged views. Individual-line selection
  is deferred.
- Discard is available on unstaged changes and requires confirmation. For a
  partially staged file, restore the working tree to the indexed version and
  preserve staged changes. Staged changes must first be unstaged to discard
  them.
- Offer discard for one file, selected files, and all unstaged files. The
  confirmation lists affected files and states that staged changes remain.
  Hunk discard is deferred.
- Bulk discard preserves untracked files by default. An unchecked “Delete
  untracked files” option explicitly includes them, with the exact deletion
  list shown in confirmation. Never include ignored files or recursively
  clean directories.
- If files change after hunk selection or after discard confirmation opens,
  stop the action, refresh, clear stale selections, and require review of the
  updated changes.
- Hunk staging and unstaging cover ordinary text-file edits, additions, and
  deletions, including before the first commit. Binary files, renames,
  symlinks, and mode changes retain whole-file actions. Partial operations on
  conflicts and submodules are deferred, with an explanation in the UI.
- An “Amend last commit” toggle loads the previous commit message. Amendment
  uses only the index, permits message-only amendments with no staged changes,
  and leaves unstaged changes untouched. Successful amendment returns the
  form to normal commit mode.
- Amend permits detached HEAD and previously published commits, with a clear
  explanation that the current commit is replaced. Never automatically
  force-push. Disable amend when there is no commit or during a merge,
  rebase, cherry-pick, or revert. Reject submission if HEAD changed after
  loading the message.
- Keep separate normal and amend message drafts per repository for the
  current session. Toggling amend off restores the normal draft. Clear only
  the submitted draft after success.
- Validate the full discard selection before starting. If execution fails
  partway through, stop, refresh, and report which files changed and which
  remain. Do not automatically retry or roll back completed changes.
- Distinguish mutation failure from refresh failure. If the mutation succeeds
  but refreshing the UI fails, report “Changes applied; refresh failed” and
  offer a refresh retry without repeating the mutation. Retain commit drafts
  when committing fails, and show Git's error without bypassing hooks.
- Develop on `feat/working-tree-workflow` and commit focused steps as work
  progresses.

## Baseline implementation findings

- Core mutations currently support whole-file stage, unstage, and normal
  commit only.
- The diff viewer computes display hunks from file contents in the client;
  the protocol has no applicable Git patch, hunk identity, or diff revision.
- The working-tree diff request key uses HEAD, path, and status, which may all
  remain unchanged after partial staging. Refresh must invalidate the diff
  and its selected hunks.
- The commit form currently requires staged files, so message-only amendment
  needs an explicit change to its enablement rules.
- Repository mutations are serialized by the server. Rust continues to own
  Git behavior, the generated protocol carries structured data, and Svelte
  presents the workflow.

## Verification plan

- Exercise hunk stage and unstage on edits, additions, and deletions; preserve
  unselected hunks and working-tree contents. Cover repositories before their
  first commit and files with both staged and unstaged changes.
- Verify stale selections and changed confirmation targets reject without
  modifying files, and that partial staging reloads the displayed diff even
  when HEAD and file status remain unchanged.
- Verify tracked-file discard preserves the index, bulk discard excludes
  untracked files by default, explicit deletion affects only confirmed files,
  cancellation changes nothing, and partial failures report actual outcomes.
- Verify message-only and staged-content amend, normal/amend draft switching,
  repository isolation, detached HEAD, changed HEAD, and blocked repository
  states. Verify successful mutations with failed refreshes are not repeated.
- Cover supported path edge cases and explanations for unsupported partial
  operations, using isolated temporary repositories for destructive checks.
- Regenerate protocol contracts and run relevant Rust tests, workspace checks,
  frontend validation/build, and whitespace checks. Reuse an existing browser
  development session for UI verification when available; capture screenshots
  and a short recording for the new interactions.

## Design status

All behavior questions were answered and shared understanding was confirmed.
The Rust core now produces Git hunk previews and checks revisions before hunk
application or discard. New protocol methods carry hunk IDs, explicit discard
targets, and the expected amend commit. They use the existing direct
client/server boundary, authorization scopes, and repository mutation lock;
Git actions do not cross Electron IPC.

New reviewed mutations return their outcome before the client refreshes. Older
mutations annotate a subsequent server snapshot failure with
`details.mutationSucceeded` so the client can distinguish it from Git failure.

## Git references

- [git restore](https://git-scm.com/docs/git-restore): working-tree restoration
  defaults to the index; restoring the index defaults to HEAD.
- [git commit](https://git-scm.com/docs/git-commit): amendment replaces the tip
  commit using the current index.
- [git apply](https://git-scm.com/docs/git-apply): patch application supports
  checking applicability and applying only to the index.
