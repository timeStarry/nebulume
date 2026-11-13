use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::SystemTime,
};

use anyhow::ensure;
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, TransactionBehavior};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    capture_time::{self, CaptureStatus},
    imaging,
    model::{ScanError, ScanReport},
    Asset, Library,
};

use super::{
    collections, file_created_at, location_key, path_is_within, path_key, Core, INSPECTION_VERSION,
};

const SCAN_BATCH_SIZE: usize = 250;

pub(super) fn is_package_bundle_name(name: &str) -> bool {
    let Some((_, ext)) = name.rsplit_once('.') else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "photoslibrary"
            | "photolibrary"
            | "aplibrary"
            | "lrdata"
            | "lrcat-data"
            | "fcpbundle"
            | "app"
            | "bundle"
            | "framework"
    )
}

fn has_sub_bundle_ancestor(canonical_root: &Path, asset_path: &Path) -> bool {
    let Ok(rel) = asset_path.strip_prefix(canonical_root) else {
        return false;
    };
    let Some(parent) = rel.parent() else {
        return false;
    };
    parent
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .any(is_package_bundle_name)
}

struct KnownLocalAsset {
    id: String,
    path: String,
    size: u64,
    modified_stamp: String,
    availability: String,
    created_at: String,
    created_at_checked: bool,
    captured_at_checked: bool,
    quick_hash: Option<String>,
    trashed: bool,
}

struct InspectedFile {
    width: Option<u32>,
    height: Option<u32>,
    metadata_json: String,
    availability: &'static str,
    captured_at: String,
    capture_checked: bool,
    error: Option<String>,
}

struct PreparedLocalUpsert {
    id: String,
    is_new: bool,
    library_id: String,
    path_string: String,
    path_key: String,
    filename: String,
    extension: String,
    kind: String,
    size: u64,
    modified_at: String,
    stamp: String,
    inspected: InspectedFile,
    created_at: String,
    location_key: Option<String>,
    quick_hash: Option<String>,
    initial_rating: Option<u8>,
    initial_flag: Option<String>,
    initial_color_label: Option<String>,
    initial_crop_json: Option<String>,
    initial_keywords: Vec<String>,
}

enum PendingPatch {
    CreatedAt { id: String, created_at: String },
    QuickHash { id: String, hash: String },
}

const LOCAL_UPSERT_SQL: &str = "\
INSERT INTO assets(id,library_id,path,path_key,filename,extension,kind,size,modified_at,modified_stamp,width,height,metadata_json,availability,created_at,created_at_checked,captured_at,captured_at_checked,key,quick_hash)
VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1,?16,?17,?18,?19)
ON CONFLICT(library_id,path_key) DO UPDATE SET path=excluded.path,key=excluded.key,
sha256=CASE WHEN assets.size=excluded.size AND assets.modified_stamp=excluded.modified_stamp THEN assets.sha256 ELSE NULL END,
quick_hash=CASE WHEN assets.size=excluded.size AND assets.modified_stamp=excluded.modified_stamp THEN assets.quick_hash ELSE excluded.quick_hash END,
filename=excluded.filename,extension=excluded.extension,
kind=excluded.kind,size=excluded.size,modified_at=excluded.modified_at,modified_stamp=excluded.modified_stamp,
width=excluded.width,height=excluded.height,metadata_json=excluded.metadata_json,availability=excluded.availability,
captured_at=excluded.captured_at,captured_at_checked=excluded.captured_at_checked,
created_at=CASE WHEN assets.source_key IS NULL THEN excluded.created_at ELSE assets.created_at END,
created_at_checked=CASE WHEN assets.source_key IS NULL THEN 1 ELSE assets.created_at_checked END,
trashed_at=NULL,trash_path=NULL";

