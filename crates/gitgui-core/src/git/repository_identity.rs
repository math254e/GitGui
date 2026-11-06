//! Repository grouping identity adapted from T3 Code's
//! `apps/server/src/project/RepositoryIdentityResolver.ts` and
//! `packages/shared/src/git.ts` at 70cd258d8aac43ea57494527b00bf36de3efa6c0.
//!
//! GitGui never returns the raw URL: unsupported or ambiguous forms do not
//! produce a cross-host identity. Git execution and output are bounded and
//! raw remote URLs are never returned or logged.

use super::command::git_command;
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: u64 = 256 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

/// Failure is deliberately coarse: Git output can contain credentials.
#[derive(Debug, PartialEq, Eq)]
pub enum IdentityReadError {
    Unavailable,
    Timeout,
    OutputTooLarge,
    InvalidOutput,
}

/// Local metadata only. The server scopes and hashes the common directory;
/// neither it nor a raw remote URL is a cross-environment identifier.
#[derive(Clone, Debug)]
pub struct RepositoryMetadata {
    pub canonical_key: Option<String>,
    pub common_dir: PathBuf,
    pub main_root: Option<PathBuf>,
    pub is_linked_worktree: bool,
    pub watch_paths: Vec<PathBuf>,
}

/// Three bounded local Git reads (four for a main checkout with a separate Git
/// directory), without loading history or contacting remotes.
pub fn resolve_repository_metadata(root: &Path) -> Result<RepositoryMetadata, IdentityReadError> {
    let root = root
        .canonicalize()
        .map_err(|_| IdentityReadError::Unavailable)?;
    let common_dir = read_git_path(&root, "--git-common-dir")?;

    let mut command = git_command();
    command
        .args(["worktree", "list", "--porcelain", "-z"])
        .current_dir(&root);
    let output = run_bounded(&mut command, COMMAND_TIMEOUT, OUTPUT_LIMIT)?;
    let records = parse_worktree_roots(&output)?;
    let first = records.first().ok_or(IdentityReadError::InvalidOutput)?;
    // A removed nested repository must never inherit its parent repository's
    // identity. Verify that Git actually lists this canonical checkout.
    let current_index = records
        .iter()
        .position(|(path, bare)| !bare && path.canonicalize().ok().as_ref() == Some(&root));
    let separate_main = !first.1 && first.0.canonicalize().ok().as_ref() == Some(&common_dir);
    if current_index.is_none()
        && (!separate_main || read_git_path(&root, "--show-toplevel")? != root)
    {
        return Err(IdentityReadError::Unavailable);
    }
    // Git lists the metadata directory as the main worktree for submodules and
    // --separate-git-dir layouts. That directory is never a checkout target.
    let main_root = if separate_main && current_index.is_none() {
        Some(root.clone())
    } else if first.1 || separate_main {
        None
    } else {
        first.0.canonicalize().ok()
    };
    let is_linked_worktree = current_index.is_some_and(|index| index > 0);
    let mut watch_paths = vec![
        root.join(".git"),
        common_dir.join("config"),
        common_dir.join("config.worktree"),
        common_dir.join("worktrees"),
    ];
    // Linked worktree config and registration files are bounded to this
    // checkout, not every worktree in the clone.
    let registration = std::fs::File::open(root.join(".git"))
        .ok()
        .and_then(|file| {
            let mut value = String::new();
            file.take(32 * 1024 + 1).read_to_string(&mut value).ok()?;
            if value.len() > 32 * 1024 {
                return None;
            }
            value
                .strip_prefix("gitdir: ")
                .map(|path| PathBuf::from(path.trim_end_matches(['\n', '\r'])))
        });
    if let Some(registration) = registration {
        let registration = if registration.is_absolute() {
            registration
        } else {
            root.join(registration)
        };
        watch_paths.extend([
            registration.join("config.worktree"),
            registration.join("commondir"),
            registration.join("gitdir"),
        ]);
    }
    Ok(RepositoryMetadata {
        canonical_key: resolve_repository_identity(&root)?,
        common_dir,
        main_root,
        is_linked_worktree,
        watch_paths,
    })
}

fn read_git_path(root: &Path, flag: &str) -> Result<PathBuf, IdentityReadError> {
    let mut command = git_command();
    command
        .args(["rev-parse", "--path-format=absolute", flag])
        .current_dir(root);
    let output = run_bounded(&mut command, COMMAND_TIMEOUT, OUTPUT_LIMIT)?;
    let directory = std::str::from_utf8(&output).map_err(|_| IdentityReadError::InvalidOutput)?;
    // Strip only Git's line terminator: whitespace can be part of a path.
    let directory = directory.strip_suffix('\n').unwrap_or(directory);
    #[cfg(windows)]
    let directory = directory.strip_suffix('\r').unwrap_or(directory);
    let directory = Path::new(directory);
    if !directory.is_absolute() {
        return Err(IdentityReadError::InvalidOutput);
    }
    directory
        .canonicalize()
        .map_err(|_| IdentityReadError::Unavailable)
}

