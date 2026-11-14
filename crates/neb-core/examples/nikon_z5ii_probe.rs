//! Opt-in physical sample validation. No camera image or private MakerNote is
//! committed; all catalog/cache/export writes stay inside a temporary directory.
//! Optional first argument saves preview/focus evidence in a new directory.

use std::{fs, io::Cursor, path::PathBuf};

use neb_core::{remote_focus, stream_preview_from_bytes, Core, PreviewTier};
use serde_json::json;
use sha2::{Digest, Sha256};

fn main() {
    // Exercise the shared decoder's stack guard from the default main stack.
    verify();
}

fn verify() {
    let source =
        PathBuf::from(std::env::var_os("NEBULUME_NIKON_Z5II_SAMPLE").expect("sample path"));
    let before = fs::read(&source).unwrap();
    let digest = Sha256::digest(&before);
    let temp = tempfile::tempdir().unwrap();
    let core = Core::open(temp.path()).unwrap();
    let original_asset = core.dispatch("file.open", json!({"path":source})).unwrap();
    // Reproduce the previous release's cached unsupported metadata, then prove
    // reopening upgrades it without replacing the asset or losing user marks.
    let database = rusqlite::Connection::open(temp.path().join("catalog.sqlite3")).unwrap();
    database
        .execute(
            "UPDATE assets SET metadata_json=?1,rating=3 WHERE id=?2",
            rusqlite::params![
                json!({"Camera":"NIKON Z5_2","Decode Status":"RAW 原始解码不可用"}).to_string(),
                original_asset["id"].as_str().unwrap()
            ],
        )
        .unwrap();
    database
        .execute(
            "DELETE FROM app_settings WHERE key='inspection.nikon-z5ii.v1'",
            [],
        )
        .unwrap();
    drop(database);
    drop(core);
    let core = Core::open(temp.path()).unwrap();
    let asset = core.dispatch("file.open", json!({"path":source})).unwrap();
    assert_eq!(asset["id"], original_asset["id"]);
    assert_eq!(asset["rating"], 3);
    assert!(asset["metadata"].get("Decode Status").is_none());
    let id = asset["id"].as_str().unwrap();
    assert_eq!(asset["metadata"]["Camera"], "Nikon Z 5 II");
    assert_eq!(
        asset["metadata"]["Decoder"],
        "rawler 0.8.0 · basic sensor rendering"
    );
    assert_eq!(
        (asset["width"].as_u64(), asset["height"].as_u64()),
        (Some(4032), Some(6048))
    );

    let embedded = core.preview_image(id, PreviewTier::P2560, true).unwrap();
    assert_eq!(embedded.source, "embedded_jpeg");
    let sensor = core
        .preview_image_with_mode(id, PreviewTier::P2560, true, true)
        .unwrap();
    assert_eq!(sensor.source, "raw_demosaic");
    assert_eq!((sensor.width, sensor.height), (1707, 2560));
    let mapping = sensor.coordinate_mapping.as_ref().unwrap();
    assert_eq!(mapping["orientation"], 8);
    assert_eq!(
        (
            mapping["full_width"].as_u64(),
            mapping["full_height"].as_u64()
        ),
        (Some(1707), Some(2560))
    );
    let image = image::load_from_memory(&sensor.jpeg).unwrap().to_rgb8();
    assert!(image
        .pixels()
        .any(|p| p.0.iter().any(|v| *v > 16 && *v < 240)));

    let focus = core.dispatch("asset.focus", json!({"id":id})).unwrap();
    assert_eq!(focus["status"], "available");
    assert_eq!(focus["orientation"], 8);
    assert_eq!(focus["regions"].as_array().unwrap().len(), 1);
    let bounded = remote_focus(Cursor::new(&before), before.len() as u64);
    assert_eq!(serde_json::to_value(bounded).unwrap(), focus);
    if let Some(directory) = std::env::args_os().nth(1) {
        let directory = PathBuf::from(directory);
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("sensor-preview.jpg"), &sensor.jpeg).unwrap();
        fs::write(directory.join("embedded-preview.jpg"), &embedded.jpeg).unwrap();
        fs::write(
            directory.join("focus.json"),
            serde_json::to_vec_pretty(&focus).unwrap(),
        )
        .unwrap();
    }

    let (stream, _) =
        stream_preview_from_bytes(&before, "nef", None, PreviewTier::P2560, true).unwrap();
    assert_eq!(stream.source, "raw_demosaic");
    assert_eq!((stream.width, stream.height), (sensor.width, sensor.height));
    assert_eq!(
        stream.extras["inspection"]["metadata"]["Decoder"],
        "rawler 0.8.0 · basic sensor rendering"
    );

    let destination = temp.path().join("sensor-export.jpg");
    core.dispatch("asset.export", json!({"id":id,"destination":destination}))
        .unwrap();
    assert_eq!(image::image_dimensions(&destination).unwrap(), (4032, 6048));
    assert!(core
        .dispatch("asset.export", json!({"id":id,"destination":destination}))
        .is_err());
    assert_eq!(Sha256::digest(fs::read(source).unwrap()), digest);
    println!("Z5 II: embedded + 1707x2560 sensor/stream + 4032x6048 export + oriented AF region; original SHA-256 unchanged");
}
