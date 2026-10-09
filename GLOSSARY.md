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
Removal of unstaged changes while preserving staged changes. Tracked files
return to their indexed version; explicitly included untracked files are deleted.
_Avoid_: Reset, revert

**Untracked file**:
A working-tree file absent from the index and not excluded from GitGui's
changes list by ignore rules.

**Stale selection**:
A selection whose underlying changes no longer match what the user reviewed.

**Amend**:
Replacement of the current commit with revised contents or a revised message.
_Avoid_: Edit any commit
