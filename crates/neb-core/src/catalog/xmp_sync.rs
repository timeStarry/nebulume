use std::{collections::HashSet, path::PathBuf};

use anyhow::{bail, ensure, Result};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{xmp, Asset, Crop};

use super::Core;

const XMP_AUTO_WRITE_KEY: &str = "xmp.auto_write";

#[derive(Deserialize)]
pub(super) struct XmpTargetArgs {
    pub ids: Option<Vec<String>>,
    pub library_id: Option<String>,
}

impl Core {
    pub fn xmp_auto_write(&self) -> Result<bool> {
        let value: Option<String> = self
            .db()?
            .query_row(
                "SELECT value FROM app_settings WHERE key=?1",
                [XMP_AUTO_WRITE_KEY],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.as_deref() == Some("true"))
    }

    pub fn set_xmp_auto_write(&self, enabled: bool) -> Result<bool> {
        self.db()?.execute(
            "INSERT INTO app_settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![XMP_AUTO_WRITE_KEY, if enabled { "true" } else { "false" }],
        )?;
        Ok(enabled)
    }

    /// Best-effort sidecar write when `xmp.auto_write` is enabled.
    /// Never fails the primary catalog mutation if a volume is read-only or offline.
    pub(super) fn sync_xmp_if_enabled(&self, ids: &[String]) {
        let Ok(true) = self.xmp_auto_write() else {
            return;
        };
        let mut seen_sidecars = HashSet::new();
        for id in ids {
            let Ok(asset) = self.asset(id) else {
                continue;
            };
            if asset.source_key.is_some() {
                continue;
            }
            let Ok(path) = self.checked_asset_path(&asset) else {
                continue;
            };
            if let Ok(target) = xmp::sidecar_path_for_write(&path) {
                if !seen_sidecars.insert(target) {
                    continue;
                }
            }
            let _ = xmp::write_sidecar_for_image(&path, asset.rating, &asset.flag, asset.crop);
        }
    }

    /// Flush `.xmp` right before handing a local original to an external editor (`Open With`),
    /// so Lightroom / Capture One / Camera Raw immediately sees Nebulume's stars, flag, and crop.
    pub fn flush_asset_xmp_for_handoff(&self, id: &str) -> Result<Option<PathBuf>> {
        let asset = self.asset(id)?;
        if asset.source_key.is_some() {
            return Ok(None);
        }
        let path = self.checked_asset_path(&asset)?;
        xmp::write_sidecar_for_image(&path, asset.rating, &asset.flag, asset.crop)
    }

    pub(super) fn write_xmp_sidecars(&self, args: XmpTargetArgs) -> Result<Value> {
        let assets = self.resolve_xmp_targets(args)?;
        let mut written = 0usize;
        let mut skipped = 0usize;
        let mut failed = Vec::new();
        let mut seen_sidecars = HashSet::new();

        for asset in assets {
            if asset.source_key.is_some() {
                skipped += 1;
                continue;
            }
            let path = match self.checked_asset_path(&asset) {
                Ok(path) => path,
                Err(error) => {
                    failed.push(json!({
                        "id": asset.id,
                        "path": asset.path,
                        "message": format!("{error:#}"),
                    }));
                    continue;
                }
            };
            if let Ok(target) = xmp::sidecar_path_for_write(&path) {
                if !seen_sidecars.insert(target) {
                    skipped += 1;
                    continue;
                }
            }
            match xmp::write_sidecar_for_image(&path, asset.rating, &asset.flag, asset.crop) {
                Ok(Some(_)) => written += 1,
                Ok(None) => skipped += 1,
                Err(error) => failed.push(json!({
                    "id": asset.id,
                    "path": asset.path,
                    "message": format!("{error:#}"),
                })),
            }
        }

        Ok(json!({
            "written": written,
            "skipped": skipped,
            "errors": failed,
        }))
    }

    pub(super) fn read_xmp_sidecars(&self, args: XmpTargetArgs) -> Result<Value> {
        let assets = self.resolve_xmp_targets(args)?;
        let mut updated = 0usize;
        let mut skipped = 0usize;
        let mut failed = Vec::new();
        let mut pending_updates: Vec<(String, u8, String, Option<Crop>, bool)> = Vec::new();

        for asset in assets {
            if asset.source_key.is_some() {
                skipped += 1;
                continue;
            }
            let path = match self.checked_asset_path(&asset) {
                Ok(path) => path,
                Err(error) => {
                    failed.push(json!({
                        "id": asset.id,
                        "path": asset.path,
                        "message": format!("{error:#}"),
                    }));
                    continue;
                }
            };
            match xmp::read_sidecar_for_image(&path) {
                Ok(Some(sidecar)) => {
                    let next_rating = sidecar.rating.unwrap_or(asset.rating);
                    let next_flag = sidecar.flag.unwrap_or_else(|| asset.flag.clone());
                    let next_crop = match sidecar.crop {
                        Some(crop_opt) => crop_opt,
                        None => asset.crop,
                    };
                    let crop_changed = next_crop != asset.crop;
                    if next_rating != asset.rating || next_flag != asset.flag || crop_changed {
                        pending_updates.push((
                            asset.id,
                            next_rating,
                            next_flag,
                            next_crop,
                            crop_changed,
                        ));
                    } else {
                        skipped += 1;
                    }
                }
                Ok(None) => skipped += 1,
                Err(error) => failed.push(json!({
                    "id": asset.id,
                    "path": asset.path,
                    "message": format!("{error:#}"),
                })),
            }
        }

        if !pending_updates.is_empty() {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut stmt = tx.prepare_cached(
                    "UPDATE assets SET rating=?1,flag=?2,crop_json=?3 WHERE id=?4",
                )?;
                for (id, rating, flag, crop, _) in &pending_updates {
                    let crop_json = crop
                        .map(|c| serde_json::to_string(&c))
                        .transpose()?;
                    stmt.execute(params![rating, flag, crop_json, id])?;
                    updated += 1;
                }
            }
            tx.commit()?;
            drop(db);

            for (id, _, _, _, crop_changed) in &pending_updates {
                if *crop_changed {
                    self.previews.remove_prefix(&format!("{id}:"));
                }
            }
        }

        let crop_changed_ids: Vec<String> = pending_updates
            .into_iter()
            .filter_map(|(id, _, _, _, changed)| changed.then_some(id))
            .collect();

        Ok(json!({
            "updated": updated,
            "skipped": skipped,
            "errors": failed,
            "crop_changed_ids": crop_changed_ids,
        }))
    }

    fn resolve_xmp_targets(&self, args: XmpTargetArgs) -> Result<Vec<Asset>> {
        if let Some(ids) = args.ids {
            ensure!(
                (1..=5000).contains(&ids.len()),
                "E_INVALID: XMP batch must name 1 to 5000 assets"
            );
            let expanded = self.with_pair_members(&ids)?;
            let mut out = Vec::with_capacity(expanded.len());
            for id in expanded {
                out.push(self.asset(&id)?);
            }
            return Ok(out);
        }
        if let Some(library_id) = args.library_id {
            self.library(&library_id)?;
            let ids = self.local_asset_ids(&library_id)?;
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                out.push(self.asset(&id)?);
            }
            return Ok(out);
        }
        bail!("E_INVALID: Provide ids or library_id for XMP operation")
    }
}
