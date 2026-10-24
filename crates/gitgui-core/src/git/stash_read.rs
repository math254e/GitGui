//! Foreground stash inspection: commit metadata and changed objects only.
//!
//! Strict whole-layout validation remains in `stash` for mutations and background
//! verification. A file list must not first walk every unchanged saved tree/blob.
use super::{
    command::{GitCommand, GitError},
    repository::{classify_content, file_diff, CommitFile, CommitFileDiff, FileContent, StashInfo},
    stash::{
        invalid, is_oid, parse_commit, read_git, read_git_input, read_stash_metadata,
        selector_number, stash_info, validate_saved_path, Commit, StashEncoding, StashError,
        StashLayout, StashTarget, TreeEntry,
    },
    stash_inspection::STASH_CONTENT_LIMIT,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

const METADATA_LIMIT: usize = 32 * 1024 * 1024;
const COMMIT_LIMIT: usize = 1024 * 1024;

fn metadata_layout(oid: &str, w: &Commit, parents: &[Commit]) -> Result<StashLayout, GitError> {
    if !(2..=3).contains(&w.parents.len()) || parents.len() != w.parents.len() {
        return Err(invalid("Stash must have two or three ordered parents"));
    }
    let (p, i) = (&parents[0], &parents[1]);
    if i.parents != [w.parents[0].clone()] || i.encoding != StashEncoding::Native {
        return Err(invalid("Invalid saved index parent"));
    }
    let original_head_oid = if w.encoding == StashEncoding::SelectedUnstagedV1 {
        if p.parents.len() != 1 || p.tree != i.tree || p.encoding != StashEncoding::Native {
            return Err(invalid("Invalid selected-unstaged baseline"));
        }
        p.parents[0].clone()
    } else {
        w.parents[0].clone()
    };
    if parents
        .get(2)
        .is_some_and(|u| !u.parents.is_empty() || u.encoding != StashEncoding::Native)
    {
        return Err(invalid("Invalid untracked stash parent"));
    }
    Ok(StashLayout {
        stash_oid: oid.to_ascii_lowercase(),
        original_head_oid,
        baseline_oid: w.parents[0].clone(),
        index_oid: w.parents[1].clone(),
        untracked_oid: w.parents.get(2).cloned(),
        encoding: w.encoding,
    })
}

/// Repository display metadata is read in bounded commit batches. Saved trees
/// are verified later; opening a repository must not audit every stash's blobs.
pub fn list_stashes_for_display(root: &str) -> Result<Vec<(StashInfo, StashLayout)>, GitError> {
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
    let mut fields = nul_fields(&raw).map_err(|error| match error {
        StashError::Invalid(error) => error,
        _ => invalid("Invalid stash listing"),
    })?;
    let mut entries = Vec::new();
    while let Some(selector) = fields.next() {
        let selector = std::str::from_utf8(selector)
            .ok()
            .and_then(|selector| selector.strip_prefix("refs/"))
            .filter(|selector| selector_number(selector).is_some())
            .ok_or_else(|| invalid("Invalid stash reflog selector"))?;
        let oid = fields
            .next()
            .ok_or_else(|| invalid("Missing stash reflog object ID"))?;
        let subject = fields
            .next()
            .ok_or_else(|| invalid("Missing stash reflog subject"))?;
        if oid.len() + subject.len() + 2 > COMMIT_LIMIT {
            continue;
        }
        let oid = std::str::from_utf8(oid)
            .ok()
            .filter(|oid| is_oid(oid))
            .ok_or_else(|| invalid("Invalid stash reflog object ID"))?;
        entries.push((
            StashTarget {
                selector: selector.into(),
                expected_oid: oid.to_ascii_lowercase(),
            },
            subject,
        ));
    }
    let mut objects = BTreeMap::new();
    read_commits_into(
        root,
        entries
            .iter()
            .map(|(target, _)| target.expected_oid.clone()),
        &mut objects,
    )?;
    let parents = objects
        .values()
        .filter(|w| (2..=3).contains(&w.parents.len()))
        .flat_map(|w| w.parents.iter().cloned())
        .collect::<BTreeSet<_>>();
    read_commits_into(root, parents.into_iter(), &mut objects)?;
    let heads = entries
        .iter()
        .filter_map(|(target, _)| {
            let w = objects.get(&target.expected_oid)?;
            if w.encoding != StashEncoding::SelectedUnstagedV1 {
                return None;
            }
            let p = objects.get(w.parents.first()?)?;
            (p.parents.len() == 1).then(|| p.parents[0].clone())
        })
        .collect::<BTreeSet<_>>();
    read_commits_into(root, heads.into_iter(), &mut objects)?;
    let mut stashes = Vec::new();
    for (target, subject) in entries {
        let Some(w) = objects.get(&target.expected_oid) else {
            continue;
        };
        let Some(parents) = w
            .parents
            .iter()
            .map(|oid| objects.get(oid).cloned())
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        if let Ok(layout) = metadata_layout(&target.expected_oid, w, &parents) {
            if objects.contains_key(&layout.original_head_oid) {
                stashes.push((stash_info(&target, &layout, w.timestamp, subject), layout));
            }
        }
    }
    Ok(stashes)
}

fn read_commits_into(
    root: &str,
    oids: impl Iterator<Item = String>,
    objects: &mut BTreeMap<String, Commit>,
) -> Result<(), GitError> {
    let missing = oids
        .filter(|oid| !objects.contains_key(oid))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    for batch in missing.chunks(16) {
        let ids = batch.iter().map(String::as_str).collect::<Vec<_>>();
        let results = commit_batch(root, &ids).unwrap_or_else(|_| {
            // A single oversized/corrupt object must not suppress healthy stash
            // entries in its batch. Exceptional reads retry separately, still
            // bounded to one commit's limit, without penalizing normal batches.
            ids.iter()
                .map(|oid| commit_batch(root, &[*oid]).and_then(|mut results| results.remove(0)))
                .collect()
        });
        for (oid, object) in batch.iter().zip(results) {
            if let Ok(object) = object {
                objects.insert(oid.clone(), object);
            }
        }
    }
    Ok(())
}

struct Change {
    before: Option<TreeEntry>,
    after: Option<TreeEntry>,
}

pub(crate) struct StashReadPlan {
    pub layout: StashLayout,
    pub files: Vec<CommitFile>,
    changes: BTreeMap<String, Change>,
    timestamp: i64,
}

impl StashReadPlan {
    pub fn load_oid(root: &str, oid: &str) -> Result<Self, StashError> {
        let w = commits(root, &[oid])?.remove(0);
        if !(2..=3).contains(&w.parents.len()) {
            return Err(invalid("Stash must have two or three ordered parents").into());
        }
        let parent_oids = w.parents.iter().map(String::as_str).collect::<Vec<_>>();
        let parents = commits(root, &parent_oids)?;
        let layout = metadata_layout(oid, &w, &parents)?;
        if w.encoding == StashEncoding::SelectedUnstagedV1 {
            // Read the literal original commit without walking its tree.
            commits(root, &[&layout.original_head_oid])?;
        }
        let raw = read_git(
            root,
            &[
                "diff-tree",
                "--no-commit-id",
                "-r",
                "-z",
                "--raw",
                "--no-abbrev",
                "--find-renames",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=none",
                "--no-relative",
                "--no-color",
                &layout.baseline_oid,
                &layout.stash_oid,
                "--",
            ],
            METADATA_LIMIT,
        )?;
        let (mut files, mut changes) = parse_changes(&raw, oid.len())?;
        if let Some(u) = layout.untracked_oid.as_deref() {
            let raw = read_git(
                root,
                &["ls-tree", "-r", "-z", "--full-tree", u],
                METADATA_LIMIT,
            )?;
            for (path, entry) in parse_untracked(&raw, oid.len())? {
                if changes.contains_key(&path) {
                    return Err(invalid("Saved untracked and changed tracked paths overlap").into());
                }
                files.push(CommitFile {
                    path: path.clone(),
                    original_path: None,
                    status: "A".into(),
                });
                changes.insert(
                    path,
                    Change {
                        before: None,
                        after: Some(entry),
                    },
                );
            }
        }
        Ok(Self {
            layout,
            files,
            changes,
            timestamp: w.timestamp,
        })
    }

    pub fn info(&self, root: &str, target: &StashTarget) -> Result<StashInfo, StashError> {
        read_stash_metadata(root, target, &self.layout, self.timestamp)
    }

    pub fn diff(&self, root: &str, path: &str) -> Result<CommitFileDiff, StashError> {
        validate_saved_path(path)?;
        let change = self
            .changes
            .get(path)
            .ok_or_else(|| invalid("Path is not a saved stash change"))?;
        let file = self
            .files
            .iter()
            .find(|file| file.path == path)
            .expect("change has file metadata");
        let original = content(root, change.before.as_ref())?;
        let modified = content(root, change.after.as_ref())?;
        Ok(file_diff(
            change
                .before
                .as_ref()
                .map(|_| file.original_path.as_deref().unwrap_or(path).into()),
            path.into(),
            original,
            modified,
        )?)
    }

    pub fn retained_bytes(&self) -> usize {
        1024 + self
            .files
            .iter()
            .map(|file| {
                256 + file.path.len()
                    + file.original_path.as_ref().map_or(0, String::len)
                    + file.status.len()
            })
            .sum::<usize>()
            + self
                .changes
                .iter()
                .map(|(path, _)| path.len() + 512)
                .sum::<usize>()
    }
}

// `--batch` returns the literal object type, unlike `cat-file commit`, which
// peels tags. Two batches read W, then its parents, independent of tree size.
fn commits(root: &str, oids: &[&str]) -> Result<Vec<Commit>, StashError> {
    Ok(commit_batch(root, oids)?
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?)
}

fn commit_batch(root: &str, oids: &[&str]) -> Result<Vec<Result<Commit, GitError>>, GitError> {
    if oids.is_empty() || oids.len() > 16 || oids.iter().any(|oid| !is_oid(oid)) {
        return Err(invalid("Expected bounded full commit object IDs").into());
    }
    let input = format!("{}\n", oids.join("\n"));
    let raw = read_git_input(
        root,
        &["cat-file", "--batch"],
        oids.len() * (COMMIT_LIMIT + 256),
        Some(input.as_bytes()),
    )?;
    let mut remaining = raw.as_slice();
    let mut result = Vec::with_capacity(oids.len());
    for oid in oids {
        let end = remaining
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| invalid("Malformed saved commit batch"))?;
        let header = std::str::from_utf8(&remaining[..end])
            .map_err(|_| invalid("Invalid saved commit batch header"))?;
        let fields = header.split(' ').collect::<Vec<_>>();
        remaining = &remaining[end + 1..];
        if fields.len() == 2 && fields[0].eq_ignore_ascii_case(oid) && fields[1] == "missing" {
            result.push(Err(invalid("Missing saved commit object")));
            continue;
        }
        if fields.len() != 3 || !fields[0].eq_ignore_ascii_case(oid) {
            return Err(invalid("Malformed saved object batch identity"));
        }
        let size = fields[2]
            .parse::<usize>()
            .ok()
            .filter(|size| *size <= COMMIT_LIMIT)
            .ok_or_else(|| invalid("Saved commit exceeds inspection limit"))?;
        if remaining.len() <= size || remaining[size] != b'\n' {
            return Err(invalid("Truncated saved commit batch").into());
        }
        result.push(if fields[1] == "commit" {
            parse_commit(oid, &remaining[..size])
        } else {
            Err(invalid("Expected literal saved commit object"))
        });
        remaining = &remaining[size + 1..];
    }
    if !remaining.is_empty() {
        return Err(invalid("Unexpected saved commit batch output").into());
    }
    Ok(result)
}

