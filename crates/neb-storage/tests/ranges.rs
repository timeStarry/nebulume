use neb_storage::{RangeReadError, RangeReadOptions, RemoteRangeReader, StorageRegistry};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Clone)]
struct Request {
    method: String,
    target: String,
    headers: HashMap<String, String>,
}
struct Response {
    status: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
impl Response {
    fn new(status: &'static str, body: &[u8]) -> Self {
        Self {
            status,
            headers: vec![("Content-Length".into(), body.len().to_string())],
            body: body.into(),
        }
    }
    fn header(mut self, key: &str, value: impl ToString) -> Self {
        self.headers
            .retain(|(previous, _)| !previous.eq_ignore_ascii_case(key));
        self.headers.push((key.into(), value.to_string()));
        self
    }
}
struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}
impl Server {
    fn new(handler: impl Fn(&Request) -> Response + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let join = thread::spawn(move || {
            for accepted in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    break;
                }
                let mut stream = accepted.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0];
                while !bytes.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        break;
                    }
                    bytes.push(byte[0]);
                    assert!(bytes.len() < 32 * 1024);
                }
                let text = String::from_utf8(bytes).unwrap();
                let mut lines = text.split("\r\n");
                let mut first = lines.next().unwrap().split_whitespace();
                let request = Request {
                    method: first.next().unwrap().into(),
                    target: first.next().unwrap().into(),
                    headers: lines
                        .filter_map(|line| line.split_once(':'))
                        .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
                        .collect(),
                };
                recorded.lock().unwrap().push(request.clone());
                let response = handler(&request);
                let mut head = format!("HTTP/1.1 {}\r\nConnection: close\r\n", response.status);
                for (key, value) in response.headers {
                    head.push_str(&format!("{key}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes());
                if request.method != "HEAD" {
                    let _ = stream.write_all(&response.body);
                }
            }
        });
        Self {
            url: format!("http://{address}"),
            requests,
            stop,
            join: Some(join),
        }
    }
    fn calls(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.url.trim_start_matches("http://"));
        self.join.take().unwrap().join().unwrap();
    }
}

const DATA: &[u8] = b"0123456789abcdef";
fn normal(request: &Request, etag: &str) -> Response {
    if request.method == "HEAD" {
        return Response::new("200 OK", &[])
            .header("Content-Length", DATA.len())
            .header("ETag", etag);
    }
    let range = request.headers["range"].strip_prefix("bytes=").unwrap();
    let (start, end) = range.split_once('-').unwrap();
    let start = start.parse::<usize>().unwrap();
    let end = end.parse::<usize>().unwrap().min(DATA.len() - 1);
    Response::new("206 Partial Content", &DATA[start..=end])
        .header(
            "Content-Range",
            format!("bytes {start}-{end}/{}", DATA.len()),
        )
        .header("ETag", etag)
}
fn options() -> RangeReadOptions {
    RangeReadOptions {
        chunk_size: 4,
        max_bytes: 64,
        max_requests: 32,
        max_cached_chunks: 2,
    }
}
fn registry(server: &Server, s3: bool) -> (tempfile::TempDir, StorageRegistry, String) {
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let source = registry
        .add(
            serde_json::from_value(serde_json::json!({
                "name":"Synthetic range test", "kind":if s3 {"s3"} else {"webdav"},
                "endpoint":server.url, "remember_credentials":false,
                "username":"synthetic-user", "password":"synthetic-password",
                "bucket":if s3 { Some("photos") } else { None },
                "region":"us-east-1", "access_key":"synthetic-key", "secret_key":"synthetic-secret"
            }))
            .unwrap(),
        )
        .unwrap();
    (data, registry, source.id)
}
fn reader(server: &Server, options: RangeReadOptions) -> RemoteRangeReader {
    let (_data, registry, id) = registry(server, false);
    let reader = registry
        .open_range_reader_with_options(&id, "photo.jpg", options)
        .unwrap();
    assert!(
        server.calls().is_empty(),
        "construction must not issue HTTP requests"
    );
    reader
}
fn error(reader: &mut RemoteRangeReader) -> RangeReadError {
    let failure = reader.read(&mut [0; 1]).unwrap_err();
    RangeReadError::from_io(&failure).unwrap().clone()
}

