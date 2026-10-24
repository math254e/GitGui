use super::*;
use crate::rpc_tests::{
    git, receive, repository as rpc_repository, send, socket, state, Client, GIT_FIXTURE_DEADLINE,
};
use futures_util::SinkExt;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_tungstenite::tungstenite::Message as ClientMessage;

#[derive(Debug, PartialEq)]
pub(super) enum MutationProgress {
    CommonLockPending,
    CommonLockAcquired,
    WorkerEntered,
}

tokio::task_local! {
    // Scoped to one dispatch future, never shared by parallel fixtures or RPCs.
    static MUTATION_PROGRESS: tokio::sync::mpsc::UnboundedSender<MutationProgress>;
}

pub(super) fn mutation_progress() -> Option<tokio::sync::mpsc::UnboundedSender<MutationProgress>> {
    MUTATION_PROGRESS.try_with(Clone::clone).ok()
}

pub(super) fn report_progress(
    observer: &Option<tokio::sync::mpsc::UnboundedSender<MutationProgress>>,
    progress: MutationProgress,
) {
    if let Some(observer) = observer {
        let _ = observer.send(progress);
    }
}

pub(super) async fn observe_common_lock<F: std::future::Future>(acquisition: F) -> F::Output {
    let observer = mutation_progress();
    let mut acquisition = std::pin::pin!(acquisition);
    let mut reported_pending = false;
    std::future::poll_fn(|cx| {
        // Report only after polling the actual acquisition, after Git metadata
        // discovery. A first suspension elsewhere cannot satisfy this proof.
        let result = acquisition.as_mut().poll(cx);
        if result.is_pending() && !reported_pending {
            report_progress(&observer, MutationProgress::CommonLockPending);
            reported_pending = true;
        }
        result
    })
    .await
}

fn repository() -> tempfile::TempDir {
    let root = rpc_repository();
    git(root.path(), &["config", "core.autocrlf", "false"]);
    git(root.path(), &["config", "commit.gpgsign", "false"]);
    root
}

async fn call(state: &ServerState, method: &str, params: Value) -> Value {
    serde_json::to_value(
        crate::dispatch(
            RequestEnvelope {
                id: "stash-test".into(),
                method: method.into(),
                params,
            },
            state,
        )
        .await,
    )
    .unwrap()
}

fn success(response: Value) -> Value {
    assert_eq!(response["ok"], true, "{response}");
    assert!(
        response["result"].get("snapshot").is_none(),
        "new receipts have no refresh dependency"
    );
    response["result"].clone()
}

fn target(root: &Path, n: usize) -> Value {
    let selector = format!("stash@{{{n}}}");
    json!({"selector": selector, "expectedOid": git(root, &["rev-parse", &format!("refs/{selector}")])})
}

async fn response(client: &mut Client, id: &str) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                if let ClientMessage::Text(text) = client
                    .next()
                    .await
                    .expect("open socket")
                    .expect("valid frame")
                {
                    break serde_json::from_str::<Value>(&text).unwrap();
                }
            }
        })
        .await
        .expect("stash RPC response deadline");
        if frame["id"] == id {
            return frame;
        }
        assert_eq!(frame["type"], "event", "unexpected frame {frame}");
    }
}

fn native_stash(root: &Path, contents: &str) -> Value {
    fs::write(root.join("file.txt"), contents).unwrap();
    git(root, &["stash", "push", "-u", "-m", "saved fixture"]);
    target(root, 0)
}

