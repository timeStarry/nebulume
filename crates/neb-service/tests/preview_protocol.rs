use neb_core::{PreviewImage, PreviewTier};
use neb_service::Service;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant, SystemTime},
};

fn ppm(width: u32, height: u32, seed: u8) -> Vec<u8> {
    let mut bytes = format!("P6\n{width} {height}\n255\n").into_bytes();
    for y in 0..height {
        for x in 0..width {
            bytes.extend_from_slice(&[
                (x % 256) as u8 ^ seed,
                (y % 256) as u8,
                seed.wrapping_mul(3),
            ]);
        }
    }
    bytes
}

/// A real JPEG produced by the service itself from a synthetic PPM.
fn jpeg(width: u32, height: u32, seed: u8) -> Vec<u8> {
    let data = tempfile::tempdir().unwrap();
    let file = data.path().join("source.ppm");
    fs::write(&file, ppm(width, height, seed)).unwrap();
    let service = Service::open(data.path().join("profile")).unwrap();
    let asset = service.execute("file.open", json!({"path":file})).unwrap();
    let image = service
        .preview_image(asset["id"].as_str().unwrap(), PreviewTier::T1024, false)
        .unwrap();
    image.jpeg.clone()
}

fn local_library(service: &Service, root: &Path) -> Value {
    let library = service
        .execute("library.add", json!({"name":"Local","root":root}))
        .unwrap();
    service
        .execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    service
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap()["items"][0]
        .clone()
}

fn id(asset: &Value) -> &str {
    asset["id"].as_str().unwrap()
}

#[test]
fn local_preview_bytes_are_jpeg_and_ipc_has_no_pixels() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("photo.jpg"), jpeg(600, 300, 1)).unwrap();
    let service = Service::open(data.path()).unwrap();
    let asset = local_library(&service, photos.path());
    let image = service
        .preview_image(id(&asset), PreviewTier::T512, false)
        .unwrap();
    assert!(image.jpeg.starts_with(&[0xFF, 0xD8]));
    assert!(image.width.max(image.height) <= 512);
    let meta = service
        .execute("asset.preview", json!({"id":asset["id"],"tier":"t512"}))
        .unwrap();
    assert_eq!(meta["width"], image.width);
    assert_eq!(meta["height"], image.height);
    assert_eq!(meta["tier"], "t512");
    assert_eq!(meta["asset"]["id"], asset["id"]);
    assert!(meta.get("data_url").is_none());
    let invalid = service
        .execute("asset.preview", json!({"id":asset["id"],"tier":"t9999"}))
        .unwrap_err();
    assert_eq!(invalid.code, "E_INVALID");
}

#[test]
fn legacy_max_size_maps_to_tier() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("photo.jpg"), jpeg(600, 300, 2)).unwrap();
    let service = Service::open(data.path()).unwrap();
    let asset = local_library(&service, photos.path());
    let meta = service
        .execute("asset.preview", json!({"id":asset["id"],"max_size":420}))
        .unwrap();
    assert_eq!(meta["tier"], "t512");
    assert_eq!(meta["width"], 512);
    let default = service
        .execute("asset.preview", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(default["tier"], "p2560");
    let invalid = service
        .execute("asset.preview", json!({"id":asset["id"],"max_size":8}))
        .unwrap_err();
    assert_eq!(invalid.code, "E_INVALID");
}

