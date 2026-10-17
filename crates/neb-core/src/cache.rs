//! Owned, budgeted disk cache. The catalog is the authority for object locations;
//! asset paths remain compatibility metadata and are never rewritten by migration.
use anyhow::{ensure, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
    thread,
    time::Duration,
};
use uuid::Uuid;
use walkdir::WalkDir;

const MARKER: &str = ".nebulume-cache-owner.json";
const DEFAULT_BUDGET: u64 = 10 * 1024 * 1024 * 1024;

#[cfg(test)]
#[derive(Clone, Copy, Default)]
struct PerfCounters {
    root_walks: u64,
    object_rows: u64,
    path_stats: u64,
    lock_depth: u64,
    hash_bytes_under_lock: u64,
}
#[cfg(test)]
thread_local! {
    static PERF:std::cell::Cell<PerfCounters>=std::cell::Cell::new(PerfCounters::default());
    static HASH_HOOK:std::cell::RefCell<Option<Box<dyn FnOnce()>>>=std::cell::RefCell::new(None);
}
#[cfg(test)]
fn record_perf(action: impl FnOnce(&mut PerfCounters)) {
    PERF.with(|cell| {
        let mut value = cell.get();
        action(&mut value);
        cell.set(value);
    });
}

#[derive(Clone, Serialize, Deserialize)]
struct Policy {
    budget_bytes: u64,
    max_unused_days: u64,
    preview_policy: String,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            budget_bytes: DEFAULT_BUDGET,
            max_unused_days: 30,
            preview_policy: "automatic".into(),
        }
    }
}
#[derive(Serialize, Deserialize)]
struct Owner {
    version: u32,
    catalog_id: String,
    root_id: String,
}
#[derive(Clone)]
struct Root {
    id: String,
    path: PathBuf,
}
#[derive(Clone)]
struct Object {
    id: String,
    root: Root,
    relative: String,
    kind: String,
    size: u64,
    hash: String,
    used: i64,
    pinned: bool,
}
struct Inner {
    database: PathBuf,
    lock: PathBuf,
    owner: String,
    session: String,
    _session_file: File,
}
#[derive(Clone)]
pub struct CacheManager {
    inner: Arc<Inner>,
}
/// Keeps the exact physical version alive, including across a root switch.
pub struct CacheLease {
    manager: CacheManager,
    id: String,
    path: PathBuf,
}
impl CacheLease {
    pub fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for CacheLease {
    fn drop(&mut self) {
        let _ = self.manager.locked(|db| {
            let cleanup:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM cache_leases l WHERE l.id=?1 AND (
                EXISTS(SELECT 1 FROM cache_objects o WHERE o.id=l.object_id AND o.evict=1)
                OR EXISTS(SELECT 1 FROM cache_migration_items i JOIN cache_migrations m ON m.id=i.job_id
                    WHERE i.from_root=l.root_id AND i.from_relative=l.relative_path AND i.cleaned=0 AND m.committed=1 AND m.status='cleanup_pending')))", [&self.id],|r|r.get(0))?;
            db.execute("DELETE FROM cache_leases WHERE id=?1", [&self.id])?;
            if cleanup {self.manager.cleanup_migrations(db)?;}
            Ok(())
        });
    }
}
/// An owned partial and a reservation for its maximum size. Dropping it never
/// removes an unrelated path, and a failed cleanup remains represented in SQLite.
pub struct Reservation {
    manager: CacheManager,
    id: String,
    path: PathBuf,
    committed: bool,
}
impl Reservation {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn commit(self, asset_id: Option<&str>) -> Result<CacheLease> {
        self.commit_verified(asset_id, None)
    }
    pub fn commit_verified(
        mut self,
        asset_id: Option<&str>,
        expected_sha256: Option<&str>,
    ) -> Result<CacheLease> {
        let lease = self
            .manager
            .commit_reservation(&self.id, asset_id, expected_sha256)?;
        self.committed = true;
        Ok(lease)
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self
                .manager
                .locked(|db| self.manager.release_reservation(db, &self.id));
        }
    }
}
struct Guard(File);
impl Drop for Guard {
    fn drop(&mut self) {
        #[cfg(test)]
        record_perf(|p| p.lock_depth -= 1);
        let _ = self.0.unlock();
    }
}

