use std::collections::HashMap;

use anyhow::{bail, ensure, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{xmp, Collection};

use super::{parse, query::AssetQuery, Core};

#[derive(Deserialize)]
pub(super) struct CollectionListArgs {
    pub library_id: String,
}

#[derive(Deserialize)]
pub(super) struct CollectionCreateArgs {
    pub library_id: String,
    pub name: String,
    #[serde(default = "default_manual_kind")]
    pub kind: String,
    #[serde(default)]
    pub rules: Option<Value>,
}

fn default_manual_kind() -> String {
    "manual".to_owned()
}

#[derive(Deserialize)]
pub(super) struct CollectionUpdateArgs {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub rules: Option<Value>,
}

#[derive(Deserialize)]
pub(super) struct CollectionAssetsArgs {
    pub id: String,
    pub asset_ids: Vec<String>,
}

#[derive(Deserialize)]
pub(super) struct KeywordSetArgs {
    pub ids: Vec<String>,
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub replace: Option<Vec<String>>,
}

pub(super) fn load_keywords_for_asset(conn: &Connection, asset_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT k.path FROM asset_keywords ak
         JOIN keywords k ON k.id=ak.keyword_id
         WHERE ak.asset_id=?1
         ORDER BY k.path ASC",
    )?;
    let rows = stmt
        .query_map([asset_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(super) fn load_keywords_for_assets(
    conn: &Connection,
    asset_ids: &[&String],
) -> Result<HashMap<String, Vec<String>>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    if asset_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; asset_ids.len()].join(",");
    let mut stmt = conn.prepare(&format!(
        "SELECT ak.asset_id, k.path FROM asset_keywords ak
         JOIN keywords k ON k.id=ak.keyword_id
         WHERE ak.asset_id IN ({placeholders})
         ORDER BY k.path ASC"
    ))?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(asset_ids.iter().copied()),
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    for row in rows {
        let (asset_id, path) = row?;
        map.entry(asset_id).or_default().push(path);
    }
    Ok(map)
}

pub(super) fn replace_asset_keywords_tx(
    tx: &Transaction<'_>,
    library_id: &str,
    asset_id: &str,
    keywords: &[String],
) -> Result<()> {
    tx.execute("DELETE FROM asset_keywords WHERE asset_id=?1", [asset_id])?;
    let now = Utc::now().to_rfc3339();
    for raw in keywords {
        let Some(norm) = xmp::normalize_keyword_path(raw) else {
            continue;
        };
        let keyword_id: String = match tx
            .query_row(
                "SELECT id FROM keywords WHERE library_id=?1 AND path=?2",
                params![library_id, norm],
                |row| row.get(0),
            )
            .optional()?
        {
            Some(existing) => existing,
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO keywords(id,library_id,path,created_at) VALUES(?1,?2,?3,?4)",
                    params![id, library_id, norm, now],
                )?;
                id
            }
        };
        tx.execute(
            "INSERT OR IGNORE INTO asset_keywords(asset_id,keyword_id) VALUES(?1,?2)",
            params![asset_id, keyword_id],
        )?;
    }
    Ok(())
}

fn validate_collection_name(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    ensure!(
        !trimmed.is_empty() && trimmed.chars().count() <= 80,
        "E_INVALID: Collection name must contain 1 to 80 characters"
    );
    Ok(trimmed.to_owned())
}

fn validate_smart_rules(rules: &Value) -> Result<String> {
    ensure!(
        rules.is_object(),
        "E_INVALID: Smart collection rules must be a JSON object"
    );
    let mut cleaned = rules.clone();
    if let Some(obj) = cleaned.as_object_mut() {
        obj.remove("collection_id");
        obj.remove("library_id");
        obj.remove("limit");
        obj.remove("offset");
    }
    let _: AssetQuery = serde_json::from_value(cleaned.clone())
        .context("E_INVALID: Invalid smart collection rules")?;
    Ok(serde_json::to_string(&cleaned)?)
}

