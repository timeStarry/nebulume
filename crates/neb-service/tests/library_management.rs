use neb_service::Service;
use serde_json::{json, Value};
use std::{
    fs,
    sync::{Arc, Barrier},
};

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

#[test]
fn update_binding_and_remove_only_change_catalog_and_guard_referenced_sources() {
    let temp = tempfile::tempdir().unwrap();
    let photos = temp.path().join("photos");
    for album in ["old", "new"] {
        fs::create_dir_all(photos.join(album)).unwrap();
        fs::write(photos.join(album).join("original.ppm"), PHOTO).unwrap();
    }
    let svc = Service::open(temp.path().join("data")).unwrap();
    let source = svc
        .execute(
            "storage.add",
            json!({"name":"Source","kind":"local","endpoint":photos}),
        )
        .unwrap();
    let library=svc.execute("library.add",json!({"name":"Original library","storage_id":source["id"],"prefix":"old","pair_raw_jpeg":true})).unwrap();
    assert_eq!(library["pair_raw_jpeg"], true);
    svc.execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let asset = svc
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap()["items"][0]
        .clone();
    svc.execute("asset.rate", json!({"id":asset["id"],"rating":5}))
        .unwrap();
    svc.execute(
        "asset.crop",
        json!({"id":asset["id"],"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
    )
    .unwrap();
    let changed=svc.execute("library.update",json!({"id":library["id"],"name":"Renamed","pair_raw_jpeg":false,"storage_id":source["id"],"source_prefix":"old/"})).unwrap();
    assert_eq!(changed["name"], "Renamed");
    assert_eq!(changed["pair_raw_jpeg"], false);
    let preserved = svc.execute("asset.get", json!({"id":asset["id"]})).unwrap();
    assert_eq!(preserved["rating"], 5);
    assert_eq!(preserved["crop"]["width"], 0.5);
    let blocked = svc
        .execute("storage.remove", json!({"id":source["id"]}))
        .unwrap_err();
    assert_eq!(blocked.code, "E_IN_USE");
    assert!(blocked.message.contains("Renamed"));
    // Offline local volumes must not prevent renaming or keeping the same binding.
    fs::rename(photos.join("old"), photos.join("temporarily-offline")).unwrap();
    let offline = svc
        .execute(
            "library.update",
            json!({"id":library["id"],"name":"Offline renamed","source_prefix":"old/"}),
        )
        .unwrap();
    assert_eq!(offline["connected"], false);
    assert_eq!(
        svc.execute("asset.list", json!({"library_id":library["id"]}))
            .unwrap()["items"][0]["rating"],
        5
    );
    fs::rename(photos.join("temporarily-offline"), photos.join("old")).unwrap();
    let rebound = svc
        .execute(
            "library.update",
            json!({"id":library["id"],"source_prefix":"new"}),
        )
        .unwrap();
    assert_eq!(rebound["id"], library["id"]);
    assert_eq!(rebound["source_prefix"], "new");
    assert_eq!(
        svc.execute("asset.list", json!({"library_id":library["id"]}))
            .unwrap()["total"],
        0
    );
    assert_eq!(
        svc.execute("asset.get", json!({"id":asset["id"]}))
            .unwrap_err()
            .code,
        "E_NOT_FOUND"
    );
    svc.execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let replacement = svc
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap()["items"][0]
        .clone();
    assert_eq!(replacement["rating"], 0);
    assert!(replacement["crop"].is_null());
    let removed = svc
        .execute("library.remove", json!({"id":library["id"]}))
        .unwrap();
    assert_eq!(removed["removed_assets"], 1);
    assert!(svc
        .execute("library.list", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        svc.execute("storage.remove", json!({"id":source["id"]}))
            .unwrap()["id"],
        source["id"]
    );
    for album in ["old", "new"] {
        assert_eq!(
            fs::read(photos.join(album).join("original.ppm")).unwrap(),
            PHOTO
        );
    }
    drop(svc);
    let reopened = Service::open(temp.path().join("data")).unwrap();
    assert_eq!(
        reopened.execute("library.list", json!({})).unwrap(),
        json!([])
    );
    assert_eq!(
        reopened.execute("storage.list", json!({})).unwrap(),
        json!([])
    );
}

#[test]
fn concurrent_source_removal_and_library_creation_cannot_leave_a_dangling_binding() {
    let temp = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let svc = Arc::new(Service::open(temp.path()).unwrap());
    let source = svc
        .execute(
            "storage.add",
            json!({"name":"Source","kind":"local","endpoint":photos.path()}),
        )
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let run = |command: &'static str, params: Value| {
        let svc = Arc::clone(&svc);
        let barrier = Arc::clone(&barrier);
        std::thread::spawn(move || {
            barrier.wait();
            svc.execute(command, params)
        })
    };
    let add = run(
        "library.add",
        json!({"name":"Race library","storage_id":source["id"]}),
    );
    let remove = run("storage.remove", json!({"id":source["id"]}));
    barrier.wait();
    let added = add.join().unwrap();
    let removed = remove.join().unwrap();
    match (added, removed) {
        (Ok(library), Err(error)) => {
            assert_eq!(error.code, "E_IN_USE");
            assert_eq!(library["storage_id"], source["id"]);
            assert_eq!(
                svc.execute("storage.list", json!({}))
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        (Err(error), Ok(_)) => {
            assert_eq!(error.code, "E_NOT_FOUND");
            assert_eq!(svc.execute("library.list", json!({})).unwrap(), json!([]));
        }
        _ => panic!("The serialized operations must have exactly one winner"),
    }
}
