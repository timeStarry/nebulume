use neb_service::Service;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

const BODY_SIZE: usize = 1024;

#[derive(Default)]
struct Gate {
    open: bool,
    entered: usize,
}

/// Minimal WebDAV source whose GETs block until the gate opens, so a capture
/// job is deterministically mid-request when quiesce runs.
struct GatedSource {
    endpoint: String,
    gate: Arc<(Mutex<Gate>, Condvar)>,
}

impl GatedSource {
    fn new(files: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let gate = Arc::new((Mutex::new(Gate::default()), Condvar::new()));
        let served = Arc::clone(&gate);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let gate = Arc::clone(&served);
                thread::spawn(move || serve(stream, files, &gate));
            }
        });
        Self { endpoint, gate }
    }

    fn wait_for_get(&self) {
        let (lock, changed) = &*self.gate;
        let (gate, _) = changed
            .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(10), |gate| {
                gate.entered == 0
            })
            .unwrap();
        assert!(gate.entered > 0, "capture job never requested a file");
    }

    fn open(&self) {
        self.gate.0.lock().unwrap().open = true;
        self.gate.1.notify_all();
    }
}

impl Drop for GatedSource {
    fn drop(&mut self) {
        self.open();
    }
}

fn serve(mut stream: TcpStream, files: usize, gate: &(Mutex<Gate>, Condvar)) {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut headers = Vec::new();
    let mut byte = [0];
    while !headers.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).unwrap_or(0) == 0 {
            return;
        }
        headers.push(byte[0]);
    }
    let headers = String::from_utf8_lossy(&headers).into_owned();
    let length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        .unwrap_or(0);
    let _ = stream.read_exact(&mut vec![0; length]);
    let method = headers.split_whitespace().next().unwrap_or_default();
    if method == "PROPFIND" {
        let listing = format!(
            "<d:multistatus xmlns:d=\"DAV:\">{}</d:multistatus>",
            (0..files)
                .map(|index| format!("<d:response><d:href>/album/photo{index}.nef</d:href><d:propstat><d:prop><d:getcontentlength>{BODY_SIZE}</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"))
                .collect::<String>()
        );
        let _ = write!(
            stream,
            "HTTP/1.1 207 Multi-Status\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{listing}",
            listing.len()
        );
        return;
    }
    if method == "GET" {
        let (lock, changed) = gate;
        let mut state = lock.lock().unwrap();
        state.entered += 1;
        changed.notify_all();
        while !state.open {
            state = changed.wait(state).unwrap();
        }
    }
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {BODY_SIZE}\r\nConnection: close\r\n\r\n"
    );
    if method == "GET" {
        let _ = stream.write_all(&[0; BODY_SIZE]);
    }
}

fn status(service: &Service, library: &Value) -> Value {
    service
        .execute(
            "library.capture_index.status",
            json!({"library_id":library["id"]}),
        )
        .unwrap()
}

#[test]
fn quiesce_cancels_capture_jobs_and_reports_idle() {
    let data = tempfile::tempdir().unwrap();
    let source = GatedSource::new(3);
    let service = Arc::new(Service::open(data.path()).unwrap());
    let storage = service
        .execute("storage.add", json!({"name":"Gated","kind":"webdav","endpoint":source.endpoint,"username":"synthetic","password":"synthetic","remember_credentials":false}))
        .unwrap();
    let library = service
        .execute(
            "library.add",
            json!({"name":"相册","storage_id":storage["id"],"prefix":"album"}),
        )
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
    source.wait_for_get();
    let releaser = {
        let service = Arc::clone(&service);
        let library = library.clone();
        let source_gate = Arc::clone(&source.gate);
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while status(&service, &library)["job"]["status"] != "stopping" {
                assert!(Instant::now() < deadline, "quiesce never cancelled the job");
                thread::sleep(Duration::from_millis(5));
            }
            source_gate.0.lock().unwrap().open = true;
            source_gate.1.notify_all();
        })
    };
    let report = service.quiesce(Duration::from_secs(10)).unwrap();
    releaser.join().unwrap();
    assert!(!report.timed_out);
    assert_eq!(report.pending_writes, 0);
    assert_eq!(report.cancelled_jobs, 1);
    let state = status(&service, &library);
    assert_eq!(state["job"]["status"], "cancelled", "{state}");
    assert_eq!(state["job"]["processed"], 1, "{state}");
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
