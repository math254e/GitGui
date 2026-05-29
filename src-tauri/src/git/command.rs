use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct GitError {
    pub message: String,
    pub stderr: String,
    pub status: Option<i32>,
}

pub struct GitCommand;

impl GitCommand {
    pub fn run(args: &[&str], cwd: Option<&Path>) -> Result<String, GitError> {
        let mut command = Command::new("git");
        command.args(args);

        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }

        let output = command.output().map_err(|error| GitError {
            message: format!("Failed to execute git: {error}"),
            stderr: String::new(),
            status: None,
        })?;

        if !output.status.success() {
            return Err(GitError {
                message: format!("git {} failed", args.join(" ")),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                status: output.status.code(),
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}
