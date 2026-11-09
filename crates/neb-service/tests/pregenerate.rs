use neb_core::PreviewTier;
use neb_service::{PregenerateReport, Service};
use serde_json::json;
use std::fs;
use std::sync::atomic::AtomicBool;

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

#[test]
fn pregeneration_renders_each_local_photo_once_and_stops_when_cancelled() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    for index in 0..3 {
        fs::write(photos.path().join(format!("photo-{index}.ppm")), PHOTO).unwrap();
    }
    let svc = Service::open(data.path()).unwrap();
    let library = svc
        .execute("library.add", json!({"name":"相册","root":photos.path()}))
        .unwrap();
    let id = library["id"].as_str().unwrap();
    svc.execute("library.scan", json!({"library_id":id}))
        .unwrap();

    let cancelled = AtomicBool::new(true);
    assert_eq!(
        svc.pregenerate_previews(id, PreviewTier::T512, &cancelled)
            .unwrap(),
        PregenerateReport {
            cancelled: true,
            ..Default::default()
        }
    );
    let run = AtomicBool::new(false);
    let first = svc
        .pregenerate_previews(id, PreviewTier::T512, &run)
        .unwrap();
    assert_eq!((first.rendered, first.cached, first.failed), (3, 0, 0));
    let second = svc
        .pregenerate_previews(id, PreviewTier::T512, &run)
        .unwrap();
    assert_eq!((second.rendered, second.cached, second.failed), (0, 3, 0));

    // A missing photo is skipped rather than reported as a failure.
    fs::remove_file(photos.path().join("photo-0.ppm")).unwrap();
    svc.execute("library.scan", json!({"library_id":id}))
        .unwrap();
    let third = svc
        .pregenerate_previews(id, PreviewTier::T512, &run)
        .unwrap();
    assert_eq!((third.rendered, third.cached, third.failed), (0, 2, 0));

    // On-demand previews of the same tier read what was rendered in the background.
    drop(svc);
    let svc = Service::open(data.path()).unwrap();
    let listed = svc.execute("asset.list", json!({"library_id":id})).unwrap();
    let asset = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["filename"] == "photo-1.ppm")
        .unwrap()
        .clone();
    let image = svc
        .preview_image(asset["id"].as_str().unwrap(), PreviewTier::T512, false)
        .unwrap();
    assert!(image.jpeg.starts_with(&[0xFF, 0xD8]));
    let again = svc
        .pregenerate_previews(id, PreviewTier::T512, &run)
        .unwrap();
    assert_eq!(again.rendered, 0);
}
