//! Reviewed stash mutations. Refresh is deliberately separate from the receipt.
//! The server must serialize these with its common-repository mutation lock.
use super::{
    command::{git_command, GitCommand, GitError},
    stash::{resolve_stash, StashError, StashLayout, StashTarget},
};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::Stdio,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StashMutationOutcome {
    Success,
    Conflicts,
    Partial,
    BranchCreatedRestoreFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StashState {
    Retained,
    Removed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StashRestoreOutcome {
    NotAttempted,
    Succeeded,
    Conflicts,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StashCreatedBranch {
    pub name: String,
    pub switched: bool,
}

/// Safe operation diagnostics; no Git output or repository-controlled text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StashActionFailure {
    RestoreConflicts,
    RestoreFailed,
    ConflictInspectionFailed,
    TargetChangedBeforeRemoval,
    RemovalFailed,
    BranchCreationFailed,
    BranchSwitchFailed,
    ContextPreparationFailed,
    RepositoryChanged,
}

impl StashActionFailure {
    pub fn message(self) -> &'static str {
        match self {
            Self::RestoreConflicts => "Restoration left unresolved conflicts. The stash was retained.",
            Self::RestoreFailed => "Restoration failed and may have changed files. The stash was retained.",
            Self::ConflictInspectionFailed => "Restoration failed; conflict state could not be read. The stash was retained.",
            Self::TargetChangedBeforeRemoval => "Restoration succeeded, but the reviewed stash position changed. No entry was removed.",
            Self::RemovalFailed => "The reviewed stash could not be removed. Do not repeat restoration automatically.",
            Self::BranchCreationFailed => "Branch creation failed. The stash was retained.",
            Self::BranchSwitchFailed => "The branch was created, but switching failed. The stash was retained.",
            Self::ContextPreparationFailed => "The branch was created, but its selected index context could not be prepared. The stash was retained.",
            Self::RepositoryChanged => "The repository changed during the action. The stash was retained.",
        }
    }
}

/// Domain counterpart of GitStashMutationResult. The server adds repositoryId
/// and the captured target and maps the enums; core has no protocol dependency.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StashMutationReceipt {
    pub outcome: StashMutationOutcome,
    pub stash_state: StashState,
    pub restore: StashRestoreOutcome,
    pub branch: Option<StashCreatedBranch>,
    pub error: Option<StashActionFailure>,
}

impl StashMutationReceipt {
    fn retained() -> Self {
        Self {
            outcome: StashMutationOutcome::Partial,
            stash_state: StashState::Retained,
            restore: StashRestoreOutcome::NotAttempted,
            branch: None,
            error: None,
        }
    }

    fn fail(&mut self, failure: StashActionFailure) {
        self.outcome = StashMutationOutcome::Partial;
        self.error = Some(failure);
    }
}

fn invalid(message: &'static str) -> GitError {
    GitError {
        message: message.into(),
        stderr: String::new(),
        status: None,
    }
}

fn git(root: &str, args: &[&str]) -> Result<String, GitError> {
    let mut full = vec!["--no-replace-objects", "--literal-pathspecs"];
    full.extend_from_slice(args);
    GitCommand::run(&full, Some(Path::new(root)))
}

