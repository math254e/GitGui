//! Validated, replacement-independent stash object layouts shared by all stash operations.
use super::command::{git_command, GitCommand, GitError};
use super::repository::StashInfo;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    path::Path,
    process::Stdio,
    sync::Arc,
};

pub const STASH_ENCODING_HEADER: &str = "gitgui-stash-encoding selected-unstaged-v1";
pub const SELECTED_UNSTAGED_ENCODING: &str = "selected-unstaged-v1";
const METADATA_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StashEncoding {
    Native,
    SelectedUnstagedV1,
}
#[derive(Clone, Debug)]
pub struct StashTarget {
    pub selector: String,
    pub expected_oid: String,
}
#[derive(Clone, Debug)]
pub enum StashError {
    TargetChanged,
    Invalid(GitError),
}
impl From<GitError> for StashError {
    fn from(error: GitError) -> Self {
        Self::Invalid(error)
    }
}
#[derive(Clone, Debug)]
pub struct StashLayout {
    pub stash_oid: String,
    pub original_head_oid: String,
    pub baseline_oid: String,
    pub index_oid: String,
    pub untracked_oid: Option<String>,
    pub encoding: StashEncoding,
}

pub(crate) fn invalid(message: impl Into<String>) -> GitError {
    GitError {
        message: message.into(),
        stderr: String::new(),
        status: None,
    }
}
pub(crate) fn is_oid(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64) && oid.bytes().all(|b| b.is_ascii_hexdigit())
}

// All saved-object consumers use this primitive: replacements cannot reinterpret a
// reviewed OID, and corrupt/huge metadata cannot cause unbounded allocation.
pub(crate) fn read_git(root: &str, args: &[&str], limit: usize) -> Result<Vec<u8>, GitError> {
    read_git_input(root, args, limit, None)
}

pub(crate) fn read_git_input(
    root: &str,
    args: &[&str],
    limit: usize,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, GitError> {
    let mut child = git_command()
        .arg("--no-replace-objects")
        .args(args)
        .current_dir(root)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| invalid(format!("Could not read saved Git object: {e}")))?;
    let mut bytes = Vec::new();
    // Drain stdout while writing batch input. Sequential writes/reads can
    // deadlock on Windows' small anonymous pipes even with bounded batches.
    let result = std::thread::scope(|scope| {
        let writer = input.map(|input| {
            let mut stdin = child.stdin.take().expect("piped stdin");
            scope.spawn(move || stdin.write_all(input))
        });
        let read = child
            .stdout
            .take()
            .expect("piped stdout")
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes);
        let write = writer
            .map(|writer| writer.join().expect("batch writer"))
            .transpose();
        read.and(write.map(|_| ()))
    });
    // The owned stdout pipe closes here, including on a limit/read failure;
    // Git exits on the closed pipe and is always reaped below.
    let status = child.wait().map_err(|e| invalid(e.to_string()))?;
    result.map_err(|e| invalid(e.to_string()))?;
    if bytes.len() > limit {
        return Err(invalid("Saved Git object exceeds inspection limit"));
    }
    if !status.success() {
        return Err(invalid("Could not read saved Git object"));
    }
    Ok(bytes)
}

pub(crate) fn selector_number(selector: &str) -> Option<usize> {
    selector
        .strip_prefix("stash@{")
        .and_then(|s| s.strip_suffix('}'))
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<usize>().ok().filter(|n| n.to_string() == s))
}

pub fn resolve_stash(root: &str, target: &StashTarget) -> Result<StashLayout, StashError> {
    decode_stash(root, &resolve_stash_oid(root, target)?)
}

pub(crate) fn resolve_stash_oid(root: &str, target: &StashTarget) -> Result<String, StashError> {
    if selector_number(&target.selector).is_none() || !is_oid(&target.expected_oid) {
        return Err(invalid("Expected exact stash@{n} selector and full object ID").into());
    }
    let selector = format!("refs/{}", target.selector);
    let output = read_git(root, &["rev-parse", "--verify", &selector], 256)
        .map_err(|_| StashError::TargetChanged)?;
    let oid = std::str::from_utf8(&output)
        .map_err(|_| invalid("Invalid stash object ID"))?
        .trim();
    if !is_oid(oid) || !oid.eq_ignore_ascii_case(&target.expected_oid) {
        return Err(StashError::TargetChanged);
    }
    Ok(oid.to_ascii_lowercase())
}

