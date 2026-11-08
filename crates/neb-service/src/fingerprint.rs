//! Explicit "build content fingerprints" task. Reads each original once to record
//! its SHA-256 so imports can de-duplicate by content instead of by name. Remote
//! libraries download every unhashed file in full; nothing is added to the cache
//! and no preview work is queued. Originals are only read, never written.
use super::*;
use anyhow::bail;
use neb_core::Asset;
use neb_storage::hash_reader;

#[derive(Default)]
pub(super) struct FingerprintController {
    jobs: Mutex<HashMap<String, Arc<Mutex<FingerprintJob>>>>,
}

#[derive(Clone, Serialize)]
struct FingerprintJob {
    id: String,
    library_id: String,
    status: String,
    total: usize,
    processed: usize,
    hashed: usize,
    failed: usize,
    bytes_read: u64,
    error: Option<String>,
}

impl FingerprintJob {
    fn running(&self) -> bool {
        matches!(self.status.as_str(), "running" | "stopping")
    }
}

struct FingerprintContext {
    core: Arc<Core>,
    storage: Arc<Mutex<StorageRegistry>>,
    cache: Arc<CacheManager>,
    data_dir: PathBuf,
}

impl Service {
    pub(super) fn fingerprint_status(&self, id: &str) -> Result<Value> {
        let mut stats = self.core.fingerprint_stats(id)?;
        let job = self
            .fingerprints
            .jobs
            .lock()
            .map_err(|_| anyhow!("Fingerprint state unavailable"))?
            .get(id)
            .cloned();
        stats["library_id"] = json!(id);
        stats["remote"] = json!(self.core.library(id)?.storage_id.is_some_and(|source| self
            .source(&source)
            .is_ok_and(|source| source.kind != "local")));
        stats["job"] = match job {
            Some(job) => serde_json::to_value(
                &*job
                    .lock()
                    .map_err(|_| anyhow!("Fingerprint state unavailable"))?,
            )?,
            None => Value::Null,
        };
        Ok(stats)
    }

    pub(super) fn start_fingerprints(&self, id: &str) -> Result<Value> {
        let library = self.core.library(id)?;
        let mut jobs = self
            .fingerprints
            .jobs
            .lock()
            .map_err(|_| anyhow!("Fingerprint state unavailable"))?;
        for (library_id, job) in jobs.iter() {
            if job
                .lock()
                .map_err(|_| anyhow!("Fingerprint state unavailable"))?
                .running()
            {
                if library_id == id {
                    drop(jobs);
                    return self.fingerprint_status(id);
                }
                bail!("E_IN_USE: 另一图片库正在建立内容指纹，请等待完成或先停止。")
            }
        }
        let candidates = self.core.fingerprint_candidates(id)?;
        let job = Arc::new(Mutex::new(FingerprintJob {
            id: format!(
                "fingerprint-{}-{}",
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
            hashed: 0,
            failed: 0,
            bytes_read: 0,
            error: None,
        }));
        jobs.insert(id.to_owned(), Arc::clone(&job));
        drop(jobs);
        if !candidates.is_empty() {
            let context = FingerprintContext {
                core: Arc::clone(&self.core),
                storage: Arc::clone(&self.storage),
                cache: Arc::clone(&self.cache),
                data_dir: self.data_dir.clone(),
            };
            let state = Arc::clone(&job);
            if let Err(error) = std::thread::Builder::new()
                .name("content-fingerprints".into())
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
                                    Some("内容指纹任务意外停止；已完成的结果保留，可重试。".into());
                                "failed".into()
                            }
                        };
                    }
                })
            {
                let mut job = job
                    .lock()
                    .map_err(|_| anyhow!("Fingerprint state unavailable"))?;
                job.status = "failed".into();
                job.error = Some(error.to_string());
            }
        }
        self.fingerprint_status(id)
    }

    pub(super) fn cancel_fingerprints(&self, id: &str, job_id: &str) -> Result<Value> {
        let job = self
            .fingerprints
            .jobs
            .lock()
            .map_err(|_| anyhow!("Fingerprint state unavailable"))?
            .get(id)
            .cloned()
            .context("E_NOT_FOUND: Fingerprint task does not exist")?;
        {
            let mut job = job
                .lock()
                .map_err(|_| anyhow!("Fingerprint state unavailable"))?;
            ensure!(
                job.id == job_id,
                "E_CONFLICT: Fingerprint task changed; refresh its state"
            );
            if job.running() {
                job.status = "stopping".into();
            }
        }
        self.fingerprint_status(id)
    }
}

