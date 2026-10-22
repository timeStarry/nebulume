use std::{collections::BTreeMap, fs, io::Cursor, path::Path};

use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};
use neb_core::{capture_time, Core};
use rusqlite::params;
use serde_json::{json, Value};

fn fields(values: &[(&str, &str)]) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn remote(temp: &Path) -> (Core, String) {
    let root = temp.join("cache");
    fs::create_dir(&root).unwrap();
    let core = Core::open(temp.join("catalog")).unwrap();
    let library = core.add_library("Remote", &root).unwrap();
    core.bind_storage(&library.id, "source", "").unwrap();
    (core, library.id)
}

fn inspection(core: &Core, id: &str, metadata: Value) {
    core.record_remote_inspection(id, &json!({"width":12,"height":8,"metadata":metadata}))
        .unwrap();
}

#[test]
fn version_four_migration_indexes_existing_exif_without_touching_originals_or_edits() {
    let temp = tempfile::tempdir().unwrap();
    let (core, library) = remote(temp.path());
    let known = core
        .register_remote_asset(&library, "known.jpg", "known.jpg", 10)
        .unwrap();
    let pending = core
        .register_remote_asset(&library, "pending.jpg", "pending.jpg", 10)
        .unwrap();
    let invalid = core
        .register_remote_asset(&library, "invalid.jpg", "invalid.jpg", 10)
        .unwrap();
    core.dispatch("asset.rate", json!({"id":known.id,"rating":5}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id":known.id,"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
    )
    .unwrap();
    drop(core);
    let database = rusqlite::Connection::open(temp.path().join("catalog/catalog.sqlite3")).unwrap();
    let metadata = json!({"Captured":"2026-10-02 01:02:03","EXIF DateTimeOriginal":"\"2026:10:02 01:02:03\"","EXIF SubSecTimeOriginal":"\"125\"","EXIF OffsetTimeOriginal":"\"+08:00\"","Lens":"Keep me"});
    for (id, value) in [
        (&known.id, metadata.clone()),
        (&pending.id, json!({"EXIF DateTime":"2025:01:01 00:00:00"})),
        (&invalid.id, json!({"Captured":"2026:02:30 00:00:00"})),
    ] {
        database
            .execute(
                "UPDATE assets SET metadata_json=?1 WHERE id=?2",
                params![value.to_string(), id],
            )
            .unwrap();
    }
    database.execute_batch("DROP INDEX assets_library_key; DROP INDEX libraries_location; ALTER TABLE assets DROP COLUMN key; ALTER TABLE libraries DROP COLUMN location_id; DROP TABLE locations; DROP INDEX assets_library_flag; DROP INDEX assets_library_batch; ALTER TABLE assets DROP COLUMN flag; ALTER TABLE assets DROP COLUMN import_batch_id; ALTER TABLE assets DROP COLUMN sha256; DROP INDEX assets_library_captured; ALTER TABLE assets DROP COLUMN captured_at; ALTER TABLE assets DROP COLUMN captured_at_checked; PRAGMA user_version=4;").unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    assert_eq!(
        database
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        7
    );
    let migrated = core.asset(&known.id).unwrap();
    assert_eq!(migrated.captured_at, "2026-10-02T01:02:03.125000000");
    assert_eq!(migrated.capture_status, "available");
    assert_eq!(migrated.rating, 5);
    assert_eq!(migrated.crop.unwrap().width, 0.5);
    assert_eq!(serde_json::to_value(&migrated.metadata).unwrap(), metadata);
    assert_eq!(core.asset(&pending.id).unwrap().capture_status, "pending");
    assert_eq!(core.asset(&invalid.id).unwrap().capture_status, "missing");
    assert_eq!(
        core.capture_index_candidates(&library)
            .unwrap()
            .iter()
            .map(|asset| asset.id.as_str())
            .collect::<Vec<_>>(),
        vec![pending.id.as_str()]
    );
    assert_eq!(
        core.capture_index_stats(&library).unwrap(),
        json!({"total":3,"known":1,"missing":1,"pending":1})
    );
    assert!(!Path::new(&migrated.path).exists());
}

#[test]
fn capture_publication_is_revision_checked_and_preserves_unrelated_metadata_and_edits() {
    let temp = tempfile::tempdir().unwrap();
    let (core, library) = remote(temp.path());
    let asset = core
        .register_remote_asset(&library, "photo.jpg", "photo.jpg", 10)
        .unwrap();
    let old_stamp = core.asset_fingerprint(&asset.id).unwrap();
    let capture = capture_time::from_metadata(&fields(&[
        ("Captured", "2020:01:01 02:03:04"),
        ("Capture Subsecond", "125"),
        ("Capture Time Zone", "-09:00"),
    ]));
    inspection(
        &core,
        &asset.id,
        json!({"Captured":"2023:01:02 03:04:05","Lens":"Current lens"}),
    );
    assert!(!core
        .record_capture_time(&asset.id, &old_stamp, &capture)
        .unwrap());
    assert_eq!(
        core.asset(&asset.id).unwrap().captured_at,
        "2023-01-02T03:04:05.000000000"
    );
    core.register_remote_asset(&library, "photo.jpg", "new.jpg", 20)
        .unwrap();
    assert_eq!(core.asset(&asset.id).unwrap().capture_status, "pending");
    assert!(!core
        .record_capture_time(&asset.id, &old_stamp, &capture)
        .unwrap());
    let new_stamp = core.asset_fingerprint(&asset.id).unwrap();
    let database = rusqlite::Connection::open(temp.path().join("catalog/catalog.sqlite3")).unwrap();
    database.execute("UPDATE assets SET width=400,height=300,metadata_json=?1 WHERE id=?2",params![json!({"Lens":"Keep lens","Custom field":"Keep value","EXIF DateTimeOriginal":"stale","EXIF SubSecTimeOriginal":"stale","EXIF OffsetTimeOriginal":"stale"}).to_string(),asset.id]).unwrap();
    core.dispatch("asset.rate", json!({"id":asset.id,"rating":4}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id":asset.id,"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
    )
    .unwrap();
    let mut capture = capture;
    capture.metadata.insert("Lens".into(), "Spoofed".into());
    capture
        .metadata
        .insert("Injected".into(), "Must not merge".into());
    assert!(core
        .record_capture_time(&asset.id, &new_stamp, &capture)
        .unwrap());
    let current = core.asset(&asset.id).unwrap();
    assert_eq!(current.captured_at, "2020-01-01T02:03:04.125000000");
    assert_eq!(current.metadata["Capture Time Zone"], "-09:00");
    assert_eq!(current.metadata["Lens"], "Keep lens");
    assert_eq!(current.metadata["Custom field"], "Keep value");
    assert!(!current.metadata.contains_key("Injected"));
    for alias in [
        "EXIF DateTimeOriginal",
        "EXIF SubSecTimeOriginal",
        "EXIF OffsetTimeOriginal",
    ] {
        assert!(!current.metadata.contains_key(alias));
    }
    assert_eq!(current.width, Some(400));
    assert_eq!(current.height, Some(300));
    assert_eq!(current.rating, 4);
    assert_eq!(current.crop.unwrap().width, 0.5);
    assert!(!core
        .record_capture_time(&asset.id, &new_stamp, &capture)
        .unwrap());
    assert!(!core
        .record_capture_time("removed", &new_stamp, &capture)
        .unwrap());
    // A later partial preview without EXIF must not erase a completed index or
    // remove its date from the details panel.
    inspection(
        &core,
        &asset.id,
        json!({"Decoder":"Partial embedded preview"}),
    );
    let previewed = core.asset(&asset.id).unwrap();
    assert_eq!(previewed.captured_at, "2020-01-01T02:03:04.125000000");
    assert_eq!(previewed.capture_status, "available");
    assert_eq!(previewed.metadata["Captured"], "2020:01:01 02:03:04");
    assert_eq!(previewed.metadata["Capture Time Zone"], "-09:00");
    // Same-revision previews with only whole-second EXIF cannot reduce an
    // independently confirmed capture index's precision or replace its offset.
    inspection(
        &core,
        &asset.id,
        json!({"Captured":"2020:01:01 02:03:04","Capture Time Zone":"+08:00"}),
    );
    let partial = core.asset(&asset.id).unwrap();
    assert_eq!(partial.captured_at, "2020-01-01T02:03:04.125000000");
    assert_eq!(partial.metadata["Capture Subsecond"], "125");
    assert_eq!(partial.metadata["Capture Time Zone"], "-09:00");
}

#[test]
fn completed_missing_and_pending_are_distinct_and_never_fall_back_to_file_dates() {
    let temp = tempfile::tempdir().unwrap();
    let (core, library) = remote(temp.path());
    let asset = core
        .register_remote_asset(&library, "no-exif.jpg", "no-exif.jpg", 10)
        .unwrap();
    core.set_remote_created_at(&asset.id, Some("2026-10-17T00:00:00Z"))
        .unwrap();
    inspection(
        &core,
        &asset.id,
        json!({"Decoder":"Preview without capture metadata"}),
    );
    assert_eq!(core.asset(&asset.id).unwrap().capture_status, "pending");
    assert_eq!(core.capture_index_stats(&library).unwrap()["pending"], 1);
    let capture = capture_time::from_metadata(&fields(&[("EXIF DateTime", "2026:01:01 00:00:00")]));
    assert!(core
        .record_capture_time(
            &asset.id,
            &core.asset_fingerprint(&asset.id).unwrap(),
            &capture
        )
        .unwrap());
    let current = core.asset(&asset.id).unwrap();
    assert_eq!(current.captured_at, "");
    assert_eq!(current.capture_status, "missing");
    assert_eq!(
        core.capture_index_stats(&library).unwrap(),
        json!({"total":1,"known":0,"missing":1,"pending":0})
    );
    assert!(core
        .read_local_capture_time(&asset.id)
        .unwrap_err()
        .to_string()
        .contains("E_INVALID"));
}

#[test]
fn default_capture_sort_uses_camera_wall_clock_unknown_last_and_pairs_before_pages() {
    let temp = tempfile::tempdir().unwrap();
    let (core, library) = remote(temp.path());
    core.update_library(&library, None, Some(true), None)
        .unwrap();
    for (name, date, subsec, zone) in [
        ("pair.NEF", "2020:01:01 00:00:00", "", "+14:00"),
        ("pair.JPG", "2022:01:01 00:00:00", "", "+14:00"),
        ("solo.jpg", "2021:01:01 00:00:00", "", "-12:00"),
        ("same-a.jpg", "2022:01:01 00:00:00", "125", "+14:00"),
        ("same-b.jpg", "2022:01:01 00:00:00", "125", "-12:00"),
        ("unknown-a.jpg", "", "", ""),
        ("unknown-b.jpg", "", "", ""),
    ] {
        let asset = core
            .register_remote_asset(&library, name, name, 10)
            .unwrap();
        let mut metadata = serde_json::Map::new();
        for (key, value) in [
            ("Captured", date),
            ("Capture Subsecond", subsec),
            ("Capture Time Zone", zone),
        ] {
            if !value.is_empty() {
                metadata.insert(key.to_owned(), json!(value));
            }
        }
        inspection(&core, &asset.id, Value::Object(metadata));
    }
    let expected = [
        "same-a.jpg",
        "same-b.jpg",
        "pair.JPG",
        "solo.jpg",
        "unknown-a.jpg",
        "unknown-b.jpg",
    ];
    let all = core
        .dispatch("asset.list", json!({"library_id":library}))
        .unwrap();
    assert_eq!(all["file_total"], 7);
    assert_eq!(all["total"], 6);
    assert_eq!(
        all["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["filename"].as_str().unwrap())
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(all["items"][2]["variants"].as_array().unwrap().len(), 2);
    for (offset, filename) in expected.iter().enumerate() {
        let page = core
            .dispatch(
                "asset.list",
                json!({"library_id":library,"offset":offset,"limit":1}),
            )
            .unwrap();
        assert_eq!(page["items"][0]["filename"], *filename);
    }
    let asc = core
        .dispatch(
            "asset.list",
            json!({"library_id":library,"sort_by":"captured_at","sort_direction":"asc"}),
        )
        .unwrap();
    assert_eq!(asc["items"][0]["filename"], "solo.jpg");
    assert_eq!(asc["items"][4]["filename"], "unknown-a.jpg");
}

fn capture_jpeg(path: &Path) {
    let mut jpeg = Cursor::new(Vec::new());
    JpegEncoder::new(&mut jpeg)
        .encode_image(&RgbImage::from_pixel(12, 8, Rgb([90, 140, 190])))
        .unwrap();
    let mut tiff = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
    tiff.extend(1u16.to_le_bytes());
    for value in [0x8769u16, 4] {
        tiff.extend(value.to_le_bytes());
    }
    tiff.extend(1u32.to_le_bytes());
    tiff.extend(26u32.to_le_bytes());
    tiff.extend(0u32.to_le_bytes());
    tiff.extend(3u16.to_le_bytes());
    for (tag, count, value) in [
        (0x9003u16, 20u32, 68u32),
        (0x9291, 4, u32::from_le_bytes(*b"125\0")),
        (0x9011, 7, 88),
    ] {
        tiff.extend(tag.to_le_bytes());
        tiff.extend(2u16.to_le_bytes());
        tiff.extend(count.to_le_bytes());
        tiff.extend(value.to_le_bytes());
    }
    tiff.extend(0u32.to_le_bytes());
    assert_eq!(tiff.len(), 68);
    tiff.extend(b"2026:10:02 01:02:03\0+08:00\0");
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
    bytes.extend(((tiff.len() + 8) as u16).to_be_bytes());
    bytes.extend(b"Exif\0\0");
    bytes.extend(tiff);
    bytes.extend(&jpeg.into_inner()[2..]);
    fs::write(path, bytes).unwrap();
}

#[test]
fn local_scan_and_unchanged_refresh_index_exif_without_redecoding_or_losing_edits() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("photos");
    fs::create_dir(&root).unwrap();
    let path = root.join("photo.jpg");
    capture_jpeg(&path);
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core.add_library("Local", &root).unwrap();
    core.scan(&library.id).unwrap();
    let asset = core
        .dispatch("asset.list", json!({"library_id":library.id}))
        .unwrap()["items"][0]
        .clone();
    let id = asset["id"].as_str().unwrap();
    assert_eq!(asset["captured_at"], "2026-10-02T01:02:03.125000000");
    assert_eq!(
        core.read_local_capture_time(id).unwrap().captured_at,
        "2026-10-02T01:02:03.125000000"
    );
    core.dispatch("asset.rate", json!({"id":id,"rating":3}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id":id,"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
    )
    .unwrap();
    let database = rusqlite::Connection::open(temp.path().join("catalog/catalog.sqlite3")).unwrap();
    database.execute("UPDATE assets SET captured_at='',captured_at_checked=0,width=123,height=456,metadata_json=?1 WHERE id=?2",params![json!({"Custom":"Preserved"}).to_string(),id]).unwrap();
    let refreshed = core.refresh_asset(id).unwrap();
    assert_eq!(refreshed.captured_at, "2026-10-02T01:02:03.125000000");
    assert_eq!(refreshed.capture_status, "available");
    assert_eq!(refreshed.metadata["Custom"], "Preserved");
    assert_eq!(refreshed.width, Some(123));
    assert_eq!(refreshed.height, Some(456));
    assert_eq!(refreshed.rating, 3);
    assert_eq!(refreshed.crop.unwrap().width, 0.5);
}

#[test]
fn unsupported_pixels_can_still_index_capture_and_bounded_read_failure_stays_pending() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("photos");
    fs::create_dir(&root).unwrap();
    let carrier = root.join("carrier.jpg");
    capture_jpeg(&carrier);
    let jpeg = fs::read(&carrier).unwrap();
    let exif_end = 4 + usize::from(u16::from_be_bytes([jpeg[4], jpeg[5]]));
    fs::write(root.join("metadata-only.nef"), &jpeg[12..exif_end]).unwrap();
    fs::write(root.join("broken.nef"), b"II\x2a\x00\xff\xff\xff\x7f").unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core.add_library("Local", &root).unwrap();
    core.scan(&library.id).unwrap();
    let all = core
        .dispatch("asset.list", json!({"library_id":library.id}))
        .unwrap();
    let items = all["items"].as_array().unwrap();
    let metadata = items
        .iter()
        .find(|asset| asset["filename"] == "metadata-only.nef")
        .unwrap();
    assert_eq!(metadata["availability"], "unsupported");
    assert_eq!(metadata["captured_at"], "2026-10-02T01:02:03.125000000");
    let broken = items
        .iter()
        .find(|asset| asset["filename"] == "broken.nef")
        .unwrap();
    assert_eq!(broken["captured_at"], "");
    assert_eq!(broken["capture_status"], "pending");
    assert!(core
        .read_local_capture_time(broken["id"].as_str().unwrap())
        .is_err());
    assert_eq!(
        core.capture_index_stats(&library.id).unwrap(),
        json!({"total":3,"known":2,"missing":0,"pending":1})
    );
}