#[derive(Clone)]
pub(crate) struct Commit {
    pub tree: String,
    pub parents: Vec<String>,
    pub encoding: StashEncoding,
    pub timestamp: i64,
}
fn commit(root: &str, oid: &str) -> Result<Commit, GitError> {
    if !is_oid(oid) {
        return Err(invalid("Expected full Git object ID"));
    }
    // `cat-file commit <oid>` peels annotated tags. Check the literal type first.
    let kind = read_git(root, &["cat-file", "-t", oid], 32)?;
    if kind != b"commit\n" {
        return Err(invalid("Expected literal commit object"));
    }
    let raw = read_git(root, &["cat-file", "commit", oid], 1024 * 1024)?;
    parse_commit(oid, &raw)
}

pub(crate) fn parse_commit(oid: &str, raw: &[u8]) -> Result<Commit, GitError> {
    let split = raw
        .windows(2)
        .position(|w| w == b"\n\n")
        .ok_or_else(|| invalid("Malformed commit headers"))?;
    let mut tree = None;
    let mut parents = Vec::new();
    let mut timestamp = None;
    let mut encoding = StashEncoding::Native;
    let mut encoding_seen = false;
    let mut previous_encoding = false;
    let mut author_seen = false;
    let mut parents_finished = false;
    for (position, line) in raw[..split].split(|b| *b == b'\n').enumerate() {
        if position == 0 && !line.starts_with(b"tree ") {
            return Err(invalid("Commit must begin with its tree"));
        }
        if line.starts_with(b" ") || line.starts_with(b"\t") {
            if previous_encoding {
                return Err(invalid("Continued stash encoding header"));
            }
            continue;
        }
        previous_encoding = false;
        let (key, value) = line.split_once_byte(b' ');
        if value.is_none() || key.is_empty() {
            return Err(invalid("Malformed commit header"));
        }
        if key != b"tree" && key != b"parent" {
            parents_finished = true;
        }
        if line.starts_with(b"gitgui-stash-encoding") {
            if key != b"gitgui-stash-encoding" {
                return Err(invalid("Malformed stash encoding header"));
            }
            if encoding_seen || value != Some(SELECTED_UNSTAGED_ENCODING.as_bytes()) {
                return Err(invalid("Unsupported or duplicate stash encoding header"));
            }
            encoding_seen = true;
            previous_encoding = true;
            encoding = StashEncoding::SelectedUnstagedV1;
        } else if key == b"tree" || key == b"parent" {
            let reference = value
                .and_then(|v| std::str::from_utf8(v).ok())
                .filter(|s| is_oid(s) && s.len() == oid.len())
                .ok_or_else(|| invalid("Invalid commit object reference"))?;
            if key == b"tree" {
                if position != 0 {
                    return Err(invalid("Misordered commit tree"));
                }
                if tree.replace(reference.to_owned()).is_some() {
                    return Err(invalid("Duplicate commit tree"));
                }
            } else {
                if parents_finished {
                    return Err(invalid("Misordered commit parent"));
                }
                parents.push(reference.to_owned());
            }
        } else if key == b"author" {
            if author_seen || timestamp.is_some() {
                return Err(invalid("Duplicate or misordered author"));
            }
            author_seen = true;
        } else if key == b"committer" {
            if !author_seen {
                return Err(invalid("Missing commit author"));
            }
            let value = value
                .and_then(|v| std::str::from_utf8(v).ok())
                .ok_or_else(|| invalid("Invalid committer"))?;
            let time = value
                .rsplit_once(' ')
                .and_then(|(v, _)| v.rsplit_once(' '))
                .and_then(|(_, t)| t.parse::<i64>().ok())
                .ok_or_else(|| invalid("Invalid commit timestamp"))?;
            if timestamp.replace(time).is_some() {
                return Err(invalid("Duplicate committer"));
            }
        }
    }
    if raw.contains(&0) {
        return Err(invalid("NUL in saved commit metadata"));
    }
    Ok(Commit {
        tree: tree.ok_or_else(|| invalid("Missing commit tree"))?,
        parents,
        encoding,
        timestamp: timestamp.ok_or_else(|| invalid("Missing committer"))?,
    })
}

