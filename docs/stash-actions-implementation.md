# Targeted stash actions

The targeted-actions implementation owns `crates/gitgui-core/src/git/stash_actions.rs`,
`crates/gitgui-core/tests/stash_actions.rs` and this document. Core exports are
shared integration and were not changed in review round 1. Other stash modules, the
repository loader, server, protocol, generated contracts and UI belong to their
respective workers. No protocol dependency is introduced in core.

## Public API

The four functions live in `gitgui_core::git::stash_actions`:

```rust
pub fn apply_stash(root: &str, target: &StashTarget)
    -> Result<StashMutationReceipt, StashError>;
pub fn pop_stash(root: &str, target: &StashTarget)
    -> Result<StashMutationReceipt, StashError>;
pub fn drop_stash(root: &str, target: &StashTarget)
    -> Result<StashMutationReceipt, StashError>;
pub fn branch_from_stash(root: &str, target: &StashTarget, name: &str)
    -> Result<StashMutationReceipt, StashError>;
```

`StashTarget`, `StashError` and `StashLayout` come from the inspection worker's
shared `git::stash` decoder. Every action consumes its full validated layout;
corrupt/unsupported snapshots are refused even for Delete. All validation and
consuming Git commands disable replacement objects. The actions use the existing
`GitCommand` text runner and its `git_command()` primitive for binary patches,
NUL-delimited filenames and private-index comparisons.

`StashMutationReceipt` has public `outcome`, `stash_state`, `restore`, `branch`
and `error` fields. Its public domain enums map one for one to the protocol:

- `StashMutationOutcome`: `Success`, `Conflicts`, `Partial`,
  `BranchCreatedRestoreFailed`.
- `StashState`: `Retained`, `Removed`.
- `StashRestoreOutcome`: `NotAttempted`, `Succeeded`, `Conflicts`, `Failed`.
- `StashCreatedBranch { name: String, switched: bool }` is present only after
  this action successfully created its branch.
- `StashActionFailure` is a typed safe diagnostic, with
  `message(self) -> &'static str`: `RestoreConflicts`, `RestoreFailed`,
  `ConflictInspectionFailed`, `TargetChangedBeforeRemoval`, `RemovalFailed`,
  `BranchCreationFailed`, `BranchSwitchFailed`, `ContextPreparationFailed`,
  `RepositoryChanged`. Receipts contain no raw Git output.

The server later adds the captured repository ID and target and maps these
types to `GitStashMutationResult`. Pre-mutation target/layout/preflight failures
remain `Err(StashError::TargetChanged | StashError::Invalid(GitError))`.
Once a mutating Git command is attempted, the function returns a receipt on
failure; it never discards that receipt because a later operation failed.

## Restoration and deletion

Apply and Pop invoke `git stash apply --no-index <immutable W>` explicitly,
overriding `stash.index` on Git versions that support that configuration.
Apply always retains the entry. Pop removes only after successful restoration
and a fresh selector/OID/layout check. Delete passes only the reviewed exact
selector to `git stash drop`, after full layout validation and a final identity
check. No latest-entry fallback or OID search is used.

Existing unmerged entries and merge, cherry-pick, revert, rebase, sequencer or
bisect state block restoration before mutation. Delete does not alter the
index/worktree and remains usable in those states. Restoration failure is
classified as a conflict only when `git ls-files --unmerged -z` finds real
unmerged entries. Exit code 1 alone and localized stderr never establish a
conflict. Untracked collisions can leave successfully restored tracked files:
these return `Partial/Retained/Failed` and are never cleaned up automatically.

Successful restoration followed by stale-target or removal failure returns
`Partial/Retained/Succeeded`, including a created branch when applicable.
The server must preserve this result independently of refresh and must never
automatically repeat restoration.

## Branch at original HEAD

Branch names are validated as literal full `refs/heads/<name>` refs, rejecting
checkout aliases (including `@`) and option-like names. Existing refs and
ancestor/descendant ref namespace collisions are rejected before
mutation. Symbolic refs are checked separately, including dangling refs omitted
by `for-each-ref`. A dry-run two-tree `read-tree` safety check detects unsafe
checkout destinations before branch creation. A create-only
`update-ref --no-deref --stdin` transaction prepares the branch at original
**H**, then checks for a symbolic ref while Git holds the ref lock before
committing. A concurrent ordinary or symbolic ref is preserved, and no symbolic
target can be written through this operation. `git switch` uses
normal dirty-worktree/worktree-ownership checks, `--no-overwrite-ignore`, no
guessing, and no recursive submodule checkout. Creation and switch are separate
so a failed switch can report the surviving branch. Actual symbolic HEAD and
commit are checked after switch; a failing post-checkout hook does not erase
the fact that switching already happened.

