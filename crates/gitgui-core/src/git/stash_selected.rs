//! Selected-side snapshots. Trees are built using private indexes; publication
//! precedes cleanup, and a cleanup failure never removes the saved entry.
use super::{
    command::{git_command, GitError},
    repository::StashInfo,
    stash::STASH_ENCODING_HEADER,
};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    ops::Range,
    path::{Path, PathBuf},
    process::Stdio,
};
use tempfile::TempDir;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StashSelectionSource {
    Staged,
    Unstaged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StashPushSelectedOutcome {
    Success,
    NoChanges,
    Partial,
}

#[derive(Clone, Debug)]
pub struct StashPushSelectedResult {
    pub outcome: StashPushSelectedOutcome,
    pub stash: Option<StashInfo>,
    /// A bounded operation diagnostic, never Git stderr or user-controlled text.
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    mode: String,
    oid: String,
}
type Entries = BTreeMap<Vec<u8>, Entry>;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Content {
    Missing,
    File(Vec<u8>, bool),
    #[cfg_attr(windows, allow(dead_code))]
    Symlink(PathBuf),
}

struct Selected {
    path: String,
    head: Option<Entry>,
    index: Option<Entry>,
    work: Option<Entry>,
    captured: Content,
}

fn invalid(message: &str) -> GitError {
    GitError {
        message: message.into(),
        stderr: String::new(),
        status: None,
    }
}

// This is a binary/private-index adapter around the existing installed-Git
// primitive, not a second executable discovery or global environment policy.
fn git(
    root: &Path,
    index: Option<&Path>,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<Vec<u8>, GitError> {
    let mut command = git_command();
    command
        .current_dir(root)
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["-c", "core.splitIndex=false"])
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let mut child = command
        .spawn()
        .map_err(|_| invalid("Could not start Git for selected stash"))?;
    let written = if let Some(input) = input {
        child
            .stdin
            .take()
            .ok_or_else(|| invalid("Git input unavailable"))?
            .write_all(input)
    } else {
        Ok(())
    };
    let output = child
        .wait_with_output()
        .map_err(|_| invalid("Could not finish selected stash Git operation"))?;
    if !output.status.success() || written.is_err() {
        return Err(invalid(
            "Git could not complete the selected stash operation",
        ));
    }
    Ok(output.stdout)
}

fn text(
    root: &Path,
    index: Option<&Path>,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<String, GitError> {
    String::from_utf8(git(root, index, args, input)?)
        .map(|s| s.strip_suffix('\n').unwrap_or(&s).to_owned())
        .map_err(|_| invalid("Git returned invalid object metadata"))
}

fn validate_path(root: &Path, path: &str) -> Result<(), GitError> {
    if path.is_empty()
        || path.contains('\0')
        || path.starts_with('/')
        || (cfg!(windows) && path.contains('\\'))
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
        || Path::new(path).is_absolute()
    {
        return Err(invalid(
            "Selected paths must be literal repository-relative files",
        ));
    }
    #[cfg(windows)]
    if path
        .chars()
        .any(|c| c < ' ' || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        || path.split('/').any(|p| {
            let stem = p.split('.').next().unwrap_or_default().to_ascii_uppercase();
            p.ends_with(['.', ' '])
                || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || stem
                    .strip_prefix("COM")
                    .or_else(|| stem.strip_prefix("LPT"))
                    .is_some_and(|n| {
                        matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                    })
        })
    {
        return Err(invalid("Selected path is unsafe on this platform"));
    }
    let mut parent = root.to_path_buf();
    let parts = path.split('/').collect::<Vec<_>>();
    for part in &parts[..parts.len() - 1] {
        parent.push(part);
        match fs::symlink_metadata(&parent) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() && !is_reparse(&meta) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err(invalid("Selected path has an unsafe ancestor")),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_reparse(_: &fs::Metadata) -> bool {
    false
}

fn capture(root: &Path, path: &str) -> Result<Content, GitError> {
    validate_path(root, path)?;
    let full = root.join(path);
    let meta = match fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Content::Missing),
        Err(_) => return Err(invalid("Selected file cannot be read")),
    };
    if meta.file_type().is_symlink() {
        #[cfg(windows)]
        return Err(invalid(
            "Selected symbolic links are unsupported on Windows",
        ));
        #[cfg(not(windows))]
        return fs::read_link(full)
            .map(Content::Symlink)
            .map_err(|_| invalid("Selected link cannot be read"));
    }
    if !meta.is_file() || is_reparse(&meta) {
        return Err(invalid(
            "Selection must contain ordinary files or supported final symbolic links",
        ));
    }
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    } // FILE_FLAG_OPEN_REPARSE_POINT
    let mut file = options
        .open(full)
        .map_err(|_| invalid("Selected file cannot be opened safely"))?;
    let opened = file
        .metadata()
        .map_err(|_| invalid("Selected file metadata unavailable"))?;
    if !opened.is_file() || is_reparse(&opened) {
        return Err(invalid("Selected file type changed while reading"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != meta.dev() || opened.ino() != meta.ino() {
            return Err(invalid("Selected file changed while opening"));
        }
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| invalid("Selected file cannot be read"))?;
    let after = file
        .metadata()
        .map_err(|_| invalid("Selected file metadata unavailable"))?;
    if opened.len() != after.len() || opened.modified().ok() != after.modified().ok() {
        return Err(invalid("Selected file changed while reading"));
    }
    Ok(Content::File(bytes, executable))
}

fn content_entry(
    root: &Path,
    path: &str,
    content: &Content,
    old: Option<&Entry>,
    filemode: bool,
) -> Result<Option<Entry>, GitError> {
    let (mode, bytes) = match content {
        Content::Missing => return Ok(None),
        Content::File(bytes, executable) => {
            let mode = if filemode {
                if *executable {
                    "100755"
                } else {
                    "100644"
                }
            } else {
                old.map(|e| e.mode.as_str())
                    .filter(|m| *m != "120000")
                    .unwrap_or("100644")
            };
            (mode, bytes.clone())
        }
        Content::Symlink(target) => {
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                ("120000", target.as_os_str().as_bytes().to_vec())
            }
            #[cfg(not(unix))]
            {
                let _ = target;
                return Err(invalid(
                    "Symbolic link capture is unsupported on this platform",
                ));
            }
        }
    };
    let args = if mode == "120000" {
        vec!["hash-object", "-w", "--stdin"]
    } else {
        vec!["hash-object", "-w", "--path", path, "--stdin"]
    };
    Ok(Some(Entry {
        mode: mode.into(),
        oid: text(root, None, &args, Some(&bytes))?,
    }))
}

fn parse_entries(bytes: &[u8], index: bool) -> Result<Entries, GitError> {
    let mut entries = Entries::new();
    for record in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let tab = record
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| invalid("Invalid Git entry"))?;
        let fields = std::str::from_utf8(&record[..tab])
            .map_err(|_| invalid("Invalid Git entry"))?
            .split(' ')
            .collect::<Vec<_>>();
        if fields.len() != 3 || (index && fields[2] != "0") {
            return Err(invalid("Unmerged indexes cannot be stashed by selection"));
        }
        let oid = if index { fields[1] } else { fields[2] };
        entries.insert(
            record[tab + 1..].to_vec(),
            Entry {
                mode: fields[0].into(),
                oid: oid.into(),
            },
        );
    }
    Ok(entries)
}

fn set_entry(
    root: &Path,
    index: &Path,
    path: &str,
    entry: Option<&Entry>,
    oid_len: usize,
) -> Result<(), GitError> {
    let mut record = if let Some(entry) = entry {
        format!("{} {}\t", entry.mode, entry.oid)
    } else {
        format!("0 {}\t", "0".repeat(oid_len))
    }
    .into_bytes();
    record.extend_from_slice(path.as_bytes());
    record.push(0);
    git(
        root,
        Some(index),
        &["update-index", "--add", "--remove", "-z", "--index-info"],
        Some(&record),
    )?;
    Ok(())
}

fn tree(root: &Path, index: &Path) -> Result<String, GitError> {
    text(root, Some(index), &["write-tree"], None)
}

fn commit(
    root: &Path,
    tree: &str,
    parents: &[&str],
    header: bool,
    message: &str,
    author: &str,
    committer: &str,
) -> Result<String, GitError> {
    let mut raw = format!("tree {tree}\n");
    for parent in parents {
        raw.push_str(&format!("parent {parent}\n"));
    }
    raw.push_str(&format!("author {author}\ncommitter {committer}\n"));
    if header {
        raw.push_str(STASH_ENCODING_HEADER);
        raw.push('\n');
    }
    raw.push('\n');
    raw.push_str(message);
    raw.push('\n');
    text(
        root,
        None,
        &["hash-object", "-w", "-t", "commit", "--stdin"],
        Some(raw.as_bytes()),
    )
}

struct IndexLock {
    path: PathBuf,
    file: Option<File>,
    owned: bool,
}
impl IndexLock {
    fn acquire(index: &Path) -> Result<Self, GitError> {
        let mut path = index.as_os_str().to_owned();
        path.push(".lock");
        let path = PathBuf::from(path);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| invalid("Repository index is locked or unavailable"))?;
        Ok(Self {
            path,
            file: Some(file),
            owned: true,
        })
    }
    fn publish(&mut self, index: &Path, bytes: &[u8]) -> Result<(), GitError> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| invalid("Index lock unavailable"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| invalid("Could not save cleaned index"))?;
        drop(self.file.take());
        fs::rename(&self.path, index).map_err(|_| invalid("Could not publish cleaned index"))?;
        self.owned = false;
        Ok(())
    }
}
impl Drop for IndexLock {
    fn drop(&mut self) {
        drop(self.file.take());
        if self.owned {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Save only the explicit selected side. Invalid/unsupported requests fail before
/// publication; after publication failures are receipts retaining the saved OID.
/// The server must serialize this operation with its other repository mutations.
pub fn stash_push_selected(
    root: &str,
    source: StashSelectionSource,
    paths: &[String],
    message: Option<&str>,
) -> Result<StashPushSelectedResult, GitError> {
    stash_push_selected_inner(root, source, paths, message, || {})
}

fn stash_push_selected_inner(
    root: &str,
    source: StashSelectionSource,
    paths: &[String],
    message: Option<&str>,
    after_publish: impl FnOnce(),
) -> Result<StashPushSelectedResult, GitError> {
    if paths.is_empty() {
        return Err(invalid(
            "Selected stash requires at least one explicit file",
        ));
    }
    if message.is_some_and(|m| m.contains('\0')) {
        return Err(invalid("Stash message contains a NUL byte"));
    }
    let root = fs::canonicalize(root).map_err(|_| invalid("Repository root is unavailable"))?;
    let actual_root = text(&root, None, &["rev-parse", "--show-toplevel"], None)?;
    if fs::canonicalize(actual_root).ok().as_ref() != Some(&root) {
        return Err(invalid("Selected stash requires the worktree root"));
    }
    let ignorecase = text(&root, None, &["config", "--bool", "core.ignorecase"], None)
        .ok()
        .as_deref()
        == Some("true");
    let mut unique = HashSet::new();
    for path in paths {
        validate_path(&root, path)?;
        let identity = if ignorecase {
            path.to_lowercase()
        } else {
            path.clone()
        };
        if !unique.insert(identity) {
            return Err(invalid("Selected paths must be unique"));
        }
    }
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
    ] {
        let location = text(
            &root,
            None,
            &["rev-parse", "--path-format=absolute", "--git-path", marker],
            None,
        )?;
        if Path::new(&location).exists() {
            return Err(invalid(
                "Finish the in-progress Git operation before selected stashing",
            ));
        }
    }
    let head = text(
        &root,
        None,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        None,
    )?;
    let index_path = PathBuf::from(text(
        &root,
        None,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        None,
    )?);
    let mut lock = IndexLock::acquire(&index_path)?;
    let original_index =
        fs::read(&index_path).map_err(|_| invalid("Repository index is unavailable"))?;
    let indexed = parse_entries(
        &git(&root, None, &["ls-files", "--stage", "-z"], None)?,
        true,
    )?;
    let headed = parse_entries(
        &git(&root, None, &["ls-tree", "-r", "-z", &head], None)?,
        false,
    )?;
    let filemode = text(&root, None, &["config", "--bool", "core.filemode"], None)
        .unwrap_or_else(|_| "false".into())
        == "true";
    // Sparse and intent-to-add entries have semantics not represented by just a
    // stage-zero blob. Refuse them rather than materializing or dropping them.
    let flags = git(&root, None, &["ls-files", "-v", "-z"], None)?;
    for record in flags.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        if record[0] != b'H' {
            return Err(invalid(
                "Selected stashing does not support sparse or assume-unchanged indexes",
            ));
        }
    }
    let raw_index_diff = git(
        &root,
        None,
        &[
            "diff",
            "--raw",
            "--no-abbrev",
            "--no-renames",
            "--ita-visible-in-index",
            "--cached",
            "-z",
            &head,
        ],
        None,
    )?;
    // An intent-to-add blob is omitted by write-tree; reject using Git's explicit
    // visible/invisible distinction, including an empty-file intent-to-add.
    let hidden_ita = git(
        &root,
        None,
        &[
            "diff",
            "--raw",
            "--no-abbrev",
            "--no-renames",
            "--ita-invisible-in-index",
            "--cached",
            "-z",
            &head,
        ],
        None,
    )?;
    if raw_index_diff != hidden_ita {
        return Err(invalid(
            "Selected stashing does not support intent-to-add entries",
        ));
    }
    let mut selected = Vec::new();
    for path in paths {
        for (name, entry) in headed.iter().chain(indexed.iter()) {
            if entry.mode == "160000"
                && path.as_bytes().starts_with(name)
                && path.as_bytes().get(name.len()) == Some(&b'/')
            {
                return Err(invalid(
                    "Paths inside selected submodules cannot be stashed",
                ));
            }
        }
        let head_entry = headed.get(path.as_bytes()).cloned();
        let index_entry = indexed.get(path.as_bytes()).cloned();
        if headed
            .keys()
            .chain(indexed.keys())
            .any(|p| p.starts_with(path.as_bytes()) && p.get(path.len()) == Some(&b'/'))
        {
            return Err(invalid("Selected paths must name files, not directories"));
        }
        if head_entry
            .iter()
            .chain(index_entry.iter())
            .any(|e| !matches!(e.mode.as_str(), "100644" | "100755" | "120000"))
        {
            return Err(invalid(
                "Selected submodules or unsupported file modes cannot be stashed",
            ));
        }
        #[cfg(windows)]
        if head_entry
            .iter()
            .chain(index_entry.iter())
            .any(|e| e.mode == "120000")
        {
            return Err(invalid(
                "Selected symbolic links are unsupported on Windows",
            ));
        }
        let captured = capture(&root, path)?;
        // Case-folding aliases on Windows/macOS can name a different logical
        // Git entry. Refuse an alias instead of saving it as a second file.
        if ignorecase
            && index_entry.is_none()
            && captured != Content::Missing
            && indexed
                .keys()
                .any(|p| p.eq_ignore_ascii_case(path.as_bytes()))
        {
            return Err(invalid(
                "Selected path spelling does not match the Git index",
            ));
        }
        if index_entry.is_none() && captured != Content::Missing {
            let untracked = git(
                &root,
                None,
                &["ls-files", "--others", "-z", "--", path],
                None,
            )?;
            if !untracked.split(|b| *b == 0).any(|p| p == path.as_bytes()) {
                return Err(invalid(
                    "Selected untracked path spelling does not match the worktree",
                ));
            }
        }
        selected.push(Selected {
            path: path.clone(),
            head: head_entry,
            index: index_entry,
            work: None,
            captured,
        });
    }
    // All explicit inputs have been validated before writing any Git objects.
    for s in &mut selected {
        s.work = content_entry(&root, &s.path, &s.captured, s.index.as_ref(), filemode)?;
    }
    let changed = selected.iter().any(|s| match source {
        StashSelectionSource::Staged => s.head != s.index,
        StashSelectionSource::Unstaged => s.index != s.work,
    });
    if !changed {
        return Ok(StashPushSelectedResult {
            outcome: StashPushSelectedOutcome::NoChanges,
            stash: None,
            error: None,
        });
    }
    let temp = TempDir::new().map_err(|_| invalid("Could not allocate a private stash index"))?;
    let snapshot = temp.path().join("snapshot");
    git(&root, Some(&snapshot), &["read-tree", &head], None)?;
    for s in &selected {
        set_entry(&root, &snapshot, &s.path, s.index.as_ref(), head.len())?;
    }
    let baseline_tree = tree(&root, &snapshot)?;
    let author = text(&root, None, &["var", "GIT_AUTHOR_IDENT"], None)?;
    let committer = text(&root, None, &["var", "GIT_COMMITTER_IDENT"], None)?;
    let baseline = if source == StashSelectionSource::Unstaged {
        commit(
            &root,
            &baseline_tree,
            &[&head],
            false,
            "GitGui selected index baseline",
            &author,
            &committer,
        )?
    } else {
        head.clone()
    };
    let index_commit = commit(
        &root,
        &baseline_tree,
        &[&baseline],
        false,
        "GitGui selected index",
        &author,
        &committer,
    )?;
    let mut untracked = None;
    if source == StashSelectionSource::Unstaged {
        for s in &selected {
            if s.index.is_some() {
                set_entry(&root, &snapshot, &s.path, s.work.as_ref(), head.len())?;
            }
        }
        let untracked_index = temp.path().join("untracked");
        git(
            &root,
            Some(&untracked_index),
            &["read-tree", "--empty"],
            None,
        )?;
        for s in &selected {
            if s.index.is_none() && s.work.is_some() {
                set_entry(
                    &root,
                    &untracked_index,
                    &s.path,
                    s.work.as_ref(),
                    head.len(),
                )?;
            }
        }
        if selected
            .iter()
            .any(|s| s.index.is_none() && s.work.is_some())
        {
            untracked = Some(commit(
                &root,
                &tree(&root, &untracked_index)?,
                &[],
                false,
                "GitGui selected untracked",
                &author,
                &committer,
            )?);
        }
    }
    let saved_tree = tree(&root, &snapshot)?;
    let mut parents = vec![baseline.as_str(), index_commit.as_str()];
    if let Some(u) = untracked.as_deref() {
        parents.push(u);
    }
    let branch = text(
        &root,
        None,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        None,
    )
    .ok();
    let description = message.unwrap_or("Selected changes");
    let subject = format!(
        "On {}: {description}",
        branch.as_deref().unwrap_or("(no branch)")
    );
    let saved = commit(
        &root,
        &saved_tree,
        &parents,
        source == StashSelectionSource::Unstaged,
        &subject,
        &author,
        &committer,
    )?;
    // The shared decoder is the single authority for accepting our wire layout.
    super::stash::decode_stash(
        root.to_str()
            .ok_or_else(|| invalid("Repository root is not UTF-8"))?,
        &saved,
    )
    .map_err(|_| invalid("Constructed selected stash failed layout validation"))?;
    check_state(&root, &head, &index_path, &original_index, &selected)?;
    git(
        &root,
        None,
        &["stash", "store", "-m", &subject, &saved],
        None,
    )?;
    let timestamp = committer
        .rsplit(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut info = StashInfo {
        hash: saved,
        selector: "stash@{0}".into(),
        base_hash: head.clone(),
        index_hash: Some(index_commit),
        branch,
        message: description.into(),
        timestamp,
    };
    after_publish();
    let cleanup = (|| {
        // External stash movement cannot authorize cleanup or change the OID in
        // the receipt. Resolve the published entry's current selector separately.
        let listing = text(&root, None, &["stash", "list", "--format=%H %gd"], None)?;
        info.selector = listing
            .lines()
            .find_map(|line| {
                line.split_once(' ')
                    .filter(|(oid, _)| *oid == info.hash)
                    .map(|(_, selector)| selector.to_owned())
            })
            .ok_or_else(|| invalid("Saved stash entry changed before cleanup"))?;
        check_state(&root, &head, &index_path, &original_index, &selected)?;
        let desired = if source == StashSelectionSource::Staged {
            staged_cleanup(&root, &selected)?
        } else {
            selected
                .iter()
                .map(|s| {
                    Ok((
                        s.path.clone(),
                        materialize(&root, &s.path, s.index.as_ref())?,
                    ))
                })
                .collect::<Result<Vec<_>, GitError>>()?
        };
        check_state(&root, &head, &index_path, &original_index, &selected)?;
        for (path, content) in &desired {
            let s = selected.iter().find(|s| &s.path == path).unwrap();
            if s.captured != *content {
                replace_checked(&root, path, &s.captured, content)?;
            }
        }
        if source == StashSelectionSource::Staged {
            let cleaned = temp.path().join("cleaned-index");
            fs::write(&cleaned, &original_index)
                .map_err(|_| invalid("Could not prepare cleaned index"))?;
            for s in &selected {
                if s.head != s.index {
                    set_entry(&root, &cleaned, &s.path, s.head.as_ref(), head.len())?;
                }
            }
            if fs::read(&index_path).ok().as_ref() != Some(&original_index)
                || text(&root, None, &["rev-parse", "HEAD"], None)? != head
            {
                return Err(invalid("Repository changed during selected cleanup"));
            }
            lock.publish(
                &index_path,
                &fs::read(cleaned).map_err(|_| invalid("Could not read cleaned index"))?,
            )?;
        }
        Ok(())
    })();
    Ok(StashPushSelectedResult {
        outcome: if cleanup.is_ok() {
            StashPushSelectedOutcome::Success
        } else {
            StashPushSelectedOutcome::Partial
        },
        stash: Some(info),
        error: cleanup.err().map(|e| e.message),
    })
}

fn check_state(
    root: &Path,
    head: &str,
    index: &Path,
    original: &[u8],
    selected: &[Selected],
) -> Result<(), GitError> {
    if text(root, None, &["rev-parse", "HEAD"], None)? != head
        || fs::read(index).ok().as_deref() != Some(original)
    {
        return Err(invalid("Repository changed while saving selected changes"));
    }
    for s in selected {
        if capture(root, &s.path)? != s.captured {
            return Err(invalid(
                "Selected file changed while saving selected changes",
            ));
        }
    }
    Ok(())
}

fn materialize(root: &Path, path: &str, entry: Option<&Entry>) -> Result<Content, GitError> {
    let Some(entry) = entry else {
        return Ok(Content::Missing);
    };
    if entry.mode == "120000" {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            return Ok(Content::Symlink(
                std::ffi::OsString::from_vec(git(
                    root,
                    None,
                    &["cat-file", "blob", &entry.oid],
                    None,
                )?)
                .into(),
            ));
        }
        #[cfg(not(unix))]
        return Err(invalid(
            "Symbolic link restoration is unsupported on this platform",
        ));
    }
    Ok(Content::File(
        git(
            root,
            None,
            &[
                "cat-file",
                "--filters",
                &format!("--path={path}"),
                &entry.oid,
            ],
            None,
        )?,
        entry.mode == "100755",
    ))
}

fn staged_cleanup(root: &Path, selected: &[Selected]) -> Result<Vec<(String, Content)>, GitError> {
    // Prepare EVERY selected path before the caller changes any live file.
    // In particular, never reverse a contextual patch against WT: Git can
    // relocate its hunks to repeated text and silently erase unstaged edits.
    let mut desired = Vec::new();
    for s in selected.iter().filter(|s| s.head != s.index) {
        if s.index == s.work {
            desired.push((s.path.clone(), materialize(root, &s.path, s.head.as_ref())?));
            continue;
        }
        if (s.head.is_none() && s.index != s.work) || (s.index.is_none() && s.work.is_some()) {
            return Err(invalid(
                "Stash saved; staged cleanup overlaps unstaged addition or deletion changes",
            ));
        }
        let (Some(head), Some(index), Some(work)) = (&s.head, &s.index, &s.work) else {
            return Err(cleanup_overlap());
        };
        let staged_mode = head.mode != index.mode;
        let unstaged_mode = index.mode != work.mode;
        let regular = |entry: &Entry| matches!(entry.mode.as_str(), "100644" | "100755");
        if (staged_mode && unstaged_mode) || ![head, index, work].into_iter().all(regular) {
            return Err(invalid(
                "Stash saved; staged cleanup overlaps unstaged mode or file-type changes",
            ));
        }
        let oid = if head.oid == index.oid {
            work.oid.clone()
        } else if index.oid == work.oid {
            head.oid.clone()
        } else {
            merge_disjoint_cleanup(root, head, index, work)?
        };
        let cleaned = Entry {
            oid,
            mode: if staged_mode { &head.mode } else { &work.mode }.clone(),
        };
        desired.push((s.path.clone(), materialize(root, &s.path, Some(&cleaned))?));
    }
    Ok(desired)
}

fn cleanup_overlap() -> GitError {
    invalid("Stash saved; staged cleanup overlaps unstaged changes or cannot be safely aligned")
}

struct LineEdit {
    baseline: Range<usize>,
    replacement: Vec<u8>,
}

// Both deltas use the SAME captured index blob as baseline: I->H removes the
// staged change, I->WT preserves the unstaged change. Splice only disjoint
// edits at those exact coordinates; there is no context search or relocation.
fn merge_disjoint_cleanup(
    root: &Path,
    head: &Entry,
    index: &Entry,
    work: &Entry,
) -> Result<String, GitError> {
    let baseline = git(root, None, &["cat-file", "blob", &index.oid], None)?;
    let lines = baseline
        .split_inclusive(|b| *b == b'\n')
        .collect::<Vec<_>>();
    let mut edits = Vec::new();
    for target in [head, work] {
        let bytes = git(root, None, &["cat-file", "blob", &target.oid], None)?;
        // Concurrent binary edits have no supported line-based merge. A binary
        // with no unstaged content change takes the exact-entry fast path above.
        if baseline.contains(&0) || bytes.contains(&0) {
            return Err(cleanup_overlap());
        }
        edits.extend(line_edits(root, &index.oid, &target.oid, &lines, &bytes)?);
    }
    edits.sort_by_key(|edit| (edit.baseline.start, edit.baseline.end));
    let mut merged = Vec::new();
    let mut cursor = 0;
    let mut previous_end = None;
    for edit in edits {
        // Also refuse touching boundaries: insertions at a replaced/deleted
        // range's edge and adjacent replacements have ambiguous ownership.
        if previous_end.is_some_and(|end| edit.baseline.start <= end) {
            return Err(cleanup_overlap());
        }
        for line in &lines[cursor..edit.baseline.start] {
            merged.extend_from_slice(line);
        }
        merged.extend_from_slice(&edit.replacement);
        cursor = edit.baseline.end;
        previous_end = Some(cursor);
    }
    for line in &lines[cursor..] {
        merged.extend_from_slice(line);
    }
    // These are canonical blob bytes; do not run a path's clean filter twice.
    text(root, None, &["hash-object", "-w", "--stdin"], Some(&merged))
}

fn line_edits(
    root: &Path,
    baseline_oid: &str,
    target_oid: &str,
    baseline: &[&[u8]],
    target: &[u8],
) -> Result<Vec<LineEdit>, GitError> {
    let patch = git(
        root,
        None,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--diff-algorithm=myers",
            "--no-indent-heuristic",
            "--unified=0",
            "--inter-hunk-context=0",
            baseline_oid,
            target_oid,
            "--",
        ],
        None,
    )?;
    let target = target.split_inclusive(|b| *b == b'\n').collect::<Vec<_>>();
    let mut edits = Vec::new();
    let (mut base_cursor, mut target_cursor) = (0, 0);
    for header in patch
        .split(|b| *b == b'\n')
        .filter(|l| l.starts_with(b"@@ "))
    {
        let fields = header.split(|b| *b == b' ').collect::<Vec<_>>();
        if fields.len() < 4 || fields[3] != b"@@" {
            return Err(cleanup_overlap());
        }
        let before = diff_line_range(fields[1], b'-')?;
        let after = diff_line_range(fields[2], b'+')?;
        let unchanged = baseline
            .get(base_cursor..before.start)
            .ok_or_else(cleanup_overlap)?;
        // Validate the edit program against the full raw blobs, including final
        // newline bytes. Unexpected/binary/filtered diff output fails closed.
        if baseline.get(before.clone()).is_none()
            || target.get(target_cursor..after.start) != Some(unchanged)
        {
            return Err(cleanup_overlap());
        }
        let replacement = target
            .get(after.clone())
            .ok_or_else(cleanup_overlap)?
            .concat();
        base_cursor = before.end;
        target_cursor = after.end;
        edits.push(LineEdit {
            baseline: before,
            replacement,
        });
    }
    if baseline.get(base_cursor..) != target.get(target_cursor..) {
        return Err(cleanup_overlap());
    }
    Ok(edits)
}

