use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::Arc,
};

use anyhow::{bail, ensure, Context, Result};
use rusqlite::{Connection, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{asset_row, Core, ASSET_COLUMNS};

const LIST_MEMO_ENTRIES: usize = 8;

#[derive(Deserialize)]
pub(super) struct AssetQuery {
    pub library_id: Option<String>,
    pub query: Option<String>,
    pub rating: Option<u8>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub format: Option<String>,
    pub sort_by: Option<String>,
    pub sort_direction: Option<String>,
    pub flag: Option<String>,
    pub import_batch_id: Option<String>,
    /// Exact EXIF camera model, as listed by `asset.facets`.
    pub camera: Option<String>,
    /// Exact EXIF lens, as listed by `asset.facets`.
    pub lens: Option<String>,
    /// Inclusive capture-date bounds, `YYYY-MM-DD`, compared with the camera's local date.
    pub captured_from: Option<String>,
    pub captured_to: Option<String>,
    /// Library-relative folder (`a/b`); photos in it and its subfolders.
    #[serde(default)]
    pub folder: Option<String>,
    /// Highest rating to include, for "not yet rated".
    #[serde(default)]
    pub rating_max: Option<u8>,
    /// Inclusive focal length range in mm, from EXIF `Focal Length`.
    #[serde(default)]
    pub focal_min: Option<f64>,
    #[serde(default)]
    pub focal_max: Option<f64>,
    /// Inclusive ISO range.
    #[serde(default)]
    pub iso_min: Option<f64>,
    #[serde(default)]
    pub iso_max: Option<f64>,
}

pub(super) struct ListSnapshot {
    pub displayed: Vec<String>,
    pub file_total: usize,
    /// Pair variants by the representative that is displayed.
    pub pairs: HashMap<String, Arc<[PairVariant; 2]>>,
}

pub(super) struct ListMemo {
    pub key: String,
    pub revision: i64,
    pub uses_full_revision: bool,
    pub snapshot: Arc<ListSnapshot>,
}

#[derive(Clone, serde::Serialize)]
pub(super) struct PairVariant {
    pub id: String,
    pub filename: String,
    pub extension: String,
    pub kind: String,
}

pub(super) struct QueryParts {
    pub search: String,
    pub format: String,
    pub flag: String,
    pub sort: &'static str,
    pub direction: &'static str,
    pub order: String,
    pub scope_sql: &'static str,
    pub scope_params: Vec<rusqlite::types::Value>,
    pub where_sql: String,
    pub where_params: Vec<rusqlite::types::Value>,
    pub uses_full_revision: bool,
}

impl Core {
    /// Camera models and lenses present in a library, most common first, for filter menus.
    pub(super) fn asset_facets(&self, library_id: &str) -> Result<Value> {
        self.library(library_id)?;
        let db = self.db()?;
        let facet = |column: &str| -> Result<Vec<Value>> {
            let mut statement = db.prepare(&format!(
                "SELECT {column} AS value,COUNT(*) FROM assets \
                 WHERE library_id=?1 AND availability<>'missing' AND {column} IS NOT NULL AND {column}<>'' \
                 GROUP BY {column} ORDER BY COUNT(*) DESC,{column} LIMIT 200"
            ))?;
            let rows = statement
                .query_map([library_id], |row| {
                    Ok(json!({"value": row.get::<_, String>(0)?, "count": row.get::<_, i64>(1)?}))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        };
        let cameras = facet("camera")?;
        let lenses = facet("lens")?;
        let (first, last): (Option<String>, Option<String>) = db.query_row(
            "SELECT MIN(substr(captured_at,1,10)),MAX(substr(captured_at,1,10)) \
             FROM assets WHERE library_id=?1 AND captured_at<>'' AND availability<>'missing'",
            [library_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(
            json!({"cameras": cameras, "lenses": lenses, "captured": {"first": first, "last": last}}),
        )
    }

    /// Validates an asset filter and builds minimal active WHERE and ORDER BY clauses
    /// so SQLite can pick composite `(library_id, ...)` B-tree indexes directly.
    pub(super) fn query_parts(&self, args: &AssetQuery) -> Result<QueryParts> {
        use rusqlite::types::Value as V;

        ensure!(
            valid_day(&args.captured_from) && valid_day(&args.captured_to),
            "E_INVALID: captured_from and captured_to must be YYYY-MM-DD dates"
        );
        ensure!(
            args.rating.is_none_or(|rating| rating <= 5),
            "E_INVALID: Rating must be from 0 to 5"
        );
        let query = args.query.clone().unwrap_or_default();
        ensure!(
            query.chars().count() <= 256,
            "E_INVALID: Search query is too long"
        );
        let format = args.format.as_deref().unwrap_or("all");
        ensure!(
            ["all", "raw", "jpeg"].contains(&format),
            "E_INVALID: Unknown image format filter"
        );
        let sort = match args.sort_by.as_deref().unwrap_or("captured_at") {
            "captured_at" => "captured_at",
            "modified_at" => "modified_at",
            "created_at" => "created_at",
            "filename" => "filename",
            "rating" => "rating",
            _ => bail!("E_INVALID: Unknown asset sort field"),
        };
        let flag = args.flag.as_deref().unwrap_or("any");
        ensure!(
            ["any", "pick", "none", "reject", "not_reject"].contains(&flag),
            "E_INVALID: Unknown flag filter"
        );
        let direction = match args.sort_direction.as_deref().unwrap_or("desc") {
            "asc" => "ASC",
            "desc" => "DESC",
            _ => bail!("E_INVALID: Unknown asset sort direction"),
        };
        if sort == "created_at" {
            self.backfill_created_at(args.library_id.as_deref())?;
        }
        let order = if matches!(sort, "created_at" | "captured_at") {
            format!("({sort}='') ASC,{sort} {direction},path ASC,id ASC")
        } else {
            format!("{sort} {direction},path ASC,id ASC")
        };
        // Quote all user terms: FTS operators cannot escape into the expression.
        let search = query
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|word| !word.is_empty())
            .map(|word| format!("\"{word}\"*"))
            .collect::<Vec<_>>()
            .join(" AND ");

        let (scope_sql, scope_params) = match &args.library_id {
            Some(id) => ("trashed_at IS NULL AND library_id=?", vec![V::Text(id.clone())]),
            None => (
                "trashed_at IS NULL AND library_id IN (SELECT id FROM libraries WHERE hidden=0)",
                Vec::new(),
            ),
        };

        let mut clauses: Vec<&'static str> = vec![scope_sql];
        let mut where_params = scope_params.clone();

        if let Some(rating) = args.rating {
            clauses.push("rating>=?");
            where_params.push(V::Integer(rating.into()));
        }
        if let Some(rating_max) = args.rating_max {
            clauses.push("rating<=?");
            where_params.push(V::Integer(rating_max.into()));
        }
        if !search.is_empty() {
            clauses.push("rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)");
            where_params.push(V::Text(search.clone()));
        }
        match format {
            "raw" => clauses.push("kind='raw'"),
            "jpeg" => clauses.push("lower(extension) IN ('jpg','jpeg')"),
            _ => {}
        }
        match flag {
            "any" => {}
            "not_reject" => clauses.push("flag<>'reject'"),
            exact => {
                clauses.push("flag=?");
                where_params.push(V::Text(exact.to_owned()));
            }
        }
        if let Some(batch) = &args.import_batch_id {
            clauses.push("import_batch_id=?");
            where_params.push(V::Text(batch.clone()));
        }
        if let Some(camera) = &args.camera {
            clauses.push("camera=?");
            where_params.push(V::Text(camera.clone()));
        }
        if let Some(lens) = &args.lens {
            clauses.push("lens=?");
            where_params.push(V::Text(lens.clone()));
        }
        if let Some(from) = &args.captured_from {
            clauses.push("(captured_at<>'' AND captured_at>=? AND substr(captured_at,1,10)>=?)");
            where_params.push(V::Text(from.clone()));
            where_params.push(V::Text(from.clone()));
        }
        if let Some(to) = &args.captured_to {
            clauses.push("(captured_at<>'' AND captured_at<=? AND substr(captured_at,1,10)<=?)");
            where_params.push(V::Text(format!("{to}\u{10ffff}")));
            where_params.push(V::Text(to.clone()));
        }
        if let Some(folder) = args
            .folder
            .as_deref()
            .map(|folder| folder.trim_matches('/'))
            .filter(|folder| !folder.is_empty())
        {
            clauses.push("(key=? OR key LIKE ? ESCAPE '\\')");
            where_params.push(V::Text(folder.to_owned()));
            where_params.push(V::Text(format!(
                "{}/%",
                folder
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )));
        }
        if let Some(focal_min) = args.focal_min {
            clauses.push("focal_length_mm>=?");
            where_params.push(V::Real(focal_min));
        }
        if let Some(focal_max) = args.focal_max {
            clauses.push("focal_length_mm<=?");
            where_params.push(V::Real(focal_max));
        }
        if let Some(iso_min) = args.iso_min {
            clauses.push("iso_value>=?");
            where_params.push(V::Real(iso_min));
        }
        if let Some(iso_max) = args.iso_max {
            clauses.push("iso_value<=?");
            where_params.push(V::Real(iso_max));
        }

        let uses_full_revision = args.rating.is_some()
            || args.rating_max.is_some()
            || flag != "any"
            || args.import_batch_id.is_some()
            || matches!(sort, "rating" | "created_at");

        Ok(QueryParts {
            search,
            format: format.to_owned(),
            flag: flag.to_owned(),
            sort,
            direction,
            order,
            scope_sql,
            scope_params,
            where_sql: clauses.join(" AND "),
            where_params,
            uses_full_revision,
        })
    }

    fn cached_snapshot(
        &self,
        read: &Transaction<'_>,
        args: &AssetQuery,
        parts: &QueryParts,
    ) -> Result<Arc<ListSnapshot>> {
        let (full_rev, structural_rev): (i64, i64) = read.query_row(
            "SELECT value,structural_value FROM catalog_revision WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let expected_rev = if parts.uses_full_revision {
            full_rev
        } else {
            structural_rev
        };
        let memo_key = serde_json::to_string(&(
            &args.library_id,
            args.rating,
            &parts.search,
            parts.format.as_str(),
            parts.flag.as_str(),
            &args.import_batch_id,
            &args.camera,
            &args.lens,
            &args.captured_from,
            &args.captured_to,
            (
                &args.folder,
                args.rating_max,
                args.focal_min,
                args.focal_max,
                args.iso_min,
                args.iso_max,
            ),
            parts.sort,
            parts.direction,
        ))?;
        let cached = self.list_memo.lock().ok().and_then(|memo| {
            memo.iter()
                .find(|entry| {
                    entry.uses_full_revision == parts.uses_full_revision
                        && entry.revision == expected_rev
                        && entry.key == memo_key
                })
                .map(|entry| Arc::clone(&entry.snapshot))
        });
        match cached {
            Some(snapshot) => Ok(snapshot),
            None => {
                let snapshot = Arc::new(Self::list_snapshot(read, parts)?);
                if let Ok(mut memo) = self.list_memo.lock() {
                    memo.retain(|entry| {
                        let current = if entry.uses_full_revision {
                            full_rev
                        } else {
                            structural_rev
                        };
                        entry.revision == current && entry.key != memo_key
                    });
                    memo.push(ListMemo {
                        key: memo_key,
                        revision: expected_rev,
                        uses_full_revision: parts.uses_full_revision,
                        snapshot: Arc::clone(&snapshot),
                    });
                    if memo.len() > LIST_MEMO_ENTRIES {
                        memo.remove(0);
                    }
                }
                Ok(snapshot)
            }
        }
    }

    pub(super) fn list_assets(&self, args: AssetQuery) -> Result<Value> {
        let limit = args.limit.unwrap_or(200);
        ensure!(
            (1..=1000).contains(&limit),
            "E_INVALID: Query limit must be between 1 and 1000"
        );
        let parts = self.query_parts(&args)?;
        let db = self.db()?;
        // One read snapshot, so the revision and the rows it describes cannot disagree.
        let read = db.unchecked_transaction()?;
        let snapshot = self.cached_snapshot(&read, &args, &parts)?;
        let file_total = snapshot.file_total;
        let total = snapshot.displayed.len();
        let page: Vec<&String> = snapshot
            .displayed
            .iter()
            .skip(args.offset.unwrap_or(0) as usize)
            .take(limit as usize)
            .collect();
        let mut items = Vec::with_capacity(page.len());
        if !page.is_empty() {
            let placeholders = vec!["?"; page.len()].join(",");
            let mut statement = read.prepare(&format!(
                "SELECT {ASSET_COLUMNS} FROM assets WHERE id IN ({placeholders})"
            ))?;
            let assets = statement
                .query_map(rusqlite::params_from_iter(page.iter().copied()), asset_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut assets: HashMap<_, _> = assets
                .into_iter()
                .map(|asset| (asset.id.clone(), asset))
                .collect();
            for id in page {
                let asset = assets
                    .remove(id)
                    .context("E_CONFLICT: Asset list changed while reading")?;
                let mut value = serde_json::to_value(asset)?;
                if let Some(pair) = snapshot.pairs.get(id.as_str()) {
                    value["variants"] = serde_json::to_value(&**pair)?;
                }
                items.push(value);
            }
        }
        Ok(json!({"items": items, "total": total, "file_total": file_total}))
    }

    /// Ordered, pair-collapsed IDs matching the same filter as `asset.list`, without
    /// page slicing or per-row JSON hydration. Powers instant full-filter `⌘A`.
    pub(super) fn asset_ids(&self, args: AssetQuery) -> Result<Value> {
        let parts = self.query_parts(&args)?;
        let db = self.db()?;
        let read = db.unchecked_transaction()?;
        let snapshot = self.cached_snapshot(&read, &args, &parts)?;
        Ok(json!({
            "ids": snapshot.displayed.as_slice(),
            "total": snapshot.displayed.len(),
            "file_total": snapshot.file_total,
        }))
    }

    /// Overview numbers for the same filter the grid shows. Photo counts collapse
    /// RAW + JPEG pairs like the grid; `bytes` counts every file.
    pub(super) fn asset_stats(&self, args: AssetQuery) -> Result<Value> {
        let parts = self.query_parts(&args)?;
        let db = self.db()?;
        let read = db.unchecked_transaction()?;
        let snapshot = self.cached_snapshot(&read, &args, &parts)?;
        let shown: HashSet<&str> = snapshot.displayed.iter().map(String::as_str).collect();
        let mut statement = read.prepare(&format!(
            "SELECT id,rating,flag,size,substr(captured_at,1,10),camera,lens,focal_length_mm,iso_value \
             FROM assets WHERE {}",
            parts.where_sql
        ))?;
        let mut rows = statement.query(rusqlite::params_from_iter(parts.where_params.iter()))?;
        let (mut photos, mut picks, mut rejects, mut rated, mut bytes, mut undated) =
            (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
        let mut days: BTreeMap<String, u64> = BTreeMap::new();
        let mut cameras: HashMap<String, u64> = HashMap::new();
        let mut lenses: HashMap<String, u64> = HashMap::new();
        let mut focal = Vec::new();
        let mut iso = Vec::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            bytes += row.get::<_, i64>(3)?.max(0) as u64;
            if !shown.contains(id.as_str()) {
                continue;
            }
            photos += 1;
            let rating: i64 = row.get(1)?;
            match row.get::<_, String>(2)?.as_str() {
                "pick" => picks += 1,
                "reject" => rejects += 1,
                _ if rating > 0 => rated += 1,
                _ => {}
            }
            match row.get::<_, Option<String>>(4)? {
                Some(day) if day.len() == 10 => *days.entry(day).or_default() += 1,
                _ => undated += 1,
            }
            for (column, counts) in [(5, &mut cameras), (6, &mut lenses)] {
                if let Some(name) = row
                    .get::<_, Option<String>>(column)?
                    .filter(|name| !name.trim().is_empty())
                {
                    *counts.entry(name).or_default() += 1;
                }
            }
            if let Some(value) = row.get::<_, Option<f64>>(7)?.filter(|value| *value > 0.0) {
                focal.push(value);
            }
            if let Some(value) = row.get::<_, Option<f64>>(8)?.filter(|value| *value > 0.0) {
                iso.push(value);
            }
        }
        let ranked = |counts: HashMap<String, u64>| {
            let mut rows: Vec<_> = counts.into_iter().collect();
            rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            rows.truncate(12);
            rows.into_iter()
                .map(|(name, count)| json!({"name": name, "count": count}))
                .collect::<Vec<_>>()
        };
        // Inclusive bounds, so each bin is also a valid focal_min/focal_max or iso_min/iso_max filter.
        let bins = |values: &[f64], edges: &[(&str, f64, Option<f64>)]| {
            edges
                .iter()
                .map(|(label, min, max)| {
                    let count = values
                        .iter()
                        .filter(|value| **value >= *min && max.is_none_or(|max| **value <= max))
                        .count();
                    json!({"label": label, "min": min, "max": max, "count": count})
                })
                .collect::<Vec<_>>()
        };
        Ok(json!({
            "photos": photos,
            "files": snapshot.file_total,
            "bytes": bytes,
            "picks": picks,
            "rejects": rejects,
            "rated": rated,
            "unprocessed": photos - picks - rejects - rated,
            "undated": undated,
            "days": days.into_iter().map(|(day, count)| json!({"day": day, "count": count})).collect::<Vec<_>>(),
            "cameras": ranked(cameras),
            "lenses": ranked(lenses),
            "focal": bins(&focal, &[("≤23", 0.0, Some(23.99)), ("24–35", 24.0, Some(35.99)), ("36–50", 36.0, Some(50.99)), ("51–85", 51.0, Some(85.99)), ("86–135", 86.0, Some(135.99)), ("136+", 136.0, None)]),
            "iso": bins(&iso, &[("≤100", 0.0, Some(100.0)), ("200", 101.0, Some(200.0)), ("400", 201.0, Some(400.0)), ("800", 401.0, Some(800.0)), ("1600", 801.0, Some(1600.0)), ("3200", 1601.0, Some(3200.0)), ("6400+", 3201.0, None)]),
        }))
    }

    /// A library's folders, nested, with photo counts that match the grid
    /// (a RAW + JPEG pair counts once). `path` is what `asset.list` takes as `folder`.
    pub(super) fn library_folders(&self, library_id: &str) -> Result<Value> {
        self.library(library_id)?;
        let args: AssetQuery = serde_json::from_value(json!({"library_id": library_id}))?;
        let parts = self.query_parts(&args)?;
        let db = self.db()?;
        let read = db.unchecked_transaction()?;
        let snapshot = self.cached_snapshot(&read, &args, &parts)?;
        let shown: HashSet<&str> = snapshot.displayed.iter().map(String::as_str).collect();
        let mut statement = read.prepare(
            "SELECT id,key FROM assets WHERE library_id=?1 AND trashed_at IS NULL AND key IS NOT NULL",
        )?;
        let mut counts: BTreeMap<String, u64> = BTreeMap::new();
        for row in statement.query_map([library_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (id, key) = row?;
            if !shown.contains(id.as_str()) {
                continue;
            }
            let segments: Vec<&str> = key.split('/').collect();
            for depth in 1..segments.len() {
                *counts.entry(segments[..depth].join("/")).or_default() += 1;
            }
        }
        fn nest(parent: &str, counts: &BTreeMap<String, u64>) -> Vec<Value> {
            counts
                .iter()
                .filter(|(path, _)| path.rsplit_once('/').map_or("", |(head, _)| head) == parent)
                .map(|(path, count)| {
                    json!({
                        "path": path,
                        "name": path.rsplit('/').next().unwrap_or(path),
                        "count": count,
                        "children": nest(path, counts)
                    })
                })
                .collect()
        }
        Ok(
            json!({"library_id": library_id, "total": snapshot.displayed.len(), "folders": nest("", &counts)}),
        )
    }

    /// The ordered, pair-collapsed ID list of one query. Recomputed only when the
    /// relevant catalog revision or the query changes, so paging costs one page of rows.
    fn list_snapshot(db: &Connection, parts: &QueryParts) -> Result<ListSnapshot> {
        // Determine ambiguity from the unfiltered library. Only thin identity
        // fields are read globally; large metadata blobs are loaded for the page.
        let mut groups: HashMap<(String, String, String), Vec<PairVariant>> = HashMap::new();
        let mut grouping = db.prepare(&format!(
            "SELECT id,library_id,COALESCE(source_key,path),filename,extension,kind \
             FROM assets WHERE {} AND library_id IN (SELECT id FROM libraries WHERE pair_raw_jpeg=1) \
             AND (kind='raw' OR lower(extension) IN ('jpg','jpeg'))",
            parts.scope_sql
        ))?;
        let members = grouping.query_map(
            rusqlite::params_from_iter(parts.scope_params.iter()),
            |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    PairVariant {
                        id: row.get(0)?,
                        filename: row.get(3)?,
                        extension: row.get(4)?,
                        kind: row.get(5)?,
                    },
                ))
            },
        )?;
        for member in members {
            let (library, location, variant) = member?;
            let location = Path::new(&location);
            if let (Some(directory), Some(stem)) = (
                location.parent(),
                location.file_stem().and_then(|s| s.to_str()),
            ) {
                groups
                    .entry((
                        library,
                        directory.to_string_lossy().into_owned(),
                        stem.to_string(),
                    ))
                    .or_default()
                    .push(variant);
            }
        }
        let mut pairs: HashMap<String, [PairVariant; 2]> = HashMap::new();
        for mut members in groups.into_values() {
            if members.len() != 2 || members.iter().filter(|m| m.kind == "raw").count() != 1 {
                continue;
            }
            members.sort_by_key(|member| member.kind != "raw");
            let pair = [members.remove(0), members.remove(0)];
            pairs.insert(pair[0].id.clone(), pair.clone());
            pairs.insert(pair[1].id.clone(), pair);
        }
        let mut statement = db.prepare(&format!(
            "SELECT id FROM assets WHERE {} ORDER BY {}",
            parts.where_sql, parts.order
        ))?;
        let ids = statement
            .query_map(
                rusqlite::params_from_iter(parts.where_params.iter()),
                |row| row.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let file_total = ids.len();
        let matches: HashSet<_> = ids.iter().collect();
        let displayed: Vec<String> = ids
            .iter()
            .filter(|id| {
                pairs.get(*id).is_none_or(|pair| {
                    let representative = if matches.contains(&pair[1].id) {
                        &pair[1].id
                    } else {
                        &pair[0].id
                    };
                    *id == representative
                })
            })
            .cloned()
            .collect();
        let mut representatives = HashMap::new();
        for id in &displayed {
            if let Some(pair) = pairs.get(id) {
                representatives.insert(id.clone(), Arc::new(pair.clone()));
            }
        }
        Ok(ListSnapshot {
            displayed,
            file_total,
            pairs: representatives,
        })
    }
}

fn valid_day(day: &Option<String>) -> bool {
    day.as_deref().is_none_or(|day| {
        day.len() == 10 && chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok()
    })
}