#[test]
fn ranges_are_lazy_seekable_version_locked_and_lru_bounded() {
    let server = Server::new(|request| normal(request, "\"version-1\""));
    let mut reader = reader(&server, options());
    assert_eq!(reader.seek(SeekFrom::Start(0)).unwrap(), 0);
    assert!(server.calls().is_empty());
    assert_eq!(reader.metadata().unwrap().length, 16);
    let mut byte = [0];
    reader.read_exact(&mut byte).unwrap();
    assert_eq!(&byte, b"0");
    reader.rewind().unwrap();
    reader.read_exact(&mut byte).unwrap();
    assert_eq!(server.calls().len(), 2);
    reader.seek(SeekFrom::End(-1)).unwrap();
    reader.read_exact(&mut byte).unwrap();
    assert_eq!(&byte, b"f");
    assert_eq!(reader.read(&mut byte).unwrap(), 0);
    reader.seek(SeekFrom::Start(8)).unwrap();
    reader.read_exact(&mut byte).unwrap();
    reader.rewind().unwrap();
    reader.read_exact(&mut byte).unwrap();
    assert_eq!(reader.stats().requests, 5);
    assert_eq!(reader.stats().body_bytes, 16);
    assert_eq!(reader.stats().cached_bytes, 8);
    for request in server
        .calls()
        .iter()
        .filter(|request| request.method == "GET")
    {
        assert_eq!(request.headers["if-match"], "\"version-1\"");
        assert_eq!(request.headers["accept-encoding"], "identity");
    }
    assert!(reader.seek(SeekFrom::Current(-100)).is_err());
    reader.seek(SeekFrom::Start(u64::MAX)).unwrap();
    assert_eq!(reader.read(&mut byte).unwrap(), 0);
}

#[test]
fn unsupported_head_uses_a_single_byte_identity_probe() {
    let server = Server::new(|request| {
        if request.method == "HEAD" {
            Response::new("405 Method Not Allowed", &[])
        } else {
            normal(request, "\"v1\"")
        }
    });
    let mut reader = reader(&server, options());
    let mut bytes = [0; 3];
    reader.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"012");
    let requests = server.calls();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1].headers["range"], "bytes=0-0");
    assert!(!requests[1].headers.contains_key("if-match"));
    assert_eq!(requests[2].headers["if-match"], "\"v1\"");
    assert_eq!(reader.stats().body_bytes, 5);
}

#[test]
fn weak_etag_and_mtime_are_not_version_locks() {
    for etag in ["W/\"weak\"", "unquoted", "*"] {
        let etag = etag.to_owned();
        let server = Server::new(move |request| {
            normal(request, &etag).header("Last-Modified", "Wed, 21 Oct 2015 07:28:00 GMT")
        });
        let mut reader = reader(&server, options());
        assert_eq!(error(&mut reader), RangeReadError::VersionUnavailable);
        assert_eq!(reader.stats().body_bytes, 0);
        assert!(RangeReadError::VersionUnavailable.is_fallback_allowed());
    }
}

#[test]
fn a_server_ignoring_range_is_rejected_without_consuming_a_full_body() {
    let server = Server::new(|request| {
        if request.method == "HEAD" {
            normal(request, "\"v1\"")
        } else {
            Response::new("200 OK", DATA).header("ETag", "\"v1\"")
        }
    });
    let mut reader = reader(&server, options());
    assert_eq!(error(&mut reader), RangeReadError::Unsupported);
    assert_eq!(reader.stats().body_bytes, 0);
    assert_eq!(server.calls().len(), 2);
}

