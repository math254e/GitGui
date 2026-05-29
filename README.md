# GitGui

GitGui is a modern Git desktop GUI inspired by tools like GitKraken, built as a visual interface over the installed Git executable.

## Technology Stack

- Tauri for the desktop shell
- SvelteKit and TypeScript for the UI
- Rust for repository logic and Git command execution
- System Git CLI for all Git behavior

## Architecture

```text
SvelteKit UI
  -> Tauri commands
  -> Rust repository services
  -> Git CLI
```

Rust owns repository detection, command execution, parsing, state shaping, commit loading, and future graph algorithms. The frontend renders structured data returned by Rust and never shells out to Git directly.

## Current Status

Phase 1 is implemented as a minimal repository viewer:

- Open a repository by path
- Detect the repository root
- Show the current branch and ahead/behind counts
- Show changed files from `git status --porcelain=v2 --branch`
- Show recent commit history from `git log --all`

## Planned Features

- Native folder picker
- Commit graph rendering
- Monaco-powered file and diff views
- Mismerge-powered conflict resolution
- Commit, checkout, merge, and rebase workflows
