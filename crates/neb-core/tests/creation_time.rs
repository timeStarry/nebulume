use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

use chrono::{DateTime, SecondsFormat, Utc};
use neb_core::Core;
use rusqlite::params;
use serde_json::{json, Value};

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

fn source_created(path: &Path) -> String {
    fs::metadata(path)
        .unwrap()
        .created()
        .ok()
        .map(|value| DateTime::<Utc>::from(value).to_rfc3339_opts(SecondsFormat::Nanos, true))
        .unwrap_or_default()
}

fn list(core: &Core, library: &str, direction: &str, offset: usize, limit: usize) -> Value {
    core.dispatch(
        "asset.list",
        json!({
            "library_id":library,"sort_by":"created_at","sort_direction":direction,
            "offset":offset,"limit":limit,
        }),
    )
    .unwrap()
}

#[test]
fn local_scan_and_refresh_use_source_birth_without_changing_identity_or_edits() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("photos");
    fs::create_dir(&root).unwrap();
    let path = root.join("original.ppm");
    fs::write(&path, PHOTO).unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(
            fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(42)),
        )
        .unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core.add_library("Local", &root).unwrap();
    core.scan(&library.id).unwrap();
    let item = list(&core, &library.id, "asc", 0, 20)["items"][0].clone();
    assert_eq!(item["created_at"], source_created(&path));
    assert_ne!(item["created_at"], item["modified_at"]);
    let id = item["id"].as_str().unwrap();
    core.dispatch("asset.rate", json!({"id":id,"rating":4}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id":id,"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
    )
    .unwrap();
    let refreshed = core.refresh_asset(id).unwrap();
    assert_eq!(refreshed.id, id);
    assert_eq!(refreshed.created_at, source_created(&path));
    assert_eq!(refreshed.rating, 4);
    assert_eq!(refreshed.crop.unwrap().width, 0.5);
    assert!(core
        .set_remote_created_at(id, Some("2020-01-01T00:00:00Z"))
        .unwrap_err()
        .to_string()
        .contains("E_INVALID"));
}

