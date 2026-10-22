//! Run explicitly with --ignored --nocapture. Counts application work only;
//! Git's own reads and subprocesses started by Git are outside these counters.
use super::{
    command::{test_metrics, GitCommand},
    working_tree::*,
};
use std::{fs, time::Instant};

#[test]
#[ignore = "local file-view process/read measurement"]
fn measure_file_view_work() {
    for kind in ["tracked", "untracked", "large", "binary", "conflict"] {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        let r = root.to_str().unwrap();
        let git = |args: &[&str]| GitCommand::run(args, Some(root)).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Measurement"]);
        git(&["config", "user.email", "measurement@example.com"]);
        git(&["config", "core.autocrlf", "false"]);
        let base = if kind == "large" {
            "original line\n".repeat(400_000)
        } else {
            "original\n".into()
        };
        fs::write(root.join("file.txt"), &base).unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "base"]);
        if kind == "untracked" {
            git(&["rm", "--cached", "file.txt"]);
            git(&["commit", "-qm", "remove"]);
        }
        if kind == "conflict" {
            git(&["checkout", "-qb", "other"]);
            fs::write(root.join("file.txt"), "other\n").unwrap();
            git(&["commit", "-qam", "other"]);
            git(&["checkout", "-q", "main"]);
            fs::write(root.join("file.txt"), "main\n").unwrap();
            git(&["commit", "-qam", "main"]);
            assert!(GitCommand::run(&["merge", "other"], Some(root)).is_err());
        } else if kind == "binary" {
            fs::write(root.join("file.txt"), b"binary\0content").unwrap();
        } else {
            fs::write(root.join("file.txt"), format!("changed\n{base}")).unwrap();
        }
        test_metrics::take();
        let start = Instant::now();
        let (_, context) = load_working_tree_file_view(r, None, "file.txt", false).unwrap();
        let context = context.unwrap();
        let review = context.complete().unwrap();
        let preview = &review.preview;
        println!(
            "{kind} select: {:?}, {:?}",
            test_metrics::take(),
            start.elapsed()
        );
        if preview.unavailable_reason.is_none() {
            let start = Instant::now();
            apply_cached_hunks(&context, &preview.revision, &[0]).unwrap();
            println!(
                "{kind} apply: {:?}, {:?}",
                test_metrics::take(),
                start.elapsed()
            );
        }
    }
}
