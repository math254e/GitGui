//! Linux executable tests use isolated per-user state and only owned children.
#![cfg(target_os = "linux")]
use gitgui_protocol::{SshEnvironmentLocator, SshHostOutcome, SshHostRequest, SshHostResponse};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

fn request() -> SshHostRequest {
    SshHostRequest {
        version: 1,
        acquisition_id: uuid::Uuid::new_v4().to_string(),
        locator: SshEnvironmentLocator::Default,
        expected_environment_id: None,
        instance_id: None,
    }
}
struct Helper {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Vec<u8>>,
}
impl Helper {
    fn start(root: &Path, operation: &str, request: &SshHostRequest) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_gitgui-server"))
            .args(["ssh", operation, "--json"])
            .env("XDG_STATE_HOME", root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        serde_json::to_writer(&mut input, request).unwrap();
        writeln!(input).unwrap();
        input.flush().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            BufReader::new(stdout)
                .read_until(b'\n', &mut bytes)
                .unwrap();
            let _ = tx.send(bytes);
        });
        Self {
            child,
            input: Some(input),
            output: rx,
        }
    }
    fn result(&mut self) -> SshHostResponse {
        let bytes = self
            .output
            .recv_timeout(Duration::from_secs(20))
            .expect("bounded helper result");
        let reply =
            serde_json::from_slice(&bytes).expect("stdout is one structured frame, without logs");
        self.input.take();
        assert!(self.child.wait().unwrap().success());
        reply
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        self.input.take();
        if self.child.try_wait().unwrap().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
fn run(root: &Path, operation: &str, request: &SshHostRequest) -> SshHostResponse {
    Helper::start(root, operation, request).result()
}
fn wait_record(root: &Path, condition: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(bytes) = fs::read(root.join("gitgui/.ssh-host/state.json")) {
            if let Ok(value) = serde_json::from_slice(&bytes) {
                if condition(&value) {
                    return value;
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "bounded runtime record transition"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn lost_result_competing_helpers_claim_release_and_two_environments() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let mut a = request();
    let mut b = request();
    let mut c = request();
    let mut helper_a = Helper::start(first.path(), "ensure", &a);
    let mut helper_b = Helper::start(first.path(), "ensure", &b);
    let ready_a = helper_a.result();
    let ready_b = helper_b.result();
    assert_eq!(ready_a.outcome, SshHostOutcome::Ready);
    assert_eq!(ready_b.outcome, SshHostOutcome::Ready);
    assert_eq!(ready_a.instance_id, ready_b.instance_id);
    assert_eq!(
        ready_a.remote_data_directory.as_deref(),
        first.path().join("gitgui").to_str()
    );
    let ready_c = run(second.path(), "ensure", &c);
    assert_eq!(ready_c.outcome, SshHostOutcome::Ready);
    assert_ne!(ready_a.environment_id, ready_c.environment_id);
    for (request, reply) in [(&mut a, &ready_a), (&mut b, &ready_b), (&mut c, &ready_c)] {
        request.instance_id = reply.instance_id.clone();
        request.expected_environment_id = reply.environment_id.clone();
    }
    assert_eq!(
        run(first.path(), "claim", &b).outcome,
        SshHostOutcome::Claimed
    );
    assert_eq!(
        run(second.path(), "claim", &c).outcome,
        SshHostOutcome::Claimed
    );
    // Treat a's ready output as lost. Cancellation by the pre-reserved ID cannot
    // stop b's independently claimed use or the other environment.
    a.instance_id = None;
    assert_eq!(
        run(first.path(), "cancel", &a).outcome,
        SshHostOutcome::Retained
    );
    assert_eq!(
        run(first.path(), "probe", &b).outcome,
        SshHostOutcome::Ready
    );
    assert_eq!(
        run(second.path(), "probe", &c).outcome,
        SshHostOutcome::Ready
    );
    assert_eq!(
        run(first.path(), "release", &b).outcome,
        SshHostOutcome::Stopped
    );
    assert_eq!(
        run(second.path(), "probe", &c).outcome,
        SshHostOutcome::Ready
    );
    assert_eq!(
        run(second.path(), "release", &c).outcome,
        SshHostOutcome::Stopped
    );
}

fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, serde_json::Value) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    let mut bytes = Vec::new();
    stream.take(64 * 1024).read_to_end(&mut bytes).unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    let (headers, body) = text.split_once("\r\n\r\n").unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_str(body).unwrap())
}

#[test]
fn managed_startup_requires_durable_auth_and_owner_pairing_is_consumed_once() {
    let root = tempfile::tempdir().unwrap();
    let mut request = request();
    let ready = run(root.path(), "ensure", &request);
    assert_eq!(ready.outcome, SshHostOutcome::Ready);
    request.instance_id = ready.instance_id.clone();
    request.expected_environment_id = ready.environment_id.clone();
    let descriptor = http(
        ready.port.unwrap(),
        "GET",
        "/.well-known/gitgui/environment",
        "",
    );
    assert_eq!(descriptor.0, 200);
    assert_eq!(descriptor.1["auth"]["required"], true);
    let pairing = run(root.path(), "pairing", &request);
    assert_eq!(pairing.outcome, SshHostOutcome::Ready);
    let pairing = pairing.pairing.unwrap();
    assert!(pairing.scopes.iter().any(|s| s == "repository:manage"));
    assert!(!pairing.scopes.iter().any(|s| s == "access:write"));
    let body = format!(
        "grant_type=urn:ietf:params:oauth:grant-type:token-exchange&subject_token={}",
        pairing.credential
    );
    let first = http(ready.port.unwrap(), "POST", "/oauth/token", &body);
    assert_eq!(first.0, 200);
    assert!(first.1["access_token"].as_str().is_some());
    assert_eq!(
        http(ready.port.unwrap(), "POST", "/oauth/token", &body).0,
        401
    );
    let metadata = fs::read_to_string(root.path().join("gitgui/.ssh-host/state.json")).unwrap();
    assert!(!metadata.contains(&pairing.credential));
    assert!(!metadata.contains(first.1["access_token"].as_str().unwrap()));
    assert_eq!(
        run(root.path(), "cancel", &request).outcome,
        SshHostOutcome::Stopped
    );
}

#[test]
fn killed_setup_helper_and_eof_leave_known_acquisition_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let request = request();
    let mut helper = Helper::start(root.path(), "ensure", &request);
    wait_record(root.path(), |r| r["instance"]["pid"].is_u64());
    // The remote process is owned before the result is read. Only the exact
    // helper Child is killed; managed servers are stopped through cooperation.
    if helper.child.try_wait().unwrap().is_none() {
        helper.child.kill().unwrap();
    }
    helper.child.wait().unwrap();
    let result = run(root.path(), "cancel", &request);
    assert!(matches!(
        result.outcome,
        SshHostOutcome::Stopped | SshHostOutcome::Cancelled
    ));
    wait_record(root.path(), |r| r["instance"]["phase"] == "stopped");
    assert_eq!(
        run(root.path(), "ensure", &request).outcome,
        SshHostOutcome::Cancelled
    );

    let root = tempfile::tempdir().unwrap();
    let request = self::request();
    let mut helper = Helper::start(root.path(), "ensure", &request);
    helper.input.take();
    let reply = helper.result();
    assert!(matches!(
        reply.outcome,
        SshHostOutcome::Stopped | SshHostOutcome::Cancelled
    ));
    assert_eq!(
        run(root.path(), "ensure", &request).outcome,
        SshHostOutcome::Cancelled
    );
}

