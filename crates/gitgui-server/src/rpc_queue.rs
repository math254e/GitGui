//! Session admission and ordering. Started dispatches are never aborted: their
//! blocking Git workers must finish before repository guards can be released.
use std::collections::{HashMap, VecDeque};

use gitgui_protocol::{RequestEnvelope, SCOPE_REPOSITORY_MANAGE, SCOPE_REPOSITORY_OPERATE};

const MAX_PENDING: usize = 128;
const MAX_READS: usize = 8;
const MAX_OPERATIONS: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Lane {
    Read,
    Prefetch,
    Control,
    Ordered(String),
}

fn lane(request: &RequestEnvelope) -> Lane {
    match request.method.as_str() {
        "server.get_info" | "server.get_status" => Lane::Control,
        "git.prefetch_commit_files" | "git.prefetch_commit_diffs" => Lane::Prefetch,
        method => match super::required_scope_for_method(method) {
            Some(SCOPE_REPOSITORY_OPERATE | SCOPE_REPOSITORY_MANAGE) => Lane::Ordered(
                request
                    .params
                    .get("repositoryId")
                    .and_then(|id| id.as_str())
                    .unwrap_or("catalog")
                    .to_owned(),
            ),
            // These previews deliberately share the mutation lock in dispatch.
            _ if matches!(
                method,
                "git.hunk_preview" | "git.discard_preview" | "git.amend_info"
            ) =>
            {
                Lane::Ordered(
                    request
                        .params
                        .get("repositoryId")
                        .and_then(|id| id.as_str())
                        .unwrap_or("catalog")
                        .to_owned(),
                )
            }
            _ => Lane::Read,
        },
    }
}

struct Running {
    lane: Lane,
    cancelled: bool,
    cancellable: bool,
}

#[derive(Default)]
pub(super) struct RequestQueue {
    pending: VecDeque<RequestEnvelope>,
    running: HashMap<String, Running>,
}

