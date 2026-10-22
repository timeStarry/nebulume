use neb_service::Service;
use serde_json::json;
use std::fs;

#[test]
fn card_registration_binding_and_import_batches() {
    let data = tempfile::tempdir().unwrap();
    let card = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::create_dir_all(card.path().join("DCIM/100")).unwrap();
    fs::write(card.path().join("DCIM/100/a.NEF"), b"raw bytes").unwrap();
    let svc = Service::open(data.path()).unwrap();
    let mount = json!({
        "mount_path": card.path(),
        "volume_label": "NIKON Z8",
        "volume_serial": "AB12",
        "capacity_bytes": 64_000_000_000u64
    });
    assert_eq!(
        svc.execute("card.identify", mount.clone()).unwrap()["status"],
        "unknown"
    );
    let mut register = mount.clone();
    register["name"] = json!("Z8 主卡");
    let registered = svc.execute("card.register", register.clone()).unwrap();
    let id = registered["id"].as_str().unwrap().to_owned();
    assert!(card.path().join(".nebulume/volume.json").exists());
    assert_eq!(
        svc.execute("card.register", register).unwrap_err().code,
        "E_CONFLICT"
    );
    let known = svc.execute("card.identify", mount.clone()).unwrap();
    assert_eq!(known["status"], "known");
    assert_eq!(known["card"]["id"], id);
    // Simulate formatting: the identity file is gone, the serial still hints.
    fs::remove_dir_all(card.path().join(".nebulume")).unwrap();
    let formatted = svc.execute("card.identify", mount.clone()).unwrap();
    assert_eq!(formatted["status"], "unknown");
    assert_eq!(formatted["candidates"][0]["id"], id);
    let mut bind = mount.clone();
    bind["card_id"] = json!(id);
    svc.execute("card.bind", bind).unwrap();
    assert_eq!(
        svc.execute("card.identify", mount).unwrap()["status"],
        "known"
    );
    // Original photos on the card are untouched.
    assert_eq!(
        fs::read(card.path().join("DCIM/100/a.NEF")).unwrap(),
        b"raw bytes"
    );

    let library = svc
        .execute("library.add", json!({"name":"相册","root":photos.path()}))
        .unwrap();
    let preset = svc
        .execute(
            "preset.save",
            json!({"name":"按日","library_id":library["id"],"rules":{"date_basis":"import","type_split":"by_kind"}}),
        )
        .unwrap();
    assert_eq!(preset["rules"]["type_split"], "by_kind");
    assert_eq!(
        svc.execute(
            "preset.save",
            json!({"name":"坏","library_id":library["id"],"rules":{"date_basis":"capture","subfolder":"../x"}})
        )
        .unwrap_err()
        .code,
        "E_INVALID"
    );
    svc.execute(
        "card.update",
        json!({"id":id,"default_preset_id":preset["id"]}),
    )
    .unwrap();
    let plan = svc
        .execute(
            "import.plan",
            json!({"source":card.path(),"destination":photos.path(),"rules":preset["rules"]}),
        )
        .unwrap();
    let result = svc
        .execute("import.execute", json!({"plan_id":plan["id"],"card_id":id}))
        .unwrap();
    assert_eq!(result["copied"], 1);
    let batch = &result["batch"];
    assert_eq!(batch["card_id"], id);
    assert_eq!(batch["asset_count"], 1);
    assert_eq!(batch["rules"]["type_split"], "by_kind");
    let listed = svc
        .execute(
            "asset.list",
            json!({"library_id":library["id"],"import_batch_id":batch["id"]}),
        )
        .unwrap();
    assert_eq!(listed["total"], 1);
    assert_eq!(
        svc.execute("import.batches", json!({"library_id":library["id"]}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let cards = svc.execute("card.list", json!({})).unwrap();
    assert!(cards[0]["last_import_at"].is_string());
    // The identity file is not imported as a photo.
    assert!(!photos.path().join(".nebulume").exists());
}

#[test]
fn identify_reports_offline_paths_without_writing() {
    let data = tempfile::tempdir().unwrap();
    let svc = Service::open(data.path()).unwrap();
    let missing = data.path().join("not-mounted");
    assert_eq!(
        svc.execute("card.identify", json!({"mount_path":missing}))
            .unwrap_err()
            .code,
        "E_OFFLINE"
    );
    assert!(!missing.exists());
}
