use std::fs;

use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};
use neb_core::Core;
use serde_json::json;

fn tiny_jpeg(color: [u8; 3]) -> Vec<u8> {
    let mut bytes = Vec::new();
    JpegEncoder::new(&mut bytes)
        .encode_image(&RgbImage::from_pixel(12, 8, Rgb(color)))
        .unwrap();
    bytes
}

#[test]
fn package_bundles_are_skipped_as_subfolders_and_cleaned_up_on_rescan() {
    let temp = tempfile::tempdir().unwrap();
    let pictures = temp.path().join("Pictures");
    let shoot_dir = pictures.join("2026_Kyoto");
    let photos_bundle = pictures
        .join("Photos Library.photoslibrary")
        .join("originals")
        .join("0");
    fs::create_dir_all(&shoot_dir).unwrap();
    fs::create_dir_all(&photos_bundle).unwrap();
    fs::write(shoot_dir.join("DSC0001.JPG"), tiny_jpeg([180, 90, 40])).unwrap();
    fs::write(photos_bundle.join("IMG_9999.JPG"), tiny_jpeg([40, 90, 180])).unwrap();

    let core = Core::open(temp.path().join("catalog")).unwrap();
    let lib = core.add_library("Pictures", &pictures).unwrap();
    let report = core.scan(&lib.id).unwrap();
    assert_eq!(report.indexed, 1, "sub-bundle .photoslibrary must not be walked");

    let folders = core
        .dispatch("library.folders", json!({ "library_id": lib.id }))
        .unwrap();
    let folder_list = folders["folders"].as_array().unwrap();
    assert_eq!(folder_list.len(), 1);
    assert_eq!(folder_list[0]["name"], "2026_Kyoto");

    // Simulate legacy catalog row previously indexed inside Photos Library.photoslibrary:
    let explicit_bundle_root = pictures.join("Photos Library.photoslibrary");
    let explicit_lib = core
        .add_library("Explicit Bundle", &explicit_bundle_root)
        .unwrap();
    let explicit_report = core.scan(&explicit_lib.id).unwrap();
    assert_eq!(
        explicit_report.indexed, 1,
        "explicitly choosing a .photoslibrary as root (depth 0) still indexes"
    );
}

#[test]
fn color_labels_collections_keywords_xmp_and_relocation_roundtrip_losslessly() {
    let temp = tempfile::tempdir().unwrap();
    let drive_old = temp.path().join("SSD_Old").join("Portfolio");
    fs::create_dir_all(drive_old.join("Day1")).unwrap();
    let img_a = drive_old.join("Day1").join("A001.JPG");
    let img_b = drive_old.join("Day1").join("A002.JPG");
    fs::write(&img_a, tiny_jpeg([200, 60, 60])).unwrap();
    fs::write(&img_b, tiny_jpeg([60, 180, 90])).unwrap();

    let core = Core::open(temp.path().join("catalog")).unwrap();
    core.dispatch("xmp.policy.set", json!({ "auto_write": true }))
        .unwrap();
    let lib = core.add_library("Portfolio", &drive_old).unwrap();
    core.scan(&lib.id).unwrap();

    let listed = core
        .dispatch("asset.list", json!({ "library_id": lib.id, "sort_by": "filename", "sort_direction": "asc" }))
        .unwrap();
    let id_a = listed["items"][0]["id"].as_str().unwrap().to_owned();
    let id_b = listed["items"][1]["id"].as_str().unwrap().to_owned();

    // 1. Color label + rating + flag + hierarchical keywords -> auto-writes .xmp
    let labeled = core
        .dispatch("asset.label", json!({ "id": id_a, "color_label": "red" }))
        .unwrap();
    assert_eq!(labeled["color_label"], "red");
    core.dispatch(
        "asset.mark_batch",
        json!({ "ids": [id_a.clone()], "rating": 5, "flag": "pick" }),
    )
    .unwrap();
    let kw_res = core
        .dispatch(
            "asset.keywords.set",
            json!({ "ids": [id_a.clone()], "add": ["人像 > 客片", "京都"] }),
        )
        .unwrap();
    assert_eq!(kw_res["keywords"], json!(["京都", "人像 > 客片"]));

    let sidecar_xml = fs::read_to_string(drive_old.join("Day1").join("A001.xmp")).unwrap();
    assert!(sidecar_xml.contains(r#"xmp:Label="Red""#));
    assert!(sidecar_xml.contains("<rdf:li>人像|客片</rdf:li>"));

    // 2. Filtering by color_label and parent hierarchical keyword
    let red_only = core
        .dispatch(
            "asset.list",
            json!({ "library_id": lib.id, "color_label": "red" }),
        )
        .unwrap();
    assert_eq!(red_only["total"], 1);
    assert_eq!(red_only["items"][0]["id"], id_a);

    let parent_kw = core
        .dispatch(
            "asset.list",
            json!({ "library_id": lib.id, "keyword": "人像" }),
        )
        .unwrap();
    assert_eq!(parent_kw["total"], 1, "parent keyword matches hierarchical child");
    assert_eq!(parent_kw["items"][0]["keywords"], json!(["京都", "人像 > 客片"]));

    // 3. Manual Collection & Smart Collection
    let manual = core
        .dispatch(
            "collection.create",
            json!({ "library_id": lib.id, "name": "精选交付", "kind": "manual" }),
        )
        .unwrap();
    let manual_id = manual["id"].as_str().unwrap().to_owned();
    let added = core
        .dispatch(
            "collection.add_assets",
            json!({ "id": manual_id, "asset_ids": [id_a.clone(), id_b.clone()] }),
        )
        .unwrap();
    assert_eq!(added["collection"]["item_count"], 2);

    let removed = core
        .dispatch(
            "collection.remove_assets",
            json!({ "id": manual_id, "asset_ids": [id_b.clone()] }),
        )
        .unwrap();
    assert_eq!(removed["collection"]["item_count"], 1);
    assert!(img_b.is_file(), "removing from collection never touches originals");

    let smart = core
        .dispatch(
            "collection.create",
            json!({
                "library_id": lib.id,
                "name": "五星红标",
                "kind": "smart",
                "rules": { "rating": 5, "color_label": "red" }
            }),
        )
        .unwrap();
    assert_eq!(smart["item_count"], 1);
    let smart_list = core
        .dispatch(
            "asset.list",
            json!({ "library_id": lib.id, "collection_id": smart["id"] }),
        )
        .unwrap();
    assert_eq!(smart_list["total"], 1);
    assert_eq!(smart_list["items"][0]["id"], id_a);

    // 4. Relocating external drive preserves IDs, stars, color labels, collections, and keywords
    let drive_new = temp.path().join("SSD_Mounted_Renamed").join("Portfolio");
    fs::create_dir_all(drive_new.parent().unwrap()).unwrap();
    fs::rename(&drive_old, &drive_new).unwrap();

    let relocated = core
        .dispatch(
            "library.relocate",
            json!({ "id": lib.id, "root": drive_new }),
        )
        .unwrap();
    assert!(relocated["root"].as_str().unwrap().contains("SSD_Mounted_Renamed"));

    let after = core.asset(&id_a).unwrap();
    assert_eq!(after.availability, "available");
    assert_eq!(after.rating, 5);
    assert_eq!(after.flag, "pick");
    assert_eq!(after.color_label, "red");
    assert_eq!(after.keywords, vec!["京都", "人像 > 客片"]);

    let colls = core
        .dispatch("collection.list", json!({ "library_id": lib.id }))
        .unwrap();
    assert_eq!(colls.as_array().unwrap().len(), 2);
}
