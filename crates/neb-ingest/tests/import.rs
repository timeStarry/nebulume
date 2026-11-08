use neb_ingest::IngestService;
use std::fs;

#[test]
fn import_is_verified_non_destructive_and_idempotent_after_restart() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::create_dir(source.path().join("DCIM")).unwrap();
    fs::write(source.path().join("DCIM/photo.CR3"), b"camera original").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    assert_eq!(plan.items.len(), 1);
    assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.copied, 1);
    assert_eq!(result.failed, 0);
    assert_eq!(
        fs::read(source.path().join("DCIM/photo.CR3")).unwrap(),
        b"camera original"
    );
    assert_eq!(
        fs::read(destination.path().join("DCIM/photo.CR3")).unwrap(),
        b"camera original"
    );
    let mut restarted = IngestService::open(state.path()).unwrap();
    assert!(restarted.execute(&plan.id).is_err());
    let plan = restarted
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    assert_eq!(plan.duplicate_count, 1);
    let result = restarted.execute(&plan.id).unwrap();
    assert_eq!(result.copied, 0);
    assert_eq!(result.duplicates, 1);
    assert_eq!(restarted.history().unwrap().len(), 2);
}

#[test]
fn same_size_is_not_duplicate_and_conflicts_never_overwrite() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("photo.jpg"), b"new").unwrap();
    fs::write(destination.path().join("photo.jpg"), b"old").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    assert_eq!(plan.duplicate_count, 0);
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.copied, 1);
    assert_eq!(
        fs::read(destination.path().join("photo.jpg")).unwrap(),
        b"old"
    );
    assert_eq!(fs::read(&result.items[0].destination).unwrap(), b"new");
}

#[test]
fn renamed_duplicates_are_reverified_at_execution() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("photo.jpg"), b"new").unwrap();
    fs::write(destination.path().join("renamed.jpg"), b"new").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    assert_eq!(plan.duplicate_count, 1);
    fs::write(destination.path().join("renamed.jpg"), b"old").unwrap();
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.copied, 1);
    assert_eq!(result.duplicates, 0);
    assert_eq!(
        fs::read(destination.path().join("photo.jpg")).unwrap(),
        b"new"
    );
}

#[test]
fn changed_source_fails_individually_while_other_files_copy() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("a.jpg"), b"original").unwrap();
    fs::write(source.path().join("b.jpg"), b"good").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    fs::write(source.path().join("a.jpg"), b"changed original").unwrap();
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.status, "partial");
    assert_eq!(result.failed, 1);
    assert_eq!(result.copied, 1);
    assert!(!destination.path().join("a.jpg").exists());
    assert!(source.path().join("a.jpg").exists());
}

#[test]
fn missing_capture_date_is_explicit_and_nested_destination_is_rejected() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(
        source.path().join("photo.nef"),
        b"synthetic unsupported raw",
    )
    .unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "date", true)
        .unwrap();
    assert_eq!(plan.items[0].relative_path, "unknown-date/photo.nef");
    assert_eq!(plan.items[0].date_source, "unknown");
    assert!(service
        .plan(
            source.path(),
            source.path().join("destination"),
            "preserve",
            true
        )
        .is_err());
}

#[test]
fn capture_date_layout_uses_exif_camera_date() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("capture.tif"), exif_tiff("2020:02:29")).unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "date", true)
        .unwrap();
    assert_eq!(plan.items[0].date_source, "exif");
    assert_eq!(plan.items[0].relative_path, "2020-02-29/capture.tif");
}

fn exif_tiff(date: &str) -> Vec<u8> {
    // Little-endian TIFF with IFD0 -> Exif IFD -> DateTimeOriginal.
    let mut tiff = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x8769u16.to_le_bytes());
    tiff.extend_from_slice(&4u16.to_le_bytes());
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&26u32.to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x9003u16.to_le_bytes());
    tiff.extend_from_slice(&2u16.to_le_bytes());
    tiff.extend_from_slice(&20u32.to_le_bytes());
    tiff.extend_from_slice(&44u32.to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend_from_slice(format!("{date} 23:59:59\0").as_bytes());
    tiff
}

fn exif_jpeg(date: &str) -> Vec<u8> {
    let mut exif = b"Exif\0\0".to_vec();
    exif.extend_from_slice(&exif_tiff(date));
    let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
    jpeg.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    jpeg.extend_from_slice(&exif);
    jpeg.extend_from_slice(&[0xff, 0xd9]);
    jpeg
}

