use super::command::{git_command, GitCommand, GitError};
use super::operations::change_tag_refs;
use super::stash::{invalid, is_oid, read_git};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagFetchConflict {
    pub name: String,
    pub local_object_id: String,
    pub remote_object_id: String,
}
pub struct TagFetchOutcome {
    pub remote: String,
    pub conflicts: Vec<TagFetchConflict>,
}
pub struct PushOutcome {
    pub tag_error: Option<String>,
}
pub struct TagDetails {
    pub annotated: bool,
    pub message: Option<String>,
    pub tagger: Option<String>,
    pub timestamp: Option<i64>,
    pub has_signature: bool,
}

fn git(root: &str, args: &[&str]) -> Result<String, GitError> {
    GitCommand::run(args, Some(Path::new(root)))
}

/// One config read and one HEAD read per sync, regardless of the tag count.
struct SyncConfig {
    values: HashMap<String, Vec<String>>,
    branch: Option<String>,
    remote: String,
}
impl SyncConfig {
    fn load(root: &str, pushing: bool) -> Result<Self, GitError> {
        let raw = git(root, &["config", "--null", "--list"])?;
        let mut values: HashMap<String, Vec<String>> = HashMap::new();
        for entry in raw.split('\0').filter(|entry| !entry.is_empty()) {
            let (key, value) = entry.split_once('\n').unwrap_or((entry, "true"));
            if key.starts_with("remote.") || key.starts_with("branch.") || key.starts_with("push.")
            {
                values
                    .entry(key.to_owned())
                    .or_default()
                    .push(value.to_owned());
            }
        }
        let branch = match git(root, &["symbolic-ref", "--quiet", "HEAD"]) {
            Ok(value) => value.trim().strip_prefix("refs/heads/").map(str::to_owned),
            Err(error) if error.status == Some(1) => None,
            Err(error) => return Err(error),
        };
        let mut config = Self {
            values,
            branch,
            remote: String::new(),
        };
        let names = config
            .values
            .keys()
            .filter_map(|key| key.strip_prefix("remote.")?.strip_suffix(".url"))
            .collect::<Vec<_>>();
        let fetch_remote = config
            .branch
            .as_ref()
            .and_then(|branch| config.get(&format!("branch.{branch}.remote")));
        let selected = if pushing {
            config
                .branch
                .as_ref()
                .and_then(|branch| config.get(&format!("branch.{branch}.pushremote")))
                .or_else(|| config.get("remote.pushdefault"))
                .or(fetch_remote)
        } else {
            fetch_remote
        };
        let remote = selected
            .or_else(|| names.contains(&"origin").then_some("origin"))
            .or_else(|| (names.len() == 1).then(|| names[0]))
            .ok_or_else(|| invalid("Configure a default remote before syncing tags"))?;
        if !names.contains(&remote) {
            return Err(invalid("The configured remote is not a named Git remote"));
        }
        config.remote = remote.to_owned();
        Ok(config)
    }
    fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key)?.last().map(String::as_str)
    }
    fn specs(&self, kind: &str) -> Vec<String> {
        self.values
            .get(&format!("remote.{}.{kind}", self.remote))
            .cloned()
            .unwrap_or_default()
    }
    fn push_specs(&self) -> Result<(Vec<String>, bool), GitError> {
        let configured = self.specs("push");
        if !configured.is_empty() {
            return Ok((configured, false));
        }
        let Some(branch) = &self.branch else {
            return Ok((vec![], false));
        };
        let mode = self.get("push.default").unwrap_or("simple");
        let source = format!("refs/heads/{branch}");
        let upstream = self.get(&format!("branch.{branch}.merge"));
        let triangular = self
            .get(&format!("branch.{branch}.remote"))
            .is_some_and(|remote| remote != self.remote);
        let auto = self
            .get("push.autosetupremote")
            .is_some_and(|value| matches!(value, "true" | "yes" | "1"));
        let dest = match mode {
            "matching" => return Ok((vec![":".to_owned()], false)),
            "nothing" => return Ok((vec![], false)),
            "current" => source.as_str(),
            "upstream" | "tracking" if !triangular => upstream
                .or(auto.then_some(source.as_str()))
                .ok_or_else(|| invalid("The current branch has no upstream"))?,
            "simple" if triangular => source.as_str(),
            "simple" if upstream == Some(source.as_str()) || (upstream.is_none() && auto) => {
                source.as_str()
            }
            _ => {
                return Err(invalid(
                    "Configure a matching upstream for the current branch before pushing",
                ))
            }
        };
        Ok((vec![format!("{source}:{dest}")], auto && upstream.is_none()))
    }
}