fn hook(root: &Path, name: &str, body: &str) {
    let path = root.join(".git/hooks").join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[tokio::test]
async fn all_seven_methods_are_dispatched_advertised_once_and_have_exact_scopes() {
    let root = repository();
    let state = state(root.path());
    let accepted = gitgui_protocol::WS_METHOD_NAMES;
    assert_eq!(
        accepted.len(),
        accepted.iter().collect::<HashSet<_>>().len()
    );
    let caps = &state.info.capabilities;
    assert_eq!(caps.len(), caps.iter().collect::<HashSet<_>>().len());
    let (mut reader, _, reader_server) =
        socket(state.clone(), vec![SCOPE_REPOSITORY_READ.into()]).await;
    let (mut operator, _, operator_server) =
        socket(state.clone(), vec![SCOPE_REPOSITORY_OPERATE.into()]).await;
    for method in gitgui_protocol::STASH_FEATURE_METHOD_NAMES {
        assert!(accepted.contains(method));
        assert_eq!(caps.iter().filter(|cap| cap.as_str() == *method).count(), 1);
        let read = matches!(*method, METHOD_GIT_STASH_FILES | METHOD_GIT_STASH_FILE_DIFF);
        assert_eq!(
            required_scope_for_method(method),
            Some(if read {
                SCOPE_REPOSITORY_READ
            } else {
                SCOPE_REPOSITORY_OPERATE
            })
        );
        send(&mut reader, "scope", method, json!({})).await;
        let response = response(&mut reader, "scope").await;
        assert_eq!(
            response["error"]["code"],
            if read {
                error_codes::INVALID_PARAMS
            } else {
                error_codes::FORBIDDEN
            }
        );
        send(&mut operator, "scope", method, json!({})).await;
        let response = self::response(&mut operator, "scope").await;
        assert_eq!(
            response["error"]["code"],
            if read {
                error_codes::FORBIDDEN
            } else {
                error_codes::INVALID_PARAMS
            }
        );
    }
    assert!(git(root.path(), &["stash", "list"]).is_empty());
    reader.close(None).await.unwrap();
    operator.close(None).await.unwrap();
    reader_server.abort();
    operator_server.abort();
}

#[tokio::test]
async fn authenticated_ticket_sessions_enforce_read_and_operate_independently() {
    use tokio_tungstenite::connect_async;
    let root = repository();
    let reviewed = native_stash(root.path(), "saved\n");
    let bootstrap = uuid::Uuid::new_v4().to_string();
    let config = ServerConfig {
        bootstrap_token: Some(bootstrap.clone()),
        ..ServerConfig::default()
    };
    let state = Arc::new(ServerState::new(
        &config,
        "127.0.0.1:0".parse().unwrap(),
        build_repository_catalog(&[root.path().display().to_string()]),
    ));
    let id = state.repositories.read().await[0].summary.id.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = router(state.clone(), None);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    for (scope, allowed, denied) in [
        (
            SCOPE_REPOSITORY_READ,
            METHOD_GIT_STASH_FILES,
            METHOD_GIT_STASH_DROP,
        ),
        (
            SCOPE_REPOSITORY_OPERATE,
            METHOD_GIT_STASH_DROP,
            METHOD_GIT_STASH_FILES,
        ),
    ] {
        let session = state.auth.exchange(&bootstrap, Some(scope)).await.unwrap();
        let ticket = state
            .auth
            .issue_websocket_ticket(&session.access_token)
            .await
            .unwrap();
        let (mut client, _) =
            connect_async(format!("ws://{address}/ws?wsTicket={}", ticket.ticket))
                .await
                .unwrap();
        assert_eq!(receive(&mut client).await["type"], "welcome");
        send(
            &mut client,
            "denied",
            denied,
            json!({"repositoryId":id,"target":reviewed}),
        )
        .await;
        assert_eq!(
            response(&mut client, "denied").await["error"]["code"],
            error_codes::FORBIDDEN
        );
        send(
            &mut client,
            "allowed",
            allowed,
            json!({"repositoryId":id,"target":reviewed}),
        )
        .await;
        assert_eq!(response(&mut client, "allowed").await["ok"], true);
        client.close(None).await.unwrap();
    }
    server.abort();
}

#[tokio::test]
async fn selected_staged_receipt_preserves_unstaged_and_unrelated_index_changes() {
    let root = repository();
    git(root.path(), &["config", "core.autocrlf", "false"]);
    fs::write(root.path().join("file.txt"), "a\nb\nc\nd\ne\n").unwrap();
    fs::write(root.path().join("other.txt"), "other\n").unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "multiline base"]);
    fs::write(root.path().join("file.txt"), "A\nb\nc\nd\ne\n").unwrap();
    fs::write(root.path().join("other.txt"), "other staged\n").unwrap();
    git(root.path(), &["add", "."]);
    fs::write(root.path().join("file.txt"), "A\nb\nc\nd\nE\n").unwrap();
    let state = state(root.path());
    let id = &state.repositories.read().await[0].summary.id.clone();
    let params =
        json!({"repositoryId": id, "source":"staged", "paths":["file.txt"], "message":"selected"});
    let saved = success(call(&state, METHOD_GIT_STASH_PUSH_SELECTED, params.clone()).await);
    assert_eq!(saved["repositoryId"], *id);
    assert_eq!(saved["outcome"], "success");
    assert!(saved["error"].is_null());
    assert_eq!(saved["stash"]["selector"], "stash@{0}");
    assert_eq!(git(root.path(), &["show", ":file.txt"]), "a\nb\nc\nd\ne");
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "a\nb\nc\nd\nE\n"
    );
    assert_eq!(git(root.path(), &["show", ":other.txt"]), "other staged");
    let files = success(
        call(
            &state,
            METHOD_GIT_STASH_FILES,
            json!({"repositoryId":id,"target":target(root.path(),0)}),
        )
        .await,
    );
    assert_eq!(files["files"].as_array().unwrap().len(), 1);
    assert_eq!(files["files"][0]["path"], "file.txt");
    let noop = success(call(&state, METHOD_GIT_STASH_PUSH_SELECTED, params).await);
    assert_eq!(noop["outcome"], "noChanges");
    assert!(noop["stash"].is_null());
    assert_eq!(git(root.path(), &["stash", "list"]).lines().count(), 1);
}

#[tokio::test]
async fn selected_unstaged_inverse_and_untracked_inspection_branch_at_original_head() {
    let root = repository();
    git(root.path(), &["config", "core.autocrlf", "false"]);
    let original = git(root.path(), &["rev-parse", "HEAD"]);
    git(root.path(), &["add", "file.txt"]); // H before, index after
    fs::write(root.path().join("file.txt"), "before\n").unwrap();
    let untracked = "new [æ].txt";
    fs::write(root.path().join(untracked), "saved untracked\n").unwrap();
    let index = fs::read(root.path().join(".git/index")).unwrap();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let saved = success(
        call(
            &state,
            METHOD_GIT_STASH_PUSH_SELECTED,
            json!({"repositoryId":id,"source":"unstaged","paths":["file.txt",untracked]}),
        )
        .await,
    );
    assert_eq!(saved["outcome"], "success");
    assert_eq!(saved["stash"]["baseHash"], original);
    assert_eq!(fs::read(root.path().join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "after\n"
    );
    assert!(!root.path().join(untracked).exists());
    let target = target(root.path(), 0);
    let files = success(
        call(
            &state,
            METHOD_GIT_STASH_FILES,
            json!({"repositoryId":id,"target":target}),
        )
        .await,
    );
    assert_eq!(files["files"].as_array().unwrap().len(), 2);
    for (path, before, after) in [
        ("file.txt", "after\n", "before\n"),
        (untracked, "", "saved untracked\n"),
    ] {
        let diff = success(
            call(
                &state,
                METHOD_GIT_STASH_FILE_DIFF,
                json!({"repositoryId":id,"target":target,"filePath":path}),
            )
            .await,
        );
        assert_eq!(diff["diff"]["originalContent"], before);
        assert_eq!(diff["diff"]["modifiedContent"], after);
        assert!(diff.get("hunkContextId").is_none());
    }
    let branch = success(
        call(
            &state,
            METHOD_GIT_STASH_BRANCH,
            json!({"repositoryId":id,"target":target,"name":"rescue-inverse"}),
        )
        .await,
    );
    assert_eq!(branch["outcome"], "success");
    assert_eq!(branch["stashState"], "removed");
    assert_eq!(
        branch["branch"],
        json!({"name":"rescue-inverse","switched":true})
    );
    assert_eq!(git(root.path(), &["rev-parse", "HEAD"]), original);
    assert_eq!(git(root.path(), &["show", ":file.txt"]), "after");
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "before\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join(untracked)).unwrap(),
        "saved untracked\n"
    );
}