fn diff_line_range(field: &[u8], sign: u8) -> Result<Range<usize>, GitError> {
    let field = field.strip_prefix(&[sign]).ok_or_else(cleanup_overlap)?;
    let field = std::str::from_utf8(field).map_err(|_| cleanup_overlap())?;
    let (start, count) = field.split_once(',').unwrap_or((field, "1"));
    let start = start.parse::<usize>().map_err(|_| cleanup_overlap())?;
    let count = count.parse::<usize>().map_err(|_| cleanup_overlap())?;
    // A zero-length unified range names the boundary AFTER its line number.
    let start = if count == 0 {
        start
    } else {
        start.checked_sub(1).ok_or_else(cleanup_overlap)?
    };
    Ok(start..start.checked_add(count).ok_or_else(cleanup_overlap)?)
}

fn replace_checked(
    root: &Path,
    path: &str,
    expected: &Content,
    desired: &Content,
) -> Result<(), GitError> {
    if &capture(root, path)? != expected {
        return Err(invalid("Selected file changed before cleanup"));
    }
    let full = root.join(path);
    if *expected == Content::Missing && *desired != Content::Missing {
        let components = path.split('/').collect::<Vec<_>>();
        let mut ancestor = root.to_path_buf();
        for part in &components[..components.len() - 1] {
            ancestor.push(part);
            match fs::create_dir(&ancestor) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(_) => return Err(invalid("Could not restore selected file parent")),
            }
            validate_path(root, path)?;
        }
    }
    // Move the final entry rather than following it. Verify the moved bytes
    // before removing anything, then create the replacement exclusively. A
    // racing newly created destination is never overwritten.
    let parent = full
        .parent()
        .ok_or_else(|| invalid("Invalid selected file parent"))?;
    let backup_dir = tempfile::Builder::new()
        .prefix(".gitgui-stash-cleanup-")
        .tempdir_in(parent)
        .map_err(|_| invalid("Could not reserve safe cleanup location"))?;
    let backup = backup_dir.path().join("original");
    let moved = *expected != Content::Missing;
    #[cfg(unix)]
    let previous_permissions = fs::symlink_metadata(&full).ok().map(|m| m.permissions());
    if moved {
        fs::rename(&full, &backup).map_err(|_| invalid("Selected file changed before cleanup"))?;
        let relative_backup = relative_path(root, &backup);
        let valid = relative_backup
            .as_ref()
            .is_some_and(|p| capture(root, p).ok().as_ref() == Some(expected));
        if !valid {
            return recover_backup(backup_dir, &full, "Selected file changed during cleanup");
        }
    }
    let written = match desired {
        Content::Missing => Ok(()),
        Content::File(bytes, executable) => (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&full)?;
            file.write_all(bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = previous_permissions
                    .as_ref()
                    .map(|p| p.mode())
                    .unwrap_or(file.metadata()?.permissions().mode());
                // Preserve read/write permissions and the process umask.
                file.set_permissions(fs::Permissions::from_mode(
                    (mode & !0o111) | if *executable { (mode & 0o444) >> 2 } else { 0 },
                ))?;
            }
            #[cfg(not(unix))]
            let _ = executable;
            file.sync_all()
        })(),
        Content::Symlink(target) => {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(target, &full)
            }
            #[cfg(not(unix))]
            {
                let _ = target;
                Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "symlink",
                ))
            }
        }
    };
    if written.is_err() {
        // Do not remove an entry that may have been created by a competing writer.
        if moved {
            return recover_backup(backup_dir, &full, "Stash saved; file cleanup incomplete");
        }
        return Err(invalid("Stash saved; file cleanup incomplete"));
    }
    if moved {
        let relative = relative_path(root, &backup);
        if !relative.is_some_and(|p| capture(root, &p).ok().as_ref() == Some(expected)) {
            let _ = backup_dir.keep();
            return Err(invalid("Stash saved; concurrent original-file edits retained in a cleanup recovery directory"));
        }
    }
    Ok(())
}

