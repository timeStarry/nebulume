//! Non-overwriting publication to WebDAV and S3.
//!
//! A write either lands at a key that did not exist, verified against the planned
//! SHA-256, or fails without touching existing content. A server that cannot
//! guarantee "do not overwrite" is refused rather than written to best-effort.
use crate::{
    availability::{classify, Availability, AvailabilityCell},
    hash_reader, remote, validate_key, Credentials, StorageConfig,
};
use anyhow::{bail, ensure, Result};
use reqwest::{
    blocking::{Body, Client, RequestBuilder},
    Method, StatusCode,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Cursor, Read},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
};
use uuid::Uuid;

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// S3 single-request upload limit.
const S3_SINGLE_PUT_LIMIT: u64 = 5 * 1024 * 1024 * 1024;

/// Whether a location has passed the explicit write test in this process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum WriteCapability {
    Unverified = 0,
    Verified = 1,
    Unsupported = 2,
}

impl WriteCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unverified => "unverified",
            Self::Verified => "verified",
            Self::Unsupported => "unsupported",
        }
    }
    pub(crate) fn load(cell: &AtomicU8) -> Self {
        match cell.load(Ordering::Relaxed) {
            1 => Self::Verified,
            2 => Self::Unsupported,
            _ => Self::Unverified,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct WriteCheck {
    pub id: String,
    pub write_capability: String,
    pub error: Option<String>,
    /// Test object that could not be removed, if any; reported, never hidden.
    pub leftover: Option<String>,
    pub checked_at: String,
}

/// Private connection snapshot for writing. Like `StorageBrowser`, it owns
/// credentials, so it implements neither Debug nor Serialize.
pub struct RemoteWriter {
    config: StorageConfig,
    credentials: Credentials,
    client: Client,
    availability: Arc<AvailabilityCell>,
    capability: Arc<AtomicU8>,
    collections: Mutex<HashSet<String>>,
}

fn code(error: &anyhow::Error) -> bool {
    let text = format!("{error:#}");
    ["E_CONFLICT", "E_VERIFY", "E_LIMIT", "E_UNSUPPORTED"]
        .iter()
        .any(|code| text.contains(code))
}

impl RemoteWriter {
    pub(crate) fn new(
        config: StorageConfig,
        credentials: Credentials,
        client: Client,
        availability: Arc<AvailabilityCell>,
        capability: Arc<AtomicU8>,
    ) -> Self {
        Self {
            config,
            credentials,
            client,
            availability,
            capability,
            collections: Mutex::new(HashSet::new()),
        }
    }

    pub fn location_id(&self) -> &str {
        &self.config.id
    }

    pub fn capability(&self) -> WriteCapability {
        WriteCapability::load(&self.capability)
    }

    /// Conflicts and verification failures are about content, not connectivity.
    fn track<T>(&self, result: Result<T>) -> Result<T> {
        match &result {
            Ok(_) => self.availability.set(Availability::Online),
            Err(error) if !code(error) => self.availability.set(classify(error)),
            Err(_) => {}
        }
        result
    }

    fn dav(&self, method: Method, key: &str) -> Result<RequestBuilder> {
        Ok(remote::dav_request(
            &self.client,
            &self.credentials,
            method,
            remote::url_for(&self.config, key)?,
        ))
    }

    fn s3(&self, method: Method, key: &str, payload: &str) -> Result<RequestBuilder> {
        remote::s3_signed(
            &self.client,
            &self.credentials,
            &self.config,
            method,
            remote::url_for(&self.config, key)?,
            &[],
            payload,
        )
    }

    pub fn exists(&self, key: &str) -> Result<bool> {
        validate_key(key, false)?;
        self.track((|| {
            let request = if self.config.kind == "s3" {
                self.s3(Method::HEAD, key, EMPTY_SHA256)?
            } else {
                self.dav(Method::HEAD, key)?
            };
            let response = request.send()?;
            match response.status() {
                status if status.is_success() => Ok(true),
                StatusCode::NOT_FOUND => Ok(false),
                status => bail!("Storage request failed with HTTP {}", status.as_u16()),
            }
        })())
    }

    /// Publish `body` at `key` only if nothing is there. `sha256` is the planned
    /// hash; the server (S3) or a read-back (WebDAV) must confirm it.
    pub fn put_new<R: Read + Send + 'static>(
        &self,
        key: &str,
        body: R,
        size: u64,
        sha256: &str,
    ) -> Result<()> {
        validate_key(key, false)?;
        ensure!(
            sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "E_INVALID: A SHA-256 is required for remote publication"
        );
        self.track(match self.config.kind.as_str() {
            "webdav" => self.dav_put_new(key, body, size, sha256),
            "s3" => self.s3_put_new(key, body, size, sha256),
            _ => bail!("E_UNSUPPORTED: Only WebDAV and S3 locations accept remote writes"),
        })
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        validate_key(key, false)?;
        self.track((|| {
            let request = if self.config.kind == "s3" {
                self.s3(Method::DELETE, key, EMPTY_SHA256)?
            } else {
                self.dav(Method::DELETE, key)?
            };
            let status = request.send()?.status();
            ensure!(
                status.is_success() || status == StatusCode::NOT_FOUND,
                "Storage request failed with HTTP {}",
                status.as_u16()
            );
            Ok(())
        })())
    }

    fn dav_collections(&self, directory: &str) -> Result<()> {
        let mut prefix = String::new();
        for part in directory.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if self
                .collections
                .lock()
                .map_err(|_| anyhow::anyhow!("Writer state is unavailable"))?
                .contains(&prefix)
            {
                continue;
            }
            let status = self
                .dav(Method::from_bytes(b"MKCOL")?, &prefix)?
                .send()?
                .status();
            // 405 means the collection already exists.
            ensure!(
                status.is_success() || status == StatusCode::METHOD_NOT_ALLOWED,
                "Cannot create folder {prefix}: HTTP {}",
                status.as_u16()
            );
            self.collections
                .lock()
                .map_err(|_| anyhow::anyhow!("Writer state is unavailable"))?
                .insert(prefix.clone());
        }
        Ok(())
    }

    fn dav_put_new<R: Read + Send + 'static>(
        &self,
        key: &str,
        body: R,
        size: u64,
        sha256: &str,
    ) -> Result<()> {
        let parent = key.rsplit_once('/').map(|(parent, _)| parent);
        if let Some(parent) = parent {
            self.dav_collections(parent)?;
        }
        let name = format!(".nebulume-{}.part", Uuid::new_v4());
        let temporary = match parent {
            Some(parent) => format!("{parent}/{name}"),
            None => name,
        };
        let uploaded = self
            .dav(Method::PUT, &temporary)?
            .header("If-None-Match", "*")
            .body(Body::sized(body, size))
            .send()?;
        if !uploaded.status().is_success() {
            bail!(
                "Storage request failed with HTTP {}",
                uploaded.status().as_u16()
            );
        }
        let outcome = (|| -> Result<()> {
            let response = remote::checked(self.dav(Method::GET, &temporary)?.send()?)?;
            let (read, hash) = hash_reader(&mut response.take(size + 1))?;
            ensure!(
                read == size && hash == sha256,
                "E_VERIFY: The uploaded file did not read back intact"
            );
            let destination = remote::url_for(&self.config, key)?;
            let moved = self
                .dav(Method::from_bytes(b"MOVE")?, &temporary)?
                .header("Destination", destination.as_str())
                .header("Overwrite", "F")
                .send()?;
            match moved.status() {
                status if status.is_success() => Ok(()),
                StatusCode::PRECONDITION_FAILED => {
                    bail!("E_CONFLICT: {key} already exists on the server")
                }
                status => bail!("Storage request failed with HTTP {}", status.as_u16()),
            }
        })();
        if outcome.is_err() {
            // Best effort: a leftover .part file never replaces anything.
            if let Ok(request) = self.dav(Method::DELETE, &temporary) {
                let _ = request.send();
            }
        }
        outcome
    }

    fn s3_put_new<R: Read + Send + 'static>(
        &self,
        key: &str,
        body: R,
        size: u64,
        sha256: &str,
    ) -> Result<()> {
        ensure!(
            size <= S3_SINGLE_PUT_LIMIT,
            "E_LIMIT: Files over 5 GiB need multipart upload, which is not supported yet"
        );
        // The signature covers the planned hash, so the server rejects any other body.
        let response = self
            .s3(Method::PUT, key, sha256)?
            .header("If-None-Match", "*")
            .body(Body::sized(body, size))
            .send()?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let text = response.text().unwrap_or_default();
        match status {
            StatusCode::PRECONDITION_FAILED | StatusCode::CONFLICT => {
                bail!("E_CONFLICT: {key} already exists on the server")
            }
            StatusCode::NOT_IMPLEMENTED => {
                bail!("E_UNSUPPORTED: This S3 service does not support conditional writes")
            }
            StatusCode::BAD_REQUEST if text.contains("NotImplemented") => {
                bail!("E_UNSUPPORTED: This S3 service does not support conditional writes")
            }
            StatusCode::BAD_REQUEST
                if text.contains("XAmzContentSHA256Mismatch") || text.contains("BadDigest") =>
            {
                bail!("E_VERIFY: The server received different bytes than planned")
            }
            _ => bail!("Storage request failed with HTTP {}", status.as_u16()),
        }
    }

    /// Explicit write test: publish a small object, prove a second write to the same
    /// key is refused, then remove it. Records the result for this process.
    pub fn probe(&self) -> WriteCheck {
        let key = format!(".nebulume-write-test-{}.txt", Uuid::new_v4());
        let first = b"nebulume write test\n".to_vec();
        let second = b"nebulume overwrite attempt\n".to_vec();
        let hash = |bytes: &[u8]| hex::encode(Sha256::digest(bytes));
        let mut published = false;
        let result = (|| -> Result<()> {
            self.put_new(
                &key,
                Cursor::new(first.clone()),
                first.len() as u64,
                &hash(&first),
            )?;
            published = true;
            match self.put_new(
                &key,
                Cursor::new(second.clone()),
                second.len() as u64,
                &hash(&second),
            ) {
                Err(error) if format!("{error:#}").contains("E_CONFLICT") => Ok(()),
                Ok(()) => bail!(
                    "E_UNSUPPORTED: The server replaced an existing file; Nebulume will not import here"
                ),
                Err(error) => Err(error),
            }
        })();
        let leftover = (published && self.delete(&key).is_err()).then(|| key.clone());
        let capability = match &result {
            Ok(()) => WriteCapability::Verified,
            Err(error) if format!("{error:#}").contains("E_UNSUPPORTED") => {
                WriteCapability::Unsupported
            }
            Err(_) => WriteCapability::Unverified,
        };
        self.capability.store(capability as u8, Ordering::Relaxed);
        WriteCheck {
            id: self.config.id.clone(),
            write_capability: capability.as_str().into(),
            error: result.err().map(|error| format!("{error:#}")),
            leftover,
            checked_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
