use std::{fs, io::Cursor, path::Path};

use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};
use neb_core::Core;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn setup() -> (TempDir, Core, std::path::PathBuf, String) {
    let temp = tempfile::tempdir().unwrap();
    let photos = temp.path().join("photos");
    fs::create_dir(&photos).unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core
        .dispatch("library.add", json!({"name":"旅行照片", "root":photos}))
        .unwrap();
    (
        temp,
        core,
        photos,
        library["id"].as_str().unwrap().to_owned(),
    )
}

fn png(path: &Path, width: u32, height: u32) {
    RgbImage::from_fn(width, height, |x, y| {
        Rgb([(x * 23) as u8, (y * 37) as u8, 180])
    })
    .save(path)
    .unwrap();
}

fn scan(core: &Core, library: &str) -> Value {
    core.dispatch("library.scan", json!({"library_id":library}))
        .unwrap()
}

fn only_asset(core: &Core) -> Value {
    let list = core.dispatch("asset.list", json!({})).unwrap();
    assert_eq!(list["total"], 1);
    list["items"][0].clone()
}

fn digest(path: &Path) -> Vec<u8> {
    Sha256::digest(fs::read(path).unwrap()).to_vec()
}

#[test]
fn standalone_open_indexes_only_requested_file_and_does_not_create_a_visible_library() {
    let temp = tempfile::tempdir().unwrap();
    let photos = temp.path().join("opened");
    fs::create_dir(&photos).unwrap();
    png(&photos.join("first.png"), 12, 8);
    png(&photos.join("sibling.png"), 20, 10);
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let asset = core.open_file(&photos.join("first.png")).unwrap();
    assert_eq!(asset.filename, "first.png");
    assert!(core.libraries().unwrap().is_empty());
    assert_eq!(core.dispatch("asset.list", json!({})).unwrap()["total"], 0);
    assert_eq!(
        core.dispatch("asset.list", json!({"library_id":asset.library_id}))
            .unwrap()["total"],
        1
    );
    let visible = core.add_library("正式图片库", &photos).unwrap();
    assert!(!visible.hidden);
    assert_eq!(core.libraries().unwrap().len(), 1);
    assert_eq!(core.dispatch("asset.list", json!({})).unwrap()["total"], 1);
    assert_eq!(
        core.open_file(&photos.join("first.png")).unwrap().id,
        asset.id
    );
}

#[test]
fn version_one_catalog_migrates_with_ratings_and_recipes_intact() {
    let temp = tempfile::tempdir().unwrap();
    let photos = temp.path().join("photos");
    let data = temp.path().join("catalog");
    fs::create_dir_all(&photos).unwrap();
    fs::create_dir_all(&data).unwrap();
    png(&photos.join("old.png"), 6, 4);
    let connection = rusqlite::Connection::open(data.join("catalog.sqlite3")).unwrap();
    connection
        .execute_batch(include_str!("../src/schema.sql"))
        .unwrap();
    let old_root = dunce::canonicalize(&photos)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let root_key = if cfg!(windows) {
        old_root.to_lowercase()
    } else {
        old_root.clone()
    };
    connection.execute("INSERT INTO libraries(id,name,root,root_key,created_at) VALUES('old','旧图库',?1,?2,'2026-10-14')",rusqlite::params![old_root,root_key]).unwrap();
    let original = dunce::canonicalize(photos.join("old.png")).unwrap();
    let original = original.to_string_lossy().into_owned();
    let path_key = if cfg!(windows) {
        original.to_lowercase()
    } else {
        original.clone()
    };
    connection.execute("INSERT INTO assets(id,library_id,path,path_key,filename,extension,kind,size,modified_at,modified_stamp,rating,metadata_json,crop_json,availability) VALUES('old-asset','old',?1,?2,'old.png','png','raster',1,'2026-10-14','legacy',4,'{}','{\"x\":0.25,\"y\":0.0,\"width\":0.5,\"height\":1.0}','available')",rusqlite::params![original,path_key]).unwrap();
    drop(connection);
    let core = Core::open(&data).unwrap();
    assert_eq!(core.libraries().unwrap()[0].id, "old");
    assert_eq!(only_asset(&core)["rating"], 4);
    assert_eq!(only_asset(&core)["crop"]["width"], 0.5);
    core.scan("old").unwrap();
    let asset = only_asset(&core);
    core.dispatch("asset.rate", json!({"id":asset["id"],"rating":5}))
        .unwrap();
    drop(core);
    let reopened = Core::open(&data).unwrap();
    assert_eq!(only_asset(&reopened)["rating"], 5);
    assert_eq!(reopened.libraries().unwrap()[0].source_prefix, "");
}

