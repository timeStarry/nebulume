//! Shared application commands for the native desktop and headless CLI.
use anyhow::{anyhow, ensure, Context, Result};
use neb_core::{Asset, Core, Library};
use neb_ingest::IngestService;
use neb_storage::{AddStorageRequest, StorageConfig, StorageRegistry};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub struct Service {
    core: Core,
    storage: Mutex<StorageRegistry>,
    ingest: Mutex<IngestService>,
    cache_root: PathBuf,
    cache_operations: Mutex<()>,
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<anyhow::Error> for CommandError {
    fn from(error: anyhow::Error) -> Self {
        let message = format!("{error:#}");
        let code = [
            "E_INVALID",
            "E_OFFLINE",
            "E_LIMIT",
            "E_UNSUPPORTED_CODEC",
            "E_NOT_FOUND",
            "E_CONFLICT",
        ]
        .into_iter()
        .find(|code| message.starts_with(code))
        .unwrap_or("E_OPERATION");
        Self { code, message }
    }
}

fn string<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| anyhow!("Missing or invalid parameter: {name}"))
}

impl Service {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        let data_dir = data_dir.as_ref();
        std::fs::create_dir_all(data_dir).context("Create application data directory")?;
        let service = Self {
            core: Core::open(data_dir.join("catalog"))?,
            storage: Mutex::new(StorageRegistry::open(data_dir.join("storage"))?),
            ingest: Mutex::new(IngestService::open(data_dir.join("ingest"))?),
            cache_root: data_dir.join("remote-cache"),
            cache_operations: Mutex::new(()),
        };
        // Associate legacy local libraries without making unavailable volumes prevent startup.
        for library in service.core.libraries()? {
            if library.storage_id.is_none() && Path::new(&library.root).is_dir() {
                let request: AddStorageRequest = serde_json::from_value(
                    json!({"name":library.name,"kind":"local","endpoint":library.root,"remember_credentials":false}),
                )?;
                let source = service
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?
                    .add(request)?;
                service.core.bind_storage(&library.id, &source.id, "")?;
            }
        }
        Ok(service)
    }

    pub fn execute(&self, command: &str, params: Value) -> Result<Value, CommandError> {
        if !params.is_object() {
            return Err(CommandError {
                code: "E_INVALID_PARAMS",
                message: "params must be a JSON object".into(),
            });
        }
        self.dispatch(command, params).map_err(Into::into)
    }

    fn source(&self, id: &str) -> Result<StorageConfig> {
        self.storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .list()
            .into_iter()
            .find(|source| source.id == id)
            .context("E_NOT_FOUND: Storage source does not exist")
    }

    fn library_value(&self, library: &Library) -> Result<Value> {
        let mut value = serde_json::to_value(library)?;
        let source = library
            .storage_id
            .as_deref()
            .map(|id| self.source(id))
            .transpose()?;
        value["source_kind"] = json!(source.as_ref().map(|s| s.kind.as_str()).unwrap_or("local"));
        value["source_name"] = json!(source
            .as_ref()
            .map(|s| s.name.as_str())
            .unwrap_or("本地目录"));
        value["source_endpoint"] = json!(source
            .as_ref()
            .map(|s| s.endpoint.as_str())
            .unwrap_or(&library.root));
        value["connected"] = json!(source
            .as_ref()
            .map(|s| if s.kind == "local" {
                Path::new(&library.root).is_dir()
            } else {
                s.connected
            })
            .unwrap_or_else(|| Path::new(&library.root).is_dir()));
        Ok(value)
    }

    fn library_list(&self) -> Result<Value> {
        self.core
            .libraries()?
            .iter()
            .map(|library| self.library_value(library))
            .collect::<Result<Vec<_>>>()
            .map(|libraries| json!(libraries))
    }

    fn add_library(&self, params: &Value) -> Result<Value> {
        let name = string(params, "name")?;
        let source = if let Some(id) = params.get("storage_id").and_then(Value::as_str) {
            self.source(id)?
        } else {
            let root = string(params, "root")?;
            let request: AddStorageRequest = serde_json::from_value(
                json!({"name":name,"kind":"local","endpoint":root,"remember_credentials":false}),
            )?;
            self.storage
                .lock()
                .map_err(|_| anyhow!("Storage state unavailable"))?
                .add(request)?
        };
        let prefix = params
            .get("prefix")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_end_matches('/');
        neb_storage::validate_key(prefix, true)?;
        if let Some(library) = self.core.libraries()?.into_iter().find(|library| {
            library.storage_id.as_deref() == Some(&source.id) && library.source_prefix == prefix
        }) {
            return self.library_value(&library);
        }
        let root = if source.kind == "local" {
            self.storage
                .lock()
                .map_err(|_| anyhow!("Storage state unavailable"))?
                .local_root(&source.id, prefix)?
        } else {
            let root = self
                .cache_root
                .join(&source.id)
                .join(hex::encode(Sha256::digest(prefix.as_bytes())));
            fs::create_dir_all(&root).context("E_IO: Cannot create remote library cache")?;
            root
        };
        let library = self.core.add_library(name, &root)?;
        let library = self.core.bind_storage(&library.id, &source.id, prefix)?;
        self.library_value(&library)
    }

    fn scan_library(&self, id: &str) -> Result<Value> {
        let library = self.core.library(id)?;
        let Some(source_id) = library.storage_id.as_deref() else {
            return self.core.dispatch("library.scan", json!({"library_id":id}));
        };
        let source = self.source(source_id)?;
        if source.kind == "local" {
            return self.core.dispatch("library.scan", json!({"library_id":id}));
        }
        let storage = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?;
        let mut pending = VecDeque::from([library.source_prefix.clone()]);
        let mut seen = HashSet::new();
        let mut keys = Vec::new();
        let mut indexed = 0usize;
        let mut skipped = 0usize;
        let mut entries_seen = 0usize;
        let mut pages_seen = 0usize;
        let mut errors = Vec::new();
        while let Some(prefix) = pending.pop_front() {
            if !seen.insert(prefix.clone()) {
                continue;
            }
            ensure!(
                seen.len() <= 2048,
                "E_LIMIT: Remote scan exceeds 2048 directories; choose a smaller library folder"
            );
            let mut cursor = None;
            let mut cursors = HashSet::new();
            loop {
                pages_seen += 1;
                ensure!(pages_seen<=4096,"E_LIMIT: Remote scan exceeds 4096 pages; partial index retained, missing state unchanged");
                let page = match storage.browse(source_id, &prefix, 1000, cursor.as_deref()) {
                    Ok(page) => page,
                    Err(error) if indexed > 0 => {
                        errors.push(json!({"path":prefix,"message":format!("{error:#}")}));
                        return Ok(
                            json!({"indexed":indexed,"skipped":skipped,"errors":errors,"partial":true,"source_kind":source.kind,"cached_on_demand":true}),
                        );
                    }
                    Err(error) => return Err(error),
                };
                for entry in page.entries {
                    entries_seen += 1;
                    ensure!(entries_seen<=50_000,"E_LIMIT: Remote scan exceeds 50000 entries; choose a smaller library folder");
                    neb_storage::validate_key(&entry.key, false)?;
                    ensure!(
                        library.source_prefix.is_empty()
                            || entry
                                .key
                                .starts_with(&format!("{}/", library.source_prefix)),
                        "E_PATH: Remote entry escaped the library folder"
                    );
                    if entry.is_dir {
                        pending.push_back(entry.key);
                        continue;
                    }
                    let extension = Path::new(&entry.key)
                        .extension()
                        .and_then(|v| v.to_str())
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    if neb_core::image_kind(&extension).is_none() {
                        skipped += 1;
                        continue;
                    }
                    let cache_name = format!(
                        "{}.{}",
                        hex::encode(Sha256::digest(
                            format!("{}:{}", entry.key, entry.size).as_bytes()
                        )),
                        extension
                    );
                    match self
                        .core
                        .register_remote_asset(id, &entry.key, &cache_name, entry.size)
                    {
                        Ok(_) => {
                            indexed += 1;
                            keys.push(entry.key);
                        }
                        Err(error) => {
                            errors.push(json!({"path":entry.key,"message":format!("{error:#}")}))
                        }
                    }
                }
                let Some(next) = page.next_cursor else {
                    break;
                };
                ensure!(
                    cursors.insert(next.clone()),
                    "E_PROTOCOL: Remote server repeated a pagination cursor"
                );
                cursor = Some(next);
            }
        }
        // Only a fully completed enumeration can mark remote entries missing.
        if errors.is_empty() {
            self.core.finish_remote_scan(id, &keys)?;
        }
        Ok(
            json!({"indexed":indexed,"skipped":skipped,"errors":errors,"source_kind":source.kind,"cached_on_demand":true}),
        )
    }

    fn materialize_asset(&self, id: &str, force: bool) -> Result<Asset> {
        let _cache = self
            .cache_operations
            .lock()
            .map_err(|_| anyhow!("Cache state unavailable"))?;
        let asset = self.core.asset(id)?;
        let Some(key) = asset.source_key.as_deref() else {
            if force {
                self.core.invalidate_asset(id)?;
            }
            return if force || Path::new(&asset.path).is_file() {
                // Inspection versions and changed originals update on access.
                // Missing local files can still expose their stored metadata;
                // rendering retains the core's canonical path/offline guards.
                self.core.refresh_asset(id)
            } else {
                Ok(asset)
            };
        };
        let library = self.core.library(&asset.library_id)?;
        let source_id = library
            .storage_id
            .as_deref()
            .context("E_NOT_FOUND: Remote library has no storage source")?;
        let cache_name = Path::new(&asset.path)
            .file_name()
            .and_then(|v| v.to_str())
            .context("E_PATH: Invalid cache path")?;
        let cache_path = neb_storage::safe_join(Path::new(&library.root), cache_name, false)?;
        ensure!(
            Path::new(&asset.path).parent() == Some(Path::new(&library.root)),
            "E_PATH: Image cache escaped its library"
        );
        if force || !cache_path.exists() {
            ensure!(
                asset.size <= 512 * 1024 * 1024,
                "E_LIMIT: Remote image exceeds the 512 MiB limit"
            );
            let storage = self
                .storage
                .lock()
                .map_err(|_| anyhow!("Storage state unavailable"))?;
            let reader = storage.reader(source_id, key)?;
            // Fail publication on overflow rather than storing a truncated original.
            let mut reader = BoundedImageReader {
                inner: reader,
                remaining: 512 * 1024 * 1024,
            };
            let destination =
                neb_storage::PreparedDestination::new(Path::new(&library.root))?.materialize()?;
            let refreshed_name = if force {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos();
                format!(
                    "{}.{}",
                    hex::encode(Sha256::digest(
                        format!("{key}:{stamp}:{}", std::process::id()).as_bytes()
                    )),
                    asset.extension
                )
            } else {
                cache_name.to_string()
            };
            destination.publish(&mut reader, &refreshed_name, None)?;
            if force {
                self.core.use_refreshed_cache(id, &refreshed_name)?;
            }
        }
        self.core.refresh_asset(id)
    }

    fn dispatch(&self, command: &str, params: Value) -> Result<Value> {
        if command == "asset.refresh" {
            return Ok(serde_json::to_value(
                self.materialize_asset(string(&params, "id")?, true)?,
            )?);
        }
        if [
            "asset.get",
            "asset.preview",
            "asset.histogram",
            "asset.export",
        ]
        .contains(&command)
        {
            self.materialize_asset(string(&params, "id")?, false)?;
        }
        if command.starts_with("asset.") || command == "file.open" {
            return self.core.dispatch(command, params);
        }
        match command {
            "library.list" => self.library_list(),
            "library.add" => self.add_library(&params),
            "library.scan" => self.scan_library(string(&params, "library_id")?),
            "system.info" => Ok(json!({
                "name": "Nebulume", "version": env!("CARGO_PKG_VERSION"), "api_version": 1,
                "platform": std::env::consts::OS,
                "storage": ["local", "webdav", "s3"],
                "storage_transport": {"lan_http": true, "tls": ["public_ca", "lan_certificate_sha256"]},
                "originals_read_only": true,
                "credentials": "system_keyring_or_explicit_session",
                "imaging": neb_core::capabilities(),
                "limits": ["Remote libraries index metadata and cache originals on demand; 50k entries / 2048 directories per scan", "Remote caches have no automatic quota or sync", "No source deletion", "Basic RAW rendering; not a color-managed developing suite"]
            })),
            "storage.list" => {
                let storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                Ok(serde_json::to_value(storage.list())?)
            }
            "storage.add" => {
                let request: AddStorageRequest =
                    serde_json::from_value(params).context("Invalid storage configuration")?;
                let mut storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                Ok(serde_json::to_value(storage.add(request)?)?)
            }
            "storage.check" => {
                let storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                Ok(serde_json::to_value(
                    storage.check(string(&params, "id")?)?,
                )?)
            }
            "storage.inspect_tls" => Ok(serde_json::to_value(neb_storage::inspect_tls(string(
                &params, "endpoint",
            )?)?)?),
            "storage.browse" => {
                let storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(200)
                    .clamp(1, 1000) as usize;
                Ok(serde_json::to_value(storage.browse(
                    string(&params, "id")?,
                    params.get("prefix").and_then(Value::as_str).unwrap_or(""),
                    limit,
                    params.get("cursor").and_then(Value::as_str),
                )?)?)
            }
            "storage.fetch" => {
                let storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                Ok(serde_json::to_value(storage.fetch(
                    string(&params, "id")?,
                    string(&params, "key")?,
                    string(&params, "destination")?,
                )?)?)
            }
            "import.plan" => {
                let mut ingest = self
                    .ingest
                    .lock()
                    .map_err(|_| anyhow!("Import state unavailable"))?;
                Ok(serde_json::to_value(
                    ingest.plan(
                        string(&params, "source")?,
                        string(&params, "destination")?,
                        params
                            .get("layout")
                            .and_then(Value::as_str)
                            .unwrap_or("preserve"),
                        params
                            .get("deduplicate")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                    )?,
                )?)
            }
            "import.execute" => {
                let mut ingest = self
                    .ingest
                    .lock()
                    .map_err(|_| anyhow!("Import state unavailable"))?;
                let mut result =
                    serde_json::to_value(ingest.execute(string(&params, "plan_id")?)?)?;
                drop(ingest);
                if let Some(destination) = result
                    .get("destination")
                    .and_then(Value::as_str)
                    .and_then(|path| fs::canonicalize(path).ok())
                {
                    let target = self
                        .core
                        .libraries()?
                        .into_iter()
                        .filter(|library| {
                            library
                                .storage_id
                                .as_deref()
                                .and_then(|id| self.source(id).ok())
                                .is_none_or(|source| source.kind == "local")
                                && fs::canonicalize(&library.root)
                                    .is_ok_and(|root| destination.starts_with(root))
                        })
                        .max_by_key(|library| library.root.len());
                    if let Some(library) = target {
                        result["library_id"] = json!(library.id);
                        match self.scan_library(&library.id) {
                            Ok(report) => result["indexing"] = report,
                            Err(error) => result["indexing_error"] = json!(format!("{error:#}")),
                        }
                    }
                }
                Ok(result)
            }
            "import.history" => {
                let ingest = self
                    .ingest
                    .lock()
                    .map_err(|_| anyhow!("Import state unavailable"))?;
                Ok(serde_json::to_value(ingest.history()?)?)
            }
            _ => Err(anyhow!("Unknown command: {command}")),
        }
    }
}

