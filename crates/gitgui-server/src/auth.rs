#[path = "auth_repository.rs"]
mod auth_repository;

use gitgui_protocol::{
    ADMIN_SCOPES, AuthSession, CLIENT_SCOPES, PairingCredentialResponse, TokenExchangeResponse,
    WebSocketTicketResponse,
};
use rand::RngCore;
use std::{
    collections::HashMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);
const WEBSOCKET_TICKET_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug)]
struct CredentialGrant {
    scopes: Vec<String>,
    expires_at: SystemTime,
}

#[derive(Clone, Debug)]
struct SessionRecord {
    id: String,
    scopes: Vec<String>,
    expires_at: SystemTime,
}

#[derive(Clone, Debug)]
struct TicketRecord {
    session_token: String,
    expires_at: SystemTime,
}

#[derive(Debug)]
pub(crate) enum AuthError {
    Unauthorized,
    Forbidden,
    InvalidScope,
    Storage,
    IdentityMismatch,
}

pub(crate) struct AuthStore {
    environment_id: String,
    repository: Option<auth_repository::AuthRepository>,
    bootstrap_credential: Option<String>,
    pairing_credentials: Mutex<HashMap<String, CredentialGrant>>,
    sessions: Mutex<HashMap<String, SessionRecord>>,
    websocket_tickets: Mutex<HashMap<String, TicketRecord>>,
}

impl AuthStore {
    pub(crate) fn authentication_required(data_dir: &std::path::Path) -> Result<bool, AuthError> {
        auth_repository::required(data_dir)
    }
    pub(crate) fn new(environment_id: String, bootstrap_credential: Option<String>) -> Self {
        Self {
            environment_id,
            repository: None,
            bootstrap_credential: bootstrap_credential.filter(|value| !value.is_empty()),
            pairing_credentials: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            websocket_tickets: Mutex::new(HashMap::new()),
        }
    }

    /// Persistent managed store. Call from a blocking worker during startup.
    pub(crate) fn open(
        environment_id: String,
        bootstrap_credential: Option<String>,
        data_dir: &std::path::Path,
    ) -> Result<Self, AuthError> {
        let repository = auth_repository::AuthRepository::open(data_dir, &environment_id)?;
        let mut store = Self::new(environment_id, bootstrap_credential);
        store.repository = Some(repository);
        Ok(store)
    }