fn path(raw: &[u8]) -> Result<String, StashError> {
    let path =
        std::str::from_utf8(raw).map_err(|_| invalid("Non-UTF-8 saved Git path is unsupported"))?;
    validate_saved_path(path)?;
    Ok(path.into())
}

fn entry(mode: &str, oid: &str, oid_len: usize) -> Result<Option<TreeEntry>, StashError> {
    if oid.len() != oid_len || !is_oid(oid) {
        return Err(invalid("Invalid saved change object ID").into());
    }
    if mode == "000000" && oid.bytes().all(|byte| byte == b'0') {
        return Ok(None);
    }
    if !matches!(mode, "100644" | "100755" | "120000" | "160000")
        || oid.bytes().all(|byte| byte == b'0')
    {
        return Err(invalid("Invalid saved change mode or object ID").into());
    }
    Ok(Some(TreeEntry {
        mode: mode.into(),
        oid: oid.into(),
    }))
}

fn nul_fields(raw: &[u8]) -> Result<impl Iterator<Item = &[u8]>, StashError> {
    let raw = if raw.is_empty() {
        raw
    } else {
        raw.strip_suffix(&[0])
            .ok_or_else(|| invalid("Unterminated saved file record"))?
    };
    Ok(raw
        .split(|byte| *byte == 0)
        .take(if raw.is_empty() { 0 } else { usize::MAX }))
}

