use super::command::{GitCommand, GitError};
use std::path::Path;

pub fn init_repository(
    root: &str,
    initial_branch: Option<&str>,
    initialize_lfs: bool,
) -> Result<(), GitError> {
    let mut init_args = vec!["init".to_string()];
    if let Some(initial_branch) = initial_branch {
        init_args.push("--initial-branch".to_string());
        init_args.push(initial_branch.to_string());
    }
    GitCommand::run_owned(&init_args, Some(Path::new(root)))?;

    if initialize_lfs {
        GitCommand::run(&["lfs", "install", "--local"], Some(Path::new(root)))?;
    }

    Ok(())
}

pub fn stage(root: &str, paths: &[String]) -> Result<(), GitError> {
    let mut args = vec!["--literal-pathspecs".to_string(), "add".to_string()];
    if paths.is_empty() {
        args.push("--all".to_string());
    } else {
        args.push("--".to_string());
        args.extend(paths.iter().cloned());
    }
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

pub fn unstage(root: &str, paths: &[String]) -> Result<(), GitError> {
    let has_head =
        GitCommand::run(&["rev-parse", "--verify", "HEAD"], Some(Path::new(root))).is_ok();
    let mut args = if has_head {
        vec![
            "--literal-pathspecs".to_string(),
            "restore".to_string(),
            "--staged".to_string(),
            "--".to_string(),
        ]
    } else {
        vec![
            "--literal-pathspecs".to_string(),
            "rm".to_string(),
            "--cached".to_string(),
            "-r".to_string(),
            "--".to_string(),
        ]
    };
    if paths.is_empty() {
        args.push(".".to_string());
    } else {
        args.extend(paths.iter().cloned());
    }
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

pub fn commit(root: &str, message: &str) -> Result<(), GitError> {
    GitCommand::run_with_stdin(
        &["commit", "--file=-"],
        Some(Path::new(root)),
        message.as_bytes(),
    )
    .map(|_| ())
}

pub fn fetch(root: &str) -> Result<(), GitError> {
    GitCommand::run(&["fetch", "--prune"], Some(Path::new(root))).map(|_| ())
}

pub fn pull(root: &str) -> Result<(), GitError> {
    GitCommand::run(&["pull"], Some(Path::new(root))).map(|_| ())
}

pub fn push(root: &str) -> Result<(), GitError> {
    GitCommand::run(&["push"], Some(Path::new(root))).map(|_| ())
}

pub fn list_local_branches(root: &str) -> Result<Vec<String>, GitError> {
    let output = GitCommand::run(
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        Some(Path::new(root)),
    )?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

pub fn validate_branch_name(root: &str, name: &str) -> Result<(), GitError> {
    GitCommand::run(
        &["check-ref-format", "--branch", name],
        Some(Path::new(root)),
    )
    .map(|_| ())
}

pub fn create_branch(
    root: &str,
    name: &str,
    start_point: Option<&str>,
    checkout: bool,
) -> Result<(), GitError> {
    validate_branch_name(root, name)?;
    let mut args = if checkout {
        vec![
            "switch".to_string(),
            "--create".to_string(),
            name.to_string(),
        ]
    } else {
        vec!["branch".to_string(), name.to_string()]
    };
    if let Some(start_point) = start_point {
        args.push(start_point.to_string());
    }
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

pub fn switch_branch(root: &str, name: &str, merge: bool) -> Result<(), GitError> {
    validate_branch_name(root, name)?;
    let mut args = vec!["switch".to_string()];
    if merge {
        args.push("--merge".to_string());
    }
    args.push(name.to_string());
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

pub fn stash_push(
    root: &str,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<(), GitError> {
    let mut args = vec!["stash".to_string(), "push".to_string()];
    if include_untracked {
        args.push("--include-untracked".to_string());
    }
    if let Some(message) = message {
        args.push("--message".to_string());
        args.push(message.to_string());
    }
    GitCommand::run_owned(&args, Some(Path::new(root))).map(|_| ())
}

pub fn stash_pop(root: &str) -> Result<(), GitError> {
    GitCommand::run(&["stash", "pop"], Some(Path::new(root))).map(|_| ())
}
