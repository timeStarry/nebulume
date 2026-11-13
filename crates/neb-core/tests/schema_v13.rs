//! Schema v13 guarantees:
//! 1. FTS5 triggers ignore rating/flag/crop updates while still indexing filename/metadata updates.
//! 2. Unfiltered list snapshots survive rating/flag culling (`structural_value` stays constant),
//!    while rating/flag-filtered snapshots immediately observe mark changes (`value` increments).
//! 3. Virtual EXIF columns (`camera`, `lens`, `focal_length_mm`, `iso_value`) upgrade cleanly from v12
//!    and drive composite B-tree index lookups in `EXPLAIN QUERY PLAN`.
//! 4. `asset.ids` matches pair-collapsed `asset.list` ordering across pages without row hydration.
//! 5. Multi-batch scanning (`> 250` files) commits cleanly, skips unchanged rescans in memory,
//!    marks missing files, and preserves ratings/flags across moves/renames.

use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};
use neb_core::Core;
use rusqlite::{params, Connection};
use serde_json::json;
use std::{fs, io::Cursor};

const TINY_PPM: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

#[test]
fn marks_skip_fts_rebuilds_and_keep_structural_revision_stable() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    for name in ["alpha", "beta", "gamma"] {
        fs::write(photos.path().join(format!("{name}.ppm")), TINY_PPM).unwrap();
    }

    let core = Core::open(data.path()).unwrap();
    let lib = core.add_library("Studio", photos.path()).unwrap();
    core.scan(&lib.id).unwrap();

    let listed = core
        .dispatch(
            "asset.list",
            json!({"library_id": lib.id, "sort_by": "filename", "sort_direction": "asc"}),
        )
        .unwrap();
    let first_id = listed["items"][0]["id"].as_str().unwrap().to_owned();

    let db = Connection::open(data.path().join("catalog.sqlite3")).unwrap();
    let (rev_before, struct_before): (i64, i64) = db
        .query_row(
            "SELECT value, structural_value FROM catalog_revision WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let fts_docsize_before: Vec<Vec<u8>> = db
        .prepare("SELECT sz FROM assets_fts_docsize ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let fts_segments_before: i64 = db
        .query_row("SELECT COUNT(*) FROM assets_fts_data", [], |r| r.get(0))
        .unwrap();

    // Prime both an unfiltered snapshot and a rating-filtered snapshot.
    assert_eq!(
        core.dispatch(
            "asset.ids",
            json!({"library_id": lib.id, "sort_by": "filename", "sort_direction": "asc"})
        )
        .unwrap()["total"],
        3
    );
    assert_eq!(
        core.dispatch(
            "asset.ids",
            json!({"library_id": lib.id, "rating": 5, "sort_by": "filename", "sort_direction": "asc"})
        )
        .unwrap()["total"],
        0
    );

    // Rate, flag, and crop: none of these change filename or metadata_json.
    core.dispatch("asset.rate", json!({"id": first_id, "rating": 5}))
        .unwrap();
    core.dispatch("asset.flag", json!({"id": first_id, "flag": "pick"}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id": first_id, "x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}),
    )
    .unwrap();

    let (rev_after, struct_after): (i64, i64) = db
        .query_row(
            "SELECT value, structural_value FROM catalog_revision WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        rev_after,
        rev_before + 3,
        "full revision increments per mark"
    );
    assert_eq!(
        struct_after, struct_before,
        "structural revision stays unchanged during pure culling marks"
    );

    // FTS5 creates new segment tombstones whenever assets_au fires; zero new rows proves FTS was untouched.
    let fts_segments_after: i64 = db
        .query_row("SELECT COUNT(*) FROM assets_fts_data", [], |r| r.get(0))
        .unwrap();
    let fts_docsize_after: Vec<Vec<u8>> = db
        .prepare("SELECT sz FROM assets_fts_docsize ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(fts_segments_after, fts_segments_before);
    assert_eq!(fts_docsize_after, fts_docsize_before);

    // Rating-filtered queries immediately see the newly rated photo, and unfiltered pages still hydrate fresh marks.
    let rated_ids = core
        .dispatch(
            "asset.ids",
            json!({"library_id": lib.id, "rating": 5, "sort_by": "filename", "sort_direction": "asc"}),
        )
        .unwrap();
    assert_eq!(rated_ids["ids"], json!([first_id]));

    let refreshed_page = core
        .dispatch(
            "asset.list",
            json!({"library_id": lib.id, "sort_by": "filename", "sort_direction": "asc"}),
        )
        .unwrap();
    assert_eq!(refreshed_page["items"][0]["rating"], 5);
    assert_eq!(refreshed_page["items"][0]["flag"], "pick");

    // Updating metadata_json DOES update FTS5 and bump structural_value.
    db.execute(
        "UPDATE assets SET metadata_json=?1 WHERE id=?2",
        params![r#"{"Camera":"Hasselblad X2D"}"#, first_id],
    )
    .unwrap();
    let (_, struct_after_meta): (i64, i64) = db
        .query_row(
            "SELECT value, structural_value FROM catalog_revision WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(struct_after_meta, struct_after + 1);
    let search_hits = core
        .dispatch(
            "asset.ids",
            json!({"library_id": lib.id, "query": "Hasselblad"}),
        )
        .unwrap();
    assert_eq!(search_hits["ids"], json!([first_id]));
}

#[test]
fn v12_upgrades_to_v13_and_exif_filters_use_composite_indexes() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    for name in ["one", "two", "three"] {
        fs::write(photos.path().join(format!("{name}.ppm")), TINY_PPM).unwrap();
    }

    let core = Core::open(data.path()).unwrap();
    let lib = core.add_library("Gear Test", photos.path()).unwrap();
    core.scan(&lib.id).unwrap();
    let ids: Vec<String> = core
        .dispatch(
            "asset.ids",
            json!({"library_id": lib.id, "sort_by": "filename", "sort_direction": "asc"}),
        )
        .unwrap()["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    drop(core);

    // Simulate a v12 catalog by dropping the v13 indexes/columns/revision column and rewinding user_version=12.
    let db = Connection::open(data.path().join("catalog.sqlite3")).unwrap();
    db.execute(
        "UPDATE assets SET metadata_json=?1 WHERE id=?2",
        params![
            r#"{"Camera":"Sony ILCE-7RM5","Lens":"FE 24-70mm GM II","Focal Length":"35 mm","ISO":"100"}"#,
            ids[0]
        ],
    )
    .unwrap();
    db.execute(
        "UPDATE assets SET metadata_json=?1 WHERE id=?2",
        params![
            r#"{"Camera":"Sony ILCE-7RM5","Lens":"FE 85mm GM","Focal Length":"85 mm","ISO":"800"}"#,
            ids[1]
        ],
    )
    .unwrap();
    db.execute(
        "UPDATE assets SET metadata_json=?1 WHERE id=?2",
        params![
            r#"{"Camera":"Fujifilm GFX100 II","Lens":"GF 55mmF1.7","Focal Length":"55 mm","ISO":"64"}"#,
            ids[2]
        ],
    )
    .unwrap();
    db.execute_batch(
        "DROP INDEX assets_library_camera;
         DROP INDEX assets_library_lens;
         DROP INDEX assets_library_focal;
         DROP INDEX assets_library_iso;
         ALTER TABLE assets DROP COLUMN camera;
         ALTER TABLE assets DROP COLUMN lens;
         ALTER TABLE assets DROP COLUMN focal_length_mm;
         ALTER TABLE assets DROP COLUMN iso_value;
         DROP TRIGGER assets_revision_insert;
         DROP TRIGGER assets_revision_update;
         DROP TRIGGER assets_revision_delete;
         DROP TRIGGER libraries_revision_insert;
         DROP TRIGGER libraries_revision_update;
         DROP TRIGGER libraries_revision_delete;
         ALTER TABLE catalog_revision DROP COLUMN structural_value;
         PRAGMA user_version=12;",
    )
    .unwrap();
    drop(db);

    // Reopen to run v12 -> v13 migration.
    let core = Core::open(data.path()).unwrap();
    let db = Connection::open(data.path().join("catalog.sqlite3")).unwrap();
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 14);

    // Verify EXPLAIN QUERY PLAN uses our composite EXIF indexes rather than full-table scans.
    for (sql, expected_index) in [
        (
            "EXPLAIN QUERY PLAN SELECT id FROM assets WHERE library_id='x' AND camera='Sony ILCE-7RM5' AND trashed_at IS NULL",
            "assets_library_camera",
        ),
        (
            "EXPLAIN QUERY PLAN SELECT id FROM assets WHERE library_id='x' AND lens='FE 85mm GM' AND trashed_at IS NULL",
            "assets_library_lens",
        ),
        (
            "EXPLAIN QUERY PLAN SELECT id FROM assets WHERE library_id='x' AND focal_length_mm>=35.0 AND focal_length_mm<=70.0 AND trashed_at IS NULL",
            "assets_library_focal",
        ),
        (
            "EXPLAIN QUERY PLAN SELECT id FROM assets WHERE library_id='x' AND iso_value>=400.0 AND trashed_at IS NULL",
            "assets_library_iso",
        ),
    ] {
        let plan: String = db
            .prepare(sql)
            .unwrap()
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
            .join(" | ");
        assert!(
            plan.contains(expected_index),
            "expected query plan '{plan}' to use index {expected_index}"
        );
    }

    // Verify filter results and facets match.
    let sony_mid = core
        .dispatch(
            "asset.ids",
            json!({"library_id": lib.id, "camera": "Sony ILCE-7RM5", "focal_min": 30.0, "focal_max": 50.0}),
        )
        .unwrap();
    assert_eq!(sony_mid["ids"], json!([ids[0]]));

    let high_iso = core
        .dispatch("asset.ids", json!({"library_id": lib.id, "iso_min": 400.0}))
        .unwrap();
    assert_eq!(high_iso["ids"], json!([ids[1]]));

    let facets = core
        .dispatch("asset.facets", json!({"library_id": lib.id}))
        .unwrap();
    assert_eq!(facets["cameras"][0]["value"], "Sony ILCE-7RM5");
    assert_eq!(facets["cameras"][0]["count"], 2);
}

#[test]
fn asset_ids_matches_paired_list_and_multi_batch_scan_preserves_moved_marks() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();

    // Create 280 photos (> SCAN_BATCH_SIZE = 250) plus 10 RAW+JPEG pairs to exercise multi-batch commits and pairing.
    for i in 0..280 {
        let mut bytes = TINY_PPM.to_vec();
        // Give #42 unique content so move/rename detection by quick_hash + size is unambiguous.
        if i == 42 {
            bytes = b"P6\n4 1\n255\n\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c".to_vec();
        }
        fs::write(photos.path().join(format!("shot_{i:04}.ppm")), bytes).unwrap();
    }
    let mut jpeg_buf = Cursor::new(Vec::new());
    JpegEncoder::new(&mut jpeg_buf)
        .encode_image(&RgbImage::from_pixel(4, 2, Rgb([20, 80, 140])))
        .unwrap();
    let jpeg = jpeg_buf.into_inner();
    let mut raw = Vec::with_capacity(38 + jpeg.len());
    raw.extend_from_slice(b"II\x2a\x00\x08\x00\x00\x00\x02\x00");
    raw.extend_from_slice(&513u16.to_le_bytes());
    raw.extend_from_slice(&4u16.to_le_bytes());
    raw.extend_from_slice(&1u32.to_le_bytes());
    raw.extend_from_slice(&38u32.to_le_bytes());
    raw.extend_from_slice(&514u16.to_le_bytes());
    raw.extend_from_slice(&4u16.to_le_bytes());
    raw.extend_from_slice(&1u32.to_le_bytes());
    raw.extend_from_slice(&(jpeg.len() as u32).to_le_bytes());
    raw.extend_from_slice(&0u32.to_le_bytes());
    raw.extend_from_slice(&jpeg);

    for i in 0..10 {
        fs::write(photos.path().join(format!("pair_{i:02}.arw")), &raw).unwrap();
        fs::write(photos.path().join(format!("pair_{i:02}.jpg")), &jpeg).unwrap();
    }

    let core = Core::open(data.path()).unwrap();
    let lib = core
        .add_library_with_options("Batch Shoot", photos.path(), true)
        .unwrap();
    let summary = core.scan(&lib.id).unwrap();
    assert_eq!(summary.indexed, 300);
    assert_eq!(summary.errors.len(), 0);

    // Unchanged rescan skips re-indexing in memory while keeping exact counts.
    let rescan = core.scan(&lib.id).unwrap();
    assert_eq!(rescan.indexed, 0);
    assert_eq!(rescan.skipped, 300);
    assert_eq!(rescan.moved, 0);

    // Compare `asset.ids` against paginated `asset.list` (280 singles + 10 collapsed pairs = 290 displayed, 300 files).
    let all_ids = core
        .dispatch(
            "asset.ids",
            json!({"library_id": lib.id, "sort_by": "filename", "sort_direction": "asc"}),
        )
        .unwrap();
    assert_eq!(all_ids["total"], 290);
    assert_eq!(all_ids["file_total"], 300);

    let page1 = core
        .dispatch(
            "asset.list",
            json!({"library_id": lib.id, "sort_by": "filename", "sort_direction": "asc", "limit": 200, "offset": 0}),
        )
        .unwrap();
    let page2 = core
        .dispatch(
            "asset.list",
            json!({"library_id": lib.id, "sort_by": "filename", "sort_direction": "asc", "limit": 200, "offset": 200}),
        )
        .unwrap();
    let mut paged_ids: Vec<String> = page1["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(page2["items"].as_array().unwrap().iter())
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect();
    let direct_ids: Vec<String> = all_ids["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(direct_ids, paged_ids);

    // Mark shot_0042.ppm, then rename it into a subfolder and delete shot_0000.ppm.
    let shot_42_id = page1["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(page2["items"].as_array().unwrap().iter())
        .find(|item| item["filename"] == "shot_0042.ppm")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    core.dispatch("asset.rate", json!({"id": shot_42_id, "rating": 5}))
        .unwrap();
    core.dispatch("asset.flag", json!({"id": shot_42_id, "flag": "pick"}))
        .unwrap();

    let shot_0_id = page1["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(page2["items"].as_array().unwrap().iter())
        .find(|item| item["filename"] == "shot_0000.ppm")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let selects_dir = photos.path().join("selects");
    fs::create_dir(&selects_dir).unwrap();
    fs::rename(
        photos.path().join("shot_0042.ppm"),
        selects_dir.join("hero_0042.ppm"),
    )
    .unwrap();
    fs::remove_file(photos.path().join("shot_0000.ppm")).unwrap();

    let after_move = core.scan(&lib.id).unwrap();
    assert_eq!(after_move.moved, 1);
    assert_eq!(core.asset(&shot_0_id).unwrap().availability, "missing");

    let moved = core.asset(&shot_42_id).unwrap();
    assert_eq!(moved.filename, "hero_0042.ppm");
    assert_eq!(moved.rating, 5);
    assert_eq!(moved.flag, "pick");
    assert_eq!(moved.availability, "available");
    paged_ids.clear();
}