#[tokio::test]
async fn validation_refuses_empty_unknown_force_stale_and_oversized_inputs_without_stash_all() {
    let root = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    for paths in [
        json!([]),
        json!(["../out"]),
        json!([".git/config"]),
        json!(["a//b"]),
        json!(["a/./b"]),
        json!(["a\u{0}b"]),
        json!(["file.txt", "file.txt"]),
        json!(["a".repeat(MAX_PATH_BYTES + 1)]),
        json!(vec!["x"; MAX_PATHS + 1]),
    ] {
        let r = call(
            &state,
            METHOD_GIT_STASH_PUSH_SELECTED,
            json!({"repositoryId":id,"source":"unstaged","paths":paths}),
        )
        .await;
        assert_eq!(r["error"]["code"], error_codes::INVALID_PARAMS, "{r}");
    }
    for extras in [
        json!({"force":true}),
        json!({"includeUntracked":true}),
        json!({"source":"all"}),
        json!({"message":"x".repeat(4097)}),
    ] {
        let mut p = json!({"repositoryId":id,"source":"unstaged","paths":["file.txt"]});
        p.as_object_mut()
            .unwrap()
            .extend(extras.as_object().unwrap().clone());
        assert_eq!(
            call(&state, METHOD_GIT_STASH_PUSH_SELECTED, p).await["error"]["code"],
            error_codes::INVALID_PARAMS
        );
    }
    assert!(git(root.path(), &["stash", "list"]).is_empty());
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "after\n"
    );
    let good = native_stash(root.path(), "saved\n");
    for method in [
        METHOD_GIT_STASH_APPLY,
        METHOD_GIT_STASH_POP_TARGET,
        METHOD_GIT_STASH_DROP,
        METHOD_GIT_STASH_BRANCH,
        METHOD_GIT_STASH_FILES,
        METHOD_GIT_STASH_FILE_DIFF,
    ] {
        let mut p = json!({"repositoryId":id,"target":good});
        if method == METHOD_GIT_STASH_BRANCH {
            p["name"] = json!("rescue");
        }
        if method == METHOD_GIT_STASH_FILE_DIFF {
            p["filePath"] = json!("file.txt");
        }
        let mut extra = p.clone();
        extra["force"] = json!(true);
        assert_eq!(
            call(&state, method, extra).await["error"]["code"],
            error_codes::INVALID_PARAMS
        );
        let mut nested = p.clone();
        nested["target"]["extra"] = json!(true);
        assert_eq!(
            call(&state, method, nested).await["error"]["code"],
            error_codes::INVALID_PARAMS
        );
        for bad in [
            json!({"selector":"stash@{00}","expectedOid":"a".repeat(40)}),
            json!({"selector":"stash@{0}","expectedOid":"abcd"}),
            json!({"selector":"refs/stash","expectedOid":"a".repeat(40)}),
            json!({"selector":"stash@{0}","expectedOid":"a".repeat(64)}),
        ] {
            let mut badp = p.clone();
            badp["target"] = bad;
            assert_eq!(
                call(&state, method, badp).await["error"]["code"],
                error_codes::INVALID_PARAMS
            );
        }
        p["target"]["expectedOid"] = json!("a".repeat(40));
        assert_eq!(
            call(&state, method, p).await["error"]["code"],
            error_codes::STASH_TARGET_CHANGED
        );
    }
    for name in ["@", "HEAD", "-bad", "a..b", "has space", "x.lock", "a@{b"] {
        assert_eq!(
            call(
                &state,
                METHOD_GIT_STASH_BRANCH,
                json!({"repositoryId":id,"target":good,"name":name})
            )
            .await["error"]["code"],
            error_codes::INVALID_PARAMS
        );
    }
    assert_eq!(
        call(
            &state,
            METHOD_GIT_STASH_FILES,
            json!({"repositoryId":"unknown","target":good})
        )
        .await["error"]["code"],
        error_codes::REPOSITORY_NOT_CONFIGURED
    );
    assert_eq!(git(root.path(), &["stash", "list"]).lines().count(), 1);
}

