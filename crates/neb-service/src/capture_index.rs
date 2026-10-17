//! Explicit background EXIF indexing. No image decoding, original publication,
//! global catalog lease, or preview/download queue is involved.
use super::*;
use neb_core::{capture_time, Asset};
use serde::Serialize;
use std::io::Cursor;

#[derive(Default)]
pub(super) struct CaptureIndexController {
    jobs: Mutex<HashMap<String, Arc<Mutex<CaptureJob>>>>,
}

#[derive(Clone, Serialize)]
struct CaptureJob {
    id: String,
    library_id: String,
    status: String,
    total: usize,
    processed: usize,
    found: usize,
    missing: usize,
    failed: usize,
    error: Option<String>,
}
impl CaptureJob {
    fn running(&self) -> bool {
        matches!(self.status.as_str(), "running" | "stopping")
    }
}

struct IndexContext {
    core: Arc<Core>,
    storage: Arc<Mutex<StorageRegistry>>,
    cache: Arc<CacheManager>,
    asset_operations: AssetOperations,
    data_dir: PathBuf,
}

impl Service {
    pub(super) fn capture_index_status(&self, id: &str) -> Result<Value> {
        let mut stats = self.core.capture_index_stats(id)?;
        let job = self
            .capture_index
            .jobs
            .lock()
            .map_err(|_| anyhow!("Capture index state unavailable"))?
            .get(id)
            .cloned();
        stats["library_id"] = json!(id);
        stats["job"] = match job {
            Some(job) => serde_json::to_value(
                &*job
                    .lock()
                    .map_err(|_| anyhow!("Capture index state unavailable"))?,
            )?,
            None => Value::Null,
        };
        Ok(stats)
    }

    pub(super) fn start_capture_index(&self, id: &str) -> Result<Value> {
        let library = self.core.library(id)?;
        let mut jobs = self
            .capture_index
            .jobs
            .lock()
            .map_err(|_| anyhow!("Capture index state unavailable"))?;
        for (library_id, job) in jobs.iter() {
            if job
                .lock()
                .map_err(|_| anyhow!("Capture index state unavailable"))?
                .running()
            {
                if library_id == id {
                    drop(jobs);
                    return self.capture_index_status(id);
                }
                anyhow::bail!("E_IN_USE: 另一图片库正在索引拍摄时间，请等待完成或先停止。")
            }
        }
        let candidates = self.core.capture_index_candidates(id)?;
        let job = Arc::new(Mutex::new(CaptureJob {
            id: format!(
                "capture-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos()
            ),
            library_id: id.to_owned(),
            status: if candidates.is_empty() {
                "completed"
            } else {
                "running"
            }
            .into(),
            total: candidates.len(),
            processed: 0,
            found: 0,
            missing: 0,
            failed: 0,
            error: None,
        }));
        jobs.insert(id.to_owned(), Arc::clone(&job));
        drop(jobs);
        if !candidates.is_empty() {
            let context = IndexContext {
                core: Arc::clone(&self.core),
                storage: Arc::clone(&self.storage),
                cache: Arc::clone(&self.cache),
                asset_operations: Arc::clone(&self.asset_operations),
                data_dir: self.data_dir.clone(),
            };
            let state = Arc::clone(&job);
            if let Err(error) = std::thread::Builder::new()
                .name("capture-time-index".into())
                .spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        context.run(&library, candidates, &state)
                    }));
                    if let Ok(mut job) = state.lock() {
                        job.status = match result {
                            Ok(Ok(())) if job.status == "stopping" => "cancelled".into(),
                            Ok(Ok(())) if job.failed > 0 => "failed".into(),
                            Ok(Ok(())) => "completed".into(),
                            Ok(Err(error)) => {
                                job.error = Some(format!("{error:#}"));
                                "failed".into()
                            }
                            Err(_) => {
                                job.error =
                                    Some("拍摄时间索引意外停止；已完成的结果保留，可重试。".into());
                                "failed".into()
                            }
                        };
                    }
                })
            {
                let mut job = job
                    .lock()
                    .map_err(|_| anyhow!("Capture index state unavailable"))?;
                job.status = "failed".into();
                job.error = Some(error.to_string());
            }
        }
        self.capture_index_status(id)
    }

    pub(super) fn cancel_capture_index(&self, id: &str, job_id: &str) -> Result<Value> {
        let job = self
            .capture_index
            .jobs
            .lock()
            .map_err(|_| anyhow!("Capture index state unavailable"))?
            .get(id)
            .cloned()
            .context("E_NOT_FOUND: Capture index task does not exist")?;
        {
            let mut job = job
                .lock()
                .map_err(|_| anyhow!("Capture index state unavailable"))?;
            ensure!(
                job.id == job_id,
                "E_CONFLICT: Capture index task changed; refresh its state"
            );
            if job.running() {
                job.status = "stopping".into();
            }
        }
        self.capture_index_status(id)
    }
}

