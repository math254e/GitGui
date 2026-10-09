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
- An “Amend last commit” toggle loads the previous commit message. Amendment
  uses only the index, permits message-only amendments with no staged changes,
  and leaves unstaged changes untouched. Successful amendment returns the
  form to normal commit mode.
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

- Discard actions for one file, selected files, or all unstaged files; whether
  selected-hunk discard is included.
- Untracked-file deletion and its confirmation.
- Hunk actions when the displayed diff is stale or a file is unsupported.
- Amendment of published commits, detached HEAD, and repositories with an
  ongoing merge or rebase.
- Commit draft preservation when toggling amend or changing repositories.
- Failure behavior and verification coverage.

## Git references

- [git restore](https://git-scm.com/docs/git-restore): working-tree restoration
  defaults to the index; restoring the index defaults to HEAD.
- [git commit](https://git-scm.com/docs/git-commit): amendment replaces the tip
  commit using the current index.
- [git apply](https://git-scm.com/docs/git-apply): patch application supports
  checking applicability and applying only to the index.