#[tokio::test]
async fn nonlatest_apply_safe_delete_and_stale_targets_never_act_on_latest() {
    let root = repository();
    let older = native_stash(root.path(), "older\n");
    let latest = native_stash(root.path(), "latest\n");
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let mut old = older.clone();
    old["selector"] = json!("stash@{1}");
    let stale = call(
        &state,
        METHOD_GIT_STASH_DROP,
        json!({"repositoryId":id,"target":older}),
    )
    .await;
    assert_eq!(stale["error"]["code"], error_codes::STASH_TARGET_CHANGED);
    let applied = success(
        call(
            &state,
            METHOD_GIT_STASH_APPLY,
            json!({"repositoryId":id,"target":old}),
        )
        .await,
    );
    assert_eq!(applied["outcome"], "success");
    assert_eq!(applied["stashState"], "retained");
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "older\n"
    );
    let dropped = success(
        call(
            &state,
            METHOD_GIT_STASH_DROP,
            json!({"repositoryId":id,"target":old}),
        )
        .await,
    );
    assert_eq!(dropped["stashState"], "removed");
    assert_eq!(dropped["restore"], "notAttempted");
    assert_eq!(target(root.path(), 0), latest);
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "older\n"
    );
}

#[tokio::test]
async fn pop_success_removes_but_conflicts_and_untracked_partial_restore_retain() {
    for mode in ["success", "conflicts", "untracked"] {
        let root = repository();
        if mode == "untracked" {
            fs::write(root.path().join("extra.txt"), "saved\n").unwrap();
        }
        let reviewed = native_stash(root.path(), "saved\n");
        if mode == "conflicts" {
            fs::write(root.path().join("file.txt"), "foreign\n").unwrap();
            git(root.path(), &["commit", "-am", "divergent"]);
        }
        if mode == "untracked" {
            fs::write(root.path().join("extra.txt"), "foreign\n").unwrap();
        }
        let state = state(root.path());
        let id = state.repositories.read().await[0].summary.id.clone();
        let receipt = success(
            call(
                &state,
                METHOD_GIT_STASH_POP_TARGET,
                json!({"repositoryId":id,"target":reviewed}),
            )
            .await,
        );
        assert_eq!(
            receipt["outcome"],
            match mode {
                "success" => "success",
                "conflicts" => "conflicts",
                _ => "partial",
            }
        );
        assert_eq!(
            receipt["stashState"],
            if mode == "success" {
                "removed"
            } else {
                "retained"
            }
        );
        if mode == "conflicts" {
            assert_eq!(receipt["restore"], "conflicts");
            assert!(!git(root.path(), &["ls-files", "--unmerged"]).is_empty());
        }
        if mode == "untracked" {
            assert_eq!(
                fs::read_to_string(root.path().join("extra.txt")).unwrap(),
                "foreign\n"
            );
            assert_eq!(receipt["restore"], "failed");
        }
        assert_eq!(
            git(root.path(), &["stash", "list"]).is_empty(),
            mode == "success"
        );
    }
}

#[tokio::test]
async fn branch_reports_created_and_switched_progress_when_hook_fails() {
    let root = repository();
    let reviewed = native_stash(root.path(), "saved\n");
    hook(
        root.path(),
        "post-checkout",
        "echo sensitive-stash-test >&2\nexit 1",
    );
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let receipt = success(
        call(
            &state,
            METHOD_GIT_STASH_BRANCH,
            json!({"repositoryId":id,"target":reviewed,"name":"rescue"}),
        )
        .await,
    );
    assert_eq!(receipt["outcome"], "branchCreatedRestoreFailed");
    assert_eq!(receipt["stashState"], "retained");
    assert_eq!(receipt["restore"], "failed");
    assert_eq!(receipt["branch"], json!({"name":"rescue","switched":true}));
    assert_eq!(git(root.path(), &["branch", "--show-current"]), "rescue");
    assert!(!receipt.to_string().contains("sensitive-stash-test"));
    assert!(receipt["error"].get("details").is_none());
}

#[test]
fn literal_path_validation_preserves_supported_control_characters_and_bounds() {
    for p in [
        "has space",
        "tabs\tand\nnewlines",
        "Unicode-æ",
        "-option",
        "a:b",
        "glob[*]?",
        "back\\slash",
    ] {
        assert!(validate_path(p, false).is_ok(), "{p:?}");
        #[cfg(not(windows))]
        assert!(validate_path(p, true).is_ok(), "{p:?}");
    }
    for p in [
        "",
        "/absolute",
        "../escape",
        "x/../escape",
        "x/./file",
        "x//file",
        "null\0byte",
    ] {
        assert!(validate_path(p, false).is_err());
    }
    assert!(validate_path(&vec!["dir"; 129].join("/"), false).is_err());
}

#[tokio::test]
async fn selected_partial_receipt_keeps_saved_stash_and_preserves_unresolved_live_sides() {
    let root = repository();
    git(root.path(), &["add", "file.txt"]);
    fs::write(root.path().join("file.txt"), "before\n").unwrap();
    let original_index = fs::read(root.path().join(".git/index")).unwrap();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let saved = success(
        call(
            &state,
            METHOD_GIT_STASH_PUSH_SELECTED,
            json!({"repositoryId":id,"source":"staged","paths":["file.txt"]}),
        )
        .await,
    );
    assert_eq!(saved["outcome"], "partial");
    assert!(saved["stash"].is_object());
    assert_eq!(
        saved["stash"]["hash"],
        target(root.path(), 0)["expectedOid"]
    );
    assert_eq!(saved["error"]["code"], error_codes::GIT_OPERATION_FAILED);
    assert!(saved["error"].get("details").is_none());
    assert_eq!(
        fs::read(root.path().join(".git/index")).unwrap(),
        original_index
    );
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "before\n"
    );
}

