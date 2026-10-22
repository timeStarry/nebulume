//! Verified, non-destructive local/SD-card import with restart-safe file results.
use anyhow::{bail, Context, Result};
use chrono::Utc;
use neb_storage::{
    atomic_json, hash_reader, open_scoped, safe_join, validate_key, PreparedDestination,
    ScopedDestination,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use uuid::Uuid;

pub mod organize;
pub use organize::OrganizeRules;
use organize::{DateBasis, ItemDate, TypeSplit, UnknownDate};

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
    /// The frozen organization rules this plan was made with.
    pub rules: OrganizeRules,
    /// Day used when `date_basis` is `import`; frozen at planning time.
    pub import_day: String,
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
    /// Rules frozen in the executed plan; absent in journals from older versions.
    #[serde(default)]
    pub rules: Option<OrganizeRules>,
}

struct ReviewedImport {
    plan: ImportPlan,
    destination: PreparedDestination,
    preserve_names: HashSet<String>,
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
    /// Compatibility entry: `preserve` or `date` (capture day, `Y-M-D`).
    pub fn plan(
        &mut self,
        source: impl AsRef<Path>,
        destination: impl AsRef<Path>,
        layout: &str,
        deduplicate: bool,
    ) -> Result<ImportPlan> {
        let rules = OrganizeRules::from_legacy_layout(layout)?;
        self.plan_with_rules(source, destination, &rules, deduplicate)
    }