fn parse_worktree_roots(output: &[u8]) -> Result<Vec<(PathBuf, bool)>, IdentityReadError> {
    if !output.ends_with(&[0, 0]) {
        return Err(IdentityReadError::InvalidOutput);
    }
    let mut records = Vec::new();
    let mut current: Option<(PathBuf, bool)> = None;
    for field in output.split(|byte| *byte == 0) {
        if field.is_empty() {
            if let Some(record) = current.take() {
                records.push(record);
            }
        } else if let Some(path) = field.strip_prefix(b"worktree ") {
            if current.is_some() {
                return Err(IdentityReadError::InvalidOutput);
            }
            let path = std::str::from_utf8(path).map_err(|_| IdentityReadError::InvalidOutput)?;
            if !Path::new(path).is_absolute() {
                return Err(IdentityReadError::InvalidOutput);
            }
            current = Some((PathBuf::from(path), false));
        } else if field == b"bare" {
            current.as_mut().ok_or(IdentityReadError::InvalidOutput)?.1 = true;
        } else if current.is_none() {
            return Err(IdentityReadError::InvalidOutput);
        }
    }
    Ok(records)
}

/// Reads only local Git configuration, with bounded output and process time.
pub fn resolve_repository_identity(root: &Path) -> Result<Option<String>, IdentityReadError> {
    let mut command = git_command();
    command.args(["remote", "-v"]).current_dir(root);
    let output = run_bounded(&mut command, COMMAND_TIMEOUT, OUTPUT_LIMIT)?;
    let output = std::str::from_utf8(&output).map_err(|_| IdentityReadError::InvalidOutput)?;
    Ok(identity_from_remote_output(output))
}

fn run_bounded(
    command: &mut Command,
    timeout: Duration,
    limit: u64,
) -> Result<Vec<u8>, IdentityReadError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| IdentityReadError::Unavailable)?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(IdentityReadError::Unavailable);
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout
            .take(limit + 1)
            .read_to_end(&mut output)
            .map(|_| output);
        let _ = sender.send(result);
    });
    let deadline = Instant::now() + timeout;
    let mut received = None;
    let status = loop {
        if let Ok(output) = receiver.try_recv() {
            if output
                .as_ref()
                .is_ok_and(|output| output.len() as u64 > limit)
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err(IdentityReadError::OutputTooLarge);
            }
            received = Some(output);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(IdentityReadError::Timeout);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(IdentityReadError::Unavailable);
            }
        }
    };
    let output = received
        .map(Ok)
        .unwrap_or_else(|| {
            receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        })
        .map_err(|_| IdentityReadError::Unavailable)?
        .map_err(|_| IdentityReadError::Unavailable)?;
    if output.len() as u64 > limit {
        return Err(IdentityReadError::OutputTooLarge);
    }
    if !status.success() {
        return Err(IdentityReadError::Unavailable);
    }
    Ok(output)
}

/// Resolve a best-effort grouping key from `git remote -v` output.
pub fn identity_from_remote_output(output: &str) -> Option<String> {
    let mut remotes = BTreeMap::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let (Some(name), Some(url), Some("(fetch)"), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        remotes.insert(name, url);
    }
    let url = remotes
        .get("upstream")
        .or_else(|| remotes.get("origin"))
        .or_else(|| remotes.values().next())?;
    normalize_remote(url)
}

fn normalize_remote(input: &str) -> Option<String> {
    let normalized = input.trim().trim_end_matches('/').to_lowercase();
    let normalized = normalized.strip_suffix(".git").unwrap_or(&normalized);
    if normalized.contains(['?', '#', '\\'])
        || normalized
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    let (host, path) = if let Some((scheme, rest)) = normalized.split_once("://") {
        if !matches!(scheme, "ssh" | "http" | "https" | "git") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let authority = authority.rsplit('@').next()?;
        (url_hostname(authority)?, path)
    } else {
        let (user, host_and_path) = normalized.split_once('@')?;
        if user.is_empty()
            || !user
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return None;
        }
        let (host, path) = host_and_path.split_once(':')?;
        (valid_host(host)?, path)
    };
    let segments: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    if segments.len() < 2
        || segments
            .iter()
            .any(|part| *part == "." || *part == ".." || part.contains('@'))
    {
        return None;
    }
    Some(format!("{host}/{}", segments.join("/")))
}

