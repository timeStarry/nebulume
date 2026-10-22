use std::fs;

use image::{Rgb, RgbImage};
use neb_core::Core;
use serde_json::{json, Value};
use tempfile::TempDir;

fn setup(count: usize) -> (TempDir, Core, String, Vec<String>) {
    let temp = tempfile::tempdir().unwrap();
    let photos = temp.path().join("photos");
    fs::create_dir(&photos).unwrap();
    for index in 0..count {
        RgbImage::from_pixel(8, 8, Rgb([index as u8 * 40, 90, 160]))
            .save(photos.join(format!("frame-{index}.png")))
            .unwrap();
    }
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core
        .dispatch("library.add", json!({"name":"选图", "root":photos}))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    core.dispatch("library.scan", json!({"library_id":library}))
        .unwrap();
    let ids = ids(
        &core,
        json!({"library_id":library,"sort_by":"filename","sort_direction":"asc"}),
    );
    (temp, core, library, ids)
}

fn ids(core: &Core, query: Value) -> Vec<String> {
    core.dispatch("asset.list", query).unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

fn error(result: anyhow::Result<Value>) -> String {
    result.unwrap_err().to_string()
}

#[test]
fn flag_round_trip_and_filters() {
    let (_temp, core, library, assets) = setup(3);
    assert_eq!(core.asset(&assets[0]).unwrap().flag, "none");
    let picked = core
        .dispatch("asset.flag", json!({"id":assets[0],"flag":"pick"}))
        .unwrap();
    assert_eq!(picked["flag"], "pick");
    core.dispatch("asset.flag", json!({"id":assets[1],"flag":"reject"}))
        .unwrap();
    let count = |flag: &str| {
        core.dispatch("asset.list", json!({"library_id":library,"flag":flag}))
            .unwrap()["total"]
            .as_u64()
            .unwrap()
    };
    assert_eq!(count("pick"), 1);
    assert_eq!(count("reject"), 1);
    assert_eq!(count("none"), 1);
    assert_eq!(count("not_reject"), 2);
    assert_eq!(count("any"), 3);
    assert!(
        error(core.dispatch("asset.flag", json!({"id":assets[0],"flag":"maybe"})))
            .starts_with("E_INVALID")
    );
    assert!(error(core.dispatch("asset.list", json!({"flag":"maybe"}))).starts_with("E_INVALID"));
    assert!(
        error(core.dispatch("asset.flag", json!({"id":"missing","flag":"pick"})))
            .starts_with("E_NOT_FOUND")
    );
    // Re-scanning keeps culling marks, as it keeps ratings and crops.
    core.dispatch("library.scan", json!({"library_id":library}))
        .unwrap();
    assert_eq!(core.asset(&assets[0]).unwrap().flag, "pick");
}

#[test]
fn mark_batch_is_atomic() {
    let (_temp, core, _library, assets) = setup(2);
    let failed = core.dispatch(
        "asset.mark_batch",
        json!({"ids":[assets[0],"missing"],"rating":4,"flag":"pick"}),
    );
    assert!(error(failed).starts_with("E_NOT_FOUND"));
    assert_eq!(core.asset(&assets[0]).unwrap().rating, 0);
    assert_eq!(core.asset(&assets[0]).unwrap().flag, "none");
    let result = core
        .dispatch(
            "asset.mark_batch",
            json!({"ids":assets,"rating":3,"flag":"pick"}),
        )
        .unwrap();
    assert_eq!(result["updated"], 2);
    for id in &assets {
        let asset = core.asset(id).unwrap();
        assert_eq!((asset.rating, asset.flag.as_str()), (3, "pick"));
    }
    // Omitted fields keep their values.
    core.dispatch("asset.mark_batch", json!({"ids":[assets[0]],"flag":"none"}))
        .unwrap();
    assert_eq!(core.asset(&assets[0]).unwrap().rating, 3);
    for invalid in [
        json!({"ids":[]}),
        json!({"ids":[assets[0]]}),
        json!({"ids":[assets[0]],"rating":6}),
        json!({"ids":[assets[0]],"flag":"maybe"}),
    ] {
        assert!(error(core.dispatch("asset.mark_batch", invalid)).starts_with("E_INVALID"));
    }
}

#[test]
fn v5_catalog_upgrades_to_v6_preserving_marks() {
    let (temp, core, _library, assets) = setup(1);
    core.dispatch("asset.rate", json!({"id":assets[0],"rating":5}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id":assets[0],"x":0.1,"y":0.1,"width":0.5,"height":0.5}),
    )
    .unwrap();
    drop(core);
    let database = rusqlite::Connection::open(temp.path().join("catalog/catalog.sqlite3")).unwrap();
    database.execute_batch(V6_DOWNGRADE).unwrap();
    database.execute_batch("PRAGMA user_version=5;").unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let version = |db: &rusqlite::Connection| {
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    assert_eq!(version(&database), 7);
    let asset = core.asset(&assets[0]).unwrap();
    assert_eq!(asset.flag, "none");
    assert_eq!(asset.rating, 5);
    assert_eq!(asset.crop.unwrap().width, 0.5);
    drop(core);
    // Reopening a v6 catalog does not migrate again.
    Core::open(temp.path().join("catalog")).unwrap();
    assert_eq!(version(&database), 7);
}

const V6_DOWNGRADE: &str = "DROP INDEX assets_library_key; DROP INDEX libraries_location; ALTER TABLE assets DROP COLUMN key; ALTER TABLE libraries DROP COLUMN location_id; DROP TABLE locations; DROP INDEX assets_library_flag; DROP INDEX assets_library_batch; ALTER TABLE assets DROP COLUMN flag; ALTER TABLE assets DROP COLUMN import_batch_id; ALTER TABLE assets DROP COLUMN sha256;";
