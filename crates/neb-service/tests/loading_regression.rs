use neb_service::Service;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";

#[derive(Default)]
struct Gate {
    pause_get: bool,
    pause_listing: bool,
    gets: usize,
    listings: usize,
}
struct SlowServer {
    endpoint: String,
    gate: Arc<(Mutex<Gate>, Condvar)>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl SlowServer {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let gate = Arc::new((Mutex::new(Gate::default()), Condvar::new()));
        let requests_gate = gate.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            for stream in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let gate = requests_gate.clone();
                requests.push(thread::spawn(move || {
                    let mut stream = stream.unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                    let mut headers = Vec::new();
                    let mut byte = [0];
                    while !headers.ends_with(b"\r\n\r\n") {
                        if stream.read(&mut byte).unwrap_or(0) == 0 { return; }
                        headers.push(byte[0]);
                        assert!(headers.len() <= 32768);
                    }
                    let text = String::from_utf8(headers).unwrap();
                    let length = text.lines().filter_map(|line|line.split_once(':'))
                        .find(|(name,_)|name.eq_ignore_ascii_case("content-length"))
                        .map(|(_,value)|value.trim().parse::<usize>().unwrap()).unwrap_or(0);
                    stream.read_exact(&mut vec![0;length]).unwrap();
                    let method = text.split_whitespace().next().unwrap();
                    let (lock, changed) = &*gate;
                    let mut state = lock.lock().unwrap();
                    match method {
                        "GET" => { state.gets += 1; changed.notify_all(); while state.pause_get { state = changed.wait(state).unwrap(); } }
                        "PROPFIND" => { state.listings += 1; changed.notify_all(); while state.pause_listing { state = changed.wait(state).unwrap(); } }
                        _ => {}
                    }
                    drop(state);
                    let listing = format!("<d:multistatus xmlns:d=\"DAV:\">{}</d:multistatus>",(0..4).map(|index|format!("<d:response><d:href>/album/photo{index}.ppm</d:href><d:propstat><d:prop><d:getcontentlength>{}</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",PHOTO.len())).collect::<String>());
                    let (status,body) = if method == "PROPFIND" { ("207 Multi-Status",listing.as_bytes()) } else { ("200 OK",PHOTO) };
                    let reply = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nETag: \"synthetic-v1\"\r\nConnection: close\r\n\r\n",body.len());
                    let _ = stream.write_all(reply.as_bytes());
                    if method != "HEAD" { let _ = stream.write_all(body); }
                }));
            }
            for request in requests {
                request.join().unwrap();
            }
        });
        Self {
            endpoint: format!("http://{address}"),
            gate,
            stop,
            worker: Some(worker),
        }
    }
    fn pause(&self, get: bool, listing: bool) {
        let mut gate = self.gate.0.lock().unwrap();
        gate.gets = 0;
        gate.listings = 0;
        gate.pause_get = get;
        gate.pause_listing = listing;
    }
    fn wait_for(&self, gets: usize, listings: usize) {
        let (lock, changed) = &*self.gate;
        let (gate, _) = changed
            .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(10), |gate| {
                gate.gets < gets || gate.listings < listings
            })
            .unwrap();
        assert!(
            gate.gets >= gets && gate.listings >= listings,
            "remote request did not reach its deterministic gate"
        );
    }
    fn resume(&self) {
        let mut gate = self.gate.0.lock().unwrap();
        gate.pause_get = false;
        gate.pause_listing = false;
        self.gate.1.notify_all();
    }
}
impl Drop for SlowServer {
    fn drop(&mut self) {
        self.resume();
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.endpoint.trim_start_matches("http://"));
        self.worker.take().unwrap().join().unwrap();
    }
}