#[test]
fn remote_keys_keep_asset_identity_and_edits_when_cache_revision_changes() {
    let temp = tempfile::tempdir().unwrap();
    let cache = temp.path().join("cache");
    fs::create_dir(&cache).unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core.add_library("远端图片库", &cache).unwrap();
    core.bind_storage(&library.id, "source", "album").unwrap();
    let first = core
        .register_remote_asset(&library.id, "album/photo.png", "revision1.png", 42)
        .unwrap();
    assert_eq!(first.availability, "remote");
    assert!(first.modified_at.is_empty());
    core.dispatch("asset.rate", json!({"id":first.id,"rating":4}))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({"id":first.id,"x":0.25,"y":0.0,"width":0.5,"height":1.0}),
    )
    .unwrap();
    let changed = core
        .register_remote_asset(&library.id, "album/photo.png", "revision2.png", 60)
        .unwrap();
    assert_eq!(changed.id, first.id);
    assert_eq!(changed.rating, 4);
    assert_eq!(changed.crop.unwrap().width, 0.5);
    assert!(changed.path.ends_with("revision2.png"));
    core.finish_remote_scan(&library.id, &[]).unwrap();
    assert_eq!(core.asset(&first.id).unwrap().availability, "missing");
    core.register_remote_asset(&library.id, "album/photo.png", "revision2.png", 60)
        .unwrap();
    assert_eq!(core.asset(&first.id).unwrap().availability, "remote");
}

#[test]
fn simultaneous_catalog_initialization_keeps_one_complete_schema() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("catalog");
    // Initialize WAL before the race to focus this regression on schema locking.
    fs::create_dir_all(&data).unwrap();
    let database = rusqlite::Connection::open(data.join("catalog.sqlite3")).unwrap();
    database.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    drop(database);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let threads = (0..4)
        .map(|_| {
            let data = data.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Core::open(data).unwrap()
            })
        })
        .collect::<Vec<_>>();
    for thread in threads {
        let core = thread.join().unwrap();
        assert!(core.libraries().unwrap().is_empty());
    }
    let reopened = Core::open(&data).unwrap();
    assert!(reopened.libraries().unwrap().is_empty());
    let database = rusqlite::Connection::open(data.join("catalog.sqlite3")).unwrap();
    assert_eq!(
        database
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        6
    );
}

#[test]
fn catalog_persists_search_ratings_and_crops_across_incremental_scans() {
    let (temp, core, photos, library) = setup();
    let original = photos.join("Harbor sunrise.png");
    png(&original, 12, 8);
    let original_hash = digest(&original);
    assert_eq!(scan(&core, &library)["indexed"], 1);
    let asset = only_asset(&core);
    let id = asset["id"].as_str().unwrap();
    core.dispatch("asset.rate", json!({"id":id,"rating":4}))
        .unwrap();
    let recipe = json!({"id":id,"x":0.25,"y":0.0,"width":0.5,"height":1.0});
    core.dispatch("asset.crop", recipe).unwrap();
    assert_eq!(scan(&core, &library)["skipped"], 1);
    let search = core
        .dispatch("asset.list", json!({"query":"Harb","rating":4}))
        .unwrap();
    assert_eq!(search["total"], 1);
    assert_eq!(search["items"][0]["id"], id);
    assert_eq!(search["items"][0]["crop"]["width"], 0.5);
    assert_eq!(digest(&original), original_hash);
    drop(core);
    let reopened = Core::open(temp.path().join("catalog")).unwrap();
    assert_eq!(only_asset(&reopened)["rating"], 4);
    assert_eq!(only_asset(&reopened)["crop"]["x"], 0.25);
    // Changed content updates searchable metadata, preserving the user's recipe.
    png(&original, 14, 9);
    scan(&reopened, &library);
    let refreshed = only_asset(&reopened);
    assert_eq!(refreshed["id"], id);
    assert_eq!(refreshed["width"], 14);
    assert_eq!(refreshed["rating"], 4);
    assert_eq!(refreshed["crop"]["width"], 0.5);
}