#[test]
fn invalid_content_ranges_and_lengths_are_rejected() {
    for value in [
        "bytes 1-4/16",
        "bytes 0-3/17",
        "bytes 0-3/*",
        "bytes 0-3/3",
        "bytes 3-0/16",
        "bytes -1-3/16",
        "bytes 0-18446744073709551616/16",
        "items 0-3/16",
    ] {
        let server = Server::new(move |request| {
            let response = normal(request, "\"v1\"");
            if request.method == "HEAD" {
                response
            } else {
                response.header("Content-Range", value)
            }
        });
        assert!(matches!(
            error(&mut reader(&server, options())),
            RangeReadError::InvalidResponse(_)
        ));
    }
    let server = Server::new(|request| {
        let response = normal(request, "\"v1\"");
        if request.method == "HEAD" {
            response
        } else {
            response.header("Content-Length", 3)
        }
    });
    assert!(matches!(
        error(&mut reader(&server, options())),
        RangeReadError::InvalidResponse(_)
    ));
}

#[test]
fn truncated_response_and_encoded_response_are_not_cached() {
    let server = Server::new(|request| {
        let mut response = normal(request, "\"v1\"");
        if request.method != "HEAD" {
            response.body.truncate(2);
        }
        response
    });
    let mut partial = reader(&server, options());
    assert!(matches!(
        error(&mut partial),
        RangeReadError::InvalidResponse(_)
    ));
    assert_eq!(partial.stats().body_bytes, 2);
    assert_eq!(partial.stats().cached_bytes, 0);
    let server =
        Server::new(|request| normal(request, "\"v1\"").header("Content-Encoding", "gzip"));
    assert!(matches!(
        error(&mut reader(&server, options())),
        RangeReadError::InvalidResponse(_)
    ));
}

#[test]
fn precondition_failed_or_changed_response_version_poison_the_reader() {
    for mode in [0, 1, 2] {
        let server = Server::new(move |request| {
            if request.method == "GET" && request.headers["range"] != "bytes=0-3" {
                match mode {
                    0 => Response::new("412 Precondition Failed", &[]),
                    1 => normal(request, "\"v2\""),
                    _ => Response::new("416 Range Not Satisfiable", &[])
                        .header("Content-Range", "bytes */16"),
                }
            } else {
                normal(request, "\"v1\"")
            }
        });
        let mut reader = reader(&server, options());
        reader.read_exact(&mut [0; 1]).unwrap();
        reader.seek(SeekFrom::Start(4)).unwrap();
        let failure = error(&mut reader);
        if mode == 2 {
            assert!(matches!(failure, RangeReadError::InvalidResponse(_)));
        } else {
            assert_eq!(failure, RangeReadError::VersionChanged);
        }
        assert_eq!(reader.stats().cached_bytes, 0);
        assert!(reader.rewind().is_err());
        assert_eq!(server.calls().len(), 3);
    }
}

#[test]
fn body_and_request_budgets_stop_before_another_request() {
    let server = Server::new(|request| normal(request, "\"v1\""));
    let mut limited = reader(
        &server,
        RangeReadOptions {
            max_bytes: 8,
            ..options()
        },
    );
    limited.read_exact(&mut [0; 8]).unwrap();
    assert_eq!(error(&mut limited), RangeReadError::BudgetExceeded);
    assert_eq!(limited.stats().body_bytes, 8);
    assert_eq!(limited.stats().requests, 3);
    let server = Server::new(|request| normal(request, "\"v1\""));
    let mut limited = reader(
        &server,
        RangeReadOptions {
            max_requests: 2,
            ..options()
        },
    );
    limited.read_exact(&mut [0; 4]).unwrap();
    assert_eq!(error(&mut limited), RangeReadError::BudgetExceeded);
    assert_eq!(limited.stats().requests, 2);
}