For selected-unstaged snapshots, prerequisite paths come exclusively from the
literal NUL-delimited, rename-disabled tree diff **H -> P**. A private index for
each tree allows exact Git content/mode comparisons, respecting the installed
Git's filters and file-mode rules. Each selected destination's real index and
worktree must independently match H or P; unrelated contents, unmerged entries,
assume-unchanged/skip-worktree entries and unsafe parent symlinks are refused.
Before switching, a path may also match the current HEAD in both index and
worktree: a checked switch returns that clean committed path to H before any
seeding. This permits restoring from a later commit whose selected contents
differ from both H and P. Dirty paths still require the H/P checks and Git's
checkout safety checks. Preflight checks all paths before branch creation,
again against H/P after switch, and again immediately before each write.

Seeding uses Git-generated binary/full-index H -> P patches, without color,
external diff drivers or text conversion and with explicit unified context,
independent of display configuration. It applies with `--index` when both destinations
need the baseline, `--cached` when only the index needs it, and worktree-only
when only the worktree needs it. Already prepared paths are untouched. Git
performs its own patch/index safety checks; there is no forced checkout or
restore. Additions, deletions and modes are included. Completed earlier seeding
is preserved if a later path fails. After seeding, native
`git stash apply --index <W>` restores the saved payload and saved index.

Native stashes have P = H and require no seeding. For custom `H=A, I=P=B, W=A`,
the result is branch HEAD A, selected index B and worktree A, preserving the
inverse unstaged change and unrelated staging. Native `git stash branch` would
instead start at synthetic P; GitGui deliberately does not use it.

After branch creation/switch, context or restoration failure retains the
branch, completed changes and stash and returns `BranchCreatedRestoreFailed`
with `restore: Failed` or `Conflicts`. Creation failure and failure to switch
return `Partial`, with restoration `NotAttempted`; a branch is reported only
when this request created one. No force, rollback, automatic cleanup or retry
is performed.

## Integration and limits

The server must still hold its shared-common-repository mutation lock around
the complete action, including final selector validation and removal. It must
schedule refresh separately and preserve the receipt if refresh fails.

An arbitrary external Git process does not share that lock. Rechecking the
selector immediately before `git stash drop` closes observed movement, but Git
does not expose an atomic expected-OID stash reflog deletion primitive. An
external edit in the final check/drop interval, or identical delete/reinserted
selector/OID pairs, cannot be distinguished by this contract. No cross-process
atomicity or exactly-once guarantee is claimed. `Retained` means this request
did not successfully remove an entry; it cannot promise an external process
has retained that entry. Similarly, filesystem checks and Git's checked patch
writes cannot prevent an arbitrary process from changing a file or replacing
a parent directory at the last instant. They detect existing and observed
changes and avoid forceful writes; they do not provide a filesystem transaction.
Repository hooks and clean/smudge filters remain ordinary Git behavior and can
themselves change state; failures leave progress visible in the receipt.

Custom baseline context seeding currently refuses submodule/gitlink prerequisites,
file/directory transitions, non-UTF-8 paths, unsafe paths and sparse or
assume-unchanged selected entries before branch creation where detectable.
Those cases require dedicated handling rather than forced restoration. Ordinary
native actions continue to delegate native Git behavior. Valid UTF-8 spaces,
tabs, newlines, Unicode and pathspec-looking names are literal; Windows filesystem
restrictions still apply. Symlink entries are handled through Git; parent
symlink traversal is refused. Executable mode comparison follows `core.filemode`
and the host filesystem, while index modes remain explicit.

## Validation

The isolated production fixture suite covers older targets versus latest;
stale identities and external reflog movement before and during actions; success
retention/removal; actual apply/pop/branch conflicts; untracked partial restoration;
in-progress operations; original-HEAD native/custom branch restoration; all four
H/P destination combinations; unrelated staged, unstaged and untracked content;
invalid/existing branch names; unsafe dirty destinations; branch creation,
switch, context, restoration and removal failures; completed context before a
later foreign edit; external worktree ownership; replacement objects; literal
odd paths; additions, deletions, executable modes and binary content; saved
untracked replacement after baseline deletion; and a failing post-checkout
hook after a confirmed switch. A focused additional case forces colored output
and zero-context diff configuration to verify that neither corrupts the patch.

On Windows, filenames containing tabs, newlines or forbidden punctuation are
skipped explicitly; spaces and Unicode run normally. The portable cases remain
in the fixture for hosts that support those names. The tested installed Git is
`2.49.0.windows.1`; no second older Git installation was used. Symlink context
entries are handled through Git but were not exercised on this Windows host.
The shared decoder's non-UTF-8 saved-path refusal applies to all four actions.

Passed on the installed Git:

- `cargo test -p gitgui-core --test stash_actions -- --test-threads=8 --nocapture`
  completed the expanded suite with 26 passing tests.
