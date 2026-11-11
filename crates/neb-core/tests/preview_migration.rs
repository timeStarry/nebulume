use image::RgbImage;
use neb_core::Core;
use rusqlite::{params, Connection};
use serde_json::json;
use std::fs;

// Versions 9/10 shipped by the preview branch had a different migration
// history. Build the common schema8 base, then apply those original additive
// migrations (including the preview search triggers and foreign keys).
fn preview_fixture(version: i64) -> (tempfile::TempDir, String, String) {
    let temp = tempfile::tempdir().unwrap();
    let photos = temp.path().join("photos");
    fs::create_dir(&photos).unwrap();
    RgbImage::new(12, 8).save(photos.join("photo.png")).unwrap();
    let data = temp.path().join("catalog");
    let core = Core::open(&data).unwrap();
    let library = core.add_library("Preview library", &photos).unwrap();
    core.scan(&library.id).unwrap();
    let asset = core.dispatch("asset.list", json!({})).unwrap()["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    core.dispatch("asset.rate", json!({"id":asset,"rating":4}))
        .unwrap();
    core.dispatch("asset.flag", json!({"id":asset,"flag":"pick"}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id":asset,"x":0.1,"y":0.1,"width":0.8,"height":0.8}),
    )
    .unwrap();
    drop(core);
    let db = Connection::open(data.join("catalog.sqlite3")).unwrap();
    db.execute_batch(
        "DROP TRIGGER assets_revision_insert; DROP TRIGGER assets_revision_update;
         DROP TRIGGER assets_revision_delete; DROP TRIGGER libraries_revision_insert;
         DROP TRIGGER libraries_revision_update; DROP TRIGGER libraries_revision_delete;
         DROP TABLE catalog_revision; DROP INDEX assets_quick_hash;
         ALTER TABLE assets DROP COLUMN quick_hash;
         ALTER TABLE assets DROP COLUMN trashed_at;
         ALTER TABLE assets DROP COLUMN trash_path;
         ALTER TABLE import_presets ADD COLUMN existing_file_policy TEXT NOT NULL DEFAULT 'rename' CHECK(existing_file_policy IN ('skip','rename'));
         ALTER TABLE import_presets ADD COLUMN options_version INTEGER NOT NULL DEFAULT 0 CHECK(options_version>=0);
         ALTER TABLE import_batches ADD COLUMN existing INTEGER NOT NULL DEFAULT 0 CHECK(existing>=0);
         PRAGMA user_version=9;"
    ).unwrap();
    db.execute("INSERT INTO import_presets(id,name,library_id,rules_json,deduplicate,created_at,existing_file_policy,options_version) VALUES('preset','Keep me',?1,'{}',0,'2026-10-25','skip',1)",params![library.id]).unwrap();
    db.execute("INSERT INTO import_batches(id,library_id,source,rules_json,started_at,status,copied,duplicates,failed,existing) VALUES('batch',?1,'fixture','{}','2026-10-25','completed',2,3,4,5)", params![library.id]).unwrap();
    db.execute("UPDATE assets SET import_batch_id='batch',sha256='original-content-hash',metadata_json=?1 WHERE id=?2", params![r#"{"Camera":"Unknown fixture camera"}"#,asset]).unwrap();
    if version >= 10 {
        db.execute_batch(include_str!("fixtures/preview-search-schema.sql"))
            .unwrap();
        db.execute("INSERT INTO asset_search(asset_id,revision,checked,camera) VALUES(?1,'preview-revision',1,'Fixture camera')",params![asset]).unwrap();
    }
    if version == 11 {
        // The affected formal release stamped 11 without repairing 9/10.
        db.execute_batch("ALTER TABLE assets ADD COLUMN trashed_at TEXT; ALTER TABLE assets ADD COLUMN trash_path TEXT; PRAGMA user_version=11;").unwrap();
    }
    (temp, library.id, asset)
}

fn original_records(db: &Connection) -> Vec<String> {
    // Include every original column, including preview-only options/index rows.
    let mut values = vec![];
    for (table, except) in [
        ("assets", vec!["quick_hash", "trashed_at", "trash_path"]),
        ("libraries", vec![]),
        ("import_presets", vec![]),
        ("import_batches", vec![]),
        ("asset_search", vec![]),
    ] {
        let columns: Vec<String> = db
            .prepare("SELECT name FROM pragma_table_info(?1)")
            .unwrap()
            .query_map([table], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .filter(|c| !except.contains(&c.as_str()))
            .collect();
        if columns.is_empty() {
            continue;
        }
        let expressions = columns
            .iter()
            .map(|c| format!("quote(\"{c}\")"))
            .collect::<Vec<_>>()
            .join("||','||");
        let mut stmt = db
            .prepare(&format!("SELECT {expressions} FROM {table} ORDER BY 1"))
            .unwrap();
        values.extend(
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap),
        );
    }
    values
}

fn check_migration(version: i64) {
    let (temp, library, asset) = preview_fixture(version);
    let data = temp.path().join("catalog");
    let db = Connection::open(data.join("catalog.sqlite3")).unwrap();
    let before = original_records(&db);
    for _ in 0..2 {
        let core = Core::open(&data).unwrap();
        assert_eq!(core.dispatch("asset.list", json!({})).unwrap()["total"], 1);
        assert_eq!(
            core.dispatch("asset.get", json!({"id":asset})).unwrap()["rating"],
            4
        );
        assert_eq!(original_records(&db), before);
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            12
        );
        assert_eq!(
            db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert!(db
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query([])
            .unwrap()
            .next()
            .unwrap()
            .is_none());
    }
    // Exercise both previously broken paths and ensure rename matching preserves
    // edits and identity when the repaired quick-hash column is used by scanning.
    let core = Core::open(&data).unwrap();
    core.scan(&library).unwrap();
    fs::rename(
        temp.path().join("photos/photo.png"),
        temp.path().join("photos/moved.png"),
    )
    .unwrap();
    core.scan(&library).unwrap();
    let list = core.dispatch("asset.list", json!({})).unwrap();
    assert_eq!(list["total"], 1);
    assert_eq!(list["items"][0]["id"], asset);
    assert_eq!(list["items"][0]["rating"], 4);
    assert_eq!(list["items"][0]["flag"], "pick");
}

#[test]
fn preview_schema9_keeps_edits_and_import_options() {
    check_migration(9);
}
#[test]
fn preview_schema10_keeps_search_rows_and_bindings() {
    check_migration(10);
}
#[test]
fn affected_formal_schema11_is_repaired() {
    check_migration(11);
}

#[test]
fn preview_repair_keeps_an_existing_revision_counter_and_installs_missing_triggers() {
    let (temp, _, _) = preview_fixture(11);
    let data = temp.path().join("catalog");
    let db = Connection::open(data.join("catalog.sqlite3")).unwrap();
    db.execute_batch("CREATE TABLE catalog_revision(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL); INSERT INTO catalog_revision VALUES(1,123);").unwrap();
    drop(Core::open(&data).unwrap());
    assert_eq!(
        db.query_row("SELECT value FROM catalog_revision WHERE id=1", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        123
    );
    db.execute("UPDATE assets SET rating=5", []).unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM catalog_revision WHERE id=1", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        124
    );
}

fn schema(db: &Connection) -> Vec<(String, String)> {
    db.prepare("SELECT name,coalesce(sql,'') FROM sqlite_master ORDER BY name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn failed_preview_repair_rolls_back_schema_and_records() {
    let (temp, _, _) = preview_fixture(10);
    let data = temp.path().join("catalog");
    let db = Connection::open(data.join("catalog.sqlite3")).unwrap();
    // Force failure after ALTER TABLE, to prove atomic rollback rather than
    // merely rejecting before migration begins.
    db.execute_batch("CREATE TABLE assets_quick_hash(keep TEXT);")
        .unwrap();
    let before_schema = schema(&db);
    let before_records = original_records(&db);
    assert!(Core::open(&data).is_err());
    assert_eq!(schema(&db), before_schema);
    assert_eq!(original_records(&db), before_records);
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
    db.execute_batch("DROP TABLE assets_quick_hash;").unwrap();
    assert!(Core::open(&data).is_ok());
}

#[test]
fn unknown_or_newer_catalogs_are_rejected_without_relabeling() {
    for version in [10, 12, 13] {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("catalog");
        fs::create_dir(&data).unwrap();
        let db = Connection::open(data.join("catalog.sqlite3")).unwrap();
        db.execute_batch(&format!(
            "CREATE TABLE assets(id TEXT); PRAGMA user_version={version};"
        ))
        .unwrap();
        let before = schema(&db);
        let error = Core::open(&data).err().unwrap();
        assert!(error.to_string().starts_with("E_SCHEMA:"));
        assert_eq!(schema(&db), before);
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            version
        );
    }
}

#[test]
fn formal_schema11_upgrades_without_rewriting_user_data() {
    let (temp, _, _) = preview_fixture(10);
    let data = temp.path().join("catalog");
    // First converge, then emulate a complete formal11 catalog. The extra
    // preview tables here must remain untouched just as on repaired catalogs.
    drop(Core::open(&data).unwrap());
    let db = Connection::open(data.join("catalog.sqlite3")).unwrap();
    db.execute_batch("PRAGMA user_version=11;").unwrap();
    let before = original_records(&db);
    drop(Core::open(&data).unwrap());
    assert_eq!(original_records(&db), before);
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        12
    );
}

#[test]
fn current_schema_with_missing_trash_columns_is_rejected_before_commit() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("catalog");
    drop(Core::open(&data).unwrap());
    let db = Connection::open(data.join("catalog.sqlite3")).unwrap();
    db.execute_batch("ALTER TABLE assets DROP COLUMN trash_path;")
        .unwrap();
    let before = schema(&db);
    assert!(Core::open(&data)
        .err()
        .unwrap()
        .to_string()
        .starts_with("E_SCHEMA:"));
    assert_eq!(schema(&db), before);
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        12
    );
}
