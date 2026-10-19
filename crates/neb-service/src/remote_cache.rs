//! Application cache policy and remote rendering. Catalog identity never follows
//! the physical cache root; a lease protects every original used by a renderer.
use super::*;
use anyhow::bail;
use neb_core::{Asset, CacheLease};
use neb_storage::RangeReadError;
use std::{fs::OpenOptions, io::Write};

fn snapshot_capture_fields(snapshot: &Value) -> (String, &'static str) {
    if let (Some(date), Some(status)) = (
        snapshot["captured_at"].as_str(),
        snapshot["capture_status"].as_str(),
    ) {
        match (date.is_empty(), status) {
            (false, "available") => return (date.to_owned(), "available"),
            (true, "missing") => return (String::new(), "missing"),
            (true, "pending") => return (String::new(), "pending"),
            _ => {}
        }
    }
    // Pre-capture-index snapshots have neither field. Existing Original EXIF
    // proves a date, but an absent/invalid optional metadata field never proves
    // that a bounded check of this pinned original has completed.
    let metadata = serde_json::from_value(snapshot["metadata"].clone()).unwrap_or_default();
    let capture = neb_core::capture_time::from_metadata(&metadata);
    if capture.status == neb_core::capture_time::CaptureStatus::Available {
        (capture.captured_at, "available")
    } else {
        (String::new(), "pending")
    }
}

struct DownloadSlot<'a>(&'a (Mutex<usize>, Condvar));
impl Drop for DownloadSlot<'_> {
    fn drop(&mut self) {
        if let Ok(mut count) = self.0 .0.lock() {
            *count = count.saturating_sub(1);
            self.0 .1.notify_one();
        }
    }
}

