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

const STREAM_PREVIEW_MAX_BYTES: u64 = 128 * 1024 * 1024;
const JPEG_RANGE_MIN_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DownloadPriority {
    /// Interactive viewer (`P2560` / `Full`): FIFO order + 1 dedicated burst slot
    /// so opening a photo never stalls behind 4 background transfers.
    Viewer,
    /// Explicit user asset actions (`fetch_original`, `refresh`, `offline.set`, `export`, `focus`): FIFO order.
    Standard,
    /// Grid thumbnails (`T256` / `T512` / `T1024`): LIFO order so the most recently
    /// scrolled-into-view thumbnails dispatch first.
    Thumbnail,
}

#[derive(Default)]
pub(crate) struct DownloadScheduler {
    state: Mutex<DownloadState>,
    changed: Condvar,
}

#[derive(Default)]
struct DownloadState {
    active_total: usize,
    active_viewer: usize,
    next_ticket: u64,
    viewer_queue: VecDeque<u64>,
    standard_queue: VecDeque<u64>,
    thumbnail_queue: VecDeque<u64>,
}

impl DownloadState {
    fn can_acquire(&self, priority: DownloadPriority, ticket: u64) -> bool {
        match priority {
            DownloadPriority::Viewer => {
                (self.active_total < 4 || (self.active_total < 5 && self.active_viewer == 0))
                    && self.viewer_queue.front() == Some(&ticket)
            }
            DownloadPriority::Standard => {
                self.active_total < 4
                    && self.viewer_queue.is_empty()
                    && self.standard_queue.front() == Some(&ticket)
            }
            DownloadPriority::Thumbnail => {
                self.active_total < 4
                    && self.viewer_queue.is_empty()
                    && self.standard_queue.is_empty()
                    && self.thumbnail_queue.back() == Some(&ticket)
            }
        }
    }

    fn remove_ticket(&mut self, priority: DownloadPriority, ticket: u64) {
        let queue = match priority {
            DownloadPriority::Viewer => &mut self.viewer_queue,
            DownloadPriority::Standard => &mut self.standard_queue,
            DownloadPriority::Thumbnail => &mut self.thumbnail_queue,
        };
        queue.retain(|queued| *queued != ticket);
    }
}

pub(crate) struct DownloadSlot<'a> {
    scheduler: &'a DownloadScheduler,
    priority: DownloadPriority,
}

impl Drop for DownloadSlot<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.scheduler.state.lock() {
            state.active_total = state.active_total.saturating_sub(1);
            if self.priority == DownloadPriority::Viewer {
                state.active_viewer = state.active_viewer.saturating_sub(1);
            }
            self.scheduler.changed.notify_all();
        }
    }
}

impl DownloadScheduler {
    pub(crate) fn acquire(&self, priority: DownloadPriority) -> Result<DownloadSlot<'_>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("Download state unavailable"))?;
        let ticket = state.next_ticket;
        state.next_ticket = state.next_ticket.wrapping_add(1);
        match priority {
            DownloadPriority::Viewer => state.viewer_queue.push_back(ticket),
            DownloadPriority::Standard => state.standard_queue.push_back(ticket),
            DownloadPriority::Thumbnail => state.thumbnail_queue.push_back(ticket),
        }
        while !state.can_acquire(priority, ticket) {
            state = match self.changed.wait(state) {
                Ok(guard) => guard,
                Err(_) => return Err(anyhow!("Download state unavailable")),
            };
        }
        state.remove_ticket(priority, ticket);
        state.active_total += 1;
        if priority == DownloadPriority::Viewer {
            state.active_viewer += 1;
        }
        Ok(DownloadSlot {
            scheduler: self,
            priority,
        })
    }
}

/// Releases one reserved `preview_writes` slot when dropped.
struct PendingWrite(Arc<AtomicUsize>);

impl Drop for PendingWrite {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Service {
    fn download_slot(&self) -> Result<DownloadSlot<'_>> {
        self.downloads.acquire(DownloadPriority::Standard)
    }

    fn download_slot_with_priority(&self, priority: DownloadPriority) -> Result<DownloadSlot<'_>> {
        self.downloads.acquire(priority)
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