#[test]
fn independent_reader_survives_registry_drop_and_uses_s3_version_query() {
    let version = "version/+ space";
    let server = Server::new(move |request| {
        normal(request, "W/\"weak\"").header("x-amz-version-id", version)
    });
    let (_data, registry, id) = registry(&server, true);
    let mut reader = registry
        .open_range_reader_with_options(&id, "snow photo.nef", options())
        .unwrap();
    drop(registry);
    assert!(server.calls().is_empty());
    let identity = reader.metadata().unwrap();
    assert_eq!(identity.version_id.as_deref(), Some(version));
    assert!(identity.etag.is_none());
    reader.read_exact(&mut [0; 1]).unwrap();
    let requests = server.calls();
    assert_eq!(requests[0].method, "HEAD");
    assert_eq!(
        requests[1].target,
        "/photos/snow%20photo.nef?versionId=version%2F%2B%20space"
    );
    assert!(requests[1].headers["authorization"].starts_with("AWS4-HMAC-SHA256 "));
    assert!(!requests[1].headers.contains_key("if-match"));
}

#[test]
fn s3_null_version_does_not_replace_a_strong_validator() {
    let server =
        Server::new(|request| normal(request, "W/\"weak\"").header("x-amz-version-id", "null"));
    let (_data, registry, id) = registry(&server, true);
    let mut reader = registry
        .open_range_reader_with_options(&id, "photo.nef", options())
        .unwrap();
    assert_eq!(error(&mut reader), RangeReadError::VersionUnavailable);
}

#[test]
fn invalid_options_do_not_construct_a_reader_or_send_requests() {
    let server = Server::new(|request| normal(request, "\"v1\""));
    let (_data, registry, id) = registry(&server, false);
    for invalid in [
        RangeReadOptions {
            chunk_size: 0,
            ..options()
        },
        RangeReadOptions {
            max_bytes: 16 * 1024 * 1024 + 1,
            ..options()
        },
        RangeReadOptions {
            max_requests: 129,
            ..options()
        },
        RangeReadOptions {
            max_cached_chunks: 0,
            ..options()
        },
    ] {
        assert!(registry
            .open_range_reader_with_options(&id, "photo.jpg", invalid)
            .is_err());
    }
    assert!(server.calls().is_empty());
}

#[test]
fn full_body_snapshot_is_lazy_send_and_outlives_registry() {
    let server = Server::new(|request| {
        assert_eq!(request.method, "GET");
        assert!(!request.headers.contains_key("range"));
        Response::new("200 OK", DATA)
    });
    let (_data, registry, id) = registry(&server, false);
    let reader = registry.open_reader(&id, "photo.jpg").unwrap();
    assert!(server.calls().is_empty());
    drop(registry);
    let bytes = thread::spawn(move || {
        let mut reader = reader;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        bytes
    })
    .join()
    .unwrap();
    assert_eq!(bytes, DATA);
    assert_eq!(server.calls().len(), 1);
}

#[test]
fn chunked_ranges_require_exact_body_length_and_unambiguous_framing() {
    for oversized in [false, true] {
        let server = Server::new(move |request| {
            if request.method == "HEAD" {
                return normal(request, "\"v1\"");
            }
            let mut response = normal(request, "\"v1\"").header("Transfer-Encoding", "chunked");
            response.headers.retain(|(key, _)| key != "Content-Length");
            response.body = if oversized {
                b"5\r\n01234\r\n0\r\n\r\n".to_vec()
            } else {
                b"4\r\n0123\r\n0\r\n\r\n".to_vec()
            };
            response
        });
        let mut reader = reader(&server, options());
        if oversized {
            assert!(matches!(
                error(&mut reader),
                RangeReadError::InvalidResponse(_)
            ));
        } else {
            let mut bytes = [0; 4];
            reader.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"0123");
            assert_eq!(reader.stats().body_bytes, 4);
        }
    }
    let server = Server::new(|request| {
        let mut response = normal(request, "\"v1\"");
        if request.method != "HEAD" {
            response = response.header("Transfer-Encoding", "chunked");
            response.body = b"4\r\n0123\r\n0\r\n\r\n".to_vec();
        }
        response
    });
    assert!(reader(&server, options()).read(&mut [0]).is_err());
}