    /// The OS-owner helper must read an existing server identity, never create one.
    #[cfg(any(target_os = "linux", test))]
    pub(crate) async fn issue_owner_pairing(
        data_dir: &std::path::Path,
        expected_environment_id: &str,
    ) -> Result<PairingCredentialResponse, AuthError> {
        let path = data_dir.to_owned();
        let expected = expected_environment_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let identity: serde_json::Value = serde_json::from_slice(
                &std::fs::read(path.join("server.json")).map_err(|_| AuthError::Storage)?,
            )
            .map_err(|_| AuthError::Storage)?;
            if identity
                .get("schemaVersion")
                .or_else(|| identity.get("schema_version"))
                .and_then(|v| v.as_u64())
                != Some(1)
                || identity
                    .get("serverId")
                    .or_else(|| identity.get("server_id"))
                    .and_then(|v| v.as_str())
                    != Some(expected.as_str())
                || expected.is_empty()
            {
                return Err(AuthError::IdentityMismatch);
            }
            let repo = auth_repository::AuthRepository::open(&path, &expected)?;
            let scopes = [
                gitgui_protocol::SCOPE_REPOSITORY_READ,
                gitgui_protocol::SCOPE_REPOSITORY_OPERATE,
                gitgui_protocol::SCOPE_REPOSITORY_MANAGE,
            ]
            .iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<_>>();
            let credential = random_token("ggp");
            repo.issue(&credential, &scopes, SystemTime::now() + PAIRING_TTL)?;
            Ok(PairingCredentialResponse {
                credential,
                expires_in: PAIRING_TTL.as_secs(),
                scopes,
            })
        })
        .await
        .map_err(|_| AuthError::Storage)?
    }

    pub(crate) fn required(&self) -> bool {
        self.repository.is_some() || self.bootstrap_credential.is_some()
    }

    pub(crate) async fn exchange(
        &self,
        subject_token: &str,
        requested_scope: Option<&str>,
    ) -> Result<TokenExchangeResponse, AuthError> {
        if let Some(repo) = self.repository.clone() {
            let subject = subject_token.to_string();
            let requested = requested_scope.map(str::to_owned);
            let admin = self
                .bootstrap_credential
                .as_deref()
                .is_some_and(|expected| {
                    constant_time_equal(expected.as_bytes(), subject.as_bytes())
                });
            let token = random_token("ggs");
            let session = SessionRecord {
                id: random_token("session"),
                scopes: Vec::new(),
                expires_at: SystemTime::now() + SESSION_TTL,
            };
            let issued = token.clone();
            let scopes = tokio::task::spawn_blocking(move || {
                repo.exchange(
                    Some(&subject),
                    admin.then(|| ADMIN_SCOPES.iter().map(|s| (*s).to_string()).collect()),
                    requested.as_deref(),
                    &issued,
                    &session,
                )
            })
            .await
            .map_err(|_| AuthError::Storage)??;
            return Ok(TokenExchangeResponse {
                access_token: token,
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token".to_string(),
                token_type: "Bearer".to_string(),
                expires_in: SESSION_TTL.as_secs(),
                scope: scopes.join(" "),
            });
        }
        let granted_scopes = if self
            .bootstrap_credential
            .as_deref()
            .is_some_and(|expected| {
                constant_time_equal(expected.as_bytes(), subject_token.as_bytes())
            }) {
            ADMIN_SCOPES
                .iter()
                .map(|scope| (*scope).to_string())
                .collect()
        } else {
            let mut credentials = self.pairing_credentials.lock().await;
            remove_expired(&mut credentials, |grant| grant.expires_at);
            credentials
                .remove(subject_token)
                .filter(|grant| grant.expires_at > SystemTime::now())
                .map(|grant| grant.scopes)
                .ok_or(AuthError::Unauthorized)?
        };

        let scopes = requested_scopes(requested_scope, &granted_scopes)?;
        let token = random_token("ggs");
        let session = SessionRecord {
            id: random_token("session"),
            scopes: scopes.clone(),
            expires_at: SystemTime::now() + SESSION_TTL,
        };
        self.sessions.lock().await.insert(token.clone(), session);

        Ok(TokenExchangeResponse {
            access_token: token,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token".to_string(),
            token_type: "Bearer".to_string(),
            expires_in: SESSION_TTL.as_secs(),
            scope: scopes.join(" "),
        })
    }

    pub(crate) async fn session(&self, token: &str) -> Result<AuthSession, AuthError> {
        if !self.required() && token.is_empty() {
            return Ok(AuthSession {
                session_id: "development-session".to_string(),
                environment_id: self.environment_id.clone(),
                scopes: ADMIN_SCOPES
                    .iter()
                    .map(|scope| (*scope).to_string())
                    .collect(),
                expires_at_unix_ms: u64::MAX,
            });
        }

        if let Some(repo) = self.repository.clone() {
            let token = token.to_string();
            let session = tokio::task::spawn_blocking(move || repo.session(&token))
                .await
                .map_err(|_| AuthError::Storage)??;
            return Ok(AuthSession {
                session_id: session.id,
                environment_id: self.environment_id.clone(),
                scopes: session.scopes,
                expires_at_unix_ms: unix_millis(session.expires_at),
            });
        }
        let mut sessions = self.sessions.lock().await;
        remove_expired(&mut sessions, |session| session.expires_at);
        let session = sessions.get(token).ok_or(AuthError::Unauthorized)?;
        Ok(AuthSession {
            session_id: session.id.clone(),
            environment_id: self.environment_id.clone(),
            scopes: session.scopes.clone(),
            expires_at_unix_ms: unix_millis(session.expires_at),
        })
    }

    pub(crate) async fn require_scopes(
        &self,
        token: &str,
        required: &[&str],
    ) -> Result<AuthSession, AuthError> {
        let session = self.session(token).await?;
        if required
            .iter()
            .all(|scope| session.scopes.iter().any(|granted| granted == scope))
        {
            Ok(session)
        } else {
            Err(AuthError::Forbidden)
        }
    }

    #[cfg(test)]
    pub(crate) async fn revoke_pairing_credential(&self, token: &str) -> Result<bool, AuthError> {
        if let Some(repo) = self.repository.clone() {
            let token = token.to_string();
            return tokio::task::spawn_blocking(move || repo.revoke_grant(&token))
                .await
                .map_err(|_| AuthError::Storage)?;
        }
        Ok(self
            .pairing_credentials
            .lock()
            .await
            .remove(token)
            .is_some())
    }

    #[cfg(test)]
    pub(crate) async fn revoke_session(&self, token: &str) -> Result<bool, AuthError> {
        if let Some(repo) = self.repository.clone() {
            let token = token.to_string();
            return tokio::task::spawn_blocking(move || repo.revoke(&token))
                .await
                .map_err(|_| AuthError::Storage)?;
        }
        Ok(self.sessions.lock().await.remove(token).is_some())
    }

    pub(crate) async fn issue_websocket_ticket(
        &self,
        session_token: &str,
    ) -> Result<WebSocketTicketResponse, AuthError> {
        self.session(session_token).await?;
        let ticket = random_token("ggw");
        self.websocket_tickets.lock().await.insert(
            ticket.clone(),
            TicketRecord {
                session_token: session_token.to_string(),
                expires_at: SystemTime::now() + WEBSOCKET_TICKET_TTL,
            },
        );
        Ok(WebSocketTicketResponse {
            ticket,
            expires_in: WEBSOCKET_TICKET_TTL.as_secs(),
        })
    }

    pub(crate) async fn consume_websocket_ticket(
        &self,
        ticket: Option<&str>,
    ) -> Result<AuthSession, AuthError> {
        if !self.required() && ticket.is_none() {
            return self.session("").await;
        }
        let ticket = ticket.ok_or(AuthError::Unauthorized)?;
        let record = {
            let mut tickets = self.websocket_tickets.lock().await;
            remove_expired(&mut tickets, |record| record.expires_at);
            tickets.remove(ticket).ok_or(AuthError::Unauthorized)?
        };
        if record.expires_at <= SystemTime::now() {
            return Err(AuthError::Unauthorized);
        }
        self.session(&record.session_token).await
    }

    pub(crate) async fn issue_pairing_credential(
        &self,
        session_token: &str,
    ) -> Result<PairingCredentialResponse, AuthError> {
        self.require_scopes(session_token, &[gitgui_protocol::SCOPE_ACCESS_WRITE])
            .await?;
        let credential = random_token("ggp");
        let scopes = CLIENT_SCOPES
            .iter()
            .map(|scope| (*scope).to_string())
            .collect::<Vec<_>>();
        if let Some(repo) = self.repository.clone() {
            let issued = credential.clone();
            let grant_scopes = scopes.clone();
            tokio::task::spawn_blocking(move || {
                repo.issue(&issued, &grant_scopes, SystemTime::now() + PAIRING_TTL)
            })
            .await
            .map_err(|_| AuthError::Storage)??;
            return Ok(PairingCredentialResponse {
                credential,
                expires_in: PAIRING_TTL.as_secs(),
                scopes,
            });
        }
        self.pairing_credentials.lock().await.insert(
            credential.clone(),
            CredentialGrant {
                scopes: scopes.clone(),
                expires_at: SystemTime::now() + PAIRING_TTL,
            },
        );
        Ok(PairingCredentialResponse {
            credential,
            expires_in: PAIRING_TTL.as_secs(),
            scopes,
        })
    }
}

