use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

use anyhow::{anyhow, bail, ensure, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    imaging,
    model::{ScanError, ScanReport},
    Asset, Crop, Library,
};

pub struct Core {
    database: Mutex<Connection>,
    // Bounded memory cache, keyed by current source fingerprint and crop recipe.
    // The disk catalog never contains preview data or credentials.
    previews: Mutex<VecDeque<(String, Value)>>,
}

const ASSET_COLUMNS: &str = "id,library_id,path,filename,extension,kind,size,modified_at,width,height,rating,metadata_json,crop_json,availability,source_key";
const LIBRARY_COLUMNS: &str = "id,name,root,created_at,storage_id,source_prefix,hidden";
// Bump when inspection semantics change. This lives only in the private cache
// fingerprint, so old catalogs upgrade on access without rewriting user EXIF.
const INSPECTION_VERSION: &str = "inspect-v2";

impl Core {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(data_dir.as_ref()).context("E_IO: Cannot create catalog directory")?;
        let mut database = Connection::open(data_dir.as_ref().join("catalog.sqlite3"))?;
        database.busy_timeout(Duration::from_secs(5))?;
        database.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        )?;
        let migration = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = migration.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            version <= 2,
            "E_SCHEMA: Catalog was created by a newer version of Nebulume"
        );
        if version == 0 {
            migration.execute_batch(include_str!("schema.sql"))?;
        }
        if version < 2 {
            migration.execute_batch(
                "ALTER TABLE libraries ADD COLUMN storage_id TEXT;
                 ALTER TABLE libraries ADD COLUMN source_prefix TEXT NOT NULL DEFAULT '';
                 ALTER TABLE libraries ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE assets ADD COLUMN source_key TEXT;
                 CREATE UNIQUE INDEX assets_remote_key ON assets(library_id,source_key) WHERE source_key IS NOT NULL;
                 PRAGMA user_version=2;",
            )?;
        }
        migration.commit()?;
        Ok(Self {
            database: Mutex::new(database),
            previews: Mutex::new(VecDeque::new()),
        })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.database
            .lock()
            .map_err(|_| anyhow!("E_INTERNAL: Catalog lock is unavailable"))
    }

    pub fn dispatch(&self, command: &str, params: Value) -> Result<Value> {
        ensure!(
            params.is_object(),
            "E_INVALID: Command params must be a JSON object"
        );
        match command {
            "library.list" => Ok(serde_json::to_value(self.libraries()?)?),
            "library.add" => {
                #[derive(Deserialize)]
                struct Add {
                    name: String,
                    root: String,
                }
                let args: Add = parse(params)?;
                Ok(serde_json::to_value(
                    self.add_library(&args.name, Path::new(&args.root))?,
                )?)
            }
            "library.scan" => {
                #[derive(Deserialize)]
                struct Scan {
                    library_id: String,
                }
                let args: Scan = parse(params)?;
                Ok(serde_json::to_value(self.scan(&args.library_id)?)?)
            }
            "asset.list" => self.list_assets(parse(params)?),
            "file.open" => {
                #[derive(Deserialize)]
                struct Open {
                    path: String,
                }
                let args: Open = parse(params)?;
                Ok(serde_json::to_value(
                    self.open_file(Path::new(&args.path))?,
                )?)
            }
            "asset.get" => Ok(serde_json::to_value(self.asset(&id(&params)?)?)?),
            "asset.rate" => {
                #[derive(Deserialize)]
                struct Rate {
                    id: String,
                    rating: u8,
                }
                let args: Rate = parse(params)?;
                ensure!(
                    args.rating <= 5,
                    "E_INVALID: Rating must be an integer from 0 to 5"
                );
                let changed = self.db()?.execute(
                    "UPDATE assets SET rating=?1 WHERE id=?2",
                    params![args.rating, args.id],
                )?;
                ensure!(changed == 1, "E_NOT_FOUND: Asset does not exist");
                Ok(serde_json::to_value(self.asset(&args.id)?)?)
            }
            "asset.crop" => {
                #[derive(Deserialize)]
                struct CropArgs {
                    id: String,
                    #[serde(flatten)]
                    crop: Crop,
                }
                let args: CropArgs = parse(params)?;
                args.crop.validate()?;
                let changed = self.db()?.execute(
                    "UPDATE assets SET crop_json=?1 WHERE id=?2",
                    params![serde_json::to_string(&args.crop)?, args.id],
                )?;
                ensure!(changed == 1, "E_NOT_FOUND: Asset does not exist");
                Ok(serde_json::to_value(self.asset(&args.id)?)?)
            }
            "asset.reset_crop" => {
                let id = id(&params)?;
                let changed = self
                    .db()?
                    .execute("UPDATE assets SET crop_json=NULL WHERE id=?1", [&id])?;
                ensure!(changed == 1, "E_NOT_FOUND: Asset does not exist");
                Ok(serde_json::to_value(self.asset(&id)?)?)
            }
            "asset.preview" => {
                #[derive(Deserialize)]
                struct Preview {
                    id: String,
                    max_size: Option<u32>,
                    #[serde(default)]
                    uncropped: bool,
                }
                let args: Preview = parse(params)?;
                self.preview(
                    &self.asset(&args.id)?,
                    args.max_size.unwrap_or(1600),
                    args.uncropped,
                )
            }
            "asset.histogram" => {
                let asset = self.asset(&id(&params)?)?;
                let path = self.checked_asset_path(&asset)?;
                imaging::histogram(&path, asset.crop)
            }
            "asset.export" => {
                #[derive(Deserialize)]
                struct Export {
                    id: String,
                    destination: String,
                }
                let args: Export = parse(params)?;
                let asset = self.asset(&args.id)?;
                let path = self.checked_asset_path(&asset)?;
                imaging::export(&path, asset.crop, Path::new(&args.destination))
            }
            _ => bail!("E_NOT_FOUND: Unknown core command {command}"),
        }
    }

    pub fn libraries(&self) -> Result<Vec<Library>> {
        let db = self.db()?;
        let mut statement = db.prepare(&format!(
            "SELECT {LIBRARY_COLUMNS} FROM libraries WHERE hidden=0 ORDER BY created_at,id"
        ))?;
        let result = statement
            .query_map([], library_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(result)
    }

    pub fn add_library(&self, name: &str, root: &Path) -> Result<Library> {
        self.add_library_internal(name, root, false)
    }

    fn add_library_internal(&self, name: &str, root: &Path, hidden: bool) -> Result<Library> {
        let name = name.trim();
        ensure!(
            !name.is_empty() && name.chars().count() <= 120,
            "E_INVALID: Library name must contain 1 to 120 characters"
        );
        let root = dunce::canonicalize(root)
            .context("E_NOT_FOUND: Library root does not exist or is inaccessible")?;
        ensure!(root.is_dir(), "E_INVALID: Library root must be a directory");
        let root_string = root
            .to_str()
            .context("E_INVALID: Library path must be valid Unicode")?
            .to_owned();
        let root_key = path_key(&root_string);
        let db = self.db()?;
        if let Some(existing) = db
            .query_row(
                &format!("SELECT {LIBRARY_COLUMNS} FROM libraries WHERE root_key=?1"),
                [&root_key],
                library_row,
            )
            .optional()?
        {
            if existing.hidden && !hidden {
                db.execute(
                    "UPDATE libraries SET hidden=0,name=?1 WHERE id=?2",
                    params![name, existing.id],
                )?;
                return Ok(Library {
                    name: name.into(),
                    hidden: false,
                    ..existing
                });
            }
            return Ok(existing);
        }
        let library = Library {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            root: root_string,
            created_at: Utc::now().to_rfc3339(),
            storage_id: None,
            source_prefix: String::new(),
            hidden,
        };
        db.execute(
            "INSERT INTO libraries(id,name,root,root_key,created_at,hidden) VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                library.id,
                library.name,
                library.root,
                root_key,
                library.created_at,
                library.hidden
            ],
        )?;
        Ok(library)
    }

    pub fn library(&self, id: &str) -> Result<Library> {
        self.db()?
            .query_row(
                &format!("SELECT {LIBRARY_COLUMNS} FROM libraries WHERE id=?1"),
                [id],
                library_row,
            )
            .optional()?
            .context("E_NOT_FOUND: Library does not exist")
    }

    pub fn bind_storage(
        &self,
        library_id: &str,
        storage_id: &str,
        prefix: &str,
    ) -> Result<Library> {
        let library = self.library(library_id)?;
        ensure!(
            library
                .storage_id
                .as_deref()
                .is_none_or(|id| id == storage_id && library.source_prefix == prefix),
            "E_CONFLICT: This library already belongs to a different storage directory"
        );
        self.db()?.execute(
            "UPDATE libraries SET storage_id=?1,source_prefix=?2 WHERE id=?3",
            params![storage_id, prefix, library_id],
        )?;
        self.library(library_id)
    }

    /// Opening a file never scans its siblings or adds a visible library implicitly.
    pub fn open_file(&self, path: &Path) -> Result<Asset> {
        let path = dunce::canonicalize(path).context("E_NOT_FOUND: Image file is unavailable")?;
        ensure!(path.is_file(), "E_INVALID: Open a regular image file");
        let extension = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let kind = imaging::kind(&extension)
            .context("E_UNSUPPORTED_CODEC: Unsupported image extension")?;
        let library = self
            .libraries()?
            .into_iter()
            .filter(|library| path_is_within(&path, Path::new(&library.root)))
            .max_by_key(|library| library.root.len());
        let library = match library {
            Some(library) => library,
            None => self.add_library_internal(
                "打开的文件",
                path.parent()
                    .context("E_INVALID: Image has no parent directory")?,
                true,
            )?,
        };
        self.index_file(&library, &path, kind, &extension, None)?;
        let key = path_key(&path.to_string_lossy());
        self.db()?
            .query_row(
                &format!("SELECT {ASSET_COLUMNS} FROM assets WHERE library_id=?1 AND path_key=?2"),
                params![library.id, key],
                asset_row,
            )
            .map_err(Into::into)
    }

    pub fn refresh_asset(&self, id: &str) -> Result<Asset> {
        let asset = self.asset(id)?;
        let library = self.library(&asset.library_id)?;
        let path = self.checked_asset_path(&asset)?;
        self.index_file(&library, &path, &asset.kind, &asset.extension, Some(&asset))?;
        self.asset(id)
    }

    pub fn invalidate_asset(&self, id: &str) -> Result<()> {
        self.asset(id)?;
        self.db()?
            .execute("UPDATE assets SET modified_stamp='' WHERE id=?1", [id])?;
        if let Ok(mut previews) = self.previews.lock() {
            previews.retain(|(key, _)| !key.starts_with(&format!("{id}:")));
        }
        Ok(())
    }

    pub fn use_refreshed_cache(&self, id: &str, filename: &str) -> Result<()> {
        ensure!(
            Path::new(filename).components().count() == 1
                && matches!(
                    Path::new(filename).components().next(),
                    Some(std::path::Component::Normal(_))
                ),
            "E_PATH: Cache filename must be one component"
        );
        let asset = self.asset(id)?;
        ensure!(
            asset.source_key.is_some(),
            "E_INVALID: Only remote originals use a cache"
        );
        let library = self.library(&asset.library_id)?;
        let path = Path::new(&library.root)
            .join(filename)
            .to_string_lossy()
            .into_owned();
        self.db()?.execute("UPDATE assets SET path=?1,path_key=?2,modified_stamp='',availability='remote' WHERE id=?3",params![path,path_key(&path),id])?;
        self.invalidate_asset(id)
    }

    pub fn register_remote_asset(
        &self,
        library_id: &str,
        source_key: &str,
        cache_filename: &str,
        size: u64,
    ) -> Result<Asset> {
        ensure!(
            size <= i64::MAX as u64,
            "E_LIMIT: Image size exceeds catalog range"
        );
        ensure!(!source_key.is_empty(), "E_INVALID: Remote key is empty");
        ensure!(
            Path::new(cache_filename).components().count() == 1
                && matches!(
                    Path::new(cache_filename).components().next(),
                    Some(std::path::Component::Normal(_))
                ),
            "E_INVALID: Cache filename must be a single component"
        );
        let library = self.library(library_id)?;
        ensure!(
            library.storage_id.is_some(),
            "E_INVALID: Remote library must have a storage source"
        );
        let filename = source_key.rsplit('/').next().unwrap_or(source_key);
        let extension = Path::new(filename)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let kind = imaging::kind(&extension)
            .context("E_UNSUPPORTED_CODEC: Unsupported image extension")?;
        let path = Path::new(&library.root)
            .join(cache_filename)
            .to_string_lossy()
            .into_owned();
        let old = self
            .db()?
            .query_row(
                &format!(
                    "SELECT {ASSET_COLUMNS} FROM assets WHERE library_id=?1 AND source_key=?2"
                ),
                params![library_id, source_key],
                asset_row,
            )
            .optional()?;
        if let Some(old) = &old {
            if (size == 0 || old.size == size) && old.availability != "missing" {
                return Ok(old.clone());
            }
        }
        let id = old
            .map(|asset| asset.id)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        self.db()?.execute(
            "INSERT INTO assets(id,library_id,path,path_key,filename,extension,kind,size,modified_at,modified_stamp,availability,source_key)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'','remote','remote',?9)
             ON CONFLICT(id) DO UPDATE SET path=excluded.path,path_key=excluded.path_key,filename=excluded.filename,size=excluded.size,width=NULL,height=NULL,metadata_json='{}',availability='remote'",
             params![id,library_id,path,path_key(&path),filename,extension,kind,size,source_key])?;
        self.asset(&id)
    }

    pub fn finish_remote_scan(&self, library_id: &str, keys: &[String]) -> Result<()> {
        let known = {
            let db = self.db()?;
            let mut statement = db.prepare(
                "SELECT id,source_key FROM assets WHERE library_id=?1 AND source_key IS NOT NULL",
            )?;
            let rows = statement
                .query_map([library_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let keys: std::collections::HashSet<_> = keys.iter().collect();
        for (id, key) in known {
            if !keys.contains(&key) {
                self.db()?
                    .execute("UPDATE assets SET availability='missing' WHERE id=?1", [id])?;
            }
        }
        Ok(())
    }

    pub fn asset(&self, id: &str) -> Result<Asset> {
        self.db()?
            .query_row(
                &format!("SELECT {ASSET_COLUMNS} FROM assets WHERE id=?1"),
                [id],
                asset_row,
            )
            .optional()?
            .context("E_NOT_FOUND: Asset does not exist")
    }

    fn checked_asset_path(&self, asset: &Asset) -> Result<PathBuf> {
        let library = self.library(&asset.library_id)?;
        let path = dunce::canonicalize(&asset.path)
            .context("E_OFFLINE: Original is missing or storage is disconnected")?;
        let root =
            dunce::canonicalize(&library.root).context("E_OFFLINE: Library is disconnected")?;
        ensure!(
            path_key(&root.to_string_lossy()) == path_key(&library.root),
            "E_PATH: Library root now resolves to a different directory"
        );
        ensure!(
            path_is_within(&path, &root),
            "E_PATH: Original now resolves outside the registered library"
        );
        ensure!(path.is_file(), "E_OFFLINE: Original is not a regular file");
        Ok(path)
    }

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
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0
                    || !entry.file_type().is_dir()
                    || !entry.file_name().to_string_lossy().starts_with('.')
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
            match self.index_file(&library, path, kind, &extension, None) {
                Ok((false, _)) => report.skipped += 1,
                Ok((true, error)) => {
                    report.indexed += 1;
                    if let Some(message) = error {
                        report.errors.push(ScanError {
                            path: path.to_string_lossy().into(),
                            message,
                        });
                    }
                }
                Err(error) => report.errors.push(ScanError {
                    path: path.to_string_lossy().into(),
                    message: format!("{error:#}"),
                }),
            }
        }
        // Keep missing assets (including their edits) so reconnecting is lossless.
        // Permission errors are not treated as deletion.
        let known = {
            let db = self.db()?;
            let mut statement = db.prepare("SELECT id,path FROM assets WHERE library_id=?1")?;
            let rows = statement
                .query_map([library_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (id, path) in known {
            match fs::metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.db()?
                        .execute("UPDATE assets SET availability='missing' WHERE id=?1", [id])?;
                }
                _ => {}
            }
        }
        Ok(report)
    }

    fn index_file(
        &self,
        library: &Library,
        path: &Path,
        kind: &str,
        extension: &str,
        registered_asset: Option<&Asset>,
    ) -> Result<(bool, Option<String>)> {
        let path = dunce::canonicalize(path)?;
        ensure!(
            path_is_within(&path, Path::new(&library.root)),
            "E_PATH: File resolves outside the library root"
        );
        let info = fs::metadata(&path)?;
        let modified = info.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let modified_nanos = modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let stamp = format!("{INSPECTION_VERSION}:{modified_nanos}");
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
        let old: Option<(String, u64, String, String)> = if let Some(asset) = registered_remote {
            Some(self.db()?.query_row(
                "SELECT id,size,modified_stamp,availability FROM assets WHERE id=?1 AND library_id=?2 AND path=?3 AND source_key=?4",
                params![asset.id, library.id, path_string, asset.source_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional()?.context("E_CONFLICT: Remote cache changed while reading; retry the image")?)
        } else {
            self.db()?.query_row(
                "SELECT id,size,modified_stamp,availability FROM assets WHERE library_id=?1 AND path_key=?2",
                params![library.id, key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional()?
        };
        if let Some((_, size, old_stamp, availability)) = &old {
            if *size == info.len()
                && *old_stamp == stamp
                && matches!(availability.as_str(), "available" | "unsupported")
            {
                return Ok((false, None));
            }
        }
        let id = old
            .map(|row| row.0)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let inspection = imaging::inspect(&path);
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
                let metadata = if info.len() <= imaging::MAX_FILE_BYTES {
                    imaging::read_exif(&path)
                } else {
                    BTreeMap::new()
                };
                (None, None, metadata, "unsupported", Some(error))
            }
        };
        if let Some(error) = &error {
            metadata.insert("Decode Status".into(), error.clone());
        }
        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let modified_at: DateTime<Utc> = modified.into();
        if let Some(asset) = registered_remote {
            // A scan can replace this cache revision while image inspection runs.
            // Update only the captured remote record, never create a local shadow
            // row or attach the old file's metadata to a newer cache revision.
            let source_key = asset.source_key.as_deref().expect("remote asset has a key");
            let changed = self.db()?.execute(
                "UPDATE assets SET filename=?1,extension=?2,kind=?3,size=?4,modified_at='',modified_stamp=?5,width=?6,height=?7,metadata_json=?8,availability=?9
                 WHERE id=?10 AND library_id=?11 AND path=?12 AND source_key=?13",
                params![source_key.rsplit('/').next().unwrap_or(source_key), extension, kind, info.len(), stamp, width, height, serde_json::to_string(&metadata)?, availability, asset.id, library.id, path_string, source_key],
            )?;
            ensure!(
                changed == 1,
                "E_CONFLICT: Remote cache changed while reading; retry the image"
            );
            return Ok((true, error));
        }
        self.db()?.execute(
            "INSERT INTO assets(id,library_id,path,path_key,filename,extension,kind,size,modified_at,modified_stamp,width,height,metadata_json,availability)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(library_id,path_key) DO UPDATE SET path=excluded.path,filename=excluded.filename,extension=excluded.extension,
             kind=excluded.kind,size=excluded.size,modified_at=excluded.modified_at,modified_stamp=excluded.modified_stamp,
             width=excluded.width,height=excluded.height,metadata_json=excluded.metadata_json,availability=excluded.availability",
            params![id, library.id, path_string, key, filename, extension, kind, info.len(), modified_at.to_rfc3339(), stamp, width, height, serde_json::to_string(&metadata)?, availability],
        )?;
        Ok((true, error))
    }

    fn list_assets(&self, args: AssetQuery) -> Result<Value> {
        let limit = args.limit.unwrap_or(200);
        ensure!(
            (1..=1000).contains(&limit),
            "E_INVALID: Query limit must be between 1 and 1000"
        );
        ensure!(
            args.rating.is_none_or(|rating| rating <= 5),
            "E_INVALID: Rating must be from 0 to 5"
        );
        let query = args.query.unwrap_or_default();
        ensure!(
            query.chars().count() <= 256,
            "E_INVALID: Search query is too long"
        );
        // Quote all user terms: FTS operators cannot escape into the expression.
        let search = query
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|word| !word.is_empty())
            .map(|word| format!("\"{word}\"*"))
            .collect::<Vec<_>>()
            .join(" AND ");
        let where_sql = "(?1 IS NULL OR library_id=?1) AND (?1 IS NOT NULL OR library_id IN (SELECT id FROM libraries WHERE hidden=0)) AND (?2 IS NULL OR rating>=?2) AND (?3='' OR rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?4))";
        let db = self.db()?;
        let total: u64 = db.query_row(
            &format!("SELECT COUNT(*) FROM assets WHERE {where_sql}"),
            params![
                args.library_id,
                args.rating,
                search,
                if search.is_empty() {
                    "\"__nebulume_no_query__\""
                } else {
                    &search
                }
            ],
            |row| row.get(0),
        )?;
        let mut statement = db.prepare(&format!("SELECT {ASSET_COLUMNS} FROM assets WHERE {where_sql} ORDER BY modified_at DESC,path ASC LIMIT ?5 OFFSET ?6"))?;
        let items = statement
            .query_map(
                params![
                    args.library_id,
                    args.rating,
                    search,
                    if search.is_empty() {
                        "\"__nebulume_no_query__\""
                    } else {
                        &search
                    },
                    limit,
                    args.offset.unwrap_or(0)
                ],
                asset_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({"items": items, "total": total}))
    }

    fn preview(&self, asset: &Asset, max_size: u32, uncropped: bool) -> Result<Value> {
        ensure!(
            (32..=4096).contains(&max_size),
            "E_INVALID: Preview max_size must be between 32 and 4096"
        );
        let path = self.checked_asset_path(asset)?;
        let info = fs::metadata(&path)?;
        let stamp = info
            .modified()?
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_nanos();
        let crop = if uncropped { None } else { asset.crop };
        let key = format!(
            "{}:{}:{}:{max_size}:{}",
            asset.id,
            stamp,
            info.len(),
            serde_json::to_string(&crop)?
        );
        if let Ok(mut cache) = self.previews.lock() {
            if let Some(position) = cache.iter().position(|entry| entry.0 == key) {
                let entry = cache.remove(position).expect("position from same queue");
                let result = entry.1.clone();
                cache.push_back(entry);
                return Ok(result);
            }
        }
        let value = imaging::preview(&path, crop, max_size)?;
        if let Ok(mut cache) = self.previews.lock() {
            cache.push_back((key, value.clone()));
            while cache.len() > 48
                || cache
                    .iter()
                    .map(|(_, value)| value["data_url"].as_str().map(str::len).unwrap_or(0))
                    .sum::<usize>()
                    > 64 * 1024 * 1024
            {
                cache.pop_front();
            }
        }
        Ok(value)
    }
}

#[derive(Deserialize)]
struct AssetQuery {
    library_id: Option<String>,
    query: Option<String>,
    rating: Option<u8>,
    limit: Option<u32>,
    offset: Option<u32>,
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params).context("E_INVALID: Invalid or missing command parameters")
}

fn id(params: &Value) -> Result<String> {
    params
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .context("E_INVALID: Asset id is required")
}

fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

// Inputs are canonical paths, or roots recorded from canonicalization. Do not
// simplify the I/O path: long Windows paths still need their verbatim prefix.
// Only the drive/UNC prefix representation is equivalent; all remaining path
// components retain their exact comparison and component boundaries.
fn path_is_within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        root.components().all(|expected| {
            let Some(actual) = components.next() else {
                return false;
            };
            match (actual, expected) {
                (Component::Prefix(actual), Component::Prefix(expected)) => {
                    match (actual.kind(), expected.kind()) {
                        (
                            Prefix::Disk(a) | Prefix::VerbatimDisk(a),
                            Prefix::Disk(b) | Prefix::VerbatimDisk(b),
                        ) => a == b,
                        (
                            Prefix::UNC(a_server, a_share) | Prefix::VerbatimUNC(a_server, a_share),
                            Prefix::UNC(b_server, b_share) | Prefix::VerbatimUNC(b_server, b_share),
                        ) => a_server == b_server && a_share == b_share,
                        (a, b) => a == b,
                    }
                }
                (a, b) => a == b,
            }
        })
    }
    #[cfg(not(windows))]
    path.starts_with(root)
}