impl Core {
    pub(super) fn list_collections(&self, library_id: &str) -> Result<Vec<Collection>> {
        self.library(library_id)?;
        let rows: Vec<(String, String, String, String, Option<String>, String)> = {
            let db = self.db()?;
            let mut stmt = db.prepare(
                "SELECT id,library_id,name,kind,rules_json,created_at
                 FROM collections
                 WHERE library_id=?1
                 ORDER BY CASE kind WHEN 'smart' THEN 0 ELSE 1 END, created_at ASC, id ASC",
            )?;
            let mapped = stmt
                .query_map([library_id], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            mapped
        };

        let mut out = Vec::with_capacity(rows.len());
        for (id, lib_id, name, kind, rules_json, created_at) in rows {
            let rules = rules_json
                .as_deref()
                .map(serde_json::from_str::<Value>)
                .transpose()
                .unwrap_or(None);
            let item_count = self.collection_item_count(&lib_id, &id, &kind, rules.as_ref())?;
            out.push(Collection {
                id,
                library_id: lib_id,
                name,
                kind,
                rules,
                item_count,
                created_at,
            });
        }
        Ok(out)
    }

    pub(super) fn collection(&self, id: &str) -> Result<Collection> {
        let (id, lib_id, name, kind, rules_json, created_at): (
            String,
            String,
            String,
            String,
            Option<String>,
            String,
        ) = self
            .db()?
            .query_row(
                "SELECT id,library_id,name,kind,rules_json,created_at FROM collections WHERE id=?1",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?
            .context("E_NOT_FOUND: Collection does not exist")?;
        let rules = rules_json
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()
            .unwrap_or(None);
        let item_count = self.collection_item_count(&lib_id, &id, &kind, rules.as_ref())?;
        Ok(Collection {
            id,
            library_id: lib_id,
            name,
            kind,
            rules,
            item_count,
            created_at,
        })
    }

    fn collection_item_count(
        &self,
        library_id: &str,
        collection_id: &str,
        kind: &str,
        rules: Option<&Value>,
    ) -> Result<usize> {
        if kind == "smart" {
            let mut merged = rules.cloned().unwrap_or_else(|| json!({}));
            if let Some(obj) = merged.as_object_mut() {
                obj.insert("library_id".into(), json!(library_id));
                obj.remove("collection_id");
            }
            let query: AssetQuery = serde_json::from_value(merged)?;
            return self.count_displayed_for_query(&query);
        }
        let query: AssetQuery = serde_json::from_value(json!({
            "library_id": library_id,
            "collection_id": collection_id,
        }))?;
        self.count_displayed_for_query(&query)
    }

    pub(super) fn create_collection(&self, args: CollectionCreateArgs) -> Result<Collection> {
        self.library(&args.library_id)?;
        let name = validate_collection_name(&args.name)?;
        ensure!(
            matches!(args.kind.as_str(), "manual" | "smart"),
            "E_INVALID: Collection kind must be manual or smart"
        );
        let rules_json = if args.kind == "smart" {
            let rules = args
                .rules
                .as_ref()
                .context("E_INVALID: Smart collection requires rules")?;
            Some(validate_smart_rules(rules)?)
        } else {
            None
        };
        if args.kind == "smart" {
            if let Some(encoded) = &rules_json {
                let mut probe: Value = serde_json::from_str(encoded)?;
                probe["library_id"] = json!(args.library_id);
                let query: AssetQuery = serde_json::from_value(probe)?;
                self.query_parts(&query)?;
            }
        }
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();
        self.db()?.execute(
            "INSERT INTO collections(id,library_id,name,kind,rules_json,created_at)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![id, args.library_id, name, args.kind, rules_json, created_at],
        )?;
        self.collection(&id)
    }

    pub(super) fn update_collection(&self, args: CollectionUpdateArgs) -> Result<Collection> {
        let existing = self.collection(&args.id)?;
        let next_name = match args.name {
            Some(ref raw) => validate_collection_name(raw)?,
            None => existing.name.clone(),
        };
        let next_rules_json = match (&existing.kind[..], args.rules) {
            ("smart", Some(rules)) => {
                let encoded = validate_smart_rules(&rules)?;
                let mut probe: Value = serde_json::from_str(&encoded)?;
                probe["library_id"] = json!(existing.library_id);
                let query: AssetQuery = serde_json::from_value(probe)?;
                self.query_parts(&query)?;
                Some(encoded)
            }
            ("smart", None) => existing
                .rules
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            (_, Some(_)) => bail!("E_INVALID: Manual collection cannot store smart rules"),
            (_, None) => None,
        };
        self.db()?.execute(
            "UPDATE collections SET name=?1,rules_json=?2 WHERE id=?3",
            params![next_name, next_rules_json, args.id],
        )?;
        self.collection(&args.id)
    }

    pub(super) fn delete_collection(&self, id: &str) -> Result<Value> {
        let changed = self
            .db()?
            .execute("DELETE FROM collections WHERE id=?1", [id])?;
        ensure!(changed == 1, "E_NOT_FOUND: Collection does not exist");
        Ok(json!({ "id": id }))
    }

    pub(super) fn add_assets_to_collection(&self, args: CollectionAssetsArgs) -> Result<Value> {
        ensure!(
            (1..=2000).contains(&args.asset_ids.len()),
            "E_INVALID: Collection batch must contain 1 to 2000 photos"
        );
        let coll = self.collection(&args.id)?;
        ensure!(
            coll.kind == "manual",
            "E_INVALID: Photos cannot be manually added to a smart collection"
        );
        let expanded = self.with_pair_members(&args.asset_ids)?;
        for id in &expanded {
            let asset = self.asset(id)?;
            ensure!(
                asset.library_id == coll.library_id,
                "E_INVALID: Asset belongs to a different library than the collection"
            );
        }
        let now = Utc::now().to_rfc3339();
        let mut added = 0usize;
        {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut stmt = tx.prepare_cached(
                    "INSERT OR IGNORE INTO collection_items(collection_id,asset_id,added_at) VALUES(?1,?2,?3)",
                )?;
                for asset_id in &expanded {
                    added += stmt.execute(params![coll.id, asset_id, now])?;
                }
            }
            tx.commit()?;
        }
        let updated = self.collection(&args.id)?;
        Ok(json!({
            "collection": updated,
            "added": added,
        }))
    }

    pub(super) fn remove_assets_from_collection(
        &self,
        args: CollectionAssetsArgs,
    ) -> Result<Value> {
        ensure!(
            (1..=2000).contains(&args.asset_ids.len()),
            "E_INVALID: Collection batch must contain 1 to 2000 photos"
        );
        let coll = self.collection(&args.id)?;
        ensure!(
            coll.kind == "manual",
            "E_INVALID: Photos cannot be manually removed from a smart collection"
        );
        let expanded = self.with_pair_members(&args.asset_ids)?;
        let mut removed = 0usize;
        {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut stmt = tx.prepare_cached(
                    "DELETE FROM collection_items WHERE collection_id=?1 AND asset_id=?2",
                )?;
                for asset_id in &expanded {
                    removed += stmt.execute(params![coll.id, asset_id])?;
                }
            }
            tx.commit()?;
        }
        let updated = self.collection(&args.id)?;
        Ok(json!({
            "collection": updated,
            "removed": removed,
        }))
    }

