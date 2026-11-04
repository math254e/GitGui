use gitgui_server::{local_control::CONTROL_LINE_PREFIX, SERVER_READY_LINE_PREFIX};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

// Only isolated fixture repositories are used. Reap this exact process if a
// regression prevents cooperative shutdown, without leaking a test server.
struct Fixture(Child);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn rpc(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    id: &str,
    method: &str,
    params: Value,
) -> Value {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    socket
        .send(Message::Text(
            json!({"id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let frame = socket.next().await.unwrap().unwrap();
            if let Message::Text(text) = frame {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["id"] == id {
                    break value;
                }
            }
        }
    })
    .await
    .expect("Git RPC must finish with the inherited control pipe open")
}

fn request_json(address: &str, endpoint: &str, body: &str, bearer: Option<&str>) -> Value {
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let authorization = bearer
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    write!(stream, "POST {endpoint} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/x-www-form-urlencoded\r\n{authorization}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "fixture authentication request failed"
    );
    serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
}

#[tokio::test]
async fn inherited_control_allows_git_startup_and_repository_refresh_without_pipe_eof() {
    use tokio_tungstenite::connect_async;

    let repository = tempfile::tempdir().unwrap();
    assert!(Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(repository.path())
        .status()
        .unwrap()
        .success());
    let mut child = Fixture(
        Command::new(env!("CARGO_BIN_EXE_gitgui-server"))
            .args([
                "--ephemeral",
                "--bind",
                "127.0.0.1",
                "--port",
                "0",
                "--repository",
            ])
            .arg(repository.path())
            .env("GITGUI_SERVER_BOOTSTRAP_STDIN", "1")
            .env("GITGUI_SERVER_DESKTOP_CONTROL", "1")
            .env("RUST_LOG", "error")
            .env_remove("GITGUI_SERVER_WEB_DIR")
            .env_remove("GITGUI_SERVER_DEV_URL")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let (tx, rx) = mpsc::channel();
    let stdout = child.0.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let mut stdin = child.0.stdin.take().unwrap();
    stdin.write_all(b"desktop-git-refresh-fixture\n").unwrap();
    stdin.flush().unwrap();
    // Keep stdin open and actively read by the control thread for every Git
    // command. EOF after bootstrap masked Windows inherited-handle deadlocks.
    let address = loop {
        let line = rx
            .recv_timeout(Duration::from_secs(15))
            .expect("Git startup must finish while the desktop control pipe remains open");
        if let Some(payload) = line.strip_prefix(SERVER_READY_LINE_PREFIX) {
            break serde_json::from_str::<Value>(payload).unwrap()["address"]
                .as_str()
                .unwrap()
                .to_owned();
        }
    };
    let session = request_json(&address, "/oauth/token", "grant_type=urn:ietf:params:oauth:grant-type:token-exchange&subject_token=desktop-git-refresh-fixture", None);
    let ticket = request_json(
        &address,
        "/api/auth/websocket-ticket",
        "",
        Some(session["access_token"].as_str().unwrap()),
    );
    let (mut socket, _) = connect_async(format!(
        "ws://{address}/ws?wsTicket={}",
        ticket["ticket"].as_str().unwrap()
    ))
    .await
    .unwrap();
    let catalog = rpc(&mut socket, "catalog", "repositories.list", json!({})).await;
    assert_eq!(catalog["ok"], true);
    let repository_id = catalog["result"]["repositories"][0]["id"].as_str().unwrap();
    let refresh = rpc(
        &mut socket,
        "refresh",
        "repositories.refresh",
        json!({"repositoryIds":[repository_id]}),
    )
    .await;
    assert_eq!(refresh["ok"], true);
    assert!(refresh["result"]["repositories"][0]["snapshot"].is_object());
    assert!(refresh["result"]["repositories"][0]["error"].is_null());
    let snapshot = rpc(
        &mut socket,
        "snapshot",
        "repositories.get_snapshot",
        json!({"repositoryId":repository_id}),
    )
    .await;
    assert_eq!(snapshot["ok"], true);
    socket.close(None).await.unwrap();
    stdin.write_all(b"{\"id\":\"prepare\",\"command\":\"prepare-update\"}\n{\"id\":\"stop\",\"command\":\"shutdown\"}\n").unwrap();
    stdin.flush().unwrap();
    loop {
        let line = rx.recv_timeout(Duration::from_secs(15)).unwrap();
        if let Some(payload) = line.strip_prefix(CONTROL_LINE_PREFIX) {
            let value: Value = serde_json::from_str(payload).unwrap();
            assert_eq!(value["ok"], true);
            if value["id"] == "stop" {
                break;
            }
        }
    }
    assert!(child.0.wait().unwrap().success());
    drop(stdin);
    reader.join().unwrap();
}

#[test]
fn inherited_pipe_pipelining_replies_and_exact_process_exit() {
    let data = tempfile::tempdir().unwrap();
    let identity = br#"{"schema_version":1,"server_id":"gitgui-123456-1788413802919117400"}"#;
    let catalog = br#"{"schema_version":1,"repositories":[]}"#;
    std::fs::write(data.path().join("server.json"), identity).unwrap();
    std::fs::write(data.path().join("repositories.json"), catalog).unwrap();
    let mut child = Fixture(
        Command::new(env!("CARGO_BIN_EXE_gitgui-server"))
            .args(["--bind", "127.0.0.1", "--port", "0", "--data-dir"])
            .arg(data.path())
            .env("GITGUI_SERVER_BOOTSTRAP_STDIN", "1")
            .env("GITGUI_SERVER_DESKTOP_CONTROL", "1")
            .env("RUST_LOG", "error")
            .env_remove("GITGUI_SERVER_WEB_DIR")
            .env_remove("GITGUI_SERVER_DEV_URL")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let mut stdin = child.0.stdin.take().unwrap();
    // One write forces bootstrap read-ahead to retain following control frames.
    stdin.write_all(b"test-bootstrap-not-for-output\n{\"id\":\"reject\",\"command\":\"shutdown\"}\n{\"id\":\"prepare\",\"command\":\"prepare-update\"}\n{\"id\":\"resume\",\"command\":\"resume\"}\n{\"id\":\"prepare-again\",\"command\":\"prepare-update\"}\n{\"id\":\"stop\",\"command\":\"shutdown\"}\n").unwrap();
    stdin.flush().unwrap();
    let mut ready = false;
    let mut replies = Vec::new();
    while replies.len() < 5 {
        let line = rx
            .recv_timeout(Duration::from_secs(15))
            .expect("bounded control reply");
        assert!(!line.contains("test-bootstrap-not-for-output"));
        if line.starts_with(SERVER_READY_LINE_PREFIX) {
            ready = true;
        }
        if let Some(json) = line.strip_prefix(CONTROL_LINE_PREFIX) {
            assert!(line.len() < 512);
            replies.push(serde_json::from_str::<Value>(json).unwrap());
        }
    }
    assert!(ready);
    for (reply, (id, ok)) in replies.iter().zip([
        ("reject", false),
        ("prepare", true),
        ("resume", true),
        ("prepare-again", true),
        ("stop", true),
    ]) {
        assert_eq!(reply["id"], id);
        assert_eq!(reply["ok"], json!(ok));
    }
    // Keep stdin open: accepted shutdown must not await pipe EOF or a signal.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "server must exit after acknowledging shutdown"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(stdin);
    reader.join().unwrap();
    assert_eq!(std::fs::read(data.path().join("server.json")).unwrap(), identity);
    assert_eq!(std::fs::read(data.path().join("repositories.json")).unwrap(), catalog);
}
