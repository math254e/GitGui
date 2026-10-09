# GitGui

GitGui's repository workflow language. Architecture terminology is defined in
`AGENTS.md`.

## Language

**Working tree**:
The repository files currently available for editing, including files not yet
tracked by Git.

**Index**:
The prepared repository snapshot from which the next commit is created.
_Avoid_: Staging area in domain documentation; use “staged” in user-facing labels.

**Staged changes**:
Differences between the index and the current commit.

**Unstaged changes**:
Differences between the working tree and the index, plus untracked files shown
in GitGui's Unstaged Files list.

**Hunk**:
A contiguous group of changes and surrounding context in a file diff.

**Discard**:
Removal of unstaged changes by restoring tracked files to their indexed
version, preserving staged changes.
_Avoid_: Reset, revert

**Amend**:
Replacement of the current commit with revised contents or a revised message.
_Avoid_: Edit any commit
