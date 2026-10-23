use neb_service::Service;
use serde_json::json;
use std::fs;

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

#[test]
fn service_flags_local_assets_and_rejects_cross_library_batch() {
    let temp = tempfile::tempdir().unwrap();
    let svc = Service::open(temp.path().join("data")).unwrap();
    let mut libraries = Vec::new();
    for name in ["a", "b"] {
        let root = temp.path().join(name);
        fs::create_dir(&root).unwrap();
        fs::write(root.join("photo.ppm"), PHOTO).unwrap();
        let library = svc
            .execute("library.add", json!({"name":name,"root":root}))
            .unwrap();
        svc.execute("library.scan", json!({"library_id":library["id"]}))
            .unwrap();
        libraries.push(library["id"].clone());
    }
    let first = |library: &serde_json::Value| {
        svc.execute("asset.list", json!({"library_id":library}))
            .unwrap()["items"][0]["id"]
            .clone()
    };
    let (a, b) = (first(&libraries[0]), first(&libraries[1]));
    let flagged = svc
        .execute("asset.flag", json!({"id":a,"flag":"reject"}))
        .unwrap();
    assert_eq!(flagged["flag"], "reject");
    let listed = svc
        .execute(
            "asset.list",
            json!({"library_id":libraries[0],"flag":"not_reject"}),
        )
        .unwrap();
    assert_eq!(listed["total"], 0);
    let error = svc
        .execute("asset.mark_batch", json!({"ids":[a,b],"flag":"pick"}))
        .unwrap_err();
    assert_eq!(error.code, "E_INVALID");
    assert_eq!(
        svc.execute("asset.get", json!({"id":a})).unwrap()["flag"],
        "reject"
    );
    let result = svc
        .execute(
            "asset.mark_batch",
            json!({"ids":[a],"rating":2,"flag":"pick"}),
        )
        .unwrap();
    assert_eq!(result["updated"], 1);
    let asset = svc.execute("asset.get", json!({"id":a})).unwrap();
    assert_eq!(
        (asset["rating"].as_u64(), asset["flag"].as_str()),
        (Some(2), Some("pick"))
    );
}