fn capture(root: &str, args: &[String]) -> Result<(bool, String), GitError> {
    let output = git_command()
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|_| invalid("Could not start Git sync"))?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

fn literal_name(name: &str) -> Result<String, GitError> {
    if name.is_empty()
        || name.starts_with('-')
        || name.len() > 1024
        || name
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return Err(invalid("Invalid tag name"));
    }
    Ok(format!("refs/tags/{name}"))
}

fn reviewed_tag(root: &str, name: &str, expected: &str) -> Result<String, GitError> {
    if !is_oid(expected) {
        return Err(invalid("The reviewed tag must have a full object ID"));
    }
    let reference = literal_name(name)?;
    let actual = git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(objectname)",
            &reference,
        ],
    )?;
    if !actual
        .lines()
        .any(|line| line.split_once('\t') == Some((reference.as_str(), expected)))
    {
        return Err(invalid(
            "This tag changed. Close the action and review it again.",
        ));
    }
    Ok(reference)
}

pub fn checkout(root: &str, name: &str, expected: &str) -> Result<(), GitError> {
    reviewed_tag(root, name, expected)?;
    let commit = git(
        root,
        &[
            "--no-replace-objects",
            "rev-parse",
            "--verify",
            &format!("{expected}^{{commit}}"),
        ],
    )?;
    if !is_oid(commit.trim()) {
        return Err(invalid("This tag does not point to a commit"));
    }
    git(root, &["switch", "--detach", commit.trim()]).map(|_| ())
}

pub fn push_tag(root: &str, name: &str, expected: &str) -> Result<(), GitError> {
    let reference = reviewed_tag(root, name, expected)?;
    let config = SyncConfig::load(root, true)?;
    let args = vec![
        "push".to_owned(),
        "--no-follow-tags".to_owned(),
        "--".to_owned(),
        config.remote,
        format!("{expected}:{reference}"),
    ];
    if capture(root, &args)?.0 {
        Ok(())
    } else {
        Err(invalid("Tag push failed. Check the remote connection and whether the remote already has a different tag."))
    }
}

pub fn push(root: &str) -> Result<PushOutcome, GitError> {
    let config = SyncConfig::load(root, true)?;
    let (specs, set_upstream) = config.push_specs()?;
    let mut args = vec![
        "push".to_owned(),
        "--porcelain".to_owned(),
        "--tags".to_owned(),
    ];
    if set_upstream {
        args.push("--set-upstream".to_owned());
    }
    args.extend(["--".to_owned(), config.remote]);
    args.extend(specs);
    let (success, output) = capture(root, &args)?;
    if !success
        && !output
            .lines()
            .any(|line| line.starts_with(['*', '+', ' ', '-']))
    {
        return Err(invalid(
            "Push failed. Check the remote connection and whether remote refs reject your changes.",
        ));
    }
    Ok(PushOutcome { tag_error: (!success).then(|| "Some refs were pushed, but other refs were rejected. Existing remote tags were not overwritten.".to_owned()) })
}

