//! Git metadata needed by the server's filesystem invalidation service.
use super::command::{GitCommand, GitError};
use std::path::{Path, PathBuf};

pub fn metadata_directories(root: &Path) -> Result<(PathBuf, PathBuf), GitError> {
    let directory = |flag| {
        let output = GitCommand::run(&["rev-parse", "--path-format=absolute", flag], Some(root))?;
        // Separate invocations preserve newlines inside directory names.
        let output = output.strip_suffix('\n').unwrap_or(&output);
        Ok(PathBuf::from(output.strip_suffix('\r').unwrap_or(output)))
    };
    Ok((directory("--git-dir")?, directory("--git-common-dir")?))
}

/// A conservative optimization: any uncertainty requires a normal status read.
pub fn only_ignored(root: &Path, paths: &[PathBuf]) -> bool {
    if paths.is_empty() {
        return false;
    }
    let mut input = Vec::new();
    for path in paths {
        let Some(path) = path.to_str() else {
            return false;
        };
        if path.is_empty() {
            return false;
        }
        input.extend_from_slice(path.as_bytes());
        input.push(0);
        // Keep the request below pipe capacity while the synchronous Git
        // runner writes stdin before collecting output.
        if input.len() > 2048 {
            return false;
        }
    }
    // Git excludes tracked paths from check-ignore, including files whose
    // containing directory matches an ignore pattern.
    match GitCommand::run_with_stdin(&["check-ignore", "--stdin", "-z"], Some(root), &input) {
        Ok(ignored) => {
            ignored
                .as_bytes()
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .count()
                == paths.len()
        }
        Err(_) => false,
    }
}