#[test]
fn raw_and_xmp_inherit_only_the_same_directory_and_stem_anchor() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::create_dir_all(source.path().join("DCIM/100CAM")).unwrap();
    fs::create_dir_all(source.path().join("DCIM/200CAM")).unwrap();
    let jpeg = exif_jpeg("2024:05:06");
    fs::write(source.path().join("DCIM/100CAM/SHOT.JPG"), &jpeg).unwrap();
    fs::write(
        source.path().join("DCIM/100CAM/SHOT.NEF"),
        b"raw without exif",
    )
    .unwrap();
    fs::write(source.path().join("DCIM/100CAM/SHOT.xmp"), b"sidecar").unwrap();
    fs::write(source.path().join("DCIM/200CAM/SHOT.xmp"), b"sidecar").unwrap();
    fs::write(source.path().join("DCIM/100CAM/OTHER.xmp"), b"sidecar").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "date", true)
        .unwrap();
    for (source_key, target, provenance) in [
        ("DCIM/100CAM/SHOT.JPG", "2024-05-06/SHOT.JPG", "exif"),
        ("DCIM/100CAM/SHOT.NEF", "2024-05-06/SHOT.NEF", "paired_exif"),
        ("DCIM/100CAM/SHOT.xmp", "2024-05-06/SHOT.xmp", "paired_exif"),
        ("DCIM/200CAM/SHOT.xmp", "unknown-date/SHOT.xmp", "unknown"),
        ("DCIM/100CAM/OTHER.xmp", "unknown-date/OTHER.xmp", "unknown"),
    ] {
        let item = plan
            .items
            .iter()
            .find(|item| item.source_relative_path == source_key)
            .unwrap();
        assert_eq!(item.relative_path, target);
        assert_eq!(item.date_source, provenance);
    }
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.copied, 5);
    assert_eq!(result.failed, 0);
    assert_eq!(
        fs::read(destination.path().join("2024-05-06/SHOT.JPG")).unwrap(),
        jpeg
    );
    assert_eq!(
        fs::read(destination.path().join("2024-05-06/SHOT.NEF")).unwrap(),
        b"raw without exif"
    );
    assert_eq!(
        fs::read(destination.path().join("2024-05-06/SHOT.xmp")).unwrap(),
        b"sidecar"
    );
    assert_eq!(
        fs::read(source.path().join("DCIM/100CAM/SHOT.NEF")).unwrap(),
        b"raw without exif"
    );
}

#[test]
fn conflicting_capture_dates_do_not_assign_an_arbitrary_sidecar_date() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("SHOT.NEF"), exif_tiff("2024:05:06")).unwrap();
    fs::write(source.path().join("SHOT.JPG"), exif_jpeg("2024:05:07")).unwrap();
    fs::write(source.path().join("SHOT.xmp"), b"sidecar").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "date", true)
        .unwrap();
    assert!(plan
        .warnings
        .iter()
        .any(|warning| warning.contains("Conflicting EXIF capture dates")
            && warning.contains("2024-05-06")
            && warning.contains("2024-05-07")));
    let xmp = plan
        .items
        .iter()
        .find(|item| item.source_relative_path == "SHOT.xmp")
        .unwrap();
    assert_eq!(xmp.relative_path, "unknown-date/SHOT.xmp");
    assert_eq!(xmp.date_source, "unknown");
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.copied, 3);
    assert!(destination.path().join("2024-05-06/SHOT.NEF").is_file());
    assert!(destination.path().join("2024-05-07/SHOT.JPG").is_file());
    assert!(destination.path().join("unknown-date/SHOT.xmp").is_file());
}

#[test]
fn identical_bytes_do_not_merge_different_photo_formats_or_sidecar_groups() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let image = exif_tiff("2024:05:06");
    for name in ["A.NEF", "A.JPG", "B.JPG", "C.NEF", "C.JPG"] {
        fs::write(source.path().join(name), &image).unwrap();
    }
    for name in ["A.xmp", "B.xmp"] {
        fs::write(source.path().join(name), b"identical edits").unwrap();
    }
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "date", true)
        .unwrap();
    assert_eq!(plan.duplicate_count, 0);
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.copied, 7);
    for name in [
        "A.NEF", "A.JPG", "B.JPG", "C.NEF", "C.JPG", "A.xmp", "B.xmp",
    ] {
        assert!(destination.path().join("2024-05-06").join(name).is_file());
        assert!(source.path().join(name).is_file());
    }
    let repeated = service
        .plan(source.path(), destination.path(), "date", true)
        .unwrap();
    assert_eq!(repeated.duplicate_count, 7);
    assert_eq!(service.execute(&repeated.id).unwrap().duplicates, 7);
}

