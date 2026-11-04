//! Rust translation of T3 70cd258d8aac43ea57494527b00bf36de3efa6c0 durable
//! PairingGrantStore/SessionStore semantics. Opaque tokens and keyed digests
//! preserve GitGui's wire contract; see docs/ssh-auth.md for adaptations.
use super::{AuthError, SessionRecord, constant_time_equal, requested_scopes, unix_millis};
use hmac::{Hmac, Mac};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::Sha256;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub(super) struct AuthRepository {
    path: PathBuf,
    secret: [u8; 32],
    environment_id: String,
}

const AUTH_REQUIRED_FILE: &str = "auth-required.json";

fn exists(path: &Path) -> Result<bool, AuthError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(AuthError::Storage),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(AuthError::Storage),
    }
}

pub(super) fn required(data_dir: &Path) -> Result<bool, AuthError> {
    let policy = exists(&data_dir.join(AUTH_REQUIRED_FILE))?;
    let database = exists(&data_dir.join("auth.sqlite3"))?;
    Ok(policy || database)
}

fn policy(data_dir: &Path, environment_id: &str) -> Result<bool, AuthError> {
    if !exists(&data_dir.join(AUTH_REQUIRED_FILE))? {
        return Ok(false);
    }
    let file = match std::fs::File::open(data_dir.join(AUTH_REQUIRED_FILE)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(AuthError::Storage),
    };
    if file.metadata().map_err(|_| AuthError::Storage)?.len() > 1024 {
        return Err(AuthError::Storage);
    }
    let value: serde_json::Value =
        serde_json::from_reader(file.take(1024)).map_err(|_| AuthError::Storage)?;
    if value["version"] != 1 || value["environmentId"] != environment_id {
        return Err(AuthError::IdentityMismatch);
    }
    Ok(true)
}

fn persist_policy(data_dir: &Path, environment_id: &str) -> Result<(), AuthError> {
    if policy(data_dir, environment_id)? {
        return Ok(());
    }
    let temporary = data_dir.join(format!(".auth-required-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| AuthError::Storage)?;
        let bytes =
            serde_json::to_vec(&serde_json::json!({"version": 1, "environmentId": environment_id}))
                .map_err(|_| AuthError::Storage)?;
        file.write_all(&bytes).map_err(|_| AuthError::Storage)?;
        file.sync_all().map_err(|_| AuthError::Storage)?;
        std::fs::rename(&temporary, data_dir.join(AUTH_REQUIRED_FILE))
            .map_err(|_| AuthError::Storage)
    })();
    let _ = std::fs::remove_file(temporary);
    result
}

