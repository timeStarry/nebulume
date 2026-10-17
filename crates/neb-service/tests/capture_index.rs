use neb_service::Service;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const DECLARED_SIZE: usize = 4 * 1024 * 1024;
const PREFIX_SIZE: usize = 64 * 1024;
const LOCAL_PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

fn exif_prefix() -> Vec<u8> {
    // Classic TIFF with a primary EXIF directory and DateTimeOriginal only.
    // It deliberately has no decodable pixels or embedded JPEG preview.
    let mut bytes = vec![0; PREFIX_SIZE];
    bytes[..8].copy_from_slice(b"II\x2a\0\x08\0\0\0");
    bytes[8..10].copy_from_slice(&1_u16.to_le_bytes());
    bytes[10..12].copy_from_slice(&0x8769_u16.to_le_bytes());
    bytes[12..14].copy_from_slice(&4_u16.to_le_bytes());
    bytes[14..18].copy_from_slice(&1_u32.to_le_bytes());
    bytes[18..22].copy_from_slice(&26_u32.to_le_bytes());
    bytes[26..28].copy_from_slice(&1_u16.to_le_bytes());
    bytes[28..30].copy_from_slice(&0x9003_u16.to_le_bytes());
    bytes[30..32].copy_from_slice(&2_u16.to_le_bytes());
    bytes[32..36].copy_from_slice(&20_u32.to_le_bytes());
    bytes[36..40].copy_from_slice(&44_u32.to_le_bytes());
    bytes[44..64].copy_from_slice(b"2026:10:17 00:12:34\0");
    bytes
}

