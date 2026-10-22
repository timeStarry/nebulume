use neb_service::Service;
use serde_json::json;
use std::fs;

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

#[test]
fn local_directory_creates_library_without_storage_registration_and_survives_restart() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("photo.ppm"), PHOTO).unwrap();
    let svc = Service::open(data.path()).unwrap();
    let library = svc
        .execute(
            "library.add",
            json!({"name":"本地相册","root":photos.path(),"pair_raw_jpeg":true}),
        )
        .unwrap();
    assert_eq!(library["source_kind"], "local");
    assert!(library["storage_id"].is_null());
    assert_eq!(library["connected"], true);
    assert_eq!(library["availability"], "online");
    assert_eq!(svc.execute("storage.list", json!({})).unwrap(), json!([]));
    assert_eq!(
        svc.execute("library.scan", json!({"library_id":library["id"]}))
            .unwrap()["indexed"],
        1
    );
    let asset = svc
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap()["items"][0]
        .clone();
    assert!(svc
        .execute("asset.preview", json!({"id":asset["id"],"max_size":32}))
        .unwrap()["data_url"]
        .as_str()
        .unwrap()
        .starts_with("data:image/"));
    drop(svc);
    let svc = Service::open(data.path()).unwrap();
    let reopened = svc.execute("library.list", json!({})).unwrap();
    assert_eq!(reopened[0]["id"], library["id"]);
    assert!(reopened[0]["storage_id"].is_null());
    assert_eq!(reopened[0]["pair_raw_jpeg"], true);
    assert_eq!(svc.execute("storage.list", json!({})).unwrap(), json!([]));
    assert_eq!(
        svc.execute("asset.get", json!({"id":asset["id"]})).unwrap()["id"],
        asset["id"]
    );
}

#[test]
fn local_rebinding_clears_only_index_and_conflicts_leave_existing_library_intact() {
    let data = tempfile::tempdir().unwrap();
    let old = tempfile::tempdir().unwrap();
    let new = tempfile::tempdir().unwrap();
    let conflict = tempfile::tempdir().unwrap();
    fs::write(old.path().join("old.ppm"), PHOTO).unwrap();
    fs::write(new.path().join("new.ppm"), PHOTO).unwrap();
    let svc = Service::open(data.path()).unwrap();
    let library = svc
        .execute("library.add", json!({"name":"相册","root":old.path()}))
        .unwrap();
    svc.execute("library.add", json!({"name":"其它","root":conflict.path()}))
        .unwrap();
    svc.execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let asset = svc
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap()["items"][0]
        .clone();
    let error = svc
        .execute(
            "library.update",
            json!({"id":library["id"],"name":"不应生效","root":conflict.path()}),
        )
        .unwrap_err();
    assert_eq!(error.code, "E_CONFLICT");
    assert_eq!(
        svc.execute("asset.get", json!({"id":asset["id"]})).unwrap()["id"],
        asset["id"]
    );
    let updated = svc
        .execute(
            "library.update",
            json!({"id":library["id"],"root":new.path()}),
        )
        .unwrap();
    assert_eq!(updated["name"], "相册");
    assert!(updated["storage_id"].is_null());
    assert!(svc.execute("asset.get", json!({"id":asset["id"]})).is_err());
    assert_eq!(
        svc.execute("asset.list", json!({"library_id":library["id"]}))
            .unwrap()["total"],
        0
    );
    svc.execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    assert_eq!(
        svc.execute("asset.list", json!({"library_id":library["id"]}))
            .unwrap()["items"][0]["filename"],
        "new.ppm"
    );
    assert_eq!(fs::read(old.path().join("old.ppm")).unwrap(), PHOTO);
    assert_eq!(fs::read(new.path().join("new.ppm")).unwrap(), PHOTO);
}

#[test]
fn detaching_legacy_local_source_at_same_directory_preserves_edits_and_source_config() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("photo.ppm"), PHOTO).unwrap();
    let svc = Service::open(data.path()).unwrap();
    let source = svc
        .execute(
            "storage.add",
            json!({"name":"旧本地源","kind":"local","endpoint":photos.path()}),
        )
        .unwrap();
    let library = svc
        .execute(
            "library.add",
            json!({"name":"相册","storage_id":source["id"]}),
        )
        .unwrap();
    svc.execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let asset = svc
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap()["items"][0]
        .clone();
    svc.execute("asset.rate", json!({"id":asset["id"],"rating":4}))
        .unwrap();
    let cropped = svc
        .execute(
            "asset.crop",
            json!({"id":asset["id"],"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
        )
        .unwrap();
    let updated = svc
        .execute(
            "library.update",
            json!({"id":library["id"],"root":photos.path()}),
        )
        .unwrap();
    assert!(updated["storage_id"].is_null());
    let kept = svc.execute("asset.get", json!({"id":asset["id"]})).unwrap();
    assert_eq!(kept["rating"], 4);
    assert_eq!(kept["crop"], cropped["crop"]);
    assert_eq!(
        svc.execute("storage.list", json!({})).unwrap()[0]["id"],
        source["id"]
    );
    assert_eq!(fs::read(photos.path().join("photo.ppm")).unwrap(), PHOTO);
}

#[test]
fn remote_library_is_unchecked_until_a_real_operation_and_offline_after_failure() {
    let data = tempfile::tempdir().unwrap();
    let svc = Service::open(data.path()).unwrap();
    // Port 9 on loopback is closed: the request fails to connect, not to authenticate.
    let source = svc
        .execute(
            "storage.add",
            json!({"name":"NAS","kind":"webdav","endpoint":"http://127.0.0.1:9/dav/"}),
        )
        .unwrap();
    let library = svc
        .execute(
            "library.add",
            json!({"name":"NAS 照片","storage_id":source["id"]}),
        )
        .unwrap();
    assert_eq!(library["availability"], "unchecked");
    assert_eq!(library["connected"], false);
    let check = svc
        .execute("storage.check", json!({"id":source["id"]}))
        .unwrap();
    assert_eq!(check["availability"], "offline");
    let listed = svc.execute("library.list", json!({})).unwrap();
    assert_eq!(listed[0]["availability"], "offline");
    // Marks stay writable regardless of location state (no assets yet: list still works).
    assert_eq!(
        svc.execute("asset.list", json!({"library_id":library["id"]}))
            .unwrap()["total"],
        0
    );
}