// Binary patches, NUL-delimited names, and private indexes need the runner's
// existing Command primitive rather than its lossy text convenience methods.
fn bytes(
    root: &str,
    args: &[&str],
    input: Option<&[u8]>,
    index: Option<&Path>,
) -> Result<Vec<u8>, GitError> {
    let mut command = git_command();
    command
        .current_dir(root)
        .args(["--no-replace-objects", "--literal-pathspecs"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let mut child = command
        .spawn()
        .map_err(|_| invalid("Could not start Git for stash action"))?;
    if let Some(input) = input {
        let result = child
            .stdin
            .take()
            .ok_or_else(|| invalid("Git input is unavailable"))?
            .write_all(input);
        if result.is_err() {
            // Always reap the process, even if it refused input early.
            drop(child.stdin.take());
            let _ = child.wait_with_output();
            return Err(invalid("Could not provide stash action input to Git"));
        }
    }
    drop(child.stdin.take());
    let output = child
        .wait_with_output()
        .map_err(|_| invalid("Could not finish Git stash action"))?;
    if !output.status.success() {
        return Err(GitError {
            status: output.status.code(),
            ..invalid("Git stash action failed")
        });
    }
    Ok(output.stdout)
}

fn has_conflicts(root: &str) -> Result<bool, GitError> {
    Ok(!bytes(root, &["ls-files", "--unmerged", "-z"], None, None)?.is_empty())
}

fn ready_for_restore(root: &str) -> Result<(), GitError> {
    if has_conflicts(root)? {
        return Err(invalid(
            "Resolve existing conflicts before restoring a stash",
        ));
    }
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
        "BISECT_START",
    ] {
        let location = git(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", marker],
        )?;
        match fs::symlink_metadata(location.trim_end()) {
            Ok(_) => {
                return Err(invalid(
                    "Finish the in-progress Git operation before restoring a stash",
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(invalid("Cannot inspect in-progress Git operation")),
        }
    }
    // The restoration commands require an existing HEAD.
    git(root, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    Ok(())
}

/// Ordinary native restoration with explicit --no-index. Retains the stash.
pub fn apply_stash(root: &str, target: &StashTarget) -> Result<StashMutationReceipt, StashError> {
    restore_stash(root, target, false)
}

/// Restore the immutable reviewed W, then revalidate before dropping its selector.
pub fn pop_stash(root: &str, target: &StashTarget) -> Result<StashMutationReceipt, StashError> {
    restore_stash(root, target, true)
}

fn restore_stash(
    root: &str,
    target: &StashTarget,
    remove: bool,
) -> Result<StashMutationReceipt, StashError> {
    let layout = resolve_stash(root, target)?;
    ready_for_restore(root)?;
    // Refuse changes already visible before starting the mutation as a target error.
    resolve_stash(root, target)?;
    let mut receipt = StashMutationReceipt::retained();
    restore(root, &layout, false, &mut receipt);
    if receipt.restore == StashRestoreOutcome::Succeeded && remove {
        remove_reviewed(root, target, &mut receipt);
    }
    Ok(receipt)
}

fn restore(root: &str, layout: &StashLayout, index: bool, receipt: &mut StashMutationReceipt) {
    let result = if index {
        git(root, &["stash", "apply", "--index", &layout.stash_oid])
    } else {
        // Newer Git honors stash.index; omission would inherit that setting.
        git(root, &["stash", "apply", "--no-index", &layout.stash_oid])
    };
    if result.is_ok() {
        receipt.restore = StashRestoreOutcome::Succeeded;
        receipt.outcome = StashMutationOutcome::Success;
        return;
    }
    // Git versions disagree on exit codes. Only real unmerged index entries
    // establish conflicts; an untracked collision is a possibly partial failure.
    match has_conflicts(root) {
        Ok(true) => {
            receipt.restore = StashRestoreOutcome::Conflicts;
            receipt.outcome = StashMutationOutcome::Conflicts;
            receipt.error = Some(StashActionFailure::RestoreConflicts);
        }
        Ok(false) => {
            receipt.restore = StashRestoreOutcome::Failed;
            receipt.fail(StashActionFailure::RestoreFailed);
        }
        Err(_) => {
            receipt.restore = StashRestoreOutcome::Failed;
            receipt.fail(StashActionFailure::ConflictInspectionFailed);
        }
    }
    if receipt.branch.as_ref().is_some_and(|b| b.switched) {
        receipt.outcome = StashMutationOutcome::BranchCreatedRestoreFailed;
    }
}

fn remove_reviewed(root: &str, target: &StashTarget, receipt: &mut StashMutationReceipt) {
    if resolve_stash(root, target).is_err() {
        receipt.fail(StashActionFailure::TargetChangedBeforeRemoval);
    } else if git(root, &["stash", "drop", &target.selector]).is_err() {
        receipt.fail(StashActionFailure::RemovalFailed);
    } else {
        receipt.stash_state = StashState::Removed;
        receipt.outcome = StashMutationOutcome::Success;
        receipt.error = None;
    }
}

/// Delete exactly the reviewed entry, with no restoration. Invalid layouts are
/// rejected even for deletion, so unsupported snapshots cannot be lost silently.
pub fn drop_stash(root: &str, target: &StashTarget) -> Result<StashMutationReceipt, StashError> {
    resolve_stash(root, target)?;
    let mut receipt = StashMutationReceipt::retained();
    // Unlike post-restore removal, this final pre-mutation check remains an Err.
    resolve_stash(root, target)?;
    if git(root, &["stash", "drop", &target.selector]).is_err() {
        receipt.fail(StashActionFailure::RemovalFailed);
    } else {
        receipt.outcome = StashMutationOutcome::Success;
        receipt.stash_state = StashState::Removed;
    }
    Ok(receipt)
}

fn validate_branch(root: &str, name: &str) -> Result<String, GitError> {
    if name.is_empty() || name.starts_with('-') || matches!(name, "HEAD" | "@") {
        return Err(invalid("Invalid branch name"));
    }
    let reference = format!("refs/heads/{name}");
    git(root, &["check-ref-format", &reference]).map_err(|_| invalid("Invalid branch name"))?;
    reject_symbolic_branch(root, &reference)?;
    let existing = git(root, &["for-each-ref", "--format=%(refname)", "refs/heads"])?;
    if existing.lines().any(|r| {
        r == reference
            || r.starts_with(&format!("{reference}/"))
            || reference.starts_with(&format!("{r}/"))
    }) {
        return Err(invalid(
            "The branch already exists or conflicts with an existing ref",
        ));
    }
    Ok(reference)
}

fn reject_symbolic_branch(root: &str, reference: &str) -> Result<(), GitError> {
    // for-each-ref omits dangling symbolic refs. Do not resolve their targets.
    match bytes(
        root,
        &["symbolic-ref", "--quiet", "--no-recurse", reference],
        None,
        None,
    ) {
        Ok(_) => Err(invalid("The branch name is an existing symbolic ref")),
        Err(e) if e.status == Some(1) => Ok(()),
        Err(e) => Err(e),
    }
}

fn create_branch(root: &str, reference: &str, oid: &str) -> Result<(), GitError> {
    let mut child = git_command()
        .current_dir(root)
        .args([
            "--no-replace-objects",
            "update-ref",
            "--no-deref",
            "-m",
            "GitGui: branch from stash",
            "--stdin",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| invalid("Could not start branch creation"))?;
    let result = (|| {
        let mut output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| invalid("Branch creation output is unavailable"))?,
        );
        child
            .stdin
            .as_mut()
            .ok_or_else(|| invalid("Branch creation input is unavailable"))?
            .write_all(format!("start\ncreate {reference} {oid}\nprepare\n").as_bytes())
            .map_err(|_| invalid("Could not prepare branch creation"))?;
        for expected in ["start: ok\n", "prepare: ok\n"] {
            let mut line = String::new();
            output
                .read_line(&mut line)
                .map_err(|_| invalid("Could not read branch creation progress"))?;
            if line != expected {
                return Err(invalid("Could not prepare branch creation"));
            }
        }
        // The prepared transaction holds the ref lock. Git's zero-old-OID
        // check alone treats a dangling symref as absent, even with no-deref.
        // Reject it under that lock before committing the direct ref creation.
        reject_symbolic_branch(root, reference)?;
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"commit\n")
            .map_err(|_| invalid("Could not commit branch creation"))?;
        let mut line = String::new();
        output
            .read_line(&mut line)
            .map_err(|_| invalid("Could not read branch creation progress"))?;
        if line != "commit: ok\n" {
            return Err(invalid("Could not commit branch creation"));
        }
        Ok(())
    })();
    // EOF aborts an uncommitted transaction and releases its locks. Always reap.
    drop(child.stdin.take());
    let status = child
        .wait()
        .map_err(|_| invalid("Could not finish branch creation"))?;
    result?;
    if !status.success() {
        return Err(invalid("Branch creation failed"));
    }
    Ok(())
}

/// Create at original H (never synthetic P), safely switch, seed selected H->P
/// context, restore --index, and only then remove the revalidated entry.
pub fn branch_from_stash(
    root: &str,
    target: &StashTarget,
    name: &str,
) -> Result<StashMutationReceipt, StashError> {
    let layout = resolve_stash(root, target)?;
    ready_for_restore(root)?;
    let reference = validate_branch(root, name)?;
    let context = Context::prepare(root, &layout)?;
    context.preflight_before_switch(root)?;
    // Git's two-tree safety check detects dirty destinations without changing
    // the index/worktree. Switch checks again, including worktree ownership.
    git(
        root,
        &[
            "read-tree",
            "--dry-run",
            "-m",
            "-u",
            "HEAD",
            &layout.original_head_oid,
        ],
    )
    .map_err(|_| invalid("Local changes prevent switching to the stash original HEAD"))?;
    resolve_stash(root, target)?;
    let mut receipt = StashMutationReceipt::retained();
    if create_branch(root, &reference, &layout.original_head_oid).is_err() {
        receipt.fail(StashActionFailure::BranchCreationFailed);
        return Ok(receipt);
    }
    receipt.branch = Some(StashCreatedBranch {
        name: name.into(),
        switched: false,
    });
    let switched = git(
        root,
        &[
            "switch",
            "--no-guess",
            "--no-overwrite-ignore",
            "--no-recurse-submodules",
            name,
        ],
    );
    // A post-checkout hook can fail after a successful switch. Observe actual
    // state rather than reporting that no switch happened based on exit status.
    let actual = git(root, &["symbolic-ref", "--quiet", "HEAD"]);
    let head = git(root, &["rev-parse", "--verify", "HEAD"]);
    let at_branch = actual.as_ref().is_ok_and(|r| r.trim_end() == reference);
    receipt.branch.as_mut().unwrap().switched = at_branch;
    if switched.is_err()
        || !at_branch
        || !head.is_ok_and(|h| h.trim_end() == layout.original_head_oid)
    {
        receipt.fail(StashActionFailure::BranchSwitchFailed);
        if at_branch {
            receipt.outcome = StashMutationOutcome::BranchCreatedRestoreFailed;
            receipt.restore = StashRestoreOutcome::Failed;
        }
        return Ok(receipt);
    }
    // Hooks and external Git may have changed the repository during switch.
    if ready_for_restore(root).is_err() {
        receipt.fail(StashActionFailure::RepositoryChanged);
        receipt.outcome = StashMutationOutcome::BranchCreatedRestoreFailed;
        receipt.restore = StashRestoreOutcome::Failed;
        return Ok(receipt);
    }
    if context.seed(root).is_err() {
        receipt.fail(StashActionFailure::ContextPreparationFailed);
        receipt.outcome = StashMutationOutcome::BranchCreatedRestoreFailed;
        receipt.restore = StashRestoreOutcome::Failed;
        return Ok(receipt);
    }
    restore(root, &layout, true, &mut receipt);
    if receipt.restore == StashRestoreOutcome::Succeeded {
        remove_reviewed(root, target, &mut receipt);
    }
    Ok(receipt)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    mode: String,
    oid: String,
}

struct Prerequisite {
    path: String,
    original: Option<Entry>,
    baseline: Option<Entry>,
    patch: Vec<u8>,
}

struct Context {
    directory: tempfile::TempDir,
    original_index: std::path::PathBuf,
    baseline_index: std::path::PathBuf,
    paths: Vec<Prerequisite>,
}

fn text(bytes: &[u8]) -> Result<&str, GitError> {
    std::str::from_utf8(bytes).map_err(|_| invalid("Stash context paths must be valid UTF-8"))
}

fn tree_entry(root: &str, tree: &str, path: &str) -> Result<Option<Entry>, GitError> {
    let output = bytes(root, &["ls-tree", "-z", tree, "--", path], None, None)?;
    if output.is_empty() {
        return Ok(None);
    }
    let records = output
        .split(|b| *b == 0)
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    if records.len() != 1 {
        return Err(invalid("Unsupported stash context tree entry"));
    }
    let record = text(records[0])?;
    let (header, found) = record
        .split_once('\t')
        .ok_or_else(|| invalid("Invalid stash context tree entry"))?;
    let fields = header.split_whitespace().collect::<Vec<_>>();
    if found != path
        || fields.len() != 3
        || fields[1] != "blob"
        || !matches!(fields[0], "100644" | "100755" | "120000")
    {
        return Err(invalid("Stash context requires ordinary files or symlinks"));
    }
    Ok(Some(Entry {
        mode: fields[0].into(),
        oid: fields[2].into(),
    }))
}

fn safe_context_path(root: &str, path: &str) -> Result<(), GitError> {
    // Tabs/newlines and pathspec-looking names are literal, valid filenames.
    if path.is_empty()
        || path.contains('\0')
        || (cfg!(windows) && (path.contains('\\') || path.contains(':')))
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
    {
        return Err(invalid("Unsafe stash context path"));
    }
    let mut full = Path::new(root).to_path_buf();
    let parts = path.split('/').collect::<Vec<_>>();
    for part in &parts[..parts.len() - 1] {
        full.push(part);
        match fs::symlink_metadata(&full) {
            Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
                return Err(invalid("Stash context crosses a symlink or non-directory"))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(invalid("Cannot inspect stash context path")),
        }
    }
    Ok(())
}

fn current_entry(root: &str, path: &str) -> Result<Option<Entry>, GitError> {
    let output = bytes(root, &["ls-files", "--stage", "-z", "--", path], None, None)?;
    if output.is_empty() {
        return Ok(None);
    }
    let records = output
        .split(|b| *b == 0)
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    if records.len() != 1 {
        return Err(invalid("Ambiguous or unmerged stash context index entry"));
    }
    let (header, found) = text(records[0])?
        .split_once('\t')
        .ok_or_else(|| invalid("Invalid stash context index entry"))?;
    let fields = header.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 3 || fields[2] != "0" || found != path {
        return Err(invalid("Invalid stash context index entry"));
    }
    let flags = bytes(root, &["ls-files", "-v", "-z", "--", path], None, None)?;
    if flags.first() != Some(&b'H') {
        return Err(invalid(
            "Sparse or assume-unchanged stash context is unsupported",
        ));
    }
    Ok(Some(Entry {
        mode: fields[0].into(),
        oid: fields[1].into(),
    }))
}

impl Context {
    fn prepare(root: &str, layout: &StashLayout) -> Result<Self, GitError> {
        let directory = tempfile::tempdir()
            .map_err(|_| invalid("Cannot prepare private stash context indexes"))?;
        let mut context = Self {
            original_index: directory.path().join("original-index"),
            baseline_index: directory.path().join("baseline-index"),
            directory,
            paths: Vec::new(),
        };
        if layout.original_head_oid == layout.baseline_oid {
            return Ok(context);
        }
        let names = bytes(
            root,
            &[
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "-r",
                "-z",
                "--no-renames",
                &layout.original_head_oid,
                &layout.baseline_oid,
                "--",
            ],
            None,
            None,
        )?;
        for raw in names.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            let path = text(raw)?.to_string();
            safe_context_path(root, &path)?;
            let original = tree_entry(root, &layout.original_head_oid, &path)?;
            let baseline = tree_entry(root, &layout.baseline_oid, &path)?;
            let patch = bytes(
                root,
                &[
                    "diff",
                    "--binary",
                    "--full-index",
                    "--no-color",
                    "--unified=3",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-renames",
                    "--src-prefix=a/",
                    "--dst-prefix=b/",
                    &layout.original_head_oid,
                    &layout.baseline_oid,
                    "--",
                    &path,
                ],
                None,
                None,
            )?;
            context.paths.push(Prerequisite {
                path,
                original,
                baseline,
                patch,
            });
        }
        if !context.paths.is_empty() {
            bytes(
                root,
                &["read-tree", &layout.original_head_oid],
                None,
                Some(&context.original_index),
            )?;
            bytes(
                root,
                &["read-tree", &layout.baseline_oid],
                None,
                Some(&context.baseline_index),
            )?;
        }
        Ok(context)
    }

    fn worktree_matches(
        root: &str,
        path: &str,
        entry: &Option<Entry>,
        index: &Path,
    ) -> Result<bool, GitError> {
        if entry.is_none() {
            return match fs::symlink_metadata(Path::new(root).join(path)) {
                Ok(_) => Ok(false),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
                Err(_) => Err(invalid("Cannot inspect stash context destination")),
            };
        }
        match bytes(
            root,
            &[
                "diff",
                "--quiet",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=none",
                "--",
                path,
            ],
            None,
            Some(index),
        ) {
            Ok(_) => Ok(true),
            Err(e) if e.status == Some(1) => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn state(&self, root: &str, path: &Prerequisite) -> Result<(bool, bool), GitError> {
        safe_context_path(root, &path.path)?;
        let index = current_entry(root, &path.path)?;
        if index != path.original && index != path.baseline {
            return Err(invalid("Selected index context has unrelated edits"));
        }
        let worktree_baseline =
            Self::worktree_matches(root, &path.path, &path.baseline, &self.baseline_index)?;
        if !worktree_baseline
            && !Self::worktree_matches(root, &path.path, &path.original, &self.original_index)?
        {
            return Err(invalid("Selected worktree context has unrelated edits"));
        }
        Ok((index == path.baseline, worktree_baseline))
    }

    fn preflight(&self, root: &str) -> Result<(), GitError> {
        for path in &self.paths {
            self.state(root, path)?;
        }
        Ok(())
    }

    fn preflight_before_switch(&self, root: &str) -> Result<(), GitError> {
        if self.paths.is_empty() {
            return Ok(());
        }
        let head = git(root, &["rev-parse", "--verify", "HEAD^{commit}"])?;
        let head = head.trim_end();
        let head_index = self.directory.path().join("head-index");
        bytes(root, &["read-tree", head], None, Some(&head_index))?;
        for path in &self.paths {
            safe_context_path(root, &path.path)?;
            let entry = tree_entry(root, head, &path.path)?;
            // Clean committed changes are replaced by the checked switch to H.
            // Dirty paths still require the original H/P checks. After switch,
            // seed() revalidates every destination against H/P before writing.
            if current_entry(root, &path.path)? == entry
                && Self::worktree_matches(root, &path.path, &entry, &head_index)?
            {
                continue;
            }
            self.state(root, path)?;
        }
        Ok(())
    }

    fn seed(&self, root: &str) -> Result<(), GitError> {
        // Check all paths again after switching, and each path immediately
        // before applying it. Git applies context-checked patches, never force
        // checkout/restore. Successful earlier writes remain on later failure.
        self.preflight(root)?;
        for path in &self.paths {
            let (index_ready, worktree_ready) = self.state(root, path)?;
            let mut args = vec!["apply", "--binary", "--whitespace=nowarn"];
            match (index_ready, worktree_ready) {
                (true, true) => continue,
                (false, false) => args.push("--index"),
                (false, true) => args.push("--cached"),
                (true, false) => {}
            }
            bytes(root, &args, Some(&path.patch), None)?;
            if self.state(root, path)? != (true, true) {
                return Err(invalid("Stash context changed during preparation"));
            }
        }
        Ok(())
    }
}