#[tokio::test]
async fn full_sha256_targets_dispatch_and_missing_entries_have_target_changed_code() {
    let root = tempfile::tempdir().unwrap();
    git(
        root.path(),
        &["init", "-b", "main", "--object-format=sha256"],
    );
    git(root.path(), &["config", "user.name", "Stash server test"]);
    git(
        root.path(),
        &["config", "user.email", "stash@example.invalid"],
    );
    git(root.path(), &["config", "core.autocrlf", "false"]);
    git(root.path(), &["config", "commit.gpgsign", "false"]);
    fs::write(root.path().join("file.txt"), "base\n").unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "base"]);
    let reviewed = native_stash(root.path(), "saved\n");
    assert_eq!(reviewed["expectedOid"].as_str().unwrap().len(), 64);
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    success(
        call(
            &state,
            METHOD_GIT_STASH_FILES,
            json!({"repositoryId":id,"target":reviewed}),
        )
        .await,
    );
    let mut missing = reviewed.clone();
    missing["selector"] = json!("stash@{5}");
    for method in [METHOD_GIT_STASH_DROP, METHOD_GIT_STASH_FILES] {
        assert_eq!(
            call(&state, method, json!({"repositoryId":id,"target":missing})).await["error"]
                ["code"],
            error_codes::STASH_TARGET_CHANGED
        );
    }
    let dropped = success(
        call(
            &state,
            METHOD_GIT_STASH_DROP,
            json!({"repositoryId":id,"target":reviewed}),
        )
        .await,
    );
    assert_eq!(dropped["stashState"], "removed");
}

#[test]
fn configured_capabilities_cannot_advertise_duplicates_or_unimplemented_methods() {
    let config = ServerConfig {
        capabilities: vec![
            METHOD_GIT_STASH_APPLY.into(),
            "git.stash.force".into(),
            METHOD_GIT_STASH_APPLY.into(),
        ],
        ..ServerConfig::default()
    };
    let state = ServerState::new(&config, "127.0.0.1:0".parse().unwrap(), vec![]);
    assert_eq!(state.info.capabilities, vec![METHOD_GIT_STASH_APPLY]);
}