fn url_hostname(authority: &str) -> Option<&str> {
    if authority.starts_with('[') {
        let end = authority.find(']')?;
        let host = &authority[..=end];
        let remainder = &authority[end + 1..];
        if !remainder.is_empty() && !valid_port(remainder) {
            return None;
        }
        if host[1..end].parse::<std::net::Ipv6Addr>().is_err() {
            return None;
        }
        Some(host)
    } else {
        let (host, port) = authority
            .split_once(':')
            .map_or((authority, ""), |(host, port)| (host, port));
        if !port.is_empty() && port.parse::<u16>().is_err() {
            return None;
        }
        if authority.ends_with(':') {
            return None;
        }
        valid_host(host)
    }
}

fn valid_port(value: &str) -> bool {
    value
        .strip_prefix(':')
        .is_some_and(|port| !port.is_empty() && port.parse::<u16>().is_ok())
}

fn valid_host(host: &str) -> Option<&str> {
    if host.is_empty()
        || !host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
    {
        return None;
    }
    Some(host)
}

#[cfg(test)]
mod tests {
    use super::{
        identity_from_remote_output as identity, resolve_repository_identity, run_bounded,
        IdentityReadError,
    };
    use crate::git::command::git_command;
    use std::process::Command;
    use std::time::Duration;

    fn git(root: &std::path::Path, args: &[&str]) {
        assert!(git_command()
            .args(args)
            .current_dir(root)
            .output()
            .unwrap()
            .status
            .success());
    }

    #[test]
    fn metadata_correlates_linked_worktrees_but_keeps_independent_clones_separate() {
        let directory = tempfile::tempdir().unwrap();
        let main = directory.path().join("main checkout ü");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-b", "main"]);
        git(
            &main,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        );
        let linked = directory.path().join("linked checkout ü");
        git(
            &main,
            &["worktree", "add", "--detach", linked.to_str().unwrap()],
        );
        let main_metadata = super::resolve_repository_metadata(&main).unwrap();
        let linked_metadata = super::resolve_repository_metadata(&linked).unwrap();
        assert_eq!(main_metadata.common_dir, linked_metadata.common_dir);
        assert_eq!(
            linked_metadata.main_root,
            Some(main.canonicalize().unwrap())
        );
        assert!(linked_metadata.is_linked_worktree);
        assert!(!main_metadata.is_linked_worktree);
        assert_eq!(main_metadata.canonical_key, None);
        assert_eq!(linked_metadata.canonical_key, None);
        let clone = directory.path().join("clone");
        git(
            directory.path(),
            &["clone", main.to_str().unwrap(), clone.to_str().unwrap()],
        );
        assert_ne!(
            super::resolve_repository_metadata(&clone)
                .unwrap()
                .common_dir,
            main_metadata.common_dir
        );

        let nested = main.join("ordinary folder");
        std::fs::create_dir(&nested).unwrap();
        assert!(
            super::resolve_repository_metadata(&nested).is_err(),
            "must not inherit the parent repository"
        );
        assert!(super::resolve_repository_metadata(&directory.path().join("missing")).is_err());
    }

    #[test]
    fn git_file_with_separate_git_dir_is_a_main_checkout() {
        let directory = tempfile::tempdir().unwrap();
        let main = directory.path().join("main");
        let git_dir = directory.path().join("metadata");
        git(
            directory.path(),
            &[
                "init",
                "--separate-git-dir",
                git_dir.to_str().unwrap(),
                main.to_str().unwrap(),
            ],
        );
        let metadata = super::resolve_repository_metadata(&main).unwrap();
        assert_eq!(metadata.common_dir, git_dir.canonicalize().unwrap());
        assert!(!metadata.is_linked_worktree);
        assert_eq!(metadata.main_root, Some(main.canonicalize().unwrap()));
    }

