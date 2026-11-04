//! Private desktop ownership channel, deliberately separate from the Git protocol.
//!
//! T3's desktop backend manager owns process stop/readiness; GitGui additionally
//! needs a cooperative Git drain because terminating a blocking worker can leave
//! a repository operation unfinished. No launcher, remote updater or network
//! administration surface is introduced here. EOF resumes service: losing the
//! owner must never leave a still-running standalone host permanently quiesced.
use super::ServerState;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, BufRead, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, Notify};

pub const DESKTOP_CONTROL_ENV: &str = "GITGUI_SERVER_DESKTOP_CONTROL";
pub const CONTROL_LINE_PREFIX: &str = "GITGUI_SERVER_CONTROL=";
const MAX_LINE_BYTES: usize = 4096;
const MAX_ID_BYTES: usize = 128;

#[derive(Default)]
struct Activity {
    paused: bool,
    active: usize,
}

#[derive(Default)]
pub(super) struct WorkGate {
    activity: Mutex<Activity>,
    changed: Notify,
}

pub(super) struct Work {
    gate: Arc<WorkGate>,
}
impl Drop for Work {
    fn drop(&mut self) {
        self.gate
            .activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active -= 1;
        self.gate.changed.notify_waiters();
    }
}
impl WorkGate {
    /// Atomically close admission only when nobody else is using the server.
    /// SSH cleanup must retain another client's live socket rather than drain it.
    #[cfg(target_os = "linux")]
    pub fn pause_if_idle(&self) -> bool {
        let mut activity = self.activity.lock().unwrap_or_else(|e| e.into_inner());
        if activity.active != 0 || activity.paused {
            return false;
        }
        activity.paused = true;
        true
    }
    pub fn enter(self: &Arc<Self>) -> Option<Work> {
        let mut activity = self.activity.lock().unwrap_or_else(|e| e.into_inner());
        if activity.paused {
            return None;
        }
        activity.active += 1;
        Some(Work { gate: self.clone() })
    }
    pub fn pause(&self) {
        self.activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .paused = true;
    }
    pub fn resume(&self) {
        self.activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .paused = false;
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self
                .activity
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .active
                == 0
            {
                return;
            }
            changed.await;
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    id: String,
    command: String,
}

/// Opaque input produced only by the inherited-pipe parser.
pub struct Input {
    id: String,
    command: Option<String>,
}

#[derive(Serialize)]
struct Reply<'a> {
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

/// Reads one bounded line, discarding overflow through the next newline so a
/// malformed frame cannot split into another command. None means clean EOF.
/// The buffer is shared with bootstrap parsing to preserve read-ahead bytes.
pub fn read_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    let mut overflow = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if overflow {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "input line too long",
                ))
            } else if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let end = available.iter().position(|b| *b == b'\n').map(|n| n + 1);
        let count = end.unwrap_or(available.len());
        if !overflow {
            if line.len() + count <= limit {
                line.extend_from_slice(&available[..count]);
            } else {
                overflow = true;
                line.clear();
            }
        }
        reader.consume(count);
        if end.is_some() {
            return if overflow {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "input line too long",
                ))
            } else {
                Ok(Some(line))
            };
        }
    }
}

fn parse(line: &[u8]) -> Input {
    match serde_json::from_slice::<Command>(line) {
        Ok(command)
            if !command.id.is_empty()
                && command.id.len() <= MAX_ID_BYTES
                && !command.id.chars().any(char::is_control) =>
        {
            Input {
                id: command.id,
                command: Some(command.command),
            }
        }
        _ => Input {
            id: String::new(),
            command: None,
        },
    }
}

/// Run on a dedicated OS thread (stdin is blocking on Windows too). The bounded
/// channel applies backpressure without spawning a task per untrusted line.
pub fn read_input(mut reader: impl BufRead, sender: mpsc::Sender<Input>) {
    loop {
        let input = match read_line(&mut reader, MAX_LINE_BYTES) {
            Ok(Some(line)) => parse(&line),
            Ok(None) => return,
            Err(error) if error.kind() == io::ErrorKind::InvalidData => Input {
                id: String::new(),
                command: None,
            },
            Err(_) => return,
        };
        if sender.blocking_send(input).is_err() {
            return;
        }
    }
}

fn reply(writer: &mut impl Write, id: &str, ok: bool, message: Option<&str>) -> io::Result<()> {
    // All output text is static except the validated, bounded correlation ID.
    let json = serde_json::to_string(&Reply { id, ok, message })?;
    writeln!(writer, "{CONTROL_LINE_PREFIX}{json}")?;
    writer.flush()
}

