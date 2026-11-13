use std::{fs, io::Cursor};

use image::{
    codecs::jpeg::{JpegDecoder, JpegEncoder},
    ImageDecoder, Rgb, RgbImage,
};
use neb_core::{xmp, Core};
use serde_json::json;

fn write_test_jpeg(path: &std::path::Path, width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut buf, 95)
        .encode_image(&RgbImage::from_pixel(width, height, Rgb(rgb)))
        .unwrap();
    let bytes = buf.into_inner();
    fs::write(path, &bytes).unwrap();
    bytes
}

#[test]
fn xmp_merge_preserves_foreign_lightroom_crs_settings_and_roundtrips_marks() {
    let dir = tempfile::tempdir().unwrap();
    let raw_like = dir.path().join("DSC_0100.JPG");
    let original_bytes = write_test_jpeg(&raw_like, 1200, 800, [190, 90, 60]);

    let sidecar_path = dir.path().join("DSC_0100.xmp");
    let adobe_xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmp:Rating="3"
    crs:Temperature="5450"
    crs:Exposure2012="+0.65">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>Portrait</rdf:li>
     <rdf:li>Studio</rdf:li>
    </rdf:Bag>
   </dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#;
    fs::write(&sidecar_path, adobe_xmp).unwrap();

    let state = tempfile::tempdir().unwrap();
    let core = Core::open(state.path()).unwrap();
    let lib = core
        .dispatch(
            "library.add",
            json!({ "name": "Studio", "root": dir.path(), "pair_raw_jpeg": true }),
        )
        .unwrap();
    let lib_id = lib["id"].as_str().unwrap();

    // Initial scan imports existing XMP rating = 3 without touching the original file.
    core.dispatch("library.scan", json!({ "library_id": lib_id }))
        .unwrap();
    let listed = core
        .dispatch("asset.list", json!({ "library_id": lib_id, "limit": 10 }))
        .unwrap();
    let asset_id = listed["items"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(listed["items"][0]["rating"].as_u64(), Some(3));

    // Enable auto-write policy and update rating, pick flag, and crop in Nebulume.
    let policy = core
        .dispatch("xmp.policy.set", json!({ "auto_write": true }))
        .unwrap();
    assert_eq!(policy["auto_write"].as_bool(), Some(true));
    assert_eq!(
        core.dispatch("xmp.policy.get", json!({})).unwrap()["auto_write"].as_bool(),
        Some(true)
    );

    core.dispatch("asset.rate", json!({ "id": asset_id, "rating": 5 }))
        .unwrap();
    core.dispatch("asset.flag", json!({ "id": asset_id, "flag": "pick" }))
        .unwrap();
    core.dispatch(
        "asset.crop",
        json!({ "id": asset_id, "x": 0.1, "y": 0.2, "width": 0.5, "height": 0.6 }),
    )
    .unwrap();

    // Verify foreign Adobe CRS attributes and Dublin Core subject tags survived untouched!
    let merged = fs::read_to_string(&sidecar_path).unwrap();
    assert!(
        merged.contains("5450"),
        "crs:Temperature must survive: {merged}"
    );
    assert!(
        merged.contains("+0.65"),
        "crs:Exposure2012 must survive: {merged}"
    );
    assert!(
        merged.contains("Portrait"),
        "dc:subject bag must survive: {merged}"
    );
    let parsed = xmp::parse_xmp_str(&merged).unwrap();
    assert_eq!(parsed.rating, Some(5));
    assert_eq!(parsed.flag.as_deref(), Some("pick"));
    let crop = parsed.crop.flatten().expect("crop present");
    assert!((crop.x - 0.1).abs() < 1e-4);
    assert!((crop.width - 0.5).abs() < 1e-4);

    // Simulate external editor rejecting (`Rating="-1"` in XMP) and clearing crop.
    xmp::write_sidecar_for_image(&raw_like, 0, "reject", None).unwrap();

    let read_report = core
        .dispatch("asset.xmp.read", json!({ "ids": [asset_id] }))
        .unwrap();
    assert_eq!(read_report["updated"].as_u64(), Some(1));
    assert_eq!(read_report["errors"].as_array().unwrap().len(), 0);

    let refreshed = core.asset(&asset_id).unwrap();
    assert_eq!(refreshed.rating, 0);
    assert_eq!(refreshed.flag, "reject");
    assert_eq!(refreshed.crop, None);

    // Verify `flush_asset_xmp_for_handoff` works even when auto_write is turned off.
    core.dispatch("xmp.policy.set", json!({ "auto_write": false }))
        .unwrap();
    core.dispatch("asset.rate", json!({ "id": asset_id, "rating": 4 }))
        .unwrap();
    let flushed = core
        .flush_asset_xmp_for_handoff(&asset_id)
        .unwrap()
        .expect("sidecar path");
    assert_eq!(
        fs::canonicalize(&flushed).unwrap(),
        fs::canonicalize(&sidecar_path).unwrap()
    );
    assert_eq!(
        xmp::parse_xmp_str(&fs::read_to_string(&sidecar_path).unwrap())
            .unwrap()
            .rating,
        Some(4)
    );

    // Original photo file is 100% byte-for-byte unchanged.
    assert_eq!(fs::read(&raw_like).unwrap(), original_bytes);
}

#[test]
fn export_with_options_resizes_embeds_target_icc_and_preserves_original() {
    let dir = tempfile::tempdir().unwrap();
    let photo_path = dir.path().join("wide_gamut.jpg");
    let original_bytes = write_test_jpeg(&photo_path, 2400, 1600, [220, 40, 30]);

    let state = tempfile::tempdir().unwrap();
    let core = Core::open(state.path()).unwrap();
    let lib = core
        .dispatch(
            "library.add",
            json!({ "name": "Delivery", "root": dir.path(), "pair_raw_jpeg": true }),
        )
        .unwrap();
    let lib_id = lib["id"].as_str().unwrap();
    core.dispatch("library.scan", json!({ "library_id": lib_id }))
        .unwrap();
    let listed = core
        .dispatch("asset.list", json!({ "library_id": lib_id, "limit": 10 }))
        .unwrap();
    let asset_id = listed["items"][0]["id"].as_str().unwrap();

    let out_dir = tempfile::tempdir().unwrap();
    let p3_out = out_dir.path().join("client_p3.jpg");
    let res = core
        .dispatch(
            "asset.export",
            json!({
                "id": asset_id,
                "destination": p3_out,
                "max_edge": 1200,
                "quality": 88,
                "color_space": "display_p3",
            }),
        )
        .unwrap();
    assert_eq!(
        fs::canonicalize(res["path"].as_str().unwrap()).unwrap(),
        fs::canonicalize(&p3_out).unwrap()
    );

    let exported_bytes = fs::read(&p3_out).unwrap();
    let mut decoder = JpegDecoder::new(Cursor::new(&exported_bytes)).unwrap();
    assert_eq!(decoder.dimensions(), (1200, 800));
    let icc = decoder
        .icc_profile()
        .unwrap()
        .expect("embedded Display P3 ICC");
    let ascii: String = icc.iter().map(|&b| b as char).collect();
    assert!(
        ascii.contains("Display P3"),
        "expected Display P3 ICC description"
    );

    let adobe_out = out_dir.path().join("print_adobe.jpg");
    core.dispatch(
        "asset.export",
        json!({
            "id": asset_id,
            "destination": adobe_out,
            "quality": 100,
            "color_space": "adobe_rgb",
        }),
    )
    .unwrap();
    let mut adobe_dec = JpegDecoder::new(Cursor::new(fs::read(&adobe_out).unwrap())).unwrap();
    assert_eq!(adobe_dec.dimensions(), (2400, 1600));
    let adobe_icc = adobe_dec
        .icc_profile()
        .unwrap()
        .expect("embedded Adobe RGB ICC");
    let adobe_ascii: String = adobe_icc.iter().map(|&b| b as char).collect();
    assert!(adobe_ascii.contains("Adobe RGB"));

    // Exporting to an existing destination path must never overwrite!
    assert!(core
        .dispatch(
            "asset.export",
            json!({ "id": asset_id, "destination": p3_out, "color_space": "srgb" }),
        )
        .is_err());

    // Source photo remains strictly read-only.
    assert_eq!(fs::read(&photo_path).unwrap(), original_bytes);
}