// Byte parsing deliberately does not use lossy text conversion for paths/headers.
trait SplitByte {
    fn split_once_byte(&self, byte: u8) -> (&[u8], Option<&[u8]>);
}
impl SplitByte for [u8] {
    fn split_once_byte(&self, byte: u8) -> (&[u8], Option<&[u8]>) {
        match self.iter().position(|b| *b == byte) {
            Some(i) => (&self[..i], Some(&self[i + 1..])),
            None => (self, None),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TreeEntry {
    pub mode: String,
    pub oid: String,
}

// A flattened ls-tree path cannot distinguish a directory boundary from a
// corrupt basename containing '/'. Validate the literal binary records first.
fn validate_raw_tree(mut raw: &[u8], oid_bytes: usize) -> Result<(), GitError> {
    let mut names = BTreeSet::new();
    let mut previous = None;
    while !raw.is_empty() {
        let (mode, rest) = raw.split_once_byte(b' ');
        let rest = rest.ok_or_else(|| invalid("Malformed saved tree mode"))?;
        if !matches!(
            mode,
            b"40000" | b"100644" | b"100755" | b"120000" | b"160000"
        ) {
            return Err(invalid("Invalid saved tree mode"));
        }
        let (name, rest) = rest.split_once_byte(0);
        let rest = rest.ok_or_else(|| invalid("Malformed saved tree name"))?;
        let path = std::str::from_utf8(name)
            .map_err(|_| invalid("Non-UTF-8 saved Git path is unsupported"))?;
        validate_saved_path(path)?;
        if name.contains(&b'/') {
            return Err(invalid("Slash in saved tree basename"));
        }
        if !names.insert(name) {
            return Err(invalid("Duplicate saved tree entry"));
        }
        // Git compares directory names as if their final NUL were '/'.
        let mut key = name.to_vec();
        if mode == b"40000" {
            key.push(b'/');
        }
        if previous.as_ref().is_some_and(|previous| previous >= &key) {
            return Err(invalid("Unsorted saved tree entries"));
        }
        previous = Some(key);
        raw = rest
            .get(oid_bytes..)
            .ok_or_else(|| invalid("Truncated saved tree object ID"))?;
    }
    Ok(())
}
// The decoder's mutable caches belong to one read/listing. Inspection can retain
// an immutable object manifest separately, with fresh checks on subsequent reads.
// Once this bounded cache fills, objects are still checked without retention.
#[derive(Default)]
struct Validation {
    commits: BTreeMap<String, Arc<Commit>>,
    trees: BTreeMap<String, Arc<BTreeMap<String, TreeEntry>>>,
    raw_trees: BTreeSet<String>,
    types: BTreeMap<String, &'static str>,
    cached_bytes: usize,
    retention_exhausted: bool,
}
impl Validation {
    fn reserve(&mut self, bytes: usize) -> bool {
        if bytes > 64 * 1024 * 1024 - self.cached_bytes {
            self.retention_exhausted = true;
            return false;
        }
        self.cached_bytes += bytes;
        true
    }
    fn commit(&mut self, root: &str, oid: &str) -> Result<Arc<Commit>, GitError> {
        if let Some(commit) = self.commits.get(oid) {
            return Ok(commit.clone());
        }
        let value = Arc::new(commit(root, oid)?);
        if self.reserve(512 + value.parents.len() * 64) {
            self.commits.insert(oid.into(), value.clone());
        }
        Ok(value)
    }
    fn check_types(
        &mut self,
        root: &str,
        objects: BTreeMap<String, &'static str>,
    ) -> Result<(), GitError> {
        let mut pending = Vec::new();
        for (oid, kind) in objects {
            match self.types.get(&oid) {
                Some(previous) if *previous == kind => {}
                Some(_) => return Err(invalid("Invalid saved object type")),
                None => pending.push((oid, kind)),
            }
        }
        // Literal OIDs and a fixed two-field format bound both input and output.
        for chunk in pending.chunks(256) {
            let input = chunk
                .iter()
                .map(|(oid, _)| format!("{oid}\n"))
                .collect::<String>();
            let output = read_git_input(
                root,
                &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
                256 * 128,
                Some(input.as_bytes()),
            )?;
            let output = std::str::from_utf8(&output)
                .map_err(|_| invalid("Invalid object type metadata"))?;
            if output.lines().count() != chunk.len()
                || output
                    .lines()
                    .zip(chunk)
                    .any(|(line, (oid, kind))| line != format!("{oid} {kind}"))
            {
                return Err(invalid("Missing or invalid saved object"));
            }
            for (oid, kind) in chunk {
                if self.reserve(160) {
                    self.types.insert(oid.clone(), *kind);
                }
            }
        }
        Ok(())
    }
    fn check_raw_trees(&mut self, root: &str, trees: BTreeSet<String>) -> Result<(), GitError> {
        self.check_types(
            root,
            trees.iter().map(|oid| (oid.clone(), "tree")).collect(),
        )?;
        let pending = trees
            .into_iter()
            .filter(|oid| !self.raw_trees.contains(oid))
            .collect::<Vec<_>>();
        let mut remaining = METADATA_LIMIT;
        // Read only tree bytes, never blob contents. Bound both each batch and
        // the total raw metadata for this snapshot; shared subtrees are read once.
        for chunk in pending.chunks(256) {
            let input = chunk
                .iter()
                .map(|oid| format!("{oid}\n"))
                .collect::<String>();
            let output = read_git_input(
                root,
                &["cat-file", "--batch"],
                remaining,
                Some(input.as_bytes()),
            )?;
            remaining -= output.len();
            let mut records = output.as_slice();
            for oid in chunk {
                let (header, rest) = records.split_once_byte(b'\n');
                let rest = rest.ok_or_else(|| invalid("Invalid raw tree batch"))?;
                let header =
                    std::str::from_utf8(header).map_err(|_| invalid("Invalid raw tree batch"))?;
                let size = header
                    .strip_prefix(&format!("{oid} tree "))
                    .and_then(|size| size.parse::<usize>().ok())
                    .ok_or_else(|| invalid("Expected literal tree object"))?;
                let raw = rest
                    .get(..size)
                    .ok_or_else(|| invalid("Truncated raw tree batch"))?;
                validate_raw_tree(raw, oid.len() / 2)?;
                records = rest
                    .get(size..)
                    .and_then(|rest| rest.strip_prefix(b"\n"))
                    .ok_or_else(|| invalid("Invalid raw tree batch delimiter"))?;
                if self.reserve(128) {
                    self.raw_trees.insert(oid.clone());
                }
            }
            if !records.is_empty() {
                return Err(invalid("Unexpected raw tree batch output"));
            }
        }
        Ok(())
    }
    fn tree(
        &mut self,
        root: &str,
        tree: &str,
    ) -> Result<Arc<BTreeMap<String, TreeEntry>>, GitError> {
        if let Some(entries) = self.trees.get(tree) {
            return Ok(entries.clone());
        }
        if !is_oid(tree) {
            return Err(invalid("Expected full tree object ID"));
        }
        // ls-tree accepts commit-ish roots, so independently require a real tree.
        self.check_types(root, BTreeMap::from([(tree.to_owned(), "tree")]))?;
        let raw = read_git(
            root,
            &["ls-tree", "-r", "-t", "-z", "--full-tree", tree],
            METADATA_LIMIT,
        )?;
        // -t enumerates every referenced directory, including empty ones. Its
        // paths are not evidence of basename boundaries: check actual records
        // for the root and every subtree before constructing the flattened map.
        let mut trees = BTreeSet::from([tree.to_owned()]);
        for record in raw.split(|b| *b == 0).filter(|v| !v.is_empty()) {
            let (metadata, path) = record.split_once_byte(b'\t');
            let path = path
                .and_then(|path| std::str::from_utf8(path).ok())
                .ok_or_else(|| invalid("Non-UTF-8 saved Git path is unsupported"))?;
            validate_saved_path(path)?;
            if path.split('/').count() > 128 {
                return Err(invalid("Saved tree exceeds inspection depth limit"));
            }
            let metadata =
                std::str::from_utf8(metadata).map_err(|_| invalid("Invalid tree metadata"))?;
            let fields = metadata.split(' ').collect::<Vec<_>>();
            if fields.len() != 3 || !is_oid(fields[2]) || fields[2].len() != tree.len() {
                return Err(invalid("Invalid saved tree entry"));
            }
            if fields[0] == "040000" {
                trees.insert(fields[2].to_owned());
            }
        }
        self.check_raw_trees(root, trees)?;
        let mut entries = BTreeMap::new();
        let mut paths = BTreeSet::new();
        let mut objects = BTreeMap::new();
        for record in raw.split(|b| *b == 0).filter(|v| !v.is_empty()) {
            let (metadata, path) = record.split_once_byte(b'\t');
            let path = path
                .and_then(|p| std::str::from_utf8(p).ok())
                .ok_or_else(|| invalid("Non-UTF-8 saved Git path is unsupported"))?;
            // -t retains every recursive directory record, including empty and
            // duplicate directories. Validate these before flattening leaf paths.
            if !paths.insert(path.to_owned()) {
                return Err(invalid("Duplicate saved tree entry"));
            }
            let metadata =
                std::str::from_utf8(metadata).map_err(|_| invalid("Invalid tree metadata"))?;
            let fields: Vec<_> = metadata.split(' ').collect();
            if fields.len() != 3
                || !is_oid(fields[2])
                || fields[2].len() != tree.len()
                || !matches!(
                    (fields[0], fields[1]),
                    ("100644" | "100755" | "120000", "blob")
                        | ("160000", "commit")
                        | ("040000", "tree")
                )
            {
                return Err(invalid("Invalid saved tree entry"));
            }
            if fields[0] == "040000" {
                if objects
                    .insert(fields[2].into(), "tree")
                    .is_some_and(|kind| kind != "tree")
                {
                    return Err(invalid("Conflicting saved object types"));
                }
                continue;
            }
            if fields[0] != "160000"
                && objects
                    .insert(fields[2].into(), "blob")
                    .is_some_and(|kind| kind != "blob")
            {
                return Err(invalid("Conflicting saved object types"));
            }
            entries.insert(
                path.to_owned(),
                TreeEntry {
                    mode: fields[0].into(),
                    oid: fields[2].into(),
                },
            );
        }
        for path in &paths {
            for (i, byte) in path.bytes().enumerate() {
                if byte == b'/' && entries.contains_key(&path[..i]) {
                    return Err(invalid("Overlapping saved tree entries"));
                }
            }
        }
        // Gitlinks may belong to another repository; all other objects must
        // have the exact recorded type, without tag peeling or replacements.
        self.check_types(root, objects)?;
        let entries = Arc::new(entries);
        let cost = entries.keys().map(|p| p.len() + 256).sum::<usize>() + 128;
        if self.reserve(cost) {
            self.trees.insert(tree.into(), entries.clone());
        }
        Ok(entries)
    }
}

pub(crate) fn validate_saved_path(path: &str) -> Result<(), GitError> {
    if path.is_empty()
        || path.contains('\0')
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(invalid("Invalid saved Git path"));
    }
    Ok(())
}

fn overlaps(entries: &BTreeMap<String, TreeEntry>, path: &str) -> bool {
    if entries.contains_key(path) {
        return true;
    }
    for (i, byte) in path.bytes().enumerate() {
        if byte == b'/' && entries.contains_key(&path[..i]) {
            return true;
        }
    }
    let prefix = format!("{path}/");
    entries
        .range(prefix.clone()..)
        .next()
        .is_some_and(|(key, _)| key.starts_with(&prefix))
}

pub fn decode_stash(root: &str, oid: &str) -> Result<StashLayout, StashError> {
    decode_with_validation(root, oid, &mut Validation::default())
}

/// Strict inspection reuses the trees already checked by the shared decoder.
/// Foreground display uses a separate changed-object plan in `stash_read`.
pub(crate) struct StashObjects {
    pub layout: StashLayout,
    pub before: Arc<BTreeMap<String, TreeEntry>>,
    pub after: Arc<BTreeMap<String, TreeEntry>>,
    pub untracked: Arc<BTreeMap<String, TreeEntry>>,
}

impl StashObjects {
    pub fn load(root: &str, target: &StashTarget) -> Result<Self, StashError> {
        let oid = resolve_stash_oid(root, target)?;
        Self::load_oid(root, &oid)
    }

    pub fn load_oid(root: &str, oid: &str) -> Result<Self, StashError> {
        let mut validation = Validation::default();
        let layout = decode_with_validation(root, oid, &mut validation)?;
        let mut tree = |oid: &str| -> Result<_, GitError> {
            let commit = validation.commit(root, oid)?;
            validation.tree(root, &commit.tree)
        };
        let before = tree(&layout.baseline_oid)?;
        let after = tree(&layout.stash_oid)?;
        let untracked = match &layout.untracked_oid {
            Some(oid) => tree(oid)?,
            None => Arc::new(BTreeMap::new()),
        };
        Ok(Self {
            layout,
            before,
            after,
            untracked,
        })
    }
}

fn decode_with_validation(
    root: &str,
    oid: &str,
    validation: &mut Validation,
) -> Result<StashLayout, StashError> {
    let w = validation.commit(root, oid)?;
    if !(2..=3).contains(&w.parents.len()) {
        return Err(invalid("Stash must have two or three ordered parents").into());
    }
    let p = validation.commit(root, &w.parents[0])?;
    let i = validation.commit(root, &w.parents[1])?;
    if i.parents != [w.parents[0].clone()] || i.encoding != StashEncoding::Native {
        return Err(invalid("Invalid saved index parent").into());
    }
    let original = if w.encoding == StashEncoding::SelectedUnstagedV1 {
        if p.parents.len() != 1 || p.tree != i.tree || p.encoding != StashEncoding::Native {
            return Err(invalid("Invalid selected-unstaged baseline").into());
        }
        let h = validation.commit(root, &p.parents[0])?;
        validation.tree(root, &h.tree)?;
        p.parents[0].clone()
    } else {
        w.parents[0].clone()
    };
    let tracked_p = validation.tree(root, &p.tree)?;
    let tracked_i = validation.tree(root, &i.tree)?;
    let tracked_w = validation.tree(root, &w.tree)?;
    if let Some(u_oid) = w.parents.get(2) {
        let u = validation.commit(root, u_oid)?;
        if !u.parents.is_empty() || u.encoding != StashEncoding::Native {
            return Err(invalid("Invalid untracked stash parent").into());
        }
        for path in validation.tree(root, &u.tree)?.keys() {
            for tracked in [&tracked_p, &tracked_i, &tracked_w] {
                if overlaps(tracked, path) {
                    return Err(invalid("Saved untracked and tracked paths overlap").into());
                }
            }
        }
    }
    Ok(StashLayout {
        stash_oid: oid.to_ascii_lowercase(),
        original_head_oid: original,
        baseline_oid: w.parents[0].clone(),
        index_oid: w.parents[1].clone(),
        untracked_oid: w.parents.get(2).cloned(),
        encoding: w.encoding,
    })
}

pub fn read_stash_info(root: &str, target: &StashTarget) -> Result<StashInfo, StashError> {
    read_stash_info_with_layout(root, target).map(|(info, _)| info)
}

fn read_stash_info_with_layout(
    root: &str,
    target: &StashTarget,
) -> Result<(StashInfo, StashLayout), StashError> {
    let layout = resolve_stash(root, target)?;
    let w = commit(root, &layout.stash_oid)?;
    let info = read_stash_metadata(root, target, &layout, w.timestamp)?;
    Ok((info, layout))
}

pub(crate) fn read_stash_metadata(
    root: &str,
    target: &StashTarget,
    layout: &StashLayout,
    timestamp: i64,
) -> Result<StashInfo, StashError> {
    if !target.expected_oid.eq_ignore_ascii_case(&layout.stash_oid)
        || selector_number(&target.selector).is_none()
    {
        return Err(StashError::TargetChanged);
    }
    // A reflog subject can differ from W's subject (`stash store -m`). NUL
    // separates the fixed identity field; control characters in a label remain
    // ordinary text. Recheck identity in this same reflog read.
    let raw = read_git(
        root,
        &[
            "reflog",
            "show",
            "-1",
            "-z",
            "--format=%H%x00%gs",
            &format!("refs/{}", target.selector),
        ],
        1024 * 1024,
    )?;
    let (oid, subject) = raw.split_once_byte(0);
    if oid != layout.stash_oid.as_bytes() {
        return Err(StashError::TargetChanged);
    }
    let subject = subject
        .and_then(|s| s.strip_suffix(&[0]))
        .ok_or_else(|| invalid("Invalid stash reflog metadata"))?;
    if subject.contains(&0) {
        return Err(invalid("Invalid stash reflog subject").into());
    }
    Ok(stash_info(target, layout, timestamp, subject))
}

pub(crate) fn stash_info(
    target: &StashTarget,
    layout: &StashLayout,
    timestamp: i64,
    subject: &[u8],
) -> StashInfo {
    let subject = String::from_utf8_lossy(subject);
    let (branch, message) = super::repository::parse_stash_subject(&subject);
    StashInfo {
        hash: layout.stash_oid.clone(),
        selector: target.selector.clone(),
        base_hash: layout.original_head_oid.clone(),
        index_hash: Some(layout.index_oid.clone()),
        branch,
        message,
        timestamp,
    }
}

/// Invalid entries are omitted, never interpreted using a weaker fallback.
pub fn list_stashes(root: &str) -> Result<Vec<StashInfo>, GitError> {
    Ok(list_stashes_with_layout(root)?
        .into_iter()
        .map(|(info, _)| info)
        .collect())
}

// The snapshot loader consumes the layout validated for the info record, avoiding
// a second full graph/tree scan for every stash in every repository refresh.
pub(crate) fn list_stashes_with_layout(
    root: &str,
) -> Result<Vec<(StashInfo, StashLayout)>, GitError> {
    match GitCommand::run(
        &[
            "--no-replace-objects",
            "show-ref",
            "--verify",
            "--quiet",
            "refs/stash",
        ],
        Some(Path::new(root)),
    ) {
        Ok(_) => {}
        Err(error) if error.status == Some(1) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    }
    let raw = read_git(
        root,
        &[
            "reflog",
            "show",
            "-z",
            "--format=%gD%x00%H%x00%gs",
            "refs/stash",
        ],
        METADATA_LIMIT,
    )?;
    // One bounded reflog snapshot supplies both identity and subject. All
    // entries share immutable-object validation for this listing only.
    let mut validation = Validation::default();
    let mut infos = Vec::new();
    if raw.is_empty() {
        return Ok(infos);
    }
    let mut fields = raw.strip_suffix(&[0]).unwrap_or(&raw).split(|b| *b == 0);
    while let Some(selector) = fields.next() {
        let selector = std::str::from_utf8(selector)
            .ok()
            .and_then(|s| s.strip_prefix("refs/"))
            .filter(|s| selector_number(s).is_some())
            .ok_or_else(|| invalid("Invalid stash reflog selector"))?;
        let oid = fields
            .next()
            .ok_or_else(|| invalid("Invalid stash reflog metadata"))?;
        let subject = fields
            .next()
            .ok_or_else(|| invalid("Invalid stash reflog metadata"))?;
        if oid.len() + subject.len() + 2 > 1024 * 1024 {
            continue;
        }
        let oid = std::str::from_utf8(oid).map_err(|_| invalid("Invalid reflog object ID"))?;
        let target = StashTarget {
            // Git omits non-commit reflog entries (e.g. annotated tags). Use
            // the actual selector, never renumber the remaining records.
            selector: selector.into(),
            expected_oid: oid.into(),
        };
        if let Ok(layout) = decode_with_validation(root, oid, &mut validation) {
            let timestamp = validation.commit(root, oid)?.timestamp;
            infos.push((stash_info(&target, &layout, timestamp, subject), layout));
        }
    }
    Ok(infos)
}

#[cfg(test)]
mod tests {
    use super::super::command::test_metrics;
    use super::*;

    #[test]
    fn object_type_batches_are_bounded_and_cached_within_one_read() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        read_git(root, &["init", "-q"], 1024).unwrap();
        let mut paths = String::new();
        for n in 0..300 {
            let path = format!("blob-{n}");
            std::fs::write(dir.path().join(&path), format!("content {n}")).unwrap();
            paths.push_str(&format!("{path}\n"));
        }
        let oids = read_git_input(
            root,
            &["hash-object", "-w", "--stdin-paths"],
            300 * 128,
            Some(paths.as_bytes()),
        )
        .unwrap();
        let objects = std::str::from_utf8(&oids)
            .unwrap()
            .lines()
            .map(|oid| (oid.to_owned(), "blob"))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(objects.len(), 300);
        let mut validation = Validation::default();
        test_metrics::take();
        validation.check_types(root, objects.clone()).unwrap();
        assert_eq!(test_metrics::take().0, 2); // 256 + 44 objects
        validation.check_types(root, objects).unwrap();
        assert_eq!(test_metrics::take().0, 0);
    }

    #[test]
    fn raw_tree_batches_are_bounded_and_shared_between_snapshot_roots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        read_git(root, &["init", "-q"], 1024).unwrap();
        let blob =
            read_git_input(root, &["hash-object", "-w", "--stdin"], 128, Some(b"blob")).unwrap();
        let blob = std::str::from_utf8(&blob).unwrap().trim();
        let oid_bytes = (0..blob.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&blob[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let mut paths = String::new();
        for n in 0..300 {
            let path = format!("tree-{n}");
            let mut raw = format!("100644 file-{n}\0").into_bytes();
            raw.extend_from_slice(&oid_bytes);
            std::fs::write(dir.path().join(&path), raw).unwrap();
            paths.push_str(&format!("{path}\n"));
        }
        let oids = read_git_input(
            root,
            &["hash-object", "-w", "-t", "tree", "--stdin-paths"],
            300 * 128,
            Some(paths.as_bytes()),
        )
        .unwrap();
        let trees = std::str::from_utf8(&oids)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        assert_eq!(trees.len(), 300);
        let mut validation = Validation::default();
        test_metrics::take();
        validation.check_raw_trees(root, trees.clone()).unwrap();
        assert_eq!(test_metrics::take().0, 4); // 2 type batches + 2 raw batches
        validation.check_raw_trees(root, trees).unwrap();
        assert_eq!(test_metrics::take().0, 0);
        // A different snapshot root referencing a known subtree needs only its
        // own type and raw batch, with no reread of that shared subtree.
        let child = validation.raw_trees.first().unwrap().clone();
        let parent = read_git_input(
            root,
            &["mktree"],
            128,
            Some(format!("040000 tree {child}\tchild\n").as_bytes()),
        )
        .unwrap();
        let parent = std::str::from_utf8(&parent).unwrap().trim().to_owned();
        test_metrics::take();
        validation
            .check_raw_trees(root, BTreeSet::from([parent.clone(), child]))
            .unwrap();
        assert_eq!(test_metrics::take().0, 2);
        assert!(validation.raw_trees.contains(&parent));
    }

    #[test]
    fn listing_reuses_snapshot_trees_and_deduplicates_a_thousand_blob_references() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let git = |args: &[&str]| {
            GitCommand::run(args, Some(dir.path()))
                .unwrap()
                .trim()
                .to_owned()
        };
        let input = |args: &[&str], bytes: &[u8]| {
            GitCommand::run_with_stdin(args, Some(dir.path()), bytes)
                .unwrap()
                .trim()
                .to_owned()
        };
        git(&["init", "-q", "-b", "main"]);
        let blob = input(&["hash-object", "-w", "--stdin"], b"shared content\n");
        let records = (0..1000)
            .map(|n| format!("100644 blob {blob}\tfile-{n:04}\0"))
            .collect::<String>();
        let tree = input(&["mktree", "-z"], records.as_bytes());
        let commit = |parents: &[&str], header: bool, label: &str| {
            let parents = parents
                .iter()
                .map(|p| format!("parent {p}\n"))
                .collect::<String>();
            let header = if header {
                format!("{STASH_ENCODING_HEADER}\n")
            } else {
                String::new()
            };
            input(&["hash-object", "-w", "-t", "commit", "--stdin"],
                format!("tree {tree}\n{parents}author Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n{header}\n{label}\n").as_bytes())
        };
        let h = commit(&[], false, "original");
        let p = commit(&[&h], false, "baseline");
        let i = commit(&[&p], false, "index");
        let w = (0..3)
            .map(|n| commit(&[&p, &i], true, &format!("stash {n}")))
            .collect::<Vec<_>>();
        git(&["update-ref", "refs/heads/main", &h]);
        // update-ref reflogs need a configured committer.
        git(&["config", "user.name", "Fixture"]);
        git(&["config", "user.email", "fixture@example.invalid"]);
        git(&["update-ref", "--create-reflog", "refs/stash", &w[0]]);
        test_metrics::take();
        assert_eq!(list_stashes(root).unwrap().len(), 1);
        let one = test_metrics::take().0;
        for oid in &w[1..] {
            git(&["update-ref", "--create-reflog", "refs/stash", oid]);
        }
        test_metrics::take();
        assert_eq!(list_stashes(root).unwrap().len(), 3);
        let three = test_metrics::take().0;
        // Only each new W needs a type and raw commit read. H/P/I, the
        // thousand-entry tree, and its repeated blob OID are checked once.
        assert_eq!(three, one + 4);
        assert!(one <= 14, "one listing used {one} subprocesses");
        for (n, oid) in w.iter().rev().enumerate() {
            read_stash_info(
                root,
                &StashTarget {
                    selector: format!("stash@{{{n}}}"),
                    expected_oid: oid.clone(),
                },
            )
            .unwrap();
        }
        let separate = test_metrics::take().0;
        assert!(three < separate);
        eprintln!("1000 files: one-entry listing={one}, three-entry listing={three}, three independent info reads={separate} Git subprocesses");
    }
}