fn parse_changes(
    raw: &[u8],
    oid_len: usize,
) -> Result<(Vec<CommitFile>, BTreeMap<String, Change>), StashError> {
    let mut fields = nul_fields(raw)?;
    let mut files = Vec::new();
    let mut changes = BTreeMap::new();
    while let Some(header) = fields.next() {
        let header =
            std::str::from_utf8(header).map_err(|_| invalid("Invalid saved change header"))?;
        let header = header
            .strip_prefix(':')
            .ok_or_else(|| invalid("Malformed raw saved change"))?;
        let columns = header.split(' ').collect::<Vec<_>>();
        if columns.len() != 5 {
            return Err(invalid("Malformed raw saved change fields").into());
        }
        let status = columns[4];
        let kind = status
            .as_bytes()
            .first()
            .copied()
            .ok_or_else(|| invalid("Missing saved change status"))?;
        let scored = matches!(kind, b'R' | b'C' | b'M');
        if !matches!(kind, b'A' | b'M' | b'D' | b'R' | b'C' | b'T')
            || (status.len() > 1
                && (!scored
                    || !status[1..].bytes().all(|b| b.is_ascii_digit())
                    || status[1..].parse::<u16>().map_or(true, |score| score > 100)))
            || (matches!(kind, b'R' | b'C') && status.len() == 1)
        {
            return Err(invalid("Unsupported saved change status").into());
        }
        let before = entry(columns[0], columns[2], oid_len)?;
        let after = entry(columns[1], columns[3], oid_len)?;
        if !matches!(
            (kind, before.is_some(), after.is_some()),
            (b'A', false, true) | (b'D', true, false) | (b'M' | b'R' | b'C' | b'T', true, true)
        ) {
            return Err(invalid("Inconsistent saved change sides").into());
        }
        let first = path(
            fields
                .next()
                .ok_or_else(|| invalid("Missing saved change path"))?,
        )?;
        let (path, original_path) = if matches!(kind, b'R' | b'C') {
            (
                path(
                    fields
                        .next()
                        .ok_or_else(|| invalid("Missing saved rename path"))?,
                )?,
                Some(first),
            )
        } else {
            (first, None)
        };
        if changes
            .insert(path.clone(), Change { before, after })
            .is_some()
        {
            return Err(invalid("Duplicate saved change path").into());
        }
        files.push(CommitFile {
            path,
            original_path,
            status: status.into(),
        });
    }
    Ok((files, changes))
}