impl IndexContext {
    fn run(
        &self,
        library: &Library,
        candidates: Vec<Asset>,
        state: &Mutex<CaptureJob>,
    ) -> Result<()> {
        for candidate in candidates {
            if state
                .lock()
                .map_err(|_| anyhow!("Capture index state unavailable"))?
                .status
                == "stopping"
            {
                return Ok(());
            }
            // Only this library is leased while reading one header. A rebind is
            // checked before every item and cannot accept a result for its old root.
            let _library = process_library_lock(&self.data_dir, &library.id, false)?;
            let current = self.core.library(&library.id)?;
            ensure!(
                current.root == library.root
                    && current.storage_id == library.storage_id
                    && current.source_prefix == library.source_prefix,
                "E_CONFLICT: 图库来源已变更，拍摄时间索引已停止。请在新位置重新开始。"
            );
            let asset_lock = {
                let mut locks = self
                    .asset_operations
                    .lock()
                    .map_err(|_| anyhow!("Asset operation state unavailable"))?;
                Arc::clone(
                    locks
                        .entry(candidate.id.clone())
                        .or_insert_with(|| Arc::new(Mutex::new(()))),
                )
            };
            let _asset = asset_lock
                .lock()
                .map_err(|_| anyhow!("Asset operation state unavailable"))?;
            let lock_root = self.data_dir.join("catalog/asset-locks");
            fs::create_dir_all(&lock_root)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(lock_root.join(format!(
                    "{}.lock",
                    hex::encode(Sha256::digest(candidate.id.as_bytes()))
                )))?;
            lock.lock()?;
            let _process_asset = ProcessCatalogGuard(lock);
            // Cancellation may arrive while this item waits for another
            // process or a viewer holding its asset/library lease. Such an
            // item has not begun reading and must not start another request.
            if state
                .lock()
                .map_err(|_| anyhow!("Capture index state unavailable"))?
                .status
                == "stopping"
            {
                return Ok(());
            }
            let result = (|| -> Result<Option<bool>> {
                let asset = self.core.asset(&candidate.id)?;
                if asset.capture_status != "pending" {
                    return Ok(None);
                }
                let fingerprint = self.core.asset_fingerprint(&asset.id)?;
                let capture = self.read(&asset, library)?;
                // The user may stop during a network call; preserve the valid
                // current result, then stop before issuing another request.
                if !self
                    .core
                    .record_capture_time(&asset.id, &fingerprint, &capture)?
                {
                    return Ok(None);
                }
                Ok(Some(!capture.captured_at.is_empty()))
            })();
            let mut job = state
                .lock()
                .map_err(|_| anyhow!("Capture index state unavailable"))?;
            job.processed += 1;
            match result {
                Ok(Some(true)) => job.found += 1,
                Ok(Some(false)) => job.missing += 1,
                Ok(None) => {}
                Err(error) => {
                    job.failed += 1;
                    if job.error.is_none() {
                        job.error = Some(format!("{error:#}"));
                    }
                    if candidate.source_key.is_some() && remote_connection_failed(&error) {
                        return Err(error);
                    }
                }
            }
        }
        Ok(())
    }

    fn read(&self, asset: &Asset, library: &Library) -> Result<capture_time::CaptureTime> {
        if asset.source_key.is_none() {
            return self.core.read_local_capture_time(&asset.id);
        }
        if self.core.original_revision_current(&asset.id)? {
            if let Ok(Some(lease)) = self.cache.acquire_original(&asset.id) {
                return capture_time::read_path(lease.path());
            }
        }
        // Known non-EXIF containers need no remote bytes.
        if !matches!(asset.extension.as_str(), "jpg" | "jpeg" | "tif" | "tiff")
            && asset.kind != "raw"
        {
            return Ok(capture_time::CaptureTime {
                captured_at: String::new(),
                metadata: Default::default(),
                status: capture_time::CaptureStatus::Unsupported,
            });
        }
        let source = library
            .storage_id
            .as_deref()
            .context("E_NOT_FOUND: Remote library has no source")?;
        let key = asset
            .source_key
            .as_deref()
            .context("E_INVALID: Not a remote asset")?;
        let mut reader = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .open_range_reader(source, key)?;
        let ranged = (|| {
            let identity = reader.metadata()?;
            ensure!(
                asset.size == 0 || identity.length == asset.size,
                "E_CONFLICT: Remote file size changed; scan the library before retrying"
            );
            let capture = capture_time::read(&mut reader, identity.length)?;
            reader.metadata()?;
            Ok(capture)
        })();
        match ranged {
            Ok(capture) => Ok(capture),
            Err(error) if Service::may_fallback(&error) => {
                // One HTTP response is one source snapshot. The prefix is never
                // combined with another response or persisted as an original.
                let mut stream = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?
                    .open_reader(source, key)?;
                let mut prefix = Vec::new();
                loop {
                    let previous = prefix.len();
                    (&mut stream).take(64 * 1024).read_to_end(&mut prefix)?;
                    let length = prefix.len() as u64;
                    ensure!(
                        prefix.len() - previous == 64 * 1024
                            || asset.size == 0
                            || length >= asset.size,
                        "E_CONFLICT: Remote response ended before the scanned file size; scan the library before retrying"
                    );
                    match capture_time::read(&mut Cursor::new(prefix.as_slice()), length) {
                        Ok(capture) => return Ok(capture),
                        Err(error) if prefix.len() == previous || prefix.len() >= 1024 * 1024 => {
                            return Err(error)
                        }
                        Err(_) => {}
                    }
                }
            }
            Err(error) => Err(error),
        }
    }
}

fn remote_connection_failed(error: &anyhow::Error) -> bool {
    for cause in error.chain() {
        let range = cause
            .downcast_ref::<neb_storage::RangeReadError>()
            .or_else(|| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .and_then(neb_storage::RangeReadError::from_io)
            });
        if matches!(
            range,
            Some(
                neb_storage::RangeReadError::Transport
                    | neb_storage::RangeReadError::HttpStatus(401 | 403)
            )
        ) {
            return true;
        }
    }
    let message = error.to_string();
    message.contains("Remote file request failed") || message.contains("E_CREDENTIAL")
}
