//! Catalog records for memory cards, import presets and import batches.
//! Writing a card's identity file is the service's job; this module only keeps
//! SQLite rows, so every function here is testable without removable media.
use anyhow::{ensure, Context, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{catalog::path_key, Core};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Card {
    /// Same value as the identity id written to the card.
    pub id: String,
    pub name: String,
    pub location_id: String,
    pub volume_label: Option<String>,
    pub volume_serial: Option<String>,
    pub capacity_bytes: Option<u64>,
    pub last_mount_path: Option<String>,
    pub last_seen_at: Option<String>,
    pub default_preset_id: Option<String>,
    pub created_at: String,
    pub last_import_at: Option<String>,
}

/// Facts about a mounted volume. Label, serial and capacity are hints only.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CardIdentity {
    pub mount_path: String,
    #[serde(default)]
    pub volume_label: Option<String>,
    #[serde(default)]
    pub volume_serial: Option<String>,
    #[serde(default)]
    pub capacity_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportPreset {
    pub id: String,
    pub name: String,
    pub library_id: String,
    /// neb-ingest OrganizeRules, stored as JSON so core does not depend on ingest.
    pub rules: Value,
    pub deduplicate: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportBatch {
    pub id: String,
    pub library_id: String,
    pub card_id: Option<String>,
    pub source: String,
    pub rules: Value,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub copied: u64,
    pub duplicates: u64,
    pub failed: u64,
    /// Assets in the library that this batch brought in.
    #[serde(default)]
    pub asset_count: u64,
}

/// (location key, size, sha256 if known, filename, captured_at)
pub type KnownAssetRow = (String, u64, Option<String>, String, String);

const CARD_COLUMNS: &str = "c.id,c.name,v.location_id,v.volume_label,v.volume_serial,v.capacity_bytes,v.last_mount_path,v.last_seen_at,c.default_preset_id,c.created_at,c.last_import_at";
const CARD_FROM: &str = "cards c JOIN volume_identities v ON v.id=c.id";

fn card_row(row: &Row<'_>) -> rusqlite::Result<Card> {
    Ok(Card {
        id: row.get(0)?,
        name: row.get(1)?,
        location_id: row.get(2)?,
        volume_label: row.get(3)?,
        volume_serial: row.get(4)?,
        capacity_bytes: row.get::<_, Option<i64>>(5)?.map(|v| v.max(0) as u64),
        last_mount_path: row.get(6)?,
        last_seen_at: row.get(7)?,
        default_preset_id: row.get(8)?,
        created_at: row.get(9)?,
        last_import_at: row.get(10)?,
    })
}

fn preset_row(row: &Row<'_>) -> rusqlite::Result<ImportPreset> {
    let rules: String = row.get(3)?;
    Ok(ImportPreset {
        id: row.get(0)?,
        name: row.get(1)?,
        library_id: row.get(2)?,
        rules: serde_json::from_str(&rules).unwrap_or(Value::Null),
        deduplicate: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn batch_row(row: &Row<'_>) -> rusqlite::Result<ImportBatch> {
    let rules: String = row.get(4)?;
    Ok(ImportBatch {
        id: row.get(0)?,
        library_id: row.get(1)?,
        card_id: row.get(2)?,
        source: row.get(3)?,
        rules: serde_json::from_str(&rules).unwrap_or(Value::Null),
        started_at: row.get(5)?,
        finished_at: row.get(6)?,
        status: row.get(7)?,
        copied: row.get::<_, i64>(8)?.max(0) as u64,
        duplicates: row.get::<_, i64>(9)?.max(0) as u64,
        failed: row.get::<_, i64>(10)?.max(0) as u64,
        asset_count: row.get::<_, i64>(11)?.max(0) as u64,
    })
}

fn valid_name(name: &str) -> Result<String> {
    let name = name.trim();
    ensure!(
        !name.is_empty() && name.chars().count() <= 120,
        "E_INVALID: Name must contain 1 to 120 characters"
    );
    Ok(name.to_owned())
}

pub fn valid_identity_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok()
}

impl Core {
    pub fn cards(&self) -> Result<Vec<Card>> {
        let db = self.db()?;
        let mut statement = db.prepare(&format!(
            "SELECT {CARD_COLUMNS} FROM {CARD_FROM} ORDER BY c.name,c.id"
        ))?;
        let rows = statement
            .query_map([], card_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn card(&self, id: &str) -> Result<Card> {
        self.db()?
            .query_row(
                &format!("SELECT {CARD_COLUMNS} FROM {CARD_FROM} WHERE c.id=?1"),
                [id],
                card_row,
            )
            .optional()?
            .context("E_NOT_FOUND: Card is not registered")
    }

    /// Create the removable location, its identity and the card in one transaction.
    /// `id` is the value the service has already written to the card.
    pub fn register_card(&self, id: &str, name: &str, identity: &CardIdentity) -> Result<Card> {
        ensure!(valid_identity_id(id), "E_INVALID: Card identity is invalid");
        let name = valid_name(name)?;
        let now = Utc::now().to_rfc3339();
        let location = Uuid::new_v4().to_string();
        let mut db = self.db()?;
        let transaction = db.transaction()?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM cards WHERE id=?1)",
            [id],
            |row| row.get(0),
        )?;
        ensure!(!exists, "E_CONFLICT: This card is already registered");
        transaction.execute(
            "INSERT INTO locations(id,kind,name,endpoint,implicit,created_at) VALUES(?1,'removable',?2,?3,0,?4)",
            params![location, name, identity.mount_path, now],
        )?;
        transaction.execute(
            "INSERT INTO volume_identities(id,location_id,volume_label,volume_serial,capacity_bytes,last_mount_path,last_seen_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id, location, identity.volume_label, identity.volume_serial, identity.capacity_bytes.map(|v| v as i64), identity.mount_path, now],
        )?;
        transaction.execute(
            "INSERT INTO cards(id,name,created_at) VALUES(?1,?2,?3)",
            params![id, name, now],
        )?;
        transaction.commit()?;
        drop(db);
        self.card(id)
    }

    /// Record that a known card is mounted here now.
    pub fn card_seen(&self, id: &str, identity: &CardIdentity) -> Result<Card> {
        let now = Utc::now().to_rfc3339();
        let db = self.db()?;
        let changed = db.execute(
            "UPDATE volume_identities SET last_mount_path=?1,last_seen_at=?2,
             volume_label=COALESCE(?3,volume_label),volume_serial=COALESCE(?4,volume_serial),
             capacity_bytes=COALESCE(?5,capacity_bytes) WHERE id=?6",
            params![
                identity.mount_path,
                now,
                identity.volume_label,
                identity.volume_serial,
                identity.capacity_bytes.map(|v| v as i64),
                id
            ],
        )?;
        ensure!(changed == 1, "E_NOT_FOUND: Card is not registered");
        db.execute(
            "UPDATE locations SET endpoint=?1 WHERE id=(SELECT location_id FROM volume_identities WHERE id=?2)",
            params![identity.mount_path, id],
        )?;
        drop(db);
        self.card(id)
    }

    /// Registered cards that this unidentified volume might be (e.g. after formatting).
    /// Hints only: the user always confirms a binding.
    pub fn card_candidates(&self, identity: &CardIdentity) -> Result<Vec<Card>> {
        let serial = identity.volume_serial.as_deref().filter(|s| !s.is_empty());
        let label = identity.volume_label.as_deref().filter(|s| !s.is_empty());
        Ok(self
            .cards()?
            .into_iter()
            .filter(|card| {
                let same_serial = serial.is_some() && card.volume_serial.as_deref() == serial;
                let same_label = label.is_some() && card.volume_label.as_deref() == label;
                let similar_size = match (identity.capacity_bytes, card.capacity_bytes) {
                    (Some(a), Some(b)) => a.abs_diff(b) <= a.max(b) / 50,
                    _ => true,
                };
                same_serial || (same_label && similar_size)
            })
            .collect())
    }

    pub fn update_card(
        &self,
        id: &str,
        name: Option<&str>,
        default_preset_id: Option<Option<&str>>,
    ) -> Result<Card> {
        self.card(id)?;
        let db = self.db()?;
        if let Some(name) = name {
            let name = valid_name(name)?;
            db.execute("UPDATE cards SET name=?1 WHERE id=?2", params![name, id])?;
            db.execute(
                "UPDATE locations SET name=?1 WHERE id=(SELECT location_id FROM volume_identities WHERE id=?2)",
                params![name, id],
            )?;
        }
        if let Some(preset) = default_preset_id {
            if let Some(preset) = preset {
                let exists: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM import_presets WHERE id=?1)",
                    [preset],
                    |row| row.get(0),
                )?;
                ensure!(exists, "E_NOT_FOUND: Import preset does not exist");
            }
            db.execute(
                "UPDATE cards SET default_preset_id=?1 WHERE id=?2",
                params![preset, id],
            )?;
        }
        drop(db);
        self.card(id)
    }

    /// Forget a card's records. Never touches the card or imported files.
    pub fn remove_card(&self, id: &str) -> Result<()> {
        let mut db = self.db()?;
        let transaction = db.transaction()?;
        let location: Option<String> = transaction
            .query_row(
                "SELECT location_id FROM volume_identities WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let location = location.context("E_NOT_FOUND: Card is not registered")?;
        let used: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM libraries WHERE location_id=?1)",
            [&location],
            |row| row.get(0),
        )?;
        ensure!(!used, "E_IN_USE: A library lives on this volume");
        transaction.execute("DELETE FROM cards WHERE id=?1", [id])?;
        transaction.execute("DELETE FROM volume_identities WHERE id=?1", [id])?;
        transaction.execute("DELETE FROM locations WHERE id=?1", [&location])?;
        // Batch history keeps its summary but no longer names a card.
        transaction.execute(
            "UPDATE import_batches SET card_id=NULL WHERE card_id=?1",
            [id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn import_presets(&self) -> Result<Vec<ImportPreset>> {
        let db = self.db()?;
        let mut statement = db.prepare(
            "SELECT id,name,library_id,rules_json,deduplicate,created_at FROM import_presets ORDER BY name,id",
        )?;
        let rows = statement
            .query_map([], preset_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Insert or replace a preset. The service validates `rules` before calling this.
    pub fn save_import_preset(
        &self,
        id: Option<&str>,
        name: &str,
        library_id: &str,
        rules: &Value,
        deduplicate: bool,
    ) -> Result<ImportPreset> {
        let name = valid_name(name)?;
        ensure!(
            rules.is_object(),
            "E_INVALID: Import rules must be an object"
        );
        self.library(library_id)?;
        let id = id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let db = self.db()?;
        db.execute(
            "INSERT INTO import_presets(id,name,library_id,rules_json,deduplicate,created_at) VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,library_id=excluded.library_id,rules_json=excluded.rules_json,deduplicate=excluded.deduplicate",
            params![id, name, library_id, rules.to_string(), deduplicate, Utc::now().to_rfc3339()],
        )?;
        db.query_row(
            "SELECT id,name,library_id,rules_json,deduplicate,created_at FROM import_presets WHERE id=?1",
            [&id],
            preset_row,
        )
        .map_err(Into::into)
    }

    pub fn remove_import_preset(&self, id: &str) -> Result<()> {
        let db = self.db()?;
        db.execute(
            "UPDATE cards SET default_preset_id=NULL WHERE default_preset_id=?1",
            [id],
        )?;
        let removed = db.execute("DELETE FROM import_presets WHERE id=?1", [id])?;
        ensure!(removed == 1, "E_NOT_FOUND: Import preset does not exist");
        Ok(())
    }

    /// Record a finished import and tag the library assets it copied. `copied` holds
    /// (destination path, sha256) for items this batch actually wrote.
    pub fn record_import_batch(
        &self,
        batch: &ImportBatch,
        copied: &[(String, String)],
    ) -> Result<ImportBatch> {
        self.library(&batch.library_id)?;
        let mut db = self.db()?;
        let transaction = db.transaction()?;
        transaction.execute(
            "INSERT INTO import_batches(id,library_id,card_id,source,rules_json,started_at,finished_at,status,copied,duplicates,failed)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![batch.id, batch.library_id, batch.card_id, batch.source, batch.rules.to_string(), batch.started_at, batch.finished_at, batch.status, batch.copied as i64, batch.duplicates as i64, batch.failed as i64],
        )?;
        {
            let mut tag = transaction.prepare(
                "UPDATE assets SET import_batch_id=?1,sha256=COALESCE(sha256,?2) WHERE library_id=?3 AND (path_key=?4 OR key=?5)",
            )?;
            // Local imports pass canonical paths; remote imports pass location keys.
            for (path, sha256) in copied {
                tag.execute(params![
                    batch.id,
                    sha256,
                    batch.library_id,
                    path_key(path),
                    path
                ])?;
            }
        }
        if let Some(card) = &batch.card_id {
            transaction.execute(
                "UPDATE cards SET last_import_at=?1 WHERE id=?2",
                params![
                    batch.finished_at.as_deref().unwrap_or(&batch.started_at),
                    card
                ],
            )?;
        }
        transaction.commit()?;
        drop(db);
        self.import_batch(&batch.id)
    }

    /// What a library already holds, for import de-duplication without downloads:
    /// (location key, size, sha256 if known, filename, captured_at).
    pub fn import_known_assets(
        &self,
        library_id: &str,
    ) -> Result<Vec<KnownAssetRow>> {
        self.library(library_id)?;
        let db = self.db()?;
        let mut statement = db.prepare(
            "SELECT key,size,sha256,filename,captured_at FROM assets WHERE library_id=?1 AND key IS NOT NULL AND availability<>'missing'",
        )?;
        let rows = statement
            .query_map([library_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?.max(0) as u64,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn import_batch(&self, id: &str) -> Result<ImportBatch> {
        self.db()?
            .query_row(&format!("{BATCH_SELECT} WHERE b.id=?1"), [id], batch_row)
            .optional()?
            .context("E_NOT_FOUND: Import batch does not exist")
    }

    pub fn import_batches(&self, library_id: &str) -> Result<Vec<ImportBatch>> {
        self.library(library_id)?;
        let db = self.db()?;
        let mut statement = db.prepare(&format!(
            "{BATCH_SELECT} WHERE b.library_id=?1 ORDER BY b.started_at DESC,b.id LIMIT 200"
        ))?;
        let rows = statement
            .query_map([library_id], batch_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

const BATCH_SELECT: &str = "SELECT b.id,b.library_id,b.card_id,b.source,b.rules_json,b.started_at,b.finished_at,b.status,b.copied,b.duplicates,b.failed,
    (SELECT COUNT(*) FROM assets a WHERE a.import_batch_id=b.id) FROM import_batches b";
