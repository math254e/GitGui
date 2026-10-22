use serde::Serialize;
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    time::Instant,
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
        Self::run_command(args, cwd, None, false)
    }

    /// `diff --no-index` uses exit code 1 for a successfully produced diff.
    pub fn run_diff(args: &[&str], cwd: &Path) -> Result<String, GitError> {
        // A file may grow after the content guard. Bound the generated patch
        // independently so direct hunk RPCs cannot transfer arbitrary output.
        const MAX_PATCH_BYTES: usize = 256 * 1024;
        let started = Instant::now();
        let failure = |message: &str| GitError {
            message: message.to_string(),
            stderr: String::new(),
            status: None,
        };
        let mut child = git_command()
            .args(args)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| failure(&format!("Failed to execute git: {e}")))?;
        let mut bytes = Vec::new();
        let read = child
            .stdout
            .take()
            .expect("piped stdout")
            .take((MAX_PATCH_BYTES + 1) as u64)
            .read_to_end(&mut bytes);
        let limited = bytes.len() > MAX_PATCH_BYTES;
        if limited || read.is_err() {
            let _ = child.kill();
        }
        let status = child
            .wait()
            .map_err(|e| failure(&format!("Failed to wait for git: {e}")))?;
        tracing::info!(target: "gitgui::git_command", category = "diff",
            elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
            stdout_bytes = bytes.len(), output_limited = limited, exit_code = status.code(),
            "Git subprocess completed");
        read.map_err(|e| failure(&format!("Failed to read Git patch: {e}")))?;
        if limited {
            return Err(failure(
                "Patch exceeds the preview limit; use whole-file actions and inspect with Git.",
            ));
        }
        if !status.success() && status.code() != Some(1) {
            return Err(failure(
                "Could not generate Git patch; refresh and try again.",
            ));
        }
        String::from_utf8(bytes).map_err(|_| failure("Non-UTF-8 files use whole-file actions"))
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
        Self::run_command(args, cwd, Some(stdin), false)
    }

    fn run_command(
        args: &[&str],
        cwd: Option<&Path>,
        stdin: Option<&[u8]>,
        diff_exit_code: bool,
    ) -> Result<String, GitError> {
        let started = Instant::now();
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

        // Record only a coarse verb, elapsed time, byte counts, and exit code.
        // Arguments can contain repository paths or user supplied values.
        let category = match args.first().copied() {
            Some("status") => "status",
            Some("diff") => "diff",
            Some("show") => "show",
            Some("rev-parse") => "rev-parse",
            Some("hash-object") => "hash-object",
            Some("ls-files") => "ls-files",
            Some("cat-file") => "cat-file",
            Some("apply") => "apply",
            Some("add") => "add",
            Some("reset") => "reset",
            Some("commit") => "commit",
            Some("branch") => "branch",
            Some("worktree") => "worktree",
            Some("stash") => "stash",
            Some("fetch") => "fetch",
            Some("pull") => "pull",
            Some("push") => "push",
            Some("remote") => "remote",
            Some("config") => "config",
            Some("merge-base") => "merge-base",
            Some("for-each-ref") => "for-each-ref",
            Some("tag") => "tag",
            Some("init") => "init",
            _ => "other",
        };
        tracing::info!(
            target: "gitgui::git_command",
            category,
            elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
            stdout_bytes = output.stdout.len().min(u32::MAX as usize),
            stderr_bytes = output.stderr.len().min(u32::MAX as usize),
            exit_code = output.status.code(),
            "Git subprocess completed"
        );

        if !output.status.success() && !(diff_exit_code && output.status.code() == Some(1)) {
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

        if diff_exit_code {
            String::from_utf8(output.stdout).map_err(|_| GitError {
                message: "Non-UTF-8 files use whole-file actions".to_string(),
                stderr: String::new(),
                status: None,
            })
        } else {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
    }
}

pub fn git_command() -> Command {
    #[cfg(test)]
    test_metrics::git();
    let mut command = Command::new("git");

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    // Remote operations must fail cleanly instead of hanging on a terminal
    // credential prompt that the desktop client cannot display or answer.
    command.env("GIT_TERMINAL_PROMPT", "0");
    // Read operations must not rewrite the index and trigger another watch
    // invalidation. Required locks for mutations are unaffected.
    command.env("GIT_OPTIONAL_LOCKS", "0");

    command
}

// Per-thread counters keep the ignored file-view measurement independent of
// production instrumentation and of concurrently running tests.
#[cfg(test)]
pub(crate) mod test_metrics {
    use std::cell::Cell;
    thread_local! {
        static COUNTS: Cell<(usize, usize, usize)> = const { Cell::new((0, 0, 0)) };
    }
    pub fn git() {
        COUNTS.with(|c| {
            let (g, r, b) = c.get();
            c.set((g + 1, r, b));
        });
    }
    pub fn read(bytes: usize) {
        COUNTS.with(|c| {
            let (g, r, b) = c.get();
            c.set((g, r + 1, b + bytes));
        });
    }
    pub fn take() -> (usize, usize, usize) {
        COUNTS.with(|c| c.replace((0, 0, 0)))
    }
}