    #[test]
    fn submodule_is_its_own_main_checkout_and_bare_family_has_no_main_checkout() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        std::fs::create_dir(&source).unwrap();
        git(&source, &["init", "-b", "main"]);
        git(
            &source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        );
        let parent = directory.path().join("parent");
        std::fs::create_dir(&parent).unwrap();
        git(&parent, &["init"]);
        git(
            &parent,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.to_str().unwrap(),
                "child",
            ],
        );
        let submodule = super::resolve_repository_metadata(&parent.join("child")).unwrap();
        assert_eq!(
            submodule.main_root,
            Some(parent.join("child").canonicalize().unwrap())
        );
        assert!(!submodule.is_linked_worktree);

        let bare = directory.path().join("bare.git");
        git(
            directory.path(),
            &[
                "clone",
                "--bare",
                source.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        let linked = directory.path().join("bare-linked");
        git(
            &bare,
            &["worktree", "add", "--detach", linked.to_str().unwrap()],
        );
        let metadata = super::resolve_repository_metadata(&linked).unwrap();
        assert_eq!(metadata.common_dir, bare.canonicalize().unwrap());
        assert!(metadata.main_root.is_none());
        assert!(metadata.is_linked_worktree);
    }

    #[test]
    fn worktree_parser_preserves_paths_and_rejects_truncation() {
        let path = std::env::temp_dir().join("a space\nand newline");
        let output = format!("worktree {}\0HEAD abc\0\0", path.display());
        let records = super::parse_worktree_roots(output.as_bytes()).unwrap();
        assert_eq!(records[0].0, path);
        assert_eq!(
            super::parse_worktree_roots(b"worktree /truncated\0"),
            Err(IdentityReadError::InvalidOutput)
        );
        assert_eq!(
            super::parse_worktree_roots(b"worktree relative\0\0"),
            Err(IdentityReadError::InvalidOutput)
        );
        assert_eq!(
            super::parse_worktree_roots(b"HEAD abc\0\0"),
            Err(IdentityReadError::InvalidOutput)
        );
    }

    #[cfg(unix)]
    #[test]
    fn metadata_preserves_newline_paths_and_resolves_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let main = directory.path().join(" main\ncheckout ");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init"]);
        let alias = directory.path().join("alias");
        std::os::unix::fs::symlink(&main, &alias).unwrap();
        let metadata = super::resolve_repository_metadata(&alias).unwrap();
        assert_eq!(metadata.main_root, Some(main.canonicalize().unwrap()));
        assert!(!metadata.is_linked_worktree);
    }

    #[test]
    fn groups_t3_url_forms_and_nested_groups() {
        for url in [
            "git@github.com:T3Tools/T3Code.git",
            "https://github.com/T3Tools/T3Code.git",
            "ssh://git@github.com:2222/T3Tools/T3Code/",
            "http://github.com:8080/T3Tools/T3Code.git/",
            "git://github.com/T3Tools/T3Code.git",
            "ssh://deploy:secret@github.com/T3Tools/T3Code.git",
        ] {
            assert_eq!(
                identity(&format!("origin\t{url} (fetch)")),
                Some("github.com/t3tools/t3code".into())
            );
        }
        assert_eq!(
            identity("origin git@gitlab.com:Team/Group/Project.git (fetch)"),
            Some("gitlab.com/team/group/project".into())
        );
    }

    #[test]
    fn prefers_upstream_then_origin_then_sorted_remote() {
        let output = "z git@host:z/repo (fetch)\norigin git@host:fork/repo (fetch)\nupstream https://host/team/repo (fetch)\n";
        assert_eq!(identity(output), Some("host/team/repo".into()));
        assert_eq!(
            identity("a git@host:a/repo (fetch)\norigin git@host:preferred/repo (fetch)"),
            Some("host/preferred/repo".into())
        );
        assert_eq!(
            identity("z git@host:z/repo (fetch)\na git@host:a/repo (fetch)"),
            Some("host/a/repo".into())
        );
        assert_eq!(
            identity("origin /private/path (fetch)\nz git@host:a/repo (fetch)"),
            None
        );
    }

    #[test]
    fn omits_credentials_and_rejects_unsafe_or_unusable_forms() {
        assert_eq!(
            identity("origin https://user:secret@example.com/team/repo.git (fetch)"),
            Some("example.com/team/repo".into())
        );
        for url in [
            "https://host/team/repo?token=secret",
            "https://host/team/repo#secret",
            "/local/repo",
            "https://host/single",
            "git@host:../repo",
            "https://host/team/repo\u{1b}[31m",
            "https://host:99999/team/repo",
            "ssh://git@[:::]/team/repo",
        ] {
            assert_eq!(identity(&format!("origin {url} (fetch)")), None);
        }
        assert_eq!(identity("origin git@host:team/repo (push)"), None);
    }

    #[test]
    fn resolves_a_real_git_repository_and_limits_output() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        assert!(git_command()
            .arg("init")
            .current_dir(root)
            .output()
            .unwrap()
            .status
            .success());
        assert!(git_command()
            .args([
                "remote",
                "add",
                "origin",
                "https://user:secret@example.com/Team/Repo.git"
            ])
            .current_dir(root)
            .output()
            .unwrap()
            .status
            .success());
        assert_eq!(
            resolve_repository_identity(root).unwrap(),
            Some("example.com/team/repo".into())
        );
        let mut command = git_command();
        command.arg("--version");
        assert_eq!(
            run_bounded(&mut command, Duration::from_secs(2), 2),
            Err(IdentityReadError::OutputTooLarge)
        );
    }

    #[test]
    fn terminates_its_own_command_after_timeout() {
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new("powershell.exe");
            command.creation_flags(0x08000000);
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 5",
            ]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sleep");
            command.arg("5");
            command
        };
        assert_eq!(
            run_bounded(&mut command, Duration::from_millis(100), 256),
            Err(IdentityReadError::Timeout)
        );
    }
}