#[test]
fn crop_export_is_new_file_and_never_changes_original_or_existing_export() {
    let (_temp, core, photos, library) = setup();
    let original = photos.join("original.jpg");
    png(&original.with_extension("png"), 12, 8);
    // Keep one catalog asset while using a genuine JPEG source.
    image::open(original.with_extension("png"))
        .unwrap()
        .save(&original)
        .unwrap();
    fs::remove_file(original.with_extension("png")).unwrap();
    let before = digest(&original);
    scan(&core, &library);
    let asset = only_asset(&core);
    let id = &asset["id"];
    core.dispatch(
        "asset.crop",
        json!({"id":id,"x":0.25,"y":0.25,"width":0.5,"height":0.5}),
    )
    .unwrap();
    let cropped = core.dispatch("asset.preview", json!({"id":id})).unwrap();
    let full = core
        .dispatch("asset.preview", json!({"id":id,"uncropped":true}))
        .unwrap();
    assert_eq!(
        (cropped["width"].as_u64(), cropped["height"].as_u64()),
        (Some(6), Some(4))
    );
    assert_eq!(
        (full["width"].as_u64(), full["height"].as_u64()),
        (Some(12), Some(8))
    );
    let cropped_again = core.dispatch("asset.preview", json!({"id":id})).unwrap();
    assert_eq!(cropped_again["data_url"], cropped["data_url"]);
    let exported = photos.join("export.jpg");
    core.dispatch("asset.export", json!({"id":id,"destination":exported}))
        .unwrap();
    assert_eq!(image::image_dimensions(&exported).unwrap(), (6, 4));
    let exported_hash = digest(&exported);
    assert!(core
        .dispatch("asset.export", json!({"id":id,"destination":exported}))
        .unwrap_err()
        .to_string()
        .contains("E_EXISTS"));
    assert!(core
        .dispatch("asset.export", json!({"id":id,"destination":original}))
        .is_err());
    assert_eq!(digest(&original), before);
    assert_eq!(digest(&exported), exported_hash);
    assert_eq!(
        core.dispatch("asset.reset_crop", json!({"id":id})).unwrap()["crop"],
        Value::Null
    );
}

#[test]
fn simultaneous_exports_have_one_atomic_winner() {
    let (_temp, core, photos, library) = setup();
    png(&photos.join("race.png"), 80, 60);
    scan(&core, &library);
    let id = only_asset(&core)["id"].as_str().unwrap().to_owned();
    let core = std::sync::Arc::new(core);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let destination = photos.join("one-winner.jpg");
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let (core, barrier, id, destination) = (
                core.clone(),
                barrier.clone(),
                id.clone(),
                destination.clone(),
            );
            std::thread::spawn(move || {
                barrier.wait();
                core.dispatch("asset.export", json!({"id":id,"destination":destination}))
                    .is_ok()
            })
        })
        .collect();
    let winners = handles
        .into_iter()
        .map(|handle| u32::from(handle.join().unwrap()))
        .sum::<u32>();
    assert_eq!(winners, 1);
    assert_eq!(image::image_dimensions(destination).unwrap(), (80, 60));
}

