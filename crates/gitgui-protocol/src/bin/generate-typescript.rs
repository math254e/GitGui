//! Deterministically generate the browser-facing GitGui protocol contract.
//!
//! The Rust structs in the library are the source of truth. This binary is
//! intentionally small and writes one committed file so the SvelteKit client
//! does not need to duplicate wire definitions by hand.

use gitgui_protocol::{
    ChangedFile, CommitFile, CommitFileDiff, CommitFileDiffParams, CommitFilesParams,
    CommitFilesResult, CommitGraph, CommitInfo, CommitRef, CommitRefType, FileDiffResult,
    GitBranch, GitBranchCreateParams, GitBranchCreateResult, GitBranchListParams,
    GitBranchListResult, GitBranchSwitchParams, GitBranchSwitchResult, GitCommitParams,
    GitCommitResult, GitFetchResult, GitPathsParams, GitPullResult, GitPushResult,
    GitRepositoryParams, GitStageResult, GitStashPopParams, GitStashPopResult, GitStashPushParams,
    GitStashPushResult, GitStatusParams, GitStatusResult, GitUnstageResult, GraphCommit, GraphEdge,
    GraphEdgeType, OrderedEventEnvelope, PrefetchCommitDiffTarget, PrefetchCommitDiffsParams,
    PrefetchCommitDiffsResult, PrefetchCommitFilesParams, PrefetchCommitFilesResult, ProtocolError,
    ProtocolErrorMessage, RepositoriesListResult, RepositoriesOpenParams, RepositoriesOpenResult,
    RepositoriesRefreshParams, RepositoriesRefreshResult, RepositoryInfo, RepositoryRefreshItem,
    RepositoryGraphParams, RepositoryGraphResult, RepositorySnapshot, RepositorySnapshotParams,
    RepositorySnapshotResult, RepositoryStatus,
    RepositorySummary, RequestEnvelope, ResponseEnvelope, ResponseErrorEnvelope,
    ResponseSuccessEnvelope, ServerInfo, ServerLifecycle, ServerReadiness, ServerStatus, StashInfo,
    WelcomeMessage, WelcomePayload, WorkingTreeFileDiffParams,
};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use ts_rs::{Config, TS};

const HEADER: &str = r#"// This file is generated. Do not edit it by hand.
// Source: crates/gitgui-protocol/src/lib.rs
// Generate with: npm run protocol:generate

/** Any JSON value accepted by the GitGui wire protocol. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

"#;

fn main() -> io::Result<()> {
    let output_path = repository_root().join("src/lib/generated/protocol.ts");
    // These values are serialized as JSON numbers by serde_json and are
    // intentionally represented as browser numbers in this first protocol.
    let config = Config::default().with_large_int("number");
    let declarations = [
        <RequestEnvelope as TS>::decl(&config),
        <ProtocolError as TS>::decl(&config),
        <ResponseSuccessEnvelope as TS>::decl(&config),
        <ResponseErrorEnvelope as TS>::decl(&config),
        <ResponseEnvelope as TS>::decl(&config),
        <WelcomePayload as TS>::decl(&config),
        <WelcomeMessage as TS>::decl(&config),
        <OrderedEventEnvelope as TS>::decl(&config),
        <ServerLifecycle as TS>::decl(&config),
        <ServerInfo as TS>::decl(&config),
        <ServerReadiness as TS>::decl(&config),
        <ServerStatus as TS>::decl(&config),
        <RepositorySummary as TS>::decl(&config),
        <RepositoriesListResult as TS>::decl(&config),
        <RepositoriesOpenParams as TS>::decl(&config),
        <RepositoriesOpenResult as TS>::decl(&config),
        <RepositorySnapshotParams as TS>::decl(&config),
        <RepositorySnapshotResult as TS>::decl(&config),
        <RepositoryGraphParams as TS>::decl(&config),
        <RepositoryGraphResult as TS>::decl(&config),
        <RepositoriesRefreshParams as TS>::decl(&config),
        <RepositoryRefreshItem as TS>::decl(&config),
        <RepositoriesRefreshResult as TS>::decl(&config),
        <GitStatusParams as TS>::decl(&config),
        <ChangedFile as TS>::decl(&config),
        <RepositoryStatus as TS>::decl(&config),
        <GitStatusResult as TS>::decl(&config),
        <GitPathsParams as TS>::decl(&config),
        <GitStageResult as TS>::decl(&config),
        <GitUnstageResult as TS>::decl(&config),
        <GitCommitParams as TS>::decl(&config),
        <GitCommitResult as TS>::decl(&config),
        <GitRepositoryParams as TS>::decl(&config),
        <GitFetchResult as TS>::decl(&config),
        <GitPullResult as TS>::decl(&config),
        <GitPushResult as TS>::decl(&config),
        <GitBranchListParams as TS>::decl(&config),
        <GitBranch as TS>::decl(&config),
        <GitBranchListResult as TS>::decl(&config),
        <GitBranchCreateParams as TS>::decl(&config),
        <GitBranchCreateResult as TS>::decl(&config),
        <GitBranchSwitchParams as TS>::decl(&config),
        <GitBranchSwitchResult as TS>::decl(&config),
        <GitStashPushParams as TS>::decl(&config),
        <GitStashPushResult as TS>::decl(&config),
        <GitStashPopParams as TS>::decl(&config),
        <GitStashPopResult as TS>::decl(&config),
        <CommitFilesParams as TS>::decl(&config),
        <CommitFilesResult as TS>::decl(&config),
        <CommitFileDiffParams as TS>::decl(&config),
        <WorkingTreeFileDiffParams as TS>::decl(&config),
        <FileDiffResult as TS>::decl(&config),
        <PrefetchCommitFilesParams as TS>::decl(&config),
        <PrefetchCommitFilesResult as TS>::decl(&config),
        <PrefetchCommitDiffTarget as TS>::decl(&config),
        <PrefetchCommitDiffsParams as TS>::decl(&config),
        <PrefetchCommitDiffsResult as TS>::decl(&config),
        <RepositoryInfo as TS>::decl(&config),
        <RepositorySnapshot as TS>::decl(&config),
        <CommitInfo as TS>::decl(&config),
        <StashInfo as TS>::decl(&config),
        <CommitGraph as TS>::decl(&config),
        <GraphCommit as TS>::decl(&config),
        <GraphEdge as TS>::decl(&config),
        <GraphEdgeType as TS>::decl(&config),
        <CommitRef as TS>::decl(&config),
        <CommitRefType as TS>::decl(&config),
        <CommitFile as TS>::decl(&config),
        <CommitFileDiff as TS>::decl(&config),
        <ProtocolErrorMessage as TS>::decl(&config),
    ];

    let mut output = String::from(HEADER);
    for declaration in declarations {
        for line in export_declaration(&declaration).lines() {
            output.push_str(line.trim_end());
            output.push('\n');
        }
        output.push('\n');
    }

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_if_changed(&output_path, output.as_bytes())?;
    println!("generated {}", output_path.display());
    Ok(())
}

fn export_declaration(declaration: &str) -> String {
    declaration
        .strip_prefix("type ")
        .map(|rest| format!("export type {rest}"))
        .unwrap_or_else(|| declaration.to_string())
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the protocol crate must be inside the GitGui repository")
}

fn write_if_changed(path: &Path, contents: &[u8]) -> io::Result<()> {
    let unchanged = fs::read(path)
        .map(|existing| existing == contents)
        .unwrap_or(false);
    if !unchanged {
        fs::write(path, contents)?;
    }
    Ok(())
}