#[test]
fn version_three_migration_backfills_once_and_preserves_user_edits() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("catalog");
    let root = temp.path().join("photos");
    fs::create_dir(&root).unwrap();
    let path = root.join("original.ppm");
    fs::write(&path, PHOTO).unwrap();
    let core = Core::open(&data).unwrap();
    let library = core.add_library("Local", &root).unwrap();
    let asset = core.open_file(&path).unwrap();
    core.dispatch("asset.rate", json!({"id":asset.id,"rating":5}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id":asset.id,"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
    )
    .unwrap();
    drop(core);
    let database = rusqlite::Connection::open(data.join("catalog.sqlite3")).unwrap();
    database.execute_batch("DROP INDEX assets_library_captured; ALTER TABLE assets DROP COLUMN captured_at; ALTER TABLE assets DROP COLUMN captured_at_checked; DROP INDEX assets_library_created; ALTER TABLE assets DROP COLUMN created_at; ALTER TABLE assets DROP COLUMN created_at_checked; PRAGMA user_version=3;").unwrap();
    let core = Core::open(&data).unwrap();
    assert_eq!(
        database
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(core.asset(&asset.id).unwrap().created_at, "");
    let first = list(&core, &library.id, "asc", 0, 20);
    assert_eq!(first["items"][0]["created_at"], source_created(&path));
    assert_eq!(first["items"][0]["rating"], 5);
    assert_eq!(first["items"][0]["crop"]["width"], 0.5);
    // A temporary missing file is recorded as unknown. Restoring it must not
    // cause metadata probes on every subsequent page request.
    database
        .execute(
            "UPDATE assets SET created_at='',created_at_checked=0 WHERE id=?1",
            [&asset.id],
        )
        .unwrap();
    let hidden = root.join("original.offline");
    fs::rename(&path, &hidden).unwrap();
    assert_eq!(
        list(&core, &library.id, "asc", 0, 20)["items"][0]["created_at"],
        ""
    );
    fs::rename(&hidden, &path).unwrap();
    drop(core);
    let core = Core::open(&data).unwrap();
    assert_eq!(
        list(&core, &library.id, "desc", 0, 20)["items"][0]["created_at"],
        ""
    );
    let refreshed = core.refresh_asset(&asset.id).unwrap();
    assert_eq!(refreshed.created_at, source_created(&path));
    assert_eq!(refreshed.rating, 5);
    assert_eq!(refreshed.crop.unwrap().width, 0.5);
}

#[test]
fn creation_sort_is_global_stable_and_keeps_unknown_last_before_pagination() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("cache");
    fs::create_dir(&root).unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core.add_library("Remote", &root).unwrap();
    core.bind_storage(&library.id, "remote", "").unwrap();
    for (name, created) in [
        ("z.ppm", Some("2026-01-02T01:00:00+01:00")),
        ("a.ppm", Some("2026-01-01T00:00:00Z")),
        ("same-b.ppm", Some("2026-01-02T00:00:00Z")),
        ("unknown-b.ppm", None),
        ("unknown-a.ppm", None),
    ] {
        let asset = core
            .register_remote_asset(&library.id, name, name, PHOTO.len() as u64)
            .unwrap();
        core.set_remote_created_at(&asset.id, created).unwrap();
    }
    for (direction, expected) in [
        (
            "asc",
            vec![
                "a.ppm",
                "same-b.ppm",
                "z.ppm",
                "unknown-a.ppm",
                "unknown-b.ppm",
            ],
        ),
        (
            "desc",
            vec![
                "same-b.ppm",
                "z.ppm",
                "a.ppm",
                "unknown-a.ppm",
                "unknown-b.ppm",
            ],
        ),
    ] {
        let all = list(&core, &library.id, direction, 0, 20);
        let names: Vec<_> = all["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["filename"].as_str().unwrap())
            .collect();
        assert_eq!(names, expected);
        let paged: Vec<_> = (0..5)
            .map(|offset| {
                list(&core, &library.id, direction, offset, 1)["items"][0]["filename"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(paged, expected);
    }
    let asset = list(&core, &library.id, "asc", 0, 20)["items"][2].clone();
    let id = asset["id"].as_str().unwrap();
    assert_eq!(asset["created_at"], "2026-01-02T00:00:00.000000000Z");
    fs::write(asset["path"].as_str().unwrap(), PHOTO).unwrap();
    assert_eq!(
        core.refresh_asset(id).unwrap().created_at,
        "2026-01-02T00:00:00.000000000Z"
    );
    assert!(core
        .set_remote_created_at(id, Some("not-a-date"))
        .unwrap_err()
        .to_string()
        .contains("E_INVALID"));
    assert_eq!(
        core.asset(id).unwrap().created_at,
        "2026-01-02T00:00:00.000000000Z"
    );
    core.set_remote_created_at(id, None).unwrap();
    assert_eq!(core.asset(id).unwrap().created_at, "");
}

#[test]
fn creation_sort_respects_pair_representatives_before_paging() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("cache");
    fs::create_dir(&root).unwrap();
    let data = temp.path().join("catalog");
    let core = Core::open(&data).unwrap();
    let library = core.add_library_with_options("Pairs", &root, true).unwrap();
    core.bind_storage(&library.id, "remote", "").unwrap();
    for (name, created) in [
        ("pair.NEF", Some("2020-01-01T00:00:00Z")),
        ("pair.JPG", Some("2022-01-01T00:00:00Z")),
        ("solo.jpg", Some("2021-01-01T00:00:00Z")),
        ("unknown.jpg", None),
    ] {
        let asset = core
            .register_remote_asset(&library.id, name, name, 10)
            .unwrap();
        core.set_remote_created_at(&asset.id, created).unwrap();
    }
    let all = list(&core, &library.id, "asc", 0, 20);
    assert_eq!(all["file_total"], 4);
    assert_eq!(all["total"], 3);
    assert_eq!(all["items"][0]["filename"], "solo.jpg");
    assert_eq!(all["items"][1]["filename"], "pair.JPG");
    assert_eq!(all["items"][1]["variants"].as_array().unwrap().len(), 2);
    assert_eq!(
        list(&core, &library.id, "asc", 1, 1)["items"][0]["filename"],
        "pair.JPG"
    );
    let database = rusqlite::Connection::open(data.join("catalog.sqlite3")).unwrap();
    assert_eq!(
        database
            .query_row(
                "SELECT COUNT(*) FROM assets WHERE source_key IS NOT NULL AND created_at_checked=1",
                params![],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
        4
    );
}
