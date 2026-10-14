//! Read-only storage adapters and non-overwriting local publication.
mod remote;
mod safe;
mod transport;

pub use transport::{inspect_tls, TlsCertificateInfo};

pub use safe::{
    atomic_json, hash_reader, open_scoped, publish_reader, safe_join, validate_key,
    PreparedDestination, ScopedDestination,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

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
    /// False after restart until credentials are supplied again.
    #[serde(default)]
    pub connected: bool,
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
}

#[derive(Clone, Default)]
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

pub struct StorageRegistry {
    config_path: PathBuf,
    configs: Vec<StorageConfig>,
    credentials: HashMap<String, Credentials>,
    clients: Mutex<HashMap<String, reqwest::blocking::Client>>,
}

impl StorageRegistry {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(data_dir.as_ref())?;
        let config_path = data_dir.as_ref().join("storage.json");
        let mut configs: Vec<StorageConfig> = if config_path.exists() {
            serde_json::from_slice(&fs::read(&config_path)?)?
        } else {
            Vec::new()
        };
        let mut credentials = HashMap::new();
        for config in &mut configs {
            config.connected = config.kind == "local";
            if let Some(credential) = environment_credentials(config) {
                config.connected = true;
                credentials.insert(config.id.clone(), credential);
            }
        }
        Ok(Self {
            config_path,
            configs,
            credentials,
            clients: Mutex::new(HashMap::new()),
        })
    }

    pub fn list(&self) -> Vec<StorageConfig> {
        self.configs.clone()
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
            if request.access_key.as_deref().unwrap_or("").is_empty()
                || request.secret_key.as_deref().unwrap_or("").is_empty()
            {
                bail!("S3 access key and secret key are required");
            }
        }
        // Reconnecting the same location retains its identity and does not accumulate duplicates.
        let id = self
            .configs
            .iter()
            .find(|c| {
                c.kind == kind
                    && c.endpoint == endpoint
                    && c.root == root
                    && c.bucket == request.bucket
            })
            .map(|c| c.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
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
            connected: true,
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
        atomic_json(&self.config_path, &saved)?;
        self.configs = configs;
        if let Some(client) = client {
            self.clients
                .get_mut()
                .map_err(|_| anyhow::anyhow!("Storage connection lock is unavailable"))?
                .insert(id.clone(), client);
        }
        self.credentials.insert(
            id,
            Credentials {
                username: request.username,
                password: request.password,
                access_key: request.access_key,
                secret_key: request.secret_key,
                session_token: request.session_token,
            },
        );
        Ok(config)
    }

    fn config(&self, id: &str) -> Result<&StorageConfig> {
        let config = self
            .configs
            .iter()
            .find(|c| c.id == id)
            .context("Storage does not exist")?;
        if !config.connected {
            bail!("Reconnect this storage: credentials are kept in memory only");
        }
        Ok(config)
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
        validate_key(prefix, true)?;
        let config = self.config(id)?;
        let limit = limit.clamp(1, 1000);
        if config.kind != "local" {
            return remote::browse(
                &self.client(config)?,
                config,
                self.credentials.get(id).unwrap_or(&Credentials::default()),
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
        validate_key(key, false)?;
        let config = self.config(id)?;
        if config.kind == "local" {
            let root = safe_join(Path::new(&config.endpoint), &config.root, true)?;
            return Ok(Box::new(open_scoped(&root, key)?));
        }
        remote::reader(
            &self.client(config)?,
            config,
            self.credentials.get(id).unwrap_or(&Credentials::default()),
            key,
        )
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