impl Core {
    pub fn scan(&self, library_id: &str) -> Result<ScanReport> {
        let library = self.library(library_id)?;
        let root = Path::new(&library.root);
        // A disconnected volume is not an empty library. Preserve the catalog.
        ensure!(
            root.is_dir(),
            "E_OFFLINE: Library root is disconnected or unavailable"
        );
        let canonical_root = dunce::canonicalize(root)?;
        ensure!(
            path_key(&canonical_root.to_string_lossy()) == path_key(&library.root),
            "E_PATH: Library root now resolves to a different directory"
        );
        let mut report = ScanReport::default();

        // Snapshot existing state once so unchanged files skip without per-file SQL or locks.
        let (existing, known_local) = {
            let db = self.db()?;
            let mut all_stmt = db.prepare("SELECT id FROM assets WHERE library_id=?1")?;
            let existing = all_stmt
                .query_map([library_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<HashSet<_>>>()?;

            let mut local_stmt = db.prepare(
                "SELECT path_key,id,path,size,modified_stamp,availability,created_at,created_at_checked,captured_at_checked,quick_hash,trashed_at IS NOT NULL \
                 FROM assets WHERE library_id=?1 AND source_key IS NULL",
            )?;
            let mut map = HashMap::with_capacity(existing.len());
            let rows = local_stmt.query_map([library_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    KnownLocalAsset {
                        id: row.get(1)?,
                        path: row.get(2)?,
                        size: row.get(3)?,
                        modified_stamp: row.get(4)?,
                        availability: row.get(5)?,
                        created_at: row.get(6)?,
                        created_at_checked: row.get(7)?,
                        captured_at_checked: row.get(8)?,
                        quick_hash: row.get(9)?,
                        trashed: row.get(10)?,
                    },
                ))
            })?;
            for row in rows {
                let (key, asset) = row?;
                map.insert(key, asset);
            }
            (existing, map)
        };

        let mut seen_keys: HashSet<String> = HashSet::with_capacity(known_local.len());
        let mut pending_upserts: Vec<PreparedLocalUpsert> = Vec::new();
        let mut pending_patches: Vec<PendingPatch> = Vec::new();

        for entry in WalkDir::new(&canonical_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                if entry.file_type().is_dir() {
                    let name = entry.file_name().to_string_lossy();
                    if name.starts_with('.') || is_package_bundle_name(&name) {
                        return false;
                    }
                }
                true
            })
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    report.errors.push(ScanError {
                        path: error.path().unwrap_or(root).to_string_lossy().into(),
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let extension = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let Some(kind) = imaging::kind(&extension) else {
                report.skipped += 1;
                continue;
            };

            // Fast in-memory check for unchanged files under canonical_root.
            if let (Some(path_str), Ok(info)) = (path.to_str(), entry.metadata()) {
                let key = path_key(path_str);
                let stamp = file_stamp(&info);
                if let Some(known) = known_local.get(&key) {
                    if !known.trashed
                        && known.size == info.len()
                        && known.modified_stamp == stamp
                        && matches!(known.availability.as_str(), "available" | "unsupported")
                    {
                        seen_keys.insert(key);
                        let created_at = file_created_at(&info);
                        if !known.created_at_checked || known.created_at != created_at {
                            pending_patches.push(PendingPatch::CreatedAt {
                                id: known.id.clone(),
                                created_at,
                            });
                        }
                        if known.quick_hash.is_none() {
                            if let Some(hash) = quick_hash(path, info.len()) {
                                pending_patches.push(PendingPatch::QuickHash {
                                    id: known.id.clone(),
                                    hash,
                                });
                            }
                        }
                        if !known.captured_at_checked {
                            if let Ok(capture) = capture_time::read_path(path) {
                                self.record_capture_time(
                                    &known.id,
                                    &known.modified_stamp,
                                    &capture,
                                )?;
                            }
                        }
                        report.skipped += 1;
                        if pending_upserts.len() + pending_patches.len() >= SCAN_BATCH_SIZE {
                            self.flush_scan_batch(
                                &mut pending_upserts,
                                &mut pending_patches,
                                &mut report,
                            )?;
                        }
                        continue;
                    }
                }
            }

            match prepare_local_upsert(
                &library,
                &canonical_root,
                path,
                kind,
                &extension,
                &known_local,
            ) {
                Ok(upsert) => {
                    seen_keys.insert(upsert.path_key.clone());
                    pending_upserts.push(upsert);
                    if pending_upserts.len() + pending_patches.len() >= SCAN_BATCH_SIZE {
                        self.flush_scan_batch(
                            &mut pending_upserts,
                            &mut pending_patches,
                            &mut report,
                        )?;
                    }
                }
                Err(error) => report.errors.push(ScanError {
                    path: path.to_string_lossy().into(),
                    message: format!("{error:#}"),
                }),
            }
        }

        if !pending_upserts.is_empty() || !pending_patches.is_empty() {
            self.flush_scan_batch(&mut pending_upserts, &mut pending_patches, &mut report)?;
        }

        // Keep missing assets (including their edits) so reconnecting is lossless.
        // Rows previously indexed inside child macOS package bundles (.photoslibrary, .lrdata, etc.)
        // are removed cleanly when untouched, or marked missing if the user rated/flagged/tagged them.
        let mut missing: Vec<(String, u64, Option<String>)> = Vec::new();
        let mut bundle_candidates: Vec<String> = Vec::new();
        for (key, known) in &known_local {
            if known.trashed || seen_keys.contains(key) {
                continue;
            }
            if has_sub_bundle_ancestor(&canonical_root, Path::new(&known.path)) {
                bundle_candidates.push(known.id.clone());
                continue;
            }
            if let Err(error) = fs::metadata(&known.path) {
                if error.kind() == std::io::ErrorKind::NotFound {
                    missing.push((known.id.clone(), known.size, known.quick_hash.clone()));
                }
            }
        }

        if !bundle_candidates.is_empty() {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut delete_unmarked = tx.prepare_cached(
                    "DELETE FROM assets WHERE id=?1
                     AND rating=0 AND flag='none' AND color_label='none' AND crop_json IS NULL
                     AND NOT EXISTS(SELECT 1 FROM collection_items WHERE asset_id=assets.id)
                     AND NOT EXISTS(SELECT 1 FROM asset_keywords WHERE asset_id=assets.id)",
                )?;
                let mut hide_marked =
                    tx.prepare_cached("UPDATE assets SET availability='missing' WHERE id=?1")?;
                for id in &bundle_candidates {
                    if delete_unmarked.execute([id])? == 0 {
                        hide_marked.execute([id])?;
                    }
                }
            }
            tx.commit()?;
        }