fn requested_scopes(requested: Option<&str>, granted: &[String]) -> Result<Vec<String>, AuthError> {
    let requested = requested.unwrap_or("").split_ascii_whitespace();
    let requested = requested.collect::<Vec<_>>();
    if requested.is_empty() {
        return Ok(granted.to_vec());
    }
    let mut scopes = Vec::new();
    for scope in requested {
        if !granted.iter().any(|granted| granted == scope) {
            return Err(AuthError::InvalidScope);
        }
        if !scopes.iter().any(|known| known == scope) {
            scopes.push(scope.to_string());
        }
    }
    Ok(scopes)
}

fn remove_expired<T>(values: &mut HashMap<String, T>, expires_at: impl Fn(&T) -> SystemTime) {
    let now = SystemTime::now();
    values.retain(|_, value| expires_at(value) > now);
}

fn unix_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn random_token(prefix: &str) -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut token = String::with_capacity(prefix.len() + 1 + bytes.len() * 2);
    token.push_str(prefix);
    token.push('_');
    for byte in bytes {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        token.push(HEX[(byte >> 4) as usize] as char);
        token.push(HEX[(byte & 15) as usize] as char);
    }
    token
}

fn constant_time_equal(expected: &[u8], supplied: &[u8]) -> bool {
    let mut difference = expected.len() ^ supplied.len();
    let length = expected.len().max(supplied.len());
    for index in 0..length {
        difference |= usize::from(
            expected.get(index).copied().unwrap_or(0) ^ supplied.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pairing_and_websocket_tickets_are_single_use() {
        let store = AuthStore::new("environment".to_string(), Some("bootstrap".to_string()));
        let admin = store.exchange("bootstrap", None).await.unwrap();
        assert_eq!(
            admin.scope.split_whitespace().collect::<Vec<_>>(),
            ADMIN_SCOPES
        );
        let pairing = store
            .issue_pairing_credential(&admin.access_token)
            .await
            .unwrap();
        let client = store.exchange(&pairing.credential, None).await.unwrap();
        assert_eq!(
            client.scope.split_whitespace().collect::<Vec<_>>(),
            CLIENT_SCOPES
        );
        assert!(matches!(
            store
                .require_scopes(
                    &client.access_token,
                    &[gitgui_protocol::SCOPE_REPOSITORY_MANAGE]
                )
                .await,
            Err(AuthError::Forbidden)
        ));
        assert!(store.exchange(&pairing.credential, None).await.is_err());

        let ticket = store
            .issue_websocket_ticket(&client.access_token)
            .await
            .unwrap();
        assert!(
            store
                .consume_websocket_ticket(Some(&ticket.ticket))
                .await
                .is_ok()
        );
        assert!(
            store
                .consume_websocket_ticket(Some(&ticket.ticket))
                .await
                .is_err()
        );
    }
}

#[cfg(test)]
mod durable_tests {
    use super::*;
    use std::sync::Arc;

    fn identity(dir: &std::path::Path) {
        std::fs::write(
            dir.join("server.json"),
            r#"{"schemaVersion":1,"serverId":"environment"}"#,
        )
        .unwrap();
    }
    fn open(dir: &std::path::Path) -> AuthStore {
        AuthStore::open("environment".into(), Some("bootstrap".into()), dir).unwrap()
    }
    #[tokio::test]
    async fn running_store_rejects_removed_or_changed_metadata() {
        for mutation in [
            "DELETE FROM auth_meta",
            "UPDATE auth_meta SET environment='other'",
            "UPDATE auth_meta SET secret=x'01'",
        ] {
            let dir = tempfile::tempdir().unwrap();
            identity(dir.path());
            let store = open(dir.path());
            let token = store
                .exchange("bootstrap", None)
                .await
                .unwrap()
                .access_token;
            let db = rusqlite::Connection::open(dir.path().join("auth.sqlite3")).unwrap();
            db.execute(mutation, []).unwrap();
            assert!(matches!(
                store.session(&token).await,
                Err(AuthError::Storage)
            ));
            assert!(matches!(
                store.exchange("bootstrap", None).await,
                Err(AuthError::Storage)
            ));
            assert!(matches!(
                store.revoke_session(&token).await,
                Err(AuthError::Storage)
            ));
        }
    }

    #[tokio::test]
    async fn missing_database_keeps_durable_authentication_required() {
        let dir = tempfile::tempdir().unwrap();
        identity(dir.path());
        drop(open(dir.path()));
        std::fs::remove_file(dir.path().join("auth.sqlite3")).unwrap();
        assert!(AuthStore::authentication_required(dir.path()).unwrap());
        assert!(matches!(
            AuthStore::open("environment".into(), None, dir.path()),
            Err(AuthError::Storage)
        ));
    }
    #[tokio::test]
    async fn incomplete_existing_authentication_store_is_never_reinitialized() {
        for mutation in [
            "truncate-database",
            "drop-metadata",
            "drop-grants",
            "drop-sessions",
            "remove-policy",
        ] {
            let dir = tempfile::tempdir().unwrap();
            identity(dir.path());
            let store = open(dir.path());
            store.exchange("bootstrap", None).await.unwrap();
            drop(store);
            match mutation {
                "truncate-database" => std::fs::write(dir.path().join("auth.sqlite3"), []).unwrap(),
                "drop-metadata" | "drop-grants" | "drop-sessions" => {
                    let db = rusqlite::Connection::open(dir.path().join("auth.sqlite3")).unwrap();
                    let statement = match mutation {
                        "drop-metadata" => "DROP TABLE auth_meta",
                        "drop-grants" => "DROP TABLE grants",
                        _ => "DROP TABLE sessions",
                    };
                    db.execute(statement, []).unwrap();
                }
                _ => std::fs::remove_file(dir.path().join("auth-required.json")).unwrap(),
            }
            assert!(AuthStore::authentication_required(dir.path()).unwrap());
            assert!(
                matches!(
                    AuthStore::open("environment".into(), None, dir.path()),
                    Err(AuthError::Storage)
                ),
                "{mutation}"
            );
            assert_eq!(
                dir.path().join("auth-required.json").exists(),
                mutation != "remove-policy"
            );
        }
    }
    #[tokio::test]
    async fn owner_grant_cross_store_restart_and_revoke() {
        let dir = tempfile::tempdir().unwrap();
        identity(dir.path());
        let running = open(dir.path());
        let grant = AuthStore::issue_owner_pairing(dir.path(), "environment")
            .await
            .unwrap();
        assert_eq!(
            grant.scopes,
            vec!["repository:read", "repository:operate", "repository:manage"]
        );
        let token = running
            .exchange(&grant.credential, None)
            .await
            .unwrap()
            .access_token;
        assert!(running.exchange(&grant.credential, None).await.is_err());
        drop(running);
        let restarted = open(dir.path());
        assert!(restarted.session(&token).await.is_ok());
        assert!(restarted.revoke_session(&token).await.unwrap());
        assert!(restarted.session(&token).await.is_err());
        let bytes = std::fs::read(dir.path().join("auth.sqlite3")).unwrap();
        assert!(!bytes.windows(token.len()).any(|w| w == token.as_bytes()));
        assert!(
            !bytes
                .windows(grant.credential.len())
                .any(|w| w == grant.credential.as_bytes())
        );
        assert!(!bytes.windows(9).any(|w| w == b"bootstrap"));
    }
    #[tokio::test]
    async fn competing_exchange_and_invalid_scope() {
        let dir = tempfile::tempdir().unwrap();
        identity(dir.path());
        let a = Arc::new(open(dir.path()));
        let b = Arc::new(open(dir.path()));
        let grant = AuthStore::issue_owner_pairing(dir.path(), "environment")
            .await
            .unwrap();
        assert!(matches!(
            a.exchange(&grant.credential, Some("access:write")).await,
            Err(AuthError::InvalidScope)
        ));
        let (one, two) = tokio::join!(
            a.exchange(&grant.credential, None),
            b.exchange(&grant.credential, None)
        );
        assert_ne!(one.is_ok(), two.is_ok());
    }
    #[tokio::test]
    async fn managed_empty_store_is_not_anonymous_and_identity_is_checked() {
        let dir = tempfile::tempdir().unwrap();
        identity(dir.path());
        let store = AuthStore::open("environment".into(), None, dir.path()).unwrap();
        assert!(store.required());
        assert!(store.session("").await.is_err());
        assert!(
            AuthStore::issue_owner_pairing(dir.path(), "other")
                .await
                .is_err()
        );
        assert!(!AuthStore::new("dev".into(), None).required());
    }
    #[tokio::test]
    async fn expiry_and_corruption_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        identity(dir.path());
        let store = open(dir.path());
        let repo = store.repository.as_ref().unwrap();
        repo.issue(
            "expired",
            &["repository:read".into()],
            SystemTime::now() - Duration::from_secs(1),
        )
        .unwrap();
        assert!(store.exchange("expired", None).await.is_err());
        repo.issue(
            "revoked",
            &["repository:read".into()],
            SystemTime::now() + Duration::from_secs(60),
        )
        .unwrap();
        assert!(store.revoke_pairing_credential("revoked").await.unwrap());
        assert!(store.exchange("revoked", None).await.is_err());
        let expired_session = SessionRecord {
            id: "expired".into(),
            scopes: vec![],
            expires_at: SystemTime::now() - Duration::from_secs(1),
        };
        repo.exchange(
            None,
            Some(vec![]),
            None,
            "expired-session",
            &expired_session,
        )
        .unwrap();
        assert!(store.session("expired-session").await.is_err());
        let conn = rusqlite::Connection::open(dir.path().join("auth.sqlite3")).unwrap();
        conn.execute("UPDATE auth_meta SET secret=x'01'", [])
            .unwrap();
        drop(conn);
        drop(store);
        assert!(matches!(
            AuthStore::open("environment".into(), None, dir.path()),
            Err(AuthError::Storage)
        ));
        let corrupt = tempfile::tempdir().unwrap();
        std::fs::write(corrupt.path().join("auth.sqlite3"), b"not a database").unwrap();
        assert!(matches!(
            AuthStore::open("environment".into(), None, corrupt.path()),
            Err(AuthError::Storage)
        ));
    }
}