pub fn fetch(root: &str) -> Result<TagFetchOutcome, GitError> {
    let config = SyncConfig::load(root, false)?;
    let mut specs = config.specs("fetch");
    specs.retain(|spec| {
        !spec
            .trim_start_matches(['+', '^'])
            .starts_with("refs/tags/")
    });
    if specs.iter().any(|spec| {
        spec.split_once(':')
            .is_some_and(|(_, dest)| dest.starts_with("refs/tags/") || dest == "refs/*")
    }) {
        return Err(invalid(
            "Fetch mappings that write local tags require a remote-tracking branch mapping",
        ));
    }
    if specs.is_empty() {
        specs.push("HEAD".to_owned());
    }
    let mut args = vec![
        "fetch".to_owned(),
        "--porcelain".to_owned(),
        "--prune".to_owned(),
        "--no-prune-tags".to_owned(),
        "--tags".to_owned(),
        "--refmap=".to_owned(),
        "--".to_owned(),
        config.remote.clone(),
    ];
    args.extend(specs);
    let (success, output) = capture(root, &args)?;
    let mut conflicts = Vec::new();
    let mut other_rejection = false;
    for line in output.lines().filter(|line| line.starts_with('!')) {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() == 4
            && parts[3].starts_with("refs/tags/")
            && is_oid(parts[1])
            && is_oid(parts[2])
            && parts[1] != parts[2]
            && parts[1].bytes().any(|b| b != b'0')
        {
            conflicts.push(TagFetchConflict {
                name: parts[3][10..].to_owned(),
                local_object_id: parts[1].to_owned(),
                remote_object_id: parts[2].to_owned(),
            });
        } else {
            other_rejection = true;
        }
    }
    if !success && (conflicts.is_empty() || other_rejection) {
        return Err(invalid(
            "Fetch failed. Check the remote connection and repository configuration.",
        ));
    }
    Ok(TagFetchOutcome {
        remote: config.remote,
        conflicts,
    })
}

pub fn apply_fetched_tags(root: &str, conflicts: &[TagFetchConflict]) -> Result<(), GitError> {
    if conflicts.is_empty() || conflicts.len() > 16_384 {
        return Err(invalid("Select between 1 and 16384 tags"));
    }
    let mut names = HashSet::new();
    let mut references = Vec::new();
    let mut commands = String::new();
    for conflict in conflicts {
        if !is_oid(&conflict.local_object_id)
            || !is_oid(&conflict.remote_object_id)
            || conflict.local_object_id.bytes().all(|b| b == b'0')
            || conflict.remote_object_id.bytes().all(|b| b == b'0')
            || !names.insert(&conflict.name)
        {
            return Err(invalid("Invalid reviewed tag replacement"));
        }
        let reference = literal_name(&conflict.name)?;
        commands.push_str(&format!(
            "update {reference} {} {}\n",
            conflict.remote_object_id, conflict.local_object_id
        ));
        references.push(reference);
    }
    change_tag_refs(root, &references, commands.trim_end(), "replace fetched")
}

pub fn details(root: &str, name: &str, expected: &str) -> Result<TagDetails, GitError> {
    let reference = literal_name(name)?;
    if !is_oid(expected) {
        return Err(invalid("Invalid reviewed tag object ID"));
    }
    let raw = read_git(root, &["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(taggername)%00%(taggerdate:unix)%00%(contents)", &reference], 65_536)?;
    let text = String::from_utf8_lossy(&raw);
    let fields = text.splitn(6, '\0').collect::<Vec<_>>();
    if fields.len() != 6 || fields[0] != reference || fields[1] != expected {
        return Err(invalid(
            "This tag changed. Hover it again after refreshing.",
        ));
    }
    let annotated = fields[2] == "tag";
    let contents = fields[5].trim();
    let signature = [
        "-----BEGIN PGP SIGNATURE-----",
        "-----BEGIN SSH SIGNATURE-----",
        "-----BEGIN SIGNED MESSAGE-----",
    ]
    .iter()
    .filter_map(|marker| contents.find(marker))
    .min();
    Ok(TagDetails {
        annotated,
        message: annotated.then(|| {
            contents[..signature.unwrap_or(contents.len())]
                .trim()
                .to_owned()
        }),
        tagger: (!fields[3].is_empty()).then(|| fields[3].to_owned()),
        timestamp: fields[4].parse().ok(),
        has_signature: annotated && signature.is_some(),
    })
}
