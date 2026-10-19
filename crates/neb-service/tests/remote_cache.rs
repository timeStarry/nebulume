use neb_service::Service;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Barrier, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";
const CHANGED_PHOTO: &[u8] = b"P6\n1 3\n255\n\x00\x00\xff\xff\x00\x00\x00\xff\x00";

#[derive(Clone)]
struct Request {
    method: String,
    ranged: bool,
    range_bytes: usize,
}
#[derive(Default)]
struct DownloadGate {
    paused: bool,
    entered: bool,
}
struct Server {
    endpoint: String,
    requests: Arc<Mutex<Vec<Request>>>,
    photo: Arc<Mutex<Vec<u8>>>,
    filename: Arc<Mutex<String>>,
    ranges: Arc<AtomicBool>,
    download_gate: Arc<(Mutex<DownloadGate>, Condvar)>,
    offline: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let photo = Arc::new(Mutex::new(PHOTO.to_vec()));
        let served_photo = photo.clone();
        let filename = Arc::new(Mutex::new("photo.ppm".to_owned()));
        let served_filename = filename.clone();
        let ranges = Arc::new(AtomicBool::new(false));
        let served_ranges = ranges.clone();
        let download_gate = Arc::new((Mutex::new(DownloadGate::default()), Condvar::new()));
        let served_gate = download_gate.clone();
        let offline = Arc::new(AtomicBool::new(false));
        let unavailable = offline.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            let mut connections = Vec::new();
            for stream in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let recorded = recorded.clone();
                let served_photo = served_photo.clone();
                let served_filename = served_filename.clone();
                let served_ranges = served_ranges.clone();
                let unavailable = unavailable.clone();
                let served_gate = served_gate.clone();
                connections.push(thread::spawn(move || {
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut headers = Vec::new();
                let mut byte = [0];
                while !headers.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        break;
                    }
                    headers.push(byte[0]);
                    assert!(headers.len() < 32 * 1024);
                }
                let text = String::from_utf8(headers).unwrap();
                let request_bytes = text
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                assert!(request_bytes < 32 * 1024);
                stream.read_exact(&mut vec![0; request_bytes]).unwrap();
                let mut parts = text.lines().next().unwrap().split_whitespace();
                let method = parts.next().unwrap().to_owned();
                let target = parts.next().unwrap();
                assert!(target.starts_with("/album/"));
                let range = text
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case("range"))
                    .map(|(_, value)| {
                        let (start,end) = value.trim().strip_prefix("bytes=").unwrap().split_once('-').unwrap();
                        (start.parse::<usize>().unwrap(), end.parse::<usize>().unwrap())
                    });
                let ranged = range.is_some();
                recorded.lock().unwrap().push(Request {
                    method: method.clone(),
                    ranged,
                    range_bytes: range.map_or(0, |(start, end)| end - start + 1),
                });
                let photo = served_photo.lock().unwrap().clone();
                let filename = served_filename.lock().unwrap().clone();
                let listing = format!("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/album/{filename}</d:href><d:propstat><d:prop><d:getcontentlength>{}</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>", photo.len());
                let range = range.filter(|_| method == "GET" && served_ranges.load(Ordering::SeqCst));
                let (status, content_type, body) = if unavailable.load(Ordering::SeqCst) {
                    (
                        "503 Service Unavailable",
                        "text/plain",
                        b"Synthetic endpoint is offline".as_slice(),
                    )
                } else if method == "PROPFIND" {
                    ("207 Multi-Status", "application/xml", listing.as_bytes())
                } else if let Some((start,end)) = range {
                    assert!(start <= end && end < photo.len());
                    ("206 Partial Content", "application/octet-stream", &photo[start..=end])
                } else {
                    // Deliberately emulate a server that ignores Range. The
                    // range reader must reject this response; only an allowed
                    // full-file fallback may consume it.
                    ("200 OK", "image/x-portable-pixmap", photo.as_slice())
                };
                let range_header = range.map(|(start,end)|format!("Content-Range: bytes {start}-{end}/{}\r\n",photo.len())).unwrap_or_default();
                let reply = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{range_header}ETag: \"synthetic-v1\"\r\nConnection: close\r\n\r\n", body.len());
                if method == "GET" && !ranged {
                    let (lock, changed) = &*served_gate;
                    let mut gate = lock.lock().unwrap();
                    if gate.paused {
                        gate.entered = true;
                        changed.notify_all();
                        while gate.paused {
                            gate = changed.wait(gate).unwrap();
                        }
                    }
                }
                let _ = stream.write_all(reply.as_bytes());
                if method != "HEAD" {
                    let _ = stream.write_all(body);
                }
                }));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            endpoint: format!("http://{address}"),
            requests,
            photo,
            filename,
            ranges,
            download_gate,
            offline,
            stop,
            worker: Some(worker),
        }
    }
    fn full_gets(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == "GET" && !request.ranged)
            .count()
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
    fn pause_original(&self) {
        let mut gate = self.download_gate.0.lock().unwrap();
        gate.paused = true;
        gate.entered = false;
    }
    fn wait_for_original(&self) {
        let (lock, changed) = &*self.download_gate;
        let (gate, _) = changed
            .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(10), |gate| {
                !gate.entered
            })
            .unwrap();
        assert!(
            gate.entered,
            "original GET did not reach the deterministic gate"
        );
    }
    fn resume_original(&self) {
        self.download_gate.0.lock().unwrap().paused = false;
        self.download_gate.1.notify_all();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.resume_original();
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.endpoint.trim_start_matches("http://"));
        self.worker.take().unwrap().join().unwrap();
    }
}