fn local_assets(service: &Service, directory: &std::path::Path) -> Vec<Value> {
    (0..2)
        .map(|index| {
            let path = directory.join(format!("local{index}.ppm"));
            fs::write(&path, PHOTO).unwrap();
            service.execute("file.open", json!({"path":path})).unwrap()
        })
        .collect()
}
fn remote_assets(service: &Service, server: &SlowServer) -> (Value, Vec<Value>) {
    let source = service.execute("storage.add",json!({"name":"Synthetic slow WebDAV","kind":"webdav","endpoint":server.endpoint,"username":"synthetic","password":"synthetic","remember_credentials":false})).unwrap();
    let library = service
        .execute(
            "library.add",
            json!({"name":"Remote album","storage_id":source["id"],"prefix":"album"}),
        )
        .unwrap();
    service
        .execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let assets = service
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(assets.len(), 4);
    (library, assets)
}
fn local_commands_complete_before_remote_release(
    service: &Arc<Service>,
    local: &[Value],
) -> Vec<String> {
    let commands = [
        ("asset.get", json!({"id":local[0]["id"]})),
        ("asset.preview", json!({"id":local[1]["id"],"max_size":420})),
        ("library.list", json!({})),
    ];
    let commands: Vec<_> = commands
        .into_iter()
        .map(|(name, params)| {
            let (sent, received) = mpsc::channel();
            let service = service.clone();
            thread::spawn(move || {
                let _ = sent.send(service.execute(name, params));
            });
            (name, received)
        })
        .collect();
    commands
        .into_iter()
        .filter_map(
            |(name, received)| match received.recv_timeout(Duration::from_millis(500)) {
                Ok(Ok(value)) => {
                    if name == "asset.preview" {
                        assert_eq!(value["width"], 2);
                    }
                    None
                }
                Ok(Err(error)) => Some(format!("{name}: {}", error.message)),
                Err(error) => Some(format!("{name}: {error}")),
            },
        )
        .collect()
}

#[test]
fn four_slow_remote_downloads_do_not_block_local_metadata_preview_or_library_list() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let server = SlowServer::new();
    let service = Arc::new(Service::open(data.path()).unwrap());
    let local = local_assets(&service, photos.path());
    let (_library, remote) = remote_assets(&service, &server);
    server.pause(true, false);
    let downloads: Vec<_> = remote
        .into_iter()
        .map(|asset| {
            let service = service.clone();
            thread::spawn(move || {
                service.execute("asset.fetch_original", json!({"id":asset["id"]}))
            })
        })
        .collect();
    server.wait_for(4, 0);
    let stalled = local_commands_complete_before_remote_release(&service, &local);
    server.resume();
    for download in downloads {
        download.join().unwrap().unwrap();
    }
    assert!(
        stalled.is_empty(),
        "local commands stalled behind remote downloads: {stalled:?}"
    );
}

#[test]
fn slow_remote_enumeration_does_not_hold_catalog_or_storage_locks_needed_by_local_browsing() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let server = SlowServer::new();
    let service = Arc::new(Service::open(data.path()).unwrap());
    let local = local_assets(&service, photos.path());
    let (library, _remote) = remote_assets(&service, &server);
    server.pause(false, true);
    let scanning_service = service.clone();
    let scan = thread::spawn(move || {
        scanning_service.execute("library.scan", json!({"library_id":library["id"]}))
    });
    server.wait_for(0, 1);
    let stalled = local_commands_complete_before_remote_release(&service, &local);
    server.resume();
    scan.join().unwrap().unwrap();
    assert!(
        stalled.is_empty(),
        "local commands stalled behind remote enumeration: {stalled:?}"
    );
}

#[test]
fn slow_connection_probe_browse_and_explicit_fetch_do_not_block_local_browsing() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let downloads = tempfile::tempdir().unwrap();
    let server = SlowServer::new();
    let service = Arc::new(Service::open(data.path()).unwrap());
    let local = local_assets(&service, photos.path());
    let (library, _) = remote_assets(&service, &server);
    for (index, command) in ["storage.check", "storage.browse", "storage.fetch"]
        .into_iter()
        .enumerate()
    {
        let fetch = command == "storage.fetch";
        server.pause(fetch, !fetch);
        let remote = service.clone();
        let params = json!({
            "id":library["storage_id"],"prefix":"album","limit":10,
            "key":"album/photo0.ppm","destination":downloads.path().join(format!("download{index}.ppm"))
        });
        let operation = thread::spawn(move || remote.execute(command, params));
        server.wait_for(usize::from(fetch), usize::from(!fetch));
        let stalled = local_commands_complete_before_remote_release(&service, &local);
        server.resume();
        operation.join().unwrap().unwrap();
        assert!(
            stalled.is_empty(),
            "local commands stalled behind {command}: {stalled:?}"
        );
    }
}

