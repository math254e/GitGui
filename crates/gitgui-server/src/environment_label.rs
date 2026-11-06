//! Host-derived default adapted from T3 Code's ServerEnvironmentLabel at
//! 70cd258d8aac43ea57494527b00bf36de3efa6c0. Explicit client labels remain
//! client-owned and do not change server identity.

use std::env;
#[cfg(target_os = "linux")]
use std::{fs, io::Read};
#[cfg(target_os = "macos")]
use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn nonempty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty() && !value.chars().any(char::is_control)).then_some(value)
}

#[cfg(any(target_os = "linux", test))]
fn pretty_hostname(contents: &str) -> Option<&str> {
    contents.lines().find_map(|line| {
        let line = line.trim();
        let value = line.strip_prefix("PRETTY_HOSTNAME=")?.trim();
        let value = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        nonempty(value)
    })
}

#[cfg(target_os = "macos")]
fn host_command(executable: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let output = child.wait_with_output().ok()?;
                if output.stdout.len() > 4096 {
                    return None;
                }
                return String::from_utf8(output.stdout)
                    .ok()
                    .and_then(|value| nonempty(&value).map(str::to_owned));
            }
            Ok(Some(_)) => return None,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

pub fn resolve() -> String {
    #[cfg(target_os = "macos")]
    if let Some(name) = host_command("/usr/sbin/scutil", &["--get", "ComputerName"]) {
        return name;
    }
    #[cfg(target_os = "linux")]
    {
        // Avoid spawning hostnamectl for every descriptor request. T3 also
        // prefers this system file; /proc supplies its hostname fallback.
        let mut info = String::new();
        if let Ok(file) = fs::File::open("/etc/machine-info") {
            if file.take(16 * 1024).read_to_string(&mut info).is_ok() {
                if let Some(name) = pretty_hostname(&info) {
                    return name.to_owned();
                }
            }
        }
        if let Ok(hostname) = fs::read_to_string("/proc/sys/kernel/hostname") {
            if let Some(name) = nonempty(&hostname) {
                return name.to_owned();
            }
        }
    }
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = env::var(key) {
            if let Some(name) = nonempty(&value) {
                return name.to_owned();
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(name) = host_command("/bin/hostname", &[]) {
        return name;
    }
    env::current_dir()
        .ok()
        .and_then(|path| {
            path.file_name()?
                .to_str()
                .and_then(nonempty)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "Environment".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{nonempty, pretty_hostname};

    #[test]
    fn reads_plain_and_quoted_pretty_hostnames() {
        assert_eq!(
            pretty_hostname("# comment\nPRETTY_HOSTNAME=\"Build Agent 01\"\n"),
            Some("Build Agent 01")
        );
        assert_eq!(
            pretty_hostname("PRETTY_HOSTNAME='Workstation'\n"),
            Some("Workstation")
        );
        assert_eq!(pretty_hostname("PRETTY_HOSTNAME=   \n"), None);
        assert_eq!(
            pretty_hostname("# PRETTY_HOSTNAME=ignored\nHOSTNAME=box"),
            None
        );
        assert_eq!(nonempty(" \t"), None);
        assert_eq!(nonempty("bad\u{1}name"), None);
    }
}
