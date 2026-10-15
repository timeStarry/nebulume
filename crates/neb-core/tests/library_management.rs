use std::{collections::HashMap, fs};

use neb_core::Core;
use serde_json::{json, Value};

fn list(core: &Core, library: &str, extra: Value) -> Value {
    let mut params = json!({"library_id":library});
    params
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    core.dispatch("asset.list", params).unwrap()
}

#[test]
fn pairing_uses_unfiltered_exact_directory_stem_and_library_before_pagination() {
    let temp = tempfile::tempdir().unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let mut ids = HashMap::new();
    let mut libraries = Vec::new();
    for (number, keys) in [
        vec![
            "A.NEF",
            "A.JPG",
            "solo.jpg",
            "D.NEF",
            "D.ARW",
            "D.jpg",
            "E.NEF",
            "E.jpg",
            "E.jpeg",
            "Case.NEF",
            "case.jpg",
            "other/A.NEF",
            "other/A.jpg",
            "X.NEF",
            "another/X.jpg",
        ],
        vec!["A.NEF", "A.jpg"],
    ]
    .into_iter()
    .enumerate()
    {
        let root = temp.path().join(format!("cache{number}"));
        fs::create_dir(&root).unwrap();
        let library = core
            .add_library_with_options("Paired", &root, true)
            .unwrap();
        core.bind_storage(&library.id, "source", "").unwrap();
        for (index, key) in keys.iter().enumerate() {
            let asset = core
                .register_remote_asset(
                    &library.id,
                    key,
                    &format!("{index}.{}", key.rsplit('.').next().unwrap()),
                    10,
                )
                .unwrap();
            ids.insert((number, key.to_string()), asset.id);
        }
        libraries.push(library.id);
    }
    let result = list(
        &core,
        &libraries[0],
        json!({"sort_by":"filename","sort_direction":"asc"}),
    );
    assert_eq!(result["file_total"], 15);
    assert_eq!(result["total"], 13);
    let items = result["items"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .filter(|item| item.get("variants").is_some())
            .count(),
        2
    );
    for item in items.iter().filter(|item| item.get("variants").is_some()) {
        assert_eq!(item["kind"], "raster");
        assert_eq!(item["variants"][0]["kind"], "raw");
        assert_eq!(item["variants"][1]["kind"], "raster");
    }
    let filenames: Vec<_> = items
        .iter()
        .map(|item| item["filename"].as_str().unwrap())
        .collect();
    assert!(filenames.windows(2).all(|pair| pair[0] <= pair[1]));
    let paged: Vec<_> = (0..13)
        .step_by(3)
        .flat_map(|offset| {
            let page = list(
                &core,
                &libraries[0],
                json!({"sort_by":"filename","sort_direction":"asc","offset":offset,"limit":3}),
            );
            assert_eq!(page["total"], 13);
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].clone())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(
        paged,
        items
            .iter()
            .map(|item| item["id"].clone())
            .collect::<Vec<_>>()
    );
    let raw = list(&core, &libraries[0], json!({"format":"raw"}));
    assert_eq!(raw["file_total"], 7);
    assert_eq!(raw["total"], 7);
    assert!(raw["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["kind"] == "raw"));
    let jpeg = list(&core, &libraries[0], json!({"format":"jpeg"}));
    assert_eq!(jpeg["total"], 8);
    assert_eq!(
        jpeg["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item.get("variants").is_some())
            .count(),
        2
    );
    let searched = list(&core, &libraries[0], json!({"query":"NEF"}));
    assert_eq!(searched["total"], 6);
    assert!(searched["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["extension"] == "nef"));
    // A filter must never turn the ambiguous D/E groups into pairs.
    assert!(searched["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["filename"] == "D.NEF" || item["filename"] == "E.NEF")
        .all(|item| item.get("variants").is_none()));
    core.dispatch(
        "asset.rate",
        json!({"id":ids[&(0,"A.NEF".into())],"rating":5}),
    )
    .unwrap();
    let rated = list(&core, &libraries[0], json!({"rating":4}));
    assert_eq!(rated["total"], 1);
    assert_eq!(rated["items"][0]["filename"], "A.NEF");
    assert_eq!(rated["items"][0]["variants"].as_array().unwrap().len(), 2);
    core.dispatch(
        "asset.rate",
        json!({"id":ids[&(0,"A.JPG".into())],"rating":4}),
    )
    .unwrap();
    let both = list(&core, &libraries[0], json!({"rating":4}));
    assert_eq!(both["file_total"], 2);
    assert_eq!(both["total"], 1);
    assert_eq!(both["items"][0]["filename"], "A.JPG");
    assert_eq!(list(&core, &libraries[1], json!({}))["total"], 1);
    assert_eq!(core.dispatch("asset.list", json!({})).unwrap()["total"], 14);
    core.update_library(&libraries[0], None, Some(false), None)
        .unwrap();
    assert_eq!(list(&core, &libraries[0], json!({}))["total"], 15);
}

#[test]
fn sort_and_filters_apply_to_the_complete_library_before_the_page() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("catalog");
    let root = temp.path().join("cache");
    fs::create_dir(&root).unwrap();
    let core = Core::open(&data).unwrap();
    let library = core.add_library("Sort", &root).unwrap();
    core.bind_storage(&library.id, "source", "").unwrap();
    let database = rusqlite::Connection::open(data.join("catalog.sqlite3")).unwrap();
    for (key, rating, modified) in [
        ("z.jpg", 1, "2026-01-01"),
        ("a.jpg", 3, "2026-01-03"),
        ("m.NEF", 5, "2026-01-02"),
        ("n.jpg", 4, "2026-01-04"),
    ] {
        let asset = core
            .register_remote_asset(&library.id, key, key, 10)
            .unwrap();
        database
            .execute(
                "UPDATE assets SET rating=?1,modified_at=?2 WHERE id=?3",
                rusqlite::params![rating, modified, asset.id],
            )
            .unwrap();
    }
    for (extra, expected) in [
        (
            json!({"sort_by":"filename","sort_direction":"asc"}),
            "m.NEF",
        ),
        (
            json!({"sort_by":"filename","sort_direction":"desc"}),
            "n.jpg",
        ),
        (json!({"sort_by":"rating","sort_direction":"asc"}), "a.jpg"),
        (json!({"sort_by":"rating","sort_direction":"desc"}), "n.jpg"),
        (
            json!({"sort_by":"modified_at","sort_direction":"asc"}),
            "m.NEF",
        ),
        (json!({}), "a.jpg"),
        (
            json!({"format":"jpeg","rating":3,"sort_by":"rating"}),
            "a.jpg",
        ),
    ] {
        let mut query = extra;
        query["offset"] = json!(1);
        query["limit"] = json!(1);
        assert_eq!(
            list(&core, &library.id, query)["items"][0]["filename"],
            expected
        );
    }
    for invalid in [
        json!({"format":"png"}),
        json!({"sort_by":"path;DELETE"}),
        json!({"sort_direction":"sideways"}),
    ] {
        assert!(core
            .dispatch("asset.list", invalid)
            .unwrap_err()
            .to_string()
            .contains("E_INVALID"));
    }
}

#[test]
fn library_updates_are_atomic_preserve_edits_and_never_remove_files() {
    let temp = tempfile::tempdir().unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let occupied = temp.path().join("occupied");
    for dir in [&old, &new, &occupied] {
        fs::create_dir(dir).unwrap();
        fs::write(dir.join("original.jpg"), b"immutable original").unwrap();
    }
    let library = core.add_library("Old", &old).unwrap();
    core.bind_storage(&library.id, "old-source", "").unwrap();
    let asset = core
        .register_remote_asset(&library.id, "original.jpg", "original.jpg", 18)
        .unwrap();
    core.dispatch("asset.rate", json!({"id":asset.id,"rating":5}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id":asset.id,"x":0.1,"y":0.2,"width":0.5,"height":0.5}),
    )
    .unwrap();
    let renamed = core
        .update_library(
            &library.id,
            Some("Renamed"),
            Some(true),
            Some((&old, "old-source", "")),
        )
        .unwrap();
    assert_eq!(renamed.name, "Renamed");
    assert!(renamed.pair_raw_jpeg);
    assert_eq!(core.asset(&asset.id).unwrap().rating, 5);
    assert!(core.asset(&asset.id).unwrap().crop.is_some());
    core.add_library("Occupied", &occupied).unwrap();
    assert!(core
        .update_library(
            &library.id,
            Some("Must rollback"),
            Some(false),
            Some((&occupied, "new-source", ""))
        )
        .unwrap_err()
        .to_string()
        .contains("E_CONFLICT"));
    assert_eq!(core.library(&library.id).unwrap().name, "Renamed");
    assert_eq!(core.asset(&asset.id).unwrap().rating, 5);
    core.update_library(&library.id, None, None, Some((&new, "new-source", "album")))
        .unwrap();
    assert!(core.asset(&asset.id).is_err());
    assert_eq!(
        list(&core, &library.id, json!({"query":"original"}))["total"],
        0
    );
    let replacement = core
        .register_remote_asset(&library.id, "album/original.jpg", "original.jpg", 18)
        .unwrap();
    assert_eq!(replacement.rating, 0);
    assert!(replacement.crop.is_none());
    assert_eq!(core.remove_library(&library.id).unwrap(), 1);
    assert!(core.library(&library.id).is_err());
    assert!(core.asset(&replacement.id).is_err());
    for dir in [&old, &new, &occupied] {
        assert_eq!(
            fs::read(dir.join("original.jpg")).unwrap(),
            b"immutable original"
        );
    }
}

#[test]
fn version_two_catalog_migrates_pair_setting_without_changing_existing_assets() {
    let temp = tempfile::tempdir().unwrap();
    let database = rusqlite::Connection::open(temp.path().join("catalog.sqlite3")).unwrap();
    database
        .execute_batch(include_str!("../src/schema.sql"))
        .unwrap();
    database.execute_batch("ALTER TABLE libraries ADD COLUMN storage_id TEXT; ALTER TABLE libraries ADD COLUMN source_prefix TEXT NOT NULL DEFAULT ''; ALTER TABLE libraries ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0; ALTER TABLE assets ADD COLUMN source_key TEXT; CREATE UNIQUE INDEX assets_remote_key ON assets(library_id,source_key) WHERE source_key IS NOT NULL; PRAGMA user_version=2;").unwrap();
    database.execute("INSERT INTO libraries(id,name,root,root_key,created_at,storage_id,source_prefix) VALUES('old','Old','unused','unused','2026','source','album')",[]).unwrap();
    database.execute("INSERT INTO assets(id,library_id,path,path_key,filename,extension,kind,size,modified_at,modified_stamp,rating,crop_json,availability,source_key) VALUES('photo','old','unused/photo.nef','unused/photo.nef','photo.nef','nef','raw',10,'2026','old-stamp',5,'{\"x\":0.0,\"y\":0.0,\"width\":0.5,\"height\":1.0}','remote','album/photo.nef')",[]).unwrap();
    let core = Core::open(temp.path()).unwrap();
    let library = core.library("old").unwrap();
    assert!(!library.pair_raw_jpeg);
    assert_eq!(library.storage_id.as_deref(), Some("source"));
    assert_eq!(library.source_prefix, "album");
    assert_eq!(core.asset("photo").unwrap().rating, 5);
    assert_eq!(core.asset("photo").unwrap().crop.unwrap().width, 0.5);
    assert_eq!(
        database
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        3
    );
    core.update_library("old", None, Some(true), None).unwrap();
    drop(core);
    assert!(
        Core::open(temp.path())
            .unwrap()
            .library("old")
            .unwrap()
            .pair_raw_jpeg
    );
}