#[test]
fn etag_is_stable_and_changes_with_file_content() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let file = photos.path().join("photo.jpg");
    fs::write(&file, jpeg(600, 300, 3)).unwrap();
    let service = Service::open(data.path()).unwrap();
    let asset = local_library(&service, photos.path());
    let first = service
        .preview_etag(id(&asset), PreviewTier::T512, false)
        .unwrap();
    assert_eq!(
        first,
        service
            .preview_etag(id(&asset), PreviewTier::T512, false)
            .unwrap()
    );
    assert!(first.starts_with('"') && first.ends_with('"'));
    let hex = &first[1..first.len() - 1];
    assert_eq!(hex.len(), 64);
    assert!(hex
        .chars()
        .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    let before = service
        .preview_image(id(&asset), PreviewTier::T512, false)
        .unwrap();

    fs::write(&file, jpeg(300, 600, 77)).unwrap();
    let later = SystemTime::now() + Duration::from_secs(5);
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(later)
        .unwrap();
    // The protocol checks the ETag before rendering, so a changed file must
    // change it without an explicit refresh command.
    let changed = service
        .preview_etag(id(&asset), PreviewTier::T512, false)
        .unwrap();
    assert_ne!(changed, first);
    service
        .execute("asset.refresh", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(
        changed,
        service
            .preview_etag(id(&asset), PreviewTier::T512, false)
            .unwrap()
    );
    let after = service
        .preview_image(id(&asset), PreviewTier::T512, false)
        .unwrap();
    assert_ne!(after.jpeg, before.jpeg);
    assert_eq!((after.width, after.height), (256, 512));
}

#[test]
fn etag_changes_with_crop_and_tier() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("photo.jpg"), jpeg(600, 300, 4)).unwrap();
    let service = Service::open(data.path()).unwrap();
    let asset = local_library(&service, photos.path());
    let etag = |tier, uncropped| service.preview_etag(id(&asset), tier, uncropped).unwrap();
    let small = etag(PreviewTier::T256, false);
    let medium = etag(PreviewTier::T512, false);
    assert_ne!(small, medium);
    service
        .execute(
            "asset.crop",
            json!({"id":asset["id"],"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
        )
        .unwrap();
    let cropped = etag(PreviewTier::T512, false);
    assert_ne!(cropped, medium);
    assert_eq!(etag(PreviewTier::T512, true), medium);
    let image = service
        .preview_image(id(&asset), PreviewTier::T512, false)
        .unwrap();
    assert_eq!((image.width, image.height), (300, 300));
}

#[test]
fn missing_asset_reports_not_found() {
    let data = tempfile::tempdir().unwrap();
    let service = Service::open(data.path()).unwrap();
    let error = service
        .preview_image(
            "00000000-0000-0000-0000-000000000000",
            PreviewTier::T256,
            false,
        )
        .unwrap_err();
    assert_eq!(error.code, "E_NOT_FOUND");
    let error = service
        .preview_etag(
            "00000000-0000-0000-0000-000000000000",
            PreviewTier::T256,
            false,
        )
        .unwrap_err();
    assert_eq!(error.code, "E_NOT_FOUND");
}

#[test]
fn preview_cache_survives_restart_as_v2_envelope() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("photo.jpg"), jpeg(600, 300, 5)).unwrap();
    let service = Service::open(data.path()).unwrap();
    let asset = local_library(&service, photos.path());
    let first = service
        .preview_image(id(&asset), PreviewTier::T256, false)
        .unwrap();
    let previews = data.path().join("remote-cache/objects/preview");
    let deadline = Instant::now() + Duration::from_secs(10);
    let stored = loop {
        let files: Vec<_> = fs::read_dir(&previews)
            .map(|entries| {
                entries
                    .map(|entry| fs::read(entry.unwrap().path()).unwrap())
                    .collect()
            })
            .unwrap_or_default();
        if let Some(bytes) = files.into_iter().next() {
            break bytes;
        }
        assert!(Instant::now() < deadline, "background preview write");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(stored.starts_with(b"NPV2"));
    let decoded = PreviewImage::from_envelope(&stored).unwrap();
    assert_eq!(decoded.jpeg, first.jpeg);
    drop(service);
    // Old-format JSON must never be served from a v2 envelope reader.
    let reopened = Service::open(data.path()).unwrap();
    let again = reopened
        .preview_image(id(&asset), PreviewTier::T256, false)
        .unwrap();
    assert_eq!(again.jpeg, first.jpeg);
    assert_eq!(again.source, first.source);
}