#[derive(Clone)]
struct Request {
    method: String,
    target: String,
    ranged: bool,
}
#[derive(Default)]
struct Gate {
    paused: bool,
    entered: usize,
}
struct MetadataServer {
    endpoint: String,
    requests: Arc<Mutex<Vec<Request>>>,
    gate: Arc<(Mutex<Gate>, Condvar)>,
    offline: Arc<AtomicBool>,
    body_override: Arc<Mutex<Option<Vec<u8>>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl MetadataServer {
    fn new(files: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let gate = Arc::new((Mutex::new(Gate::default()), Condvar::new()));
        let served_gate = Arc::clone(&gate);
        let offline = Arc::new(AtomicBool::new(false));
        let failing = Arc::clone(&offline);
        let body_override: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(Mutex::new(None));
        let served_body = Arc::clone(&body_override);
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            let mut handlers = Vec::new();
            for stream in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let recorded = Arc::clone(&recorded);
                let gate = Arc::clone(&served_gate);
                let failing = Arc::clone(&failing);
                let served_body = Arc::clone(&served_body);
                handlers.push(thread::spawn(move || {
                    let mut stream = stream.unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                    let mut headers = Vec::new();
                    let mut byte = [0];
                    while !headers.ends_with(b"\r\n\r\n") {
                        if stream.read(&mut byte).unwrap_or(0) == 0 { return; }
                        headers.push(byte[0]);
                        assert!(headers.len() < 32 * 1024);
                    }
                    let headers = String::from_utf8(headers).unwrap();
                    let request_body = headers.lines().filter_map(|line| line.split_once(':'))
                        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap()).unwrap_or(0);
                    stream.read_exact(&mut vec![0; request_body]).unwrap();
                    let mut first_line = headers.lines().next().unwrap().split_whitespace();
                    let method = first_line.next().unwrap().to_owned();
                    let target = first_line.next().unwrap().to_owned();
                    let ranged = headers.lines().filter_map(|line| line.split_once(':'))
                        .any(|(key, _)| key.eq_ignore_ascii_case("range"));
                    recorded.lock().unwrap().push(Request { method: method.clone(), target, ranged });
                    if method == "GET" && !ranged {
                        let (lock, changed) = &*gate;
                        let mut state = lock.lock().unwrap();
                        state.entered += 1;
                        changed.notify_all();
                        while state.paused { state = changed.wait(state).unwrap(); }
                    }
                    if failing.load(Ordering::SeqCst) {
                        let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        return;
                    }
                    if method == "PROPFIND" {
                        let listing = format!("<d:multistatus xmlns:d=\"DAV:\">{}</d:multistatus>", (0..files).map(|index| format!("<d:response><d:href>/album/photo{index}.nef</d:href><d:propstat><d:prop><d:getcontentlength>{DECLARED_SIZE}</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")).collect::<String>());
                        let reply = format!("HTTP/1.1 207 Multi-Status\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{listing}", listing.len());
                        let _ = stream.write_all(reply.as_bytes());
                        return;
                    }
                    // No strong version or Range support. A range probe is
                    // ignored; the allowed fallback must read a single prefix.
                    let body = served_body.lock().unwrap().clone();
                    let declared = body.as_ref().map(Vec::len).unwrap_or(DECLARED_SIZE);
                    let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n");
                    if stream.write_all(reply.as_bytes()).is_ok() && method == "GET" {
                        // Serving only 64 KiB means any attempt to consume or
                        // cache the declared 4 MiB original would fail. Metadata
                        // indexing succeeds because its one-response prefix is
                        // sufficient and the remainder is deliberately dropped.
                        let _ = stream.write_all(&body.unwrap_or_else(exif_prefix));
                    }
                }));
            }
            for handler in handlers {
                handler.join().unwrap();
            }
        });
        Self {
            endpoint: format!("http://{address}"),
            requests,
            gate,
            offline,
            body_override,
            stop,
            worker: Some(worker),
        }
    }
    fn pause(&self) {
        let mut gate = self.gate.0.lock().unwrap();
        gate.entered = 0;
        gate.paused = true;
    }
    fn wait_for_prefix_get(&self) {
        let (lock, changed) = &*self.gate;
        let (gate, _) = changed
            .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(10), |gate| {
                gate.entered == 0
            })
            .unwrap();
        assert!(
            gate.entered > 0,
            "metadata fallback did not reach its deterministic gate"
        );
    }
    fn resume(&self) {
        self.gate.0.lock().unwrap().paused = false;
        self.gate.1.notify_all();
    }
    fn full_gets(&self) -> Vec<Request> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == "GET" && !request.ranged)
            .cloned()
            .collect()
    }
}
impl Drop for MetadataServer {
    fn drop(&mut self) {
        self.resume();
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.endpoint.trim_start_matches("http://"));
        self.worker.take().unwrap().join().unwrap();
    }
}