struct BoundedImageReader {
    inner: Box<dyn Read>,
    remaining: usize,
}
impl Read for BoundedImageReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut extra = [0u8; 1];
            return if self.inner.read(&mut extra)? == 0 {
                Ok(0)
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "E_LIMIT: Remote image exceeds the 512 MiB limit",
                ))
            };
        }
        let limit = buffer.len().min(self.remaining);
        let read = self.inner.read(&mut buffer[..limit])?;
        self.remaining -= read;
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_download_accepts_exact_size_and_rejects_overflow_without_truncation_success() {
        let mut exact = BoundedImageReader {
            inner: Box::new(std::io::Cursor::new(vec![1, 2, 3])),
            remaining: 3,
        };
        let mut output = Vec::new();
        exact.read_to_end(&mut output).unwrap();
        assert_eq!(output, vec![1, 2, 3]);
        let mut oversized = BoundedImageReader {
            inner: Box::new(std::io::Cursor::new(vec![1, 2, 3, 4])),
            remaining: 3,
        };
        let error = oversized.read_to_end(&mut Vec::new()).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("E_LIMIT"));
    }
    #[test]
    fn shared_service_rejects_invalid_and_unknown_commands() {
        let dir = tempfile::tempdir().unwrap();
        let svc = Service::open(dir.path()).unwrap();
        assert_eq!(
            svc.execute("system.info", json!([])).unwrap_err().code,
            "E_INVALID_PARAMS"
        );
        assert!(svc.execute("secret.delete_everything", json!({})).is_err());
        assert!(svc.execute("import.plan", json!({"source": ""})).is_err());
        assert!(svc
            .execute("storage.inspect_tls", json!({"endpoint": ""}))
            .is_err());
        assert!(svc
            .execute(
                "storage.inspect_tls",
                json!({"endpoint": "http://127.0.0.1"})
            )
            .is_err());
        assert_eq!(
            svc.execute("system.info", json!({})).unwrap()["api_version"],
            1
        );
    }
    #[test]
    fn library_survives_shared_service_restart() {
        let dir = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let id;
        {
            let svc = Service::open(dir.path()).unwrap();
            id = svc
                .execute(
                    "library.add",
                    json!({"name":"测试图库", "root":source.path()}),
                )
                .unwrap()["id"]
                .clone();
        }
        let svc = Service::open(dir.path()).unwrap();
        let libraries = svc.execute("library.list", json!({})).unwrap();
        assert_eq!(libraries[0]["id"], id);
    }
}
