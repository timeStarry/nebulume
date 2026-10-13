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
    tiff.extend_from_slice(b"2020:02:29 23:59:59\0");
    fs::write(source.path().join("capture.tif"), tiff).unwrap();
    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "date", true)
        .unwrap();
    assert_eq!(plan.items[0].date_source, "exif");
    assert_eq!(plan.items[0].relative_path, "2020-02-29/capture.tif");
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
