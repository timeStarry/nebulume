use std::{
    collections::HashSet,
    fs,
    sync::atomic::{AtomicBool, Ordering},
};

use neb_ingest::{
    organize::{DateBasis, DateLayout, OrganizeRules, RenameMode, TypeSplit, UnknownDate},
    ExecuteOptions, IngestService,
};

#[test]
fn rename_mode_keeps_raw_jpeg_and_xmp_companions_aligned_and_dual_backs_up() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let backup = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();

    let dcim = source.path().join("DCIM/100NIKON");
    fs::create_dir_all(&dcim).unwrap();
    fs::write(dcim.join("_DSC0010.NEF"), b"raw-bytes-10").unwrap();
    fs::write(dcim.join("_DSC0010.JPG"), b"jpg-bytes-10").unwrap();
    fs::write(dcim.join("_DSC0010.XMP"), b"<x:xmpmeta/>").unwrap();
    fs::write(dcim.join("_DSC0011.NEF"), b"raw-bytes-11").unwrap();

    let rules = OrganizeRules {
        date_basis: DateBasis::Import,
        date_layout: DateLayout::Day,
        type_split: TypeSplit::None,
        unknown_date: UnknownDate::Folder,
        subfolder: String::new(),
        rename_mode: RenameMode::DatePrefixSeq,
        rename_prefix: "Editorial".to_string(),
    };

    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan_with_options(
            source.path(),
            destination.path(),
            &rules,
            true,
            Some(backup.path()),
        )
        .unwrap();
    assert_eq!(plan.items.len(), 4);
    assert!(plan.backup_destination.is_some());

    // Select ONLY the `_DSC0010` RAW + JPG (companion `.XMP` must follow automatically!).
    let selected: HashSet<String> = plan
        .items
        .iter()
        .filter(|item| item.source.contains("_DSC0010.NEF") || item.source.contains("_DSC0010.JPG"))
        .map(|item| item.source.clone())
        .collect();

    let progress_events = std::sync::Mutex::new(Vec::new());
    let record_progress = |p: neb_ingest::ImportProgress| {
        progress_events.lock().unwrap().push(p);
    };

    let result = service
        .execute_with_options(
            &plan.id,
            ExecuteOptions {
                selected_sources: Some(selected),
                backup_destination: Some(backup.path().to_path_buf()),
                include_likely_duplicates: false,
                progress: Some(&record_progress),
                cancel: None,
            },
        )
        .unwrap();

    assert_eq!(result.status, "completed");
    assert_eq!(result.copied, 3, "RAW + JPG + companion XMP copied");
    assert_eq!(result.skipped_unselected, 1, "_DSC0011.NEF skipped");
    assert_eq!(result.backup_copied, 3, "all 3 verified on secondary backup disk");
    assert_eq!(result.backup_failed, 0);

    // Check companion stems match identically (`YYYYMMDD_Editorial_0001.{NEF,JPG,XMP}`).
    let copied_rel: Vec<&str> = plan
        .items
        .iter()
        .filter(|item| item.source.contains("_DSC0010"))
        .map(|item| item.relative_path.as_str())
        .collect();
    assert_eq!(copied_rel.len(), 3);
    let stems: HashSet<String> = copied_rel
        .iter()
        .map(|rel| rel.rsplit_once('.').unwrap().0.to_string())
        .collect();
    assert_eq!(stems.len(), 1, "RAW, JPEG, and XMP share the exact renamed stem");
    let stem = stems.into_iter().next().unwrap();
    assert!(stem.ends_with("_Editorial_0001"), "unexpected stem: {stem}");

    // Both primary destination and backup destination hold identical verified bytes.
    for rel in copied_rel {
        let primary_bytes = fs::read(destination.path().join(rel)).unwrap();
        let backup_bytes = fs::read(backup.path().join(rel)).unwrap();
        assert_eq!(primary_bytes, backup_bytes);
    }
    assert!(!progress_events.lock().unwrap().is_empty());
}

#[test]
fn cooperative_cancel_stops_cleanly_at_companion_group_boundary() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();

    fs::write(source.path().join("A001.NEF"), b"group-1-raw").unwrap();
    fs::write(source.path().join("A001.XMP"), b"group-1-xmp").unwrap();
    fs::write(source.path().join("A002.NEF"), b"group-2-raw").unwrap();

    let mut service = IngestService::open(state.path()).unwrap();
    let plan = service
        .plan(source.path(), destination.path(), "preserve", true)
        .unwrap();
    assert_eq!(plan.items.len(), 3);

    let cancel = AtomicBool::new(false);
    let trigger_cancel = |p: neb_ingest::ImportProgress| {
        if p.done_items >= 1 {
            cancel.store(true, Ordering::SeqCst);
        }
    };

    let result = service
        .execute_with_options(
            &plan.id,
            ExecuteOptions {
                selected_sources: None,
                backup_destination: None,
                include_likely_duplicates: false,
                progress: Some(&trigger_cancel),
                cancel: Some(&cancel),
            },
        )
        .unwrap();

    assert_eq!(result.status, "cancelled");
    assert_eq!(
        result.copied, 2,
        "companion group A001 (.NEF + .XMP) finishes atomically before stopping before A002"
    );
    assert!(destination.path().join("A001.NEF").exists());
    assert!(destination.path().join("A001.XMP").exists());
    assert!(!destination.path().join("A002.NEF").exists());
}
