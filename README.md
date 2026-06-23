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

The commit graph engine is intended to match Gitamine's graph behavior as closely as practical while keeping GitGui's own visual layer.

## Current Status

The current application implements the repository viewer foundation:

- Open a repository by path
- Open repositories with the native folder picker
- Restore open repositories and recent repositories
- Detect the repository root
- Show the current branch and ahead/behind counts
- Show changed files from `git status --porcelain=v2 --branch`
- Show recent commit history from `git log --all`
- View changed files and commit files with Monaco-powered file and diff views

## Planned Features

- Gitamine-aligned commit graph rendering
- Mismerge-powered conflict resolution
- Commit, checkout, merge, and rebase workflows
