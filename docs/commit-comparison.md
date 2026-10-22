# Commit comparisons

The history graph offers a context-menu action to compare a commit with the
current working directory. The details panel shows the selected commit metadata
and the paths that differ; selecting a path opens its content diff.

This comparison is distinct from a commit's normal file list, which compares
the commit with its first parent. The server runs Git domain operations and
includes staged, unstaged, and untracked working-directory changes. The client
only chooses the comparison mode and renders the returned file list and diff.
Untracked files are represented as additions. Renames use Git's detected
rename path pair when available.
