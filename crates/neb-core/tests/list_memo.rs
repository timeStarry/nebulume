//! `asset.list` reuses its ordered ID list between pages; any catalog change,
//! from this or another process, must be visible on the next call.
use neb_core::Core;
use serde_json::json;
use std::fs;

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

fn ids(core: &Core, params: serde_json::Value) -> Vec<String> {
    core.dispatch("asset.list", params).unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["filename"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn list_pages_reflect_changes_made_between_them_here_and_elsewhere() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    for name in ["a", "b", "c", "d"] {
        fs::write(photos.path().join(format!("{name}.ppm")), PHOTO).unwrap();
    }
    let core = Core::open(data.path()).unwrap();
    let library = core
        .dispatch("library.add", json!({"name":"相册","root":photos.path()}))
        .unwrap();
    let id = library["id"].as_str().unwrap().to_owned();
    core.dispatch("library.scan", json!({"library_id":id}))
        .unwrap();
    let by_name = json!({"library_id":id,"sort_by":"filename","sort_direction":"asc","limit":2});
    let page = |offset: u32| {
        let mut params = by_name.clone();
        params["offset"] = json!(offset);
        params
    };
    assert_eq!(ids(&core, page(0)), ["a.ppm", "b.ppm"]);
    assert_eq!(ids(&core, page(2)), ["c.ppm", "d.ppm"]);

    // A rating made through this core changes a rating-filtered list at once.
    let rated = json!({"library_id":id,"rating":3,"sort_by":"filename","sort_direction":"asc"});
    assert!(ids(&core, rated.clone()).is_empty());
    let all = core
        .dispatch("asset.list", json!({"library_id":id}))
        .unwrap();
    let c = all["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["filename"] == "c.ppm")
        .unwrap()["id"]
        .clone();
    core.dispatch("asset.rate", json!({"id":c,"rating":4}))
        .unwrap();
    assert_eq!(ids(&core, rated.clone()), ["c.ppm"]);

    // Another process (here a second Core on the same catalog) is seen too.
    let other = Core::open(data.path()).unwrap();
    other
        .dispatch("asset.rate", json!({"id":c,"rating":0}))
        .unwrap();
    assert!(ids(&core, rated).is_empty());

    // A new file indexed elsewhere shifts the pages of an unchanged query.
    fs::write(photos.path().join("0.ppm"), PHOTO).unwrap();
    other
        .dispatch("library.scan", json!({"library_id":id}))
        .unwrap();
    assert_eq!(ids(&core, page(0)), ["0.ppm", "a.ppm"]);
    assert_eq!(core.dispatch("asset.list", by_name).unwrap()["total"], 5);
}