        if !missing.is_empty() {
            const FILE_COLUMNS: &str = "path,path_key,filename,extension,kind,size,modified_at,modified_stamp,width,height,metadata_json,availability,created_at,created_at_checked,captured_at,captured_at_checked,key,quick_hash,sha256";
            let mut db = self.db()?;
            let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut mark_missing = transaction
                    .prepare_cached("UPDATE assets SET availability='missing' WHERE id=?1")?;
                for (old_id, _, _) in &missing {
                    mark_missing.execute([old_id])?;
                }
            }
            for (old_id, size, hash) in &missing {
                let Some(hash) = hash else { continue };
                let candidates: Vec<String> = {
                    let mut find = transaction.prepare_cached(
                        "SELECT id FROM assets WHERE library_id=?1 AND size=?2 AND quick_hash=?3 AND availability<>'missing' AND source_key IS NULL",
                    )?;
                    let ids = find
                        .query_map(params![library_id, size, hash], |row| {
                            row.get::<_, String>(0)
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    ids
                };
                let fresh: Vec<&String> = candidates
                    .iter()
                    .filter(|id| !existing.contains(*id))
                    .collect();
                // Two copies of the same file are ambiguous; leave both untouched.
                let [new_id] = fresh.as_slice() else { continue };
                let values: Vec<rusqlite::types::Value> = transaction.query_row(
                    &format!("SELECT {FILE_COLUMNS} FROM assets WHERE id=?1"),
                    [new_id],
                    |row| (0..19).map(|index| row.get(index)).collect(),
                )?;
                transaction.execute("DELETE FROM assets WHERE id=?1", [new_id])?;
                let assignments = FILE_COLUMNS
                    .split(',')
                    .enumerate()
                    .map(|(index, column)| format!("{column}=?{}", index + 1))
                    .collect::<Vec<_>>()
                    .join(",");
                let mut bound: Vec<&dyn rusqlite::ToSql> = values
                    .iter()
                    .map(|value| value as &dyn rusqlite::ToSql)
                    .collect();
                bound.push(old_id);
                transaction.execute(
                    &format!("UPDATE assets SET {assignments} WHERE id=?20"),
                    bound.as_slice(),
                )?;
                report.moved += 1;
            }
            transaction.commit()?;
        }
        Ok(report)
    }