fn remote_library(service: &Service, server: &Server) -> (Value, Value) {
    let source = service.execute("storage.add", json!({
        "name":"Synthetic WebDAV", "kind":"webdav", "endpoint":server.endpoint,
        "username":"synthetic-user", "password":"synthetic-password", "remember_credentials":false
    })).unwrap();
    let library = service
        .execute(
            "library.add",
            json!({
                "name":"Synthetic album", "storage_id":source["id"], "prefix":"album"
            }),
        )
        .unwrap();
    let scan = service
        .execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    assert_eq!(scan["indexed"], 1);
    let assets = service
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap();
    (library, assets["items"][0].clone())
}
fn preview(service: &Service, id: &Value) -> Value {
    service
        .execute("asset.preview", json!({"id":id,"max_size":420}))
        .unwrap()
}
fn stats(service: &Service) -> Value {
    service.execute("cache.stats", json!({})).unwrap()
}
fn fill_remaining_budget(service: &Service, data: &Path, used: u64) -> neb_core::Reservation {
    let budget = 1024_u64 * 1024 * 1024;
    service
        .execute("cache.policy.set", json!({"budget_bytes":budget}))
        .unwrap();
    let manager = neb_core::CacheManager::open(
        data.join("catalog/catalog.sqlite3"),
        data.join("remote-cache"),
    )
    .unwrap();
    manager
        .reserve("synthetic-other-cli-write", "temporary", budget - used)
        .unwrap()
}
fn migrate(service: &Service, destination: &Path) -> Value {
    let plan = service
        .execute(
            "cache.migration.plan",
            json!({"path":destination,"mode":"all","allow_overage":true}),
        )
        .unwrap();
    assert_eq!(plan["can_start"], true);
    service
        .execute(
            "cache.migration.start",
            json!({"plan_id":plan["plan_id"],"allow_overage":true}),
        )
        .unwrap();
    let start = Instant::now();
    loop {
        let state = service
            .execute("cache.migration.get", json!({"id":plan["plan_id"]}))
            .unwrap();
        if state["status"] == "completed" {
            return state;
        }
        assert!(
            state["status"] != "failed" && state["status"] != "cancelled",
            "migration failed: {state}"
        );
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "migration did not finish: {state}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn listing_and_cold_metadata_do_not_download_originals() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Service::open(data.path()).unwrap();
    let (_library, asset) = remote_library(&service, &server);
    let count = server.count();
    let detail = service
        .execute("asset.get", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(detail["id"], asset["id"]);
    assert_eq!(detail["source_key"], "album/photo.ppm");
    assert_eq!(server.count(), count);
    assert_eq!(server.full_gets(), 0);
    assert_eq!(stats(&service)["usage"]["originals_bytes"], 0);
    let focus = service
        .execute("asset.focus", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(focus["status"], "unsupported");
    assert_eq!(
        server.full_gets(),
        0,
        "availability detection must not download the full original"
    );
}

#[test]
fn allowed_preview_persists_and_restarts_offline_without_saved_credentials() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Service::open(data.path()).unwrap();
    let (_library, asset) = remote_library(&service, &server);
    let first = preview(&service, &asset["id"]);
    assert!(first["data_url"]
        .as_str()
        .unwrap()
        .starts_with("data:image/jpeg;base64,"));
    assert_eq!(first["width"], 2);
    assert_eq!(first["height"], 1);
    assert_eq!(server.full_gets(), 1);
    assert!(stats(&service)["usage"]["previews_bytes"].as_u64().unwrap() > 0);
    let count = server.count();
    assert_eq!(
        preview(&service, &asset["id"])["data_url"],
        first["data_url"]
    );
    assert_eq!(server.count(), count);
    drop(service);
    server.offline.store(true, Ordering::SeqCst);
    let reopened = Service::open(data.path()).unwrap();
    assert_eq!(
        preview(&reopened, &asset["id"])["data_url"],
        first["data_url"]
    );
    assert_eq!(server.count(), count);
    assert_eq!(
        reopened
            .execute("asset.get", json!({"id":asset["id"]}))
            .unwrap()["id"],
        asset["id"]
    );
}

#[test]
fn manual_policy_requires_explicit_original_fetch_and_keeps_one_copy() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Service::open(data.path()).unwrap();
    let (_library, asset) = remote_library(&service, &server);
    let policy = service
        .execute("cache.policy.set", json!({"preview_policy":"manual"}))
        .unwrap();
    assert_eq!(policy["policy"]["preview_policy"], "manual");
    let blocked = service
        .execute("asset.preview", json!({"id":asset["id"],"max_size":420}))
        .unwrap_err();
    assert!(blocked.message.contains("E_DOWNLOAD_REQUIRED"));
    assert_eq!(server.full_gets(), 0);
    assert_eq!(stats(&service)["usage"]["originals_bytes"], 0);
    service
        .execute("asset.fetch_original", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(server.full_gets(), 1);
    assert_eq!(stats(&service)["usage"]["originals_bytes"], PHOTO.len());
    preview(&service, &asset["id"]);
    service
        .execute("asset.fetch_original", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(server.full_gets(), 1);
}

#[test]
fn pin_prune_budget_and_migration_preserve_catalog_edits_and_offline_access() {
    let data = tempfile::tempdir().unwrap();
    let destination_parent = tempfile::tempdir().unwrap();
    let destination = destination_parent.path().join("migrated-cache");
    let server = Server::new();
    let service = Service::open(data.path()).unwrap();
    let (library, asset) = remote_library(&service, &server);
    preview(&service, &asset["id"]);
    service
        .execute("asset.rate", json!({"id":asset["id"],"rating":4}))
        .unwrap();
    let recipe = json!({"x":0.0,"y":0.0,"width":0.5,"height":1.0});
    service
        .execute(
            "asset.crop",
            json!({"id":asset["id"],"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
        )
        .unwrap();
    service
        .execute("asset.offline.set", json!({"id":asset["id"],"pinned":true}))
        .unwrap();
    assert_eq!(stats(&service)["usage"]["pinned_bytes"], PHOTO.len());
    let budget = stats(&service)["policy"]["budget_bytes"].clone();
    assert!(service
        .execute("cache.policy.set", json!({"budget_bytes":1}))
        .is_err());
    assert_eq!(stats(&service)["policy"]["budget_bytes"], budget);
    service
        .execute(
            "cache.prune",
            json!({"originals":true,"previews":true,"temporary":true}),
        )
        .unwrap();
    assert_eq!(stats(&service)["usage"]["pinned_bytes"], PHOTO.len());
    let before = service
        .execute("asset.get", json!({"id":asset["id"]}))
        .unwrap();
    let source_before = service.execute("storage.list", json!({})).unwrap();
    migrate(&service, &destination);
    assert_eq!(
        fs::canonicalize(stats(&service)["location"]["path"].as_str().unwrap()).unwrap(),
        fs::canonicalize(&destination).unwrap()
    );
    let after = service
        .execute("asset.get", json!({"id":asset["id"]}))
        .unwrap();
    for key in ["id", "library_id", "source_key", "rating", "crop"] {
        assert_eq!(after[key], before[key]);
    }
    assert_eq!(after["rating"], 4);
    assert_eq!(after["crop"], recipe);
    assert_eq!(
        service.execute("storage.list", json!({})).unwrap(),
        source_before
    );
    assert_eq!(
        service.execute("library.list", json!({})).unwrap()[0]["id"],
        library["id"]
    );
    let count = server.count();
    drop(service);
    server.offline.store(true, Ordering::SeqCst);
    let reopened = Service::open(data.path()).unwrap();
    assert_eq!(stats(&reopened)["usage"]["pinned_bytes"], PHOTO.len());
    let rendered = preview(&reopened, &asset["id"]);
    assert_eq!(rendered["width"], 1);
    assert_eq!(server.count(), count);
    reopened
        .execute(
            "asset.offline.set",
            json!({"id":asset["id"],"pinned":false}),
        )
        .unwrap();
    reopened
        .execute(
            "cache.prune",
            json!({"originals":true,"previews":true,"temporary":true}),
        )
        .unwrap();
    assert_eq!(stats(&reopened)["usage"]["originals_bytes"], 0);
    assert_eq!(
        reopened
            .execute("asset.get", json!({"id":asset["id"]}))
            .unwrap()["crop"],
        recipe
    );
}

#[test]
fn concurrent_same_asset_previews_share_the_original_and_persisted_result() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Arc::new(Service::open(data.path()).unwrap());
    let (_library, asset) = remote_library(&service, &server);
    let barrier = Arc::new(Barrier::new(4));
    let readers: Vec<_> = (0..4)
        .map(|_| {
            let service = service.clone();
            let barrier = barrier.clone();
            let id = asset["id"].clone();
            thread::spawn(move || {
                barrier.wait();
                preview(&service, &id)["data_url"].clone()
            })
        })
        .collect();
    let values: Vec<_> = readers
        .into_iter()
        .map(|reader| reader.join().unwrap())
        .collect();
    assert!(values.iter().all(|value| value == &values[0]));
    assert_eq!(server.full_gets(), 1);
}

#[test]
fn rescanned_remote_size_replaces_stale_ordinary_original() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Service::open(data.path()).unwrap();
    let (library, asset) = remote_library(&service, &server);
    assert_eq!(preview(&service, &asset["id"])["width"], 2);
    *server.photo.lock().unwrap() = CHANGED_PHOTO.to_vec();
    service
        .execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let detail = service
        .execute("asset.get", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(detail["size"], CHANGED_PHOTO.len());
    let changed = preview(&service, &asset["id"]);
    assert_eq!(
        changed["width"], 1,
        "a new asset version must not render the old original"
    );
    assert_eq!(changed["height"], 3);
    assert_eq!(server.full_gets(), 2);
}

#[test]
fn pinned_snapshot_survives_remote_changes_until_explicit_refresh() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Service::open(data.path()).unwrap();
    let (library, asset) = remote_library(&service, &server);
    let first = preview(&service, &asset["id"]);
    service
        .execute("asset.offline.set", json!({"id":asset["id"],"pinned":true}))
        .unwrap();
    *server.photo.lock().unwrap() = CHANGED_PHOTO.to_vec();
    service
        .execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    service
        .execute("asset.rate", json!({"id":asset["id"],"rating":4}))
        .unwrap();
    let recipe = json!({"x":0.0,"y":0.0,"width":0.5,"height":1.0});
    service
        .execute(
            "asset.crop",
            json!({"id":asset["id"],"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
        )
        .unwrap();
    let snapshot = service
        .execute(
            "asset.preview",
            json!({"id":asset["id"],"max_size":420,"uncropped":true}),
        )
        .unwrap();
    assert_eq!(snapshot["width"], 2);
    assert_eq!(snapshot["height"], 1);
    assert_eq!(snapshot["data_url"], first["data_url"]);
    assert_eq!(snapshot["asset"]["size"], PHOTO.len());
    assert_eq!(snapshot["asset"]["cache_update_available"], true);
    assert_eq!(snapshot["asset"]["rating"], 4);
    assert_eq!(snapshot["asset"]["crop"], recipe);
    assert_eq!(
        server.full_gets(),
        1,
        "browsing must not silently replace an offline snapshot"
    );
    assert_eq!(stats(&service)["usage"]["pinned_bytes"], PHOTO.len());
    let refreshed = service
        .execute("asset.refresh", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(refreshed["cache_update_available"], false);
    assert_eq!(refreshed["rating"], 4);
    assert_eq!(refreshed["crop"], recipe);
    assert_eq!(refreshed["size"], CHANGED_PHOTO.len());
    let updated = service
        .execute(
            "asset.preview",
            json!({"id":asset["id"],"max_size":420,"uncropped":true}),
        )
        .unwrap();
    assert_eq!(updated["width"], 1);
    assert_eq!(updated["height"], 3);
    assert_eq!(updated["asset"]["cache_update_available"], false);
    assert_eq!(server.full_gets(), 2);
    assert_eq!(
        stats(&service)["usage"]["pinned_bytes"],
        CHANGED_PHOTO.len()
    );
}

#[test]
fn pinned_capture_time_matches_the_displayed_snapshot_after_remote_rescan() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let mut original = vec![0; 64];
    original[..8].copy_from_slice(b"II\x2a\0\x08\0\0\0");
    original[8..10].copy_from_slice(&1_u16.to_le_bytes());
    original[10..12].copy_from_slice(&0x8769_u16.to_le_bytes());
    original[12..14].copy_from_slice(&4_u16.to_le_bytes());
    original[14..18].copy_from_slice(&1_u32.to_le_bytes());
    original[18..22].copy_from_slice(&26_u32.to_le_bytes());
    original[26..28].copy_from_slice(&1_u16.to_le_bytes());
    original[28..30].copy_from_slice(&0x9003_u16.to_le_bytes());
    original[30..32].copy_from_slice(&2_u16.to_le_bytes());
    original[32..36].copy_from_slice(&20_u32.to_le_bytes());
    original[36..40].copy_from_slice(&44_u32.to_le_bytes());
    original[44..64].copy_from_slice(b"2026:10:16 01:02:03\0");
    *server.photo.lock().unwrap() = original.clone();
    *server.filename.lock().unwrap() = "photo.nef".into();
    let service = Service::open(data.path()).unwrap();
    let (library, asset) = remote_library(&service, &server);
    service
        .execute("asset.offline.set", json!({"id":asset["id"],"pinned":true}))
        .unwrap();
    let pinned = service
        .execute("asset.get", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(pinned["captured_at"], "2026-10-16T01:02:03.000000000");
    original[44..64].copy_from_slice(b"2026:10:17 04:05:06\0");
    original.push(0); // New size makes the remote scan publish a new revision.
    *server.photo.lock().unwrap() = original;
    service
        .execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let live = service
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap();
    assert_eq!(live["items"][0]["capture_status"], "pending");
    let displayed = service
        .execute("asset.get", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(displayed["captured_at"], pinned["captured_at"]);
    assert_eq!(displayed["capture_status"], "available");
    assert_eq!(
        displayed["metadata"]["Captured"],
        pinned["metadata"]["Captured"]
    );
    assert_eq!(displayed["cache_update_available"], true);
    assert_eq!(
        server.full_gets(),
        1,
        "displaying the pinned version must not fetch the new remote original"
    );
}

#[test]
fn failed_forced_refresh_does_not_evict_the_previously_cached_original() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Service::open(data.path()).unwrap();
    let (_library, asset) = remote_library(&service, &server);
    service
        .execute("asset.fetch_original", json!({"id":asset["id"]}))
        .unwrap();
    service
        .execute(
            "cache.policy.set",
            json!({"budget_bytes":1024_u64 * 1024 * 1024}),
        )
        .unwrap();
    // A separate manager represents another CLI process with an active writer.
    // Its reservation fills the quota without allocating a GiB of fixture data.
    let other_writer = neb_core::CacheManager::open(
        data.path().join("catalog/catalog.sqlite3"),
        data.path().join("remote-cache"),
    )
    .unwrap();
    let _reservation = other_writer
        .reserve(
            "synthetic-other-cli-write",
            "temporary",
            1024_u64 * 1024 * 1024 - PHOTO.len() as u64,
        )
        .unwrap();
    server.offline.store(true, Ordering::SeqCst);
    assert!(service
        .execute("asset.refresh", json!({"id":asset["id"]}))
        .is_err());
    assert_eq!(
        stats(&service)["usage"]["originals_bytes"],
        PHOTO.len(),
        "failed refresh must preserve the old cached original"
    );
    let count = server.count();
    service
        .execute("asset.fetch_original", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(
        server.count(),
        count,
        "the original must remain usable offline"
    );
}

#[test]
fn removed_library_offline_pin_can_still_be_released() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Service::open(data.path()).unwrap();
    let (library, asset) = remote_library(&service, &server);
    service
        .execute("asset.offline.set", json!({"id":asset["id"],"pinned":true}))
        .unwrap();
    service
        .execute("library.remove", json!({"id":library["id"]}))
        .unwrap();
    assert_eq!(stats(&service)["usage"]["pinned_bytes"], PHOTO.len());
    service
        .execute(
            "asset.offline.set",
            json!({"id":asset["id"],"pinned":false}),
        )
        .unwrap();
    service
        .execute(
            "cache.prune",
            json!({"originals":true,"previews":true,"temporary":true}),
        )
        .unwrap();
    assert_eq!(stats(&service)["usage"]["pinned_bytes"], 0);
    assert_eq!(stats(&service)["usage"]["originals_bytes"], 0);
}

#[test]
fn another_service_rescan_waits_for_in_flight_original_before_changing_its_revision() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Arc::new(Service::open(data.path()).unwrap());
    let (library, asset) = remote_library(&service, &server);
    let scanner = Service::open(data.path()).unwrap();
    scanner.execute("storage.add", json!({
        "name":"Synthetic WebDAV", "kind":"webdav", "endpoint":server.endpoint,
        "username":"synthetic-user", "password":"synthetic-password", "remember_credentials":false
    })).unwrap();
    server.pause_original();
    let fetch_service = service.clone();
    let id = asset["id"].clone();
    let fetcher =
        thread::spawn(move || fetch_service.execute("asset.fetch_original", json!({"id":id})));
    server.wait_for_original();
    *server.photo.lock().unwrap() = CHANGED_PHOTO.to_vec();
    let (started_tx, started_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    let library_id = library["id"].clone();
    let scanning = thread::spawn(move || {
        started_tx.send(()).unwrap();
        let result = scanner.execute("library.scan", json!({"library_id":library_id}));
        finished_tx.send(result).unwrap();
        scanner
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        matches!(
            finished_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ),
        "a concurrent catalog rescan must wait for the old original's operation"
    );
    server.resume_original();
    fetcher.join().unwrap().unwrap();
    finished_rx
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    let scanner = scanning.join().unwrap();
    let current = scanner
        .execute("asset.get", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(current["size"], CHANGED_PHOTO.len());
    let updated = preview(&scanner, &asset["id"]);
    assert_eq!(updated["width"], 1);
    assert_eq!(updated["height"], 3);
    assert_eq!(server.full_gets(), 2);
}

#[test]
fn full_budget_does_not_prevent_viewing_an_existing_offline_original() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let service = Service::open(data.path()).unwrap();
    let (_library, asset) = remote_library(&service, &server);
    service
        .execute("asset.offline.set", json!({"id":asset["id"],"pinned":true}))
        .unwrap();
    let _reservation = fill_remaining_budget(&service, data.path(), PHOTO.len() as u64);
    let count = server.count();
    let rendered = preview(&service, &asset["id"]);
    assert_eq!(rendered["width"], 2);
    assert_eq!(rendered["height"], 1);
    assert_eq!(server.count(), count);
    assert_eq!(stats(&service)["usage"]["previews_bytes"], 0);
    assert_eq!(
        stats(&service)["usage"]["total_bytes"],
        1024_u64 * 1024 * 1024
    );
}

#[test]
fn disconnected_cache_does_not_prevent_viewing_a_local_original_or_create_a_fallback() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let file = photos.path().join("photo.ppm");
    fs::write(&file, PHOTO).unwrap();
    let service = Service::open(data.path()).unwrap();
    let asset = service.execute("file.open", json!({"path":file})).unwrap();
    let cache_root = data.path().join("remote-cache");
    fs::rename(&cache_root, data.path().join("disconnected-cache")).unwrap();
    let rendered = preview(&service, &asset["id"]);
    assert_eq!(rendered["width"], 2);
    assert_eq!(rendered["height"], 1);
    assert_eq!(stats(&service)["location"]["state"], "offline");
    assert!(
        !cache_root.exists(),
        "a disconnected cache must not be silently recreated"
    );
    assert_eq!(fs::read(file).unwrap(), PHOTO);
}

fn synthetic_preview_jpeg() -> Vec<u8> {
    let fixture_data = tempfile::tempdir().unwrap();
    let local_file = fixture_data.path().join("synthetic.ppm");
    fs::write(&local_file, PHOTO).unwrap();
    let fixture_service = Service::open(fixture_data.path().join("fixture-profile")).unwrap();
    let local = fixture_service
        .execute("file.open", json!({"path":local_file}))
        .unwrap();
    let encoded = preview(&fixture_service, &local["id"]);
    let encoded = encoded["data_url"]
        .as_str()
        .unwrap()
        .split_once(',')
        .unwrap()
        .1;
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut jpeg = Vec::new();
    let (mut accumulator, mut bits) = (0_u32, 0_u32);
    for byte in encoded.bytes().take_while(|byte| *byte != b'=') {
        accumulator =
            (accumulator << 6) | alphabet.iter().position(|item| *item == byte).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            jpeg.push((accumulator >> bits) as u8);
        }
    }
    jpeg
}

#[test]
fn range_embedded_preview_remains_viewable_in_memory_while_cache_is_disconnected() {
    let jpeg = synthetic_preview_jpeg();
    let mut tiff = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
    tiff.extend(3_u16.to_le_bytes());
    for (tag, kind, value) in [
        (274_u16, 3_u16, 1_u32),
        (513, 4, 50),
        (514, 4, jpeg.len() as u32),
    ] {
        tiff.extend(tag.to_le_bytes());
        tiff.extend(kind.to_le_bytes());
        tiff.extend(1_u32.to_le_bytes());
        tiff.extend(value.to_le_bytes());
    }
    tiff.extend(0_u32.to_le_bytes());
    assert_eq!(tiff.len(), 50);
    tiff.extend(jpeg);
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    *server.filename.lock().unwrap() = "photo.tif".into();
    *server.photo.lock().unwrap() = tiff;
    server.ranges.store(true, Ordering::SeqCst);
    let service = Service::open(data.path()).unwrap();
    let (_library, asset) = remote_library(&service, &server);
    let cache_root = data.path().join("remote-cache");
    fs::rename(&cache_root, data.path().join("disconnected-cache")).unwrap();
    let rendered = preview(&service, &asset["id"]);
    assert_eq!(rendered["width"], 2);
    assert_eq!(rendered["height"], 1);
    assert_eq!(rendered["source"], "remote_embedded_jpeg");
    assert_eq!(server.full_gets(), 0);
    assert!(server
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| request.method == "GET" && request.ranged));
    assert_eq!(stats(&service)["usage"]["previews_bytes"], 0);
    assert_eq!(stats(&service)["location"]["state"], "offline");
    assert!(!cache_root.exists());
}

fn large_raw_with_preview(jpeg_padding: usize) -> Vec<u8> {
    fn ifd(entries: &[(u16, u16, u32, u32)]) -> Vec<u8> {
        let mut bytes = (entries.len() as u16).to_le_bytes().to_vec();
        for (tag, kind, count, value) in entries {
            bytes.extend(tag.to_le_bytes());
            bytes.extend(kind.to_le_bytes());
            bytes.extend(count.to_le_bytes());
            bytes.extend(value.to_le_bytes());
        }
        bytes.extend(0_u32.to_le_bytes());
        bytes
    }
    let mut jpeg = synthetic_preview_jpeg();
    jpeg.resize(jpeg.len() + jpeg_padding, 0);
    let exif_offset = 8 * 1024 * 1024_u32;
    let mut raw = vec![0; 30 * 1024 * 1024];
    raw[..8].copy_from_slice(b"II\x2a\x00\x08\x00\x00\x00");
    let primary = ifd(&[
        (271, 2, 10, 128),
        (272, 2, 12, 160),
        (274, 3, 1, 6),
        (513, 4, 1, 512),
        (514, 4, 1, jpeg.len() as u32),
        (34665, 4, 1, exif_offset),
    ]);
    raw[8..8 + primary.len()].copy_from_slice(&primary);
    raw[128..138].copy_from_slice(b"Synthetic\0");
    raw[160..172].copy_from_slice(b"RangeCamera\0");
    raw[512..512 + jpeg.len()].copy_from_slice(&jpeg);
    let exif = ifd(&[
        (33434, 5, 1, exif_offset + 160),
        (36867, 2, 20, exif_offset + 128),
    ]);
    let exif_offset = exif_offset as usize;
    raw[exif_offset..exif_offset + exif.len()].copy_from_slice(&exif);
    raw[exif_offset + 128..exif_offset + 148].copy_from_slice(b"2026:10:19 12:34:56\0");
    raw[exif_offset + 160..exif_offset + 164].copy_from_slice(&1_u32.to_le_bytes());
    raw[exif_offset + 164..exif_offset + 168].copy_from_slice(&125_u32.to_le_bytes());
    raw
}

#[test]
fn large_remote_raw_keeps_small_range_preview_and_far_exif_without_downloading_original() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    *server.filename.lock().unwrap() = "photo.nef".into();
    *server.photo.lock().unwrap() = large_raw_with_preview(0);
    server.ranges.store(true, Ordering::SeqCst);
    let service = Service::open(data.path()).unwrap();
    service
        .execute("cache.policy.set", json!({"preview_policy":"manual"}))
        .unwrap();
    let (_library, asset) = remote_library(&service, &server);
    let rendered = preview(&service, &asset["id"]);
    assert_eq!(rendered["source"], "remote_embedded_jpeg");
    assert_eq!(
        (rendered["width"].as_u64(), rendered["height"].as_u64()),
        (Some(1), Some(2))
    );
    assert_eq!(rendered["coordinate_mapping"]["orientation"], 6);
    assert_eq!(rendered["asset"]["metadata"]["Make"], "Synthetic");
    assert_eq!(rendered["asset"]["metadata"]["Camera"], "RangeCamera");
    assert_eq!(
        rendered["asset"]["metadata"]["Captured"],
        "2026:10:19 12:34:56"
    );
    assert!(rendered["asset"]["metadata"]["Exposure"]
        .as_str()
        .unwrap()
        .contains("1/125"));
    assert_eq!(rendered["histogram"]["pixels"], 2);
    assert_eq!(server.full_gets(), 0);
    let requests = server.requests.lock().unwrap();
    let range_bytes: usize = requests.iter().map(|request| request.range_bytes).sum();
    assert!(
        range_bytes < 2 * 1024 * 1024,
        "30 MiB RAW fetched {range_bytes} bytes"
    );
    assert!(requests.len() < 16);
    drop(requests);
    assert_eq!(stats(&service)["usage"]["originals_bytes"], 0);
    assert!(stats(&service)["usage"]["previews_bytes"].as_u64().unwrap() > 0);
    let count = server.count();
    assert_eq!(preview(&service, &asset["id"])["width"], 1);
    assert_eq!(
        server.count(),
        count,
        "persisted preview must avoid another remote read"
    );
}

#[test]
fn genuine_range_budget_exhaustion_requires_explicit_original_download() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    *server.filename.lock().unwrap() = "photo.nef".into();
    *server.photo.lock().unwrap() = large_raw_with_preview(17 * 1024 * 1024);
    server.ranges.store(true, Ordering::SeqCst);
    let service = Service::open(data.path()).unwrap();
    let (_library, asset) = remote_library(&service, &server);
    let error = service
        .execute("asset.preview", json!({"id":asset["id"],"max_size":420}))
        .unwrap_err();
    assert_eq!(error.code, "E_DOWNLOAD_REQUIRED");
    assert!(error.message.contains("超出分段读取上限"));
    assert!(!error.message.contains("E_RANGE_LIMIT"));
    assert_eq!(
        server.full_gets(),
        0,
        "budget limit must not start an automatic full GET"
    );
    assert_eq!(stats(&service)["usage"]["originals_bytes"], 0);
    service
        .execute("asset.fetch_original", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(server.full_gets(), 1);
    let rendered = preview(&service, &asset["id"]);
    assert_eq!(rendered["source"], "embedded_jpeg");
    assert_eq!(rendered["width"], 1);
}