fn remote_library(service: &Service, server: &MetadataServer) -> Value {
    let source = service.execute("storage.add", json!({"name":"Synthetic metadata source","kind":"webdav","endpoint":server.endpoint,"username":"synthetic","password":"synthetic","remember_credentials":false})).unwrap();
    let library = service
        .execute(
            "library.add",
            json!({"name":"Remote EXIF","storage_id":source["id"],"prefix":"album"}),
        )
        .unwrap();
    service
        .execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    library
}
fn status(service: &Service, library: &Value) -> Value {
    service
        .execute(
            "library.capture_index.status",
            json!({"library_id":library["id"]}),
        )
        .unwrap()
}
fn start(service: &Service, library: &Value) -> Value {
    service
        .execute(
            "library.capture_index.start",
            json!({"library_id":library["id"]}),
        )
        .unwrap()
}
fn terminal(service: &Service, library: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let state = status(service, library);
        if matches!(
            state["job"]["status"].as_str(),
            Some("completed" | "cancelled" | "failed")
        ) {
            return state;
        }
        assert!(
            Instant::now() < deadline,
            "capture indexing did not finish: {state}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
fn originals_remain_uncached(service: &Service) {
    let cache = service.execute("cache.stats", json!({})).unwrap();
    assert_eq!(cache["usage"]["originals_bytes"], 0);
}

#[test]
fn no_range_remote_exif_index_uses_one_response_prefix_without_decoding_or_original_cache() {
    let data = tempfile::tempdir().unwrap();
    let server = MetadataServer::new(1);
    let service = Service::open(data.path()).unwrap();
    let library = remote_library(&service, &server);
    assert_eq!(status(&service, &library)["pending"], 1);
    start(&service, &library);
    let state = terminal(&service, &library);
    assert_eq!(state["job"]["status"], "completed", "{state}");
    assert_eq!(state["known"], 1);
    assert_eq!(state["pending"], 0);
    assert_eq!(state["job"]["found"], 1);
    assert_eq!(server.full_gets().len(), 1);
    let assets = service
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap();
    assert_eq!(
        assets["items"][0]["captured_at"],
        "2026-10-17T00:12:34.000000000"
    );
    assert_eq!(assets["items"][0]["capture_status"], "available");
    assert!(
        assets["items"][0]["width"].is_null(),
        "indexing did not decode pixels"
    );
    originals_remain_uncached(&service);
    let cache = service.execute("cache.stats", json!({})).unwrap();
    assert_eq!(
        cache["objects_count"], 0,
        "indexing created no cache objects"
    );
}

fn local_asset(service: &Service, folder: &Path) -> Value {
    let path = folder.join("local.ppm");
    fs::write(&path, LOCAL_PHOTO).unwrap();
    service.execute("file.open", json!({"path":path})).unwrap()
}

#[test]
fn paused_metadata_does_not_block_local_browsing_or_cancel_and_keeps_the_current_result() {
    let data = tempfile::tempdir().unwrap();
    let local = tempfile::tempdir().unwrap();
    let server = MetadataServer::new(2);
    let service = Arc::new(Service::open(data.path()).unwrap());
    let asset = local_asset(&service, local.path());
    let library = remote_library(&service, &server);
    server.pause();
    let started = start(&service, &library);
    server.wait_for_prefix_get();
    let commands = [
        ("asset.get", json!({"id":asset["id"]})),
        ("asset.preview", json!({"id":asset["id"],"max_size":420})),
        ("asset.list", json!({"library_id":asset["library_id"]})),
        ("library.list", json!({})),
    ];
    let pending: Vec<_> = commands
        .into_iter()
        .map(|(name, params)| {
            let service = Arc::clone(&service);
            let (send, receive) = mpsc::channel();
            thread::spawn(move || {
                let _ = send.send(service.execute(name, params));
            });
            (name, receive)
        })
        .collect();
    let local_results: Vec<_> = pending
        .into_iter()
        .map(|(name, receive)| (name, receive.recv_timeout(Duration::from_secs(1))))
        .collect();
    let (send, receive) = mpsc::channel();
    let cancelling = Arc::clone(&service);
    let params = json!({"library_id":library["id"],"job_id":started["job"]["id"]});
    thread::spawn(move || {
        let _ = send.send(cancelling.execute("library.capture_index.cancel", params));
    });
    let cancellation = receive.recv_timeout(Duration::from_secs(1));
    server.resume();
    let finished = terminal(&service, &library);
    for (name, result) in local_results {
        let value = result
            .unwrap_or_else(|error| panic!("{name} stalled behind metadata: {error}"))
            .unwrap();
        if name == "asset.preview" {
            assert_eq!(value["width"], 2);
        }
    }
    assert_eq!(
        cancellation
            .expect("cancel must respond before the current HTTP call returns")
            .unwrap()["job"]["status"],
        "stopping"
    );
    assert_eq!(finished["job"]["status"], "cancelled", "{finished}");
    assert_eq!(finished["job"]["processed"], 1);
    assert_eq!(finished["known"], 1, "completed current result is retained");
    assert_eq!(finished["pending"], 1);
    let gets = server.full_gets();
    assert_eq!(gets.len(), 1, "stopping must not request the next asset");
    let indexed_target = &gets[0].target;
    assert!(server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.method != "PROPFIND")
        .all(|request| &request.target == indexed_target));
    originals_remain_uncached(&service);
}

#[test]
fn network_failure_leaves_pending_and_retry_fills_capture_time() {
    let data = tempfile::tempdir().unwrap();
    let server = MetadataServer::new(1);
    let service = Service::open(data.path()).unwrap();
    let library = remote_library(&service, &server);
    server.offline.store(true, Ordering::SeqCst);
    let first = start(&service, &library);
    let failed = terminal(&service, &library);
    assert_eq!(failed["job"]["status"], "failed", "{failed}");
    assert_eq!(failed["job"]["failed"], 1);
    assert_eq!(failed["job"]["missing"], 0);
    assert_eq!(failed["pending"], 1);
    assert_eq!(failed["missing"], 0);
    originals_remain_uncached(&service);
    server.offline.store(false, Ordering::SeqCst);
    let retry = start(&service, &library);
    assert_ne!(retry["job"]["id"], first["job"]["id"]);
    let done = terminal(&service, &library);
    assert_eq!(done["job"]["status"], "completed", "{done}");
    assert_eq!(done["known"], 1);
    assert_eq!(done["pending"], 0);
    assert_eq!(done["job"]["failed"], 0);
    originals_remain_uncached(&service);
}

#[test]
fn cancellation_while_waiting_for_an_asset_lock_does_not_start_a_metadata_request() {
    let data = tempfile::tempdir().unwrap();
    let server = MetadataServer::new(1);
    let service = Service::open(data.path()).unwrap();
    let library = remote_library(&service, &server);
    let assets = service
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap();
    let asset_id = assets["items"][0]["id"].as_str().unwrap();
    let locks = data.path().join("catalog/asset-locks");
    fs::create_dir_all(&locks).unwrap();
    let asset_lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(locks.join(format!(
            "{}.lock",
            hex::encode(Sha256::digest(asset_id.as_bytes()))
        )))
        .unwrap();
    asset_lock.lock().unwrap();
    let started = start(&service, &library);
    let library_lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.path().join("catalog/library-locks").join(format!(
            "{}.lock",
            hex::encode(Sha256::digest(library["id"].as_str().unwrap().as_bytes()))
        )))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if library_lock.try_lock().is_err() {
            break;
        }
        library_lock.unlock().unwrap();
        assert!(
            Instant::now() < deadline,
            "indexer did not acquire its library lease before waiting for the asset"
        );
        thread::sleep(Duration::from_millis(1));
    }
    let stopped = service
        .execute(
            "library.capture_index.cancel",
            json!({"library_id":library["id"],"job_id":started["job"]["id"]}),
        )
        .unwrap();
    assert_eq!(stopped["job"]["status"], "stopping");
    asset_lock.unlock().unwrap();
    let done = terminal(&service, &library);
    assert_eq!(done["job"]["status"], "cancelled");
    assert_eq!(
        done["job"]["processed"], 0,
        "waiting was not a completed metadata read"
    );
    assert_eq!(done["pending"], 1);
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.method == "PROPFIND"),
        "cancelled queued work must not issue HEAD or GET"
    );
}

#[test]
fn an_empty_or_shortened_response_cannot_confirm_missing_metadata_for_a_larger_scanned_file() {
    let data = tempfile::tempdir().unwrap();
    let server = MetadataServer::new(1);
    let service = Service::open(data.path()).unwrap();
    let library = remote_library(&service, &server);
    for body in [Vec::new(), exif_prefix()[..64].to_vec()] {
        *server.body_override.lock().unwrap() = Some(body);
        start(&service, &library);
        let done = terminal(&service, &library);
        assert_eq!(done["job"]["status"], "failed", "{done}");
        assert_eq!(done["pending"], 1);
        assert_eq!(done["known"], 0);
        assert_eq!(done["missing"], 0);
        assert!(done["job"]["error"]
            .as_str()
            .unwrap()
            .contains("E_CONFLICT"));
        originals_remain_uncached(&service);
    }
}