fn library_row(row: &Row<'_>) -> rusqlite::Result<Library> {
    Ok(Library {
        id: row.get(0)?,
        name: row.get(1)?,
        root: row.get(2)?,
        created_at: row.get(3)?,
        storage_id: row.get(4)?,
        source_prefix: row.get(5)?,
        hidden: row.get(6)?,
    })
}

fn json_column<T: serde::de::DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    let value: String = row.get(index)?;
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn asset_row(row: &Row<'_>) -> rusqlite::Result<Asset> {
    let crop: Option<String> = row.get(12)?;
    let crop = crop
        .map(|value| {
            serde_json::from_str(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    12,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()?;
    Ok(Asset {
        id: row.get(0)?,
        library_id: row.get(1)?,
        path: row.get(2)?,
        filename: row.get(3)?,
        extension: row.get(4)?,
        kind: row.get(5)?,
        size: row.get(6)?,
        modified_at: row.get(7)?,
        width: row.get(8)?,
        height: row.get(9)?,
        rating: row.get(10)?,
        metadata: json_column(row, 11)?,
        crop,
        availability: row.get(13)?,
        source_key: row.get(14)?,
    })
}

#[cfg(all(test, windows))]
mod windows_path_tests {
    use super::path_is_within;
    use std::path::Path;

    #[test]
    fn verbatim_aliases_preserve_drive_share_and_component_boundaries() {
        for (path, root, expected) in [
            (r"\\?\C:\photos\cache.jpg", r"C:\photos", true),
            (r"C:\photos\cache.jpg", r"\\?\C:\photos", true),
            (r"\\?\UNC\nas\photos\cache.jpg", r"\\nas\photos", true),
            (r"\\nas\photos\cache.jpg", r"\\?\UNC\nas\photos", true),
            (r"\\?\D:\photos\cache.jpg", r"C:\photos", false),
            (r"\\?\C:\photos-other\cache.jpg", r"C:\photos", false),
            (
                r"\\?\UNC\other-nas\photos\cache.jpg",
                r"\\nas\photos",
                false,
            ),
            (
                r"\\?\UNC\nas\photos-other\cache.jpg",
                r"\\nas\photos",
                false,
            ),
            (r"\\.\C:\photos\cache.jpg", r"C:\photos", false),
            (r"\\?\Volume{sample}\photos\cache.jpg", r"C:\photos", false),
        ] {
            assert_eq!(
                path_is_within(Path::new(path), Path::new(root)),
                expected,
                "{path} within {root}"
            );
        }
    }
}

#[cfg(test)]
mod remote_refresh_tests {
    use super::Core;
    use serde_json::json;
    use std::{fs, path::Path};

    #[test]
    fn stale_remote_cache_cannot_create_a_shadow_asset_after_revision_changes() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().join("cache");
        fs::create_dir(&root).unwrap();
        let core = Core::open(data.path().join("catalog")).unwrap();
        let library = core.add_library("remote", &root).unwrap();
        core.bind_storage(&library.id, "source", "album").unwrap();
        let captured = core
            .register_remote_asset(&library.id, "album/photo.ppm", "old.ppm", 17)
            .unwrap();
        let photo = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";
        fs::write(&captured.path, photo).unwrap();
        core.dispatch("asset.rate", json!({"id":captured.id,"rating":4}))
            .unwrap();
        core.dispatch(
            "asset.crop",
            json!({"id":captured.id,"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
        )
        .unwrap();
        // Model a concurrent scan changing the cache revision after a reader has
        // captured its old Asset. The old file remains readable but is no longer current.
        core.use_refreshed_cache(&captured.id, "new.ppm").unwrap();
        fs::write(root.join("new.ppm"), photo).unwrap();
        let error = core
            .index_file(
                &library,
                Path::new(&captured.path),
                "raster",
                "ppm",
                Some(&captured),
            )
            .unwrap_err();
        assert!(error.to_string().contains("E_CONFLICT"));
        assert_eq!(core.dispatch("asset.list", json!({})).unwrap()["total"], 1);
        let current = core.refresh_asset(&captured.id).unwrap();
        assert_eq!(current.id, captured.id);
        assert_eq!(current.source_key, captured.source_key);
        assert!(current.path.ends_with("new.ppm"));
        assert_eq!(current.rating, 4);
        assert_eq!(current.crop.unwrap().width, 0.5);
        assert_eq!(current.width, Some(2));
    }
}

#[cfg(test)]
mod inspection_cache_tests {
    use super::Core;
    use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};
    use rusqlite::params;
    use serde_json::json;
    use std::{fs, path::Path, time::SystemTime};

    fn jpeg() -> Vec<u8> {
        let mut bytes = Vec::new();
        JpegEncoder::new(&mut bytes)
            .encode_image(&RgbImage::from_pixel(8, 6, Rgb([30, 90, 160])))
            .unwrap();
        bytes
    }

    fn unsupported_camera_with_preview() -> Vec<u8> {
        let jpeg = jpeg();
        let mut tiff = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
        tiff.extend(2u16.to_le_bytes());
        for (tag, value) in [(513u16, 38u32), (514, jpeg.len() as u32)] {
            tiff.extend(tag.to_le_bytes());
            tiff.extend(4u16.to_le_bytes());
            tiff.extend(1u32.to_le_bytes());
            tiff.extend(value.to_le_bytes());
        }
        tiff.extend(0u32.to_le_bytes());
        tiff.extend(jpeg);
        tiff
    }

    #[test]
    fn legacy_inspection_is_upgraded_from_existing_files_without_losing_identity_or_edits() {
        for (remote, extension, old_availability) in [
            (false, "jpg", "available"),
            (true, "jpg", "available"),
            (true, "nef", "unsupported"),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("photos");
            let catalog = temp.path().join("catalog");
            fs::create_dir(&root).unwrap();
            let core = Core::open(&catalog).unwrap();
            let library = core.add_library("legacy", &root).unwrap();
            let filename = format!("photo.{extension}");
            let original = if extension == "nef" {
                unsupported_camera_with_preview()
            } else {
                jpeg()
            };
            fs::write(root.join(&filename), &original).unwrap();
            let asset = if remote {
                core.bind_storage(&library.id, "offline-source", "album")
                    .unwrap();
                core.register_remote_asset(
                    &library.id,
                    &format!("album/{filename}"),
                    &filename,
                    original.len() as u64,
                )
                .unwrap()
            } else {
                core.open_file(&root.join(&filename)).unwrap()
            };
            core.dispatch("asset.rate", json!({"id":asset.id,"rating":4}))
                .unwrap();
            core.dispatch(
                "asset.crop",
                json!({"id":asset.id,"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
            )
            .unwrap();
            let old_stamp = fs::metadata(&asset.path)
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
                .to_string();
            core.db().unwrap().execute(
                "UPDATE assets SET modified_stamp=?1,availability=?2,width=0,height=0,metadata_json=?3 WHERE id=?4",
                params![old_stamp, old_availability, r#"{"Artist":"[[]]","Legacy Inspection":"old","Decode Status":"old unsupported"}"#, asset.id],
            ).unwrap();
            drop(core);
            let core = Core::open(&catalog).unwrap();
            // No directory scan or remote read: only the already cached file is inspected.
            let refreshed = core.refresh_asset(&asset.id).unwrap();
            assert_eq!(refreshed.id, asset.id);
            assert_eq!(refreshed.path, asset.path);
            assert_eq!(refreshed.source_key, asset.source_key);
            assert_eq!(refreshed.rating, 4);
            assert_eq!(refreshed.crop.unwrap().width, 0.5);
            assert_eq!((refreshed.width, refreshed.height), (Some(8), Some(6)));
            assert_eq!(refreshed.availability, "available");
            assert!(!refreshed.metadata.contains_key("Artist"));
            assert!(!refreshed.metadata.contains_key("Legacy Inspection"));
            assert!(!serde_json::to_string(&refreshed)
                .unwrap()
                .contains("inspect-v"));
            if extension == "nef" {
                assert_eq!(refreshed.metadata["Preview Source"], "embedded_jpeg");
            }
            assert_eq!(refreshed.modified_at.is_empty(), remote);
            let repeated = core
                .index_file(
                    &library,
                    Path::new(&refreshed.path),
                    &refreshed.kind,
                    extension,
                    Some(&refreshed),
                )
                .unwrap();
            assert!(
                !repeated.0,
                "an unchanged current-version inspection must be reused"
            );
            assert_eq!(core.dispatch("asset.list", json!({})).unwrap()["total"], 1);
            assert_eq!(fs::read(&asset.path).unwrap(), original);
        }
    }

    #[test]
    fn unsupported_inspection_is_memoized_but_explicit_invalidation_retries() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("photos");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("damaged.nef"), b"not a raw image").unwrap();
        let core = Core::open(temp.path().join("catalog")).unwrap();
        let library = core.add_library("unsupported", &root).unwrap();
        let first = core.scan(&library.id).unwrap();
        assert_eq!(first.indexed, 1);
        assert_eq!(first.errors.len(), 1);
        let asset = core.dispatch("asset.list", json!({})).unwrap()["items"][0].clone();
        assert_eq!(asset["availability"], "unsupported");
        let second = core.scan(&library.id).unwrap();
        assert_eq!(second.indexed, 0);
        assert_eq!(second.skipped, 1);
        core.invalidate_asset(asset["id"].as_str().unwrap())
            .unwrap();
        let retried = core.scan(&library.id).unwrap();
        assert_eq!(retried.indexed, 1);
        assert_eq!(retried.errors.len(), 1);
        assert_eq!(
            core.dispatch("asset.list", json!({})).unwrap()["items"][0]["id"],
            asset["id"]
        );
    }
}