    pub fn plan_with_rules(
        &mut self,
        source: impl AsRef<Path>,
        destination: impl AsRef<Path>,
        rules: &OrganizeRules,
        deduplicate: bool,
    ) -> Result<ImportPlan> {
        rules.validate()?;
        let layout = match rules.date_basis {
            DateBasis::Preserve => "preserve",
            _ => "date",
        };
        let import_day = chrono::Local::now().format("%Y-%m-%d").to_string();
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
        let source_discovery = discover(&source, &mut warnings)?;
        let source_files = source_discovery.files;
        let sidecar_groups: HashSet<_> = source_files
            .iter()
            .chain(&source_discovery.unavailable)
            .filter(|key| extension_role(key) == "xmp")
            .map(|key| capture_group(key))
            .collect();
        let preserve_names: HashSet<_> = source_files
            .iter()
            .chain(&source_discovery.unavailable)
            .filter(|key| is_pairable(key) && sidecar_groups.contains(&capture_group(key)))
            .cloned()
            .collect();
        let capture_dates = if rules.needs_capture_dates() {
            resolve_capture_dates(&source, &source_files, &mut warnings)
        } else {
            HashMap::new()
        };
        // With type folders, an XMP sidecar follows the RAW/JPEG it describes so the
        // companion group keeps a single target stem.
        let anchors: HashMap<String, String> = if rules.type_split == TypeSplit::ByKind {
            let mut by_group: HashMap<String, String> = HashMap::new();
            for key in &source_files {
                let role = extension_role(key);
                if role == "xmp" || !is_pairable(key) {
                    continue;
                }
                let entry = by_group
                    .entry(capture_group(key))
                    .or_insert_with(|| key.clone());
                // Prefer the RAW as the group's anchor.
                if organize::kind_folder(key) == "RAW" {
                    *entry = key.clone();
                }
            }
            by_group
        } else {
            HashMap::new()
        };
        let destination_files = if deduplicate && destination.is_dir() {
            discover(&destination, &mut warnings)?.files
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
                let item_date = match rules.date_basis {
                    DateBasis::Preserve | DateBasis::None => ItemDate {
                        day: None,
                        source: "preserved".into(),
                    },
                    DateBasis::Import => ItemDate {
                        day: Some(import_day.clone()),
                        source: "import_date".into(),
                    },
                    DateBasis::Capture => {
                        let (day, provenance) = capture_dates
                            .get(&key)
                            .cloned()
                            .unwrap_or_else(|| (None, "unknown".to_string()));
                        match day {
                            Some(day) => ItemDate {
                                day: Some(day),
                                source: provenance,
                            },
                            // Explicit opt-in only; the plan labels every such item.
                            None if rules.unknown_date == UnknownDate::ModifiedTime => ItemDate {
                                day: modified_day(&metadata),
                                source: "modified_time".into(),
                            },
                            None => ItemDate {
                                day: None,
                                source: provenance,
                            },
                        }
                    }
                };
                let date_source = item_date.source.clone();
                let mut relative_path = organize::target_path(rules, &key, &item_date)?;
                if let Some(anchor) = anchors.get(&capture_group(&key)) {
                    if extension_role(&key) == "xmp" {
                        let folder = organize::kind_folder(anchor);
                        if let Some(index) = relative_path.rfind("/RAW/") {
                            relative_path.replace_range(index + 1..index + 4, folder);
                        }
                    }
                }
                let preserve_name = preserve_names.contains(&key);
                let duplicate_identity = dedup_identity(&relative_path, &sha256, preserve_name);
                let mut duplicate_path = None;
                if let Some(candidates) = destination_by_size.get(&size) {
                    for candidate in candidates {
                        if !same_dedup_role(&relative_path, candidate, preserve_name) {
                            continue;
                        }
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
                    duplicate_path = batch_hashes.get(&duplicate_identity).cloned();
                }
                if deduplicate {
                    batch_hashes.entry(duplicate_identity).or_insert_with(|| {
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
        let incomplete_groups: BTreeSet<_> = {
            let planned_keys: HashSet<_> = items
                .iter()
                .map(|item| item.source_relative_path.as_str())
                .collect();
            preserve_names
                .iter()
                .filter(|key| !planned_keys.contains(key.as_str()))
                .map(|key| capture_group(key))
                .collect()
        };
        if !incomplete_groups.is_empty() {
            for group in &incomplete_groups {
                warnings.push(format!(
                    "Incomplete XMP companion group {group} was excluded from the plan because a source member could not be read. No member of this group will be imported; restore source access and create a new plan"
                ));
            }
            items.retain(|item| {
                !incomplete_groups.contains(&capture_group(&item.source_relative_path))
            });
            duplicate_count = items
                .iter()
                .filter(|item| item.status == "duplicate")
                .count();
            total_bytes = items
                .iter()
                .filter(|item| item.status != "duplicate")
                .map(|item| item.size)
                .sum();
        }
        let plan = ImportPlan {
            id: Uuid::new_v4().to_string(),
            source: source.to_string_lossy().into_owned(),
            destination: destination.to_string_lossy().into_owned(),
            layout: layout.to_string(),
            rules: rules.clone(),
            import_day,
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
                preserve_names,
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
            rules: Some(plan.rules.clone()),
        };
        let journal_path = self.history_dir.join(format!("{}.json", result.id));
        atomic_json(&journal_path, &result)?;
        let scoped_destination = reviewed.destination.materialize()?;
        let mut group_members: HashMap<String, Vec<&ImportItem>> = HashMap::new();
        for item in &plan.items {
            if reviewed.preserve_names.contains(&item.source_relative_path) {
                group_members
                    .entry(capture_group(&item.source_relative_path))
                    .or_default()
                    .push(item);
            }
        }
        let mut group_errors = conflicting_companion_groups(&plan.items, &group_members);
        let mut checked_groups = HashSet::new();
        let mut verified_batch: HashMap<String, String> = HashMap::new();
        for item in &plan.items {
            let preserve_name = reviewed.preserve_names.contains(&item.source_relative_path);
            let group = preserve_name.then(|| capture_group(&item.source_relative_path));
            let duplicate_identity =
                dedup_identity(&item.relative_path, &item.sha256, preserve_name);
            let outcome = (|| -> Result<ItemResult> {
                if let Some(group) = &group {
                    if let Some(error) = group_errors.get(group) {
                        bail!("{error}");
                    }
                    if checked_groups.insert(group.clone()) {
                        preflight_companion_targets(
                            &scoped_destination,
                            &group_members[group],
                            plan.deduplicate,
                        )?;
                    }
                }
                execute_item(
                    source,
                    destination,
                    &scoped_destination,
                    item,
                    plan.deduplicate,
                    preserve_name,
                    verified_batch.get(&duplicate_identity).map(String::as_str),
                )
            })();
            let item_result = match outcome {
                Ok(item_result) => {
                    if let Ok(key) = Path::new(&item_result.destination).strip_prefix(destination) {
                        verified_batch
                            .insert(duplicate_identity, key.to_string_lossy().replace('\\', "/"));
                    }
                    if item_result.status == "duplicate" {
                        result.duplicates += 1;
                    } else {
                        result.copied += 1;
                    }
                    item_result
                }
                Err(error) => {
                    if let Some(group) = group {
                        group_errors.entry(group).or_insert_with(|| {
                            format!(
                                "XMP companion group stopped after {} failed: {error:#}. Already verified files are retained; no remaining member will be published. Choose a new destination directory and retry the complete group",
                                item.source_relative_path
                            )
                        });
                    }
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
                        error: Some(format!("{error:#}")),
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

fn preflight_companion_targets(
    destination: &ScopedDestination,
    items: &[&ImportItem],
    deduplicate: bool,
) -> Result<()> {
    for item in items {
        if destination.exists(&item.relative_path)?
            && !(deduplicate && existing_matches(destination, &item.relative_path, item))
        {
            bail!(
                "Filename conflict at {} blocks the entire XMP companion group before publication. Choose a new destination directory; all source files are retained",
                item.relative_path
            );
        }
    }
    Ok(())
}

fn conflicting_companion_groups(
    items: &[ImportItem],
    groups: &HashMap<String, Vec<&ImportItem>>,
) -> HashMap<String, String> {
    let mut claims: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for item in items
        .iter()
        .filter(|item| is_pairable(&item.source_relative_path))
    {
        // Reserve the complete target stem, not just each extension. This keeps
        // a RAW from one source folder from being paired with another folder's
        // JPEG/XMP, including on a case-insensitive destination filesystem.
        claims
            .entry(capture_group(&item.relative_path).to_lowercase())
            .or_default()
            .insert(capture_group(&item.source_relative_path));
    }
    let mut errors = HashMap::new();
    for (target_stem, source_groups) in claims {
        if source_groups.len() < 2 {
            continue;
        }
        for group in &source_groups {
            if groups.contains_key(group) {
                errors.entry(group.clone()).or_insert_with(|| {
                    format!(
                        "Multiple source groups map to target stem {target_stem}: {}. The entire XMP companion group is blocked to prevent mixed pairing. Choose a new destination directory or preserve source folders",
                        source_groups.iter().cloned().collect::<Vec<_>>().join(", ")
                    )
                });
            }
        }
    }
    errors
}

fn execute_item(
    source: &Path,
    destination: &Path,
    scoped: &ScopedDestination,
    item: &ImportItem,
    deduplicate: bool,
    preserve_name: bool,
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
            if preserve_name {
                bail!("Filename conflict in an XMP companion group: individual files cannot be renamed without breaking pairing. Choose a new destination directory; all source files are retained");
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

struct DiscoveredFiles {
    files: Vec<String>,
    unavailable: Vec<String>,
}

fn discover(root: &Path, warnings: &mut Vec<String>) -> Result<DiscoveredFiles> {
    let mut pending = vec![(PathBuf::new(), 0usize)];
    let mut files = Vec::new();
    let mut unavailable = Vec::new();
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
                if supported(&path) {
                    unavailable.push(key);
                }
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    warnings.push(format!("Skipped {key}: {error}"));
                    if supported(&path) {
                        unavailable.push(key);
                    }
                    continue;
                }
            };
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
    Ok(DiscoveredFiles { files, unavailable })
}

fn extension_role(key: &str) -> String {
    let extension = Path::new(key)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" => "jpeg".to_string(),
        "tif" => "tiff".to_string(),
        _ => extension,
    }
}

fn is_pairable(key: &str) -> bool {
    !matches!(
        extension_role(key).as_str(),
        "mov" | "mp4" | "avi" | "mkv" | "mts" | "m2ts"
    )
}

fn capture_group(key: &str) -> String {
    // Exact directory and stem identity avoids guessing across different cards,
    // camera folders, or case-distinct filenames on a case-sensitive source.
    Path::new(key)
        .with_extension("")
        .to_string_lossy()
        .replace('\\', "/")
}

fn resolve_capture_dates(
    root: &Path,
    keys: &[String],
    warnings: &mut Vec<String>,
) -> HashMap<String, (Option<String>, String)> {
    let mut direct = HashMap::new();
    let mut groups: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for key in keys {
        if !is_pairable(key) || extension_role(key) == "xmp" {
            continue;
        }
        if let Some(date) = capture_day(root, key) {
            groups
                .entry(capture_group(key))
                .or_default()
                .insert(date.clone());
            direct.insert(key.clone(), date);
        }
    }
    for (group, dates) in &groups {
        if dates.len() > 1 {
            warnings.push(format!(
                "Conflicting EXIF capture dates for {group}: {}. Images retain their own dates; companions without an unambiguous date remain in unknown-date.",
                dates.iter().cloned().collect::<Vec<_>>().join(", ")
            ));
        }
    }
    keys.iter()
        .map(|key| {
            let resolved = if let Some(date) = direct.get(key) {
                (Some(date.clone()), "exif".to_string())
            } else if is_pairable(key) {
                match groups.get(&capture_group(key)) {
                    Some(dates) if dates.len() == 1 => {
                        (dates.first().cloned(), "paired_exif".to_string())
                    }
                    _ => (None, "unknown".to_string()),
                }
            } else {
                (None, "unknown".to_string())
            };
            (key.clone(), resolved)
        })
        .collect()
}

fn same_dedup_role(target: &str, candidate: &str, preserve_name: bool) -> bool {
    let role = extension_role(target);
    role == extension_role(candidate) && (!(preserve_name || role == "xmp") || target == candidate)
}

fn dedup_identity(target: &str, hash: &str, preserve_name: bool) -> String {
    let role = extension_role(target);
    if preserve_name || role == "xmp" {
        format!("{role}\0{target}\0{hash}")
    } else {
        format!("{role}\0{hash}")
    }
}

fn modified_day(metadata: &fs::Metadata) -> Option<String> {
    let modified: chrono::DateTime<chrono::Local> = metadata.modified().ok()?.into();
    Some(modified.format("%Y-%m-%d").to_string())
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