#[tokio::test]
async fn legacy_stash_defaults_include_untracked_and_keep_snapshot_result_shapes() {
    let root = repository();
    fs::write(root.path().join("legacy-untracked.txt"), "legacy\n").unwrap();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    for method in [METHOD_GIT_STASH_PUSH, METHOD_GIT_STASH_POP] {
        let response = call(&state, method, json!({"repositoryId":id})).await;
        assert_eq!(response["ok"], true, "{response}");
        let result = &response["result"];
        assert_eq!(
            result
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<HashSet<_>>(),
            HashSet::from(["repository".to_string(), "snapshot".to_string()])
        );
        assert_eq!(result["repository"]["id"], id);
        if method == METHOD_GIT_STASH_PUSH {
            assert!(!root.path().join("legacy-untracked.txt").exists());
            assert_eq!(result["snapshot"]["stashes"].as_array().unwrap().len(), 1);
        } else {
            assert_eq!(
                fs::read_to_string(root.path().join("legacy-untracked.txt")).unwrap(),
                "legacy\n"
            );
            assert!(result["snapshot"]["stashes"].as_array().unwrap().is_empty());
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn utf8_tabs_newlines_backslashes_and_colons_round_trip_literally() {
    let root = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let names = ["a\tb\nc", "back\\slash", "a:b", "-path", "glob[*]?"];
    for path in names {
        fs::write(root.path().join(path), "literal contents\n").unwrap();
    }
    let saved = success(
        call(
            &state,
            METHOD_GIT_STASH_PUSH_SELECTED,
            json!({"repositoryId":id,"source":"unstaged","paths":names}),
        )
        .await,
    );
    assert_eq!(saved["outcome"], "success");
    for path in names {
        let diff = success(
            call(
                &state,
                METHOD_GIT_STASH_FILE_DIFF,
                json!({"repositoryId":id,"target":target(root.path(),0),"filePath":path}),
            )
            .await,
        );
        assert_eq!(diff["diff"]["modifiedContent"], "literal contents\n");
    }
}

async fn linked_registration(state: &ServerState, root: &Path, linked: &Path) -> String {
    git(
        root,
        &[
            "worktree",
            "add",
            "-b",
            "linked-stash-test",
            linked.to_str().unwrap(),
        ],
    );
    let entry = build_repository_catalog(&[linked.display().to_string()])
        .pop()
        .unwrap();
    let id = entry.summary.id.clone();
    state.upsert_repository(entry).await.unwrap();
    id
}

async fn wait_locked(lock: &Arc<Mutex<()>>) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while lock.try_lock().is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("dispatch acquired worktree guard");
}

#[tokio::test]
async fn common_directory_lock_serializes_linked_and_legacy_stashes_and_keeps_worktree_lock() {
    let root = repository();
    let parent = tempfile::tempdir().unwrap();
    let linked = parent.path().join("linked");
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let linked_id = linked_registration(&state, root.path(), &linked).await;
    fs::write(linked.join("file.txt"), "linked work\n").unwrap();
    let common = common_directory(root.path().to_str().unwrap()).unwrap();
    assert_eq!(common, common_directory(linked.to_str().unwrap()).unwrap());
    let common_lock = state.stash_mutation_lock(&common).await;
    assert!(Arc::ptr_eq(
        &common_lock,
        &state
            .stash_mutation_lock(&common_directory(linked.to_str().unwrap()).unwrap())
            .await
    ));
    let common_guard = common_lock.lock_owned().await;
    let main_lock = state.git_mutation_lock(&id).await;
    let linked_lock = state.git_mutation_lock(&linked_id).await;
    assert!(
        !Arc::ptr_eq(&main_lock, &linked_lock),
        "registration locks must remain distinct for worktree removal"
    );
    let (selected_observer, mut selected_progress) = tokio::sync::mpsc::unbounded_channel();
    let (legacy_observer, mut legacy_progress) = tokio::sync::mpsc::unbounded_channel();
    let mut selected = Box::pin(MUTATION_PROGRESS.scope(
        selected_observer,
        call(
            &state,
            METHOD_GIT_STASH_PUSH_SELECTED,
            json!({"repositoryId":linked_id,"source":"unstaged","paths":["file.txt"]}),
        ),
    ));
    let mut legacy = Box::pin(MUTATION_PROGRESS.scope(
        legacy_observer,
        call(&state, METHOD_GIT_STASH_PUSH, json!({"repositoryId":id})),
    ));
    // Poll the actual dispatches into their first suspension rather than wait
    // for a sleep/poll loop to happen to observe their registration guards.
    assert!(futures_util::poll!(&mut selected).is_pending());
    assert!(futures_util::poll!(&mut legacy).is_pending());
    assert!(main_lock.try_lock().is_err());
    assert!(linked_lock.try_lock().is_err());
    let mut stage = Box::pin(call(
        &state,
        METHOD_GIT_STAGE,
        json!({"repositoryId":linked_id,"paths":["file.txt"]}),
    ));
    assert!(futures_util::poll!(&mut stage).is_pending());
    tokio::time::timeout(GIT_FIXTURE_DEADLINE, async {
        tokio::select! {
            biased;
            result = &mut selected => panic!("selected bypassed held common lock: {result}"),
            result = &mut legacy => panic!("legacy bypassed held common lock: {result}"),
            result = &mut stage => panic!("stage bypassed held worktree lock: {result}"),
            () = async {
                for (label, progress) in [
                    ("selected", &mut selected_progress),
                    ("legacy", &mut legacy_progress),
                ] {
                    assert_eq!(
                        progress.recv().await,
                        Some(MutationProgress::CommonLockPending),
                        "{label} must wait on the held common lock before worker entry"
                    );
                }
            } => {}
        }
    })
    .await
    .expect("both dispatches reach the held common lock after metadata discovery");
    let independent = repository();
    let entry = build_repository_catalog(&[independent.path().display().to_string()])
        .pop()
        .unwrap();
    let independent_id = entry.summary.id.clone();
    state.upsert_repository(entry).await.unwrap();
    let independent_common = common_directory(independent.path().to_str().unwrap()).unwrap();
    assert_ne!(common, independent_common);
    assert!(!Arc::ptr_eq(
        &state.stash_mutation_lock(&common).await,
        &state.stash_mutation_lock(&independent_common).await
    ));
    // Exercise the production worker and both locks, without making independent
    // progress depend on another complete selected stash (many Git processes).
    // Both real acquisitions have returned Pending. Keep polling the dispatches
    // and observing entry, rather than race slow Git completion against this
    // cheap callback. Acquired is emitted before any further await or worker
    // submission, so queued/slow blocking work cannot hide a bypass.
    tokio::time::timeout(GIT_FIXTURE_DEADLINE, async {
        tokio::select! {
            biased;
            event = selected_progress.recv() => panic!("selected advanced past held common lock: {event:?}"),
            event = legacy_progress.recv() => panic!("legacy advanced past held common lock: {event:?}"),
            result = &mut selected => panic!("selected bypassed held common lock: {result}"),
            result = &mut legacy => panic!("legacy bypassed held common lock: {result}"),
            result = &mut stage => panic!("stage bypassed held worktree lock: {result}"),
            result = mutate(&state, &independent_id, |_| Ok(())) => result.unwrap(),
        }
    })
    .await
    .expect("independent repository worker progresses while common lock is held");
    assert_eq!(
        selected_progress.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    );
    assert_eq!(
        legacy_progress.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    );
    assert!(main_lock.try_lock().is_err());
    assert!(linked_lock.try_lock().is_err());
    drop(common_guard);
    let (selected, legacy, stage) = tokio::time::timeout(GIT_FIXTURE_DEADLINE, async {
        tokio::join!(selected, legacy, stage)
    })
    .await
    .expect("linked selected/legacy stashes and queued stage finish after release");
    assert_eq!(success(selected)["outcome"], "success");
    assert_eq!(legacy["ok"], true, "{legacy}");
    assert!(
        legacy["result"]["snapshot"].is_object(),
        "legacy wire result stays intact"
    );
    assert_eq!(stage["ok"], true);
    for progress in [&mut selected_progress, &mut legacy_progress] {
        assert_eq!(
            progress.try_recv(),
            Ok(MutationProgress::CommonLockAcquired)
        );
        assert_eq!(progress.try_recv(), Ok(MutationProgress::WorkerEntered));
        assert_eq!(
            progress.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
        );
    }
    assert_eq!(git(root.path(), &["stash", "list"]).lines().count(), 2);
    assert!(git(&linked, &["diff", "--cached", "--name-only"]).is_empty());
}

#[tokio::test]
async fn invalidations_reach_known_linked_registrations_and_use_one_ordered_environment_stream() {
    let root = repository();
    let parent = tempfile::tempdir().unwrap();
    let linked = parent.path().join("linked");
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let linked_id = linked_registration(&state, root.path(), &linked).await;
    let independent = repository();
    let entry = build_repository_catalog(&[independent.path().display().to_string()])
        .pop()
        .unwrap();
    let independent_id = entry.summary.id.clone();
    state.upsert_repository(entry).await.unwrap();
    let other_environment = crate::rpc_tests::state(root.path());
    assert!(!Arc::ptr_eq(
        &state.stash_mutation_lock("same-key").await,
        &other_environment.stash_mutation_lock("same-key").await
    ));
    let mut events = state.repository_events.subscribe();
    let mut other_events = other_environment.repository_events.subscribe();
    let saved = success(
        call(
            &state,
            METHOD_GIT_STASH_PUSH_SELECTED,
            json!({"repositoryId":id,"source":"unstaged","paths":["file.txt"]}),
        )
        .await,
    );
    assert_eq!(saved["outcome"], "success");
    let mut ids = HashSet::new();
    let mut sequence = 0;
    while let Ok(event) = events.try_recv() {
        assert_eq!(event.sequence, sequence + 1);
        sequence = event.sequence;
        let change: RepositoryChanged = serde_json::from_value(event.payload).unwrap();
        assert_eq!(change.kind, RepositoryChangeKind::Snapshot);
        assert!(change.paths.is_none());
        ids.insert(change.repository_id);
    }
    assert_eq!(ids, HashSet::from([id.clone(), linked_id]));
    assert!(!ids.contains(&independent_id));
    assert!(other_events.try_recv().is_err());
    state.publish_repository_change(RepositoryChanged {
        repository_id: id,
        kind: RepositoryChangeKind::Status,
        paths: None,
    });
    assert_eq!(
        events.recv().await.unwrap().sequence,
        sequence + 1,
        "watcher and mutation share sequence ownership"
    );
}

#[tokio::test]
async fn completed_receipt_survives_repository_disappearance_and_unavailable_refresh() {
    let root = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let mut events = state.repository_events.subscribe();
    let saved = mutate(&state, &id, |root| {
        let saved = selected::stash_push_selected(
            root,
            selected::StashSelectionSource::Unstaged,
            &["file.txt".into()],
            None,
        )
        .map_err(|_| git_failure_error("fixture capture failed"))?;
        assert!(matches!(
            saved.outcome,
            selected::StashPushSelectedOutcome::Success
        ));
        fs::rename(
            Path::new(root).join(".git"),
            Path::new(root).join("saved-metadata"),
        )
        .unwrap();
        Ok(saved)
    })
    .await
    .unwrap();
    assert!(saved.stash.is_some());
    assert!(saved.error.is_none());
    let repository = state.repository(&id).await.unwrap();
    assert!(load_snapshot(&repository).is_err());
    let change: RepositoryChanged =
        serde_json::from_value(events.recv().await.unwrap().payload).unwrap();
    assert_eq!(change.repository_id, id);
    assert_eq!(change.kind, RepositoryChangeKind::Snapshot);
    fs::rename(root.path().join("saved-metadata"), root.path().join(".git")).unwrap();
    assert_eq!(git(root.path(), &["stash", "list"]).lines().count(), 1);
}

#[tokio::test]
async fn dropped_mutation_await_keeps_both_guards_until_started_blocking_worker_finishes() {
    let root = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let worktree_lock = state.git_mutation_lock(&id).await;
    let common = common_directory(root.path().to_str().unwrap()).unwrap();
    let common_lock = state.stash_mutation_lock(&common).await;
    let completed = Arc::new(AtomicBool::new(false));
    let (started, entered) = oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let task = tokio::spawn({
        let state = state.clone();
        let id = id.clone();
        let completed = completed.clone();
        async move {
            mutate(&state, &id, move |_| {
                started.send(()).unwrap();
                // Dropping the sender on any failing assertion also releases
                // this worker. No fixture panic can leave the runtime blocked.
                gate.recv_timeout(Duration::from_secs(30)).unwrap();
                completed.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
        }
    });
    tokio::time::timeout(GIT_FIXTURE_DEADLINE, entered)
        .await
        .expect("mutation worker started")
        .unwrap();
    assert!(worktree_lock.try_lock().is_err());
    assert!(common_lock.try_lock().is_err());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(worktree_lock.try_lock().is_err());
    assert!(common_lock.try_lock().is_err());
    assert!(!completed.load(Ordering::SeqCst));
    release.send(()).unwrap();
    // Guard lifetime, not Git throughput: the callback finishes immediately
    // after release. Real selected stash outcomes are covered by dispatch tests.
    let _worktree = tokio::time::timeout(Duration::from_secs(15), worktree_lock.lock())
        .await
        .unwrap();
    let _common = tokio::time::timeout(Duration::from_secs(15), common_lock.lock())
        .await
        .unwrap();
    assert!(completed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn cancel_and_disconnect_cannot_abandon_started_selected_or_legacy_stash_dispatches() {
    for method in [
        METHOD_GIT_STASH_PUSH_SELECTED,
        METHOD_GIT_STASH_PUSH,
        METHOD_GIT_STASH_POP,
    ] {
        let root = repository();
        if method == METHOD_GIT_STASH_POP {
            native_stash(root.path(), "saved\n");
        }
        let state = state(root.path());
        let id = state.repositories.read().await[0].summary.id.clone();
        let common = common_directory(root.path().to_str().unwrap()).unwrap();
        let common_guard = state.stash_mutation_lock(&common).await.lock_owned().await;
        let worktree_lock = state.git_mutation_lock(&id).await;
        let mut events = state.repository_events.subscribe();
        let (mut client, exited, server) = socket(
            state.clone(),
            vec![
                SCOPE_REPOSITORY_OPERATE.into(),
                SCOPE_REPOSITORY_READ.into(),
            ],
        )
        .await;
        let params = if method == METHOD_GIT_STASH_PUSH_SELECTED {
            json!({"repositoryId":id,"source":"unstaged","paths":["file.txt"]})
        } else {
            json!({"repositoryId":id})
        };
        send(&mut client, "stash", method, params).await;
        wait_locked(&worktree_lock).await;
        client
            .send(ClientMessage::Text(
                json!({"type":"cancel","id":"stash"}).to_string().into(),
            ))
            .await
            .unwrap();
        send(&mut client, "probe", METHOD_SERVER_GET_STATUS, json!({})).await;
        assert_eq!(
            response(&mut client, "probe").await["ok"],
            true,
            "mutation cancellation must not cancel the dispatch"
        );
        client.close(None).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), exited)
            .await
            .unwrap()
            .unwrap();
        assert!(
            worktree_lock.try_lock().is_err(),
            "started dispatch stays detached with its guard"
        );
        drop(common_guard);
        // Invalidation is sent after the actual worker (including legacy
        // snapshot refresh) finishes. Wait for that explicit completion signal;
        // do not time a real selected stash with a short lock-lifetime deadline.
        let event = tokio::time::timeout(GIT_FIXTURE_DEADLINE, events.recv())
            .await
            .expect("disconnected stash dispatch completed and invalidated")
            .unwrap();
        let change: RepositoryChanged = serde_json::from_value(event.payload).unwrap();
        assert_eq!(change.repository_id, id);
        assert_eq!(change.kind, RepositoryChangeKind::Snapshot);
        let _finished = worktree_lock
            .try_lock()
            .expect("completed worker released guard");
        assert!(state.stash_mutation_lock(&common).await.try_lock().is_ok());
        assert_eq!(
            git(root.path(), &["stash", "list"]).is_empty(),
            method == METHOD_GIT_STASH_POP
        );
        server.abort();
    }
}

#[tokio::test]
async fn unexpected_worker_panic_reports_unknown_completion_without_sensitive_diagnostics() {
    let root = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let error = mutate::<(), _>(&state, &id, |_| panic!("sensitive worker payload"))
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::INTERNAL);
    assert!(error.message.contains("completion is unknown"));
    assert!(!error.message.contains("sensitive"));
    assert!(error.details.is_none());
    assert!(state.git_mutation_lock(&id).await.try_lock().is_ok());
}

#[test]
fn stash_reads_use_cancellable_read_lane_while_mutations_keep_ordered_ownership() {
    let mut queue = rpc_queue::RequestQueue::default();
    for (id, method) in [
        ("mutation", METHOD_GIT_STASH_POP_TARGET),
        ("read", METHOD_GIT_STASH_FILES),
        ("diff", METHOD_GIT_STASH_FILE_DIFF),
        ("next", METHOD_GIT_STASH_DROP),
    ] {
        queue
            .push(RequestEnvelope {
                id: id.into(),
                method: method.into(),
                params: json!({"repositoryId":"repo"}),
            })
            .unwrap();
    }
    assert_eq!(queue.next().unwrap().id, "mutation");
    assert!(!queue.cancel("mutation"));
    assert_eq!(queue.next().unwrap().id, "read");
    assert!(queue.cancel("read"));
    assert!(queue.cancel("diff"));
    assert!(queue.next().is_none());
    assert!(!queue.finish("read"));
    assert!(queue.finish("mutation"));
    assert_eq!(queue.next().unwrap().id, "next");
}

#[tokio::test]
async fn stash_mutation_evicts_live_hunk_contexts_and_commit_caches_only_for_affected_roots() {
    use gitgui_core::git::working_tree::load_working_tree_file_view;
    let root = repository();
    let independent = repository();
    let state = state(root.path());
    let id = state.repositories.read().await[0].summary.id.clone();
    let root_string = state.repository(&id).await.unwrap().operation_path;
    let other_string = independent.path().to_str().unwrap().to_string();
    let (_, context) = load_working_tree_file_view(&root_string, None, "file.txt", false).unwrap();
    let context = context.unwrap();
    let context_id = context.id();
    let (_, other) = load_working_tree_file_view(&other_string, None, "file.txt", false).unwrap();
    let other = other.unwrap();
    let other_id = other.id();
    state
        .hunk_cache
        .lock()
        .unwrap()
        .insert(&root_string, context, None);
    state
        .hunk_cache
        .lock()
        .unwrap()
        .insert(&other_string, other, None);
    let head = git(root.path(), &["rev-parse", "HEAD"]);
    let key = CommitFilesKey {
        repo_root: root_string.clone(),
        commit_hash: head.clone(),
    };
    let other_key = CommitFilesKey {
        repo_root: other_string.clone(),
        commit_hash: head,
    };
    state
        .cache
        .lock()
        .unwrap()
        .insert_recent(key.clone(), vec![]);
    state
        .cache
        .lock()
        .unwrap()
        .insert_recent(other_key.clone(), vec![]);
    success(
        call(
            &state,
            METHOD_GIT_STASH_PUSH_SELECTED,
            json!({"repositoryId":id,"source":"unstaged","paths":["file.txt"]}),
        )
        .await,
    );
    assert!(state
        .hunk_cache
        .lock()
        .unwrap()
        .get_context(&root_string, "file.txt", false, &context_id)
        .is_none());
    assert!(state
        .hunk_cache
        .lock()
        .unwrap()
        .get_context(&other_string, "file.txt", false, &other_id)
        .is_some());
    assert!(state.cache.lock().unwrap().get(&key).is_none());
    assert!(state.cache.lock().unwrap().get(&other_key).is_some());
}
