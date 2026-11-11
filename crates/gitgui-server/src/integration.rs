use super::*;
use gitgui_core::git::integration::{
    self, IntegrationAction, IntegrationKind, IntegrationReview, RecoveryAction, RewritePushReview,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    repository_id: String,
    target_ref: Option<String>,
    review: Option<IntegrationReview>,
    action: Option<serde_json::Value>,
    kind: Option<IntegrationKind>,
    push_review: Option<RewritePushReview>,
}

pub(super) async fn dispatch(
    id: String,
    method: &str,
    params: Value,
    state: &ServerState,
) -> ResponseEnvelope {
    let params: Params = match parse_params(params, method) {
        Ok(value) => value,
        Err(error) => return ResponseEnvelope::error(id, error),
    };
    if let Err(error) = validate_repository_id(&params.repository_id) {
        return ResponseEnvelope::error(id, error);
    }
    let Some(repository) = state.repository(&params.repository_id).await else {
        return repository_not_configured(id, &params.repository_id);
    };
    let lock = state.git_mutation_lock(&params.repository_id).await;
    let guard = lock.lock_owned().await;
    let root = repository.operation_path;
    let method = method.to_owned();
    let result = spawn_blocking(move || -> Result<Value, GitError> {
        // A disconnected client must not release mutation serialization while
        // the already-started blocking Git command is still running.
        let _guard = guard;
        let missing = || GitError {
            message: "Invalid integration request".into(),
            stderr: String::new(),
            status: None,
        };
        let value = match method.as_str() {
            gitgui_protocol::METHOD_GIT_INTEGRATION_INSPECT => {
                serde_json::to_value(integration::inspect(&root)?)
            }
            gitgui_protocol::METHOD_GIT_INTEGRATION_REVIEW => serde_json::to_value(
                integration::review(&root, params.target_ref.as_deref().ok_or_else(missing)?)?,
            ),
            gitgui_protocol::METHOD_GIT_INTEGRATION_START => {
                let action: IntegrationAction =
                    serde_json::from_value(params.action.ok_or_else(missing)?)
                        .map_err(|_| missing())?;
                serde_json::to_value(integration::start(
                    &root,
                    &params.review.ok_or_else(missing)?,
                    action,
                )?)
            }
            gitgui_protocol::METHOD_GIT_INTEGRATION_RECOVER => {
                let action: RecoveryAction =
                    serde_json::from_value(params.action.ok_or_else(missing)?)
                        .map_err(|_| missing())?;
                serde_json::to_value(integration::recover(
                    &root,
                    params.kind.ok_or_else(missing)?,
                    action,
                )?)
            }
            gitgui_protocol::METHOD_GIT_REWRITE_PUSH_REVIEW => {
                serde_json::to_value(integration::review_rewrite_push(&root)?)
            }
            gitgui_protocol::METHOD_GIT_REWRITE_PUSH_EXECUTE => {
                integration::push_rewrite(&root, &params.push_review.ok_or_else(missing)?)?;
                Ok(Value::Null)
            }
            _ => return Err(missing()),
        };
        value.map_err(|_| missing())
    })
    .await;
    match result {
        Ok(Ok(value)) => response_success(id, value),
        Ok(Err(error)) => ResponseEnvelope::error(id, git_operation_error(error)),
        Err(_) => ResponseEnvelope::error(
            id,
            git_failure_error("Git operation worker failed; refresh to inspect the current state"),
        ),
    }
}
