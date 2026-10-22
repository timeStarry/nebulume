use std::fs;

use image::{Rgb, RgbImage};
use neb_core::{Core, Location};
use serde_json::json;

fn photo(path: &std::path::Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    RgbImage::from_pixel(4, 4, Rgb([10, 20, 30]))
        .save(path)
        .unwrap();
}

const V7_DOWNGRADE: &str = "DROP INDEX import_batches_library; DROP TABLE import_batches; DROP TABLE cards; DROP TABLE import_presets; DROP TABLE volume_identities; DROP INDEX assets_library_key; DROP INDEX libraries_location; ALTER TABLE assets DROP COLUMN key; ALTER TABLE libraries DROP COLUMN location_id; DROP TABLE locations; PRAGMA user_version=6;";

#[test]
fn folder_library_gets_an_implicit_location_and_location_relative_keys() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("photos");
    photo(&root.join("2026/day/a.png"));
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core.add_library("相册", &root).unwrap();
    let locations = core.locations().unwrap();
    assert_eq!(locations.len(), 1);
    assert!(locations[0].implicit);
    assert_eq!(locations[0].kind, "local");
    assert_eq!(
        library.location_id.as_deref(),
        Some(locations[0].id.as_str())
    );
    core.dispatch("library.scan", json!({"library_id":library.id}))
        .unwrap();
    let id = core
        .dispatch("asset.list", json!({"library_id":library.id}))
        .unwrap()["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        core.asset(&id).unwrap().key.as_deref(),
        Some("2026/day/a.png")
    );
    // Removing the library removes its implicit location, never the folder.
    core.remove_library(&library.id).unwrap();
    assert!(core.locations().unwrap().is_empty());
    assert!(root.join("2026/day/a.png").exists());
}

#[test]
fn explicit_locations_mirror_sources_and_are_protected_while_in_use() {
    let temp = tempfile::tempdir().unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let nas = Location {
        id: "nas".into(),
        kind: "webdav".into(),
        name: "家庭 NAS".into(),
        endpoint: "https://nas.local/dav/".into(),
        root: "photos".into(),
        bucket: None,
        region: None,
        tls_certificate_sha256: None,
        implicit: false,
        created_at: String::new(),
    };
    core.sync_location(&nas).unwrap();
    core.sync_location(&Location {
        name: "NAS".into(),
        ..nas.clone()
    })
    .unwrap();
    let listed = core.locations().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "NAS");
    assert!(!listed[0].implicit);
    let cache = temp.path().join("cache");
    fs::create_dir(&cache).unwrap();
    let library = core.add_library("NAS", &cache).unwrap();
    core.bind_storage(&library.id, "nas", "trips").unwrap();
    assert_eq!(
        core.library(&library.id).unwrap().location_id.as_deref(),
        Some("nas")
    );
    // The superseded implicit location is cleaned up.
    assert_eq!(core.locations().unwrap().len(), 1);
    let asset = core
        .register_remote_asset(&library.id, "trips/a.jpg", "a.jpg", 10)
        .unwrap();
    assert_eq!(asset.key.as_deref(), Some("trips/a.jpg"));
    assert!(core
        .remove_location("nas")
        .unwrap_err()
        .to_string()
        .starts_with("E_IN_USE"));
    assert!(core
        .sync_location(&Location {
            kind: "ftp".into(),
            ..nas
        })
        .is_err());
}

#[test]
fn v6_catalog_upgrades_to_v7_without_touching_marks_or_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("photos");
    photo(&root.join("a.png"));
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core.add_library("旧库", &root).unwrap();
    core.dispatch("library.scan", json!({"library_id":library.id}))
        .unwrap();
    let id = core
        .dispatch("asset.list", json!({"library_id":library.id}))
        .unwrap()["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    core.dispatch("asset.rate", json!({"id":id,"rating":4}))
        .unwrap();
    core.dispatch("asset.flag", json!({"id":id,"flag":"pick"}))
        .unwrap();
    drop(core);
    let database = rusqlite::Connection::open(temp.path().join("catalog/catalog.sqlite3")).unwrap();
    database.execute_batch(V7_DOWNGRADE).unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let version: i64 = database
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 8);
    let asset = core.asset(&id).unwrap();
    assert_eq!((asset.rating, asset.flag.as_str()), (4, "pick"));
    assert_eq!(asset.key.as_deref(), Some("a.png"));
    let library = core.library(&library.id).unwrap();
    let locations = core.locations().unwrap();
    assert_eq!(locations.len(), 1);
    assert!(locations[0].implicit);
    assert_eq!(
        library.location_id.as_deref(),
        Some(locations[0].id.as_str())
    );
}