fn recover_backup(backup: TempDir, destination: &Path, diagnostic: &str) -> Result<(), GitError> {
    let original = backup.path().join("original");
    // Hard-link creation is exclusive; unlike rename it cannot replace a racing
    // destination. Keep a recovery file if restoring the name is impossible.
    if fs::hard_link(&original, destination).is_err() {
        let _ = backup.keep();
    }
    Err(invalid(diagnostic))
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .and_then(|p| p.to_str())
        .map(|p| {
            if cfg!(windows) {
                p.replace('\\', "/")
            } else {
                p.to_owned()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::stash::{decode_stash, StashEncoding};

    struct Repo(TempDir);
    impl Repo {
        fn new() -> Self {
            let r = Self(tempfile::tempdir().unwrap());
            r.git(&["init", "-q"]);
            for (key, value) in [
                ("user.name", "Selected fixture"),
                ("user.email", "selected@example.invalid"),
                ("core.autocrlf", "false"),
                ("commit.gpgsign", "false"),
            ] {
                r.git(&["config", key, value]);
            }
            r.write("selected", "A\n");
            r.write("other", "original\n");
            r.git(&["add", "--", "selected", "other"]);
            r.git(&["commit", "-qm", "base"]);
            r
        }
        fn root(&self) -> &str {
            self.0.path().to_str().unwrap()
        }
        fn git(&self, args: &[&str]) -> String {
            let output = git_command()
                .current_dir(self.0.path())
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout)
                .unwrap()
                .trim_end_matches('\n')
                .to_owned()
        }
        fn write(&self, path: &str, data: &str) {
            fs::write(self.0.path().join(path), data).unwrap();
        }
        fn read(&self, path: &str) -> String {
            fs::read_to_string(self.0.path().join(path)).unwrap()
        }
        fn push(&self, source: StashSelectionSource, paths: &[&str]) -> StashPushSelectedResult {
            stash_push_selected(
                self.root(),
                source,
                &paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(),
                None,
            )
            .unwrap()
        }
        fn index(&self) -> Vec<u8> {
            fs::read(self.0.path().join(".git/index")).unwrap()
        }
        fn unrelated(&self) {
            self.write("other", "other staged\n");
            self.git(&["add", "--", "other"]);
            self.write("other", "other worktree\n");
        }
        fn assert_unrelated(&self, stash: &str) {
            assert_eq!(self.git(&["show", ":other"]), "other staged");
            assert_eq!(self.read("other"), "other worktree\n");
            assert_eq!(self.git(&["show", &format!("{stash}:other")]), "original");
            assert_eq!(self.git(&["show", &format!("{stash}^2:other")]), "original");
        }
    }

    #[test]
    fn unstaged_inverse_uses_durable_baseline_and_preserves_entire_index() {
        for with_index in [false, true] {
            let r = Repo::new();
            let head = r.git(&["rev-parse", "HEAD"]);
            r.write("selected", "B\n");
            r.git(&["add", "--", "selected"]);
            r.write("selected", "A\n");
            r.unrelated();
            let before = r.index();
            let result = r.push(StashSelectionSource::Unstaged, &["selected"]);
            assert_eq!(
                result.outcome,
                StashPushSelectedOutcome::Success,
                "{result:?}"
            );
            let saved = result.stash.unwrap();
            let layout = decode_stash(r.root(), &saved.hash).unwrap();
            assert_eq!(layout.encoding, StashEncoding::SelectedUnstagedV1);
            assert_eq!(layout.original_head_oid, head);
            assert_eq!(saved.base_hash, head);
            assert_eq!(r.read("selected"), "B\n");
            assert_eq!(r.index(), before);
            let patch = r.git(&["stash", "show", "-p", &saved.hash]);
            assert!(patch.contains("-B\n+A"), "{patch}");
            r.assert_unrelated(&saved.hash);
            if with_index {
                r.git(&["stash", "apply", "--index", &saved.hash]);
            } else {
                r.git(&["stash", "apply", &saved.hash]);
            }
            assert_eq!(r.git(&["show", ":selected"]), "B");
            assert_eq!(r.read("selected"), "A\n");
            r.assert_unrelated(&saved.hash);
        }
    }

    #[test]
    fn staged_snapshot_excludes_unstaged_and_preserves_nonoverlapping_delta() {
        let r = Repo::new();
        r.write(
            "selected",
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
        );
        r.git(&["add", "--", "selected"]);
        r.git(&["commit", "-qm", "lines"]);
        r.write(
            "selected",
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
        );
        r.git(&["add", "--", "selected"]);
        r.write(
            "selected",
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n",
        );
        r.unrelated();
        let result = r.push(StashSelectionSource::Staged, &["selected"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        let saved = result.stash.unwrap();
        assert_eq!(
            decode_stash(r.root(), &saved.hash).unwrap().encoding,
            StashEncoding::Native
        );
        assert!(r.read("selected").starts_with("one\n"));
        assert!(r.read("selected").ends_with("TEN\n"));
        assert_eq!(
            r.git(&["show", ":selected"]),
            r.git(&["show", "HEAD:selected"])
        );
        assert!(!r
            .git(&["show", &format!("{}:selected", saved.hash)])
            .contains("TEN"));
        r.assert_unrelated(&saved.hash);
        // Native stash restoration can refuse existing unstaged work. Cleanup
        // preservation was asserted above; replay is exercised on a clean target.
        r.git(&[
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            "selected",
            "other",
        ]);
        r.git(&["stash", "apply", "--index", &saved.hash]);
        assert!(r.read("selected").starts_with("ONE\n"));
        assert!(r.read("selected").ends_with("ten\n"));
    }

    #[test]
    fn staged_overlap_and_staged_inverse_return_partial_without_touching_live_state() {
        for work in ["A\n", "C\n"] {
            let r = Repo::new();
            r.write("selected", "B\n");
            r.git(&["add", "--", "selected"]);
            r.write("selected", work);
            r.unrelated();
            let before = r.index();
            let result = r.push(StashSelectionSource::Staged, &["selected"]);
            assert_eq!(result.outcome, StashPushSelectedOutcome::Partial);
            assert!(result.error.unwrap().contains("overlaps"));
            let saved = result.stash.unwrap();
            assert_eq!(r.git(&["rev-parse", "refs/stash"]), saved.hash);
            assert_eq!(r.git(&["show", &format!("{}:selected", saved.hash)]), "B");
            assert_eq!(r.index(), before);
            assert_eq!(r.read("selected"), work);
            r.assert_unrelated(&saved.hash);
        }
    }

    #[test]
    fn staged_repeated_context_inverse_cannot_relocate_cleanup_or_clean_other_paths() {
        let r = Repo::new();
        let block = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
        let changed = block.replace("five\n", "FIVE\n");
        r.write("selected", &block.repeat(2));
        r.write("safe", "safe original\n");
        r.git(&["add", "--", "selected", "safe"]);
        r.git(&["commit", "-qm", "repeated context"]);
        let staged = format!("{changed}{block}");
        let work = format!("{block}{changed}");
        r.write("selected", &staged);
        r.write("safe", "safe staged\n");
        r.git(&["add", "--", "selected", "safe"]);
        r.write("selected", &work);
        r.unrelated();
        let before = r.index();

        // Production API: reversing H->I against WT used to relocate the first
        // block's hunk to the second and erase BOTH unstaged edits successfully.
        // The safe path comes first to require preflight of the whole selection.
        let result = r.push(StashSelectionSource::Staged, &["safe", "selected"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Partial,
            "{result:?}"
        );
        assert!(result.error.unwrap().contains("overlaps"));
        assert_eq!(r.index(), before);
        assert_eq!(r.read("selected"), work);
        assert_eq!(r.read("safe"), "safe staged\n");
        let saved = result.stash.unwrap();
        assert_eq!(r.git(&["rev-parse", &saved.selector]), saved.hash);
        assert_eq!(
            git(
                r.0.path(),
                None,
                &["show", &format!("{}:selected", saved.hash)],
                None
            )
            .unwrap(),
            staged.as_bytes()
        );
        assert_eq!(
            r.git(&["rev-parse", &format!("{}^{{tree}}", saved.hash)]),
            r.git(&["rev-parse", &format!("{}^2^{{tree}}", saved.hash)])
        );
        r.assert_unrelated(&saved.hash);
    }

    #[test]
    fn staged_cleanup_preserves_disjoint_insert_delete_offsets_and_final_newline_bytes() {
        for prefix in ["inserted before everything\nsecond insertion\n", ""] {
            let r = Repo::new();
            let original = (1..=50)
                .map(|n| format!("line {n}"))
                .collect::<Vec<_>>()
                .join("\n");
            r.write("selected", &original);
            r.git(&["add", "--", "selected"]);
            r.git(&["commit", "-qm", "offset baseline"]);
            let staged = original
                .replace("line 20\n", "staged insertion\nLINE 20\n")
                .replace("line 35\n", "");
            r.write("selected", &staged);
            r.git(&["add", "--", "selected"]);
            let unstaged = |text: &str| {
                format!(
                    "{prefix}{}",
                    text.replace("line 5\n", "")
                        .replace("line 45\n", "LINE 45\n")
                )
            };
            r.write("selected", &unstaged(&staged));
            r.unrelated();
            let result = r.push(StashSelectionSource::Staged, &["selected"]);
            assert_eq!(
                result.outcome,
                StashPushSelectedOutcome::Success,
                "{result:?}"
            );
            assert_eq!(r.read("selected"), unstaged(&original));
            assert_eq!(r.git(&["show", ":selected"]), original);
            let saved = result.stash.unwrap();
            assert_eq!(
                r.git(&["show", &format!("{}:selected", saved.hash)]),
                staged
            );
            r.assert_unrelated(&saved.hash);
        }
    }

    #[test]
    fn staged_cleanup_refuses_touching_replacements_and_insertion_boundaries() {
        let original = "one\ntwo\nthree\nfour\nfive\n";
        for (staged, work) in [
            (
                "one\ntwo\nTHREE\nfour\nfive\n",
                "one\nTWO\nTHREE\nfour\nfive\n",
            ),
            (
                "one\ntwo\ninserted\nthree\nfour\nfive\n",
                "one\ntwo\nunstaged\ninserted\nthree\nfour\nfive\n",
            ),
            ("one\ntwo\nfour\nfive\n", "one\ntwo\nFOUR\nfive\n"),
        ] {
            let r = Repo::new();
            r.write("selected", original);
            r.git(&["add", "--", "selected"]);
            r.git(&["commit", "-qm", "boundary baseline"]);
            r.write("selected", staged);
            r.git(&["add", "--", "selected"]);
            r.write("selected", work);
            let before = r.index();
            let result = r.push(StashSelectionSource::Staged, &["selected"]);
            assert_eq!(
                result.outcome,
                StashPushSelectedOutcome::Partial,
                "{result:?}"
            );
            assert!(result.error.unwrap().contains("overlaps"));
            assert_eq!(r.index(), before);
            assert_eq!(r.read("selected"), work);
            let saved = result.stash.unwrap();
            assert_eq!(r.git(&["rev-parse", &saved.selector]), saved.hash);
            assert_eq!(
                r.git(&["show", &format!("{}:selected", saved.hash)]),
                staged.trim_end_matches('\n')
            );
        }
    }

    #[test]
    fn staged_disjoint_cleanup_preserves_crlf_filters_and_non_utf8_bytes() {
        let r = Repo::new();
        r.write(".gitattributes", "selected text eol=crlf\n");
        let original =
            b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nnine\r\n\xff\r\n";
        let staged =
            b"ONE\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nnine\r\n\xff\r\n";
        let work =
            b"ONE\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nNINE\r\n\xff\r\n";
        let expected =
            b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nNINE\r\n\xff\r\n";
        fs::write(r.0.path().join("selected"), original).unwrap();
        r.git(&["add", "--", "selected", ".gitattributes"]);
        r.git(&["commit", "-qm", "filtered baseline"]);
        fs::write(r.0.path().join("selected"), staged).unwrap();
        r.git(&["add", "--", "selected"]);
        fs::write(r.0.path().join("selected"), work).unwrap();
        let result = r.push(StashSelectionSource::Staged, &["selected"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(fs::read(r.0.path().join("selected")).unwrap(), expected);
        assert_eq!(
            r.git(&["rev-parse", ":selected"]),
            r.git(&["rev-parse", "HEAD:selected"])
        );
        let saved = result.stash.unwrap();
        let canonical = staged
            .iter()
            .copied()
            .filter(|b| *b != b'\r')
            .collect::<Vec<_>>();
        assert_eq!(
            git(
                r.0.path(),
                None,
                &["show", &format!("{}:selected", saved.hash)],
                None
            )
            .unwrap(),
            canonical
        );
    }

    #[test]
    fn staged_binary_cleanup_restores_exact_entry_or_retains_simultaneous_edits() {
        for unstaged in [false, true] {
            let r = Repo::new();
            let original = b"head\0binary\n";
            let staged = b"index\0binary\n";
            let work = if unstaged {
                b"work\0binary\n".as_slice()
            } else {
                staged.as_slice()
            };
            fs::write(r.0.path().join("selected"), original).unwrap();
            r.git(&["add", "--", "selected"]);
            r.git(&["commit", "-qm", "binary baseline"]);
            fs::write(r.0.path().join("selected"), staged).unwrap();
            r.git(&["add", "--", "selected"]);
            fs::write(r.0.path().join("selected"), work).unwrap();
            let before = r.index();
            let result = r.push(StashSelectionSource::Staged, &["selected"]);
            assert_eq!(
                result.outcome,
                if unstaged {
                    StashPushSelectedOutcome::Partial
                } else {
                    StashPushSelectedOutcome::Success
                },
                "{result:?}"
            );
            if unstaged {
                assert_eq!(r.index(), before);
            } else {
                assert_eq!(
                    r.git(&["rev-parse", ":selected"]),
                    r.git(&["rev-parse", "HEAD:selected"])
                );
            }
            assert_eq!(
                fs::read(r.0.path().join("selected")).unwrap(),
                if unstaged { work } else { original }
            );
            let saved = result.stash.unwrap();
            assert_eq!(
                git(
                    r.0.path(),
                    None,
                    &["show", &format!("{}:selected", saved.hash)],
                    None
                )
                .unwrap(),
                staged
            );
        }
    }

    #[test]
    fn selected_untracked_is_parentless_disjoint_and_only_selected_file_removed() {
        let r = Repo::new();
        r.write("new file", "selected new\n");
        r.write("not selected", "keep\n");
        r.unrelated();
        let before = r.index();
        let result = r.push(StashSelectionSource::Unstaged, &["new file"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        let saved = result.stash.unwrap();
        let layout = decode_stash(r.root(), &saved.hash).unwrap();
        let u = layout.untracked_oid.unwrap();
        assert_eq!(r.git(&["rev-list", "--parents", "-n", "1", &u]), u);
        assert_eq!(r.git(&["ls-tree", "-r", "--name-only", &u]), "new file");
        assert!(!r.0.path().join("new file").exists());
        assert_eq!(r.read("not selected"), "keep\n");
        assert_eq!(r.index(), before);
        r.git(&["stash", "apply", &saved.hash]);
        assert_eq!(r.read("new file"), "selected new\n");
        r.assert_unrelated(&saved.hash);
    }

    #[test]
    fn staged_deletion_untracked_replacement_has_only_u_payload() {
        let r = Repo::new();
        r.git(&["update-index", "--force-remove", "--", "selected"]);
        r.write("selected", "replacement\n");
        let before = r.index();
        let result = r.push(StashSelectionSource::Unstaged, &["selected"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        let saved = result.stash.unwrap();
        let layout = decode_stash(r.root(), &saved.hash).unwrap();
        assert_eq!(
            r.git(&["diff", "--name-only", &layout.baseline_oid, &saved.hash]),
            ""
        );
        assert_eq!(
            r.git(&[
                "show",
                &format!("{}:selected", layout.untracked_oid.unwrap())
            ]),
            "replacement"
        );
        assert_eq!(r.index(), before);
        assert!(!r.0.path().join("selected").exists());
        r.git(&["stash", "apply", &saved.hash]);
        assert_eq!(r.read("selected"), "replacement\n");
        assert_eq!(r.git(&["diff", "--cached", "--name-status"]), "D\tselected");
    }

    #[test]
    fn tracked_add_delete_and_rename_are_explicit_path_operations() {
        let r = Repo::new();
        r.git(&["mv", "--", "selected", "renamed"]);
        r.unrelated();
        let result = r.push(StashSelectionSource::Staged, &["selected", "renamed"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.read("selected"), "A\n");
        assert!(!r.0.path().join("renamed").exists());
        let saved = result.stash.unwrap();
        r.assert_unrelated(&saved.hash);
        r.git(&[
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            "other",
        ]);
        r.git(&["stash", "apply", "--index", &saved.hash]);
        assert_eq!(r.read("renamed"), "A\n");
        assert!(!r.0.path().join("selected").exists());
        // Unstaged tracked deletion is saved and restored without changing index.
        let before = r.index();
        fs::remove_file(r.0.path().join("renamed")).unwrap();
        let result = r.push(StashSelectionSource::Unstaged, &["renamed"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.index(), before);
        assert_eq!(r.read("renamed"), "A\n");
        r.git(&["stash", "apply", &result.stash.unwrap().hash]);
        assert!(!r.0.path().join("renamed").exists());
    }

    #[test]
    fn no_op_and_empty_never_publish_a_stash() {
        let r = Repo::new();
        assert!(stash_push_selected(r.root(), StashSelectionSource::Unstaged, &[], None).is_err());
        for source in [StashSelectionSource::Staged, StashSelectionSource::Unstaged] {
            let result = r.push(source, &["selected"]);
            assert_eq!(result.outcome, StashPushSelectedOutcome::NoChanges);
            assert!(result.stash.is_none());
        }
        assert_eq!(r.git(&["stash", "list"]), "");
        r.write("selected", "only unstaged\n");
        assert_eq!(
            r.push(StashSelectionSource::Staged, &["selected"]).outcome,
            StashPushSelectedOutcome::NoChanges
        );
        assert_eq!(r.read("selected"), "only unstaged\n");
    }

    #[test]
    fn dangerous_paths_and_directory_selections_are_rejected_before_publication() {
        let r = Repo::new();
        r.write("selected", "changed\n");
        fs::create_dir(r.0.path().join("directory")).unwrap();
        let before = r.index();
        for path in [
            "",
            ".",
            "..",
            "../outside",
            "/absolute",
            ".git/config",
            "x/../selected",
            "x//y",
            "directory",
            "nul\0byte",
        ] {
            assert!(
                stash_push_selected(
                    r.root(),
                    StashSelectionSource::Unstaged,
                    &[path.into()],
                    None
                )
                .is_err(),
                "{path:?}"
            );
        }
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Unstaged,
            &["selected".into(), "selected".into()],
            None
        )
        .is_err());
        assert_eq!(r.index(), before);
        assert_eq!(r.read("selected"), "changed\n");
        assert_eq!(r.git(&["stash", "list"]), "");
        #[cfg(windows)]
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Unstaged,
            &["x\\y".into()],
            None
        )
        .is_err());
    }

    #[test]
    fn literal_option_wildcard_and_unicode_paths_are_not_expanded() {
        let r = Repo::new();
        let paths = ["-option", "[literal]", "unicode-æ-猫 space", ":(glob)*"];
        let supported = paths
            .into_iter()
            .filter(|p| fs::write(r.0.path().join(p), b"saved\n").is_ok())
            .collect::<Vec<_>>();
        r.write("other new", "keep\n");
        let result = r.push(StashSelectionSource::Unstaged, &supported);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        for path in &supported {
            assert!(!r.0.path().join(path).exists());
        }
        assert_eq!(r.read("other new"), "keep\n");
        r.git(&["stash", "apply", &result.stash.unwrap().hash]);
        for path in &supported {
            assert_eq!(r.read(path), "saved\n");
        }
        r.git(&["add", "--all"]);
        r.git(&["commit", "-qm", "literal files"]);
        for path in &supported {
            r.write(path, "staged literal\n");
        }
        let mut add = vec!["add", "--"];
        add.extend(supported.iter().copied());
        r.git(&add);
        let result = r.push(StashSelectionSource::Staged, &supported);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        for path in &supported {
            assert_eq!(r.read(path), "saved\n");
        }
    }

    #[cfg(unix)]
    #[test]
    fn tabs_newlines_and_final_symlinks_are_saved_without_following_targets() {
        use std::os::unix::fs::symlink;
        let r = Repo::new();
        r.write("tab\tfile", "tab\n");
        r.write("back\\slash", "backslash\n");
        r.write("line\nfile", "line\n");
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("target"), b"external").unwrap();
        symlink(external.path().join("target"), r.0.path().join("link")).unwrap();
        let result = r.push(
            StashSelectionSource::Unstaged,
            &["tab\tfile", "line\nfile", "back\\slash", "link"],
        );
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(
            fs::read(external.path().join("target")).unwrap(),
            b"external"
        );
        r.git(&["stash", "apply", &result.stash.unwrap().hash]);
        assert_eq!(r.read("tab\tfile"), "tab\n");
        assert_eq!(r.read("back\\slash"), "backslash\n");
        assert_eq!(r.read("line\nfile"), "line\n");
        assert_eq!(
            fs::read_link(r.0.path().join("link")).unwrap(),
            external.path().join("target")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_ancestors_cannot_escape_repository() {
        let r = Repo::new();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("file"), b"external").unwrap();
        std::os::unix::fs::symlink(external.path(), r.0.path().join("escape")).unwrap();
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Unstaged,
            &["escape/file".into()],
            None
        )
        .is_err());
        assert_eq!(fs::read(external.path().join("file")).unwrap(), b"external");
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    #[test]
    fn existing_index_lock_refuses_without_publication_or_cleanup() {
        let r = Repo::new();
        r.write("selected", "changed\n");
        let lock = r.0.path().join(".git/index.lock");
        fs::write(&lock, b"owned by another process").unwrap();
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Unstaged,
            &["selected".into()],
            None
        )
        .is_err());
        assert_eq!(fs::read(lock).unwrap(), b"owned by another process");
        assert_eq!(r.read("selected"), "changed\n");
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    #[test]
    fn post_publication_content_race_retains_new_content_and_saved_stash() {
        let r = Repo::new();
        r.write("selected", "captured\n");
        let before = r.index();
        let result = stash_push_selected_inner(
            r.root(),
            StashSelectionSource::Unstaged,
            &["selected".into()],
            None,
            || r.write("selected", "concurrent\n"),
        )
        .unwrap();
        assert_eq!(result.outcome, StashPushSelectedOutcome::Partial);
        let saved = result.stash.unwrap();
        assert_eq!(r.git(&["rev-parse", "refs/stash"]), saved.hash);
        assert_eq!(
            r.git(&["show", &format!("{}:selected", saved.hash)]),
            "captured"
        );
        assert_eq!(r.read("selected"), "concurrent\n");
        assert_eq!(r.index(), before);
    }

    #[test]
    fn post_publication_untracked_race_does_not_remove_new_contents() {
        let r = Repo::new();
        r.write("new", "captured\n");
        let result = stash_push_selected_inner(
            r.root(),
            StashSelectionSource::Unstaged,
            &["new".into()],
            None,
            || r.write("new", "new contents\n"),
        )
        .unwrap();
        assert_eq!(result.outcome, StashPushSelectedOutcome::Partial);
        assert!(result.stash.is_some());
        assert_eq!(r.read("new"), "new contents\n");
    }

    #[test]
    fn post_publication_index_change_is_not_overwritten() {
        let r = Repo::new();
        r.write("selected", "B\n");
        r.git(&["add", "--", "selected"]);
        let mut changed = r.index();
        changed.extend_from_slice(b"external writer");
        let result = stash_push_selected_inner(
            r.root(),
            StashSelectionSource::Staged,
            &["selected".into()],
            None,
            || fs::write(r.0.path().join(".git/index"), &changed).unwrap(),
        )
        .unwrap();
        assert_eq!(result.outcome, StashPushSelectedOutcome::Partial);
        assert!(result.stash.is_some());
        assert_eq!(r.index(), changed);
        assert_eq!(r.read("selected"), "B\n");
    }

    #[test]
    fn unsupported_intent_to_add_and_in_progress_operations_are_refused() {
        let r = Repo::new();
        r.write("new", "new\n");
        r.git(&["add", "-N", "--", "new"]);
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Unstaged,
            &["new".into()],
            None
        )
        .is_err());
        assert_eq!(r.git(&["stash", "list"]), "");
        r.git(&["reset", "--", "new"]);
        r.write("selected", "changed\n");
        fs::write(
            r.0.path().join(".git/MERGE_HEAD"),
            r.git(&["rev-parse", "HEAD"]),
        )
        .unwrap();
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Unstaged,
            &["selected".into()],
            None
        )
        .is_err());
        assert_eq!(r.read("selected"), "changed\n");
    }

    #[test]
    fn binary_contents_are_saved_and_cleaned_without_text_conversion_loss() {
        let r = Repo::new();
        let bytes = [0, 255, 0, 128, b'\n'].repeat(64 * 1024);
        fs::write(r.0.path().join("selected"), &bytes).unwrap();
        let result = r.push(StashSelectionSource::Unstaged, &["selected"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.read("selected"), "A\n");
        r.git(&["stash", "apply", &result.stash.unwrap().hash]);
        assert_eq!(fs::read(r.0.path().join("selected")).unwrap(), bytes);
    }

    #[test]
    fn other_worktree_index_and_files_are_untouched() {
        let r = Repo::new();
        let other = tempfile::tempdir().unwrap();
        let location = other.path().join("linked");
        r.git(&[
            "worktree",
            "add",
            "-qb",
            "other-worktree",
            location.to_str().unwrap(),
        ]);
        fs::write(location.join("selected"), b"other worktree\n").unwrap();
        text(&location, None, &["add", "--", "selected"], None).unwrap();
        let other_index = text(
            &location,
            None,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            None,
        )
        .unwrap();
        let before = fs::read(&other_index).unwrap();
        r.write("selected", "B\n");
        assert_eq!(
            r.push(StashSelectionSource::Unstaged, &["selected"])
                .outcome,
            StashPushSelectedOutcome::Success
        );
        assert_eq!(fs::read(other_index).unwrap(), before);
        assert_eq!(
            fs::read(location.join("selected")).unwrap(),
            b"other worktree\n"
        );
        // Also exercise selected stash from a linked worktree's own index path.
        let result = stash_push_selected(
            location.to_str().unwrap(),
            StashSelectionSource::Staged,
            &["selected".into()],
            None,
        )
        .unwrap();
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.read("selected"), "A\n");
    }

    #[test]
    fn nested_deleted_worktree_file_is_restored_without_touching_index() {
        let r = Repo::new();
        fs::create_dir(r.0.path().join("nested")).unwrap();
        r.write("nested/file", "base\n");
        r.git(&["add", "--", "nested/file"]);
        r.git(&["commit", "-qm", "nested"]);
        fs::remove_file(r.0.path().join("nested/file")).unwrap();
        fs::remove_dir(r.0.path().join("nested")).unwrap();
        let before = r.index();
        let result = r.push(StashSelectionSource::Unstaged, &["nested/file"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.index(), before);
        assert_eq!(r.read("nested/file"), "base\n");
    }

    #[test]
    fn unstaged_rename_saves_delete_and_selected_untracked_add() {
        let r = Repo::new();
        fs::rename(r.0.path().join("selected"), r.0.path().join("renamed")).unwrap();
        let before = r.index();
        let result = r.push(StashSelectionSource::Unstaged, &["selected", "renamed"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.index(), before);
        assert_eq!(r.read("selected"), "A\n");
        assert!(!r.0.path().join("renamed").exists());
        r.git(&["stash", "apply", &result.stash.unwrap().hash]);
        assert_eq!(r.read("renamed"), "A\n");
        assert!(!r.0.path().join("selected").exists());
    }

    #[test]
    fn staged_add_is_removed_and_unstaged_added_index_file_restores_baseline() {
        let r = Repo::new();
        r.write("new", "staged\n");
        r.git(&["add", "--", "new"]);
        let result = r.push(StashSelectionSource::Staged, &["new"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert!(!r.0.path().join("new").exists());
        assert_eq!(r.git(&["ls-files", "--", "new"]), "");
        r.git(&["stash", "apply", "--index", &result.stash.unwrap().hash]);
        r.write("new", "unstaged\n");
        let before = r.index();
        let result = r.push(StashSelectionSource::Unstaged, &["new"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.index(), before);
        assert_eq!(r.read("new"), "staged\n");
    }

    #[test]
    fn failed_publication_leaves_index_worktree_and_existing_lock_unchanged() {
        let r = Repo::new();
        r.write("selected", "changed\n");
        let before = r.index();
        let lock = r.0.path().join(".git/refs/stash.lock");
        fs::write(&lock, b"other owner").unwrap();
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Unstaged,
            &["selected".into()],
            None
        )
        .is_err());
        assert_eq!(r.read("selected"), "changed\n");
        assert_eq!(r.index(), before);
        assert_eq!(fs::read(lock).unwrap(), b"other owner");
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    #[test]
    fn unmerged_index_and_selected_gitlinks_are_refused() {
        let r = Repo::new();
        let head = r.git(&["rev-parse", "HEAD"]);
        r.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000",
            &head,
            "submodule",
        ]);
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Staged,
            &["submodule".into()],
            None
        )
        .is_err());
        fs::create_dir(r.0.path().join("submodule")).unwrap();
        r.write("submodule/file", "do not save\n");
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Unstaged,
            &["submodule/file".into()],
            None
        )
        .is_err());
        let oid = r.git(&["rev-parse", "HEAD:selected"]);
        let stages = format!(
            "0 {}\tselected\0\x31\x30\x30\x36\x34\x34 {} 1\tselected\0",
            "0".repeat(40),
            oid
        );
        git(
            r.0.path(),
            None,
            &["update-index", "-z", "--index-info"],
            Some(stages.as_bytes()),
        )
        .unwrap();
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Unstaged,
            &["selected".into()],
            None
        )
        .is_err());
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    #[test]
    fn index_lock_drop_does_not_delete_a_successor_lock() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index");
        fs::write(&index, b"old").unwrap();
        let mut owned = IndexLock::acquire(&index).unwrap();
        owned.publish(&index, b"new").unwrap();
        let next = IndexLock::acquire(&index).unwrap();
        drop(owned);
        assert!(next.path.exists());
    }

    #[test]
    fn split_index_keeps_unstaged_real_index_bytes_and_preserves_unrelated_entries() {
        let r = Repo::new();
        r.unrelated();
        r.git(&["update-index", "--split-index"]);
        r.write("selected", "unstaged\n");
        let before = r.index();
        let result = r.push(StashSelectionSource::Unstaged, &["selected"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.index(), before);
        r.assert_unrelated(&result.stash.unwrap().hash);
        r.write("selected", "staged\n");
        r.git(&["add", "--", "selected"]);
        let result = r.push(StashSelectionSource::Staged, &["selected"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.git(&["show", ":selected"]), "A");
        r.assert_unrelated(&result.stash.unwrap().hash);
    }

    #[test]
    fn mode_inverse_cleanup_is_refused_even_if_git_apply_would_only_warn() {
        let r = Repo::new();
        let oid = r.git(&["rev-parse", "HEAD:selected"]);
        let selected = Selected {
            path: "selected".into(),
            head: Some(Entry {
                mode: "100644".into(),
                oid: oid.clone(),
            }),
            index: Some(Entry {
                mode: "100755".into(),
                oid: oid.clone(),
            }),
            work: Some(Entry {
                mode: "100644".into(),
                oid,
            }),
            captured: Content::File(b"A\n".to_vec(), false),
        };
        assert!(staged_cleanup(r.0.path(), &[selected])
            .unwrap_err()
            .message
            .contains("mode"));
    }

    #[test]
    fn staged_text_cleanup_preserves_unstaged_mode_and_new_file_mode_overlap_refuses() {
        let r = Repo::new();
        let original = r.git(&["rev-parse", "HEAD:selected"]);
        r.write("selected", "B\n");
        r.git(&["add", "--", "selected"]);
        let oid = r.git(&["rev-parse", ":selected"]);
        let mut selected = Selected {
            path: "selected".into(),
            head: Some(Entry {
                mode: "100644".into(),
                oid: original,
            }),
            index: Some(Entry {
                mode: "100644".into(),
                oid: oid.clone(),
            }),
            work: Some(Entry {
                mode: "100755".into(),
                oid,
            }),
            captured: Content::File(b"B\n".to_vec(), true),
        };
        let desired = staged_cleanup(r.0.path(), std::slice::from_ref(&selected)).unwrap();
        assert_eq!(
            desired,
            vec![("selected".into(), Content::File(b"A\n".to_vec(), true))]
        );
        selected.head = None;
        assert!(staged_cleanup(r.0.path(), &[selected]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_special_names_and_tracked_symlinks_are_explicit_safe_refusals() {
        let r = Repo::new();
        for path in [
            "NUL",
            "con.txt",
            "LPT1",
            "directory/COM1",
            "space ",
            "dot.",
            "tab\tname",
            "line\nname",
            "file:stream",
        ] {
            assert!(
                stash_push_selected(
                    r.root(),
                    StashSelectionSource::Unstaged,
                    &[path.into()],
                    None
                )
                .is_err(),
                "{path}"
            );
        }
        let blob = text(
            r.0.path(),
            None,
            &["hash-object", "-w", "--stdin"],
            Some(b"outside"),
        )
        .unwrap();
        r.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            "120000",
            &blob,
            "link",
        ]);
        assert!(stash_push_selected(
            r.root(),
            StashSelectionSource::Staged,
            &["link".into()],
            None
        )
        .is_err());
        assert_eq!(r.git(&["stash", "list"]), "");
    }

    #[cfg(unix)]
    #[test]
    fn executable_mode_changes_and_tracked_final_symlink_are_preserved() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let r = Repo::new();
        r.git(&["config", "core.filemode", "true"]);
        fs::set_permissions(
            r.0.path().join("selected"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        r.git(&["add", "--", "selected"]);
        let result = r.push(StashSelectionSource::Staged, &["selected"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(
            fs::metadata(r.0.path().join("selected"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
        let saved = result.stash.unwrap();
        assert!(r
            .git(&["ls-tree", &saved.hash, "--", "selected"])
            .starts_with("100755"));
        fs::set_permissions(
            r.0.path().join("selected"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        r.git(&["add", "--", "selected"]);
        fs::set_permissions(
            r.0.path().join("selected"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let before_inverse = r.index();
        let inverse = r.push(StashSelectionSource::Staged, &["selected"]);
        assert_eq!(
            inverse.outcome,
            StashPushSelectedOutcome::Partial,
            "{inverse:?}"
        );
        assert_eq!(r.index(), before_inverse);
        r.git(&[
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            "selected",
        ]);
        symlink("first", r.0.path().join("link")).unwrap();
        r.git(&["add", "--", "link"]);
        r.git(&["commit", "-qm", "link"]);
        fs::remove_file(r.0.path().join("link")).unwrap();
        symlink("second", r.0.path().join("link")).unwrap();
        let before = r.index();
        let result = r.push(StashSelectionSource::Unstaged, &["link"]);
        assert_eq!(
            result.outcome,
            StashPushSelectedOutcome::Success,
            "{result:?}"
        );
        assert_eq!(r.index(), before);
        assert_eq!(
            fs::read_link(r.0.path().join("link")).unwrap(),
            PathBuf::from("first")
        );
        r.git(&["stash", "apply", &result.stash.unwrap().hash]);
        assert_eq!(
            fs::read_link(r.0.path().join("link")).unwrap(),
            PathBuf::from("second")
        );
    }
}
