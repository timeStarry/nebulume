use neb_service::Service;
use serde_json::{json, Value};
use std::{fs, time::Duration};

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

fn wait(svc: &Service, library: &Value) -> Value {
    for _ in 0..200 {
        let status = svc
            .execute("library.fingerprint.status", json!({"library_id":library}))
            .unwrap();
        let job = status["job"]["status"].as_str().unwrap_or("none");
        if !matches!(job, "running" | "stopping") {
            return status;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("fingerprint task did not finish");
}

#[test]
fn fingerprints_hash_local_originals_and_drop_stale_hashes_on_change() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("a.ppm"), PHOTO).unwrap();
    fs::write(photos.path().join("b.ppm"), b"P6\n1 1\n255\n\x01\x02\x03").unwrap();
    let svc = Service::open(data.path()).unwrap();
    let library = svc
        .execute("library.add", json!({"name":"库","root":photos.path()}))
        .unwrap();
    svc.execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let before = svc
        .execute(
            "library.fingerprint.status",
            json!({"library_id":library["id"]}),
        )
        .unwrap();
    assert_eq!(
        (before["total"].as_u64(), before["pending"].as_u64()),
        (Some(2), Some(2))
    );
    assert_eq!(before["remote"], false);
    svc.execute(
        "library.fingerprint.start",
        json!({"library_id":library["id"]}),
    )
    .unwrap();
    let done = wait(&svc, &library["id"]);
    assert_eq!(done["job"]["status"], "completed", "{done}");
    assert_eq!(done["job"]["hashed"], 2);
    assert_eq!(
        (done["known"].as_u64(), done["pending"].as_u64()),
        (Some(2), Some(0))
    );
    // Originals are unchanged by hashing.
    assert_eq!(fs::read(photos.path().join("a.ppm")).unwrap(), PHOTO);
    // Starting again with nothing pending completes immediately.
    let again = svc
        .execute(
            "library.fingerprint.start",
            json!({"library_id":library["id"]}),
        )
        .unwrap();
    assert_eq!(again["job"]["status"], "completed");
    // A changed file loses its stale hash on rescan.
    fs::write(photos.path().join("b.ppm"), b"P6\n1 1\n255\n\x09\x09\x09").unwrap();
    bump_modified(&photos.path().join("b.ppm"));
    svc.execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let rescanned = svc
        .execute(
            "library.fingerprint.status",
            json!({"library_id":library["id"]}),
        )
        .unwrap();
    assert_eq!(rescanned["pending"], 1, "{rescanned}");
    assert_eq!(rescanned["known"], 1, "the unchanged file keeps its hash");
}

/// Ensure the next scan sees a new modification stamp even on coarse clocks.
fn bump_modified(path: &std::path::Path) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(std::time::SystemTime::now() + Duration::from_secs(5))
        .unwrap();
}

#[test]
fn only_one_library_fingerprints_at_a_time_and_cancel_checks_the_job() {
    let data = tempfile::tempdir().unwrap();
    let svc = Service::open(data.path()).unwrap();
    let empty = tempfile::tempdir().unwrap();
    let library = svc
        .execute("library.add", json!({"name":"空","root":empty.path()}))
        .unwrap();
    let status = svc
        .execute(
            "library.fingerprint.start",
            json!({"library_id":library["id"]}),
        )
        .unwrap();
    assert_eq!(status["job"]["status"], "completed");
    assert_eq!(
        svc.execute(
            "library.fingerprint.cancel",
            json!({"library_id":library["id"],"job_id":"other"})
        )
        .unwrap_err()
        .code,
        "E_CONFLICT"
    );
}
