//! Host-local SSH ownership. See docs/ssh-host-runner.md for the private contract.
//! No PID is ever authority to stop a process. Persistent tombstones precede
//! spawn/claim, and every managed server enforces its own provisional deadline.
use gitgui_protocol::{
    SSH_HOST_MAX_FRAME_BYTES, SSH_HOST_VERSION, SshHostOutcome, SshHostRequest, SshHostResponse,
};
use std::io::{self, Write};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub(crate) use linux::HostGuard;

fn response(request: &SshHostRequest, outcome: SshHostOutcome) -> SshHostResponse {
    SshHostResponse {
        version: SSH_HOST_VERSION,
        acquisition_id: request.acquisition_id.clone(),
        outcome,
        instance_id: None,
        environment_id: None,
        port: None,
        ownership: None,
        expires_at_unix_ms: None,
        message: None,
        remote_data_directory: None,
        pairing: None,
    }
}

/// One bounded JSON request/reply. Diagnostics never echo request fields or logs.
pub async fn command(operation: &str) -> io::Result<()> {
    let input = crate::local_control::read_line(&mut io::stdin().lock(), SSH_HOST_MAX_FRAME_BYTES);
    let fallback = SshHostRequest {
        version: SSH_HOST_VERSION,
        acquisition_id: String::new(),
        locator: gitgui_protocol::SshEnvironmentLocator::Default,
        expected_environment_id: None,
        instance_id: None,
    };
    let result = match input
        .ok()
        .flatten()
        .and_then(|line| serde_json::from_slice::<SshHostRequest>(&line).ok())
    {
        Some(request) if valid_request(&request) => {
            if request.version != SSH_HOST_VERSION {
                response(&request, SshHostOutcome::Incompatible)
            } else {
                #[cfg(target_os = "linux")]
                {
                    linux::command(operation, &request).await
                }
                #[cfg(not(target_os = "linux"))]
                {
                    let _ = operation;
                    response(&request, SshHostOutcome::Unsupported)
                }
            }
        }
        _ => response(&fallback, SshHostOutcome::InvalidRequest),
    };
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &result)?;
    writeln!(stdout)?;
    stdout.flush()
}

fn valid_ownership_id(value: &str) -> bool {
    // Match the desktop UUID boundary; parse_str also accepts other spellings
    // that would become distinct journal keys for the same UUID value.
    value.len() == 36
        && uuid::Uuid::parse_str(value).is_ok()
        && matches!(value.as_bytes()[14], b'1'..=b'8')
        && matches!(
            value.as_bytes()[19].to_ascii_lowercase(),
            b'8' | b'9' | b'a' | b'b'
        )
}

fn valid_request(request: &SshHostRequest) -> bool {
    valid_ownership_id(&request.acquisition_id)
        && request
            .instance_id
            .as_ref()
            .is_none_or(|id| valid_ownership_id(id))
        && request
            .expected_environment_id
            .as_ref()
            .is_none_or(|id| crate::is_valid_environment_id(id))
}

/// Private detached child entry: no endpoint, command or credential is accepted.
pub async fn serve_child() -> Result<(), crate::ServerError> {
    #[cfg(target_os = "linux")]
    {
        linux::serve_child().await
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(crate::ServerError::Configuration(
            "SSH management requires Linux".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_frames_reject_unknown_fields_and_unbounded_ids() {
        assert!(
            serde_json::from_str::<SshHostRequest>(
                r#"{"version":1,"acquisitionId":"x","locator":{"kind":"default"},"shell":"whoami"}"#
            )
            .is_err()
        );
        let mut request = SshHostRequest {
            version: 1,
            acquisition_id: "x".repeat(1000),
            locator: gitgui_protocol::SshEnvironmentLocator::Default,
            expected_environment_id: None,
            instance_id: None,
        };
        assert!(!valid_request(&request));
        request.acquisition_id = uuid::Uuid::new_v4().to_string();
        assert!(valid_request(&request));
        request.expected_environment_id = Some("gitgui-123456-1788413802919117400".into());
        assert!(valid_request(&request));
        request.instance_id = request.expected_environment_id.clone();
        assert!(
            !valid_request(&request),
            "instance ownership still requires a UUID"
        );
    }

    #[test]
    fn ownership_ids_use_the_same_uuid_syntax_as_desktop() {
        let canonical = uuid::Uuid::new_v4().to_string();
        assert!(valid_ownership_id(&canonical));
        assert!(valid_ownership_id(&canonical.to_uppercase()));
        for invalid in [
            canonical.replace('-', ""),
            format!("{{{canonical}}}"),
            format!("urn:uuid:{canonical}"),
            "00000000-0000-0000-0000-000000000000".into(),
            "11111111-1111-9111-8111-111111111111".into(),
        ] {
            assert!(!valid_ownership_id(&invalid));
        }
    }

    #[test]
    fn corrupt_existing_identity_is_never_replaced_on_startup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.json");
        std::fs::write(&path, b"corrupt existing identity").unwrap();
        let config = crate::ServerConfig {
            data_dir: Some(dir.path().into()),
            ..crate::ServerConfig::default()
        };
        assert!(crate::load_startup_state(&config).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"corrupt existing identity");
    }
}
