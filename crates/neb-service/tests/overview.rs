//! Folder tree, folder filter and overview statistics agree with the grid.
use neb_service::Service;
use serde_json::{json, Value};
use std::fs;

fn jpeg_with(model: &str, iso: u16, focal: (u32, u32)) -> Vec<u8> {
    // Minimal EXIF: Model (0x0110) in IFD0, ISO (0x8827) and FocalLength (0x920a) in the EXIF IFD.
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II*\0");
    tiff.extend_from_slice(&8u32.to_le_bytes());
    let model_bytes = [model.as_bytes(), &[0]].concat();
    // IFD0 with two entries: Model and ExifIFD pointer.
    let ifd0 = 8u32;
    let ifd0_size = 2 + 2 * 12 + 4;
    let model_offset = ifd0 + ifd0_size;
    let exif_ifd = model_offset + model_bytes.len() as u32;
    let exif_size = 2 + 2 * 12 + 4;
    let focal_offset = exif_ifd + exif_size;
    tiff.extend_from_slice(&2u16.to_le_bytes());
    let entry = |tiff: &mut Vec<u8>, tag: u16, kind: u16, count: u32, value: u32| {
        tiff.extend_from_slice(&tag.to_le_bytes());
        tiff.extend_from_slice(&kind.to_le_bytes());
        tiff.extend_from_slice(&count.to_le_bytes());
        tiff.extend_from_slice(&value.to_le_bytes());
    };
    entry(&mut tiff, 0x0110, 2, model_bytes.len() as u32, model_offset);
    entry(&mut tiff, 0x8769, 4, 1, exif_ifd);
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend_from_slice(&model_bytes);
    tiff.extend_from_slice(&2u16.to_le_bytes());
    entry(&mut tiff, 0x8827, 3, 1, u32::from(iso));
    entry(&mut tiff, 0x920a, 5, 1, focal_offset);
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend_from_slice(&focal.0.to_le_bytes());
    tiff.extend_from_slice(&focal.1.to_le_bytes());
    let mut jpeg = Cursor::default();
    image::codecs::jpeg::JpegEncoder::new(&mut jpeg.0)
        .encode(
            &[90, 120, 200, 90, 120, 200],
            2,
            1,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
    bytes.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
    bytes.extend_from_slice(b"Exif\0\0");
    bytes.extend_from_slice(&tiff);
    bytes.extend_from_slice(&jpeg.0[2..]);
    bytes
}

#[derive(Default)]
struct Cursor(Vec<u8>);

fn names(result: &Value) -> Vec<String> {
    let mut names: Vec<String> = result["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["filename"].as_str().unwrap().to_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn folders_counts_filters_and_stats_match_the_grid() {
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let kyoto = root.path().join("Kyoto").join("01 Arashiyama");
    let nara = root.path().join("Nara");
    fs::create_dir_all(&kyoto).unwrap();
    fs::create_dir_all(&nara).unwrap();
    fs::write(kyoto.join("A.jpg"), jpeg_with("Z 6II", 100, (35, 1))).unwrap();
    fs::write(kyoto.join("A.nef"), b"raw sibling").unwrap();
    fs::write(kyoto.join("B.jpg"), jpeg_with("Z 6II", 1600, (85, 1))).unwrap();
    fs::write(nara.join("C.jpg"), jpeg_with("X-T5", 400, (33, 1))).unwrap();
    fs::write(
        root.path().join("loose.jpg"),
        jpeg_with("X-T5", 200, (24, 1)),
    )
    .unwrap();
    let svc = Service::open(data.path()).unwrap();
    let library = svc
        .execute(
            "library.add",
            json!({"name":"旅行","root":root.path(),"pair_raw_jpeg":true}),
        )
        .unwrap();
    let id = library["id"].as_str().unwrap().to_owned();
    svc.execute("library.scan", json!({"library_id":id}))
        .unwrap();

    let tree = svc
        .execute("library.folders", json!({"library_id":id}))
        .unwrap();
    assert_eq!(tree["total"], 4, "the RAW + JPEG pair counts once: {tree}");
    let folders = tree["folders"].as_array().unwrap();
    assert_eq!(folders.len(), 2);
    let kyoto_node = folders.iter().find(|f| f["name"] == "Kyoto").unwrap();
    assert_eq!(kyoto_node["count"], 2);
    assert_eq!(kyoto_node["children"][0]["path"], "Kyoto/01 Arashiyama");
    assert_eq!(kyoto_node["children"][0]["count"], 2);

    let in_kyoto = svc
        .execute("asset.list", json!({"library_id":id,"folder":"Kyoto"}))
        .unwrap();
    assert_eq!(names(&in_kyoto), ["A.jpg", "B.jpg"]);
    assert_eq!(in_kyoto["total"], 2);
    // A folder name that is only a prefix of another does not match it.
    assert_eq!(
        svc.execute("asset.list", json!({"library_id":id,"folder":"Kyo"}))
            .unwrap()["total"],
        0
    );

    let a = in_kyoto["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["filename"] == "A.jpg")
        .unwrap()["id"]
        .clone();
    svc.execute("asset.flag", json!({"id":a,"flag":"pick"}))
        .unwrap();
    let stats = svc
        .execute("asset.stats", json!({"library_id":id}))
        .unwrap();
    assert_eq!(
        (
            &stats["photos"],
            &stats["files"],
            &stats["picks"],
            &stats["unprocessed"]
        ),
        (&json!(4), &json!(5), &json!(1), &json!(3)),
        "{stats}"
    );
    // Ties rank by name.
    assert_eq!(
        stats["cameras"],
        json!([{"name":"X-T5","count":2},{"name":"Z 6II","count":2}])
    );
    let iso_1600 = stats["iso"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bin| bin["label"] == "1600")
        .unwrap()
        .clone();
    assert_eq!(iso_1600["count"], 1);
    // Every bin doubles as a filter that lists exactly the photos it counted.
    let listed = svc
        .execute(
            "asset.list",
            json!({"library_id":id,"iso_min":iso_1600["min"],"iso_max":iso_1600["max"]}),
        )
        .unwrap();
    assert_eq!(names(&listed), ["B.jpg"]);
    let wide = svc
        .execute(
            "asset.list",
            json!({"library_id":id,"focal_min":24.0,"focal_max":35.99}),
        )
        .unwrap();
    assert_eq!(names(&wide), ["A.jpg", "C.jpg", "loose.jpg"]);
    // "Unprocessed": no flag and no rating.
    let untouched = svc
        .execute(
            "asset.list",
            json!({"library_id":id,"flag":"none","rating_max":0}),
        )
        .unwrap();
    assert_eq!(untouched["total"], 3);
    // Stats follow the same filter as the grid.
    let scoped = svc
        .execute("asset.stats", json!({"library_id":id,"folder":"Nara"}))
        .unwrap();
    assert_eq!(scoped["photos"], 1);
    assert_eq!(scoped["days"].as_array().unwrap().len(), 0);
    assert_eq!(scoped["undated"], 1);
}
