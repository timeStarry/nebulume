//! Independent browse snapshot. It never holds a StorageRegistry lock while
//! resolving a remote endpoint, issuing HTTP, or enumerating a local directory.
use crate::{
    remote, safe, safe_join, transport, validate_key, BrowsePage, Credentials, StorageCheck,
    StorageConfig, StorageEntry,
};
use anyhow::Result;
use reqwest::blocking::Client;
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

/// Private connection/credential snapshot. Intentionally does not implement
/// Debug or Serialize, because it owns authentication material.
pub struct StorageBrowser {
    config: StorageConfig,
    credentials: Credentials,
    client: Mutex<Option<Client>>,
    connected: Arc<AtomicBool>,
}
impl StorageBrowser {
    pub(crate) fn new(
        config: StorageConfig,
        credentials: Credentials,
        client: Option<Client>,
        connected: Arc<AtomicBool>,
    ) -> Self {
        Self {
            config,
            credentials,
            client: Mutex::new(client),
            connected,
        }
    }

    /// Starts remote/local I/O here, after the registry lock has been released.
    pub fn browse(&self, prefix: &str, limit: usize, cursor: Option<&str>) -> Result<BrowsePage> {
        let result = self.browse_inner(prefix, limit, cursor);
        self.connected.store(result.is_ok(), Ordering::Relaxed);
        result
    }

    /// Performs the same authenticated one-entry probe as registry.check,
    /// while all network work remains outside the registry lock.
    pub fn check(&self) -> Result<StorageCheck> {
        let result = self.browse("", 1, None);
        Ok(StorageCheck {
            id: self.config.id.clone(),
            connected: result.is_ok(),
            credential_status: self.config.credential_status.clone(),
            checked_at: chrono::Utc::now().to_rfc3339(),
            error: result.err().map(|error| format!("{error:#}")),
        })
    }

    fn browse_inner(&self, prefix: &str, limit: usize, cursor: Option<&str>) -> Result<BrowsePage> {
        validate_key(prefix, true)?;
        let limit = limit.clamp(1, 1000);
        if self.config.kind != "local" {
            let client = {
                let mut slot = self
                    .client
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Storage snapshot connection is unavailable"))?;
                if slot.is_none() {
                    *slot = Some(transport::client(&self.config)?);
                }
                slot.as_ref().expect("client initialized above").clone()
            };
            return remote::browse(
                &client,
                &self.config,
                &self.credentials,
                prefix,
                limit,
                cursor,
            );
        }
        let root = safe_join(Path::new(&self.config.endpoint), &self.config.root, true)?;
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
                    created_at: metadata.created().ok().map(|created| {
                        chrono::DateTime::<chrono::Utc>::from(created)
                            .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
                    }),
                });
            }
        }
        entries.sort_by(|left, right| left.key.cmp(&right.key));
        if let Some(cursor) = cursor {
            entries.retain(|entry| entry.key.as_str() > cursor);
        }
        let more = entries.len() > limit;
        entries.truncate(limit);
        let next_cursor = if more {
            entries.last().map(|entry| entry.key.clone())
        } else {
            None
        };
        Ok(BrowsePage {
            entries,
            next_cursor,
        })
    }
}