#[test]
fn missing_and_corrupt_files_remain_in_catalog_with_edits() {
    let (_temp, core, photos, library) = setup();
    let original = photos.join("offline.png");
    png(&original, 8, 6);
    scan(&core, &library);
    let asset = only_asset(&core);
    core.dispatch("asset.rate", json!({"id":asset["id"],"rating":5}))
        .unwrap();
    fs::remove_file(&original).unwrap();
    scan(&core, &library);
    assert_eq!(only_asset(&core)["availability"], "missing");
    assert!(core
        .dispatch("asset.preview", json!({"id":asset["id"]}))
        .is_err());
    fs::write(&original, b"not a PNG").unwrap();
    let report = scan(&core, &library);
    assert_eq!(report["errors"].as_array().unwrap().len(), 1);
    let corrupt = only_asset(&core);
    assert_eq!(corrupt["id"], asset["id"]);
    assert_eq!(corrupt["rating"], 5);
    assert_eq!(corrupt["availability"], "unsupported");
    png(&original, 8, 6);
    scan(&core, &library);
    assert_eq!(only_asset(&core)["availability"], "available");
    assert_eq!(only_asset(&core)["rating"], 5);
}

#[test]
fn histogram_counts_actual_rendered_pixels() {
    let (_temp, core, photos, library) = setup();
    let pixels = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
    RgbImage::from_fn(4, 1, |x, _| Rgb(pixels[x as usize]))
        .save(photos.join("colors.png"))
        .unwrap();
    scan(&core, &library);
    let asset = only_asset(&core);
    let hist = core
        .dispatch("asset.histogram", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(hist["pixels"], 4);
    assert_eq!(hist["red"][255], 2);
    assert_eq!(hist["green"][0], 2);
    assert_eq!(hist["blue"][255], 2);
    for channel in ["red", "green", "blue", "luminance"] {
        assert_eq!(
            hist[channel]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap())
                .sum::<u64>(),
            4
        );
    }
    assert_eq!(hist["source"], "raster");
}

#[test]
fn validation_rejects_invalid_edits_queries_and_unknown_assets() {
    let (_temp, core, photos, library) = setup();
    png(&photos.join("safe.png"), 12, 8);
    scan(&core, &library);
    let asset = only_asset(&core);
    for crop in [
        json!({"x":-0.1,"y":0,"width":0.5,"height":1}),
        json!({"x":0.8,"y":0,"width":0.5,"height":1}),
        json!({"x":0,"y":0,"width":0,"height":1}),
    ] {
        let mut args = crop;
        args["id"] = asset["id"].clone();
        assert!(core.dispatch("asset.crop", args).is_err());
    }
    assert!(core
        .dispatch("asset.rate", json!({"id":asset["id"],"rating":6}))
        .is_err());
    assert!(core
        .dispatch("asset.rate", json!({"id":asset["id"],"rating":1.5}))
        .is_err());
    assert!(core
        .dispatch("asset.preview", json!({"id":asset["id"],"max_size":100000}))
        .is_err());
    assert!(core.dispatch("asset.list", json!({"limit":0})).is_err());
    assert!(core.dispatch("asset.get", json!({"id":"missing"})).is_err());
    for query in ["\" OR 1=1 --", "*", "near(a)", "filename:safe"] {
        assert!(core.dispatch("asset.list", json!({"query":query})).is_ok());
    }
    assert_eq!(only_asset(&core)["crop"], Value::Null);
}

