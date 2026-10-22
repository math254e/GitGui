use super::*;
use tokio_tungstenite::{
    connect_async, tungstenite::Message as ClientMessage, MaybeTlsStream, WebSocketStream,
};

type Client = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

fn git(root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn repository() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    git(root.path(), &["config", "user.name", "RPC Test"]);
    git(root.path(), &["config", "user.email", "rpc@example.test"]);
    fs::write(root.path().join("file.txt"), "before\n").unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "Initial"]);
    fs::write(root.path().join("file.txt"), "after\n").unwrap();
    root
}

// Use the production socket loop without filesystem watcher events. Its exit
// signal lets disconnect tests assert cleanup without guessing a sleep delay.
async fn socket(
    state: Arc<ServerState>,
    scopes: Vec<String>,
) -> (Client, oneshot::Receiver<()>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (done, exited) = oneshot::channel();
    let done = Arc::new(Mutex::new(Some(done)));
    let app = Router::new().route(
        "/ws",
        get(move |upgrade: WebSocketUpgrade| {
            let state = state.clone();
            let done = done.clone();
            let session = AuthSession {
                session_id: "test".into(),
                environment_id: state.info.environment_id.clone(),
                scopes: scopes.clone(),
                expires_at_unix_ms: u64::MAX,
            };
            async move {
                upgrade.on_upgrade(move |socket| async move {
                    handle_socket(socket, state, session).await;
                    if let Some(done) = done.lock().await.take() {
                        let _ = done.send(());
                    }
                })
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (mut socket, _) = connect_async(format!("ws://{addr}/ws")).await.unwrap();
    assert_eq!(receive(&mut socket).await["type"], "welcome");
    (socket, exited, server)
}

fn state(root: &Path) -> Arc<ServerState> {
    let repositories = build_repository_catalog(&[root.display().to_string()]);
    Arc::new(ServerState::new(
        &ServerConfig::default(),
        "127.0.0.1:0".parse().unwrap(),
        repositories,
    ))
}

async fn send(socket: &mut Client, id: &str, method: &str, params: Value) {
    socket
        .send(ClientMessage::Text(
            json!({"id": id, "method": method, "params": params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
}

async fn receive(socket: &mut Client) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            if let ClientMessage::Text(text) = message {
                return serde_json::from_str(&text).unwrap();
            }
        }
    })
    .await
    .expect("RPC response deadline")
}

#[tokio::test]
async fn slow_read_does_not_block_responses_errors_or_cancellation() {
    let root = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let lock = state.git_mutation_lock(&id).await;
    let guard = lock.lock().await;
    let (mut client, exited, server) = socket(state, vec![SCOPE_REPOSITORY_READ.into()]).await;
    send(
        &mut client,
        "slow",
        METHOD_GIT_HUNK_PREVIEW,
        json!({"repositoryId": id, "filePath": "file.txt", "staged": false}),
    )
    .await;
    send(
        &mut client,
        "fast",
        METHOD_GIT_WORKING_TREE_FILE_DIFF,
        json!({"repositoryId": id, "filePath": "file.txt", "staged": false}),
    )
    .await;
    let fast = receive(&mut client).await;
    assert_eq!(fast["id"], "fast");
    assert_eq!(fast["ok"], true);
    send(
        &mut client,
        "denied",
        METHOD_GIT_STAGE,
        json!({"repositoryId": "other", "paths": []}),
    )
    .await;
    assert_eq!(
        receive(&mut client).await["error"]["code"],
        error_codes::FORBIDDEN
    );
    client
        .send(ClientMessage::Binary(vec![255].into()))
        .await
        .unwrap();
    assert_eq!(receive(&mut client).await["type"], "protocol_error");
    client
        .send(ClientMessage::Text(
            json!({"id": "malformed", "method": 42}).to_string().into(),
        ))
        .await
        .unwrap();
    let error = receive(&mut client).await;
    assert_eq!(error["id"], "malformed");
    assert_eq!(error["error"]["code"], error_codes::INVALID_REQUEST);
    client
        .send(ClientMessage::Text(
            json!({"type": "cancel", "id": "slow"}).to_string().into(),
        ))
        .await
        .unwrap();
    let cancelled = receive(&mut client).await;
    assert_eq!(cancelled["id"], "slow");
    assert_eq!(cancelled["error"]["code"], "request_cancelled");
    drop(guard);
    send(&mut client, "probe", METHOD_SERVER_GET_STATUS, json!({})).await;
    assert_eq!(receive(&mut client).await["id"], "probe");
    client.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), exited)
        .await
        .unwrap()
        .unwrap();
    server.abort();
}

#[tokio::test]
async fn same_repository_mutations_keep_wire_order() {
    let root = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let lock = state.git_mutation_lock(&id).await;
    let guard = lock.lock().await;
    let (mut client, exited, server) = socket(state, vec![SCOPE_REPOSITORY_OPERATE.into()]).await;
    send(
        &mut client,
        "stage",
        METHOD_GIT_STAGE,
        json!({"repositoryId": id, "paths": ["file.txt"]}),
    )
    .await;
    send(
        &mut client,
        "unstage",
        METHOD_GIT_UNSTAGE,
        json!({"repositoryId": id, "paths": ["file.txt"]}),
    )
    .await;
    send(&mut client, "probe", METHOD_SERVER_GET_STATUS, json!({})).await;
    assert_eq!(receive(&mut client).await["id"], "probe");
    // A cancellation notification cannot remove a queued mutation.
    client
        .send(ClientMessage::Text(
            json!({"type": "cancel", "id": "unstage"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    drop(guard);
    for id in ["stage", "unstage"] {
        let response = receive(&mut client).await;
        assert_eq!(response["id"], id);
        assert_eq!(response["ok"], true, "{response}");
    }
    assert!(git(root.path(), &["diff", "--cached", "--name-only"]).is_empty());
    client.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), exited)
        .await
        .unwrap()
        .unwrap();
    server.abort();
}

#[tokio::test]
async fn failed_mutation_releases_its_lane_and_lock() {
    let root = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let (mut client, exited, server) = socket(state, vec![SCOPE_REPOSITORY_OPERATE.into()]).await;
    send(
        &mut client,
        "failure",
        METHOD_GIT_STAGE,
        json!({"repositoryId": id, "paths": ["missing.txt"]}),
    )
    .await;
    send(
        &mut client,
        "next",
        METHOD_GIT_STAGE,
        json!({"repositoryId": id, "paths": ["file.txt"]}),
    )
    .await;
    let failure = receive(&mut client).await;
    assert_eq!(failure["id"], "failure");
    assert_eq!(failure["error"]["code"], error_codes::GIT_OPERATION_FAILED);
    let next = receive(&mut client).await;
    assert_eq!(next["id"], "next");
    assert_eq!(next["ok"], true);
    assert_eq!(
        git(root.path(), &["diff", "--cached", "--name-only"]),
        "file.txt"
    );
    client.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), exited)
        .await
        .unwrap()
        .unwrap();
    server.abort();
}

#[tokio::test]
async fn disconnect_drops_queued_mutations_but_retains_active_worker_lock() {
    let root = repository();
    git(root.path(), &["add", "file.txt"]);
    let hook = root.path().join(".git/hooks/pre-commit");
    fs::write(
        &hook,
        "#!/bin/sh\ntouch .git/rpc-entered\nwhile [ ! -f .git/rpc-release ]; do sleep 0.05; done\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    // Always release the hook, including when an assertion fails.
    struct Release(PathBuf);
    impl Drop for Release {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, "release");
        }
    }
    let release = Release(root.path().join(".git/rpc-release"));
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let lock = state.git_mutation_lock(&id).await;
    let (mut client, exited, server) =
        socket(state.clone(), vec![SCOPE_REPOSITORY_OPERATE.into()]).await;
    send(
        &mut client,
        "commit",
        METHOD_GIT_COMMIT,
        json!({"repositoryId": id, "summary": "Active commit"}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !root.path().join(".git/rpc-entered").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("pre-commit hook started");
    send(
        &mut client,
        "queued",
        METHOD_GIT_BRANCH_CREATE,
        json!({"repositoryId": id, "name": "must-not-run"}),
    )
    .await;
    send(&mut client, "probe", METHOD_SERVER_GET_STATUS, json!({})).await;
    assert_eq!(receive(&mut client).await["id"], "probe");
    client.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), exited)
        .await
        .unwrap()
        .unwrap();
    assert!(
        lock.try_lock().is_err(),
        "disconnect must not release a live worker's lock"
    );
    drop(release);
    let _guard = tokio::time::timeout(Duration::from_secs(10), lock.lock())
        .await
        .unwrap();
    assert_eq!(
        git(root.path(), &["log", "-1", "--format=%s"]),
        "Active commit"
    );
    assert!(!git(root.path(), &["branch", "--list"]).contains("must-not-run"));
    server.abort();
}

#[tokio::test]
async fn prefetch_is_bounded_and_validates_the_entire_hint() {
    let root = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let hash = git(root.path(), &["rev-parse", "HEAD"]);
    let targets =
        vec![json!({"commitHash": hash, "filePath": "file.txt"}); MAX_PREFETCH_COMMIT_DIFF_TARGETS];
    let response = git_prefetch_commit_diffs(
        "prefetch".into(),
        json!({"repositoryId": id, "targets": targets}),
        &state,
    )
    .await;
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(response["result"]["count"], 1);
    let response = git_prefetch_commit_files(
        "files".into(),
        json!({"repositoryId": id, "commitHashes": [hash, hash]}),
        &state,
    )
    .await;
    assert_eq!(
        serde_json::to_value(response).unwrap()["result"]["count"],
        1
    );
    let response = git_prefetch_commit_files(
        "invalid-tail".into(),
        json!({"repositoryId": id, "commitHashes": [hash, "invalid"]}),
        &state,
    )
    .await;
    assert_eq!(
        serde_json::to_value(response).unwrap()["error"]["code"],
        error_codes::INVALID_PARAMS
    );
    let response = git_prefetch_commit_diffs("bad".into(), json!({"repositoryId": id, "targets": [
        {"commitHash": hash, "filePath": "file.txt"}, {"commitHash": hash, "filePath": "../outside"}
    ]}), &state).await;
    assert_eq!(
        serde_json::to_value(response).unwrap()["error"]["code"],
        error_codes::INVALID_PARAMS
    );
}
