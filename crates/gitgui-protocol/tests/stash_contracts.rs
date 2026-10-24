use gitgui_protocol::*;
use serde_json::json;

#[test]
fn legacy_stash_inputs_keep_their_original_defaults() {
    let push: GitStashPushParams = serde_json::from_value(json!({"repositoryId": "repo"})).unwrap();
    assert!(push.include_untracked);
    assert!(push.message.is_none());
    let pop: GitStashPopParams = serde_json::from_value(json!({"repositoryId": "repo"})).unwrap();
    assert_eq!(pop.repository_id, "repo");
}

#[test]
fn selected_push_requires_explicit_source_and_paths() {
    for value in [
        json!({"repositoryId": "repo", "source": "staged"}),
        json!({"repositoryId": "repo", "paths": ["file"]}),
        json!({"repositoryId": "repo", "source": "all", "paths": ["file"]}),
        json!({"repositoryId": "repo", "source": "staged", "paths": ["file"], "includeUntracked": true}),
    ] {
        assert!(serde_json::from_value::<GitStashPushSelectedParams>(value).is_err());
    }
}

#[test]
fn targeted_operations_cannot_omit_the_reviewed_object_id() {
    assert!(serde_json::from_value::<GitStashTargetParams>(json!({
        "repositoryId": "repo", "target": {"selector": "stash@{0}"}
    }))
    .is_err());
    // No force/discard switches are part of this contract.
    assert!(serde_json::from_value::<GitStashTargetParams>(json!({
        "repositoryId": "repo", "target": {"selector": "stash@{0}", "expectedOid": "a".repeat(40)}, "force": true
    })).is_err());
}

#[test]
fn receipts_preserve_completed_steps_without_a_refresh_snapshot() {
    let result: GitStashMutationResult = serde_json::from_value(json!({
        "repositoryId": "repo",
        "target": {"selector": "stash@{0}", "expectedOid": "a".repeat(40)},
        "outcome": "branchCreatedRestoreFailed", "stashState": "retained",
        "restore": "conflicts", "branch": {"name": "rescue", "switched": true},
        "error": {"code": "git_operation_failed", "message": "Conflicts while restoring"}
    }))
    .unwrap();
    let encoded = serde_json::to_value(result).unwrap();
    assert_eq!(encoded["stashState"], "retained");
    assert_eq!(encoded["branch"]["switched"], true);
    assert!(encoded.get("snapshot").is_none());

    let restored_but_not_dropped: GitStashMutationResult = serde_json::from_value(json!({
        "repositoryId": "repo",
        "target": {"selector": "stash@{0}", "expectedOid": "a".repeat(40)},
        "outcome": "partial", "stashState": "retained", "restore": "succeeded",
        "branch": null, "error": {"code": "git_operation_failed", "message": "Could not remove stash"}
    })).unwrap();
    assert!(matches!(
        restored_but_not_dropped.restore,
        GitStashRestoreOutcome::Succeeded
    ));
}

#[test]
fn stash_methods_are_unique_members_of_the_accepted_registry() {
    let unique: std::collections::HashSet<_> = WS_METHOD_NAMES.iter().collect();
    assert_eq!(unique.len(), WS_METHOD_NAMES.len());
    assert_eq!(STASH_FEATURE_METHOD_NAMES.len(), 7);
    for method in STASH_FEATURE_METHOD_NAMES {
        assert!(WS_METHOD_NAMES.contains(method));
    }
}
