//! Secrets only cross this boundary into an operating-system credential store.
use crate::Credentials;
use serde::{Deserialize, Serialize};
use std::fmt;
use zeroize::Zeroizing;

/// Deliberately excludes backend error payloads: some keyring errors contain secret bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialStoreError {
    Unavailable,
    InvalidRecord,
    TooLarge,
}
impl fmt::Display for CredentialStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "The system credential store is locked or unavailable; unlock it or select session-only credentials",
            Self::InvalidRecord => "The system credential record is unreadable; enter the credentials again",
            Self::TooLarge => "The credential record exceeds this system credential store's supported size",
        })
    }
}
impl std::error::Error for CredentialStoreError {}

/// Injectable to test persistence and failures without touching a real user's vault.
/// Implementations must not log secret bytes or attach them to errors.
pub trait CredentialStore: Send + Sync {
    fn load(&self, key: &str) -> Result<Option<Zeroizing<Vec<u8>>>, CredentialStoreError>;
    fn save(&self, key: &str, secret: &[u8]) -> Result<(), CredentialStoreError>;
    fn delete(&self, key: &str) -> Result<(), CredentialStoreError>;
}

pub struct SystemCredentialStore {
    service: String,
}
impl Default for SystemCredentialStore {
    fn default() -> Self {
        Self {
            service: "app.nebulume.storage.v1".into(),
        }
    }
}
impl SystemCredentialStore {
    fn entry(&self, key: &str) -> Result<keyring::Entry, CredentialStoreError> {
        // Never permit keyring's fallback mock backend on unsupported targets.
        if !cfg!(any(
            target_os = "windows",
            target_os = "macos",
            target_os = "linux"
        )) {
            return Err(CredentialStoreError::Unavailable);
        }
        keyring::Entry::new(&self.service, key).map_err(safe_error)
    }
}
fn safe_error(error: keyring::Error) -> CredentialStoreError {
    match error {
        keyring::Error::BadEncoding(_) => CredentialStoreError::InvalidRecord,
        keyring::Error::TooLong(_, _) => CredentialStoreError::TooLarge,
        _ => CredentialStoreError::Unavailable,
    }
}
impl CredentialStore for SystemCredentialStore {
    fn load(&self, key: &str) -> Result<Option<Zeroizing<Vec<u8>>>, CredentialStoreError> {
        match self.entry(key)?.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(safe_error(error)),
        }
    }
    fn save(&self, key: &str, secret: &[u8]) -> Result<(), CredentialStoreError> {
        self.entry(key)?.set_secret(secret).map_err(safe_error)
    }
    fn delete(&self, key: &str) -> Result<(), CredentialStoreError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(safe_error(error)),
        }
    }
}

// Credentials themselves are not Serialize/Debug. This private borrowed wire view is
// used only to create the protected vault payload, never a config or API response.
#[derive(Serialize)]
struct StoredCredentials<'a> {
    username: &'a Option<String>,
    password: &'a Option<String>,
    access_key: &'a Option<String>,
    secret_key: &'a Option<String>,
    session_token: &'a Option<String>,
}
#[derive(Serialize)]
struct StoredRecord<'a> {
    version: u8,
    credentials: StoredCredentials<'a>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LoadedRecord {
    version: u8,
    credentials: Credentials,
}
pub(crate) fn encode(
    credentials: &Credentials,
) -> Result<Zeroizing<Vec<u8>>, CredentialStoreError> {
    serde_json::to_vec(&StoredRecord {
        version: 1,
        credentials: StoredCredentials {
            username: &credentials.username,
            password: &credentials.password,
            access_key: &credentials.access_key,
            secret_key: &credentials.secret_key,
            session_token: &credentials.session_token,
        },
    })
    .map(Zeroizing::new)
    .map_err(|_| CredentialStoreError::InvalidRecord)
}
pub(crate) fn decode(secret: &[u8]) -> Result<Credentials, CredentialStoreError> {
    let record: LoadedRecord =
        serde_json::from_slice(secret).map_err(|_| CredentialStoreError::InvalidRecord)?;
    if record.version != 1 {
        return Err(CredentialStoreError::InvalidRecord);
    }
    Ok(record.credentials)
}

#[cfg(all(test, target_os = "windows"))]
mod native_test {
    use super::*;

    #[test]
    #[ignore = "Explicit test of the Windows credential vault; creates and removes one random synthetic entry"]
    fn windows_native_vault_roundtrip_cleans_up_its_entry() {
        let store = SystemCredentialStore {
            service: format!("Nebulume-test-{}", uuid::Uuid::new_v4()),
        };
        let key = uuid::Uuid::new_v4().to_string();
        struct Cleanup<'a>(&'a SystemCredentialStore, &'a str);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete(self.1);
            }
        }
        let _cleanup = Cleanup(&store, &key);
        assert!(store.load(&key).unwrap().is_none());
        let secret = Zeroizing::new(b"synthetic-nebulume-credential".to_vec());
        store.save(&key, &secret).unwrap();
        assert!(store
            .load(&key)
            .unwrap()
            .is_some_and(|loaded| *loaded == *secret));
        store.delete(&key).unwrap();
        assert!(store.load(&key).unwrap().is_none());
    }
}