#[test]
fn a_slow_scan_cannot_publish_entries_after_its_library_has_been_rebound() {
    let data = tempfile::tempdir().unwrap();
    let replacement = tempfile::tempdir().unwrap();
    fs::write(replacement.path().join("replacement.ppm"), PHOTO).unwrap();
    let server = SlowServer::new();
    let service = Arc::new(Service::open(data.path()).unwrap());
    let (library, _) = remote_assets(&service, &server);
    let local_source = service.execute("storage.add", json!({"name":"Replacement local source","kind":"local","endpoint":replacement.path(),"remember_credentials":false})).unwrap();
    server.pause(false, true);
    let scanning_service = service.clone();
    let library_id = library["id"].clone();
    let scan = thread::spawn(move || {
        scanning_service.execute("library.scan", json!({"library_id":library_id}))
    });
    server.wait_for(0, 1);
    let updating_service = service.clone();
    let library_id = library["id"].clone();
    let source_id = local_source["id"].clone();
    let (sent, received) = mpsc::channel();
    let updating = thread::spawn(move || {
        sent.send(updating_service.execute(
            "library.update",
            json!({"id":library_id,"storage_id":source_id,"source_prefix":""}),
        ))
        .unwrap();
    });
    let rebound = received.recv_timeout(Duration::from_millis(500));
    server.resume();
    updating.join().unwrap();
    let rebound = rebound
        .expect("rebind must not wait for remote enumeration")
        .unwrap();
    assert_eq!(rebound["storage_id"], local_source["id"]);
    let rejected = scan.join().unwrap().unwrap_err();
    assert_eq!(rejected.code, "E_CONFLICT");
    assert!(service
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    service
        .execute("library.scan", json!({"library_id":library["id"]}))
        .unwrap();
    let assets = service
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap();
    let assets = assets["items"].as_array().unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0]["filename"], "replacement.ppm");
    assert!(assets[0]["source_key"].is_null());
}

#[test]
fn local_browsing_does_not_wait_for_an_unrelated_cache_writer_lock() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let service = Arc::new(Service::open(data.path()).unwrap());
    let local = local_assets(&service, photos.path());
    let cache_lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(data.path().join("catalog/catalog.cache.lock"))
        .unwrap();
    cache_lock.lock().unwrap();
    let stalled = local_commands_complete_before_remote_release(&service, &local);
    cache_lock.unlock().unwrap();
    assert!(
        stalled.is_empty(),
        "local commands waited for global cache maintenance: {stalled:?}"
    );
}

#[test]
fn same_library_scans_serialize_before_http_without_blocking_other_local_libraries() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let server = SlowServer::new();
    let service = Arc::new(Service::open(data.path()).unwrap());
    let local = local_assets(&service, photos.path());
    let (library, _) = remote_assets(&service, &server);
    server.pause(false, true);
    let first_service = service.clone();
    let id = library["id"].clone();
    let first =
        thread::spawn(move || first_service.execute("library.scan", json!({"library_id":id})));
    server.wait_for(0, 1);

    let second_service = service.clone();
    let id = library["id"].clone();
    let (started_tx, started_rx) = mpsc::channel();
    let second = thread::spawn(move || {
        started_tx.send(()).unwrap();
        second_service.execute("library.scan", json!({"library_id":id}))
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (lock, changed) = &*server.gate;
    let (gate, _) = changed
        .wait_timeout_while(lock.lock().unwrap(), Duration::from_millis(100), |gate| {
            gate.listings < 2
        })
        .unwrap();
    let premature_second_request = gate.listings > 1;
    drop(gate);
    let stalled = local_commands_complete_before_remote_release(&service, &local);
    server.resume();
    assert_eq!(first.join().unwrap().unwrap()["indexed"], 4);
    assert_eq!(second.join().unwrap().unwrap()["indexed"], 4);
    assert!(
        !premature_second_request,
        "the second scan issued HTTP before the first scan completed"
    );
    assert_eq!(server.gate.0.lock().unwrap().listings, 2);
    assert!(
        stalled.is_empty(),
        "queued scans blocked unrelated local browsing: {stalled:?}"
    );
}
