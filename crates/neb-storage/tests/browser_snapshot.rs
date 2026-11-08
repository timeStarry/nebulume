use neb_storage::{AddStorageRequest, StorageBrowser, StorageRegistry};
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

struct Server {
    endpoint: String,
    requests: Arc<AtomicUsize>,
    fail: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let recorded = requests.clone();
        let fail = Arc::new(AtomicBool::new(false));
        let failing = fail.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = thread::spawn(move || {
            for stream in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut headers = Vec::new();
                let mut byte = [0];
                while !headers.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        return;
                    }
                    headers.push(byte[0]);
                    assert!(headers.len() < 32768);
                }
                let text = String::from_utf8(headers).unwrap();
                let length = text
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                assert!(length < 32768);
                stream.read_exact(&mut vec![0; length]).unwrap();
                assert!(text.starts_with("PROPFIND "));
                recorded.fetch_add(1, Ordering::SeqCst);
                let (status, body) = if failing.load(Ordering::SeqCst) {
                    ("503 Service Unavailable", "Synthetic endpoint offline")
                } else {
                    ("207 Multi-Status","<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/photo.ppm</d:href><d:propstat><d:prop><d:getcontentlength>17</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>")
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            endpoint: format!("http://{address}"),
            requests,
            fail,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.endpoint.trim_start_matches("http://"));
        self.thread.take().unwrap().join().unwrap();
    }
}
fn request(server: &Server) -> AddStorageRequest {
    serde_json::from_value(json!({"name":"Synthetic WebDAV","kind":"webdav","endpoint":server.endpoint,"username":"synthetic","password":"synthetic","remember_credentials":false})).unwrap()
}

#[test]
fn snapshot_is_lazy_send_sync_and_remains_usable_after_registry_drop() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<StorageBrowser>();
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let source = registry.add(request(&server)).unwrap();
    let browser = registry.open_browser(&source.id).unwrap();
    assert_eq!(server.requests.load(Ordering::SeqCst), 0);
    drop(registry);
    let page = thread::spawn(move || browser.browse("", 5, None).unwrap())
        .join()
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].key, "photo.ppm");
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
}

#[test]
fn real_probe_updates_only_the_captured_connection_generation() {
    let data = tempfile::tempdir().unwrap();
    let server = Server::new();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let source = registry.add(request(&server)).unwrap();
    assert_eq!(registry.list()[0].availability, "unchecked");
    let old = registry.open_browser(&source.id).unwrap();
    old.browse("", 1, None).unwrap();
    assert!(registry.list()[0].connected);
    assert_eq!(registry.list()[0].availability, "online");
    let reconnected = registry.add(request(&server)).unwrap();
    assert_eq!(reconnected.id, source.id);
    assert!(!registry.list()[0].connected);
    assert!(old.check().unwrap().connected);
    assert!(
        !registry.list()[0].connected,
        "an old snapshot must not mark a reconnected source as checked"
    );
    let current = registry.open_browser(&source.id).unwrap();
    let success = current.check().unwrap();
    assert!(success.connected);
    assert_eq!(success.credential_status, "session");
    assert!(success.error.is_none());
    assert!(registry.list()[0].connected);
    server.fail.store(true, Ordering::SeqCst);
    let failure = current.check().unwrap();
    assert!(!failure.connected);
    assert!(failure.error.is_some());
    assert!(!registry.list()[0].connected);
    // A server error is reported honestly, not guessed as offline or a login problem.
    assert_eq!(failure.availability, "error");
    assert_eq!(registry.list()[0].availability, "error");
}

#[test]
fn local_snapshot_preserves_safe_pagination_and_outlives_the_registry() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("a.ppm"), b"synthetic a").unwrap();
    fs::write(photos.path().join("b.ppm"), b"synthetic b").unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let source = registry.add(serde_json::from_value(json!({"name":"Local","kind":"local","endpoint":photos.path(),"remember_credentials":false})).unwrap()).unwrap();
    let browser = registry.open_browser(&source.id).unwrap();
    drop(registry);
    let first = browser.browse("", 1, None).unwrap();
    assert_eq!(first.entries[0].key, "a.ppm");
    let expected_created = fs::metadata(photos.path().join("a.ppm"))
        .unwrap()
        .created()
        .ok()
        .map(|created| {
            chrono::DateTime::<chrono::Utc>::from(created)
                .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
        });
    assert_eq!(first.entries[0].created_at, expected_created);
    let second = browser.browse("", 1, first.next_cursor.as_deref()).unwrap();
    assert_eq!(second.entries[0].key, "b.ppm");
    assert!(second.next_cursor.is_none());
    assert!(browser.browse("../", 1, None).is_err());
}
