# Working-tree workflow

Design interview in progress. This document records agreed behavior; remaining
questions must be settled before implementation begins.

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
- Develop on `feat/working-tree-workflow` and commit focused steps as work
  progresses.

## Current implementation findings

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

## Unsettled behavior

- Batch failure behavior, including a successful mutation followed by a
  failed snapshot refresh.
- Final shared-understanding confirmation before implementation.

## Git references

- [git restore](https://git-scm.com/docs/git-restore): working-tree restoration
  defaults to the index; restoring the index defaults to HEAD.
- [git commit](https://git-scm.com/docs/git-commit): amendment replaces the tip
  commit using the current index.
- [git apply](https://git-scm.com/docs/git-apply): patch application supports
  checking applicability and applying only to the index.
