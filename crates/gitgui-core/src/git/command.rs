use serde::Serialize;
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Debug, Serialize)]
pub struct GitError {
    pub message: String,
    pub stderr: String,
    pub status: Option<i32>,
}

pub struct GitCommand;

impl GitCommand {
    pub fn run(args: &[&str], cwd: Option<&Path>) -> Result<String, GitError> {
        Self::run_command(args, cwd, None)
    }

    pub fn run_owned(args: &[String], cwd: Option<&Path>) -> Result<String, GitError> {
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        Self::run(&args, cwd)
    }

    pub fn run_with_stdin(
        args: &[&str],
        cwd: Option<&Path>,
        stdin: &[u8],
    ) -> Result<String, GitError> {
        Self::run_command(args, cwd, Some(stdin))
    }

    fn run_command(
        args: &[&str],
        cwd: Option<&Path>,
        stdin: Option<&[u8]>,
    ) -> Result<String, GitError> {
        let mut command = git_command();
        command.args(args);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        if stdin.is_some() {
            command.stdin(std::process::Stdio::piped());
        }

        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }

        let mut child = command.spawn().map_err(|error| GitError {
            message: format!("Failed to execute git: {error}"),
            stderr: String::new(),
            status: None,
        })?;

        if let Some(stdin_bytes) = stdin {
            let mut input = child.stdin.take().ok_or_else(|| GitError {
                message: "Failed to open git standard input".to_string(),
                stderr: String::new(),
                status: None,
            })?;
            input.write_all(stdin_bytes).map_err(|error| GitError {
                message: format!("Failed to write to git standard input: {error}"),
                stderr: String::new(),
                status: None,
            })?;
        }

        let output = child.wait_with_output().map_err(|error| GitError {
            message: format!("Failed to wait for git: {error}"),
            stderr: String::new(),
            status: None,
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let diagnostic = match (stderr.is_empty(), stdout.is_empty()) {
                (true, true) => String::new(),
                (false, true) => stderr,
                (true, false) => stdout,
                (false, false) => format!("{stderr}\n{stdout}"),
            };

            return Err(GitError {
                message: format!("git {} failed", args.join(" ")),
                stderr: diagnostic,
                status: output.status.code(),
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

pub fn git_command() -> Command {
    let mut command = Command::new("git");

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    // Remote operations must fail cleanly instead of hanging on a terminal
    // credential prompt that the desktop client cannot display or answer.
    command.env("GIT_TERMINAL_PROMPT", "0");

    command
}
