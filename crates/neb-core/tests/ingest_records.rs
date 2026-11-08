use std::fs;

use image::{Rgb, RgbImage};
use neb_core::{CardIdentity, Core, ImportBatch};
use serde_json::json;

fn identity(path: &str, label: &str, serial: &str) -> CardIdentity {
    CardIdentity {
        mount_path: path.into(),
        volume_label: Some(label.into()),
        volume_serial: Some(serial.into()),
        capacity_bytes: Some(64_000_000_000),
    }
}

#[test]
fn cards_register_rebind_hints_and_presets() {
    let temp = tempfile::tempdir().unwrap();
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let card = core
        .register_card(
            &id,
            "Z8 主卡",
            &identity("/Volumes/NIKON", "NIKON Z8", "AB12"),
        )
        .unwrap();
    assert_eq!(card.name, "Z8 主卡");
    assert!(core
        .locations()
        .unwrap()
        .iter()
        .any(|l| l.id == card.location_id && l.kind == "removable"));
    assert!(core
        .register_card(&id, "again", &identity("/x", "a", "b"))
        .is_err());
    assert!(core
        .register_card("not-a-uuid", "x", &identity("/x", "a", "b"))
        .is_err());
    // A formatted card loses its identity file: same serial is a hint, never a match.
    let hints = core
        .card_candidates(&identity("/Volumes/NO NAME", "NO NAME", "AB12"))
        .unwrap();
    assert_eq!(hints.len(), 1);
    assert!(core
        .card_candidates(&identity("/Volumes/OTHER", "OTHER", "ZZ99"))
        .unwrap()
        .is_empty());
    let seen = core
        .card_seen(&id, &identity("/Volumes/NIKON 1", "NIKON Z8", "CD34"))
        .unwrap();
    assert_eq!(seen.last_mount_path.as_deref(), Some("/Volumes/NIKON 1"));
    assert_eq!(seen.volume_serial.as_deref(), Some("CD34"));
    // Presets
    let root = temp.path().join("photos");
    fs::create_dir(&root).unwrap();
    let library = core.add_library("相册", &root).unwrap();
    let preset = core
        .save_import_preset(
            None,
            "按日",
            &library.id,
            &json!({"date_basis":"capture"}),
            true,
        )
        .unwrap();
    let card = core
        .update_card(&id, Some("改名"), Some(Some(&preset.id)))
        .unwrap();
    assert_eq!(card.default_preset_id.as_deref(), Some(preset.id.as_str()));
    assert!(core.update_card(&id, None, Some(Some("missing"))).is_err());
    core.remove_import_preset(&preset.id).unwrap();
    assert!(core.card(&id).unwrap().default_preset_id.is_none());
    core.remove_card(&id).unwrap();
    assert!(core.cards().unwrap().is_empty());
    assert!(!core
        .locations()
        .unwrap()
        .iter()
        .any(|l| l.kind == "removable"));
}

#[test]
fn batches_tag_only_copied_assets_and_filter_listing() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("photos");
    fs::create_dir(&root).unwrap();
    for name in ["new.png", "old.png"] {
        RgbImage::from_pixel(4, 4, Rgb([1, 2, 3]))
            .save(root.join(name))
            .unwrap();
    }
    let core = Core::open(temp.path().join("catalog")).unwrap();
    let library = core.add_library("库", &root).unwrap();
    core.dispatch("library.scan", json!({"library_id":library.id}))
        .unwrap();
    let canonical = dunce::canonicalize(&root).unwrap();
    let batch = core
        .record_import_batch(
            &ImportBatch {
                id: "batch-1".into(),
                library_id: library.id.clone(),
                card_id: None,
                source: "/Volumes/NIKON".into(),
                rules: json!({"date_basis":"capture"}),
                started_at: "2026-10-23T08:00:00Z".into(),
                finished_at: Some("2026-10-23T08:01:00Z".into()),
                status: "completed".into(),
                copied: 1,
                duplicates: 1,
                failed: 0,
                asset_count: 0,
            },
            &[(
                canonical.join("new.png").to_string_lossy().into_owned(),
                "ab".repeat(32),
            )],
        )
        .unwrap();
    assert_eq!(batch.asset_count, 1);
    let listed = core
        .dispatch(
            "asset.list",
            json!({"library_id":library.id,"import_batch_id":"batch-1"}),
        )
        .unwrap();
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["items"][0]["filename"], "new.png");
    assert_eq!(core.import_batches(&library.id).unwrap().len(), 1);
    core.remove_library(&library.id).unwrap();
    assert!(core.import_batch("batch-1").is_err());
}