#[test]
fn deep_existing_absolute_locator_uses_bounded_private_socket() {
    let root = tempfile::tempdir().unwrap();
    let deep = root
        .path()
        .join("long-home-path".repeat(10))
        .join("legacy-locator".repeat(8));
    fs::create_dir_all(&deep).unwrap();
    let first = request();
    let ready = run(&deep, "ensure", &first);
    assert_eq!(ready.outcome, SshHostOutcome::Ready);
    let data_dir = ready.remote_data_directory.clone().unwrap();
    assert!(data_dir.len() > 108);
    let mut attached = request();
    attached.locator = SshEnvironmentLocator::Directory {
        path: data_dir.clone(),
        environment_id: ready.environment_id.clone().unwrap(),
    };
    attached.expected_environment_id = ready.environment_id.clone();
    let reused = run(&deep, "ensure", &attached);
    assert_eq!(reused.outcome, SshHostOutcome::Ready);
    assert_eq!(
        reused.remote_data_directory.as_deref(),
        Some(data_dir.as_str())
    );
    assert_eq!(reused.instance_id, ready.instance_id);
    // Probe succeeds through the exact-instance owner socket despite the data
    // directory being much longer than Linux sockaddr_un.sun_path permits.
    attached.instance_id = ready.instance_id;
    assert_eq!(
        run(&deep, "probe", &attached).outcome,
        SshHostOutcome::Ready
    );
    assert_eq!(
        run(&deep, "cancel", &attached).outcome,
        SshHostOutcome::Retained
    );
    assert_eq!(
        run(&deep, "cancel", &first).outcome,
        SshHostOutcome::Stopped
    );
}