pub(super) async fn run(
    state: &ServerState,
    mut input: mpsc::Receiver<Input>,
    mut writer: impl Write,
    budget: Duration,
) {
    let mut prepared = false;
    while let Some(input) = input.recv().await {
        let (ok, message, shutdown) = match input.command.as_deref() {
            Some("prepare-update") => {
                state.work.pause();
                if tokio::time::timeout(budget, state.work.drained())
                    .await
                    .is_ok()
                {
                    prepared = true;
                    (true, None, false)
                } else {
                    prepared = false;
                    state.work.resume();
                    (
                        false,
                        Some("Repository work is still busy; admissions resumed"),
                        false,
                    )
                }
            }
            Some("resume") => {
                prepared = false;
                state.work.resume();
                (true, None, false)
            }
            Some("shutdown") if prepared => (true, None, true),
            Some("shutdown") => (
                false,
                Some("Prepare update successfully before shutdown"),
                false,
            ),
            Some(_) => (false, Some("Unknown desktop control command"), false),
            None => (
                false,
                Some("Malformed or oversized desktop control input"),
                false,
            ),
        };
        let written = reply(&mut writer, &input.id, ok, message).is_ok();
        if shutdown {
            return;
        }
        if !written {
            break;
        }
    }
    // The pipe's owner died, or cannot receive responses. Resume instead of
    // leaving all other clients blocked. No process or Git worker is killed.
    state.work.resume();
    std::future::pending::<()>().await;
}
#[cfg(test)]
mod tests {
    use super::run;
    use super::*;
    use crate::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::Message};

    struct Output {
        buffer: Vec<u8>,
        tx: mpsc::UnboundedSender<Value>,
    }
    impl Write for Output {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.buffer.extend_from_slice(bytes);
            while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = self.buffer.drain(..=end).collect();
                let line = std::str::from_utf8(&line).unwrap();
                let value =
                    serde_json::from_str(line.strip_prefix(CONTROL_LINE_PREFIX).unwrap()).unwrap();
                let _ = self.tx.send(value);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn controller(
        state: Arc<ServerState>,
        budget: Duration,
    ) -> (
        mpsc::Sender<Input>,
        mpsc::UnboundedReceiver<Value>,
        JoinHandle<()>,
    ) {
        let (tx, rx) = mpsc::channel(16);
        let (output_tx, output_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            run(
                &state,
                rx,
                Output {
                    buffer: Vec::new(),
                    tx: output_tx,
                },
                budget,
            )
            .await;
        });
        (tx, output_rx, task)
    }
    async fn command(tx: &mpsc::Sender<Input>, id: &str, command: &str) {
        tx.send(parse(
            &serde_json::to_vec(&json!({"id": id, "command": command})).unwrap(),
        ))
        .await
        .unwrap();
    }
    async fn response(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn wait_until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    fn state() -> Arc<ServerState> {
        Arc::new(ServerState::new(
            &ServerConfig::default(),
            "127.0.0.1:1".parse().unwrap(),
            Vec::new(),
        ))
    }
    fn paused(state: &ServerState) -> bool {
        state.work.activity.lock().unwrap().paused
    }

    #[tokio::test]
    async fn prepare_waits_for_blocking_worker_timeout_resumes_and_shutdown_requires_prepare() {
        let state = state();
        let guard = state.work.enter().unwrap();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = spawn_blocking(move || {
            let _guard = guard;
            wait.recv().unwrap();
        });
        let (tx, mut output, task) = controller(state.clone(), Duration::from_millis(100));
        command(&tx, "no", "shutdown").await;
        assert_eq!(response(&mut output).await["ok"], false);
        command(&tx, "busy", "prepare-update").await;
        wait_until(|| paused(&state)).await;
        assert!(state.work.enter().is_none());
        assert!(output.try_recv().is_err());
        assert_eq!(response(&mut output).await["ok"], false);
        assert!(state.work.enter().is_some());
        release.send(()).unwrap();
        worker.await.unwrap();
        command(&tx, "ready", "prepare-update").await;
        assert_eq!(
            response(&mut output).await,
            json!({"id":"ready", "ok":true})
        );
        command(&tx, "resume", "resume").await;
        assert_eq!(response(&mut output).await["ok"], true);
        assert!(state.work.enter().is_some());
        command(&tx, "no-again", "shutdown").await;
        assert_eq!(response(&mut output).await["ok"], false);
        command(&tx, "ready-again", "prepare-update").await;
        assert_eq!(response(&mut output).await["ok"], true);
        command(&tx, "stop", "shutdown").await;
        assert_eq!(response(&mut output).await["ok"], true);
        task.await.unwrap();
        assert!(
            state.work.enter().is_none(),
            "barrier stays held through shutdown"
        );
    }

    #[tokio::test]
    async fn eof_after_prepare_restores_admission() {
        let state = state();
        let (tx, mut output, task) = controller(state.clone(), Duration::from_secs(1));
        command(&tx, "ready", "prepare-update").await;
        assert_eq!(response(&mut output).await["ok"], true);
        drop(tx);
        wait_until(|| !paused(&state)).await;
        assert!(state.work.enter().is_some());
        task.abort();
    }

    #[tokio::test]
    async fn malformed_unknown_and_oversized_input_is_bounded_and_recovers() {
        let mut bytes = vec![b'x'; MAX_LINE_BYTES * 4];
        bytes.extend_from_slice(b"\n{bad}\n{\"id\":\"unknown\",\"command\":\"other\"}\n{\"id\":\"ok\",\"command\":\"resume\"}\n");
        let (tx, rx) = mpsc::channel(16);
        std::thread::spawn(move || read_input(io::Cursor::new(bytes), tx))
            .join()
            .unwrap();
        let (output_tx, mut output) = mpsc::unbounded_channel();
        let state = state();
        let task = tokio::spawn(async move {
            run(
                &state,
                rx,
                Output {
                    buffer: Vec::new(),
                    tx: output_tx,
                },
                Duration::from_secs(1),
            )
            .await;
        });
        for id in ["", "", "unknown"] {
            let response = response(&mut output).await;
            assert_eq!(response["id"], id);
            assert_eq!(response["ok"], false);
            assert!(response.to_string().len() < 256);
        }
        assert_eq!(response(&mut output).await, json!({"id":"ok","ok":true}));
        let input = parse(
            &serde_json::to_vec(&json!({"id":"x".repeat(MAX_ID_BYTES + 1),"command":"resume"}))
                .unwrap(),
        );
        assert!(input.id.is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn disconnected_mutation_drains_and_admission_is_hostwide() {
        let root = tempfile::tempdir().unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root.path())
            .status()
            .unwrap()
            .success());
        std::fs::write(root.path().join("file.txt"), "content").unwrap();
        let server = start(ServerConfig {
            repository_paths: vec![root.path().display().to_string()],
            ..ServerConfig::default()
        })
        .await
        .unwrap();
        let state = server.state.clone();
        let id = state.repositories.read().await[0].summary.id.clone();
        let mutation = state.git_mutation_lock(&id).await;
        let lock = mutation.clone().lock_owned().await;
        let url = format!("ws://{}/ws", server.local_addr());
        let (mut first, _) = connect_async(&url).await.unwrap();
        first.next().await.unwrap().unwrap();
        let (mut second, _) = connect_async(&url).await.unwrap();
        second.next().await.unwrap().unwrap();
        first.send(Message::Text(json!({"id":"slow", "method":METHOD_GIT_STAGE, "params":{"repositoryId":id,"paths":["file.txt"]}}).to_string().into())).await.unwrap();
        // The dispatcher has cloned the repository lock and is waiting on it.
        // Watcher work can also hold host permits, so count alone is insufficient.
        wait_until(|| Arc::strong_count(&mutation) >= 4).await;
        first.close(None).await.unwrap();
        drop(first);
        let (tx, mut output, task) = controller(state.clone(), Duration::from_secs(20));
        command(&tx, "prepare", "prepare-update").await;
        wait_until(|| paused(&state)).await;
        assert!(
            output.try_recv().is_err(),
            "detached mutation must still hold the drain"
        );
        for (id, method) in [
            ("mutation", METHOD_GIT_STAGE),
            ("catalog", METHOD_REPOSITORIES_REMOVE),
        ] {
            second
                .send(Message::Text(
                    json!({"id":id,"method":method,"params":{}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            loop {
                let frame = tokio::time::timeout(Duration::from_secs(5), second.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                if value["id"] == id {
                    assert_eq!(value["error"]["code"], error_codes::SERVER_BUSY);
                    break;
                }
            }
        }
        drop(lock);
        assert_eq!(response(&mut output).await["ok"], true);
        assert!(
            std::process::Command::new("git")
                .args(["diff", "--cached", "--exit-code", "--quiet"])
                .current_dir(root.path())
                .status()
                .unwrap()
                .code()
                == Some(1)
        );
        command(&tx, "resume", "resume").await;
        assert_eq!(response(&mut output).await["ok"], true);
        task.abort();
        server.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn stopping_revokes_readiness_closes_websockets_and_awaits_work() {
        let server = start(ServerConfig::default()).await.unwrap();
        let state = server.state.clone();
        let (mut socket, _) = connect_async(format!("ws://{}/ws", server.local_addr()))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        let guard = state.work.enter().unwrap();
        let shutdown = tokio::spawn(server.shutdown());
        wait_until(|| *state.stopping.borrow()).await;
        assert!(!state.readiness().await.ready);
        assert!(state.work.enter().is_none());
        assert!(state.sockets.enter().is_none());
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(message.is_close());
        assert!(
            !shutdown.is_finished(),
            "must wait for detached repository work"
        );
        drop(guard);
        shutdown.await.unwrap().unwrap();
        assert_eq!(state.lifecycle().await, ServerLifecycle::Stopped);
    }
}