#[test]
fn sidecar_group_conflicts_fail_without_independent_filename_suffixes() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("SHOT.NEF"), b"new raw").unwrap();
    fs::write(source.path().join("SHOT.xmp"), b"new edits").unwrap();
    fs::write(destination.path().join("SHOT.NEF"), b"existing raw").unwrap();
    fs::write(destination.path().join("SHOT.xmp"), b"existing edits").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.failed, 2);
    assert_eq!(result.copied, 0);
    assert!(result.items.iter().all(|item| item
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("Choose a new destination directory")));
    assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 2);
    assert_eq!(
        fs::read(destination.path().join("SHOT.NEF")).unwrap(),
        b"existing raw"
    );
    assert_eq!(
        fs::read(destination.path().join("SHOT.xmp")).unwrap(),
        b"existing edits"
    );
    assert_eq!(
        fs::read(source.path().join("SHOT.NEF")).unwrap(),
        b"new raw"
    );
    assert_eq!(
        fs::read(source.path().join("SHOT.xmp")).unwrap(),
        b"new edits"
    );

    // Identical occupied names are reusable only when deduplication is enabled.
    fs::write(destination.path().join("SHOT.NEF"), b"new raw").unwrap();
    fs::write(destination.path().join("SHOT.xmp"), b"new edits").unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", false)
        .unwrap();
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.failed, 2);
    assert_eq!(result.copied, 0);
    assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 2);
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.duplicates, 2);
    assert_eq!(result.failed, 0);
}

#[test]
fn an_existing_raw_conflict_blocks_its_new_sidecar_before_publication() {
    assert_one_sided_companion_conflict("SHOT.NEF", b"old raw", "SHOT.xmp");
}

#[test]
fn an_existing_sidecar_conflict_blocks_its_new_raw_before_publication() {
    assert_one_sided_companion_conflict("SHOT.xmp", b"old edits", "SHOT.NEF");
}

fn assert_one_sided_companion_conflict(occupied: &str, old_content: &[u8], absent: &str) {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("SHOT.NEF"), b"new raw").unwrap();
    fs::write(source.path().join("SHOT.xmp"), b"new edits").unwrap();
    fs::write(destination.path().join(occupied), old_content).unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.failed, 2);
    assert_eq!(result.copied, 0);
    assert!(!destination.path().join(absent).exists());
    assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 1);
    assert_eq!(
        fs::read(destination.path().join(occupied)).unwrap(),
        old_content
    );
    assert_eq!(
        fs::read(source.path().join("SHOT.NEF")).unwrap(),
        b"new raw"
    );
    assert_eq!(
        fs::read(source.path().join("SHOT.xmp")).unwrap(),
        b"new edits"
    );
}

#[test]
fn a_member_failure_retains_completed_files_but_stops_later_companions() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("SHOT.JPG"), b"jpeg").unwrap();
    fs::write(source.path().join("SHOT.NEF"), b"raw").unwrap();
    fs::write(source.path().join("SHOT.xmp"), b"edits").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    // The JPG is published first; the changed RAW must stop the following XMP.
    fs::write(source.path().join("SHOT.NEF"), b"changed raw").unwrap();
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.status, "partial");
    assert_eq!(result.copied, 1);
    assert_eq!(result.failed, 2);
    assert_eq!(
        fs::read(destination.path().join("SHOT.JPG")).unwrap(),
        b"jpeg"
    );
    assert!(!destination.path().join("SHOT.NEF").exists());
    assert!(!destination.path().join("SHOT.xmp").exists());
    let xmp = result
        .items
        .iter()
        .find(|item| item.source.ends_with("SHOT.xmp"))
        .unwrap();
    assert!(xmp
        .error
        .as_deref()
        .unwrap()
        .contains("companion group stopped"));
    assert_eq!(fs::read(source.path().join("SHOT.xmp")).unwrap(), b"edits");
}

#[test]
fn date_layout_does_not_mix_same_stem_groups_from_different_source_folders() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::create_dir(source.path().join("camera-a")).unwrap();
    fs::create_dir(source.path().join("camera-b")).unwrap();
    fs::write(
        source.path().join("camera-a/SHOT.NEF"),
        exif_tiff("2024:05:06"),
    )
    .unwrap();
    fs::write(source.path().join("camera-a/SHOT.xmp"), b"edits a").unwrap();
    fs::write(
        source.path().join("camera-b/SHOT.JPG"),
        exif_jpeg("2024:05:06"),
    )
    .unwrap();
    fs::write(source.path().join("camera-b/SHOT.xmp"), b"edits b").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "date", true)
        .unwrap();
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.failed, 4);
    assert_eq!(result.copied, 0);
    assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
    assert!(result.items.iter().all(|item| item
        .error
        .as_deref()
        .unwrap()
        .contains("Multiple source groups")));
}

#[cfg(windows)]
#[test]
fn unreadable_member_excludes_its_entire_companion_group_during_planning() {
    use std::os::windows::fs::OpenOptionsExt;
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("SHOT.NEF"), b"raw").unwrap();
    fs::write(source.path().join("SHOT.xmp"), b"edits").unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(source.path().join("SHOT.NEF"))
        .unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    assert!(plan.items.is_empty());
    assert_eq!(plan.total_bytes, 0);
    assert!(plan
        .warnings
        .iter()
        .any(|warning| warning.contains("Incomplete XMP companion group SHOT")));
    drop(locked);
    assert_eq!(service.execute(&plan.id).unwrap().total, 0);
    assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
    assert_eq!(fs::read(source.path().join("SHOT.NEF")).unwrap(), b"raw");
}