impl AuthRepository {
    pub(super) fn open(data_dir: &Path, environment_id: &str) -> Result<Self, AuthError> {
        std::fs::create_dir_all(data_dir).map_err(|_| AuthError::Storage)?;
        let path = data_dir.join("auth.sqlite3");
        let database_exists = exists(&path)?;
        // Both files are introduced by this durable format. A one-sided store
        // is interrupted initialization or lost state, never implicit migration.
        if policy(data_dir, environment_id)? != database_exists {
            return Err(AuthError::Storage);
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(0o600);
            let file = options.open(&path).map_err(|_| AuthError::Storage)?;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| AuthError::Storage)?;
        }
        #[cfg(not(unix))]
        {
            options.open(&path).map_err(|_| AuthError::Storage)?;
        }
        let mut db = connect(&path)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthError::Storage)?;
        let initialized: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_meta')", [], |r| r.get(0)).map_err(|_| AuthError::Storage)?;
        if database_exists && !initialized {
            return Err(AuthError::Storage);
        }
        if !initialized {
            tx.execute_batch("CREATE TABLE auth_meta (id INTEGER PRIMARY KEY CHECK(id=1), environment TEXT NOT NULL, secret BLOB NOT NULL); CREATE TABLE grants (digest BLOB PRIMARY KEY, scopes TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE sessions (digest BLOB PRIMARY KEY, id TEXT NOT NULL, scopes TEXT NOT NULL, expires INTEGER NOT NULL);").map_err(|_| AuthError::Storage)?;
        }
        // Existing stores are validated, never repaired by startup DDL. Lost
        // grant/session tables are corruption even when auth_meta survived.
        tx.prepare("SELECT digest, scopes, expires FROM grants LIMIT 0")
            .map_err(|_| AuthError::Storage)?;
        tx.prepare("SELECT digest, id, scopes, expires FROM sessions LIMIT 0")
            .map_err(|_| AuthError::Storage)?;
        let row: Option<(String, Vec<u8>)> = tx
            .query_row(
                "SELECT environment, secret FROM auth_meta WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| AuthError::Storage)?;
        let secret = if let Some((id, secret)) = row {
            if id != environment_id {
                return Err(AuthError::IdentityMismatch);
            }
            secret.try_into().map_err(|_| AuthError::Storage)?
        } else {
            // Missing metadata in a populated store is corruption, not a new identity.
            let count: i64 = tx
                .query_row(
                    "SELECT (SELECT count(*) FROM grants)+(SELECT count(*) FROM sessions)",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| AuthError::Storage)?;
            if initialized || count != 0 {
                return Err(AuthError::Storage);
            }
            let mut secret = [0u8; 32];
            rand::rng().fill_bytes(&mut secret);
            tx.execute(
                "INSERT INTO auth_meta VALUES (1, ?1, ?2)",
                params![environment_id, &secret[..]],
            )
            .map_err(|_| AuthError::Storage)?;
            secret
        };
        tx.commit().map_err(|_| AuthError::Storage)?;
        persist_policy(data_dir, environment_id)?;
        Ok(Self {
            path,
            secret,
            environment_id: environment_id.to_owned(),
        })
    }
    fn validate_metadata(&self, tx: &Transaction<'_>) -> Result<(), AuthError> {
        let (environment, secret): (String, Vec<u8>) = tx
            .query_row(
                "SELECT environment, secret FROM auth_meta WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| AuthError::Storage)?;
        if environment != self.environment_id || !constant_time_equal(&secret, &self.secret) {
            return Err(AuthError::Storage);
        }
        Ok(())
    }
    fn digest(&self, domain: &str, token: &str) -> Result<Vec<u8>, AuthError> {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.secret).map_err(|_| AuthError::Storage)?;
        mac.update(domain.as_bytes());
        mac.update(&[0]);
        mac.update(token.as_bytes());
        Ok(mac.finalize().into_bytes().to_vec())
    }
    pub(super) fn issue(
        &self,
        token: &str,
        scopes: &[String],
        expires: SystemTime,
    ) -> Result<(), AuthError> {
        let mut db = connect(&self.path)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthError::Storage)?;
        self.validate_metadata(&tx)?;
        tx.execute(
            "INSERT INTO grants VALUES (?1, ?2, ?3)",
            params![
                self.digest("grant", token)?,
                serde_json::to_string(scopes).map_err(|_| AuthError::Storage)?,
                unix_millis(expires) as i64
            ],
        )
        .map_err(|_| AuthError::Storage)?;
        tx.commit().map_err(|_| AuthError::Storage)
    }
    pub(super) fn exchange(
        &self,
        grant: Option<&str>,
        admin: Option<Vec<String>>,
        requested: Option<&str>,
        token: &str,
        session: &SessionRecord,
    ) -> Result<Vec<String>, AuthError> {
        let mut db = connect(&self.path)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthError::Storage)?;
        self.validate_metadata(&tx)?;
        let scopes = if let Some(scopes) = admin {
            scopes
        } else {
            let digest = self.digest("grant", grant.ok_or(AuthError::Unauthorized)?)?;
            let row: Option<(String, i64)> = tx
                .query_row(
                    "SELECT scopes, expires FROM grants WHERE digest=?1",
                    [&digest],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|_| AuthError::Storage)?;
            let (scopes, expires) = row.ok_or(AuthError::Unauthorized)?;
            if expires <= unix_millis(SystemTime::now()) as i64 {
                return Err(AuthError::Unauthorized);
            }
            let scopes: Vec<String> =
                serde_json::from_str(&scopes).map_err(|_| AuthError::Storage)?;
            tx.execute("DELETE FROM grants WHERE digest=?1", [&digest])
                .map_err(|_| AuthError::Storage)?;
            scopes
        };
        let scopes = requested_scopes(requested, &scopes)?;
        tx.execute(
            "INSERT INTO sessions VALUES (?1, ?2, ?3, ?4)",
            params![
                self.digest("session", token)?,
                session.id,
                serde_json::to_string(&scopes).map_err(|_| AuthError::Storage)?,
                unix_millis(session.expires_at) as i64
            ],
        )
        .map_err(|_| AuthError::Storage)?;
        tx.commit().map_err(|_| AuthError::Storage)?;
        Ok(scopes)
    }
    pub(super) fn session(&self, token: &str) -> Result<SessionRecord, AuthError> {
        let mut db = connect(&self.path)?;
        let tx = db.transaction().map_err(|_| AuthError::Storage)?;
        self.validate_metadata(&tx)?;
        let row: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT id, scopes, expires FROM sessions WHERE digest=?1",
                [self.digest("session", token)?],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|_| AuthError::Storage)?;
        let (id, scopes, expires) = row.ok_or(AuthError::Unauthorized)?;
        if expires <= unix_millis(SystemTime::now()) as i64 {
            return Err(AuthError::Unauthorized);
        }
        let session = SessionRecord {
            id,
            scopes: serde_json::from_str(&scopes).map_err(|_| AuthError::Storage)?,
            expires_at: UNIX_EPOCH + Duration::from_millis(expires as u64),
        };
        tx.commit().map_err(|_| AuthError::Storage)?;
        Ok(session)
    }
    pub(super) fn revoke_grant(&self, token: &str) -> Result<bool, AuthError> {
        let mut db = connect(&self.path)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthError::Storage)?;
        self.validate_metadata(&tx)?;
        let changed = tx
            .execute(
                "DELETE FROM grants WHERE digest=?1",
                [self.digest("grant", token)?],
            )
            .map_err(|_| AuthError::Storage)?
            != 0;
        tx.commit().map_err(|_| AuthError::Storage)?;
        Ok(changed)
    }
    pub(super) fn revoke(&self, token: &str) -> Result<bool, AuthError> {
        let mut db = connect(&self.path)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthError::Storage)?;
        self.validate_metadata(&tx)?;
        let changed = tx
            .execute(
                "DELETE FROM sessions WHERE digest=?1",
                [self.digest("session", token)?],
            )
            .map_err(|_| AuthError::Storage)?
            != 0;
        tx.commit().map_err(|_| AuthError::Storage)?;
        Ok(changed)
    }
}
fn connect(path: &Path) -> Result<Connection, AuthError> {
    let db = Connection::open(path).map_err(|_| AuthError::Storage)?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| AuthError::Storage)?;
    Ok(db)
}
