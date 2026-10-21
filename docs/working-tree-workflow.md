# Working-tree workflow

Behavior decisions were confirmed by Mathies. Implementation is complete on
`feat/working-tree-workflow`.

## Agreed behavior

- Keep existing whole-file staging and unstaging, and add selection of whole
  diff hunks in both the unstaged and staged views. Individual-line selection
  is deferred.
- Staging a hunk in an open unstaged diff keeps that file open while unstaged
  changes remain, and removes the staged hunk from the displayed diff. Staging
  its last unstaged hunk closes the file view and returns to the graph, even
  though the path remains in the staged list. Unstaging follows the same rule
  for the staged side.
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

The working-tree panel offers row, selected-file, and bulk discard. Its native
modal lists exact targets, traps focus, supports cancellation, and excludes
untracked deletion until explicitly selected. Amendment drafts are scoped by
environment and repository, with separate normal and amend messages for the
current session. Removing a repository or explicitly removing its environment
registration clears its drafts; ordinary disconnects preserve them. This
follows the current T3 checkout's `docs/internals/connection-runtime.md` and
`packages/client-runtime/src/connection/registry.ts`, inspected under
`/data/references/t3code`: registration removal clears owned drafts, whereas
transport loss retains cached data. No connectivity behavior changed.

The diff viewer displays Git-generated hunks with a checkbox and Stage/Unstage
action inline after each hunk. Controls scroll with the code in all diff
layouts, and a compact toolbar applies multiple selected hunks together. The
file-only view hides these controls; switching layouts preserves selection and
checkbox updates preserve keyboard focus. The viewer reloads working-tree
diffs on snapshot replacement even when
HEAD and file status are unchanged. Whole-file actions remain available for
unsupported hunk operations. Before the first commit, whole-file unstaging
removes only indexed entries and preserves later working-tree edits.

## Verification results

Open-file reconciliation checks the selected index/worktree side and updates
its status metadata after refresh. File contents load independently of hunk
previews, so a delayed preview cannot keep the file behind a loading overlay.
Preview completion updates parsed hunks and advances Pierre's item version so
new annotations replace the earlier content-only rendering. Late responses
remain guarded by the current file request generation.

Regression coverage includes source-aware file selection and a browser fixture
with the actual Svelte route/viewer and mocked RPC responses. The browser check
stages three hunks in sequence, including a refresh where status stays `MM`,
checks that the last hunk closes the diff, and deliberately blocks hunk previews
to verify that contents remain readable and controls appear after completion.

- `npm test`: desktop, client-runtime, SSH, and Rust workspace tests pass.
  Focused Git tests cover stage/unstage with unselected hunks, additions and
  deletions, initial repositories, stale selections, index-preserving discard,
  explicit untracked deletion, literal filenames, CRLF normalization, missing
  final newlines, symlinks, ignored files, binary fallback, staged renames,
  partial discard failures, and amend blocking and hook failure behavior.
- `npm run check`: all TypeScript and Svelte checks pass without diagnostics.
- `npm run build`: production frontend build passes.
- `cargo check --workspace` and `git diff --check` pass.
- Browser checks in isolated repositories verified hunk staging and unstaging,
  refreshed diffs, normal/amend draft preservation, draft isolation across two
  repositories, message-only and staged-content amendment, hook-error draft
  retention, discard cancellation, stale confirmation rejection, staged
  content preservation, default untracked exclusion, and explicit deletion.
- Inline-control browser checks verified single-hunk and multiple-hunk staging,
  unstaging, added/deleted files, selection across Hunks/Inline/Split and
  File/Diff switches, retained keyboard focus, and clearing selection after
  refresh. Controls use Pierre line-annotation slots and participate in the
  existing virtualized diff layout.
- Fault injection verified successful amendment followed by failed refresh:
  the UI reports the distinct outcome, clears the submitted amend draft, and
  retrying refresh does not repeat amendment. No browser runtime errors were
  observed in the final interaction checks.
- Captured screenshots and an interaction recording. The shared T3 preview
  disconnected during verification; remaining checks used an isolated
  headless Chrome session against the same development stack.

## Limits

Individual-line staging and hunk discard remain deferred. Conflicts,
submodules, renames, binary/non-UTF-8 files, symlinks, and mode changes do not
support partial operations. Whole-file discard refuses unresolved conflicts,
submodules, and unstaged renames rather than guessing their restoration.
Revision checks reject observed external changes; external editors and Git
processes do not participate in the server's mutation lock. Verification ran
on Linux; packaged Electron and Windows/macOS execution were not exercised.

## Git references

- [git restore](https://git-scm.com/docs/git-restore): working-tree restoration
  defaults to the index; restoring the index defaults to HEAD.
- [git commit](https://git-scm.com/docs/git-commit): amendment replaces the tip
  commit using the current index.
- [git apply](https://git-scm.com/docs/git-apply): patch application supports
  checking applicability and applying only to the index.
