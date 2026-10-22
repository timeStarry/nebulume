//! Shared application commands for the native desktop and headless CLI.
use anyhow::{anyhow, ensure, Context, Result};
use neb_core::{CacheManager, Core, Library};
use neb_ingest::IngestService;
use neb_storage::{AddStorageRequest, StorageConfig, StorageRegistry};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex, RwLock,
    },
};

mod capture_index;
mod cards;
mod remote_cache;

type AssetOperations = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

// Independent handles are intentional: duplicated handles can share a lock's
// ownership on some platforms. Entry points acquire library, catalog, asset/cache
// in that order, so waiting for a busy library never holds the whole catalog.
struct ProcessCatalogGuard(File);
impl Drop for ProcessCatalogGuard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
fn process_catalog_lock(data_dir: &Path, exclusive: bool) -> Result<ProcessCatalogGuard> {
    fs::create_dir_all(data_dir.join("catalog"))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data_dir.join("catalog/service.lock"))?;
    if exclusive {
        file.lock()?;
    } else {
        file.lock_shared()?;
    }
    Ok(ProcessCatalogGuard(file))
}

fn process_library_lock(data_dir: &Path, id: &str, exclusive: bool) -> Result<ProcessCatalogGuard> {
    process_scoped_lock(data_dir, "library-locks", id, exclusive)
}

fn process_scoped_lock(
    data_dir: &Path,
    scope: &str,
    id: &str,
    exclusive: bool,
) -> Result<ProcessCatalogGuard> {
    let directory = data_dir.join("catalog").join(scope);
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!(
        "{}.lock",
        hex::encode(Sha256::digest(id.as_bytes()))
    ));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    if exclusive {
        file.lock()?;
    } else {
        file.lock_shared()?;
    }
    Ok(ProcessCatalogGuard(file))
}