#[test]
fn jpeg_exif_orientation_is_applied_before_crop_and_export() {
    let (_temp, core, photos, library) = setup();
    let source = photos.join("portrait.jpg");
    let mut jpeg = Cursor::new(Vec::new());
    JpegEncoder::new(&mut jpeg)
        .encode_image(&RgbImage::from_pixel(12, 8, Rgb([120, 150, 200])))
        .unwrap();
    let exif = simple_tiff(
        vec![
            short(274, 6),
            ascii(271, "Nebulume Camera"),
            ascii(272, "Fixture One"),
        ],
        &[],
    );
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
    bytes.extend_from_slice(&((exif.len() + 8) as u16).to_be_bytes());
    bytes.extend_from_slice(b"Exif\0\0");
    bytes.extend_from_slice(&exif);
    bytes.extend_from_slice(&jpeg.into_inner()[2..]);
    fs::write(&source, bytes).unwrap();
    scan(&core, &library);
    let asset = only_asset(&core);
    assert_eq!(
        (asset["width"].as_u64(), asset["height"].as_u64()),
        (Some(8), Some(12))
    );
    assert!(asset["metadata"]["Camera"]
        .as_str()
        .unwrap()
        .contains("Fixture One"));
    let preview = core
        .dispatch("asset.preview", json!({"id":asset["id"],"max_size":64}))
        .unwrap();
    assert_eq!(
        (preview["width"].as_u64(), preview["height"].as_u64()),
        (Some(8), Some(12))
    );
    core.dispatch(
        "asset.crop",
        json!({"id":asset["id"],"x":0,"y":0,"width":0.5,"height":1}),
    )
    .unwrap();
    let output = photos.join("rotated.jpg");
    core.dispatch(
        "asset.export",
        json!({"id":asset["id"],"destination":output}),
    )
    .unwrap();
    assert_eq!(image::image_dimensions(output).unwrap(), (4, 12));
}