#[test]
fn disabling_deduplication_copies_identical_content_with_a_new_name() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("photo.jpg"), b"same").unwrap();
    fs::write(destination.path().join("photo.jpg"), b"same").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", false)
        .unwrap();
    assert_eq!(plan.duplicate_count, 0);
    assert_eq!(plan.total_bytes, 4);
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.copied, 1);
    assert_eq!(result.duplicates, 0);
    assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 2);
}

#[test]
fn duplicates_inside_one_batch_share_the_verified_destination() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("a.jpg"), b"same").unwrap();
    fs::write(source.path().join("b.jpg"), b"same").unwrap();
    // The first copy must use a conflict suffix; the second must find that actual path.
    fs::write(destination.path().join("a.jpg"), b"different").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    assert_eq!(plan.duplicate_count, 1);
    assert_eq!(plan.total_bytes, 4);
    let result = service.execute(&plan.id).unwrap();
    assert_eq!(result.copied, 1);
    assert_eq!(result.duplicates, 1);
    assert_eq!(result.items[0].destination, result.items[1].destination);
    assert!(!destination.path().join("b.jpg").exists());
}

#[cfg(unix)]
#[test]
fn linked_source_file_is_not_imported() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(state.path().join("secret.jpg"), b"secret").unwrap();
    std::os::unix::fs::symlink(
        state.path().join("secret.jpg"),
        source.path().join("photo.jpg"),
    )
    .unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    assert!(plan.items.is_empty());
    assert!(!plan.warnings.is_empty());
}

#[test]
fn structured_rules_split_types_keep_sidecars_with_raw_and_freeze_import_day() {
    use neb_ingest::OrganizeRules;
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::create_dir_all(source.path().join("DCIM/100")).unwrap();
    fs::write(source.path().join("DCIM/100/a.NEF"), b"raw bytes").unwrap();
    fs::write(source.path().join("DCIM/100/a.xmp"), b"<x/>").unwrap();
    fs::write(source.path().join("DCIM/100/a.JPG"), b"jpeg bytes").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let rules: OrganizeRules = serde_json::from_value(serde_json::json!({
        "date_basis": "import",
        "date_layout": "Y/Y-M-D",
        "type_split": "by_kind",
        "subfolder": "Z8"
    }))
    .unwrap();
    let plan = service
        .plan_with_rules(source.path(), destination.path(), &rules, true)
        .unwrap();
    let day = &plan.import_day;
    let year = &day[..4];
    let mut targets: Vec<_> = plan.items.iter().map(|i| i.relative_path.clone()).collect();
    targets.sort();
    assert_eq!(
        targets,
        [
            format!("Z8/{year}/{day}/JPG/a.JPG"),
            format!("Z8/{year}/{day}/RAW/a.NEF"),
            format!("Z8/{year}/{day}/RAW/a.xmp"),
        ]
    );
    assert!(plan.items.iter().all(|i| i.date_source == "import_date"));
    assert_eq!(plan.rules, rules);
    let result = service.execute(&plan.id).unwrap();
    assert_eq!((result.copied, result.failed), (3, 0));
    assert!(destination
        .path()
        .join(format!("Z8/{year}/{day}/RAW/a.xmp"))
        .exists());
    // Originals are retained.
    assert!(source.path().join("DCIM/100/a.NEF").exists());
}

#[test]
fn unknown_capture_dates_stay_unknown_unless_modified_time_is_chosen() {
    use neb_ingest::OrganizeRules;
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(source.path().join("no-exif.jpg"), b"not really a jpeg").unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let default = service
        .plan_with_rules(
            source.path(),
            destination.path(),
            &OrganizeRules::default(),
            true,
        )
        .unwrap();
    assert_eq!(default.items[0].relative_path, "unknown-date/no-exif.jpg");
    assert_eq!(default.items[0].date_source, "unknown");
    let rules: OrganizeRules = serde_json::from_value(
        serde_json::json!({"date_basis":"capture","unknown_date":"modified_time"}),
    )
    .unwrap();
    let fallback = service
        .plan_with_rules(source.path(), destination.path(), &rules, true)
        .unwrap();
    assert_eq!(fallback.items[0].date_source, "modified_time");
    assert!(!fallback.items[0].relative_path.starts_with("unknown-date/"));
    let bad: OrganizeRules =
        serde_json::from_value(serde_json::json!({"date_basis":"capture","subfolder":"../escape"}))
            .unwrap();
    assert!(service
        .plan_with_rules(source.path(), destination.path(), &bad, true)
        .is_err());
}