pub struct Service {
    core: Arc<Core>,
    storage: Arc<Mutex<StorageRegistry>>,
    ingest: Mutex<IngestService>,
    cache_root: PathBuf,
    cache: Arc<CacheManager>,
    asset_operations: AssetOperations,
    downloads: (Mutex<usize>, Condvar),
    preview_writes: Arc<AtomicUsize>,
    data_dir: PathBuf,
    catalog_operations: RwLock<()>,
    capture_index: capture_index::CaptureIndexController,
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
            "E_DOWNLOAD_REQUIRED",
            // Longer codes first: matching is by prefix.
            "E_UNSUPPORTED_CODEC",
            "E_UNSUPPORTED",
            "E_NOT_FOUND",
            "E_CONFLICT",
            "E_IN_USE",
            "E_WRITE_UNVERIFIED",
            "E_VERIFY",
            "E_IO",
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
        let _process_catalog = process_catalog_lock(data_dir, true)?;
        let service = Self {
            core: Arc::new(Core::open(data_dir.join("catalog"))?),
            storage: Arc::new(Mutex::new(StorageRegistry::open(data_dir.join("storage"))?)),
            ingest: Mutex::new(IngestService::open(data_dir.join("ingest"))?),
            cache_root: data_dir.join("remote-cache"),
            cache: Arc::new(CacheManager::open(
                data_dir.join("catalog/catalog.sqlite3"),
                data_dir.join("remote-cache"),
            )?),
            asset_operations: Arc::new(Mutex::new(HashMap::new())),
            downloads: (Mutex::new(0), Condvar::new()),
            preview_writes: Arc::new(AtomicUsize::new(0)),
            data_dir: data_dir.to_path_buf(),
            catalog_operations: RwLock::new(()),
            capture_index: capture_index::CaptureIndexController::default(),
        };
        service.sync_locations()?;
        service.adopt_legacy_cache()?;
        if let Err(error) = service.cache.maintain() {
            // Metadata/settings remain available when a removable cache is
            // offline or protected/unmanaged content already fills the budget.
            if ![
                "E_CACHE_OFFLINE:",
                "E_CACHE_BUDGET:",
                "E_CACHE_BUSY:",
                "E_CACHE_SPACE:",
            ]
            .iter()
            .any(|code| error.to_string().starts_with(code))
            {
                return Err(error);
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
        let structural_write =
            matches!(command, "library.add" | "library.update" | "library.remove")
                || matches!(command, "storage.add" | "storage.remove" | "file.open")
                || matches!(
                    command,
                    "card.register" | "card.bind" | "card.remove" | "preset.remove"
                );
        // Long operations hold only their own library lease. A slow remote file
        // or scan cannot monopolize the catalog for unrelated local libraries.
        let _process_library = if matches!(command, "library.update" | "library.remove") {
            Some(
                process_library_lock(
                    &self.data_dir,
                    string(&params, "id").map_err(CommandError::from)?,
                    true,
                )
                .map_err(CommandError::from)?,
            )
        } else if command == "asset.mark_batch" {
            // Every id must belong to one library so a single lease covers the batch.
            let ids: Vec<String> = params
                .get("ids")
                .and_then(|ids| serde_json::from_value(ids.clone()).ok())
                .ok_or_else(|| CommandError {
                    code: "E_INVALID",
                    message: "A batch must contain 1 to 1000 assets".into(),
                })?;
            let library = self
                .core
                .mark_batch_library(&ids)
                .map_err(CommandError::from)?;
            Some(
                process_library_lock(&self.data_dir, &library, false)
                    .map_err(CommandError::from)?,
            )
        } else if command.starts_with("asset.") && command != "asset.list" {
            let asset = self
                .core
                .asset(string(&params, "id").map_err(CommandError::from)?);
            match asset {
                Ok(asset) => Some(
                    process_library_lock(&self.data_dir, &asset.library_id, false)
                        .map_err(CommandError::from)?,
                ),
                Err(_) if command == "asset.offline.set" && params["pinned"] == false => None,
                Err(error) => return Err(error.into()),
            }
        } else {
            None
        };
        let _process_catalog = if structural_write || command == "asset.list" {
            Some(
                process_catalog_lock(&self.data_dir, structural_write)
                    .map_err(CommandError::from)?,
            )
        } else {
            None
        };
        // Entry-point lock only: private helpers may call each other without
        // recursively acquiring it. Always acquire catalog before storage/cache.
        let _catalog_write = if structural_write {
            Some(self.catalog_operations.write().map_err(|_| CommandError {
                code: "E_OPERATION",
                message: "Catalog operation state is unavailable".into(),
            })?)
        } else {
            None
        };
        // Lists need a coherent catalog snapshot. Long asset I/O uses the
        // per-library lease above without occupying this global lock.
        let _catalog_read = if command == "asset.list" {
            Some(self.catalog_operations.read().map_err(|_| CommandError {
                code: "E_OPERATION",
                message: "Catalog operation state is unavailable".into(),
            })?)
        } else {
            None
        };
        self.dispatch(command, params).map_err(Into::into)
    }

    /// Mirror every saved source into the catalog's location table, preserving ids so
    /// libraries and credential scopes keep pointing at the same thing.
    fn sync_locations(&self) -> Result<()> {
        let sources = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .list();
        for source in &sources {
            self.core.sync_location(&location_of(source))?;
        }
        Ok(())
    }

    /// Locations with runtime availability; implicit folder locations are included
    /// so the UI can show where every library lives.
    fn location_list(&self) -> Result<Value> {
        let sources = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .list();
        let libraries = self.core.libraries()?;
        self.core
            .locations()?
            .into_iter()
            .map(|location| {
                let mut value = serde_json::to_value(&location)?;
                let availability = match sources.iter().find(|s| s.id == location.id) {
                    Some(source) if source.kind != "local" => source.availability.clone(),
                    _ => if Path::new(&location.endpoint).is_dir() {
                        "online"
                    } else {
                        "offline"
                    }
                    .to_owned(),
                };
                value["availability"] = json!(availability);
                value["library_ids"] = json!(libraries
                    .iter()
                    .filter(|library| library.location_id.as_deref() == Some(&location.id))
                    .map(|library| library.id.as_str())
                    .collect::<Vec<_>>());
                Ok(value)
            })
            .collect::<Result<Vec<_>>>()
            .map(Value::from)
    }

    /// `library_id` naming a WebDAV/S3 library selects the remote import path.
    fn remote_import_target(&self, params: &Value) -> Result<Option<(Library, StorageConfig)>> {
        let Some(id) = params.get("library_id").and_then(Value::as_str) else {
            return Ok(None);
        };
        let library = self.core.library(id)?;
        let Some(source) = library
            .storage_id
            .as_deref()
            .map(|id| self.source(id))
            .transpose()?
        else {
            return Ok(None);
        };
        Ok((source.kind != "local").then_some((library, source)))
    }

    fn execute_remote_import(
        &self,
        library: &Library,
        source: &StorageConfig,
        params: &Value,
    ) -> Result<Value> {
        let writer = {
            let storage = self
                .storage
                .lock()
                .map_err(|_| anyhow!("Storage state unavailable"))?;
            // Only a location that passed the explicit write test accepts imports.
            ensure!(
                storage.write_capability(&source.id) == neb_storage::WriteCapability::Verified,
                "E_WRITE_UNVERIFIED: Test writing to {} in Locations before importing to it",
                source.name
            );
            storage.open_writer(&source.id)?
        };
        let include_likely = params
            .get("include_likely_duplicates")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let outcome = {
            let mut ingest = self
                .ingest
                .lock()
                .map_err(|_| anyhow!("Import state unavailable"))?;
            ingest.execute_remote(string(params, "plan_id")?, &writer, include_likely)?
        };
        let mut result = serde_json::to_value(&outcome)?;
        result["library_id"] = json!(library.id);
        // Register published files directly from known keys and sizes; no rescan.
        let mut registered = 0;
        let mut errors = Vec::new();
        for item in outcome.items.iter().filter(|item| item.status == "copied") {
            let extension = Path::new(&item.destination)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if neb_core::image_kind(&extension).is_none() {
                continue;
            }
            let cache_name = format!(
                "{}.{}",
                hex::encode(Sha256::digest(
                    format!("{}:{}", item.destination, item.size).as_bytes()
                )),
                extension
            );
            match self.core.register_remote_asset(
                &library.id,
                &item.destination,
                &cache_name,
                item.size,
            ) {
                Ok(_) => registered += 1,
                Err(error) => {
                    errors.push(json!({"path":item.destination,"message":format!("{error:#}")}))
                }
            }
        }
        result["indexing"] = json!({"indexed":registered,"skipped":0,"errors":errors});
        match self.record_batch(library, &result, params.get("card_id")) {
            Ok(batch) => result["batch"] = serde_json::to_value(batch)?,
            Err(error) => result["batch_error"] = json!(format!("{error:#}")),
        }
        Ok(result)
    }

    fn record_batch(
        &self,
        library: &Library,
        result: &Value,
        card: Option<&Value>,
    ) -> Result<neb_core::ImportBatch> {
        let card_id = match card.and_then(Value::as_str) {
            Some(id) => Some(self.core.card(id)?.id),
            None => None,
        };
        let count = |key: &str| result.get(key).and_then(Value::as_u64).unwrap_or(0);
        let text = |key: &str| {
            result
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        // Only files this import wrote are tagged; skipped duplicates keep their batch.
        let copied: Vec<(String, String)> = result
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|item| item.get("status").and_then(Value::as_str) == Some("copied"))
            .filter_map(|item| {
                let destination = item.get("destination")?.as_str()?;
                // Local results are paths; remote results are location keys.
                let path = if library.storage_id.is_some() && !Path::new(destination).is_absolute()
                {
                    destination.to_owned()
                } else {
                    fs::canonicalize(destination)
                        .ok()?
                        .to_string_lossy()
                        .into_owned()
                };
                Some((path, item.get("sha256")?.as_str()?.to_owned()))
            })
            .collect();
        self.core.record_import_batch(
            &neb_core::ImportBatch {
                id: text("id"),
                library_id: library.id.clone(),
                card_id,
                source: text("source"),
                rules: result.get("rules").cloned().unwrap_or_else(|| json!({})),
                started_at: text("started_at"),
                finished_at: result
                    .get("finished_at")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                status: text("status"),
                copied: count("copied"),
                duplicates: count("duplicates"),
                failed: count("failed"),
                asset_count: 0,
            },
            &copied,
        )
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
        // Local directories are checked directly (cheap, no network). Remote sources
        // report only the result of the latest real operation; listing never connects.
        let local_online = || Path::new(&library.root).is_dir();
        let availability = match source.as_ref() {
            Some(s) if s.kind != "local" => s.availability.clone(),
            _ => if local_online() { "online" } else { "offline" }.to_owned(),
        };
        value["connected"] = json!(availability == "online");
        value["availability"] = json!(availability);
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
        let pair = params
            .get("pair_raw_jpeg")
            .map(|value| {
                value
                    .as_bool()
                    .context("E_INVALID: pair_raw_jpeg must be boolean")
            })
            .transpose()?
            .unwrap_or(false);
        if params.get("storage_id").and_then(Value::as_str).is_none() {
            let root = string(params, "root")?;
            return self.library_value(&self.core.add_library_with_options(
                name,
                Path::new(root),
                pair,
            )?);
        }
        let source = self.source(string(params, "storage_id")?)?;
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
        let root = self.source_library_root(&source, prefix)?;
        let library = self.core.add_library_with_options(name, &root, pair)?;
        let library = self.core.bind_storage(&library.id, &source.id, prefix)?;
        self.library_value(&library)
    }

    fn source_library_root(&self, source: &StorageConfig, prefix: &str) -> Result<PathBuf> {
        if source.kind == "local" {
            self.storage
                .lock()
                .map_err(|_| anyhow!("Storage state unavailable"))?
                .local_root(&source.id, prefix)
        } else {
            let root = self
                .cache_root
                .join(&source.id)
                .join(hex::encode(Sha256::digest(prefix.as_bytes())));
            fs::create_dir_all(&root).context("E_IO: Cannot create remote library cache")?;
            Ok(root)
        }
    }

    fn update_library(&self, params: Value) -> Result<Value> {
        #[derive(Deserialize)]
        struct Update {
            id: String,
            name: Option<String>,
            pair_raw_jpeg: Option<bool>,
            storage_id: Option<String>,
            source_prefix: Option<String>,
            root: Option<String>,
        }
        let update: Update =
            serde_json::from_value(params).context("E_INVALID: Invalid library update")?;
        let previous = self.core.library(&update.id)?;
        if let Some(root) = update.root {
            ensure!(
                update.storage_id.is_none(),
                "E_INVALID: Choose a local directory or a remote storage source"
            );
            return self.library_value(&self.core.update_local_library(
                &update.id,
                update.name.as_deref(),
                update.pair_raw_jpeg,
                Path::new(&root),
            )?);
        }
        let source_id = update
            .storage_id
            .as_deref()
            .or(previous.storage_id.as_deref());
        let prefix = update
            .source_prefix
            .as_deref()
            .unwrap_or(&previous.source_prefix)
            .trim_end_matches('/');
        neb_storage::validate_key(prefix, true)?;
        let changed =
            source_id != previous.storage_id.as_deref() || prefix != previous.source_prefix;
        let resolved = if changed {
            let source_id = source_id
                .context("E_INVALID: Select a storage source before changing its directory")?;
            let source = self.source(source_id)?;
            Some((self.source_library_root(&source, prefix)?, source_id))
        } else {
            None
        };
        let binding = resolved
            .as_ref()
            .map(|(root, source)| (root.as_path(), *source, prefix));
        let library = self.core.update_library(
            &update.id,
            update.name.as_deref(),
            update.pair_raw_jpeg,
            binding,
        )?;
        self.library_value(&library)
    }

    fn remove_storage(&self, id: &str) -> Result<Value> {
        let references = self.core.libraries_for_storage(id)?;
        ensure!(
            references.is_empty(),
            "E_IN_USE: Storage is used by libraries: {}",
            references
                .iter()
                .map(|library| library.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        let removed = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .remove(id)?;
        self.core.remove_location(id)?;
        Ok(serde_json::to_value(removed)?)
    }

    fn check_scan_binding(&self, expected: &Library) -> Result<()> {
        let current = self.core.library(&expected.id)?;
        ensure!(
            current.root == expected.root
                && current.storage_id == expected.storage_id
                && current.source_prefix == expected.source_prefix,
            "E_CONFLICT: Library location changed during scanning; retry the scan"
        );
        Ok(())
    }

    fn scan_library(&self, id: &str) -> Result<Value> {
        // Two paginated scans must not mark each other missing. This lease is
        // separate from asset/rebind leases, which are free during network I/O.
        let _scan = process_scoped_lock(&self.data_dir, "scan-locks", id, true)?;
        let library = self.core.library(id)?;
        let source = library
            .storage_id
            .as_deref()
            .map(|id| self.source(id))
            .transpose()?;
        if source.as_ref().is_none_or(|source| source.kind == "local") {
            let _library = process_library_lock(&self.data_dir, id, true)?;
            self.check_scan_binding(&library)?;
            return self.core.dispatch("library.scan", json!({"library_id":id}));
        }
        let source = source.expect("remote source checked above");
        let browser = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .open_browser(&source.id)?;
        let mut pending = VecDeque::from([library.source_prefix.clone()]);
        let mut seen = HashSet::new();
        let mut keys = Vec::new();
        let (mut indexed, mut skipped, mut entries_seen, mut pages_seen) =
            (0usize, 0usize, 0usize, 0usize);
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
                // Network enumeration owns a snapshot, never the storage registry
                // or catalog/library locks needed by unrelated local browsing.
                let page = match browser.browse(&prefix, 1000, cursor.as_deref()) {
                    Ok(page) => page,
                    Err(error) if indexed > 0 => {
                        errors.push(json!({"path":prefix,"message":format!("{error:#}")}));
                        return Ok(
                            json!({"indexed":indexed,"skipped":skipped,"errors":errors,"partial":true,"source_kind":source.kind,"cached_on_demand":true}),
                        );
                    }
                    Err(error) => return Err(error),
                };
                {
                    let _library = process_library_lock(&self.data_dir, id, true)?;
                    self.check_scan_binding(&library)?;
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
                            .and_then(|asset| {
                                self.core.set_remote_created_at(
                                    &asset.id,
                                    entry.created_at.as_deref(),
                                )?;
                                Ok(asset)
                            }) {
                            Ok(_) => {
                                indexed += 1;
                                keys.push(entry.key);
                            }
                            Err(error) => errors
                                .push(json!({"path":entry.key,"message":format!("{error:#}")})),
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
        if errors.is_empty() {
            let _library = process_library_lock(&self.data_dir, id, true)?;
            self.check_scan_binding(&library)?;
            self.core.finish_remote_scan(id, &keys)?;
        }
        Ok(
            json!({"indexed":indexed,"skipped":skipped,"errors":errors,"source_kind":source.kind,"cached_on_demand":true}),
        )
    }

    fn dispatch(&self, command: &str, params: Value) -> Result<Value> {
        if command == "asset.mark_batch" {
            return self.core.dispatch(command, params);
        }
        if command.starts_with("asset.") && command != "asset.list" {
            return self.asset_dispatch(command, params);
        }
        if command == "asset.list" || command == "file.open" {
            return self.core.dispatch(command, params);
        }
        if command.starts_with("cache.") {
            return self.cache_dispatch(command, params);
        }
        match command {
            "library.list" => self.library_list(),
            "library.add" => self.add_library(&params),
            "library.update" => self.update_library(params),
            "library.remove" => {
                let id = string(&params, "id")?;
                Ok(json!({"id":id,"removed_assets":self.core.remove_library(id)?}))
            }
            "library.scan" => self.scan_library(string(&params, "library_id")?),
            "library.capture_index.status" => {
                self.capture_index_status(string(&params, "library_id")?)
            }
            "library.capture_index.start" => {
                self.start_capture_index(string(&params, "library_id")?)
            }
            "library.capture_index.cancel" => self
                .cancel_capture_index(string(&params, "library_id")?, string(&params, "job_id")?),
            "system.info" => Ok(json!({
                "name": "Nebulume", "version": env!("CARGO_PKG_VERSION"), "api_version": 1,
                "platform": std::env::consts::OS,
                "storage": ["local", "webdav", "s3"],
                "storage_transport": {"lan_http": true, "tls": ["public_ca", "lan_certificate_sha256"]},
                "originals_read_only": true,
                "credentials": "system_keyring_or_explicit_session",
                "imaging": neb_core::capabilities(),
                "limits": ["Remote libraries index metadata and cache originals on demand; 50k entries / 2048 directories per scan", "Managed remote cache with shared disk quota, protected offline originals and version-locked bounded previews", "No source deletion", "Basic RAW rendering; not a color-managed developing suite"]
            })),
            "storage.list" => {
                let storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                let mut list = serde_json::to_value(storage.list())?;
                // Write capability is a per-process result of the explicit write test.
                for source in list.as_array_mut().into_iter().flatten() {
                    let id = source["id"].as_str().unwrap_or_default().to_owned();
                    source["write_capability"] = json!(storage.write_capability(&id).as_str());
                }
                Ok(list)
            }
            "storage.add" => {
                let request: AddStorageRequest =
                    serde_json::from_value(params).context("Invalid storage configuration")?;
                let mut storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                let added = storage.add(request)?;
                drop(storage);
                self.core.sync_location(&location_of(&added))?;
                Ok(serde_json::to_value(added)?)
            }
            "location.list" => self.location_list(),
            "card.list" => Ok(serde_json::to_value(self.core.cards()?)?),
            "card.identify" => cards::identify(&self.core, &params),
            "card.register" => cards::register(&self.core, &params),
            "card.bind" => cards::bind(&self.core, &params),
            "card.update" => cards::update(&self.core, &params),
            "card.remove" => {
                self.core.remove_card(string(&params, "id")?)?;
                Ok(json!({"id":string(&params, "id")?}))
            }
            "preset.list" => Ok(serde_json::to_value(self.core.import_presets()?)?),
            "preset.save" => cards::save_preset(&self.core, &params),
            "preset.remove" => {
                self.core.remove_import_preset(string(&params, "id")?)?;
                Ok(json!({"id":string(&params, "id")?}))
            }
            "import.batches" => Ok(serde_json::to_value(
                self.core.import_batches(string(&params, "library_id")?)?,
            )?),
            "storage.remove" => self.remove_storage(string(&params, "id")?),
            "storage.write_check" => {
                // Explicit: writes and removes one small test object on the server.
                let id = string(&params, "id")?;
                let writer = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?
                    .open_writer(id)?;
                Ok(serde_json::to_value(writer.probe())?)
            }
            "storage.check" => {
                let id = string(&params, "id")?;
                let (snapshot, config) = {
                    let storage = self
                        .storage
                        .lock()
                        .map_err(|_| anyhow!("Storage state unavailable"))?;
                    let snapshot = storage.open_browser(id);
                    let config = storage
                        .list()
                        .into_iter()
                        .find(|source| source.id == id)
                        .context("E_NOT_FOUND: Storage source does not exist")?;
                    (snapshot, config)
                };
                match snapshot {
                    Ok(browser) => Ok(serde_json::to_value(browser.check()?)?),
                    Err(error) => Ok(
                        json!({"id":id,"connected":false,"availability":neb_storage::classify(&error).as_str(),"credential_status":config.credential_status,"checked_at":chrono::Utc::now().to_rfc3339(),"error":format!("{error:#}")}),
                    ),
                }
            }
            "storage.inspect_tls" => Ok(serde_json::to_value(neb_storage::inspect_tls(string(
                &params, "endpoint",
            )?)?)?),
            "storage.browse" => {
                let browser = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?
                    .open_browser(string(&params, "id")?)?;
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(200)
                    .clamp(1, 1000) as usize;
                Ok(serde_json::to_value(browser.browse(
                    params.get("prefix").and_then(Value::as_str).unwrap_or(""),
                    limit,
                    params.get("cursor").and_then(Value::as_str),
                )?)?)
            }
            "storage.fetch" => {
                let mut reader = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?
                    .open_reader(string(&params, "id")?, string(&params, "key")?)?;
                let destination = Path::new(string(&params, "destination")?);
                let (size, sha256) = neb_storage::publish_reader(&mut reader, destination, None)?;
                Ok(serde_json::to_value(neb_storage::FetchResult {
                    path: destination.to_string_lossy().into_owned(),
                    size,
                    sha256,
                })?)
            }
            "import.plan" => {
                let mut ingest = self
                    .ingest
                    .lock()
                    .map_err(|_| anyhow!("Import state unavailable"))?;
                // Structured `rules` take precedence; `layout` remains a compatibility alias.
                let rules = match params.get("rules").filter(|rules| !rules.is_null()) {
                    Some(rules) => {
                        serde_json::from_value::<neb_ingest::OrganizeRules>(rules.clone())
                            .context("E_INVALID: Invalid import organization rules")?
                    }
                    None => neb_ingest::OrganizeRules::from_legacy_layout(
                        params
                            .get("layout")
                            .and_then(Value::as_str)
                            .unwrap_or("preserve"),
                    )?,
                };
                let deduplicate = params
                    .get("deduplicate")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                // A remote library is addressed by id; local targets keep `destination`.
                if let Some(target) = self.remote_import_target(&params)? {
                    let (library, source) = target;
                    let known: Vec<neb_ingest::KnownAsset> = self
                        .core
                        .import_known_assets(&library.id)?
                        .into_iter()
                        .map(
                            |(key, size, sha256, filename, captured_at)| neb_ingest::KnownAsset {
                                key,
                                size,
                                sha256,
                                filename,
                                captured_at,
                            },
                        )
                        .collect();
                    let mut plan = serde_json::to_value(ingest.plan_remote(
                        string(&params, "source")?,
                        &source.id,
                        &library.source_prefix,
                        &rules,
                        deduplicate,
                        &known,
                    )?)?;
                    plan["library_id"] = json!(library.id);
                    plan["write_capability"] = json!(self
                        .storage
                        .lock()
                        .map_err(|_| anyhow!("Storage state unavailable"))?
                        .write_capability(&source.id)
                        .as_str());
                    return Ok(plan);
                }
                Ok(serde_json::to_value(ingest.plan_with_rules(
                    string(&params, "source")?,
                    string(&params, "destination")?,
                    &rules,
                    deduplicate,
                )?)?)
            }
            "import.execute" if self.remote_import_target(&params)?.is_some() => {
                let (library, source) = self
                    .remote_import_target(&params)?
                    .expect("checked by the match guard");
                self.execute_remote_import(&library, &source, &params)
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
                        // The batch is recorded after indexing so it can tag new assets.
                        match self.record_batch(&library, &result, params.get("card_id")) {
                            Ok(batch) => result["batch"] = serde_json::to_value(batch)?,
                            Err(error) => result["batch_error"] = json!(format!("{error:#}")),
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

fn location_of(source: &StorageConfig) -> neb_core::Location {
    neb_core::Location {
        id: source.id.clone(),
        kind: source.kind.clone(),
        name: source.name.clone(),
        endpoint: source.endpoint.clone(),
        root: source.root.clone(),
        bucket: source.bucket.clone(),
        region: source.region.clone(),
        tls_certificate_sha256: source.tls_certificate_sha256.clone(),
        implicit: false,
        created_at: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hidden_library_references_also_prevent_storage_removal() {
        let data = tempfile::tempdir().unwrap();
        let photos = tempfile::tempdir().unwrap();
        let photo = photos.path().join("photo.ppm");
        fs::write(&photo, b"P6\n1 1\n255\n\xff\x00\x00").unwrap();
        let svc = Service::open(data.path()).unwrap();
        let source = svc
            .execute(
                "storage.add",
                json!({"name":"Local","kind":"local","endpoint":photos.path()}),
            )
            .unwrap();
        let asset = svc.execute("file.open", json!({"path":photo})).unwrap();
        let library_id = asset["library_id"].as_str().unwrap();
        svc.core
            .bind_storage(library_id, source["id"].as_str().unwrap(), "")
            .unwrap();
        assert!(svc.core.libraries().unwrap().is_empty());
        assert_eq!(
            svc.execute("storage.remove", json!({"id":source["id"]}))
                .unwrap_err()
                .code,
            "E_IN_USE"
        );
        svc.execute("library.remove", json!({"id":library_id}))
            .unwrap();
        svc.execute("storage.remove", json!({"id":source["id"]}))
            .unwrap();
        assert!(photo.is_file());
    }

    #[test]
    fn local_materialization_holds_binding_until_rebind_can_clear_old_assets() {
        use std::{
            sync::Arc,
            time::{Duration, Instant},
        };
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&new).unwrap();
        let photo = old.join("photo.ppm");
        let bytes = b"P6\n1 1\n255\n\xff\x00\x00";
        fs::write(&photo, bytes).unwrap();
        let svc = Arc::new(Service::open(temp.path().join("data")).unwrap());
        let library = svc
            .execute("library.add", json!({"name":"Old","root":old}))
            .unwrap();
        let source = svc
            .execute(
                "storage.add",
                json!({"name":"New","kind":"local","endpoint":new}),
            )
            .unwrap();
        svc.execute("library.scan", json!({"library_id":library["id"]}))
            .unwrap();
        let asset = svc
            .execute("asset.list", json!({"library_id":library["id"]}))
            .unwrap()["items"][0]
            .clone();
        // Stall refresh inside materialize, after execute has captured its read
        // lease. A binding change must wait for this complete operation.
        let asset_lock = Arc::new(Mutex::new(()));
        svc.asset_operations.lock().unwrap().insert(
            asset["id"].as_str().unwrap().to_owned(),
            Arc::clone(&asset_lock),
        );
        let cache = asset_lock.lock().unwrap();
        let refreshing = {
            let svc = Arc::clone(&svc);
            let id = asset["id"].clone();
            std::thread::spawn(move || svc.execute("asset.refresh", json!({"id":id})))
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let probe = OpenOptions::new()
            .read(true)
            .write(true)
            .open(svc.data_dir.join("catalog/library-locks").join(format!(
                "{}.lock",
                hex::encode(Sha256::digest(library["id"].as_str().unwrap().as_bytes()))
            )))
            .unwrap();
        loop {
            if probe.try_lock().is_err() {
                break;
            }
            probe.unlock().unwrap();
            assert!(
                Instant::now() < deadline,
                "Refresh did not acquire its library lease"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let rebinding = {
            let svc = Arc::clone(&svc);
            let id = library["id"].clone();
            std::thread::spawn(move || {
                let result = svc.execute(
                    "library.update",
                    json!({"id":id,"storage_id":source["id"],"source_prefix":""}),
                );
                done_tx.send(()).unwrap();
                result
            })
        };
        assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());
        drop(cache);
        refreshing.join().unwrap().unwrap();
        rebinding.join().unwrap().unwrap();
        assert_eq!(
            svc.execute("asset.list", json!({"library_id":library["id"]}))
                .unwrap()["total"],
            0
        );
        assert!(svc.core.asset(asset["id"].as_str().unwrap()).is_err());
        assert_eq!(fs::read(photo).unwrap(), bytes);
    }

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
