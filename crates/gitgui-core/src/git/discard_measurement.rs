//! Local measurement, using temporary repositories only. Counters cover
//! application-launched Git processes and explicit fingerprint reads, not Git's IO.
use super::{
    command::{test_metrics, GitCommand},
    repository, working_tree,
};
use std::{fs, time::Instant};

#[test]
#[ignore = "local discard process/read and latency measurement"]
fn measure_discard_pipeline() {
    for count in [1, 20] {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        let r = root.to_str().unwrap();
        let git = |args: &[&str]| GitCommand::run(args, Some(root)).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Measurement"]);
        git(&["config", "user.email", "measurement@example.com"]);
        git(&["config", "core.autocrlf", "false"]);
        let paths: Vec<String> = (0..count).map(|i| format!("file-{i}.txt")).collect();
        for path in &paths {
            fs::write(root.join(path), "base\n").unwrap();
        }
        git(&["add", "."]);
        git(&["commit", "-qm", "base"]);
        for sample in 0..3 {
            for path in &paths {
                fs::write(root.join(path), "x".repeat(4096)).unwrap();
            }
            test_metrics::take();
            let started = Instant::now();
            let review = working_tree::preview_discard(r, &paths).unwrap();
            let preview_ms = started.elapsed().as_secs_f64() * 1000.0;
            let preview = test_metrics::take();
            let confirmed = Instant::now();
            let outcome = working_tree::discard(r, &review, false).unwrap();
            assert!(outcome.error.is_none());
            assert_eq!(outcome.completed_paths.len(), count);
            let receipt_ms = confirmed.elapsed().as_secs_f64() * 1000.0;
            let discard = test_metrics::take();
            // Match the server status handler: resolve once, then read status.
            let info = repository::resolve_repository(r).unwrap();
            repository::load_repository_status_from_root(&info.root).unwrap();
            let reconciled_ms = confirmed.elapsed().as_secs_f64() * 1000.0;
            let refresh = test_metrics::take();
            println!("files={count} sample={sample} preview={preview:?} {preview_ms:.2}ms discard={discard:?} receipt={receipt_ms:.2}ms refresh={refresh:?} reconciled={reconciled_ms:.2}ms");
        }
    }
}