impl FingerprintContext {
    fn stopping(state: &Mutex<FingerprintJob>) -> Result<bool> {
        Ok(state
            .lock()
            .map_err(|_| anyhow!("Fingerprint state unavailable"))?
            .status
            == "stopping")
    }

    fn run(
        &self,
        library: &Library,
        candidates: Vec<Asset>,
        state: &Mutex<FingerprintJob>,
    ) -> Result<()> {
        for candidate in candidates {
            if Self::stopping(state)? {
                return Ok(());
            }
            // Only this library is leased per item; a rebind stops the task.
            let _library = process_library_lock(&self.data_dir, &library.id, false)?;
            let current = self.core.library(&library.id)?;
            ensure!(
                current.root == library.root
                    && current.storage_id == library.storage_id
                    && current.source_prefix == library.source_prefix,
                "E_CONFLICT: 图库来源已变更，内容指纹任务已停止。"
            );
            let result = (|| -> Result<Option<u64>> {
                let asset = self.core.asset(&candidate.id)?;
                let fingerprint = self.core.asset_fingerprint(&asset.id)?;
                let (size, sha256) = self.hash(&asset, library)?;
                // A file replaced during the read is not recorded.
                if !self
                    .core
                    .record_asset_sha256(&asset.id, &fingerprint, size, &sha256)?
                {
                    return Ok(None);
                }
                Ok(Some(size))
            })();
            let mut job = state
                .lock()
                .map_err(|_| anyhow!("Fingerprint state unavailable"))?;
            job.processed += 1;
            match result {
                Ok(Some(size)) => {
                    job.hashed += 1;
                    job.bytes_read += size;
                }
                Ok(None) => {}
                Err(error) => {
                    job.failed += 1;
                    job.error = Some(format!("{}: {error:#}", candidate.filename));
                    // A connection that is gone will fail every item; stop early.
                    let text = format!("{error:#}");
                    if text.contains("E_OFFLINE")
                        || matches!(
                            neb_storage::classify(&error),
                            neb_storage::Availability::Offline
                                | neb_storage::Availability::AuthRequired
                                | neb_storage::Availability::TrustRequired
                        )
                    {
                        bail!("{text}");
                    }
                }
            }
        }
        Ok(())
    }

    fn hash(&self, asset: &Asset, library: &Library) -> Result<(u64, String)> {
        if asset.source_key.is_none() {
            let path = self.core.local_original_path(&asset.id)?;
            return hash_reader(&mut File::open(path)?);
        }
        // A current cached original avoids a second download.
        if self.core.original_revision_current(&asset.id)? {
            if let Ok(Some(lease)) = self.cache.acquire_original(&asset.id) {
                return hash_reader(&mut File::open(lease.path())?);
            }
        }
        let source = library
            .storage_id
            .as_deref()
            .context("E_NOT_FOUND: Remote library has no source")?;
        let key = asset
            .source_key
            .as_deref()
            .context("E_INVALID: Not a remote asset")?;
        // Streamed straight into the hasher: no cache object, no temporary file.
        let mut reader = self
            .storage
            .lock()
            .map_err(|_| anyhow!("Storage state unavailable"))?
            .open_reader(source, key)?;
        let (size, sha256) = hash_reader(&mut reader)?;
        ensure!(
            asset.size == 0 || size == asset.size,
            "E_CONFLICT: Remote file size changed; scan the library before retrying"
        );
        Ok((size, sha256))
    }
}
