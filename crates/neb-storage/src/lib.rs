//! Read-only storage adapters and non-overwriting local publication.
mod credentials;
mod remote;
mod safe;
mod transport;

pub use credentials::{CredentialStore, CredentialStoreError, SystemCredentialStore};

pub use transport::{inspect_tls, TlsCertificateInfo};

pub use safe::{
    atomic_json, hash_reader, open_scoped, publish_reader, safe_join, validate_key,
    PreparedDestination, ScopedDestination,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageConfig {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub endpoint: String,
    pub root: String,
    pub bucket: Option<String>,
    pub region: Option<String>,
    /// Explicit trust for this source's LAN HTTPS leaf certificate only.
    #[serde(default)]
    pub tls_certificate_sha256: Option<String>,
    /// Result of the latest actual browse/read/check in this process; never persisted as true.
    #[serde(default)]
    pub connected: bool,
    /// Legacy sources did not persist credentials, so absent saved fields remain false.
    #[serde(default)]
    pub remember_credentials: bool,
    #[serde(default = "missing_credentials")]
    pub credential_status: String,
}

/// Never serialize or debug-print this input: it can contain credentials.
#[derive(Deserialize)]
pub struct AddStorageRequest {
    pub name: String,
    pub kind: String,
    pub endpoint: String,
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub bucket: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub access_key: Option<String>,
    #[serde(default)]
    pub secret_key: Option<String>,
    #[serde(default)]
    pub session_token: Option<String>,
    #[serde(default)]
    pub tls_certificate_sha256: Option<String>,
    #[serde(default = "remember_by_default")]
    pub remember_credentials: bool,
}

fn remember_by_default() -> bool {
    true
}
fn missing_credentials() -> String {
    "missing".into()
}

#[derive(Clone, Default, Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct Credentials {
    username: Option<String>,
    password: Option<String>,
    access_key: Option<String>,
    secret_key: Option<String>,
    session_token: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageEntry {
    pub key: String,
    pub size: u64,
    pub is_dir: bool,
}
#[derive(Debug, Serialize)]
pub struct BrowsePage {
    pub entries: Vec<StorageEntry>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct FetchResult {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct StorageCheck {
    pub id: String,
    pub connected: bool,
    pub credential_status: String,
    pub checked_at: String,
    pub error: Option<String>,
}

struct SourceState {
    credentials: Option<Credentials>,
    credential_status: String,
    connected: bool,
}

pub struct StorageRegistry {
    config_path: PathBuf,
    configs: Vec<StorageConfig>,
    states: Mutex<HashMap<String, SourceState>>,
    credential_store: Arc<dyn CredentialStore>,
    credential_scope: String,
    clients: Mutex<HashMap<String, reqwest::blocking::Client>>,
}

impl StorageRegistry {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_credential_store(data_dir, Arc::new(SystemCredentialStore::default()))
    }

    pub fn open_with_credential_store(
        data_dir: impl AsRef<Path>,
        credential_store: Arc<dyn CredentialStore>,
    ) -> Result<Self> {
        fs::create_dir_all(data_dir.as_ref())?;
        let canonical = fs::canonicalize(data_dir.as_ref())?;
        let credential_scope = hex::encode(Sha256::digest(canonical.to_string_lossy().as_bytes()));
        let config_path = data_dir.as_ref().join("storage.json");
        let mut configs: Vec<StorageConfig> = if config_path.exists() {
            serde_json::from_slice(&fs::read(&config_path)?)?
        } else {
            Vec::new()
        };
        let mut states = HashMap::new();
        for config in &mut configs {
            config.connected = false;
            let credential = environment_credentials(config);
            config.credential_status = if config.kind == "local" {
                "not_required"
            } else if credential.is_some() {
                "session"
            } else if config.remember_credentials {
                "system"
            } else {
                "missing"
            }
            .into();
            states.insert(
                config.id.clone(),
                SourceState {
                    credentials: credential,
                    credential_status: config.credential_status.clone(),
                    connected: false,
                },
            );
        }
        Ok(Self {
            config_path,
            configs,
            states: Mutex::new(states),
            credential_store,
            credential_scope,
            clients: Mutex::new(HashMap::new()),
        })
    }

    pub fn list(&self) -> Vec<StorageConfig> {
        let states = self.states.lock();
        self.configs
            .iter()
            .cloned()
            .map(|mut config| {
                if let Ok(states) = &states {
                    if let Some(state) = states.get(&config.id) {
                        config.connected = state.connected;
                        config.credential_status = state.credential_status.clone();
                    }
                } else {
                    config.connected = false;
                    config.credential_status = "unavailable".into();
                }
                config
            })
            .collect()
    }

    pub fn add(&mut self, request: AddStorageRequest) -> Result<StorageConfig> {
        if request.name.trim().is_empty() {
            bail!("Storage name is required");
        }
        let kind = request.kind.to_lowercase();
        if !["local", "webdav", "s3"].contains(&kind.as_str()) {
            bail!("Unsupported storage kind");
        }
        let root = request
            .root
            .unwrap_or_default()
            .trim_matches('/')
            .to_string();
        validate_key(&root, true)?;
        let endpoint = if kind == "local" {
            fs::canonicalize(&request.endpoint)
                .context("Local storage root is unavailable")?
                .to_string_lossy()
                .into_owned()
        } else {
            remote::validate_endpoint(&request.endpoint)?
                .to_string()
                .trim_end_matches('/')
                .to_string()
        };
        if kind == "local" && !safe_join(Path::new(&endpoint), &root, true)?.is_dir() {
            bail!("Local storage root must be a directory");
        }
        if kind == "s3" {
            let bucket = request.bucket.as_deref().unwrap_or("");
            if bucket.is_empty() || bucket.contains(['/', '\\', ':', '?', '#']) {
                bail!("A valid S3 bucket is required");
            }
        }
        // Reconnecting the same location retains its identity and does not accumulate duplicates.
        let previous = self
            .configs
            .iter()
            .find(|c| {
                c.kind == kind
                    && c.endpoint == endpoint
                    && c.root == root
                    && c.bucket == request.bucket
            })
            .cloned();
        let id = previous
            .as_ref()
            .map(|c| c.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let remember = kind != "local" && request.remember_credentials;
        let is_local = kind == "local";
        let config = StorageConfig {
            id: id.clone(),
            name: request.name.trim().to_string(),
            kind,
            endpoint,
            root,
            bucket: request.bucket,
            region: request.region,
            tls_certificate_sha256: transport::normalize_pin(
                request.tls_certificate_sha256.as_deref(),
            )?,
            connected: false,
            remember_credentials: remember,
            credential_status: if is_local {
                "not_required"
            } else if remember {
                "system"
            } else {
                "session"
            }
            .into(),
        };
        let credentials = if config.kind == "local" {
            Credentials::default()
        } else {
            let incoming = Credentials {
                username: request.username.filter(|v| !v.is_empty()),
                password: request.password.filter(|v| !v.is_empty()),
                access_key: request.access_key.filter(|v| !v.is_empty()),
                secret_key: request.secret_key.filter(|v| !v.is_empty()),
                session_token: request.session_token.filter(|v| !v.is_empty()),
            };
            let complete = if config.kind == "s3" {
                incoming.access_key.is_some() && incoming.secret_key.is_some()
            } else {
                incoming.username.is_some() && incoming.password.is_some()
            };
            let previous_credentials = previous
                .as_ref()
                .map(|old| self.credentials_for(old))
                .transpose();
            // Fully supplied replacement credentials can repair a missing/corrupt record.
            // Otherwise omitted fields must come from an actual available old record.
            let old = if complete {
                previous_credentials.unwrap_or(None)
            } else {
                previous_credentials?
            };
            merge_credentials(&config.kind, incoming, old)?
        };
        let client = if config.kind == "local" {
            if config.tls_certificate_sha256.is_some() {
                bail!("Certificate trust is only available for LAN HTTPS storage");
            }
            None
        } else {
            Some(transport::client(&config)?)
        };
        let mut configs = self.configs.clone();
        configs.retain(|c| c.id != id);
        configs.push(config.clone());
        let saved: Vec<_> = configs
            .iter()
            .cloned()
            .map(|mut c| {
                c.connected = false;
                c
            })
            .collect();
        // Persist the vault first, then settings. Restore the previous vault record if
        // either verification or settings publication fails, never claim a silent save.
        let touches_vault = config.kind != "local"
            && (remember || previous.as_ref().is_some_and(|c| c.remember_credentials));
        let key = self.credential_key(&config);
        if touches_vault {
            let prior = self
                .credential_store
                .load(&key)
                .context("Cannot update saved credentials")?;
            let desired = if remember {
                Some(credentials::encode(&credentials)?)
            } else {
                None
            };
            let operation = (|| -> Result<()> {
                match &desired {
                    Some(secret) => self
                        .credential_store
                        .save(&key, secret)
                        .context("Cannot save credentials securely")?,
                    None => self
                        .credential_store
                        .delete(&key)
                        .context("Cannot remove saved credentials")?,
                }
                let verified = self
                    .credential_store
                    .load(&key)
                    .context("Cannot verify the credential-store update")?;
                if verified.as_deref() != desired.as_deref() {
                    bail!("The system credential store did not retain the requested update");
                }
                atomic_json(&self.config_path, &saved)
            })();
            if let Err(error) = operation {
                let restored = match prior {
                    Some(secret) => self.credential_store.save(&key, &secret),
                    None => self.credential_store.delete(&key),
                };
                if restored.is_err() {
                    return Err(error.context("Saving storage failed and the previous credential record could not be restored; re-enter credentials before reconnecting"));
                }
                return Err(error);
            }
        } else {
            atomic_json(&self.config_path, &saved)?;
        }
        self.configs = configs;
        if let Some(client) = client {
            self.clients
                .get_mut()
                .map_err(|_| anyhow::anyhow!("Storage connection lock is unavailable"))?
                .insert(id.clone(), client);
        }
        self.states
            .get_mut()
            .map_err(|_| anyhow::anyhow!("Credential state is unavailable"))?
            .insert(
                id,
                SourceState {
                    credentials: Some(credentials),
                    credential_status: config.credential_status.clone(),
                    connected: false,
                },
            );
        Ok(config)
    }

    /// Unregister a source and its saved credentials. Never touches source files.
    /// The service must reject removal while a catalog library references it.
    pub fn remove(&mut self, id: &str) -> Result<StorageConfig> {
        let config = self.config(id)?.clone();
        // Detect poisoned process state before publishing a persistent change.
        self.states
            .get_mut()
            .map_err(|_| anyhow::anyhow!("Credential state is unavailable"))?;
        self.clients
            .get_mut()
            .map_err(|_| anyhow::anyhow!("Storage connection lock is unavailable"))?;
        let saved: Vec<_> = self
            .configs
            .iter()
            .filter(|entry| entry.id != id)
            .cloned()
            .map(|mut entry| {
                entry.connected = false;
                entry
            })
            .collect();
        if config.kind != "local" && config.remember_credentials {
            let key = self.credential_key(&config);
            let prior = self
                .credential_store
                .load(&key)
                .context("Cannot remove saved credentials")?;
            let operation = (|| -> Result<()> {
                self.credential_store
                    .delete(&key)
                    .context("Cannot remove saved credentials")?;
                if self.credential_store.load(&key)?.is_some() {
                    bail!("The system credential store did not remove the saved record");
                }
                atomic_json(&self.config_path, &saved)
            })();
            if let Err(error) = operation {
                let restored = match prior {
                    Some(secret) => self.credential_store.save(&key, &secret),
                    None => self.credential_store.delete(&key),
                };
                if restored.is_err() {
                    return Err(error.context("Removing storage failed and its credential record could not be restored; re-enter credentials before reconnecting"));
                }
                return Err(error);
            }
        } else {
            atomic_json(&self.config_path, &saved)?;
        }
        self.configs = saved;
        self.states
            .get_mut()
            .expect("state checked above")
            .remove(id);
        self.clients
            .get_mut()
            .expect("clients checked above")
            .remove(id);
        Ok(config)
    }

    fn config(&self, id: &str) -> Result<&StorageConfig> {
        let config = self
            .configs
            .iter()
            .find(|c| c.id == id)
            .context("Storage does not exist")?;
        Ok(config)
    }

    fn credential_key(&self, config: &StorageConfig) -> String {
        // A copied ID or edited endpoint cannot reuse another profile/location's secrets.
        let identity = serde_json::to_vec(&(
            &self.credential_scope,
            &config.id,
            &config.kind,
            &config.endpoint,
            &config.root,
            &config.bucket,
        ))
        .expect("String tuple is serializable");
        hex::encode(Sha256::digest(identity))
    }

    fn credentials_for(&self, config: &StorageConfig) -> Result<Credentials> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| anyhow::anyhow!("Credential state is unavailable"))?;
        let state = states
            .get_mut(&config.id)
            .context("Storage credential state is unavailable")?;
        if let Some(credentials) = &state.credentials {
            return Ok(credentials.clone());
        }
        if !config.remember_credentials {
            state.credential_status = "missing".into();
            bail!("Credentials are missing; reconnect this storage and choose system credential storage to restore it after restart");
        }
        let loaded = self.credential_store.load(&self.credential_key(config));
        match loaded {
            Ok(Some(secret)) => match credentials::decode(&secret) {
                Ok(credentials) if credentials_valid(&config.kind, &credentials) => {
                    state.credential_status = "system".into();
                    state.credentials = Some(credentials.clone());
                    Ok(credentials)
                }
                _ => {
                    state.credential_status = "unavailable".into();
                    Err(CredentialStoreError::InvalidRecord.into())
                }
            },
            Ok(None) => {
                state.credential_status = "missing".into();
                bail!("Saved credentials were not found in the system credential store; enter them again");
            }
            Err(error) => {
                state.credential_status = "unavailable".into();
                Err(error.into())
            }
        }
    }

    fn connection_result(&self, id: &str, connected: bool) {
        if let Ok(mut states) = self.states.lock() {
            if let Some(state) = states.get_mut(id) {
                state.connected = connected;
            }
        }
    }

    pub fn local_root(&self, id: &str, prefix: &str) -> Result<PathBuf> {
        let config = self.config(id)?;
        if config.kind != "local" {
            bail!("This source is not local storage");
        }
        let root = safe_join(Path::new(&config.endpoint), &config.root, true)?;
        let directory = safe_join(&root, prefix, true)?;
        if !directory.is_dir() {
            bail!("The local source path is not a directory");
        }
        Ok(directory)
    }

    pub fn check(&self, id: &str) -> Result<StorageCheck> {
        self.config(id)?;
        let result = self.browse(id, "", 1, None);
        let config = self
            .list()
            .into_iter()
            .find(|config| config.id == id)
            .context("Storage does not exist")?;
        Ok(StorageCheck {
            id: id.into(),
            connected: result.is_ok(),
            credential_status: config.credential_status,
            checked_at: chrono::Utc::now().to_rfc3339(),
            error: result.err().map(|error| format!("{error:#}")),
        })
    }

    fn client(&self, config: &StorageConfig) -> Result<reqwest::blocking::Client> {
        let mut clients = self
            .clients
            .lock()
            .map_err(|_| anyhow::anyhow!("Storage connection lock is unavailable"))?;
        if let Some(client) = clients.get(&config.id) {
            return Ok(client.clone());
        }
        // Opening the registry is offline, including when environment credentials exist.
        // Resolve and freeze LAN addresses only upon the first actual remote operation.
        let client = transport::client(config)?;
        clients.insert(config.id.clone(), client.clone());
        Ok(client)
    }

    pub fn browse(
        &self,
        id: &str,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<BrowsePage> {
        let result = self.browse_inner(id, prefix, limit, cursor);
        self.connection_result(id, result.is_ok());
        result
    }

    fn browse_inner(
        &self,
        id: &str,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<BrowsePage> {
        validate_key(prefix, true)?;
        let config = self.config(id)?;
        let limit = limit.clamp(1, 1000);
        if config.kind != "local" {
            let credentials = self.credentials_for(config)?;
            return remote::browse(
                &self.client(config)?,
                config,
                &credentials,
                prefix,
                limit,
                cursor,
            );
        }
        let root = safe_join(Path::new(&config.endpoint), &config.root, true)?;
        let directory = safe_join(&root, prefix, true)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() || safe::is_reparse(&metadata) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let key = if prefix.is_empty() {
                name
            } else {
                format!("{}/{name}", prefix.trim_end_matches('/'))
            };
            if validate_key(&key, false).is_ok() {
                entries.push(StorageEntry {
                    key,
                    size: metadata.len(),
                    is_dir: metadata.is_dir(),
                });
            }
        }
        entries.sort_by(|a, b| a.key.cmp(&b.key));
        if let Some(cursor) = cursor {
            entries.retain(|e| e.key.as_str() > cursor);
        }
        let more = entries.len() > limit;
        entries.truncate(limit);
        let next_cursor = if more {
            entries.last().map(|e| e.key.clone())
        } else {
            None
        };
        Ok(BrowsePage {
            entries,
            next_cursor,
        })
    }

    pub fn reader(&self, id: &str, key: &str) -> Result<Box<dyn Read>> {
        let result = self.reader_inner(id, key);
        self.connection_result(id, result.is_ok());
        result
    }

    fn reader_inner(&self, id: &str, key: &str) -> Result<Box<dyn Read>> {
        validate_key(key, false)?;
        let config = self.config(id)?;
        if config.kind == "local" {
            let root = safe_join(Path::new(&config.endpoint), &config.root, true)?;
            return Ok(Box::new(open_scoped(&root, key)?));
        }
        let credentials = self.credentials_for(config)?;
        remote::reader(&self.client(config)?, config, &credentials, key)
    }

    pub fn fetch(&self, id: &str, key: &str, destination: impl AsRef<Path>) -> Result<FetchResult> {
        let mut reader = self.reader(id, key)?;
        let (size, sha256) = publish_reader(&mut reader, destination.as_ref(), None)?;
        Ok(FetchResult {
            path: destination.as_ref().to_string_lossy().into_owned(),
            size,
            sha256,
        })
    }
}

fn credentials_valid(kind: &str, credentials: &Credentials) -> bool {
    if kind == "webdav" {
        return credentials.username.is_some() || credentials.password.is_none();
    }
    kind != "s3"
        || (credentials
            .access_key
            .as_deref()
            .is_some_and(|v| !v.is_empty())
            && credentials
                .secret_key
                .as_deref()
                .is_some_and(|v| !v.is_empty()))
}

fn merge_credentials(
    kind: &str,
    mut incoming: Credentials,
    old: Option<Credentials>,
) -> Result<Credentials> {
    if let Some(old) = old {
        if kind == "webdav"
            && incoming.username.is_some()
            && incoming.username != old.username
            && incoming.password.is_none()
        {
            bail!("Changing the WebDAV username requires its password");
        }
        if kind == "s3"
            && incoming.access_key.is_some()
            && incoming.access_key != old.access_key
            && incoming.secret_key.is_none()
        {
            bail!("Changing the S3 access key requires its secret key");
        }
        if incoming.username.is_none() {
            incoming.username = old.username.clone();
        }
        if incoming.password.is_none() {
            incoming.password = old.password.clone();
        }
        if incoming.access_key.is_none() {
            incoming.access_key = old.access_key.clone();
        }
        if incoming.secret_key.is_none() {
            incoming.secret_key = old.secret_key.clone();
        }
        if incoming.session_token.is_none() && incoming.access_key == old.access_key {
            incoming.session_token = old.session_token.clone();
        }
    }
    if !credentials_valid(kind, &incoming) {
        if kind == "webdav" {
            bail!("A WebDAV username is required when supplying a password");
        }
        bail!("S3 access key and secret key are required");
    }
    Ok(incoming)
}

fn environment_credentials(config: &StorageConfig) -> Option<Credentials> {
    let prefix = format!(
        "NEBULUME_STORAGE_{}_",
        config.id.replace('-', "_").to_ascii_uppercase()
    );
    let read = |name: &str| {
        std::env::var(format!("{prefix}{name}"))
            .ok()
            .filter(|v| !v.is_empty())
    };
    let credentials = Credentials {
        username: read("USERNAME"),
        password: read("PASSWORD"),
        access_key: read("ACCESS_KEY"),
        secret_key: read("SECRET_KEY"),
        session_token: read("SESSION_TOKEN"),
    };
    if (config.kind == "s3" && credentials.access_key.is_some() && credentials.secret_key.is_some())
        || (config.kind == "webdav"
            && (credentials.username.is_some() || read("ANONYMOUS").as_deref() == Some("1")))
    {
        Some(credentials)
    } else {
        None
    }
}