- After adding the explicit diff-display overrides,
  `cargo test -p gitgui-core --test stash_actions diff_display_configuration_cannot_corrupt_context_patch -- --exact --nocapture`
  passed the additional regression test (26 other tests filtered out).
- `cargo check -p gitgui-core` passed after the final source change.
- `rustfmt --check --edition 2021 crates/gitgui-core/src/git/stash_actions.rs crates/gitgui-core/tests/stash_actions.rs`
  and `git diff --check` passed.

The test file now contains 27 production API fixtures. No services were started,
and no workspace commits, PRs or worktrees were created.

## Targeted review round 1

1. **Index policy (P2):** Apply/Pop now pass `--no-index`; Branch still passes
   `--index`. The current [Git stash manual](https://git-scm.com/docs/git-stash#Documentation/git-stash.txt-stashindex)
   documents that `stash.index=true` otherwise requests index restoration. The
   [current official source](https://github.com/git/git/blob/master/builtin/stash.c)
   initializes Apply/Pop from that configuration and uses a negatable boolean
   option. The [Git 2.49 source](https://github.com/git/git/blob/v2.49.0/builtin/stash.c)
   initializes the option to zero and does not read `stash.index`: omission on
   that version cannot reproduce the newer behavior. A direct isolated probe on
   installed `2.49.0.windows.1`, with saved index S/worktree W and
   `stash.index=true`, confirmed that omission and `--no-index` both leave index
   A/worktree W, whereas `--index` restores S/W. The regression fixture
   sets `stash.index=true` for production Apply/Pop and `false` for Branch and
   asserts the exact resulting index, worktree, and stash retention/removal.
   Successful execution on installed `2.49.0.windows.1` verifies compatibility
   of explicit `--no-index`; a newer Git binary was not run here.
2. **Dangling symbolic branch refs (P2):** Production rejects requested symbolic
   refs even when dangling. Creation disables dereferencing. A direct isolated
   Git 2.49 probe also established that `--no-deref` with a zero old OID alone
   can replace a dangling symref. Therefore the create-only transaction prepares
   and locks the ref, checks `symbolic-ref --quiet --no-recurse` under the lock,
   and commits only for a non-symbolic destination. EOF aborts failures and the
   child is always reaped. Fixtures cover an existing ordinary destination,
   pre-existing resolved/dangling symbolic refs, and both ordinary/dangling
   symbolic refs created by a clean filter after preflight validation. They
   assert preservation of refs, HEAD, stash, worktree and truthful failure
   receipts without a claimed created branch. This uses Git's documented
   [ref transaction and no-dereference API](https://git-scm.com/docs/git-update-ref).
3. **Clean advanced HEAD (P2):** Pre-switch context validation additionally
   accepts index/worktree paths matching current HEAD, using the same Git
   content/filter/mode comparison as the H/P checks. Normal checked checkout
   must succeed; H/P validation remains mandatory after switch and immediately
   before every seed write. The direct `H=A, P=B, W=A`, clean `HEAD=C` fixture
   now restores at H with index B/worktree A, preserving unrelated staged and
   unstaged edits. Additional cases preserve rejection of staged, unstaged,
   filter-transformed and index-mode edits at advanced HEAD; the existing dirty
   H/P and post-switch external-edit fixtures remain unchanged.

The external stash check/drop interval and arbitrary filesystem/process races
described above remain limitations. No protocol, decoder, repository loader,
server, client or UI changes are included in this response.

### Round 1 verification

Five direct regression fixtures were added, bringing the action suite to 32.
Against the original implementation, 29 passed and the clean advanced HEAD,
pre-existing dangling symbolic ref, and concurrent dangling symbolic ref
fixtures failed as reported. The index-policy fixture also passed on Git 2.49,
consistent with that version ignoring `stash.index`.

Final checks on installed `2.49.0.windows.1`:

- `cargo test -p gitgui-core --target-dir target/stash-actions-review1-20261023-sol --test stash_actions -- --test-threads=8 --nocapture`
  passed all 32 tests (346.29 seconds).
- `cargo check -p gitgui-core --target-dir target/stash-actions-review1-20261023-sol`
  passed.
- `rustfmt --check --edition 2021 crates/gitgui-core/src/git/stash_actions.rs crates/gitgui-core/tests/stash_actions.rs`
  passed.
- `git diff --check` passed; separate `git diff --no-index --check` comparisons
  against `NUL`, with `core.autocrlf=false`, also produced no whitespace
  diagnostics for all three owned untracked files.

No round-1 finding remains unresolved. A newer Git binary was not executed;
current index-configuration behavior was verified against the official source
and manual above. The final test run reused only its isolated Cargo target
directory. No services, workspace worktrees, commits or PRs were created, and
no processes were killed.