#[test]
fn dng_fixture_is_sensor_decoded_not_an_embedded_jpeg() {
    let (_temp, core, photos, library) = setup();
    let source = photos.join("sensor.dng");
    let samples: Vec<u8> = (0..48)
        .flat_map(|i| {
            let color = match ((i / 8) % 2, (i % 8) % 2) {
                (0, 0) => 2800_u16,
                (1, 1) => 700,
                _ => 1600,
            };
            color.to_le_bytes()
        })
        .collect();
    let tags = vec![
        long(256, 8),
        long(257, 6),
        short(258, 16),
        short(259, 1),
        short(262, 32803),
        ascii(271, "Nebulume"),
        ascii(272, "Synthetic Bayer"),
        long(273, 0),
        short(274, 6),
        short(277, 1),
        long(278, 6),
        long(279, samples.len() as u32),
        short(284, 1),
        (
            33421,
            3,
            2,
            [2_u16.to_le_bytes(), 2_u16.to_le_bytes()].concat(),
        ),
        (33422, 1, 4, vec![0, 1, 1, 2]),
        (50706, 1, 4, vec![1, 4, 0, 0]),
        (50710, 1, 3, vec![0, 1, 2]),
        short(50711, 1),
        long(50717, 4095),
        (
            50728,
            5,
            3,
            [1_u32.to_le_bytes(), 1_u32.to_le_bytes()]
                .concat()
                .repeat(3),
        ),
    ];
    fs::write(&source, simple_tiff(tags, &samples)).unwrap();
    let before = digest(&source);
    let report = scan(&core, &library);
    assert!(
        report["errors"].as_array().unwrap().is_empty(),
        "{report:#}"
    );
    let asset = only_asset(&core);
    assert_eq!(asset["kind"], "raw");
    assert_eq!(asset["availability"], "available");
    assert_eq!(
        (asset["width"].as_u64(), asset["height"].as_u64()),
        (Some(6), Some(8))
    );
    let preview = core
        .dispatch("asset.preview", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(preview["source"], "raw_demosaic");
    assert!(preview["data_url"]
        .as_str()
        .unwrap()
        .starts_with("data:image/jpeg;base64,"));
    let hist = core
        .dispatch("asset.histogram", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(hist["pixels"], 48);
    assert_eq!(hist["source"], "raw_demosaic");
    assert_ne!(
        hist["red"], hist["blue"],
        "Bayer color samples must affect rendered RGB channels"
    );
    assert_eq!(digest(&source), before);
}

#[test]
fn unsupported_raw_is_reported_honestly() {
    let (_temp, core, photos, library) = setup();
    fs::write(photos.join("new-camera.cr3"), b"unsupported CR3 fixture").unwrap();
    scan(&core, &library);
    let asset = only_asset(&core);
    assert_eq!(asset["availability"], "unsupported");
    let error = core
        .dispatch("asset.preview", json!({"id":asset["id"]}))
        .unwrap_err();
    assert!(format!("{error:#}").contains("CR3"));
}

#[cfg(unix)]
#[test]
fn scan_does_not_follow_symlinks_and_read_rejects_relocated_symlink() {
    use std::os::unix::fs::symlink;
    let (temp, core, photos, library) = setup();
    let outside = temp.path().join("outside.png");
    png(&outside, 8, 6);
    symlink(&outside, photos.join("link.png")).unwrap();
    scan(&core, &library);
    assert_eq!(core.dispatch("asset.list", json!({})).unwrap()["total"], 0);
    let real = photos.join("real.png");
    png(&real, 8, 6);
    scan(&core, &library);
    let asset = only_asset(&core);
    fs::remove_file(&real).unwrap();
    symlink(&outside, &real).unwrap();
    let error = core
        .dispatch("asset.preview", json!({"id":asset["id"]}))
        .unwrap_err();
    assert!(error.to_string().contains("E_PATH"));
}

#[cfg(unix)]
#[test]
fn replaced_library_root_cannot_retarget_preview_histogram_or_export() {
    use std::os::unix::fs::symlink;
    let (temp, core, photos, library) = setup();
    png(&photos.join("same-name.png"), 8, 6);
    scan(&core, &library);
    let asset = only_asset(&core);
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    png(&outside.join("same-name.png"), 16, 12);
    fs::rename(&photos, temp.path().join("photos-original")).unwrap();
    symlink(&outside, &photos).unwrap();
    for command in ["asset.preview", "asset.histogram", "asset.export"] {
        let error = core
            .dispatch(
                command,
                json!({"id":asset["id"],"destination":temp.path().join("forbidden.jpg")}),
            )
            .unwrap_err();
        assert!(error.to_string().contains("E_PATH"), "{command}: {error}");
    }
    assert!(!temp.path().join("forbidden.jpg").exists());
}

type TiffTag = (u16, u16, u32, Vec<u8>);
fn short(tag: u16, value: u16) -> TiffTag {
    (tag, 3, 1, value.to_le_bytes().to_vec())
}
fn long(tag: u16, value: u32) -> TiffTag {
    (tag, 4, 1, value.to_le_bytes().to_vec())
}
fn ascii(tag: u16, value: &str) -> TiffTag {
    let mut bytes = value.as_bytes().to_vec();
    bytes.push(0);
    (tag, 2, bytes.len() as u32, bytes)
}

// Small deterministic TIFF/DNG writer for tests. Fixture contains sensor samples
// and metadata only; no embedded preview exists that could satisfy RAW tests.
fn simple_tiff(mut tags: Vec<TiffTag>, samples: &[u8]) -> Vec<u8> {
    tags.sort_by_key(|tag| tag.0);
    let ifd_end = 8 + 2 + tags.len() * 12 + 4;
    let mut extra = Vec::new();
    let mut entries = Vec::new();
    let mut strip_offset_index = None;
    for (tag, kind, count, data) in &tags {
        entries.extend_from_slice(&tag.to_le_bytes());
        entries.extend_from_slice(&kind.to_le_bytes());
        entries.extend_from_slice(&count.to_le_bytes());
        if *tag == 273 {
            strip_offset_index = Some(entries.len());
        }
        if data.len() <= 4 {
            let mut inline = [0_u8; 4];
            inline[..data.len()].copy_from_slice(data);
            entries.extend_from_slice(&inline);
        } else {
            entries.extend_from_slice(&((ifd_end + extra.len()) as u32).to_le_bytes());
            extra.extend_from_slice(data);
            if extra.len() % 2 != 0 {
                extra.push(0);
            }
        }
    }
    if let Some(index) = strip_offset_index {
        entries[index..index + 4].copy_from_slice(&((ifd_end + extra.len()) as u32).to_le_bytes());
    }
    let mut bytes = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
    bytes.extend_from_slice(&(tags.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&entries);
    bytes.extend_from_slice(&[0; 4]);
    bytes.extend_from_slice(&extra);
    bytes.extend_from_slice(samples);
    bytes
}