impl CacheManager {
    pub fn open(database_path: impl AsRef<Path>, default_root: impl AsRef<Path>) -> Result<Self> {
        let database = absolute(database_path.as_ref())?;
        fs::create_dir_all(
            database
                .parent()
                .context("E_CACHE: Catalog has no parent")?,
        )?;
        let lock = database.with_extension("cache.lock");
        let _guard = global_lock(&lock)?;
        let db = connect(&database)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS cache_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cache_roots(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE);
            CREATE TABLE IF NOT EXISTS cache_objects(id TEXT PRIMARY KEY,cache_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,root_id TEXT NOT NULL,relative_path TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,last_used INTEGER NOT NULL,evict INTEGER NOT NULL DEFAULT 0,UNIQUE(root_id,relative_path));
            CREATE TABLE IF NOT EXISTS cache_assets(asset_id TEXT PRIMARY KEY,object_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cache_asset_revisions(asset_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cache_asset_snapshots(asset_id TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cache_unmanaged_files(root_id TEXT NOT NULL,relative_path TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(root_id,relative_path));
            CREATE TABLE IF NOT EXISTS cache_object_sizes(object_id TEXT PRIMARY KEY,size INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS cache_pins(asset_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS cache_sessions(id TEXT PRIMARY KEY,path TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cache_leases(id TEXT PRIMARY KEY,object_id TEXT NOT NULL,root_id TEXT NOT NULL,relative_path TEXT NOT NULL,session_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cache_reservations(id TEXT PRIMARY KEY,cache_key TEXT NOT NULL,kind TEXT NOT NULL,root_id TEXT NOT NULL,relative_path TEXT NOT NULL,bytes INTEGER NOT NULL,session_id TEXT,created INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS cache_migrations(id TEXT PRIMARY KEY,status TEXT NOT NULL,from_root TEXT NOT NULL,to_path TEXT NOT NULL,to_root TEXT,mode TEXT NOT NULL,allow_overage INTEGER NOT NULL DEFAULT 0,total_bytes INTEGER NOT NULL,copied_bytes INTEGER NOT NULL DEFAULT 0,cancel INTEGER NOT NULL DEFAULT 0,committed INTEGER NOT NULL DEFAULT 0,error TEXT,session_id TEXT);
            CREATE TABLE IF NOT EXISTS cache_migration_items(job_id TEXT NOT NULL,object_id TEXT NOT NULL,from_root TEXT NOT NULL,from_relative TEXT NOT NULL,to_relative TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,copied INTEGER NOT NULL DEFAULT 0,cleaned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,object_id));
            CREATE INDEX IF NOT EXISTS cache_assets_object ON cache_assets(object_id);
            CREATE INDEX IF NOT EXISTS cache_leases_object ON cache_leases(object_id);
            CREATE INDEX IF NOT EXISTS cache_leases_path ON cache_leases(root_id,relative_path);
            CREATE INDEX IF NOT EXISTS cache_objects_expiry ON cache_objects(kind,last_used);
            CREATE INDEX IF NOT EXISTS cache_migration_items_object ON cache_migration_items(object_id);")?;
        let owner = setting(&db, "owner")?.unwrap_or_else(|| Uuid::new_v4().to_string());
        put_setting(&db, "owner", &owner)?;
        if setting(&db, "policy")?.is_none() {
            put_setting(&db, "policy", &serde_json::to_string(&Policy::default())?)?;
        }
        if setting(&db, "active_root")?.is_none() {
            let path = absolute(default_root.as_ref())?;
            reject_root(&path)?;
            reject_links(&path)?;
            fs::create_dir_all(&path)?;
            let path = dunce::canonicalize(path)?;
            let root = Root {
                id: Uuid::new_v4().to_string(),
                path,
            };
            // Only the caller's default legacy cache may be nonempty. Unadopted
            // files are counted as unmanaged and are never reclamation candidates.
            claim_root(&root, &owner)?;
            db.execute(
                "INSERT INTO cache_roots(id,path) VALUES(?1,?2)",
                params![root.id, path_text(&root.path)?],
            )?;
            put_setting(&db, "active_root", &root.id)?;
        }
        let session = Uuid::new_v4().to_string();
        let session_path = database.with_file_name(format!(".cache-session-{session}.lock"));
        let session_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&session_path)?;
        session_file.lock()?;
        db.execute(
            "INSERT INTO cache_sessions(id,path) VALUES(?1,?2)",
            params![session, path_text(&session_path)?],
        )?;
        let manager = Self {
            inner: Arc::new(Inner {
                database,
                lock,
                owner,
                session,
                _session_file: session_file,
            }),
        };
        manager.recover(&db)?;
        manager.cleanup_migrations(&db)?;
        manager.reconcile_inventory(&db)?;
        // Existing over-budget pinned or disconnected data must not prevent
        // startup. New reservations will report the unsatisfied bound.
        let _ = manager.ensure_capacity(&db, 0, &policy(&db)?);
        Ok(manager)
    }
    fn locked<T>(&self, action: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let _guard = global_lock(&self.inner.lock)?;
        let mut db = connect(&self.inner.database)?;
        self.recover(&db)?;
        action(&mut db)
    }
    fn recover(&self, db: &Connection) -> Result<()> {
        let sessions = rows2(db, "SELECT id,path FROM cache_sessions", [])?;
        for (id, path) in sessions {
            if id == self.inner.session {
                continue;
            }
            let stale = match OpenOptions::new().read(true).write(true).open(&path) {
                Ok(file) => file.try_lock().is_ok(),
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            };
            if !stale {
                continue;
            }
            db.execute("DELETE FROM cache_leases WHERE session_id=?1", [&id])?;
            db.execute(
                "UPDATE cache_reservations SET session_id=NULL,bytes=0 WHERE session_id=?1",
                [&id],
            )?;
            db.execute("UPDATE cache_migrations SET status=CASE WHEN committed=1 THEN 'cleanup_pending' ELSE 'failed' END,error='Interrupted by process exit; the committed root remains authoritative' WHERE session_id=?1 AND status='running'", [&id])?;
            db.execute("DELETE FROM cache_sessions WHERE id=?1", [&id])?;
        }
        Ok(())
    }
    pub fn state(&self) -> Result<Value> {
        self.locked(|db| {
            self.reconcile_inventory(db)?;
            self.state_db(db)
        })
    }
    /// Read the download preference without triggering disk reconciliation.
    pub fn preview_policy(&self) -> Result<String> {
        self.locked(|db| Ok(policy(db)?.preview_policy))
    }
    /// Reclaim expired or excess local cache data without accessing a source.
    /// Call after legacy adoption so startup maintenance includes those objects.
    pub fn maintain(&self) -> Result<()> {
        self.locked(|db| {
            let root = active_root(db)?;
            verify_root(&root, &self.inner.owner).context(
                "E_CACHE_OFFLINE: Cache location is unavailable; no fallback location was created",
            )?;
            self.reconcile_inventory(db)?;
            self.cleanup_migrations(db)?;
            self.ensure_capacity(db, 0, &policy(db)?)
        })
    }
    fn state_db(&self, db: &Connection) -> Result<Value> {
        let root = active_root(db)?;
        let online = verify_root(&root, &self.inner.owner).is_ok();
        let usage = self.usage(db)?;
        let mut pinned = Vec::new();
        let mut query = db.prepare("SELECT a.asset_id,o.size,o.last_used FROM cache_pins p JOIN cache_assets a ON a.asset_id=p.asset_id JOIN cache_objects o ON o.id=a.object_id ORDER BY o.last_used DESC")?;
        for row in query.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })? {
            let (id, size, used) = row?;
            let name = db
                .query_row("SELECT filename FROM assets WHERE id=?1", [&id], |r| {
                    r.get::<_, String>(0)
                })
                .ok()
                .or_else(|| {
                    let snapshot = db
                        .query_row(
                            "SELECT snapshot_json FROM cache_asset_snapshots WHERE asset_id=?1",
                            [&id],
                            |r| r.get::<_, String>(0),
                        )
                        .ok()?;
                    serde_json::from_str::<Value>(&snapshot).ok()?["filename"]
                        .as_str()
                        .map(str::to_string)
                })
                .unwrap_or_else(|| id.clone());
            pinned.push(json!({"asset_id":id,"name":name,"size":size,"last_used":used}));
        }
        let migration = latest_migration(db)?;
        Ok(
            json!({"policy":policy(db)?,"location":{"path":root.path,"state":if online {"online"} else {"offline"},"available_bytes":if online {available_space(&root.path).ok()} else {None}},"usage":usage,"objects_count":db.query_row("SELECT COUNT(*) FROM cache_objects",[],|r|r.get::<_,u64>(0))?,"pinned":pinned,"migration":migration}),
        )
    }
    pub fn set_policy(&self, value: Value) -> Result<Value> {
        self.locked(|db| {
            ensure!(!migration_running(db)?,"E_CACHE_BUSY: Wait for cache migration before changing its budget");
            let previous = policy(db)?;
            let mut next = previous.clone();
            if let Some(v) = value.get("budget_bytes") { next.budget_bytes = v.as_u64().context("E_INVALID: budget_bytes must be a nonnegative integer")?; }
            if let Some(v) = value.get("max_unused_days") { next.max_unused_days = v.as_u64().context("E_INVALID: max_unused_days must be nonnegative")?; }
            if let Some(v) = value.get("preview_policy") { next.preview_policy = v.as_str().context("E_INVALID: preview_policy must be a string")?.into(); }
            ensure!(["automatic","manual"].contains(&next.preview_policy.as_str()),"E_INVALID: Invalid preview policy");
            ensure!((1024*1024*1024..=1024u64*1024*1024*1024).contains(&next.budget_bytes) && next.max_unused_days <= 36500,"E_INVALID: Cache budget must be between 1 and 1024 GiB and expiry at most 36500 days");
            if verify_root(&active_root(db)?, &self.inner.owner).is_err() {
                ensure!(next.budget_bytes >= previous.budget_bytes
                    && next.max_unused_days == previous.max_unused_days
                    && next.preview_policy == previous.preview_policy,
                    "E_CACHE_OFFLINE: Reconnect the cache location before reducing its budget or changing its cleanup policy");
                put_setting(db,"policy",&serde_json::to_string(&next)?)?;
                return self.state_db(db);
            }
            self.reconcile_inventory(db)?;
            let current = self.usage(db)?["total_bytes"].as_u64().unwrap_or(0);
            let candidates = self.candidates(db, &json!({"originals":true,"previews":true,"temporary":true}))?;
            let reclaim: u64 = candidates.iter().map(|c|c.size).sum();
            ensure!(current.saturating_sub(reclaim) <= next.budget_bytes,"E_CACHE_BUDGET: Pinned, in-use, reserved or unmanaged files exceed the requested budget");
            // All deletions remain separately committed facts; the policy itself
            // changes only if the new bound has actually been met.
            self.ensure_capacity(db, 0, &next)?;
            put_setting(db,"policy",&serde_json::to_string(&next)?)?;
            self.state_db(db)
        })
    }
    pub fn adopt_original(&self, asset_id: &str, path: impl AsRef<Path>) -> Result<()> {
        self.locked(|db| {
            let mapped:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM cache_assets WHERE asset_id=?1)",[asset_id],|r|r.get(0))?;
            if mapped {return Ok(());}
            let path = dunce::canonicalize(path.as_ref()).context("E_CACHE: Legacy original is unavailable")?;
            reject_links(&path)?;
            let roots = all_roots(db)?;
            let root = roots.into_iter().filter(|r|relative_under(&path,&r.path).is_some()).max_by_key(|r|r.path.components().count()).context("E_CACHE: Legacy file is outside managed cache roots")?;
            verify_root(&root,&self.inner.owner)?;
            let relative = relative_text(&relative_under(&path,&root.path).context("E_CACHE: Legacy file escaped its root")?)?;
            let (size,hash) = hash_file(&path)?;
            let existing = db.query_row("SELECT id FROM cache_objects WHERE root_id=?1 AND relative_path=?2",params![root.id,relative],|r|r.get::<_,String>(0)).optional()?;
            let id = existing.unwrap_or_else(||Uuid::new_v4().to_string());
            db.execute("INSERT OR IGNORE INTO cache_objects(id,cache_key,kind,root_id,relative_path,size,sha256,last_used) VALUES(?1,?2,'original',?3,?4,?5,?6,?7)",params![id,format!("legacy:{id}"),root.id,relative,size,hash,now()])?;
            db.execute("INSERT INTO cache_assets(asset_id,object_id) VALUES(?1,?2) ON CONFLICT(asset_id) DO UPDATE SET object_id=excluded.object_id",params![asset_id,id])?;
            db.execute("DELETE FROM cache_unmanaged_files WHERE root_id=?1 AND relative_path=?2",params![root.id,relative])?;
            Ok(())
        })
    }
    /// Check catalog registration without opening the file or updating its LRU.
    pub fn original_registered(&self, asset_id: &str) -> Result<bool> {
        self.locked(|db| {
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM cache_assets WHERE asset_id=?1)",
                [asset_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
    }
    pub fn legacy_adoption_complete(&self) -> Result<bool> {
        self.locked(|db| Ok(setting(db, "legacy_adoption_complete")?.as_deref() == Some("1")))
    }
    pub fn mark_legacy_adoption_complete(&self) -> Result<()> {
        self.locked(|db| put_setting(db, "legacy_adoption_complete", "1"))
    }
    pub fn acquire_original(&self, asset_id: &str) -> Result<Option<CacheLease>> {
        self.locked(|db| {
            let id = db
                .query_row(
                    "SELECT object_id FROM cache_assets WHERE asset_id=?1",
                    [asset_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            match id {
                Some(id) => self.lease(db, &id),
                None => Ok(None),
            }
        })
    }
    fn lease(&self, db: &Connection, object_id: &str) -> Result<Option<CacheLease>> {
        let Some(object) = object(db, object_id)? else {
            return Ok(None);
        };
        verify_root(&object.root,&self.inner.owner).context("E_CACHE_OFFLINE: Cache location is unavailable; reconnect it or explicitly choose a new location")?;
        let path = scoped_path(&object.root, &object.relative)?;
        if !path.is_file() {
            return Ok(None);
        }
        let id = Uuid::new_v4().to_string();
        db.execute("INSERT INTO cache_leases(id,object_id,root_id,relative_path,session_id) VALUES(?1,?2,?3,?4,?5)",params![id,object.id,object.root.id,object.relative,self.inner.session])?;
        db.execute(
            "UPDATE cache_objects SET last_used=?1 WHERE id=?2",
            params![now(), object.id],
        )?;
        Ok(Some(CacheLease {
            manager: self.clone(),
            id,
            path,
        }))
    }
    pub fn reserve(&self, key: &str, kind: &str, size: u64) -> Result<Reservation> {
        ensure!(
            ["original", "preview", "temporary"].contains(&kind),
            "E_INVALID: Invalid cache object kind"
        );
        ensure!(
            size <= i64::MAX as u64 && key.len() <= 2048 && !key.is_empty(),
            "E_INVALID: Invalid cache reservation"
        );
        self.locked(|db| {
            ensure!(!migration_running(db)?,"E_CACHE_BUSY: Cache migration is in progress");
            let root = active_root(db)?;
            verify_root(&root,&self.inner.owner).context("E_CACHE_OFFLINE: Cache location is unavailable; no fallback location was created")?;
            self.ensure_capacity(db,size,&policy(db)?)?;
            let outstanding = self.usage(db)?["reserved_bytes"].as_u64().unwrap_or(0);
            ensure!(available_space(&root.path)? >= size.saturating_add(outstanding),"E_CACHE_SPACE: Not enough space after existing download reservations");
            let id = Uuid::new_v4().to_string();
            let relative = format!("temporary/{id}.partial");
            let path = scoped_path(&root,&relative)?;
            fs::create_dir_all(path.parent().unwrap())?;
            reject_links(path.parent().unwrap())?;
            OpenOptions::new().write(true).create_new(true).open(&path)?;
            if let Err(error) = db.execute("INSERT INTO cache_reservations(id,cache_key,kind,root_id,relative_path,bytes,session_id,created) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![id,key,kind,root.id,relative,size,self.inner.session,now()]) { let _=fs::remove_file(&path); return Err(error.into()); }
            Ok(Reservation {manager:self.clone(),id,path,committed:false})
        })
    }
    fn commit_reservation(
        &self,
        id: &str,
        asset_id: Option<&str>,
        expected: Option<&str>,
    ) -> Result<CacheLease> {
        // The reservation and session protect this partial while its potentially
        // large hash/fsync runs. Never hold the cross-process cache lock across
        // a full original-file read.
        let source=self.locked(|db| {
            let (root_id,relative):(String,String)=db.query_row("SELECT root_id,relative_path FROM cache_reservations WHERE id=?1 AND session_id=?2",params![id,self.inner.session],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let root=get_root(db,&root_id)?;
            verify_root(&root,&self.inner.owner)?;
            scoped_path(&root,&relative)
        })?;
        let file = OpenOptions::new().read(true).write(true).open(&source)?;
        file.sync_all()?;
        let before = file.metadata()?;
        let (size, hash) = hash_file(&source)?;
        let verified = file.metadata()?;
        ensure!(
            before.len() == size
                && verified.len() == size
                && before.modified()? == verified.modified()?,
            "E_CACHE_VERIFY: Partial changed while verifying"
        );
        ensure!(
            expected.is_none_or(|v| v == hash),
            "E_CACHE_VERIFY: Cached content does not match the expected SHA-256"
        );
        drop(file);
        self.locked(|db| {
            let (key,kind,root_id,relative,bound): (String,String,String,String,u64) = db.query_row("SELECT cache_key,kind,root_id,relative_path,bytes FROM cache_reservations WHERE id=?1 AND session_id=?2",params![id,self.inner.session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
            let root = get_root(db,&root_id)?;
            verify_root(&root,&self.inner.owner)?;
            ensure!(scoped_path(&root,&relative)?==source,"E_CACHE_VERIFY: Reservation location changed while verifying");
            let current=fs::metadata(&source)?;
            ensure!(current.len()==size && current.modified()?==verified.modified()?,"E_CACHE_VERIFY: Partial changed before publication");
            ensure!(size<=bound,"E_CACHE_BUDGET: Cache writer exceeded its reservation");
            // Reuse an identical ready object without counting one version twice.
            let previous = db.query_row("SELECT id,sha256 FROM cache_objects WHERE cache_key=?1",[&key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
            if let Some((existing,existing_hash))=previous {
                ensure!(existing_hash==hash,"E_CACHE_CONFLICT: A cache key identifies different content");
                if let Some(asset)=asset_id { db.execute("INSERT INTO cache_assets(asset_id,object_id) VALUES(?1,?2) ON CONFLICT(asset_id) DO UPDATE SET object_id=excluded.object_id",params![asset,existing])?; }
                self.release_reservation(db,id)?;
                return self.lease(db,&existing)?.context("E_CACHE: Existing object is unavailable");
            }
            let extension = Path::new(&key).extension().and_then(|s|s.to_str()).filter(|s|s.len()<=12&&s.chars().all(|c|c.is_ascii_alphanumeric())).unwrap_or("bin");
            let target_relative = format!("objects/{kind}/{id}.{extension}");
            let target = scoped_path(&root,&target_relative)?;
            fs::create_dir_all(target.parent().unwrap())?;
            reject_links(target.parent().unwrap())?;
            fs::hard_link(&source,&target).context("E_CACHE_PUBLISH: Cache filesystem must support hard links and no-replace publication")?;
            let outcome=(|| -> Result<()> {
                // hard_link publishes the already verified inode, without a
                // copy or overwrite; rehashing it would reread the same bytes.
                let tx = db.transaction()?;
                tx.execute("INSERT INTO cache_objects(id,cache_key,kind,root_id,relative_path,size,sha256,last_used) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![id,key,kind,root_id,target_relative,size,hash,now()])?;
                if let Some(asset)=asset_id { tx.execute("INSERT INTO cache_assets(asset_id,object_id) VALUES(?1,?2) ON CONFLICT(asset_id) DO UPDATE SET object_id=excluded.object_id",params![asset,id])?; }
                tx.execute("DELETE FROM cache_reservations WHERE id=?1",[id])?;
                tx.commit()?;
                Ok(())
            })();
            if let Err(error)=outcome { let _=fs::remove_file(target); return Err(error); }
            fs::remove_file(source)?;
            self.lease(db,id)?.context("E_CACHE: Committed object is unavailable")
        })
    }
    fn release_reservation(&self, db: &Connection, id: &str) -> Result<()> {
        let row = db
            .query_row(
                "SELECT root_id,relative_path FROM cache_reservations WHERE id=?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((root_id, relative)) = row {
            let root = get_root(db, &root_id)?;
            if verify_root(&root, &self.inner.owner).is_ok() {
                let path = scoped_path(&root, &relative)?;
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => {
                        db.execute(
                            "UPDATE cache_reservations SET bytes=0,session_id=NULL WHERE id=?1",
                            [id],
                        )?;
                        return Ok(());
                    }
                }
                db.execute("DELETE FROM cache_reservations WHERE id=?1", [id])?;
            } else {
                db.execute(
                    "UPDATE cache_reservations SET bytes=0,session_id=NULL WHERE id=?1",
                    [id],
                )?;
            }
        }
        Ok(())
    }
    pub fn preview_get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let lease = self.locked(|db| {
            let id = db
                .query_row(
                    "SELECT id FROM cache_objects WHERE cache_key=?1 AND kind='preview'",
                    [key],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            match id {
                Some(id) => self.lease(db, &id),
                None => Ok(None),
            }
        })?;
        lease
            .map(|lease| fs::read(lease.path()).map_err(Into::into))
            .transpose()
    }
    /// Best-effort local preview lookup. A busy cache/SQLite writer is a miss,
    /// allowing local image rendering to proceed without joining that queue.
    pub fn try_preview_get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let Some(_guard) = try_global_lock(&self.inner.lock)? else {
            return Ok(None);
        };
        let result = (|| -> Result<Option<Vec<u8>>> {
            let db = connect_timeout(&self.inner.database, Duration::ZERO)?;
            let id = db
                .query_row(
                    "SELECT id FROM cache_objects WHERE cache_key=?1 AND kind='preview'",
                    [key],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            let Some(id) = id else { return Ok(None) };
            let Some(object) = object(&db, &id)? else {
                return Ok(None);
            };
            verify_root(&object.root, &self.inner.owner)
                .context("E_CACHE_OFFLINE: Cache location is unavailable")?;
            let path = scoped_path(&object.root, &object.relative)?;
            if !path.is_file() {
                return Ok(None);
            }
            // The short-lived global guard protects this one small file from
            // eviction. No lease drop can subsequently wait on a busy cache.
            let bytes = fs::read(path)?;
            db.execute(
                "UPDATE cache_objects SET last_used=?1 WHERE id=?2",
                params![now(), id],
            )?;
            Ok(Some(bytes))
        })();
        match result {
            Err(error) if error.downcast_ref::<rusqlite::Error>().is_some_and(|e|matches!(e,rusqlite::Error::SqliteFailure(code,_) if matches!(code.code,rusqlite::ErrorCode::DatabaseBusy|rusqlite::ErrorCode::DatabaseLocked)))=>Ok(None),
            result=>result,
        }
    }
    pub fn preview_put(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let reservation = self.reserve(key, "preview", bytes.len() as u64)?;
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(reservation.path())?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        drop(reservation.commit(None)?);
        Ok(())
    }
    pub fn set_pinned(&self, asset_id: &str, pinned: bool) -> Result<Value> {
        self.locked(|db| {
            ensure!(
                !migration_running(db)?,
                "E_CACHE_BUSY: Wait for cache migration before changing offline pins"
            );
            if pinned {
                ensure!(
                    self.acquire_id_exists(db, asset_id)?,
                    "E_CACHE_NOT_FOUND: Fetch the original before pinning it"
                );
                db.execute(
                    "INSERT OR IGNORE INTO cache_pins(asset_id) VALUES(?1)",
                    [asset_id],
                )?;
            } else {
                db.execute("DELETE FROM cache_pins WHERE asset_id=?1", [asset_id])?;
            }
            self.state_db(db)
        })
    }
    pub fn is_pinned(&self, asset_id: &str) -> Result<bool> {
        self.locked(|db| {
            Ok(db.query_row(
                "SELECT EXISTS(SELECT 1 FROM cache_pins WHERE asset_id=?1)",
                [asset_id],
                |r| r.get(0),
            )?)
        })
    }
    fn acquire_id_exists(&self, db: &Connection, id: &str) -> Result<bool> {
        let object_id = db
            .query_row(
                "SELECT object_id FROM cache_assets WHERE asset_id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok(match object_id {
            Some(id) => object(db, &id)?.is_some_and(|o| {
                verify_root(&o.root, &self.inner.owner).is_ok()
                    && scoped_path(&o.root, &o.relative).is_ok_and(|p| p.is_file())
            }),
            None => false,
        })
    }
    pub fn prune(&self, flags: Value, dryrun: bool) -> Result<Value> {
        self.locked(|db| {
            self.reconcile_inventory(db)?;
            if !dryrun {self.cleanup_migrations(db)?;}
            let candidates=self.candidates(db,&flags)?;
            let reclaimable_bytes:u64=candidates.iter().map(|o|o.size).sum::<u64>()+if flags["temporary"].as_bool().unwrap_or(false){self.stale_partial_bytes(db)?}else{0};
            let mut freed=0;
            if !dryrun {
                for item in candidates { if self.remove_object(db,&item)? { freed+=item.size; } }
                if flags["temporary"].as_bool().unwrap_or(false) { freed+=self.prune_partials(db)?; }
            }
            let usage=self.usage(db)?;
            Ok(json!({"reclaimable_bytes":reclaimable_bytes,"freed_bytes":freed,"skipped_bytes":usage["total_bytes"].as_u64().unwrap_or(0).saturating_sub(if dryrun{reclaimable_bytes}else{0})}))
        })
    }
    fn candidates(&self, db: &Connection, flags: &Value) -> Result<Vec<Object>> {
        let mut result = Vec::new();
        let mut online = HashMap::new();
        let mut query=db.prepare("SELECT o.id,r.id,r.path,o.relative_path,o.kind,COALESCE(s.size,o.size),o.sha256,o.last_used,0
            FROM cache_objects o JOIN cache_roots r ON r.id=o.root_id LEFT JOIN cache_object_sizes s ON s.object_id=o.id
            WHERE ((o.kind='original' AND ?1) OR (o.kind='preview' AND ?2) OR (o.kind='temporary' AND ?3))
            AND NOT EXISTS(SELECT 1 FROM cache_assets a JOIN cache_pins p ON p.asset_id=a.asset_id WHERE a.object_id=o.id)
            AND NOT EXISTS(SELECT 1 FROM cache_leases l WHERE l.object_id=o.id)
            AND NOT EXISTS(SELECT 1 FROM cache_migration_items i JOIN cache_migrations m ON m.id=i.job_id WHERE i.object_id=o.id AND m.status='running')")?;
        for o in query.query_map(
            params![
                flags["originals"].as_bool().unwrap_or(false),
                flags["previews"].as_bool().unwrap_or(false),
                flags["temporary"].as_bool().unwrap_or(false)
            ],
            object_row,
        )? {
            let o = o?;
            let available = *online
                .entry(o.root.id.clone())
                .or_insert_with(|| verify_root(&o.root, &self.inner.owner).is_ok());
            if available {
                result.push(o);
            }
        }
        let days = policy(db)?.max_unused_days;
        let expired =
            now().saturating_sub((days.saturating_mul(86400)).min(i64::MAX as u64) as i64);
        result.sort_by_key(|o| {
            (
                !(days > 0 && o.kind == "original" && o.used < expired),
                if o.kind == "temporary" {
                    0
                } else if o.kind == "original" {
                    1
                } else {
                    2
                },
                o.used,
            )
        });
        Ok(result)
    }
    fn ensure_capacity(&self, db: &Connection, extra: u64, p: &Policy) -> Result<()> {
        self.prune_partials(db)?;
        let total = self.usage(db)?["total_bytes"].as_u64().unwrap_or(0);
        let cutoff = now()
            .saturating_sub((p.max_unused_days.saturating_mul(86400)).min(i64::MAX as u64) as i64);
        let expired:bool=p.max_unused_days>0 && db.query_row("SELECT EXISTS(SELECT 1 FROM cache_objects o WHERE o.kind='original' AND o.last_used<?1
            AND NOT EXISTS(SELECT 1 FROM cache_assets a JOIN cache_pins p ON p.asset_id=a.asset_id WHERE a.object_id=o.id)
            AND NOT EXISTS(SELECT 1 FROM cache_leases l WHERE l.object_id=o.id)
            AND NOT EXISTS(SELECT 1 FROM cache_migration_items i JOIN cache_migrations m ON m.id=i.job_id WHERE i.object_id=o.id AND m.status='running'))",[cutoff],|r|r.get(0))?;
        if total.saturating_add(extra) <= p.budget_bytes && !expired {
            return Ok(());
        }
        let candidates = self.candidates(
            db,
            &json!({"originals":true,"previews":true,"temporary":true}),
        )?;
        let reclaim: u64 = candidates.iter().map(|o| o.size).sum();
        ensure!(
            total.saturating_add(extra).saturating_sub(reclaim) <= p.budget_bytes,
            "E_CACHE_BUDGET: Budget is occupied by pinned, leased, reserved or unmanaged files"
        );
        let mut used = total;
        for o in candidates {
            if used.saturating_add(extra) <= p.budget_bytes
                && !(p.max_unused_days > 0 && o.kind == "original" && o.used < cutoff)
            {
                continue;
            }
            if self.remove_object(db, &o)? {
                used = used.saturating_sub(o.size);
            }
        }
        ensure!(
            used.saturating_add(extra) <= p.budget_bytes,
            "E_CACHE_BUDGET: Some cache files could not be reclaimed"
        );
        Ok(())
    }
    fn remove_object(&self, db: &Connection, o: &Object) -> Result<bool> {
        if o.pinned || object_leased(db, &o.id)? || migration_protects(db, &o.id)? {
            return Ok(false);
        }
        verify_root(&o.root, &self.inner.owner)?;
        let path = scoped_path(&o.root, &o.relative)?;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Ok(false),
        }
        db.execute("DELETE FROM cache_assets WHERE object_id=?1", [&o.id])?;
        db.execute("DELETE FROM cache_object_sizes WHERE object_id=?1", [&o.id])?;
        db.execute("DELETE FROM cache_objects WHERE id=?1", [&o.id])?;
        Ok(true)
    }
    fn prune_partials(&self, db: &Connection) -> Result<u64> {
        let ids: Vec<String> = db
            .prepare("SELECT id FROM cache_reservations WHERE session_id IS NULL")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let before = self.stale_partial_bytes(db)?;
        for id in ids {
            self.release_reservation(db, &id)?;
        }
        Ok(before.saturating_sub(self.stale_partial_bytes(db)?))
    }
    fn stale_partial_bytes(&self, db: &Connection) -> Result<u64> {
        let rows = rows2(
            db,
            "SELECT root_id,relative_path FROM cache_reservations WHERE session_id IS NULL",
            [],
        )?;
        let mut total = 0;
        for (id, relative) in rows {
            let root = get_root(db, &id)?;
            if verify_root(&root, &self.inner.owner).is_ok() {
                total += physical_size(&scoped_path(&root, &relative)?).unwrap_or(0);
            }
        }
        Ok(total)
    }
    fn usage(&self, db: &Connection) -> Result<Value> {
        let mut known = HashSet::new();
        // Ready objects are immutable app-owned files. Their committed sizes,
        // plus explicit inventory observations, are the quota ledger; a preview
        // must not stat every original or walk unrelated directories.
        let (originals, previews, mut temporary, pinned, in_use): (u64,u64,u64,u64,u64) = db.query_row(
            "WITH sizes AS (SELECT o.id,o.kind,COALESCE(s.size,o.size) AS bytes,
                EXISTS(SELECT 1 FROM cache_assets a JOIN cache_pins p ON p.asset_id=a.asset_id WHERE a.object_id=o.id) AS pinned,
                EXISTS(SELECT 1 FROM cache_leases l WHERE l.object_id=o.id) AS leased
                FROM cache_objects o LEFT JOIN cache_object_sizes s ON s.object_id=o.id)
             SELECT COALESCE(SUM(CASE WHEN kind='original' THEN bytes ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN kind='preview' THEN bytes ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN kind NOT IN ('original','preview') THEN bytes ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN pinned THEN bytes ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN leased THEN bytes ELSE 0 END),0) FROM sizes",
            [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
        let mut reserved = 0u64;
        let mut q=db.prepare("SELECT r.path,t.relative_path,t.bytes FROM cache_reservations t JOIN cache_roots r ON r.id=t.root_id")?;
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u64>(2)?,
            ))
        })? {
            let (root, relative, bytes) = row?;
            let path = PathBuf::from(root).join(relative);
            known.insert(path.clone());
            let actual = physical_size(&path).unwrap_or(0);
            temporary += actual;
            reserved += bytes.saturating_sub(actual);
        }
        let mut q=db.prepare("SELECT m.committed,m.status,m.to_root,i.from_root,i.from_relative,i.to_relative,i.size,m.id,i.object_id FROM cache_migration_items i JOIN cache_migrations m ON m.id=i.job_id WHERE i.cleaned=0 AND m.status!='planned'")?;
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, bool>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, u64>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
            ))
        })? {
            let (
                committed,
                status,
                to_root,
                from_root,
                from_relative,
                to_relative,
                size,
                job_id,
                object_id,
            ) = row?;
            let Some(to_root) = to_root else { continue };
            let root = get_root(db, if committed { &from_root } else { &to_root })?;
            let relative = if committed {
                from_relative
            } else {
                to_relative
            };
            let registered: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM cache_objects WHERE root_id=?1 AND relative_path=?2)",
                params![root.id, relative],
                |r| r.get(0),
            )?;
            let path = root.path.join(relative);
            if !registered && known.insert(path.clone()) {
                let partial = path.with_file_name(format!("{object_id}.{job_id}.partial"));
                if !committed {
                    known.insert(partial.clone());
                }
                let actual = physical_size(&path)
                    .or_else(|| {
                        if !committed {
                            physical_size(&partial)
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                temporary += actual;
                if !committed && status == "running" {
                    reserved += size.saturating_sub(actual);
                }
            }
        }
        let unmanaged: u64 = db.query_row(
            "SELECT COALESCE(SUM(size),0) FROM cache_unmanaged_files",
            [],
            |r| r.get(0),
        )?;
        Ok(
            json!({"total_bytes":originals+previews+temporary+reserved+unmanaged,"originals_bytes":originals,"previews_bytes":previews,"temporary_bytes":temporary,"pinned_bytes":pinned,"reserved_bytes":reserved,"unmanaged_bytes":unmanaged,"in_use_bytes":in_use}),
        )
    }
    /// Full disk reconciliation belongs to startup and explicit management
    /// operations. Normal reads/writes update the same persistent ledger rather
    /// than repeatedly enumerating thousands of originals under the global lock.
    fn reconcile_inventory(&self, db: &Connection) -> Result<()> {
        let mut managed: HashMap<(String, String), String> = db
            .prepare("SELECT root_id,relative_path,id FROM cache_objects")?
            .query_map([], |r| Ok(((r.get(0)?, r.get(1)?), r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut owned: HashSet<(String, String)> = db
            .prepare("SELECT root_id,relative_path FROM cache_reservations")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut query=db.prepare("SELECT m.id,m.committed,m.to_root,i.object_id,i.from_root,i.from_relative,i.to_relative FROM cache_migration_items i JOIN cache_migrations m ON m.id=i.job_id WHERE i.cleaned=0 AND m.status!='planned'")?;
        for row in query.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })? {
            let (job, committed, to, object, from, from_relative, to_relative) = row?;
            let Some(to) = to else { continue };
            if committed {
                owned.insert((from, from_relative));
            } else {
                let partial =
                    Path::new(&to_relative).with_file_name(format!("{object}.{job}.partial"));
                owned.insert((to.clone(), relative_text(&partial)?));
                owned.insert((to, to_relative));
            }
        }
        for root in all_roots(db)? {
            if verify_root(&root, &self.inner.owner).is_err() {
                continue;
            }
            #[cfg(test)]
            record_perf(|p| p.root_walks += 1);
            let mut unmanaged = Vec::new();
            let mut observed = Vec::new();
            for entry in WalkDir::new(&root.path)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
            {
                if !entry.file_type().is_file() || entry.file_name() == MARKER {
                    continue;
                }
                let relative = relative_text(entry.path().strip_prefix(&root.path)?)?;
                let size = entry.metadata()?.len();
                let key = (root.id.clone(), relative.clone());
                if let Some(id) = managed.remove(&key) {
                    observed.push((id, size));
                } else if !owned.contains(&key) {
                    unmanaged.push((relative, size));
                }
            }
            for ((root_id, relative), id) in &managed {
                if root_id == &root.id {
                    observed.push((
                        id.clone(),
                        physical_size(&root.path.join(relative)).unwrap_or(0),
                    ));
                }
            }
            let tx = db.unchecked_transaction()?;
            tx.execute(
                "DELETE FROM cache_unmanaged_files WHERE root_id=?1",
                [&root.id],
            )?;
            for (relative, size) in unmanaged {
                tx.execute("INSERT INTO cache_unmanaged_files(root_id,relative_path,size) VALUES(?1,?2,?3)",params![root.id,relative,size])?;
            }
            for (id, size) in observed {
                tx.execute("INSERT INTO cache_object_sizes(object_id,size) VALUES(?1,?2) ON CONFLICT(object_id) DO UPDATE SET size=excluded.size",params![id,size])?;
            }
            tx.commit()?;
        }
        Ok(())
    }
    pub fn location_check(&self, path: impl AsRef<Path>, protected: &[PathBuf]) -> Result<Value> {
        self.locked(|db| self.check_location(db, path.as_ref(), protected))
    }
    fn check_location(&self, db: &Connection, path: &Path, protected: &[PathBuf]) -> Result<Value> {
        let path = absolute(path)?;
        reject_root(&path)?;
        reject_links(&path)?;
        for root in protected {
            let root = absolute(root)?;
            ensure!(
                !overlaps(&path, &root),
                "E_CACHE_LOCATION: Cache and a local photo library must not overlap"
            );
        }
        let has_libraries: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='libraries')",
            [],
            |r| r.get(0),
        )?;
        if has_libraries {
            let roots: Vec<String> = db
                .prepare("SELECT root FROM libraries")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for root in roots {
                if let Ok(root) = absolute(Path::new(&root)) {
                    ensure!(
                        !overlaps(&path, &root),
                        "E_CACHE_LOCATION: Cache and a catalog library must not overlap"
                    );
                }
            }
        }
        for root in all_roots(db)? {
            if root.path != path {
                ensure!(
                    !overlaps(&path, &root.path),
                    "E_CACHE_LOCATION: Cache roots must not contain one another"
                );
            }
        }
        if path.exists() {
            ensure!(path.is_dir(), "E_CACHE_LOCATION: Choose a directory");
            let entries = fs::read_dir(&path)?.collect::<std::io::Result<Vec<_>>>()?;
            if !entries.is_empty() {
                let registered = all_roots(db)?
                    .into_iter()
                    .find(|r| r.path == path)
                    .context("E_CACHE_LOCATION: Nonempty directory is not a managed cache root")?;
                verify_root(&registered, &self.inner.owner)?;
            }
        } else {
            fs::create_dir_all(&path)?;
            reject_links(&path)?;
        }
        let probe = path.join(format!(".cache-check-{}", Uuid::new_v4()));
        let link = path.join(format!(".cache-check-{}", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        file.write_all(b"Nebulume cache capability probe")?;
        file.sync_all()?;
        drop(file);
        let supported = fs::hard_link(&probe, &link).is_ok();
        let _ = fs::remove_file(&link);
        let _ = fs::remove_file(&probe);
        Ok(
            json!({"path":path,"available_bytes":available_space(&path).ok(),"hard_links":supported,"valid":supported,"can_use":supported,"reason":if supported{Value::Null}else{json!("This cache filesystem does not support safe hard-link publication (FAT/exFAT is unsupported)")}}),
        )
    }
    pub fn migration_plan(
        &self,
        path: impl AsRef<Path>,
        mode: &str,
        allow_overage: bool,
        protected: &[PathBuf],
    ) -> Result<Value> {
        ensure!(
            ["all", "pinned"].contains(&mode),
            "E_INVALID: Migration mode must be all or pinned"
        );
        self.locked(|db| {
            ensure!(!migration_running(db)?,"E_CACHE_BUSY: A migration is already running");
            let check=self.check_location(db,path.as_ref(),protected)?;
            let from=active_root(db)?;verify_root(&from,&self.inner.owner)?;
            let to=PathBuf::from(check["path"].as_str().context("E_CACHE_LOCATION: Invalid destination")?);
            ensure!(from.path!=to,"E_CACHE_LOCATION: Destination is already active");
            let selected:Vec<_>=objects(db)?.into_iter().filter(|o|mode=="all"||o.pinned).collect();
            let bytes:u64=selected.iter().map(|o|o.size).sum();
            let id=Uuid::new_v4().to_string();
            let tx=db.transaction()?;
            tx.execute("INSERT INTO cache_migrations(id,status,from_root,to_path,mode,allow_overage,total_bytes) VALUES(?1,'planned',?2,?3,?4,?5,?6)",params![id,from.id,path_text(&to)?,mode,allow_overage,bytes])?;
            for o in &selected {
                let suffix=Path::new(&o.relative).extension().and_then(|s|s.to_str()).filter(|s|s.chars().all(|c|c.is_ascii_alphanumeric())).unwrap_or("bin");
                tx.execute("INSERT INTO cache_migration_items(job_id,object_id,from_root,from_relative,to_relative,size,sha256) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,o.id,o.root.id,o.relative,format!("objects/{}/{}.{}",o.kind,o.id,suffix),o.size,o.hash])?;
            }
            tx.commit()?;
            let total=self.usage(db)?["total_bytes"].as_u64().unwrap_or(0);
            let extra=total.saturating_add(bytes).saturating_sub(policy(db)?.budget_bytes);
            let enough=check["available_bytes"].as_u64().is_some_and(|n|n>=bytes);
            let can_start=check["can_use"]==true&&enough;
            let reason=if check["can_use"]!=true {check["reason"].clone()}else if !enough {json!("Not enough destination space for verified migration")}else if extra>0&&!allow_overage {json!("Migration temporarily exceeds the cache budget; explicit approval is required")}else{Value::Null};
            Ok(json!({"plan_id":id,"from_path":from.path,"to_path":to,"bytes":bytes,"extra_bytes":bytes,"budget_overage_bytes":extra,"available_bytes":check["available_bytes"],"can_start":can_start,"reason":reason}))
        })
    }
    pub fn migration_start(&self, plan_id: &str, allow_overage: bool) -> Result<Value> {
        self.locked(|db| {
            ensure!(!migration_running(db)?,"E_CACHE_BUSY: A migration is already running");
            let (status,from,path,mode):(String,String,String,String)=db.query_row("SELECT status,from_root,to_path,mode FROM cache_migrations WHERE id=?1",[plan_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            ensure!(status=="planned"&&active_root(db)?.id==from,"E_CACHE_PLAN: Migration plan is stale");
            let reservations:u64=db.query_row("SELECT COUNT(*) FROM cache_reservations WHERE session_id IS NOT NULL",[],|r|r.get(0))?;
            ensure!(reservations==0,"E_CACHE_BUSY: Wait for cache writes to reach a safe boundary");
            let selected:HashSet<_>=objects(db)?.into_iter().filter(|o|mode=="all"||o.pinned).map(|o|(o.id,o.root.id,o.relative,o.size,o.hash)).collect();
            let planned:HashSet<_>=migration_items(db,plan_id)?.into_iter().map(|o|(o.object_id,o.from_root,o.from_relative,o.size,o.hash)).collect();
            ensure!(selected==planned,"E_CACHE_PLAN: Cache contents changed; create a new migration plan");
            let to=PathBuf::from(path);let check=self.check_location(db,&to,&[])?;
            ensure!(check["can_use"]==true,"E_CACHE_LOCATION: Destination cannot safely publish cache files");
            let bytes:u64=selected.iter().map(|o|o.3).sum();
            ensure!(check["available_bytes"].as_u64().is_some_and(|n|n>=bytes),"E_CACHE_SPACE: Destination space changed");
            let usage=self.usage(db)?["total_bytes"].as_u64().unwrap_or(0);
            ensure!(allow_overage||usage.saturating_add(bytes)<=policy(db)?.budget_bytes,"E_CACHE_OVERAGE: Explicit approval for temporary duplicate occupancy is required");
            let root=if let Some(root)=all_roots(db)?.into_iter().find(|r|r.path==to){root}else{let root=Root{id:Uuid::new_v4().to_string(),path:to};claim_root(&root,&self.inner.owner)?;db.execute("INSERT INTO cache_roots(id,path) VALUES(?1,?2)",params![root.id,path_text(&root.path)?])?;root};
            verify_root(&root,&self.inner.owner)?;
            db.execute("UPDATE cache_migrations SET status='running',to_root=?1,allow_overage=?2,session_id=?3 WHERE id=?4",params![root.id,allow_overage,self.inner.session,plan_id])?;
            migration_json(db,plan_id)
        })?;
        let manager = self.clone();
        let id = plan_id.to_string();
        thread::spawn(move || {
            if let Err(error) = manager.run_migration(&id) {
                let _ = manager.locked(|db| {
                    let committed: bool = db.query_row(
                        "SELECT committed FROM cache_migrations WHERE id=?1",
                        [&id],
                        |r| r.get(0),
                    )?;
                    db.execute(
                        "UPDATE cache_migrations SET status=?1,error=?2 WHERE id=?3",
                        params![
                            if committed {
                                "cleanup_pending"
                            } else {
                                "failed"
                            },
                            format!("{error:#}"),
                            id
                        ],
                    )?;
                    manager.cleanup_migrations(db)
                });
            }
        });
        self.migration_get(plan_id)
    }
    pub fn migration_get(&self, id: &str) -> Result<Value> {
        self.locked(|db| {
            self.cleanup_migrations(db)?;
            migration_json(db, id)
        })
    }
    pub fn migration_cancel(&self, id: &str) -> Result<Value> {
        self.locked(|db|{let committed:bool=db.query_row("SELECT committed FROM cache_migrations WHERE id=?1",[id],|r|r.get(0))?;ensure!(!committed,"E_CACHE_MIGRATION: Root switch has committed; only old-root cleanup remains");db.execute("UPDATE cache_migrations SET cancel=1,status=CASE WHEN status='planned' THEN 'cancelled' ELSE status END WHERE id=?1",[id])?;migration_json(db,id)})
    }
    fn run_migration(&self, id: &str) -> Result<()> {
        let (items, to) = self.locked(|db| {
            let root_id: String = db.query_row(
                "SELECT to_root FROM cache_migrations WHERE id=?1",
                [id],
                |r| r.get(0),
            )?;
            Ok((migration_items(db, id)?, get_root(db, &root_id)?))
        })?;
        for item in &items {
            if self.locked(|db| cancelled(db, id))? {
                return self.finish_cancel(id);
            }
            let from = self.locked(|db| get_root(db, &item.from_root))?;
            verify_root(&from, &self.inner.owner)?;
            verify_root(&to, &self.inner.owner)?;
            let source = scoped_path(&from, &item.from_relative)?;
            let target = scoped_path(&to, &item.to_relative)?;
            ensure!(
                hash_file(&source)? == (item.size, item.hash.clone()),
                "E_CACHE_VERIFY: Source cache changed during migration"
            );
            fs::create_dir_all(target.parent().unwrap())?;
            reject_links(target.parent().unwrap())?;
            let partial = target.with_file_name(format!("{}.{}.partial", item.object_id, id));
            // The exact temporary path is journal-derived, never guessed from a directory scan.
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&partial)?;
            let outcome = (|| -> Result<()> {
                let mut input = File::open(&source)?;
                let mut buffer = [0u8; 128 * 1024];
                let mut hasher = Sha256::new();
                let mut copied = 0u64;
                let mut checkpoint = std::time::Instant::now();
                let base=self.locked(|db|Ok(db.query_row("SELECT COALESCE(SUM(size),0) FROM cache_migration_items WHERE job_id=?1 AND copied=1",[id],|r|r.get::<_,u64>(0))?))?;
                loop {
                    let count = input.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    if checkpoint.elapsed() >= Duration::from_millis(100) {
                        self.locked(|db| {
                            ensure!(
                                !cancelled(db, id)?,
                                "E_CACHE_CANCELLED: Migration cancellation requested"
                            );
                            db.execute(
                                "UPDATE cache_migrations SET copied_bytes=?1 WHERE id=?2",
                                params![base + copied, id],
                            )?;
                            Ok(())
                        })?;
                        checkpoint = std::time::Instant::now();
                    }
                    output.write_all(&buffer[..count])?;
                    hasher.update(&buffer[..count]);
                    copied += count as u64;
                }
                output.sync_all()?;
                ensure!(
                    copied == item.size && hex::encode(hasher.finalize()) == item.hash,
                    "E_CACHE_VERIFY: Source changed while copying"
                );
                ensure!(
                    hash_file(&partial)? == (item.size, item.hash.clone()),
                    "E_CACHE_VERIFY: Migration readback failed"
                );
                verify_root(&to, &self.inner.owner)?;
                reject_links(target.parent().unwrap())?;
                fs::hard_link(&partial, &target)
                    .context("E_CACHE_MIGRATION: No-replace destination publication failed")?;
                ensure!(
                    hash_file(&target)? == (item.size, item.hash.clone()),
                    "E_CACHE_VERIFY: Published migration object failed verification"
                );
                Ok(())
            })();
            drop(output);
            let _ = fs::remove_file(&partial);
            if let Err(error) = outcome {
                if self.locked(|db| cancelled(db, id))? {
                    return self.finish_cancel(id);
                }
                return Err(error);
            }
            self.locked(|db|{db.execute("UPDATE cache_migration_items SET copied=1 WHERE job_id=?1 AND object_id=?2",params![id,item.object_id])?;db.execute("UPDATE cache_migrations SET copied_bytes=(SELECT COALESCE(SUM(size),0) FROM cache_migration_items WHERE job_id=?1 AND copied=1) WHERE id=?1",[id])?;Ok(())})?;
        }
        self.locked(|db| {
            if cancelled(db,id)? {return self.finish_cancel_db(db,id);}
            verify_root(&to,&self.inner.owner)?;
            // Root and every physical object reference change in one SQLite transaction.
            let tx=db.transaction()?;
            for item in &items {ensure!(hash_file(&scoped_path(&to,&item.to_relative)?)?==(item.size,item.hash.clone()),"E_CACHE_VERIFY: Migration destination changed before commit");tx.execute("UPDATE cache_objects SET root_id=?1,relative_path=?2,evict=0 WHERE id=?3",params![to.id,item.to_relative,item.object_id])?;}
            let mode:String=tx.query_row("SELECT mode FROM cache_migrations WHERE id=?1",[id],|r|r.get(0))?;
            if mode=="pinned" {tx.execute("UPDATE cache_objects SET evict=1 WHERE root_id!=?1 AND id NOT IN (SELECT object_id FROM cache_assets WHERE asset_id IN (SELECT asset_id FROM cache_pins))",[&to.id])?;}
            put_setting(&tx,"active_root",&to.id)?;
            tx.execute("UPDATE cache_migrations SET committed=1,status='cleanup_pending' WHERE id=?1",[id])?;tx.commit()?;
            self.cleanup_migrations(db)
        })
    }
    fn finish_cancel(&self, id: &str) -> Result<()> {
        self.locked(|db| self.finish_cancel_db(db, id))
    }
    fn finish_cancel_db(&self, db: &Connection, id: &str) -> Result<()> {
        db.execute(
            "UPDATE cache_migrations SET status='cancelled' WHERE id=?1 AND committed=0",
            [id],
        )?;
        self.cleanup_migrations(db)
    }
    fn cleanup_migrations(&self, db: &Connection) -> Result<()> {
        let jobs=rows2(db,"SELECT id,status FROM cache_migrations m WHERE status='cleanup_pending' OR (status IN ('failed','cancelled') AND EXISTS(SELECT 1 FROM cache_migration_items i WHERE i.job_id=m.id AND i.cleaned=0))",[])?;
        for (id, status) in jobs {
            let (committed, to_id): (bool, Option<String>) = db.query_row(
                "SELECT committed,to_root FROM cache_migrations WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let Some(to_id) = to_id else { continue };
            let mut pending = false;
            for item in migration_items(db, &id)?.into_iter().filter(|o| !o.cleaned) {
                let root = get_root(db, if committed { &item.from_root } else { &to_id })?;
                let relative = if committed {
                    &item.from_relative
                } else {
                    &item.to_relative
                };
                let leased:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM cache_leases WHERE root_id=?1 AND relative_path=?2)",params![root.id,relative],|r|r.get(0))?;
                if leased || verify_root(&root, &self.inner.owner).is_err() {
                    pending = true;
                    continue;
                }
                let path = scoped_path(&root, relative)?;
                if path.exists()
                    && (hash_file(&path).ok() != Some((item.size, item.hash.clone()))
                        || fs::remove_file(&path).is_err())
                {
                    pending = true;
                    continue;
                }
                // A crash can leave the journal-derived owned partial before publication.
                if !committed {
                    let partial = path.with_file_name(format!("{}.{}.partial", item.object_id, id));
                    if partial.is_file() {
                        let _ = fs::remove_file(partial);
                    }
                }
                db.execute(
                    "UPDATE cache_migration_items SET cleaned=1 WHERE job_id=?1 AND object_id=?2",
                    params![id, item.object_id],
                )?;
            }
            if committed {
                let mut query = db.prepare(&format!("{OBJECT_SELECT} WHERE o.evict=1"))?;
                for o in query.query_map([], object_row)? {
                    if !self.remove_object(db, &o?)? {
                        pending = true;
                    }
                }
            }
            if committed {
                db.execute(
                    "UPDATE cache_migrations SET status=?1 WHERE id=?2",
                    params![
                        if pending {
                            "cleanup_pending"
                        } else {
                            "completed"
                        },
                        id
                    ],
                )?;
            } else if pending && status == "failed" {
                db.execute("UPDATE cache_migrations SET error=COALESCE(error,'') || ' (destination cleanup pending)' WHERE id=?1",[&id])?;
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
struct MigrationItem {
    object_id: String,
    from_root: String,
    from_relative: String,
    to_relative: String,
    size: u64,
    hash: String,
    cleaned: bool,
}
fn migration_items(db: &Connection, id: &str) -> Result<Vec<MigrationItem>> {
    Ok(db.prepare("SELECT object_id,from_root,from_relative,to_relative,size,sha256,cleaned FROM cache_migration_items WHERE job_id=?1 ORDER BY object_id")?.query_map([id],|r|Ok(MigrationItem{object_id:r.get(0)?,from_root:r.get(1)?,from_relative:r.get(2)?,to_relative:r.get(3)?,size:r.get(4)?,hash:r.get(5)?,cleaned:r.get(6)?}))?.collect::<rusqlite::Result<_>>()?)
}
fn migration_running(db: &Connection) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM cache_migrations WHERE status='running')",
        [],
        |r| r.get(0),
    )?)
}
fn migration_protects(db: &Connection, id: &str) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM cache_migration_items i JOIN cache_migrations m ON m.id=i.job_id WHERE i.object_id=?1 AND m.status='running')",[id],|r|r.get(0))?)
}
fn cancelled(db: &Connection, id: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT cancel FROM cache_migrations WHERE id=?1",
        [id],
        |r| r.get(0),
    )?)
}
fn migration_json(db: &Connection, id: &str) -> Result<Value> {
    let (status,from,to,total,copied,error):(String,String,String,u64,u64,Option<String>)=db.query_row("SELECT status,from_root,to_path,total_bytes,copied_bytes,error FROM cache_migrations WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    Ok(
        json!({"id":id,"status":status,"from_path":get_root(db,&from)?.path,"to_path":to,"total_bytes":total,"copied_bytes":copied,"error":error}),
    )
}
fn latest_migration(db: &Connection) -> Result<Option<Value>> {
    let id = db
        .query_row(
            "SELECT id FROM cache_migrations WHERE status!='planned' ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    id.map(|id| migration_json(db, &id)).transpose()
}
fn now() -> i64 {
    Utc::now().timestamp()
}
fn connect(path: &Path) -> Result<Connection> {
    connect_timeout(path, Duration::from_secs(15))
}
fn connect_timeout(path: &Path, timeout: Duration) -> Result<Connection> {
    let db = Connection::open(path)?;
    db.busy_timeout(timeout)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
    Ok(db)
}
fn global_lock(path: &Path) -> Result<Guard> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    file.lock()?;
    #[cfg(test)]
    record_perf(|p| p.lock_depth += 1);
    Ok(Guard(file))
}
fn try_global_lock(path: &Path) -> Result<Option<Guard>> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => {
            #[cfg(test)]
            record_perf(|p| p.lock_depth += 1);
            Ok(Some(Guard(file)))
        }
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    }
}
fn setting(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT value FROM cache_settings WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?)
}
fn put_setting(db: &Connection, key: &str, value: &str) -> Result<()> {
    db.execute("INSERT INTO cache_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
    Ok(())
}
fn policy(db: &Connection) -> Result<Policy> {
    Ok(serde_json::from_str(
        &setting(db, "policy")?.context("E_CACHE: Missing cache policy")?,
    )?)
}
fn get_root(db: &Connection, id: &str) -> Result<Root> {
    Ok(
        db.query_row("SELECT id,path FROM cache_roots WHERE id=?1", [id], |r| {
            Ok(Root {
                id: r.get(0)?,
                path: PathBuf::from(r.get::<_, String>(1)?),
            })
        })?,
    )
}
fn active_root(db: &Connection) -> Result<Root> {
    get_root(
        db,
        &setting(db, "active_root")?.context("E_CACHE: No active cache location")?,
    )
}
fn all_roots(db: &Connection) -> Result<Vec<Root>> {
    Ok(db
        .prepare("SELECT id,path FROM cache_roots")?
        .query_map([], |r| {
            Ok(Root {
                id: r.get(0)?,
                path: PathBuf::from(r.get::<_, String>(1)?),
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}
fn rows2<P: rusqlite::Params>(
    db: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<(String, String)>> {
    Ok(db
        .prepare(sql)?
        .query_map(params, |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}
fn object(db: &Connection, id: &str) -> Result<Option<Object>> {
    Ok(db
        .query_row(&format!("{OBJECT_SELECT} WHERE o.id=?1"), [id], object_row)
        .optional()?)
}
const OBJECT_SELECT:&str="SELECT o.id,r.id,r.path,o.relative_path,o.kind,o.size,o.sha256,o.last_used,EXISTS(SELECT 1 FROM cache_assets a JOIN cache_pins p ON p.asset_id=a.asset_id WHERE a.object_id=o.id) FROM cache_objects o JOIN cache_roots r ON r.id=o.root_id";
fn object_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Object> {
    #[cfg(test)]
    record_perf(|p| p.object_rows += 1);
    Ok(Object {
        id: r.get(0)?,
        root: Root {
            id: r.get(1)?,
            path: PathBuf::from(r.get::<_, String>(2)?),
        },
        relative: r.get(3)?,
        kind: r.get(4)?,
        size: r.get(5)?,
        hash: r.get(6)?,
        used: r.get(7)?,
        pinned: r.get(8)?,
    })
}
fn objects(db: &Connection) -> Result<Vec<Object>> {
    Ok(db
        .prepare(OBJECT_SELECT)?
        .query_map([], object_row)?
        .collect::<rusqlite::Result<_>>()?)
}
fn object_leased(db: &Connection, id: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM cache_leases WHERE object_id=?1)",
        [id],
        |r| r.get(0),
    )?)
}
fn path_text(path: &Path) -> Result<&str> {
    path.to_str()
        .context("E_CACHE_PATH: Cache paths must be Unicode")
}
fn absolute(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    ensure!(
        !path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir)),
        "E_CACHE_PATH: Relative traversal is forbidden"
    );
    reject_links(&path)?;
    let mut parent = path.as_path();
    let mut missing = Vec::new();
    while !parent.exists() {
        missing.push(
            parent
                .file_name()
                .context("E_CACHE_PATH: Invalid cache root")?
                .to_os_string(),
        );
        parent = parent
            .parent()
            .context("E_CACHE_PATH: Missing existing ancestor")?;
    }
    let mut result = dunce::canonicalize(parent)?;
    for part in missing.into_iter().rev() {
        result.push(part);
    }
    Ok(result)
}
fn reject_root(path: &Path) -> Result<()> {
    ensure!(
        path.parent().is_some(),
        "E_CACHE_LOCATION: A filesystem root cannot be a cache"
    );
    Ok(())
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn reject_links(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(m) => ensure!(
                !is_link(&m),
                "E_CACHE_PATH: Links and junctions cannot be cache path components"
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn overlaps(a: &Path, b: &Path) -> bool {
    relative_under(a, b).is_some() || relative_under(b, a).is_some()
}
fn relative_under(path: &Path, root: &Path) -> Option<PathBuf> {
    let path = plain_windows_path(path);
    let root = plain_windows_path(root);
    path.strip_prefix(root).ok().map(Path::to_path_buf)
}
fn plain_windows_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::Prefix;
        let mut parts = path.components();
        if let Some(Component::Prefix(prefix)) = parts.next() {
            let base = match prefix.kind() {
                Prefix::VerbatimDisk(drive) => Some(PathBuf::from(format!("{}:", drive as char))),
                Prefix::VerbatimUNC(server, share) => Some(PathBuf::from(format!(
                    "\\\\{}\\{}",
                    server.to_string_lossy(),
                    share.to_string_lossy()
                ))),
                _ => None,
            };
            if let Some(mut result) = base {
                for part in parts {
                    result.push(part);
                }
                return result;
            }
        }
    }
    path.to_path_buf()
}
fn relative_text(path: &Path) -> Result<String> {
    ensure!(
        !path.as_os_str().is_empty()
            && path.components().all(|c| matches!(c, Component::Normal(_))),
        "E_CACHE_PATH: Invalid relative object path"
    );
    Ok(path_text(path)?.replace('\\', "/"))
}
fn scoped_path(root: &Root, relative: &str) -> Result<PathBuf> {
    let rel = Path::new(relative);
    relative_text(rel)?;
    let path = root.path.join(rel);
    reject_links(&path)?;
    ensure!(
        path.starts_with(&root.path),
        "E_CACHE_PATH: Object escaped its root"
    );
    Ok(path)
}
fn claim_root(root: &Root, owner: &str) -> Result<()> {
    reject_links(&root.path)?;
    let marker = root.path.join(MARKER);
    if marker.exists() {
        return verify_root(root, owner);
    }
    let value = Owner {
        version: 1,
        catalog_id: owner.into(),
        root_id: root.id.clone(),
    };
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker)?;
    serde_json::to_writer(&mut file, &value)?;
    file.sync_all()?;
    Ok(())
}
fn verify_root(root: &Root, owner: &str) -> Result<()> {
    reject_links(&root.path)?;
    ensure!(
        root.path.is_dir() && dunce::canonicalize(&root.path)? == root.path,
        "E_CACHE_OFFLINE: Cache root is unavailable or moved"
    );
    let marker = root.path.join(MARKER);
    reject_links(&marker)?;
    ensure!(
        fs::metadata(&marker)?.len() <= 4096,
        "E_CACHE_OWNER: Invalid owner marker"
    );
    let value: Owner = serde_json::from_reader(File::open(marker)?)?;
    ensure!(
        value.version == 1 && value.catalog_id == owner && value.root_id == root.id,
        "E_CACHE_OWNER: Cache directory belongs to another catalog"
    );
    Ok(())
}
fn physical_size(path: &Path) -> Option<u64> {
    #[cfg(test)]
    record_perf(|p| p.path_stats += 1);
    fs::symlink_metadata(path)
        .ok()
        .filter(|m| m.is_file() && !is_link(m))
        .map(|m| m.len())
}
#[cfg(windows)]
fn available_space(path: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let path: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut available = 0;
    ensure!(
        unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } != 0,
        "E_CACHE_SPACE: Cannot query destination free space: {}",
        std::io::Error::last_os_error()
    );
    Ok(available)
}
#[cfg(unix)]
fn available_space(path: &Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    ensure!(
        unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } == 0,
        "E_CACHE_SPACE: Cannot query destination free space"
    );
    let stat = unsafe { stat.assume_init() };
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}
#[cfg(not(any(windows, unix)))]
fn available_space(_path: &Path) -> Result<u64> {
    anyhow::bail!("E_CACHE_SPACE: Free-space query is unavailable on this platform")
}
fn hash_file(path: &Path) -> Result<(u64, String)> {
    #[cfg(test)]
    HASH_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
    reject_links(path)?;
    let mut input = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0;
    let mut bytes = [0u8; 128 * 1024];
    loop {
        let n = input.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        #[cfg(test)]
        record_perf(|p| {
            if p.lock_depth > 0 {
                p.hash_bytes_under_lock += n as u64;
            }
        });
        hasher.update(&bytes[..n]);
        size += n as u64;
    }
    Ok((size, hex::encode(hasher.finalize())))
}

/// Used by Core's checked image path. Never falls back to a compatibility path
/// when an authoritative mapping exists but its volume is disconnected.
pub(crate) fn resolve_asset_path(db: &Connection, asset_id: &str) -> Result<Option<PathBuf>> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='cache_assets')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let id = db
        .query_row(
            "SELECT object_id FROM cache_assets WHERE asset_id=?1",
            [asset_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    let Some(id) = id else { return Ok(None) };
    let o = object(db, &id)?.context("E_CACHE_NOT_FOUND: Missing cache object record")?;
    verify_root(
        &o.root,
        &setting(db, "owner")?.context("E_CACHE_OWNER: Missing catalog owner")?,
    )
    .context("E_CACHE_OFFLINE: The cache volume is unavailable")?;
    let path = scoped_path(&o.root, &o.relative)?;
    ensure!(
        path.is_file(),
        "E_CACHE_NOT_FOUND: Cached original was reclaimed or is unavailable"
    );
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        _dir: tempfile::TempDir,
        manager: CacheManager,
        database: PathBuf,
        root: PathBuf,
    }
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("catalog.sqlite3");
        let root = dir.path().join("cache");
        let manager = CacheManager::open(&database, &root).unwrap();
        let root = dunce::canonicalize(&root).unwrap();
        Fixture {
            _dir: dir,
            manager,
            database,
            root,
        }
    }
    fn tiny_budget(manager: &CacheManager, bytes: u64) {
        manager
            .locked(|db| {
                let mut p = policy(db)?;
                p.budget_bytes = bytes;
                p.max_unused_days = 0;
                put_setting(db, "policy", &serde_json::to_string(&p)?)
            })
            .unwrap();
    }
    fn put(
        manager: &CacheManager,
        key: &str,
        kind: &str,
        asset: Option<&str>,
        bytes: &[u8],
    ) -> CacheLease {
        let reservation = manager.reserve(key, kind, bytes.len() as u64).unwrap();
        fs::write(reservation.path(), bytes).unwrap();
        reservation.commit(asset).unwrap()
    }
    fn wait_job(manager: &CacheManager, id: &str) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            let job = manager.migration_get(id).unwrap();
            if job["status"] != "running" {
                return job;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "migration did not finish: {job}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn preview_io_with_hundreds_of_originals_never_scans_the_root_or_loads_the_catalog() {
        let f = fixture();
        let folder = f.root.join("objects/original");
        fs::create_dir_all(&folder).unwrap();
        for n in 0..500 {
            fs::write(folder.join(format!("{n}.jpg")), [1; 16]).unwrap();
        }
        f.manager.locked(|db| {
            let root=active_root(db)?;
            let tx=db.transaction()?;
            for n in 0..500 {
                let id=format!("original-{n}");
                tx.execute("INSERT INTO cache_objects(id,cache_key,kind,root_id,relative_path,size,sha256,last_used) VALUES(?1,?1,'original',?2,?3,16,'fixture',?4)",params![id,root.id,format!("objects/original/{n}.jpg"),now()])?;
                tx.execute("INSERT INTO cache_assets(asset_id,object_id) VALUES(?1,?1)",[id])?;
            }
            tx.commit()?;
            Ok(())
        }).unwrap();
        assert_eq!(f.manager.state().unwrap()["usage"]["total_bytes"], 8000);
        PERF.with(|c| c.set(PerfCounters::default()));
        f.manager.preview_put("small-preview", &[2; 4096]).unwrap();
        assert_eq!(
            f.manager.preview_get("small-preview").unwrap(),
            Some(vec![2; 4096])
        );
        assert_eq!(
            f.manager.try_preview_get("small-preview").unwrap(),
            Some(vec![2; 4096])
        );
        assert!(f.manager.original_registered("original-499").unwrap());
        let counters = PERF.with(|c| c.get());
        assert_eq!(
            counters.root_walks, 0,
            "preview I/O enumerated the cache root"
        );
        assert!(
            counters.object_rows <= 3,
            "single preview loaded unrelated object rows: {}",
            counters.object_rows
        );
        assert!(
            counters.path_stats <= 4,
            "preview I/O statted unrelated original paths: {}",
            counters.path_stats
        );
        assert_eq!(counters.hash_bytes_under_lock, 0);
        assert_eq!(f.manager.state().unwrap()["usage"]["total_bytes"], 12096);
    }
    #[test]
    fn hashing_a_preview_does_not_hold_the_cache_or_sqlite_write_lock() {
        use std::sync::mpsc;
        let f = fixture();
        Connection::open(&f.database)
            .unwrap()
            .execute("CREATE TABLE local_metadata(name TEXT PRIMARY KEY)", [])
            .unwrap();
        let (paused_tx, paused_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let manager = f.manager.clone();
        let writer = thread::spawn(move || {
            PERF.with(|c| c.set(PerfCounters::default()));
            HASH_HOOK.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || {
                    paused_tx.send(()).unwrap();
                    resume_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                }))
            });
            manager.preview_put("preview", &[1; 4096]).unwrap();
            PERF.with(|c| c.get())
        });
        paused_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let (probe_tx, probe_rx) = mpsc::channel();
        let database = f.database.clone();
        let manager = f.manager.clone();
        let probe = thread::spawn(move || {
            let result = (|| -> Result<()> {
                ensure!(
                    !manager.original_registered("unrelated")?,
                    "Unexpected mapping"
                );
                connect(&database)?
                    .execute("INSERT INTO local_metadata(name) VALUES('local.jpg')", [])?;
                Ok(())
            })();
            probe_tx.send(result).unwrap();
        });
        let result = probe_rx.recv_timeout(Duration::from_secs(5));
        // Always release the hash before asserting, even if a regression made
        // the independent operation wait. The timeout is a deadlock guard.
        resume_tx.send(()).unwrap();
        let counters = writer.join().unwrap();
        probe.join().unwrap();
        result
            .expect("preview verification blocked an independent local operation")
            .unwrap();
        assert_eq!(counters.hash_bytes_under_lock, 0);
    }
    #[test]
    fn local_preview_lookup_treats_a_busy_cache_as_a_miss_without_waiting() {
        let f = fixture();
        f.manager.preview_put("preview", b"image").unwrap();
        let guard = global_lock(&f.manager.inner.lock).unwrap();
        assert!(f.manager.try_preview_get("preview").unwrap().is_none());
        drop(guard);
        assert_eq!(
            f.manager.try_preview_get("preview").unwrap(),
            Some(b"image".to_vec())
        );
    }
    #[test]
    fn preview_policy_lookup_never_reconciles_the_disk_inventory() {
        let f = fixture();
        f.manager
            .set_policy(json!({"preview_policy":"manual"}))
            .unwrap();
        fs::write(f.root.join("unrelated-history"), b"do not scan this").unwrap();
        PERF.with(|c| c.set(PerfCounters::default()));
        assert_eq!(f.manager.preview_policy().unwrap(), "manual");
        let counters = PERF.with(|c| c.get());
        assert_eq!(counters.root_walks, 0);
        assert_eq!(counters.object_rows, 0);
        assert_eq!(counters.path_stats, 0);
    }
    #[test]
    fn inventory_tracks_unknown_occupancy_and_adoption_without_double_counting() {
        let f = fixture();
        tiny_budget(&f.manager, 30);
        let legacy = f.root.join("legacy.jpg");
        fs::write(&legacy, [1; 20]).unwrap();
        assert_eq!(f.manager.state().unwrap()["usage"]["unmanaged_bytes"], 20);
        assert!(f.manager.reserve("too-much", "preview", 11).is_err());
        f.manager.adopt_original("legacy", &legacy).unwrap();
        f.manager.set_pinned("legacy", true).unwrap();
        f.manager
            .locked(|db| {
                let usage = f.manager.usage(db)?;
                assert_eq!(usage["total_bytes"], 20);
                assert_eq!(usage["originals_bytes"], 20);
                assert_eq!(usage["unmanaged_bytes"], 0);
                Ok(())
            })
            .unwrap();
        fs::write(f.root.join("do-not-delete"), [3; 15]).unwrap();
        assert_eq!(f.manager.state().unwrap()["usage"]["total_bytes"], 35);
        assert!(f.manager.reserve("one-byte", "preview", 1).is_err());
        assert!(legacy.is_file());
        assert!(f.root.join("do-not-delete").is_file());
        assert!(!f.manager.legacy_adoption_complete().unwrap());
        f.manager.mark_legacy_adoption_complete().unwrap();
        assert!(CacheManager::open(&f.database, &f.root)
            .unwrap()
            .legacy_adoption_complete()
            .unwrap());
    }
    #[test]
    fn budget_protects_pin_lease_and_reservation_without_counting_subsets_twice() {
        let f = fixture();
        tiny_budget(&f.manager, 60);
        drop(put(&f.manager, "a.nef", "original", Some("a"), &[1; 20]));
        f.manager.set_pinned("a", true).unwrap();
        let lease = put(&f.manager, "b.jpg", "original", Some("b"), &[2; 20]);
        drop(put(&f.manager, "preview", "preview", None, &[3; 20]));
        assert!(f.manager.reserve("too-large", "original", 30).is_err());
        let reservation = f.manager.reserve("next.jpg", "original", 20).unwrap();
        let usage = &f.manager.state().unwrap()["usage"];
        assert_eq!(usage["total_bytes"], 60);
        assert_eq!(usage["pinned_bytes"], 20);
        assert_eq!(usage["in_use_bytes"], 20);
        assert_eq!(usage["reserved_bytes"], 20);
        assert_eq!(usage["previews_bytes"], 0);
        assert!(lease.path().is_file());
        drop(reservation);
        drop(lease);
        assert_eq!(f.manager.state().unwrap()["usage"]["total_bytes"], 40);
    }
    #[test]
    fn preview_is_retained_before_unpinned_original_and_expiry_only_affects_originals() {
        let f = fixture();
        tiny_budget(&f.manager, 30);
        drop(put(
            &f.manager,
            "image.jpg",
            "original",
            Some("image"),
            &[1; 10],
        ));
        f.manager.preview_put("preview", &[2; 10]).unwrap();
        f.manager
            .locked(|db| {
                db.execute(
                    "UPDATE cache_objects SET last_used=?1",
                    [now() - 60 * 86400],
                )?;
                let mut p = policy(db)?;
                p.max_unused_days = 30;
                put_setting(db, "policy", &serde_json::to_string(&p)?)
            })
            .unwrap();
        f.manager.maintain().unwrap();
        assert!(f.manager.acquire_original("image").unwrap().is_none());
        assert_eq!(
            f.manager.preview_get("preview").unwrap().unwrap(),
            vec![2; 10]
        );
        let r = f.manager.reserve("new.nef", "original", 25).unwrap();
        assert_eq!(f.manager.state().unwrap()["usage"]["total_bytes"], 25);
        drop(r);
    }
    #[test]
    fn registration_check_does_not_touch_lru_or_protect_expired_originals() {
        let f = fixture();
        let lease = put(&f.manager, "old.jpg", "original", Some("old"), &[1; 10]);
        let path = lease.path().to_owned();
        drop(lease);
        let expired = now() - 60 * 86400;
        f.manager
            .locked(|db| {
                db.execute("UPDATE cache_objects SET last_used=?1", [expired])?;
                Ok(())
            })
            .unwrap();
        assert!(f.manager.original_registered("old").unwrap());
        assert!(!f.manager.original_registered("missing").unwrap());
        f.manager
            .locked(|db| {
                assert_eq!(
                    db.query_row("SELECT last_used FROM cache_objects", [], |r| r
                        .get::<_, i64>(0))?,
                    expired
                );
                assert_eq!(
                    db.query_row("SELECT COUNT(*) FROM cache_leases", [], |r| r
                        .get::<_, u64>(0))?,
                    0
                );
                Ok(())
            })
            .unwrap();
        f.manager.maintain().unwrap();
        assert!(!path.exists());
        assert!(!f.manager.original_registered("old").unwrap());
    }
    #[test]
    fn maintenance_includes_adopted_objects_and_preserves_pins_leases_and_previews() {
        let f = fixture();
        tiny_budget(&f.manager, 40);
        let legacy = f.root.join("legacy.jpg");
        fs::write(&legacy, [1; 10]).unwrap();
        f.manager.adopt_original("legacy", &legacy).unwrap();
        drop(put(
            &f.manager,
            "pin.jpg",
            "original",
            Some("pin"),
            &[2; 10],
        ));
        f.manager.set_pinned("pin", true).unwrap();
        let lease = put(&f.manager, "used.jpg", "original", Some("used"), &[3; 10]);
        f.manager.preview_put("preview", &[4; 10]).unwrap();
        f.manager
            .locked(|db| {
                db.execute("UPDATE cache_objects SET last_used=?1", [now() - 60 * 86400])?;
                db.execute("INSERT INTO cache_asset_revisions(asset_id,fingerprint) VALUES('orphan','old')", [])?;
                let mut p = policy(db)?;
                p.max_unused_days = 30;
                put_setting(db, "policy", &serde_json::to_string(&p)?)
            })
            .unwrap();
        f.manager.maintain().unwrap();
        assert!(!legacy.exists());
        assert!(lease.path().is_file());
        assert_eq!(f.manager.state().unwrap()["usage"]["total_bytes"], 30);
        assert_eq!(f.manager.preview_get("preview").unwrap(), Some(vec![4; 10]));
        drop(lease);
        f.manager.maintain().unwrap();
        assert!(f.manager.acquire_original("used").unwrap().is_none());
        assert!(f.manager.acquire_original("pin").unwrap().is_some());
        tiny_budget(&f.manager, 9);
        assert!(format!("{:#}", f.manager.maintain().unwrap_err()).contains("E_CACHE_BUDGET"));
        assert!(f.manager.acquire_original("pin").unwrap().is_some());
    }
    #[test]
    fn legacy_adoption_never_deletes_unmanaged_files_or_changes_catalog_version() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("catalog.sqlite3");
        let db = Connection::open(&database).unwrap();
        db.pragma_update(None, "user_version", 3).unwrap();
        drop(db);
        let root = dir.path().join("legacy");
        fs::create_dir(&root).unwrap();
        let managed = root.join("old.jpg");
        fs::write(&managed, b"data").unwrap();
        let unknown = root.join("unknown.jpg");
        fs::write(&unknown, b"history").unwrap();
        let m = CacheManager::open(&database, &root).unwrap();
        m.adopt_original("asset", &managed).unwrap();
        assert_eq!(m.state().unwrap()["usage"]["unmanaged_bytes"], 7);
        let dry = m.prune(json!({"originals":true}), true).unwrap();
        assert_eq!(dry["reclaimable_bytes"], 4);
        assert!(managed.exists());
        assert_eq!(
            m.prune(json!({"originals":true}), false).unwrap()["freed_bytes"],
            4
        );
        assert_eq!(fs::read(unknown).unwrap(), b"history");
        assert_eq!(
            Connection::open(database)
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            3
        );
    }
    #[test]
    fn migration_switch_is_atomic_and_old_leased_version_survives_until_release() {
        let f = fixture();
        tiny_budget(&f.manager, 4);
        let old = put(&f.manager, "v1.nef", "original", Some("asset"), b"data");
        let old_path = old.path().to_path_buf();
        let to = absolute(&f._dir.path().join("new-cache")).unwrap();
        let plan = f.manager.migration_plan(&to, "all", false, &[]).unwrap();
        assert_eq!(plan["extra_bytes"], 4);
        assert_eq!(plan["budget_overage_bytes"], 4);
        assert_eq!(plan["can_start"], true);
        let id = plan["plan_id"].as_str().unwrap();
        assert!(f.manager.migration_start(id, false).is_err());
        f.manager.migration_start(id, true).unwrap();
        assert_eq!(wait_job(&f.manager, id)["status"], "cleanup_pending");
        let current = f.manager.acquire_original("asset").unwrap().unwrap();
        assert!(current.path().starts_with(&to));
        assert_eq!(current.path().extension().unwrap(), "nef");
        assert_eq!(fs::read(&old_path).unwrap(), b"data");
        // A restart/legacy scan cannot undo the authoritative root switch.
        f.manager.adopt_original("asset", &old_path).unwrap();
        assert!(f
            .manager
            .acquire_original("asset")
            .unwrap()
            .unwrap()
            .path()
            .starts_with(&to));
        drop(current);
        drop(old);
        assert_eq!(f.manager.migration_get(id).unwrap()["status"], "completed");
        assert!(!old_path.exists());
        assert_eq!(f.manager.state().unwrap()["usage"]["total_bytes"], 4);
    }
    #[test]
    fn failed_or_cancelled_migration_keeps_old_root_and_never_rebinds_assets() {
        let f = fixture();
        let lease = put(&f.manager, "v1.jpg", "original", Some("asset"), b"data");
        let path = lease.path().to_path_buf();
        drop(lease);
        let plan = f
            .manager
            .migration_plan(f._dir.path().join("target"), "all", false, &[])
            .unwrap();
        fs::write(&path, b"edit").unwrap();
        let id = plan["plan_id"].as_str().unwrap();
        f.manager.migration_start(id, false).unwrap();
        assert_eq!(wait_job(&f.manager, id)["status"], "failed");
        assert_eq!(
            f.manager.state().unwrap()["location"]["path"],
            json!(f.root)
        );
        let plan = f
            .manager
            .migration_plan(f._dir.path().join("cancelled"), "all", false, &[])
            .unwrap();
        let id = plan["plan_id"].as_str().unwrap();
        assert_eq!(
            f.manager.migration_cancel(id).unwrap()["status"],
            "cancelled"
        );
        assert_eq!(
            f.manager.state().unwrap()["location"]["path"],
            json!(f.root)
        );
    }
    #[test]
    fn offline_root_is_not_recreated_and_location_checks_reject_user_content() {
        let f = fixture();
        let library = f._dir.path().join("photos");
        fs::create_dir(&library).unwrap();
        assert!(f
            .manager
            .location_check(library.join("cache"), std::slice::from_ref(&library))
            .is_err());
        let nonempty = f._dir.path().join("user-files");
        fs::create_dir(&nonempty).unwrap();
        fs::write(nonempty.join("keep"), b"original").unwrap();
        assert!(f.manager.location_check(&nonempty, &[]).is_err());
        let moved = f._dir.path().join("disconnected");
        fs::rename(&f.root, &moved).unwrap();
        assert_eq!(f.manager.state().unwrap()["location"]["state"], "offline");
        assert!(f.manager.reserve("x", "preview", 1).is_err());
        assert!(!f.root.exists());
        let unused = f._dir.path().join("fallback-must-not-exist");
        let reopened = CacheManager::open(&f.database, &unused).unwrap();
        assert_eq!(reopened.state().unwrap()["location"]["state"], "offline");
        assert!(format!("{:#}", reopened.maintain().unwrap_err()).contains("E_CACHE_OFFLINE"));
        assert!(!f.root.exists());
        assert!(!unused.exists());
    }
    #[test]
    fn policy_validation_rejects_unbounded_or_invalid_values() {
        let f = fixture();
        assert!(f.manager.set_policy(json!({"budget_bytes":0})).is_err());
        assert!(f
            .manager
            .set_policy(json!({"budget_bytes":1025u64*1024*1024*1024}))
            .is_err());
        assert!(f
            .manager
            .set_policy(json!({"preview_policy":"anything"}))
            .is_err());
        assert!(f.manager.set_policy(json!({"max_unused_days":-1})).is_err());
        assert_eq!(
            f.manager
                .set_policy(json!({"max_unused_days":0,"preview_policy":"manual"}))
                .unwrap()["policy"]["preview_policy"],
            "manual"
        );
    }
    #[test]
    fn offline_policy_allows_only_budget_increases_and_rejections_preserve_policy() {
        let f = fixture();
        drop(put(
            &f.manager,
            "image.jpg",
            "original",
            Some("image"),
            &[1; 10],
        ));
        fs::rename(&f.root, f._dir.path().join("disconnected")).unwrap();
        let increased = f
            .manager
            .set_policy(json!({"budget_bytes":12u64*1024*1024*1024}))
            .unwrap();
        assert_eq!(
            increased["policy"]["budget_bytes"],
            12u64 * 1024 * 1024 * 1024
        );
        assert_eq!(increased["usage"]["total_bytes"], 10);
        for request in [
            json!({"budget_bytes":11u64*1024*1024*1024}),
            json!({"max_unused_days":0}),
            json!({"preview_policy":"manual"}),
        ] {
            let error = f.manager.set_policy(request).unwrap_err();
            assert!(format!("{error:#}").contains("E_CACHE_OFFLINE"));
            assert_eq!(f.manager.state().unwrap()["policy"], increased["policy"]);
        }
        assert!(!f.root.exists());
    }
    #[test]
    fn long_legacy_path_adoption_and_prune_preserve_unknown_neighbors() {
        let f = fixture();
        let mut folder = f.root.clone();
        for _ in 0..10 {
            folder.push("long-path-component-1234567890");
        }
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("original.nef");
        fs::write(&path, b"camera bytes").unwrap();
        let unknown = folder.join("unknown.nef");
        fs::write(&unknown, b"untracked history").unwrap();
        let canonical = fs::canonicalize(&path).unwrap();
        #[cfg(windows)]
        assert!(canonical.to_string_lossy().starts_with("\\\\?\\"));
        f.manager.adopt_original("long", &canonical).unwrap();
        assert_eq!(
            fs::read(f.manager.acquire_original("long").unwrap().unwrap().path()).unwrap(),
            b"camera bytes"
        );
        assert_eq!(
            f.manager.prune(json!({"originals":true}), false).unwrap()["freed_bytes"],
            12
        );
        assert!(!path.exists());
        assert_eq!(fs::read(unknown).unwrap(), b"untracked history");
    }
    #[test]
    fn pinned_only_migration_keeps_pins_and_defers_unpinned_leased_objects() {
        let f = fixture();
        drop(put(
            &f.manager,
            "pin.nef",
            "original",
            Some("pin"),
            b"pinned",
        ));
        f.manager.set_pinned("pin", true).unwrap();
        let old = put(&f.manager, "loose.jpg", "original", Some("loose"), b"loose");
        let old_path = old.path().to_path_buf();
        let to = absolute(&f._dir.path().join("pins-only")).unwrap();
        let plan = f.manager.migration_plan(&to, "pinned", false, &[]).unwrap();
        assert_eq!(plan["bytes"], 6);
        let id = plan["plan_id"].as_str().unwrap();
        f.manager.migration_start(id, false).unwrap();
        assert_eq!(wait_job(&f.manager, id)["status"], "cleanup_pending");
        assert!(f
            .manager
            .acquire_original("pin")
            .unwrap()
            .unwrap()
            .path()
            .starts_with(&to));
        assert_eq!(fs::read(&old_path).unwrap(), b"loose");
        drop(old);
        assert_eq!(f.manager.migration_get(id).unwrap()["status"], "completed");
        assert!(!old_path.exists());
        assert!(f.manager.acquire_original("loose").unwrap().is_none());
        assert!(f.manager.is_pinned("pin").unwrap());
    }
    #[test]
    fn cancellation_of_running_copy_keeps_old_location_and_verified_object() {
        let f = fixture();
        let bytes = vec![42; 32 * 1024 * 1024];
        drop(put(
            &f.manager,
            "large.nef",
            "original",
            Some("large"),
            &bytes,
        ));
        let plan = f
            .manager
            .migration_plan(f._dir.path().join("cancel-running"), "all", false, &[])
            .unwrap();
        let id = plan["plan_id"].as_str().unwrap();
        f.manager.migration_start(id, false).unwrap();
        f.manager.migration_cancel(id).unwrap();
        assert_eq!(wait_job(&f.manager, id)["status"], "cancelled");
        assert_eq!(
            f.manager.state().unwrap()["location"]["path"],
            json!(f.root)
        );
        assert_eq!(
            fs::read(f.manager.acquire_original("large").unwrap().unwrap().path()).unwrap(),
            bytes
        );
    }
    #[test]
    fn corrupt_owner_and_overwritten_reservation_cannot_be_committed() {
        let f = fixture();
        let reservation = f.manager.reserve("bounded.jpg", "original", 4).unwrap();
        let partial = reservation.path().to_path_buf();
        fs::write(&partial, b"over budget").unwrap();
        assert!(reservation.commit(Some("asset")).is_err());
        assert!(!partial.exists());
        fs::write(
            f.root.join(MARKER),
            br#"{"version":1,"catalog_id":"foreign","root_id":"foreign"}"#,
        )
        .unwrap();
        assert!(f.manager.reserve("new", "preview", 1).is_err());
        assert_eq!(f.manager.state().unwrap()["location"]["state"], "offline");
    }
    #[cfg(unix)]
    #[test]
    fn linked_cache_location_and_object_components_are_rejected() {
        let f = fixture();
        let outside = f._dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let link = f._dir.path().join("linked");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(f.manager.location_check(&link, &[]).is_err());
    }
    #[test]
    fn child_process_reservation() {
        let Some(directory) = std::env::var_os("NEBULUME_CACHE_TEST_CHILD") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let m =
            CacheManager::open(directory.join("catalog.sqlite3"), directory.join("cache")).unwrap();
        let _r = m.reserve("child", "original", 90).unwrap();
        fs::write(directory.join("ready"), b"ready").unwrap();
        loop {
            thread::sleep(Duration::from_millis(20));
        }
    }
    #[test]
    fn cross_process_reservation_blocks_overcommit_and_crash_is_recovered() {
        let f = fixture();
        tiny_budget(&f.manager, 100);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "cache::tests::child_process_reservation",
                "--nocapture",
            ])
            .env("NEBULUME_CACHE_TEST_CHILD", f._dir.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !f._dir.path().join("ready").exists() {
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("child did not reserve");
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(f.manager.reserve("blocked", "original", 20).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        let reservation = f.manager.reserve("after-crash", "original", 20).unwrap();
        assert_eq!(f.manager.state().unwrap()["usage"]["reserved_bytes"], 20);
        drop(reservation);
    }
}