fn parse_untracked(raw: &[u8], oid_len: usize) -> Result<BTreeMap<String, TreeEntry>, StashError> {
    let mut entries = BTreeMap::new();
    for record in nul_fields(raw)? {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| invalid("Malformed saved untracked entry"))?;
        let header = std::str::from_utf8(&record[..tab])
            .map_err(|_| invalid("Invalid saved untracked header"))?;
        let columns = header.split(' ').collect::<Vec<_>>();
        if columns.len() != 3
            || columns[1]
                != if columns[0] == "160000" {
                    "commit"
                } else {
                    "blob"
                }
        {
            return Err(invalid("Invalid saved untracked object type").into());
        }
        let entry = entry(columns[0], columns[2], oid_len)?
            .ok_or_else(|| invalid("Missing saved untracked object"))?;
        if entries.insert(path(&record[tab + 1..])?, entry).is_some() {
            return Err(invalid("Duplicate saved untracked path").into());
        }
    }
    Ok(entries)
}

fn content(root: &str, entry: Option<&TreeEntry>) -> Result<FileContent, StashError> {
    let Some(entry) = entry else {
        return Ok(FileContent::Text(String::new()));
    };
    if entry.mode == "160000" {
        return Ok(FileContent::Missing(
            "Submodule content cannot be displayed.".into(),
        ));
    }
    // Literal type/size in one query: never peel a malformed tag into a blob.
    let raw = read_git_input(
        root,
        &[
            "cat-file",
            "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        ],
        256,
        Some(format!("{}\n", entry.oid).as_bytes()),
    )?;
    let header = std::str::from_utf8(&raw).map_err(|_| invalid("Invalid saved blob metadata"))?;
    let fields = header.trim_end_matches('\n').split(' ').collect::<Vec<_>>();
    if fields.len() != 3 || fields[0] != entry.oid || fields[1] != "blob" {
        return Err(invalid("Expected literal saved blob object").into());
    }
    let size = fields[2]
        .parse::<u64>()
        .map_err(|_| invalid("Invalid saved blob size"))?;
    if size > STASH_CONTENT_LIMIT as u64 {
        return Ok(FileContent::Missing(format!(
            "Saved file exceeds the {} MiB inspection limit.",
            STASH_CONTENT_LIMIT / 1024 / 1024
        )));
    }
    Ok(classify_content(read_git(
        root,
        &["cat-file", "blob", &entry.oid],
        STASH_CONTENT_LIMIT,
    )?))
}

#[cfg(test)]
#[path = "../../tests/support/stash_read.rs"]
mod tests;