    /// `preview-v3:<id>:<stamp>:<size>:<crop json>:<tier>[:raw]`. Local stamps come
    /// from the file itself, so an on-disk change alters the key (and ETag)
    /// before any refresh. Remote stamps are catalog/snapshot fields; no I/O
    /// beyond SQLite and a local stat is performed.
    pub(super) fn preview_key(
        &self,
        asset: &Asset,
        tier: PreviewTier,
        uncropped: bool,
    ) -> Result<String> {
        self.preview_key_with_mode(asset, tier, uncropped, false)
    }

    pub(super) fn preview_key_with_mode(
        &self,
        asset: &Asset,
        tier: PreviewTier,
        uncropped: bool,
        prefer_raw: bool,
    ) -> Result<String> {
        let mode_suffix = if prefer_raw { ":raw" } else { "" };
        if asset.source_key.is_none() {
            return Ok(format!(
                "preview-v3:{}:{}{mode_suffix}",
                self.core.preview_fingerprint(&asset.id, uncropped)?,
                tier.as_str()
            ));
        }
        let snapshot = if self.cache.is_pinned(&asset.id)? {
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
            "preview-v3:{}:{}:{}:{}:{}{mode_suffix}",
            asset.id,
            fingerprint,
            size,
            serde_json::to_string(&if uncropped { None } else { asset.crop })?,
            tier.as_str()
        ))
    }

    pub(super) fn preview_etag_for(
        &self,
        asset: &Asset,
        tier: PreviewTier,
        uncropped: bool,
        prefer_raw: bool,
    ) -> Result<String> {
        let key = self.preview_key_with_mode(asset, tier, uncropped, prefer_raw)?;
        Ok(format!(
            "\"{}\"",
            hex::encode(Sha256::digest(key.as_bytes()))
        ))
    }

    /// Memory first, then disk. Local lookups never wait for a busy cache.
    fn stored_preview(&self, key: &str, local: bool) -> Result<Option<Arc<PreviewImage>>> {
        if let Some(image) = self.previews.get(key) {
            return Ok(Some(image));
        }
        let bytes = if local {
            self.cache.try_preview_get(key)
        } else {
            self.cache.preview_get(key)
        };
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(error) if Self::optional_preview_cache_error(&error) => None,
            Err(error) => return Err(error),
        };
        let Some(bytes) = bytes else {
            return Ok(None);
        };
        let image = Arc::new(PreviewImage::from_envelope(&bytes)?);
        self.previews.put(key.to_owned(), Arc::clone(&image));
        Ok(Some(image))
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

    /// Background local preview writes still in flight.
    pub fn pending_preview_writes(&self) -> usize {
        self.preview_writes.load(Ordering::Acquire)
    }

    /// Disk persistence is best effort for local originals. No remote slot or
    /// cache maintenance may delay returning decoded pixels.
    fn persist_local_preview(&self, key: String, image: &Arc<PreviewImage>) {
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
        if !persist {
            return;
        }
        let cache = Arc::clone(&self.cache);
        let pending = Arc::clone(&self.preview_writes);
        let image = Arc::clone(image);
        if std::thread::Builder::new()
            .name("local-preview-cache".into())
            .spawn(move || {
                // Released on unwind too, so a panicking write cannot leave
                // quiesce waiting for a write that will never finish.
                let _pending = PendingWrite(pending);
                let _ = cache.preview_put(&key, &image.to_envelope());
            })
            .is_err()
        {
            self.preview_writes.fetch_sub(1, Ordering::AcqRel);
        }
    }

    /// The single preview control flow behind `asset.preview`,
    /// remote `asset.histogram` and `Service::preview_image`.
    pub(super) fn render_preview(
        &self,
        asset: &Asset,
        tier: PreviewTier,
        uncropped: bool,
    ) -> Result<Arc<PreviewImage>> {
        self.render_preview_with_mode(asset, tier, uncropped, false)
    }

    fn try_cascade_preview(
        &self,
        asset: &Asset,
        tier: PreviewTier,
        uncropped: bool,
        prefer_raw: bool,
        local: bool,
        memory_only: bool,
    ) -> Result<Option<Arc<PreviewImage>>> {
        for higher_tier in tier.higher_standard_tiers() {
            let higher_key =
                self.preview_key_with_mode(asset, *higher_tier, uncropped, prefer_raw)?;
            let higher = if memory_only {
                self.previews.get(&higher_key)
            } else {
                self.stored_preview(&higher_key, local)?
            };
            if let Some(higher) = higher {
                if let Ok(downsampled) = neb_core::downsample_preview(&higher, tier) {
                    return Ok(Some(Arc::new(downsampled)));
                }
            }
        }
        Ok(None)
    }

    pub(super) fn render_preview_with_mode(
        &self,
        asset: &Asset,
        tier: PreviewTier,
        uncropped: bool,
        prefer_raw: bool,
    ) -> Result<Arc<PreviewImage>> {
        let key = self.preview_key_with_mode(asset, tier, uncropped, prefer_raw)?;
        if asset.source_key.is_none() {
            let local_policy = self
                .cache
                .try_preview_policy()
                .unwrap_or_else(|| "automatic".into());
            let memory_only = local_policy == "memory_only";
            if let Some(image) = if memory_only {
                self.previews.get(&key)
            } else {
                self.stored_preview(&key, true)?
            } {
                return Ok(image);
            }
            if let Some(cascaded) =
                self.try_cascade_preview(asset, tier, uncropped, prefer_raw, true, memory_only)?
            {
                self.previews.put(key.clone(), Arc::clone(&cascaded));
                if !memory_only {
                    self.persist_local_preview(key, &cascaded);
                }
                return Ok(cascaded);
            }
            let image = self
                .core
                .preview_image_with_mode(&asset.id, tier, uncropped, prefer_raw)?;
            self.previews.put(key.clone(), Arc::clone(&image));
            if !memory_only {
                self.persist_local_preview(key, &image);
            }
            return Ok(image);
        }

        let policy = self.cache.preview_policy()?;
        let memory_only = policy == "memory_only";
        if let Some(image) = if memory_only {
            self.previews.get(&key)
        } else {
            self.stored_preview(&key, false)?
        } {
            return Ok(image);
        }
        if let Some(cascaded) =
            self.try_cascade_preview(asset, tier, uncropped, prefer_raw, false, memory_only)?
        {
            if !memory_only {
                if let Err(error) = self.cache.preview_put(&key, &cascaded.to_envelope()) {
                    if !Self::optional_preview_cache_error(&error) {
                        return Err(error);
                    }
                }
            }
            self.previews.put(key, Arc::clone(&cascaded));
            return Ok(cascaded);
        }

        let priority = if tier.is_grid() {
            DownloadPriority::Thumbnail
        } else {
            DownloadPriority::Viewer
        };
        let _slot = self.download_slot_with_priority(priority)?;

        if let Some(image) = if memory_only {
            self.previews.get(&key)
        } else {
            self.stored_preview(&key, false)?
        } {
            return Ok(image);
        }
        if let Some(cascaded) =
            self.try_cascade_preview(asset, tier, uncropped, prefer_raw, false, memory_only)?
        {
            if !memory_only {
                if let Err(error) = self.cache.preview_put(&key, &cascaded.to_envelope()) {
                    if !Self::optional_preview_cache_error(&error) {
                        return Err(error);
                    }
                }
            }
            self.previews.put(key, Arc::clone(&cascaded));
            return Ok(cascaded);
        }

        let lease = self.current_original(asset)?;
        if lease.is_some() && !self.cache.is_pinned(&asset.id)? {
            self.core.refresh_asset(&asset.id)?;
            self.core.bind_original_revision(&asset.id)?;
        }

        let (image, companion_p2560) = if lease.is_some() {
            (
                self.core
                    .preview_image_with_mode(&asset.id, tier, uncropped, prefer_raw)?,
                None,
            )
        } else if prefer_raw {
            self.fallback_remote_preview(asset, tier, uncropped, true, &policy)?
        } else {
            let should_try_range = asset.kind == "raw"
                || matches!(asset.extension.as_str(), "tif" | "tiff")
                || (matches!(asset.extension.as_str(), "jpg" | "jpeg")
                    && (asset.size == 0
                        || asset.size >= JPEG_RANGE_MIN_BYTES
                        || policy == "manual"));
            if should_try_range {
                match self.range_preview_bundle(
                    asset,
                    if uncropped { None } else { asset.crop },
                    tier,
                ) {
                    Ok((primary, companion)) => (Arc::new(primary), companion),
                    Err(error) if Self::may_fallback(&error) => {
                        self.fallback_remote_preview(asset, tier, uncropped, prefer_raw, &policy)?
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
                self.fallback_remote_preview(asset, tier, uncropped, prefer_raw, &policy)?
            }
        };

        if let Some(inspection) = image.extras.get("inspection") {
            self.core.record_remote_inspection(&asset.id, inspection)?;
        }
        // Preview publication uses the current refreshed fingerprint. Callers
        // overlay live metadata, so ratings/crops/pins never come from the cache.
        let fresh = self.core.asset(&asset.id)?;
        let key = self.preview_key_with_mode(&fresh, tier, uncropped, prefer_raw)?;
        if !memory_only {
            if let Err(error) = self.cache.preview_put(&key, &image.to_envelope()) {
                if !Self::optional_preview_cache_error(&error) {
                    return Err(error);
                }
            }
        }
        self.previews.put(key, Arc::clone(&image));

        if let Some(companion) = companion_p2560 {
            let companion_key =
                self.preview_key_with_mode(&fresh, PreviewTier::P2560, uncropped, prefer_raw)?;
            let companion = Arc::new(companion);
            if !memory_only {
                let _ = self
                    .cache
                    .preview_put(&companion_key, &companion.to_envelope());
            }
            self.previews.put(companion_key, companion);
        }
        Ok(image)
    }

    fn fallback_remote_preview(
        &self,
        asset: &Asset,
        tier: PreviewTier,
        uncropped: bool,
        prefer_raw: bool,
        policy: &str,
    ) -> Result<(Arc<PreviewImage>, Option<PreviewImage>)> {
        match policy {
            "manual" => {
                self.require_automatic_download()?;
                unreachable!()
            }
            "stream_preview" | "memory_only" => {
                let (primary, companion) =
                    self.stream_remote_preview(asset, uncropped, tier, prefer_raw)?;
                Ok((Arc::new(primary), companion))
            }
            _ => {
                let _lease = self.original(asset, false)?;
                let primary = self
                    .core
                    .preview_image_with_mode(&asset.id, tier, uncropped, prefer_raw)?;
                Ok((primary, None))
            }
        }
    }

    fn stream_remote_preview(
        &self,
        asset: &Asset,
        uncropped: bool,
        tier: PreviewTier,
        prefer_raw: bool,
    ) -> Result<(PreviewImage, Option<PreviewImage>)> {
        ensure!(
            asset.size <= STREAM_PREVIEW_MAX_BYTES,
            "E_DOWNLOAD_REQUIRED: 此远程原图超过流式内存解码上限（128 MiB），可手动下载原图后预览。"
        );
        let library = self.core.library(&asset.library_id)?;
        let source = library
            .storage_id
            .as_deref()
            .context("E_NOT_FOUND: Remote library has no storage source")?;
        let key = asset
            .source_key
            .as_deref()
            .context("E_INVALID: Not a remote image")?;
        let download_bound = if asset.size == 0 {
            STREAM_PREVIEW_MAX_BYTES
        } else {
            asset.size
        };
        let reader = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .open_reader(source, key)?;
        let mut reader = BoundedImageReader {
            inner: reader,
            remaining: usize::try_from(download_bound)?,
        };
        let capacity = usize::try_from(asset.size)
            .unwrap_or(0)
            .min(16 * 1024 * 1024);
        let mut bytes = Vec::with_capacity(capacity);
        reader.read_to_end(&mut bytes)?;
        ensure!(
            asset.size == 0 || u64::try_from(bytes.len())? == asset.size,
            "E_CONFLICT: Remote original size changed; rescan the library before retrying"
        );
        let crop = if uncropped { None } else { asset.crop };
        let result =
            neb_core::stream_preview_from_bytes(&bytes, &asset.extension, crop, tier, prefer_raw)?;
        drop(bytes);
        Ok(result)
    }

    /// IPC shape: preview metadata, its tier and live asset metadata; no pixels.
    fn preview_value(&self, asset: &Asset, params: &Value) -> Result<Value> {
        let (tier, uncropped, prefer_raw) = preview_request_with_mode(params)?;
        let image = self.render_preview_with_mode(asset, tier, uncropped, prefer_raw)?;
        let mut value = image.meta();
        value["tier"] = json!(tier.as_str());
        value["asset"] = self.asset_value(&self.core.asset(&asset.id)?)?;
        Ok(value)
    }

    fn range_preview_bundle(
        &self,
        asset: &Asset,
        crop: Option<neb_core::Crop>,
        tier: PreviewTier,
    ) -> Result<(PreviewImage, Option<PreviewImage>)> {
        ensure!(
            asset.kind == "raw"
                || matches!(asset.extension.as_str(), "tif" | "tiff" | "jpg" | "jpeg"),
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
        let result = neb_core::remote_preview_bundle(
            &mut reader,
            identity.length,
            &asset.extension,
            crop,
            tier,
        );
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

    /// Serializes every operation on one asset, in-process and across processes.
    pub(super) fn with_asset_operation<T>(
        &self,
        id: &str,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
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
        operation()
    }

    /// Local originals are re-inspected before reading, as for `asset.preview`.
    pub(super) fn preview_asset(&self, id: &str) -> Result<Asset> {
        let asset = self.core.asset(id)?;
        if asset.source_key.is_none() {
            return self.refresh_local(asset, false);
        }
        Ok(asset)
    }

    pub(super) fn asset_dispatch(&self, command: &str, params: Value) -> Result<Value> {
        let id = string(&params, "id")?.to_owned();
        self.with_asset_operation(&id, || self.asset_command(&id, command, params))
    }

    fn asset_command(&self, id: &str, command: &str, params: Value) -> Result<Value> {
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
            "asset.preview" => self.preview_value(&asset, &params),
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
            "asset.histogram" if asset.source_key.is_none() => {
                // From the viewer tier the window already shows (cached on disk after the
                // first view), then from memory: a RAW is never demosaiced twice for this.
                let (_, uncropped) = preview_request(&params)?;
                let key = self.preview_key(&asset, PreviewTier::P2560, uncropped)?;
                if let Some(hit) = self.histograms.get(&key) {
                    return Ok(hit);
                }
                let image = self.render_preview(&asset, PreviewTier::P2560, uncropped)?;
                let histogram = neb_core::histogram_from_jpeg(&image.jpeg, &image.source)?;
                self.histograms.put(key, histogram.clone());
                Ok(histogram)
            }
            "asset.histogram" if asset.source_key.is_some() => {
                let (_, uncropped) = preview_request(&params)?;
                let key = self.preview_key(&asset, PreviewTier::P2560, uncropped)?;
                if let Some(mut hit) = self.histograms.get(&key) {
                    hit["asset"] = self.asset_value(&self.core.asset(id)?)?;
                    return Ok(hit);
                }
                let image = self.render_preview(&asset, PreviewTier::P2560, uncropped)?;
                let mut histogram = if let Some(histogram) = image.extras.get("histogram") {
                    histogram.clone()
                } else {
                    neb_core::histogram_from_jpeg(&image.jpeg, &image.source)?
                };
                let fresh = self.core.asset(id)?;
                let fresh_key = self.preview_key(&fresh, PreviewTier::P2560, uncropped)?;
                self.histograms.put(fresh_key, histogram.clone());
                histogram["asset"] = self.asset_value(&fresh)?;
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
            "asset.rate" | "asset.flag" | "asset.label" | "asset.crop" | "asset.reset_crop" => {
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

/// `tier` wins; legacy `max_size` maps to the smallest covering tier.
fn preview_request(params: &Value) -> Result<(PreviewTier, bool)> {
    let (tier, uncropped, _) = preview_request_with_mode(params)?;
    Ok((tier, uncropped))
}

fn preview_request_with_mode(params: &Value) -> Result<(PreviewTier, bool, bool)> {
    let tier = match (params.get("tier"), params.get("max_size")) {
        (Some(tier), _) => tier
            .as_str()
            .and_then(PreviewTier::parse)
            .context("E_INVALID: Unknown preview tier")?,
        (None, Some(max_size)) => {
            let max_size = max_size
                .as_u64()
                .context("E_INVALID: max_size must be an integer")?;
            ensure!(
                (32..=4096).contains(&max_size),
                "E_INVALID: Preview max_size must be between 32 and 4096"
            );
            PreviewTier::for_max_size(max_size as u32)
        }
        (None, None) => PreviewTier::P2560,
    };
    let uncropped = params
        .get("uncropped")
        .map(|v| v.as_bool().context("E_INVALID: uncropped must be boolean"))
        .transpose()?
        .unwrap_or(false);
    let prefer_raw = params
        .get("prefer_raw")
        .map(|v| v.as_bool().context("E_INVALID: prefer_raw must be boolean"))
        .transpose()?
        .unwrap_or(false);
    Ok((tier, uncropped, prefer_raw))
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

#[cfg(test)]
mod pending_write_tests {
    use super::*;

    #[test]
    fn pending_write_is_released_when_the_writer_panics() {
        let pending = Arc::new(AtomicUsize::new(1));
        let guard = PendingWrite(Arc::clone(&pending));
        let result = std::thread::spawn(move || {
            let _pending = guard;
            panic!("preview write failed");
        })
        .join();
        assert!(result.is_err());
        assert_eq!(pending.load(Ordering::Acquire), 0);
    }

    #[test]
    fn quiesce_times_out_while_a_preview_write_is_held() {
        let data = tempfile::tempdir().unwrap();
        let service = Service::open(data.path()).unwrap();
        service.preview_writes.fetch_add(1, Ordering::AcqRel);
        let held = PendingWrite(Arc::clone(&service.preview_writes));
        let report = service
            .quiesce(std::time::Duration::from_millis(120))
            .unwrap();
        assert!(report.timed_out);
        assert_eq!(report.pending_writes, 1);
        drop(held);
        let report = service
            .quiesce(std::time::Duration::from_millis(120))
            .unwrap();
        assert!(!report.timed_out);
        assert_eq!(report.pending_writes, 0);
    }
}

#[cfg(test)]
mod scheduler_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn viewer_has_interactive_burst_slot_and_thumbnails_wake_lifo() {
        let scheduler = Arc::new(DownloadScheduler::default());
        let g1 = scheduler.acquire(DownloadPriority::Thumbnail).unwrap();
        let g2 = scheduler.acquire(DownloadPriority::Thumbnail).unwrap();
        let g3 = scheduler.acquire(DownloadPriority::Thumbnail).unwrap();
        let g4 = scheduler.acquire(DownloadPriority::Thumbnail).unwrap();
        // Even with 4 thumbnails active, 1 interactive Viewer slot succeeds immediately!
        let gv1 = scheduler.acquire(DownloadPriority::Viewer).unwrap();

        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let spawn_waiter = |prio: DownloadPriority, label: &'static str, expected_q: usize| {
            let sched = Arc::clone(&scheduler);
            let ord = Arc::clone(&order);
            let handle = std::thread::spawn(move || {
                let _slot = sched.acquire(prio).unwrap();
                ord.lock().unwrap().push(label);
                std::thread::sleep(Duration::from_millis(15));
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                let st = scheduler.state.lock().unwrap();
                let q_len = match prio {
                    DownloadPriority::Viewer => st.viewer_queue.len(),
                    DownloadPriority::Standard => st.standard_queue.len(),
                    DownloadPriority::Thumbnail => st.thumbnail_queue.len(),
                };
                drop(st);
                if q_len >= expected_q {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "waiter {label} did not queue"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            handle
        };

        let t1 = spawn_waiter(DownloadPriority::Thumbnail, "T1", 1);
        let t2 = spawn_waiter(DownloadPriority::Thumbnail, "T2", 2);
        let t3 = spawn_waiter(DownloadPriority::Thumbnail, "T3", 3);
        let s1 = spawn_waiter(DownloadPriority::Standard, "S1", 1);
        let v2 = spawn_waiter(DownloadPriority::Viewer, "V2", 1);

        // Release 1 slot at a time so wake order is strictly serialized:
        // First drop gv1 -> active_total becomes 4, active_viewer becomes 0 -> V2 wakes immediately!
        drop(gv1);
        v2.join().unwrap();

        // Now active_total is 4 (g1..g4). Drop g4 -> active_total becomes 3 -> S1 wakes before thumbnails!
        drop(g4);
        s1.join().unwrap();

        // Now drop g3 -> T3 (most recent LIFO thumbnail) wakes before T2 and T1!
        drop(g3);
        t3.join().unwrap();
        t2.join().unwrap();
        t1.join().unwrap();
        drop((g1, g2));

        assert_eq!(*order.lock().unwrap(), vec!["V2", "S1", "T3", "T2", "T1"]);
    }
}
