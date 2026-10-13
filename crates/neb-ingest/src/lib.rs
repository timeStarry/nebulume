//! Verified, non-destructive local/SD-card import with restart-safe file results.
use anyhow::{bail, Context, Result};
use chrono::Utc;
use neb_storage::{
    atomic_json, hash_reader, open_scoped, safe_join, validate_key, PreparedDestination,
    ScopedDestination,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportItem {
    pub source: String,
    /// Destination path relative to the destination root; never the source key.
    pub relative_path: String,
    pub size: u64,
    pub status: String,
    pub sha256: String,
    pub date_source: String,
    pub duplicate_path: Option<String>,
    pub source_relative_path: String,
    pub modified_nanos: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportPlan {
    pub id: String,
    pub source: String,
    pub destination: String,
    pub layout: String,
    pub deduplicate: bool,
    pub items: Vec<ImportItem>,
    pub total_bytes: u64,
    pub duplicate_count: usize,
    pub warnings: Vec<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ItemResult {
    pub source: String,
    pub destination: String,
    pub status: String,
    pub size: u64,
    pub sha256: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportResult {
    pub id: String,
    pub plan_id: String,
    pub source: String,
    pub destination: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub total: usize,
    pub copied: usize,
    pub duplicates: usize,
    pub failed: usize,
    pub items: Vec<ItemResult>,
    pub originals_retained: bool,
}

struct ReviewedImport {
    plan: ImportPlan,
    destination: PreparedDestination,
}
pub struct IngestService {
    history_dir: PathBuf,
    plans: HashMap<String, ReviewedImport>,
}

impl IngestService {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        let history_dir = data_dir.as_ref().join("imports");
        fs::create_dir_all(&history_dir)?;
        Ok(Self {
            history_dir,
            plans: HashMap::new(),
        })
    }

    /// A folder is a source, whether removable, mounted, or selected manually.
    /// Planning is read-only and does not register or modify a card.
    pub fn plan(
        &mut self,
        source: impl AsRef<Path>,
        destination: impl AsRef<Path>,
        layout: &str,
        deduplicate: bool,
    ) -> Result<ImportPlan> {
        if !["preserve", "date"].contains(&layout) {
            bail!("Layout must be preserve or date");
        }
        let source = fs::canonicalize(source.as_ref()).context("Import source is unavailable")?;
        if !source.is_dir() {
            bail!("Import source must be a directory");
        }
        let destination = prospective_root(destination.as_ref())?;
        if destination.starts_with(&source) || source.starts_with(&destination) {
            bail!("Import source and destination must be separate directory trees");
        }
        let destination_capability = PreparedDestination::new(&destination)?;
        let mut warnings = Vec::new();
        let source_files = discover(&source, &mut warnings)?;
        let destination_files = if deduplicate && destination.is_dir() {
            discover(&destination, &mut warnings)?
        } else {
            Vec::new()
        };
        let mut destination_by_size: HashMap<u64, Vec<String>> = HashMap::new();
        for key in destination_files {
            match safe_join(&destination, &key, false).and_then(|p| Ok(fs::metadata(p)?.len())) {
                Ok(size) => destination_by_size.entry(size).or_default().push(key),
                Err(error) => warnings.push(format!("Cannot inspect destination {key}: {error}")),
            }
        }
        let mut destination_hashes: HashMap<String, String> = HashMap::new();
        let mut batch_hashes: HashMap<String, String> = HashMap::new();
        let mut items = Vec::new();
        let mut total_bytes = 0;
        let mut duplicate_count = 0;
        for key in source_files {
            let inspect = (|| -> Result<ImportItem> {
                let mut file = open_scoped(&source, &key)?;
                let metadata = file.metadata()?;
                let modified = modified_nanos(&metadata)?;
                let (size, sha256) = hash_reader(&mut file)?;
                let after = file.metadata()?;
                if size != metadata.len()
                    || size != after.len()
                    || modified != modified_nanos(&after)?
                {
                    bail!("Source changed during planning");
                }
                let (relative_path, date_source) = if layout == "date" {
                    let date = capture_day(&source, &key);
                    let source = if date.is_some() { "exif" } else { "unknown" };
                    (
                        format!(
                            "{}/{}",
                            date.unwrap_or_else(|| "unknown-date".to_string()),
                            Path::new(&key)
                                .file_name()
                                .context("Missing filename")?
                                .to_string_lossy()
                        ),
                        source.to_string(),
                    )
                } else {
                    (key.clone(), "preserved".to_string())
                };
                let mut duplicate_path = None;
                if let Some(candidates) = destination_by_size.get(&size) {
                    for candidate in candidates {
                        let candidate_hash = if let Some(hash) = destination_hashes.get(candidate) {
                            Some(hash.clone())
                        } else {
                            match open_scoped(&destination, candidate)
                                .and_then(|mut f| hash_reader(&mut f))
                            {
                                Ok((_, hash)) => {
                                    destination_hashes.insert(candidate.clone(), hash.clone());
                                    Some(hash)
                                }
                                Err(error) => {
                                    warnings.push(format!(
                                        "Cannot verify destination {candidate}: {error}"
                                    ));
                                    None
                                }
                            }
                        };
                        if candidate_hash.as_deref() == Some(&sha256) {
                            duplicate_path = Some(candidate.clone());
                            break;
                        }
                    }
                }
                if deduplicate && duplicate_path.is_none() {
                    duplicate_path = batch_hashes.get(&sha256).cloned();
                }
                if deduplicate {
                    batch_hashes.entry(sha256.clone()).or_insert_with(|| {
                        duplicate_path
                            .clone()
                            .unwrap_or_else(|| relative_path.clone())
                    });
                }
                Ok(ImportItem {
                    source: source.join(&key).to_string_lossy().into_owned(),
                    relative_path,
                    size,
                    status: if duplicate_path.is_some() {
                        "duplicate"
                    } else {
                        "pending"
                    }
                    .to_string(),
                    sha256,
                    date_source,
                    duplicate_path,
                    source_relative_path: key.clone(),
                    modified_nanos: modified,
                })
            })();
            match inspect {
                Ok(item) => {
                    if item.status == "duplicate" {
                        duplicate_count += 1;
                    } else {
                        total_bytes += item.size;
                    }
                    items.push(item);
                }
                Err(error) => warnings.push(format!("Skipped {key}: {error}")),
            }
        }
        let plan = ImportPlan {
            id: Uuid::new_v4().to_string(),
            source: source.to_string_lossy().into_owned(),
            destination: destination.to_string_lossy().into_owned(),
            layout: layout.to_string(),
            deduplicate,
            items,
            total_bytes,
            duplicate_count,
            warnings,
            created_at: Utc::now().to_rfc3339(),
        };
        // Bound stale review snapshots; application can always make another plan.
        if self.plans.len() >= 32 {
            self.plans.clear();
        }
        self.plans.insert(
            plan.id.clone(),
            ReviewedImport {
                plan: plan.clone(),
                destination: destination_capability,
            },
        );
        Ok(plan)
    }

    pub fn execute(&mut self, plan_id: &str) -> Result<ImportResult> {
        let reviewed = self
            .plans
            .get(plan_id)
            .context("Plan not found; review a fresh import plan")?;
        let plan = reviewed.plan.clone();
        let source = Path::new(&plan.source);
        let destination = Path::new(&plan.destination);
        if fs::canonicalize(source)? != source || prospective_root(destination)? != destination {
            bail!("Import roots changed after planning");
        }
        let mut result = ImportResult {
            id: Uuid::new_v4().to_string(),
            plan_id: plan.id.clone(),
            source: plan.source.clone(),
            destination: plan.destination.clone(),
            status: "running".to_string(),
            started_at: Utc::now().to_rfc3339(),
            finished_at: None,
            total: plan.items.len(),
            copied: 0,
            duplicates: 0,
            failed: 0,
            items: Vec::new(),
            originals_retained: true,
        };
        let journal_path = self.history_dir.join(format!("{}.json", result.id));
        atomic_json(&journal_path, &result)?;
        let scoped_destination = reviewed.destination.materialize()?;
        let mut verified_batch: HashMap<String, String> = HashMap::new();
        for item in &plan.items {
            let item_result = match execute_item(
                source,
                destination,
                &scoped_destination,
                item,
                plan.deduplicate,
                verified_batch.get(&item.sha256).map(String::as_str),
            ) {
                Ok(item_result) => {
                    if let Ok(key) = Path::new(&item_result.destination).strip_prefix(destination) {
                        verified_batch.insert(
                            item.sha256.clone(),
                            key.to_string_lossy().replace('\\', "/"),
                        );
                    }
                    if item_result.status == "duplicate" {
                        result.duplicates += 1;
                    } else {
                        result.copied += 1;
                    }
                    item_result
                }
                Err(error) => {
                    result.failed += 1;
                    ItemResult {
                        source: item.source.clone(),
                        destination: destination
                            .join(&item.relative_path)
                            .to_string_lossy()
                            .into_owned(),
                        status: "failed".to_string(),
                        size: item.size,
                        sha256: None,
                        error: Some(error.to_string()),
                    }
                }
            };
            result.items.push(item_result);
            // Each completed file is durable. A restart re-plans and re-verifies actual files.
            atomic_json(&journal_path, &result)?;
        }
        result.status = if result.failed == 0 {
            "completed"
        } else if result.copied + result.duplicates == 0 {
            "failed"
        } else {
            "partial"
        }
        .to_string();
        result.finished_at = Some(Utc::now().to_rfc3339());
        atomic_json(&journal_path, &result)?;
        Ok(result)
    }

    pub fn history(&self) -> Result<Vec<ImportResult>> {
        let mut history = Vec::new();
        for entry in fs::read_dir(&self.history_dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let mut result: ImportResult = serde_json::from_slice(&fs::read(entry.path())?)
                .context("Import journal is damaged")?;
            if result.status == "running" {
                result.status = "interrupted".to_string();
            }
            history.push(result);
        }
        history.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(history)
    }
}

fn execute_item(
    source: &Path,
    destination: &Path,
    scoped: &ScopedDestination,
    item: &ImportItem,
    deduplicate: bool,
    batch_duplicate: Option<&str>,
) -> Result<ItemResult> {
    validate_key(&item.source_relative_path, false)?;
    validate_key(&item.relative_path, false)?;
    let mut source_file = open_scoped(source, &item.source_relative_path)?;
    let metadata = source_file.metadata()?;
    if metadata.len() != item.size || modified_nanos(&metadata)? != item.modified_nanos {
        bail!("Source changed after planning; create a fresh plan");
    }
    let (size, hash) = hash_reader(&mut source_file)?;
    if size != item.size || hash != item.sha256 {
        bail!("Source content changed after planning");
    }
    if deduplicate {
        for key in batch_duplicate
            .into_iter()
            .chain(item.duplicate_path.as_deref())
        {
            if existing_matches(scoped, key, item) {
                return Ok(success(item, destination.join(key), "duplicate"));
            }
        }
    }
    for attempt in 0..100 {
        let key = collision_key(&item.relative_path, &item.sha256, attempt)?;
        let target = destination.join(&key);
        if scoped.exists(&key)? {
            if deduplicate && existing_matches(scoped, &key, item) {
                return Ok(success(item, target, "duplicate"));
            }
            continue;
        }
        let mut file = open_scoped(source, &item.source_relative_path)?;
        // A simultaneous writer is rejected at atomic no-replace publication.
        scoped.publish(&mut file, &key, Some(&item.sha256))?;
        return Ok(success(item, target, "copied"));
    }
    bail!("Too many filename conflicts; no existing file was replaced")
}

fn success(item: &ImportItem, target: PathBuf, status: &str) -> ItemResult {
    ItemResult {
        source: item.source.clone(),
        destination: target.to_string_lossy().into_owned(),
        status: status.to_string(),
        size: item.size,
        sha256: Some(item.sha256.clone()),
        error: None,
    }
}

fn existing_matches(destination: &ScopedDestination, key: &str, item: &ImportItem) -> bool {
    destination
        .reader(key)
        .and_then(|mut file| {
            if file.metadata()?.len() != item.size {
                return Ok(false);
            }
            Ok(hash_reader(&mut file)? == (item.size, item.sha256.clone()))
        })
        .unwrap_or(false)
}

fn collision_key(key: &str, hash: &str, attempt: usize) -> Result<String> {
    if attempt == 0 {
        return Ok(key.to_string());
    }
    let path = Path::new(key);
    let stem = path
        .file_stem()
        .context("Missing filename")?
        .to_string_lossy();
    let extension = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let suffix = if attempt == 1 {
        String::new()
    } else {
        format!("-{attempt}")
    };
    Ok(path
        .with_file_name(format!("{stem}-{}{suffix}{extension}", &hash[..12]))
        .to_string_lossy()
        .replace('\\', "/"))
}

fn prospective_root(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    if absolute
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        bail!("Import root must not contain relative traversal");
    }
    let mut existing = absolute.as_path();
    let mut missing = Vec::new();
    while !existing.exists() {
        missing.push(
            existing
                .file_name()
                .context("Invalid import root")?
                .to_os_string(),
        );
        existing = existing
            .parent()
            .context("Import root has no existing parent")?;
    }
    let mut resolved = fs::canonicalize(existing)?;
    for part in missing.iter().rev() {
        validate_key(&part.to_string_lossy(), false)?;
        resolved.push(part);
    }
    Ok(resolved)
}

fn modified_nanos(metadata: &fs::Metadata) -> Result<u128> {
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos())
}

fn supported(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    [
        "jpg", "jpeg", "png", "tif", "tiff", "webp", "avif", "heic", "heif", "gif", "bmp", "dng",
        "nef", "nrw", "cr2", "cr3", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw", "3fr",
        "fff", "iiq", "rwl", "x3f", "raw", "mov", "mp4", "avi", "mkv", "mts", "m2ts", "xmp",
    ]
    .contains(&extension.as_str())
}

fn discover(root: &Path, warnings: &mut Vec<String>) -> Result<Vec<String>> {
    let mut pending = vec![(PathBuf::new(), 0usize)];
    let mut files = Vec::new();
    while let Some((relative, depth)) = pending.pop() {
        if depth > 64 {
            warnings.push(format!(
                "Folder depth limit reached: {}",
                relative.display()
            ));
            continue;
        }
        let entries = match fs::read_dir(root.join(&relative)) {
            Ok(entries) => entries,
            Err(error) => {
                warnings.push(format!("Cannot scan {}: {error}", relative.display()));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    warnings.push(error.to_string());
                    continue;
                }
            };
            let path = relative.join(entry.file_name());
            let key = path.to_string_lossy().replace('\\', "/");
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if let Err(error) = safe_join(root, &key, false) {
                warnings.push(format!("Skipped {key}: {error}"));
                continue;
            }
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                pending.push((path, depth + 1));
            } else if metadata.is_file() && supported(&path) {
                files.push(key);
            }
            if files.len() > 1_000_000 {
                bail!("Import file limit exceeded");
            }
        }
    }
    files.sort();
    Ok(files)
}

fn capture_day(root: &Path, key: &str) -> Option<String> {
    let file = open_scoped(root, key).ok()?;
    // TIFF/RAW offsets can be hostile or extremely large. Parse only a bounded
    // prefix; metadata outside it is honestly reported as unknown.
    let mut prefix = Vec::new();
    file.take(16 * 1024 * 1024).read_to_end(&mut prefix).ok()?;
    let exif = exif::Reader::new()
        .read_from_container(&mut Cursor::new(prefix))
        .ok()?;
    let field = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)?;
    let value = match &field.value {
        exif::Value::Ascii(values) => values.first()?,
        _ => return None,
    };
    let text = std::str::from_utf8(value).ok()?;
    let date = text.get(..10)?;
    chrono::NaiveDate::parse_from_str(date, "%Y:%m:%d")
        .ok()
        .map(|d| d.format("%Y-%m-%d").to_string())
}
