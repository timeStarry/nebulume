use neb_service::Service;
use serde_json::json;
use std::{
    fs,
    time::{Duration, Instant},
};

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

#[test]
fn quiesce_cancels_capture_jobs_and_reports_idle() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("photo.ppm"), PHOTO).unwrap();
    let service = Service::open(data.path()).unwrap();
    let library = service
        .execute("library.add", json!({"name":"相册","root":photos.path()}))
        .unwrap();
    service
        .execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    service
        .execute(
            "library.capture_index.start",
            json!({"library_id":library["id"]}),
        )
        .unwrap();
    let report = service.quiesce(Duration::from_secs(5)).unwrap();
    assert!(!report.timed_out);
    assert_eq!(report.pending_writes, 0);
    assert!(report.cancelled_jobs <= 1);
    let status = service
        .execute(
            "library.capture_index.status",
            json!({"library_id":library["id"]}),
        )
        .unwrap();
    let job_status = status["job"]["status"].as_str().unwrap();
    assert!(
        ["cancelled", "completed"].contains(&job_status),
        "unexpected status {job_status}"
    );
}

#[test]
fn quiesce_on_idle_service_returns_immediately() {
    let data = tempfile::tempdir().unwrap();
    let service = Service::open(data.path()).unwrap();
    let started = Instant::now();
    let report = service.quiesce(Duration::from_secs(5)).unwrap();
    assert!(started.elapsed() < Duration::from_millis(200));
    assert_eq!(report.cancelled_jobs, 0);
    assert_eq!(report.pending_writes, 0);
    assert!(!report.timed_out);
}
