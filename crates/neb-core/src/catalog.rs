use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

use anyhow::{anyhow, bail, ensure, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
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

const ASSET_COLUMNS: &str = "id,library_id,path,filename,extension,kind,size,modified_at,width,height,rating,metadata_json,crop_json,availability";

impl Core {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(data_dir.as_ref()).context("E_IO: Cannot create catalog directory")?;
        let database = Connection::open(data_dir.as_ref().join("catalog.sqlite3"))?;
        database.busy_timeout(Duration::from_secs(5))?;
        database.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        )?;
        let version: i64 = database.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            version <= 1,
            "E_SCHEMA: Catalog was created by a newer version of Nebulume"
        );
        database.execute_batch(include_str!("schema.sql"))?;
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
        let mut statement =
            db.prepare("SELECT id,name,root,created_at FROM libraries ORDER BY created_at,id")?;
        let result = statement
            .query_map([], library_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(result)
    }

    pub fn add_library(&self, name: &str, root: &Path) -> Result<Library> {
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
                "SELECT id,name,root,created_at FROM libraries WHERE root_key=?1",
                [&root_key],
                library_row,
            )
            .optional()?
        {
            return Ok(existing);
        }
        let library = Library {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            root: root_string,
            created_at: Utc::now().to_rfc3339(),
        };
        db.execute(
            "INSERT INTO libraries(id,name,root,root_key,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![
                library.id,
                library.name,
                library.root,
                root_key,
                library.created_at
            ],
        )?;
        Ok(library)
    }

    fn library(&self, id: &str) -> Result<Library> {
        self.db()?
            .query_row(
                "SELECT id,name,root,created_at FROM libraries WHERE id=?1",
                [id],
                library_row,
            )
            .optional()?
            .context("E_NOT_FOUND: Library does not exist")
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
            path.starts_with(&root),
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
            match self.index_file(&library, path, kind, &extension) {
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
    ) -> Result<(bool, Option<String>)> {
        let path = dunce::canonicalize(path)?;
        ensure!(
            path.starts_with(&library.root),
            "E_PATH: File resolves outside the library root"
        );
        let info = fs::metadata(&path)?;
        let modified = info.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let stamp = modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_string();
        let path_string = path
            .to_str()
            .context("E_INVALID: Image path is not valid Unicode")?
            .to_owned();
        let key = path_key(&path_string);
        let old: Option<(String, u64, String, String)> = self.db()?.query_row(
            "SELECT id,size,modified_stamp,availability FROM assets WHERE library_id=?1 AND path_key=?2",
            params![library.id, key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        if let Some((_, size, old_stamp, availability)) = &old {
            if *size == info.len() && *old_stamp == stamp && availability == "available" {
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
        let where_sql = "(?1 IS NULL OR library_id=?1) AND (?2 IS NULL OR rating>=?2) AND (?3='' OR rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?4))";
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

fn library_row(row: &Row<'_>) -> rusqlite::Result<Library> {
    Ok(Library {
        id: row.get(0)?,
        name: row.get(1)?,
        root: row.get(2)?,
        created_at: row.get(3)?,
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
    })
}