    pub(super) fn library_keywords(&self, library_id: &str) -> Result<Value> {
        self.library(library_id)?;
        let db = self.db()?;
        let mut stmt = db.prepare(
            "SELECT k.path, COUNT(DISTINCT ak.asset_id) AS cnt
             FROM keywords k
             LEFT JOIN asset_keywords ak ON ak.keyword_id = k.id
             LEFT JOIN assets a ON a.id = ak.asset_id AND a.trashed_at IS NULL AND a.availability <> 'missing'
             WHERE k.library_id = ?1
             GROUP BY k.id, k.path
             HAVING COUNT(a.id) > 0
             ORDER BY COUNT(a.id) DESC, k.path ASC
             LIMIT 500",
        )?;
        let rows = stmt
            .query_map([library_id], |row| {
                Ok(json!({
                    "path": row.get::<_, String>(0)?,
                    "count": row.get::<_, i64>(1)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Value::Array(rows))
    }

    pub(super) fn set_asset_keywords(&self, args: KeywordSetArgs) -> Result<Value> {
        ensure!(
            (1..=1000).contains(&args.ids.len()),
            "E_INVALID: Keyword batch must contain 1 to 1000 assets"
        );
        let library_id = self.mark_batch_library(&args.ids)?;
        let expanded = self.with_pair_members(&args.ids)?;

        let normalized_add: Vec<String> = args
            .add
            .iter()
            .map(|raw| {
                xmp::normalize_keyword_path(raw)
                    .context("E_INVALID: Keyword must contain 1 to 160 valid characters")
            })
            .collect::<Result<Vec<_>>>()?;
        let normalized_remove: Vec<String> = args
            .remove
            .iter()
            .filter_map(|raw| xmp::normalize_keyword_path(raw))
            .collect();
        let normalized_replace: Option<Vec<String>> = args
            .replace
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .map(|raw| {
                        xmp::normalize_keyword_path(raw)
                            .context("E_INVALID: Keyword must contain 1 to 160 valid characters")
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?;

        {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for asset_id in &expanded {
                let mut current = if let Some(ref rep) = normalized_replace {
                    let mut dedup = Vec::new();
                    for item in rep {
                        if !dedup.contains(item) {
                            dedup.push(item.clone());
                        }
                    }
                    dedup
                } else {
                    load_keywords_for_asset(&tx, asset_id)?
                };
                for rem in &normalized_remove {
                    current.retain(|existing| existing != rem);
                }
                for add in &normalized_add {
                    if !current.contains(add) {
                        current.push(add.clone());
                    }
                }
                current.sort();
                replace_asset_keywords_tx(&tx, &library_id, asset_id, &current)?;
            }
            tx.execute(
                "DELETE FROM keywords WHERE library_id=?1 AND id NOT IN (SELECT DISTINCT keyword_id FROM asset_keywords)",
                [&library_id],
            )?;
            tx.commit()?;
        }

        self.sync_xmp_with_keywords(&expanded);
        let primary_keywords = {
            let db = self.db()?;
            load_keywords_for_asset(&db, &args.ids[0])?
        };
        Ok(json!({
            "updated": expanded.len(),
            "keywords": primary_keywords,
        }))
    }

    pub(super) fn dispatch_collection_or_keyword(
        &self,
        command: &str,
        params: Value,
    ) -> Result<Option<Value>> {
        match command {
            "collection.list" => {
                let args: CollectionListArgs = parse(params)?;
                Ok(Some(serde_json::to_value(
                    self.list_collections(&args.library_id)?,
                )?))
            }
            "collection.get" => {
                let id = super::id(&params)?;
                Ok(Some(serde_json::to_value(self.collection(&id)?)?))
            }
            "collection.create" => {
                let args: CollectionCreateArgs = parse(params)?;
                Ok(Some(serde_json::to_value(self.create_collection(args)?)?))
            }
            "collection.update" => {
                let args: CollectionUpdateArgs = parse(params)?;
                Ok(Some(serde_json::to_value(self.update_collection(args)?)?))
            }
            "collection.delete" => {
                let id = super::id(&params)?;
                Ok(Some(self.delete_collection(&id)?))
            }
            "collection.add_assets" => {
                let args: CollectionAssetsArgs = parse(params)?;
                Ok(Some(self.add_assets_to_collection(args)?))
            }
            "collection.remove_assets" => {
                let args: CollectionAssetsArgs = parse(params)?;
                Ok(Some(self.remove_assets_from_collection(args)?))
            }
            "library.keywords" => {
                let args: CollectionListArgs = parse(params)?;
                Ok(Some(self.library_keywords(&args.library_id)?))
            }
            "asset.keywords.set" => {
                let args: KeywordSetArgs = parse(params)?;
                Ok(Some(self.set_asset_keywords(args)?))
            }
            _ => Ok(None),
        }
    }
}
