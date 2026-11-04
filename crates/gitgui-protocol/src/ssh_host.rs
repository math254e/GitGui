//! Private OS-owner SSH helper contract. This is not a Git RPC or desktop IPC API.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const SSH_HOST_VERSION: u32 = 1;
pub const SSH_HOST_MAX_FRAME_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SshEnvironmentLocator {
    Default,
    /// Existing/legacy directories require an expected environment ID. No migration occurs here.
    Directory {
        path: String,
        #[serde(rename = "environmentId")]
        environment_id: String,
    },
    /// Old saved targets lack an absolute directory; resolve only this exact key and ID.
    Legacy {
        #[serde(rename = "stateKey")]
        state_key: String,
        #[serde(rename = "environmentId")]
        environment_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostRequest {
    pub version: u32,
    /// Reserved by the desktop before starting SSH; a UUID, never reused.
    pub acquisition_id: String,
    pub locator: SshEnvironmentLocator,
    pub expected_environment_id: Option<String>,
    /// Required by claim/release. Cancellation can run before any result is received.
    pub instance_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SshHostOutcome {
    Ready,
    Claimed,
    Cancelled,
    Released,
    Stopped,
    Retained,
    CleanupPending,
    NotRunning,
    Unsupported,
    InvalidRequest,
    Incompatible,
    IdentityMismatch,
    Ambiguous,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SshHostOwnership {
    Managed,
    External,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostResponse {
    pub version: u32,
    pub acquisition_id: String,
    pub outcome: SshHostOutcome,
    pub instance_id: Option<String>,
    pub environment_id: Option<String>,
    /// Canonical host directory. Persist only after identity/auth/RPC validation.
    pub remote_data_directory: Option<String>,
    /// The only endpoint result: an actual loopback listener port. Never a URL/command/PID.
    pub port: Option<u16>,
    pub ownership: Option<SshHostOwnership>,
    pub expires_at_unix_ms: Option<u64>,
    /// Static diagnostic, never raw command output or credentials.
    pub message: Option<String>,
    /// Only the separate pairing operation returns this secret; never lifecycle metadata.
    pub pairing: Option<crate::PairingCredentialResponse>,
}
