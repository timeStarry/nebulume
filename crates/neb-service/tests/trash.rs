//! Moving originals to the real system Trash and back. Each test uses its own
//! temporary folder, so it only ever trashes files it created.
use neb_service::Service;
use serde_json::{json, Value};
use std::fs;

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

fn listed(svc: &Service, library: &str) -> Vec<String> {
    let mut names: Vec<String> = svc
        .execute("asset.list", json!({"library_id":library}))
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["filename"].as_str().unwrap().to_owned())
        .collect();
    names.sort();
    names
}

fn id_of(svc: &Service, library: &str, filename: &str) -> Value {
    svc.execute("asset.list", json!({"library_id":library}))
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["filename"] == filename)
        .unwrap()["id"]
        .clone()
}

fn library(svc: &Service, root: &std::path::Path) -> String {
    let library = svc
        .execute("library.add", json!({"name":"相册","root":root}))
        .unwrap();
    let id = library["id"].as_str().unwrap().to_owned();
    svc.execute("library.scan", json!({"library_id":id}))
        .unwrap();
    id
}

#[test]
fn trashing_moves_a_raw_jpeg_pair_hides_it_and_undo_restores_marks() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("keep.ppm"), PHOTO).unwrap();
    fs::write(photos.path().join("DSC_1.nef"), b"not really raw").unwrap();
    fs::write(photos.path().join("DSC_1.jpg"), b"not really jpeg").unwrap();
    let svc = Service::open(data.path()).unwrap();
    let library = library(&svc, photos.path());
    let jpeg = id_of(&svc, &library, "DSC_1.jpg");
    svc.execute("asset.rate", json!({"id":jpeg,"rating":4}))
        .unwrap();
    svc.execute("asset.flag", json!({"id":jpeg,"flag":"reject"}))
        .unwrap();

    let result = svc.execute("asset.trash", json!({"ids":[jpeg]})).unwrap();
    assert_eq!(result["trashed"].as_array().unwrap().len(), 2, "{result}");
    assert!(!photos.path().join("DSC_1.nef").exists());
    assert!(!photos.path().join("DSC_1.jpg").exists());
    assert_eq!(listed(&svc, &library), ["keep.ppm"]);
    // A rescan neither revives nor re-matches the trashed rows.
    svc.execute("library.scan", json!({"library_id":library}))
        .unwrap();
    assert_eq!(listed(&svc, &library), ["keep.ppm"]);

    let ids = result["trashed"].clone();
    let restored = svc.execute("asset.restore", json!({"ids":ids})).unwrap();
    assert_eq!(
        restored["restored"].as_array().unwrap().len(),
        2,
        "{restored}"
    );
    assert_eq!(
        fs::read(photos.path().join("DSC_1.jpg")).unwrap(),
        b"not really jpeg"
    );
    assert_eq!(
        listed(&svc, &library),
        ["DSC_1.jpg", "DSC_1.nef", "keep.ppm"]
    );
    let back = svc.execute("asset.get", json!({"id":jpeg})).unwrap();
    assert_eq!(
        (back["rating"].as_u64(), back["flag"].as_str()),
        (Some(4), Some("reject"))
    );
}

#[test]
fn a_file_put_back_outside_the_app_returns_on_the_next_scan() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("a.ppm"), PHOTO).unwrap();
    let svc = Service::open(data.path()).unwrap();
    let library = library(&svc, photos.path());
    let id = id_of(&svc, &library, "a.ppm");
    svc.execute("asset.rate", json!({"id":id,"rating":5}))
        .unwrap();
    svc.execute("asset.trash", json!({"ids":[id]})).unwrap();
    assert!(listed(&svc, &library).is_empty());
    // Like Finder's Put Back: the same file reappears at the same path.
    fs::write(photos.path().join("a.ppm"), PHOTO).unwrap();
    svc.execute("library.scan", json!({"library_id":library}))
        .unwrap();
    assert_eq!(listed(&svc, &library), ["a.ppm"]);
    let back = svc.execute("asset.get", json!({"id":id})).unwrap();
    assert_eq!(back["rating"], 5);
}

#[test]
fn unknown_photos_are_refused() {
    let data = tempfile::tempdir().unwrap();
    let svc = Service::open(data.path()).unwrap();
    let error = svc
        .execute("asset.trash", json!({"ids":["no-such-photo"]}))
        .unwrap_err();
    assert_eq!(error.code, "E_NOT_FOUND");
}