impl RequestQueue {
    pub fn push(&mut self, request: RequestEnvelope) -> Result<(), &'static str> {
        if self.running.contains_key(&request.id) || self.pending.iter().any(|r| r.id == request.id)
        {
            return Err(gitgui_protocol::error_codes::DUPLICATE_REQUEST_ID);
        }
        // Hints must not fill admission capacity needed by interactive work.
        // Keep at most one running and one waiting prefetch per session.
        if lane(&request) == Lane::Prefetch
            && self
                .pending
                .iter()
                .filter(|r| lane(r) == Lane::Prefetch)
                .count()
                + self
                    .running
                    .values()
                    .filter(|r| r.lane == Lane::Prefetch)
                    .count()
                >= 2
        {
            return Err(gitgui_protocol::error_codes::SERVER_BUSY);
        }
        if self.pending.len() + self.running.len() >= MAX_PENDING {
            return Err(gitgui_protocol::error_codes::SERVER_BUSY);
        }
        self.pending.push_back(request);
        Ok(())
    }

    pub fn next(&mut self) -> Option<RequestEnvelope> {
        let index = self.pending.iter().position(|request| {
            let lane = lane(request);
            let count = self.running.values().filter(|r| r.lane == lane).count();
            match lane {
                Lane::Read => count < MAX_READS,
                Lane::Prefetch | Lane::Control => count == 0,
                Lane::Ordered(_) => {
                    count == 0
                        && self
                            .running
                            .values()
                            .filter(|r| matches!(r.lane, Lane::Ordered(_)))
                            .count()
                            < MAX_OPERATIONS
                }
            }
        })?;
        let request = self.pending.remove(index)?;
        self.running.insert(
            request.id.clone(),
            Running {
                lane: lane(&request),
                cancelled: false,
                cancellable: super::required_scope_for_method(&request.method)
                    == Some(gitgui_protocol::SCOPE_REPOSITORY_READ),
            },
        );
        Some(request)
    }

    /// Only reads can be cancelled. Cancellation is scoped to this socket and
    /// never promises to undo a mutation or terminate a started Git process.
    pub fn cancel(&mut self, id: &str) -> bool {
        if let Some(index) = self.pending.iter().position(|r| {
            r.id == id
                && super::required_scope_for_method(&r.method)
                    == Some(gitgui_protocol::SCOPE_REPOSITORY_READ)
        }) {
            self.pending.remove(index);
            return true;
        }
        if let Some(running) = self.running.get_mut(id) {
            if running.cancellable && !running.cancelled {
                running.cancelled = true;
                return true;
            }
        }
        false
    }

    /// A cancelled running read still occupies its slot until its worker ends.
    pub fn finish(&mut self, id: &str) -> bool {
        self.running.remove(id).is_some_and(|r| !r.cancelled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(id: &str, method: &str, repository: &str) -> RequestEnvelope {
        RequestEnvelope {
            id: id.into(),
            method: method.into(),
            params: json!({"repositoryId": repository}),
        }
    }

    #[test]
    fn independent_reads_and_repositories_bypass_ordered_work() {
        let mut q = RequestQueue::default();
        for (id, method, repo) in [
            ("first", "git.stage", "a"),
            ("second", "git.unstage", "a"),
            ("preview", "git.hunk_preview", "a"),
            ("other", "git.stage", "b"),
            ("read", "git.commit_file_diff", "a"),
        ] {
            q.push(request(id, method, repo)).unwrap();
        }
        assert_eq!(q.next().unwrap().id, "first");
        assert_eq!(q.next().unwrap().id, "other");
        assert_eq!(q.next().unwrap().id, "read");
        assert!(q.next().is_none());
        q.finish("first");
        assert_eq!(q.next().unwrap().id, "second");
        q.finish("second");
        assert_eq!(q.next().unwrap().id, "preview");
    }

    #[test]
    fn cancelled_reads_release_queued_work_but_running_workers_keep_their_slots() {
        let mut q = RequestQueue::default();
        for n in 0..MAX_READS + 20 {
            q.push(request(&n.to_string(), "git.commit_file_diff", "a"))
                .unwrap();
        }
        for n in 0..MAX_READS {
            assert_eq!(q.next().unwrap().id, n.to_string());
        }
        assert!(q.next().is_none());
        for n in 0..MAX_READS + 20 {
            assert!(q.cancel(&n.to_string()));
        }
        q.push(request("selected", "git.commit_file_diff", "a"))
            .unwrap();
        assert!(q.next().is_none());
        assert!(!q.finish("0")); // Cancelled worker response is suppressed.
        assert_eq!(q.next().unwrap().id, "selected");
        assert!(q.finish("selected"));
        assert!(!q.cancel("missing"));
    }

    #[test]
    fn prefetch_and_saturation_leave_control_and_interactive_capacity() {
        let mut q = RequestQueue::default();
        q.push(request("prefetch", "git.prefetch_commit_diffs", "a"))
            .unwrap();
        q.push(request("more", "git.prefetch_commit_files", "a"))
            .unwrap();
        assert_eq!(
            q.push(request("excess-prefetch", "git.prefetch_commit_files", "b")),
            Err("server_busy")
        );
        q.push(request("selected", "git.commit_file_diff", "a"))
            .unwrap();
        q.push(request("health", "server.get_status", "a")).unwrap();
        assert_eq!(q.next().unwrap().id, "prefetch");
        assert_eq!(q.next().unwrap().id, "selected");
        assert_eq!(q.next().unwrap().id, "health");
        assert!(q.next().is_none());
        assert_eq!(
            q.push(request("selected", "git.stage", "a")),
            Err("duplicate_request_id")
        );
        for n in 4..MAX_PENDING {
            q.push(request(&n.to_string(), "git.status", "a")).unwrap();
        }
        assert_eq!(
            q.push(request("excess", "git.status", "a")),
            Err("server_busy")
        );
        assert!(q.cancel("more"));
        q.push(request("mutation", "git.stage", "a")).unwrap();
        assert!(!q.cancel("mutation"));
    }
}