impl Service {
    fn download_slot(&self) -> Result<DownloadSlot<'_>> {
        let mut count = self
            .downloads
            .0
            .lock()
            .map_err(|_| anyhow!("Download state unavailable"))?;
        while *count >= 4 {
            count = self
                .downloads
                .1
                .wait(count)
                .map_err(|_| anyhow!("Download state unavailable"))?;
        }
        *count += 1;
        Ok(DownloadSlot(&self.downloads))
    }

    pub(super) fn adopt_legacy_cache(&self) -> Result<()> {
        if self.cache.legacy_adoption_complete()? {
            return Ok(());
        }
        let Ok(cache_root) = fs::canonicalize(&self.cache_root) else {
            self.cache.mark_legacy_adoption_complete()?;
            return Ok(());
        };
        for asset in self.core.remote_assets()? {
            self.adopt_legacy_asset(&asset, &cache_root)?;
        }
        self.cache.mark_legacy_adoption_complete()?;
        Ok(())
    }

    fn adopt_legacy_asset(&self, asset: &Asset, cache_root: &Path) -> Result<()> {
        if !Path::new(&asset.path).is_file() || self.cache.original_registered(&asset.id)? {
            return Ok(());
        }
        let library = self.core.library(&asset.library_id)?;
        // Only catalog-proven files under this app's historical cache root.
        if fs::canonicalize(&library.root).is_ok_and(|root| root.starts_with(cache_root))
            && Path::new(&asset.path).parent() == Some(Path::new(&library.root))
        {
            self.cache
                .adopt_original(&asset.id, Path::new(&asset.path))?;
            self.core.bind_original_revision(&asset.id)?;
        }
        Ok(())
    }

    fn asset_value(&self, asset: &Asset) -> Result<Value> {
        let mut value = serde_json::to_value(asset)?;
        if asset.source_key.is_some() {
            let pinned = self.cache.is_pinned(&asset.id)?;
            value["cache_pinned"] = json!(pinned);
            if pinned {
                if let Some(snapshot) = self.core.original_snapshot(&asset.id)? {
                    for field in ["width", "height", "metadata", "size", "availability"] {
                        value[field] = snapshot[field].clone();
                    }
                    let (captured_at, capture_status) = snapshot_capture_fields(&snapshot);
                    value["captured_at"] = json!(captured_at);
                    value["capture_status"] = json!(capture_status);
                    value["cache_update_available"] =
                        json!(!self.core.original_revision_current(&asset.id)?);
                }
            }
        }
        Ok(value)
    }

    fn refresh_local(&self, asset: Asset, force: bool) -> Result<Asset> {
        if force {
            self.core.invalidate_asset(&asset.id)?;
        }
        if force || Path::new(&asset.path).is_file() {
            self.core.refresh_asset(&asset.id)
        } else {
            Ok(asset)
        }
    }

    fn original(&self, asset: &Asset, force: bool) -> Result<Option<CacheLease>> {
        let Some(key) = asset.source_key.as_deref() else {
            return Ok(None);
        };
        // A failed refresh must leave its previous ordinary (unpinned) version
        // intact. Its reservation cannot evict the file it is replacing.
        let _previous = if force {
            self.cache.acquire_original(&asset.id)?
        } else {
            None
        };
        if !force {
            if let Some(lease) = self.current_original(asset)? {
                return Ok(Some(lease));
            }
        }
        ensure!(
            asset.size <= 512 * 1024 * 1024,
            "E_LIMIT: Remote image exceeds 512 MiB"
        );
        let library = self.core.library(&asset.library_id)?;
        let source = library
            .storage_id
            .as_deref()
            .context("E_NOT_FOUND: Remote library has no storage source")?;
        let generation = if force {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
                .to_string()
        } else {
            format!("{}:{}", self.core.asset_fingerprint(&asset.id)?, asset.size)
        };
        let object_key = format!("{}:{generation}.{}", asset.id, asset.extension);
        let download_bound = if asset.size == 0 {
            512 * 1024 * 1024
        } else {
            asset.size
        };
        let reservation = self
            .cache
            .reserve(&object_key, "original", download_bound)?;
        // Lazy network reader captures credentials while locked, then performs
        // all HTTP and streaming I/O after the storage registry lock is released.
        let reader = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .open_reader(source, key)?;
        let mut reader = BoundedImageReader {
            inner: reader,
            remaining: usize::try_from(download_bound)?,
        };
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(reservation.path())?;
        let copied = std::io::copy(&mut reader, &mut file)?;
        ensure!(
            asset.size == 0 || copied == asset.size,
            "E_CONFLICT: Remote original size changed; rescan the library before retrying"
        );
        file.flush()?;
        file.sync_all()?;
        drop(file);
        let lease = reservation.commit(Some(&asset.id))?;
        self.core.invalidate_asset(&asset.id)?;
        self.core.refresh_asset(&asset.id)?;
        self.core.bind_original_revision(&asset.id)?;
        if self.cache.is_pinned(&asset.id)? {
            self.core.save_original_snapshot(&asset.id)?;
        }
        Ok(Some(lease))
    }

    fn current_original(&self, asset: &Asset) -> Result<Option<CacheLease>> {
        let mut lease = self.cache.acquire_original(&asset.id)?;
        if lease.is_none() && !self.cache.original_registered(&asset.id)? {
            // Recover a late file left by an older process without rescanning
            // every remote catalog entry on every modern application startup.
            if let Ok(root) = fs::canonicalize(&self.cache_root) {
                self.adopt_legacy_asset(asset, &root)?;
                lease = self.cache.acquire_original(&asset.id)?;
            }
        }
        if self.cache.is_pinned(&asset.id)? {
            ensure!(
                lease.is_some(),
                "E_CACHE_PIN_MISSING: 固定的离线原图不可用，请重新连接缓存盘或手动刷新此图片。"
            );
            return Ok(lease);
        }
        if lease.is_some() && !self.core.original_revision_current(&asset.id)? {
            return Ok(None);
        }
        Ok(lease.filter(|lease| {
            asset.size == 0 || fs::metadata(lease.path()).is_ok_and(|info| info.len() == asset.size)
        }))
    }

    fn preview_key(&self, asset: &Asset, max_size: u32, uncropped: bool) -> Result<String> {
        let snapshot = if asset.source_key.is_some() && self.cache.is_pinned(&asset.id)? {
            self.core.original_snapshot(&asset.id)?
        } else {
            None
        };
        let fingerprint = match &snapshot {
            Some(snapshot) => snapshot["_cache_fingerprint"]
                .as_str()
                .context("E_CACHE: Invalid offline snapshot")?
                .to_owned(),
            None => self.core.asset_fingerprint(&asset.id)?,
        };
        let size = snapshot
            .as_ref()
            .and_then(|s| s["size"].as_u64())
            .unwrap_or(asset.size);
        Ok(format!(
            "preview-v1:{}:{}:{}:{max_size}:{}",
            asset.id,
            fingerprint,
            size,
            serde_json::to_string(&if uncropped { None } else { asset.crop })?
        ))
    }

    fn cached_preview(&self, key: &str) -> Result<Option<Value>> {
        let bytes = match self.cache.preview_get(key) {
            Ok(bytes) => bytes,
            Err(error) if Self::optional_preview_cache_error(&error) => None,
            Err(error) => return Err(error),
        };
        bytes
            .map(|bytes| serde_json::from_slice(&bytes).context("E_CACHE: Invalid preview cache"))
            .transpose()
    }

    fn optional_preview_cache_error(error: &anyhow::Error) -> bool {
        [
            "E_CACHE_BUDGET:",
            "E_CACHE_SPACE:",
            "E_CACHE_BUSY:",
            "E_CACHE_OFFLINE:",
        ]
        .iter()
        .any(|code| error.to_string().starts_with(code))
    }

    fn render_preview(&self, asset: &Asset, params: &Value) -> Result<Value> {
        let max_size = params
            .get("max_size")
            .map(|v| v.as_u64().context("E_INVALID: max_size must be an integer"))
            .transpose()?
            .unwrap_or(1600);
        ensure!(
            (32..=4096).contains(&max_size),
            "E_INVALID: Preview max_size must be between 32 and 4096"
        );
        let uncropped = params
            .get("uncropped")
            .map(|v| v.as_bool().context("E_INVALID: uncropped must be boolean"))
            .transpose()?
            .unwrap_or(false);
        let key = self.preview_key(asset, max_size as u32, uncropped)?;
        if asset.source_key.is_none() {
            let cached = match self.cache.try_preview_get(&key) {
                Ok(value) => value,
                Err(error) if Self::optional_preview_cache_error(&error) => None,
                Err(error) => return Err(error),
            };
            let mut value = if let Some(bytes) = cached {
                serde_json::from_slice(&bytes).context("E_CACHE: Invalid preview cache")?
            } else {
                let value = self.core.dispatch("asset.preview", params.clone())?;
                // Disk persistence is best effort for local originals. No remote
                // slot or cache maintenance may delay returning decoded pixels.
                let bytes = serde_json::to_vec(&value)?;
                let mut count = self.preview_writes.load(Ordering::Acquire);
                let persist = loop {
                    if count >= 2 {
                        break false;
                    }
                    match self.preview_writes.compare_exchange_weak(
                        count,
                        count + 1,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    ) {
                        Ok(_) => break true,
                        Err(current) => count = current,
                    }
                };
                if persist {
                    let cache = Arc::clone(&self.cache);
                    let pending = Arc::clone(&self.preview_writes);
                    if std::thread::Builder::new()
                        .name("local-preview-cache".into())
                        .spawn(move || {
                            let _ = cache.preview_put(&key, &bytes);
                            pending.fetch_sub(1, Ordering::AcqRel);
                        })
                        .is_err()
                    {
                        self.preview_writes.fetch_sub(1, Ordering::AcqRel);
                    }
                }
                value
            };
            value["asset"] = self.asset_value(asset)?;
            return Ok(value);
        }
        if let Some(mut value) = self.cached_preview(&key)? {
            value["asset"] = self.asset_value(&self.core.asset(&asset.id)?)?;
            return Ok(value);
        }
        let _slot = self.download_slot()?;
        let lease = self.current_original(asset)?;
        if asset.source_key.is_some() && lease.is_some() && !self.cache.is_pinned(&asset.id)? {
            self.core.refresh_asset(&asset.id)?;
            self.core.bind_original_revision(&asset.id)?;
        }
        let mut value = if asset.source_key.is_some() && lease.is_none() {
            match self.range_preview(
                asset,
                if uncropped { None } else { asset.crop },
                max_size as u32,
            ) {
                Ok(value) => value,
                Err(error) if Self::may_fallback(&error) => {
                    self.require_automatic_download()?;
                    let _lease = self.original(asset, false)?;
                    self.core.dispatch("asset.preview", params.clone())?
                }
                Err(error)
                    if matches!(
                        Self::range_read_error(&error),
                        Some(RangeReadError::BudgetExceeded)
                    ) =>
                {
                    // A bounded attempt must not silently become a much larger
                    // transfer. Let the existing explicit-download action recover.
                    bail!("E_DOWNLOAD_REQUIRED: 此图片的内嵌预览超出分段读取上限，可下载原图后再尝试预览。")
                }
                Err(error) => return Err(error),
            }
        } else {
            self.core.dispatch("asset.preview", params.clone())?
        };
        if let Some(inspection) = value.get("inspection") {
            self.core.record_remote_inspection(&asset.id, inspection)?;
        }
        // Preview publication uses the current refreshed fingerprint. Cache hits
        // overlay live metadata, so ratings/crops/pins can never come from old JSON.
        let fresh = self.core.asset(&asset.id)?;
        let key = self.preview_key(&fresh, max_size as u32, uncropped)?;
        if let Err(error) = self.cache.preview_put(&key, &serde_json::to_vec(&value)?) {
            if !Self::optional_preview_cache_error(&error) {
                return Err(error);
            }
        }
        value["asset"] = self.asset_value(&fresh)?;
        Ok(value)
    }

    fn range_preview(
        &self,
        asset: &Asset,
        crop: Option<neb_core::Crop>,
        max_size: u32,
    ) -> Result<Value> {
        ensure!(
            asset.kind == "raw" || matches!(asset.extension.as_str(), "tif" | "tiff"),
            "E_UNSUPPORTED_CODEC: This format requires the original file for rendering"
        );
        let library = self.core.library(&asset.library_id)?;
        let source = library
            .storage_id
            .as_deref()
            .context("E_NOT_FOUND: Remote library has no storage source")?;
        let mut reader = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .open_range_reader(
                source,
                asset
                    .source_key
                    .as_deref()
                    .context("E_INVALID: Not a remote image")?,
            )?;
        let identity = reader.metadata()?;
        ensure!(
            asset.size == 0 || identity.length == asset.size,
            "E_CONFLICT: Remote image changed; rescan the library"
        );
        let result = neb_core::remote_preview(&mut reader, identity.length, crop, max_size);
        // Optional EXIF parsing must not hide a failed/changed transport.
        reader.metadata()?;
        result
    }

    fn range_read_error(error: &anyhow::Error) -> Option<&RangeReadError> {
        error.chain().find_map(|cause| {
            cause.downcast_ref::<RangeReadError>().or_else(|| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .and_then(RangeReadError::from_io)
            })
        })
    }

    pub(super) fn may_fallback(error: &anyhow::Error) -> bool {
        if let Some(error) = Self::range_read_error(error) {
            return error.is_fallback_allowed();
        }
        // A well-formed version-locked file may lack a standard embedded JPEG.
        error.to_string().starts_with("E_DECODE")
            || error.to_string().starts_with("E_UNSUPPORTED_CODEC")
    }

    fn require_automatic_download(&self) -> Result<()> {
        ensure!(self.cache.preview_policy()? != "manual", "E_DOWNLOAD_REQUIRED: 此图片需要下载原图才能预览。可手动下载，或在缓存设置中开启自动下载。");
        Ok(())
    }

    fn remote_focus_value(&self, asset: &Asset) -> Result<Value> {
        if !matches!(asset.extension.as_str(), "jpg" | "jpeg" | "tif" | "tiff")
            && asset.kind != "raw"
        {
            return Ok(
                json!({"status":"unsupported","reason":"此格式不提供可用的相机对焦坐标。","source":null,"coordinate_space":"oriented_full_image","orientation":1,"regions":[]}),
            );
        }
        let library = self.core.library(&asset.library_id)?;
        let mut reader = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .open_range_reader(
                library
                    .storage_id
                    .as_deref()
                    .context("E_NOT_FOUND: Remote library has no storage source")?,
                asset
                    .source_key
                    .as_deref()
                    .context("E_INVALID: Not a remote image")?,
            )?;
        let identity = reader.metadata()?;
        ensure!(
            asset.size == 0 || identity.length == asset.size,
            "E_CONFLICT: Remote image changed; rescan the library"
        );
        let focus = neb_core::remote_focus(&mut reader, identity.length);
        reader.metadata()?;
        Ok(serde_json::to_value(focus)?)
    }

    pub(super) fn asset_dispatch(&self, command: &str, params: Value) -> Result<Value> {
        let id = string(&params, "id")?;
        let lock = {
            let mut operations = self
                .asset_operations
                .lock()
                .map_err(|_| anyhow!("Asset operation state unavailable"))?;
            operations.retain(|_, lock| Arc::strong_count(lock) > 1);
            operations
                .entry(id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _asset_operation = lock
            .lock()
            .map_err(|_| anyhow!("Asset operation state unavailable"))?;
        let lock_root = self.data_dir.join("catalog/asset-locks");
        fs::create_dir_all(&lock_root)?;
        let lock_path = lock_root.join(format!(
            "{}.lock",
            hex::encode(Sha256::digest(id.as_bytes()))
        ));
        let process_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        process_lock.lock()?;
        let _process_asset = ProcessCatalogGuard(process_lock);
        // Pins can outlive a removed catalog record. Their settings-list action
        // must remain usable without looking up that now-absent asset.
        if command == "asset.offline.set" && params.get("pinned") == Some(&Value::Bool(false)) {
            let stats = self.cache.set_pinned(id, false)?;
            return Ok(json!({"asset_id":id,"pinned":false,"stats":stats}));
        }
        let mut asset = self.core.asset(id)?;
        if asset.source_key.is_none()
            && matches!(
                command,
                "asset.get"
                    | "asset.preview"
                    | "asset.histogram"
                    | "asset.focus"
                    | "asset.export"
                    | "asset.refresh"
            )
        {
            asset = self.refresh_local(asset, command == "asset.refresh")?;
        }
        match command {
            "asset.get" => self.asset_value(&asset),
            "asset.preview" => self.render_preview(&asset, &params),
            "asset.refresh" | "asset.fetch_original" => {
                if asset.source_key.is_none() {
                    return self.asset_value(&asset);
                }
                let _slot = self.download_slot()?;
                let _lease = self.original(&asset, command == "asset.refresh")?;
                self.asset_value(&self.core.asset(id)?)
            }
            "asset.offline.set" => {
                ensure!(
                    asset.source_key.is_some(),
                    "E_INVALID: Local originals do not need offline caching"
                );
                let pinned = params
                    .get("pinned")
                    .and_then(Value::as_bool)
                    .context("E_INVALID: pinned must be boolean")?;
                let _slot = self.download_slot()?;
                let _lease = if pinned {
                    self.original(&asset, false)?
                } else {
                    None
                };
                let stats = self.cache.set_pinned(id, pinned)?;
                if pinned {
                    self.core.save_original_snapshot(id)?;
                }
                Ok(json!({"asset_id":id,"pinned":pinned,"stats":stats}))
            }
            "asset.histogram" if asset.source_key.is_some() => {
                let mut request = params.clone();
                request["max_size"] = json!(2048);
                let value = self.render_preview(&asset, &request)?;
                if let Some(histogram) = value.get("histogram") {
                    let mut histogram = histogram.clone();
                    histogram["asset"] = self.asset_value(&self.core.asset(id)?)?;
                    return Ok(histogram);
                }
                let _slot = self.download_slot()?;
                let _lease = self.original(&asset, false)?;
                let mut histogram = self.core.dispatch(command, params.clone())?;
                histogram["asset"] = self.asset_value(&self.core.asset(id)?)?;
                Ok(histogram)
            }
            "asset.focus" if asset.source_key.is_some() => {
                let _slot = self.download_slot()?;
                let lease = self.current_original(&asset)?;
                if lease.is_some() {
                    return self.core.dispatch(command, params);
                }
                match self.remote_focus_value(&asset) {
                    Ok(value) => Ok(value),
                    Err(error) if Self::may_fallback(&error) => Ok(
                        json!({"status":"unsupported","reason":"远程预览未提供可用的对焦坐标。","source":null,"coordinate_space":"oriented_full_image","orientation":1,"regions":[]}),
                    ),
                    Err(error) => Err(error),
                }
            }
            "asset.export" => {
                if asset.source_key.is_none() {
                    return self.core.dispatch(command, params);
                }
                let _slot = self.download_slot()?;
                let _lease = self.original(&asset, false)?;
                self.core.dispatch(command, params)
            }
            "asset.rate" | "asset.crop" | "asset.reset_crop" => {
                self.core.dispatch(command, params.clone())?;
                self.asset_value(&self.core.asset(id)?)
            }
            _ => self.core.dispatch(command, params),
        }
    }

    fn protected_cache_roots(&self) -> Result<Vec<PathBuf>> {
        let mut roots = vec![
            self.data_dir.join("catalog"),
            self.data_dir.join("storage"),
            self.data_dir.join("ingest"),
        ];
        for library in self.core.libraries()? {
            if library
                .storage_id
                .as_deref()
                .map(|id| self.source(id).map(|s| s.kind == "local"))
                .transpose()?
                .unwrap_or(true)
            {
                roots.push(PathBuf::from(library.root));
            }
        }
        for source in self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .list()
        {
            if source.kind == "local" {
                roots.push(PathBuf::from(source.endpoint));
            }
        }
        Ok(roots)
    }

    pub(super) fn cache_dispatch(&self, command: &str, params: Value) -> Result<Value> {
        match command {
            "cache.stats" => self.cache.state(),
            "cache.policy.set" => self.cache.set_policy(params),
            "cache.prune" => self.cache.prune(
                params.clone(),
                params
                    .get("dry_run")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
            "cache.location.check" => self.cache.location_check(
                Path::new(string(&params, "path")?),
                &self.protected_cache_roots()?,
            ),
            "cache.migration.plan" => self.cache.migration_plan(
                Path::new(string(&params, "path")?),
                params.get("mode").and_then(Value::as_str).unwrap_or("all"),
                params
                    .get("allow_overage")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                &self.protected_cache_roots()?,
            ),
            "cache.migration.start" => self.cache.migration_start(
                string(&params, "plan_id")?,
                params
                    .get("allow_overage")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
            "cache.migration.get" => self.cache.migration_get(string(&params, "id")?),
            "cache.migration.cancel" => self.cache.migration_cancel(string(&params, "id")?),
            _ => Err(anyhow!("Unknown command: {command}")),
        }
    }
}

#[cfg(test)]
mod pinned_capture_tests {
    use super::snapshot_capture_fields;
    use serde_json::json;

    #[test]
    fn snapshot_capture_fields_keep_checked_state_and_upgrade_only_known_legacy_dates() {
        assert_eq!(
            snapshot_capture_fields(
                &json!({"captured_at":"2026-10-17T00:12:34.000000000","capture_status":"available","metadata":{"Captured":"2026:10:17 00:12:34"}})
            ),
            ("2026-10-17T00:12:34.000000000".into(), "available")
        );
        assert_eq!(
            snapshot_capture_fields(
                &json!({"captured_at":"","capture_status":"missing","metadata":{}})
            ),
            (String::new(), "missing")
        );
        assert_eq!(
            snapshot_capture_fields(&json!({"metadata":{"Captured":"2026-10-17 00:12:34"}})),
            ("2026-10-17T00:12:34.000000000".into(), "available")
        );
        for metadata in [
            json!({}),
            json!({"Captured":"invalid"}),
            json!({"EXIF DateTime":"2026:10:17 00:12:34"}),
        ] {
            assert_eq!(
                snapshot_capture_fields(&json!({"metadata":metadata})),
                (String::new(), "pending")
            );
        }
    }
}
