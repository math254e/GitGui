use gitgui_protocol::{
    AuthSession, PairingCredentialResponse, TokenExchangeResponse, WebSocketTicketResponse,
    ADMIN_SCOPES, CLIENT_SCOPES,
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
}

pub(crate) struct AuthStore {
    environment_id: String,
    bootstrap_credential: Option<String>,
    pairing_credentials: Mutex<HashMap<String, CredentialGrant>>,
    sessions: Mutex<HashMap<String, SessionRecord>>,
    websocket_tickets: Mutex<HashMap<String, TicketRecord>>,
}

impl AuthStore {
    pub(crate) fn new(environment_id: String, bootstrap_credential: Option<String>) -> Self {
        Self {
            environment_id,
            bootstrap_credential: bootstrap_credential.filter(|value| !value.is_empty()),
            pairing_credentials: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            websocket_tickets: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn required(&self) -> bool {
        self.bootstrap_credential.is_some()
    }

    pub(crate) async fn exchange(
        &self,
        subject_token: &str,
        requested_scope: Option<&str>,
    ) -> Result<TokenExchangeResponse, AuthError> {
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
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
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
        assert!(store
            .consume_websocket_ticket(Some(&ticket.ticket))
            .await
            .is_ok());
        assert!(store
            .consume_websocket_ticket(Some(&ticket.ticket))
            .await
            .is_err());
    }
}