    fn flush_scan_batch(
        &self,
        upserts: &mut Vec<PreparedLocalUpsert>,
        patches: &mut Vec<PendingPatch>,
        report: &mut ScanReport,
    ) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        {
            if !patches.is_empty() {
                let mut set_created = tx.prepare_cached(
                    "UPDATE assets SET created_at=?1,created_at_checked=1 \
                     WHERE id=?2 AND source_key IS NULL AND (created_at<>?1 OR created_at_checked=0)",
                )?;
                let mut set_hash = tx.prepare_cached(
                    "UPDATE assets SET quick_hash=?1 WHERE id=?2 AND quick_hash IS NULL",
                )?;
                for patch in patches.drain(..) {
                    match patch {
                        PendingPatch::CreatedAt { id, created_at } => {
                            set_created.execute(params![created_at, id])?;
                        }
                        PendingPatch::QuickHash { id, hash } => {
                            set_hash.execute(params![hash, id])?;
                        }
                    }
                }
            }
            if !upserts.is_empty() {
                let mut upsert_stmt = tx.prepare_cached(LOCAL_UPSERT_SQL)?;
                let mut sidecar_stmt = tx.prepare_cached(
                    "UPDATE assets SET rating=COALESCE(?1,rating),flag=COALESCE(?2,flag),color_label=COALESCE(?3,color_label),crop_json=COALESCE(?4,crop_json) WHERE id=?5",
                )?;
                for item in upserts.drain(..) {
                    upsert_stmt.execute(params![
                        item.id,
                        item.library_id,
                        item.path_string,
                        item.path_key,
                        item.filename,
                        item.extension,
                        item.kind,
                        item.size,
                        item.modified_at,
                        item.stamp,
                        item.inspected.width,
                        item.inspected.height,
                        item.inspected.metadata_json,
                        item.inspected.availability,
                        item.created_at,
                        item.inspected.captured_at,
                        item.inspected.capture_checked,
                        item.location_key,
                        item.quick_hash,
                    ])?;
                    if item.is_new {
                        if item.initial_rating.is_some()
                            || item.initial_flag.is_some()
                            || item.initial_color_label.is_some()
                            || item.initial_crop_json.is_some()
                        {
                            sidecar_stmt.execute(params![
                                item.initial_rating,
                                item.initial_flag,
                                item.initial_color_label,
                                item.initial_crop_json,
                                item.id,
                            ])?;
                        }
                        if !item.initial_keywords.is_empty() {
                            collections::replace_asset_keywords_tx(
                                &tx,
                                &item.library_id,
                                &item.id,
                                &item.initial_keywords,
                            )?;
                        }
                    }
                    report.indexed += 1;
                    if let Some(message) = item.inspected.error {
                        report.errors.push(ScanError {
                            path: item.path_string,
                            message,
                        });
                    }
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub(super) fn index_file(
        &self,
        library: &Library,
        path: &Path,
        kind: &str,
        extension: &str,
        registered_asset: Option<&Asset>,
    ) -> Result<(bool, Option<String>)> {
        use rusqlite::OptionalExtension;

        let path = dunce::canonicalize(path)?;
        ensure!(
            path_is_within(&path, Path::new(&library.root))
                || registered_asset
                    .filter(|asset| asset.source_key.is_some())
                    .is_some_and(|asset| {
                        self.db()
                            .ok()
                            .and_then(|database| {
                                crate::cache::resolve_asset_path(&database, &asset.id)
                                    .ok()
                                    .flatten()
                            })
                            .is_some_and(|managed| managed == path)
                    }),
            "E_PATH: File resolves outside the library root"
        );
        let info = fs::metadata(&path)?;
        let modified = info.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let stamp = file_stamp(&info);
        // A remote placeholder was registered before its file existed. On Windows
        // canonicalization may add a verbatim prefix only after that long cache
        // file exists. Keep the registered identity (including a refreshed cache
        // filename), while all inspection uses the checked canonical I/O path.
        let registered_remote = registered_asset.filter(|asset| asset.source_key.is_some());
        let path_string = match registered_remote {
            Some(asset) => asset.path.clone(),
            None => path
                .to_str()
                .context("E_INVALID: Image path is not valid Unicode")?
                .to_owned(),
        };
        let key = path_key(&path_string);
        let old: Option<(String, u64, String, String, bool, bool, bool)> = if let Some(asset) =
            registered_remote
        {
            Some(self.db()?.query_row(
                "SELECT id,size,modified_stamp,availability,captured_at_checked,quick_hash IS NULL,trashed_at IS NOT NULL FROM assets WHERE id=?1 AND library_id=?2 AND path=?3 AND source_key=?4",
                params![asset.id, library.id, path_string, asset.source_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            ).optional()?.context("E_CONFLICT: Remote cache changed while reading; retry the image")?)
        } else {
            self.db()?.query_row(
                "SELECT id,size,modified_stamp,availability,captured_at_checked,quick_hash IS NULL,trashed_at IS NOT NULL FROM assets WHERE library_id=?1 AND path_key=?2",
                params![library.id, key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            ).optional()?
        };
        if let Some((
            old_id,
            size,
            old_stamp,
            availability,
            capture_checked,
            hash_missing,
            trashed,
        )) = &old
        {
            if !trashed
                && *size == info.len()
                && *old_stamp == stamp
                && matches!(availability.as_str(), "available" | "unsupported")
            {
                if registered_remote.is_none() {
                    let created_at = file_created_at(&info);
                    self.db()?.execute(
                        "UPDATE assets SET created_at=?1,created_at_checked=1 WHERE id=?2 AND source_key IS NULL AND (created_at<>?1 OR created_at_checked=0)",
                        params![created_at, old_id],
                    )?;
                }
                if *hash_missing && registered_remote.is_none() {
                    if let Some(hash) = quick_hash(&path, info.len()) {
                        self.db()?.execute(
                            "UPDATE assets SET quick_hash=?1 WHERE id=?2 AND quick_hash IS NULL",
                            params![hash, old_id],
                        )?;
                    }
                }
                if !capture_checked {
                    if let Ok(capture) = capture_time::read_path(&path) {
                        self.record_capture_time(old_id, old_stamp, &capture)?;
                    }
                }
                return Ok((false, None));
            }
        }
        let is_new = old.is_none();
        let id = old
            .map(|row| row.0)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let inspected = inspect_file_metadata(&path, info.len())?;
        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let modified_at: DateTime<Utc> = modified.into();
        if let Some(asset) = registered_remote {
            let source_key = asset.source_key.as_deref().expect("remote asset has a key");
            let changed = self.db()?.execute(
                "UPDATE assets SET filename=?1,extension=?2,kind=?3,size=?4,modified_at='',modified_stamp=?5,width=?6,height=?7,metadata_json=?8,availability=?9,captured_at=?14,captured_at_checked=?15
                 WHERE id=?10 AND library_id=?11 AND path=?12 AND source_key=?13",
                params![
                    source_key.rsplit('/').next().unwrap_or(source_key),
                    extension,
                    kind,
                    info.len(),
                    stamp,
                    inspected.width,
                    inspected.height,
                    inspected.metadata_json,
                    inspected.availability,
                    asset.id,
                    library.id,
                    path_string,
                    source_key,
                    inspected.captured_at,
                    inspected.capture_checked,
                ],
            )?;
            ensure!(
                changed == 1,
                "E_CONFLICT: Remote cache changed while reading; retry the image"
            );
            return Ok((true, inspected.error));
        }
        self.db()?.execute(
            LOCAL_UPSERT_SQL,
            params![
                id,
                library.id,
                path_string,
                key,
                filename,
                extension,
                kind,
                info.len(),
                modified_at.to_rfc3339(),
                stamp,
                inspected.width,
                inspected.height,
                inspected.metadata_json,
                inspected.availability,
                file_created_at(&info),
                inspected.captured_at,
                inspected.capture_checked,
                location_key(&library.source_prefix, Path::new(&library.root), &path),
                quick_hash(&path, info.len()),
            ],
        )?;
        if is_new {
            if let Ok(Some(sidecar)) = crate::xmp::read_sidecar_for_image(&path) {
                let crop_json = sidecar
                    .crop
                    .and_then(|c| c)
                    .and_then(|c| serde_json::to_string(&c).ok());
                if sidecar.rating.is_some()
                    || sidecar.flag.is_some()
                    || sidecar.color_label.is_some()
                    || crop_json.is_some()
                {
                    self.db()?.execute(
                        "UPDATE assets SET rating=COALESCE(?1,rating),flag=COALESCE(?2,flag),color_label=COALESCE(?3,color_label),crop_json=COALESCE(?4,crop_json) WHERE id=?5",
                        params![sidecar.rating, sidecar.flag, sidecar.color_label, crop_json, id],
                    )?;
                }
                if !sidecar.keywords.is_empty() {
                    let mut db = self.db()?;
                    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    collections::replace_asset_keywords_tx(
                        &tx,
                        &library.id,
                        &id,
                        &sidecar.keywords,
                    )?;
                    tx.commit()?;
                }
            }
        }
        Ok((true, inspected.error))
    }
}

fn file_stamp(info: &fs::Metadata) -> String {
    let modified = info.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let modified_nanos = modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{INSPECTION_VERSION}:{modified_nanos}")
}

fn prepare_local_upsert(
    library: &Library,
    canonical_root: &Path,
    path: &Path,
    kind: &str,
    extension: &str,
    known_local: &HashMap<String, KnownLocalAsset>,
) -> Result<PreparedLocalUpsert> {
    let path = dunce::canonicalize(path)?;
    ensure!(
        path_is_within(&path, canonical_root),
        "E_PATH: File resolves outside the library root"
    );
    let info = fs::metadata(&path)?;
    let modified = info.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let stamp = file_stamp(&info);
    let path_string = path
        .to_str()
        .context("E_INVALID: Image path is not valid Unicode")?
        .to_owned();
    let key = path_key(&path_string);
    let is_new = !known_local.contains_key(&key);
    let id = known_local
        .get(&key)
        .map(|known| known.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let inspected = inspect_file_metadata(&path, info.len())?;
    let (initial_rating, initial_flag, initial_color_label, initial_crop_json, initial_keywords) =
        if is_new {
            match crate::xmp::read_sidecar_for_image(&path).ok().flatten() {
                Some(sidecar) => (
                    sidecar.rating,
                    sidecar.flag,
                    sidecar.color_label,
                    sidecar
                        .crop
                        .and_then(|c| c)
                        .and_then(|c| serde_json::to_string(&c).ok()),
                    sidecar.keywords,
                ),
                None => (None, None, None, None, Vec::new()),
            }
        } else {
            (None, None, None, None, Vec::new())
        };
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_owned();
    let modified_at: DateTime<Utc> = modified.into();
    Ok(PreparedLocalUpsert {
        id,
        is_new,
        library_id: library.id.clone(),
        path_string,
        path_key: key,
        filename,
        extension: extension.to_owned(),
        kind: kind.to_owned(),
        size: info.len(),
        modified_at: modified_at.to_rfc3339(),
        stamp,
        inspected,
        created_at: file_created_at(&info),
        location_key: location_key(&library.source_prefix, canonical_root, &path),
        quick_hash: quick_hash(&path, info.len()),
        initial_rating,
        initial_flag,
        initial_color_label,
        initial_crop_json,
        initial_keywords,
    })
}

fn inspect_file_metadata(path: &Path, size: u64) -> Result<InspectedFile> {
    let inspection = imaging::inspect(path);
    let (width, height, mut metadata, availability, error) = match inspection {
        Ok(info) => (
            Some(info.width),
            Some(info.height),
            info.metadata,
            "available",
            None,
        ),
        Err(error) => {
            let error = format!("{error:#}");
            let metadata = if size <= imaging::MAX_FILE_BYTES {
                imaging::read_exif(path)
            } else {
                BTreeMap::new()
            };
            (None, None, metadata, "unsupported", Some(error))
        }
    };
    if let Some(error) = &error {
        metadata.insert("Decode Status".into(), error.clone());
    }
    let inspected_capture = capture_time::from_metadata(&metadata);
    let capture = if matches!(inspected_capture.status, CaptureStatus::Missing) {
        capture_time::read_path(path).ok()
    } else {
        Some(inspected_capture)
    };
    let capture_checked = capture.is_some();
    if let Some(capture) = &capture {
        for key in ["Captured", "Capture Subsecond", "Capture Time Zone"] {
            if let Some(value) = capture.metadata.get(key) {
                metadata.insert(key.to_owned(), value.clone());
            }
        }
    }
    let captured_at = capture.map(|value| value.captured_at).unwrap_or_default();
    Ok(InspectedFile {
        width,
        height,
        metadata_json: serde_json::to_string(&metadata)?,
        availability,
        captured_at,
        capture_checked,
        error,
    })
}

/// SHA-256 of the first 64 KiB + last 64 KiB + file size as LE bytes.
/// For files smaller than 128 KiB, hashes the full content + size.
/// Returns None on any I/O error (the file may be locked or gone).
fn quick_hash(path: &Path, size: u64) -> Option<String> {
    const CHUNK: u64 = 64 * 1024;
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    if size <= CHUNK * 2 {
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).ok()?;
        hasher.update(&buf);
    } else {
        let mut buf = [0u8; 64 * 1024];
        let n = file.read(&mut buf).ok()?;
        hasher.update(&buf[..n]);
        file.seek(SeekFrom::End(-(CHUNK as i64))).ok()?;
        let n = file.read(&mut buf).ok()?;
        hasher.update(&buf[..n]);
    }
    hasher.update(size.to_le_bytes());
    Some(hex::encode(hasher.finalize()))
}
