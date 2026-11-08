//! Remote publication against a loopback WebDAV/S3 stand-in. Never touches a real NAS.
use neb_storage::{StorageRegistry, WriteCapability};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Cursor, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Honors If-None-Match and Overwrite: F.
    Strict,
    /// Replaces existing content regardless of preconditions.
    Overwrites,
    /// Returns different bytes on GET (WebDAV read-back must catch it).
    Corrupts,
    /// S3 without conditional-write support.
    NoConditional,
}

type Store = Arc<Mutex<HashMap<String, Vec<u8>>>>;

struct Server {
    endpoint: String,
    store: Store,
}

fn hex_sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn serve(kind: &'static str, mode: Mode) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let store: Store = Arc::default();
    let shared = store.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let store = shared.clone();
            thread::spawn(move || handle(stream, &store, kind, mode));
        }
    });
    Server {
        endpoint: format!("http://127.0.0.1:{port}/root/"),
        store,
    }
}

fn handle(mut stream: TcpStream, store: &Store, kind: &str, mode: Mode) {
    let mut data = Vec::new();
    let mut buffer = [0u8; 8192];
    let header_end = loop {
        let count = match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(count) => count,
        };
        data.extend_from_slice(&buffer[..count]);
        if let Some(index) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let head = String::from_utf8_lossy(&data[..header_end]).to_string();
    let mut lines = head.lines();
    let mut request_line = lines.next().unwrap().split(' ');
    let method = request_line.next().unwrap().to_owned();
    let path = request_line.next().unwrap().to_owned();
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = data[header_end..].to_vec();
    while body.len() < length {
        let count = stream.read(&mut buffer).unwrap_or(0);
        if count == 0 {
            break;
        }
        body.extend_from_slice(&buffer[..count]);
    }
    let key = |path: &str| path.split('?').next().unwrap().to_owned();
    let path = key(&path);
    let mut files = store.lock().unwrap();
    let (status, reply): (&str, Vec<u8>) = match method.as_str() {
        "HEAD" => (
            if files.contains_key(&path) {
                "200 OK"
            } else {
                "404 Not Found"
            },
            vec![],
        ),
        "GET" => match files.get(&path) {
            Some(bytes) if mode == Mode::Corrupts => ("200 OK", [bytes.as_slice(), b"!"].concat()),
            Some(bytes) => ("200 OK", bytes.clone()),
            None => ("404 Not Found", vec![]),
        },
        "DELETE" => {
            files.remove(&path);
            ("204 No Content", vec![])
        }
        "MKCOL" => ("201 Created", vec![]),
        "PUT" => {
            let conditional = headers.get("if-none-match").map(String::as_str) == Some("*");
            if kind == "s3" && mode == Mode::NoConditional && conditional {
                (
                    "501 Not Implemented",
                    b"<Error><Code>NotImplemented</Code></Error>".to_vec(),
                )
            } else if kind == "s3" && headers.get("x-amz-content-sha256") != Some(&hex_sha(&body)) {
                (
                    "400 Bad Request",
                    b"<Error><Code>XAmzContentSHA256Mismatch</Code></Error>".to_vec(),
                )
            } else if conditional && mode != Mode::Overwrites && files.contains_key(&path) {
                ("412 Precondition Failed", vec![])
            } else {
                files.insert(path.clone(), body);
                ("201 Created", vec![])
            }
        }
        "MOVE" => {
            let destination = headers
                .get("destination")
                .map(|url| url.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap())
                .unwrap();
            let no_overwrite = headers.get("overwrite").map(String::as_str) == Some("F");
            if no_overwrite && mode != Mode::Overwrites && files.contains_key(&destination) {
                ("412 Precondition Failed", vec![])
            } else if let Some(bytes) = files.remove(&path) {
                files.insert(destination, bytes);
                ("201 Created", vec![])
            } else {
                ("404 Not Found", vec![])
            }
        }
        _ => ("405 Method Not Allowed", vec![]),
    };
    drop(files);
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reply.len()
    );
    let _ = stream.write_all(&reply);
}

fn registry(kind: &str, server: &Server) -> (tempfile::TempDir, StorageRegistry, String) {
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let request = serde_json::from_value(serde_json::json!({
        "name": "NAS", "kind": kind, "endpoint": server.endpoint,
        "bucket": if kind == "s3" { Some("bucket") } else { None },
        "access_key": "key", "secret_key": "secret", "username": "user", "password": "pass",
        "remember_credentials": false
    }))
    .unwrap();
    let id = registry.add(request).unwrap().id;
    (data, registry, id)
}

fn put(writer: &neb_storage::RemoteWriter, key: &str, bytes: &'static [u8]) -> anyhow::Result<()> {
    writer.put_new(key, Cursor::new(bytes), bytes.len() as u64, &hex_sha(bytes))
}

fn keys(server: &Server) -> Vec<String> {
    let mut keys: Vec<_> = server.store.lock().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

#[test]
fn webdav_publishes_once_verifies_and_never_overwrites() {
    let server = serve("webdav", Mode::Strict);
    let (_data, registry, id) = registry("webdav", &server);
    assert_eq!(registry.write_capability(&id), WriteCapability::Unverified);
    let writer = registry.open_writer(&id).unwrap();
    put(&writer, "2026/2026-10-22/a.NEF", b"raw bytes").unwrap();
    assert_eq!(keys(&server), ["/root/2026/2026-10-22/a.NEF"]);
    let conflict = put(&writer, "2026/2026-10-22/a.NEF", b"different").unwrap_err();
    assert!(format!("{conflict:#}").contains("E_CONFLICT"));
    assert_eq!(
        server.store.lock().unwrap()["/root/2026/2026-10-22/a.NEF"],
        b"raw bytes"
    );
    // No temporary .part files remain after success or conflict.
    assert_eq!(keys(&server).len(), 1);
    assert!(writer.exists("2026/2026-10-22/a.NEF").unwrap());
    assert!(!writer.exists("2026/2026-10-22/b.NEF").unwrap());
    // Wrong planned hash: rejected before anything is published.
    let wrong = writer
        .put_new("c.jpg", Cursor::new(b"abc"), 3, &"0".repeat(64))
        .unwrap_err();
    assert!(format!("{wrong:#}").contains("E_VERIFY"));
    assert_eq!(keys(&server).len(), 1);
    assert!(put(&writer, "../escape.jpg", b"x").is_err());
    let check = writer.probe();
    assert_eq!(check.write_capability, "verified", "{:?}", check.error);
    assert!(check.leftover.is_none());
    assert_eq!(registry.write_capability(&id), WriteCapability::Verified);
    assert_eq!(keys(&server).len(), 1, "probe object must be removed");
}

#[test]
fn webdav_that_ignores_overwrite_protection_is_refused() {
    let server = serve("webdav", Mode::Overwrites);
    let (_data, registry, id) = registry("webdav", &server);
    let check = registry.open_writer(&id).unwrap().probe();
    assert_eq!(check.write_capability, "unsupported");
    assert!(check.error.unwrap().contains("E_UNSUPPORTED"));
    assert_eq!(registry.write_capability(&id), WriteCapability::Unsupported);
}

#[test]
fn webdav_read_back_mismatch_publishes_nothing() {
    let server = serve("webdav", Mode::Corrupts);
    let (_data, registry, id) = registry("webdav", &server);
    let writer = registry.open_writer(&id).unwrap();
    let error = put(&writer, "a.jpg", b"jpeg").unwrap_err();
    assert!(format!("{error:#}").contains("E_VERIFY"));
    assert!(
        keys(&server).is_empty(),
        "temporary file is removed, target never created"
    );
}

#[test]
fn s3_conditional_put_is_hash_bound_and_unsupported_services_are_refused() {
    let server = serve("s3", Mode::Strict);
    let (_data, strict, id) = registry("s3", &server);
    let writer = strict.open_writer(&id).unwrap();
    put(&writer, "trips/a.NEF", b"raw").unwrap();
    assert_eq!(keys(&server), ["/root/bucket/trips/a.NEF"]);
    let conflict = put(&writer, "trips/a.NEF", b"new").unwrap_err();
    assert!(format!("{conflict:#}").contains("E_CONFLICT"));
    let mismatch = writer
        .put_new("trips/b.NEF", Cursor::new(b"abc"), 3, &hex_sha(b"xyz"))
        .unwrap_err();
    assert!(format!("{mismatch:#}").contains("E_VERIFY"));
    assert_eq!(writer.probe().write_capability, "verified");

    let legacy = serve("s3", Mode::NoConditional);
    let (_legacy_data, old, id) = registry("s3", &legacy);
    let check = old.open_writer(&id).unwrap().probe();
    assert_eq!(check.write_capability, "unsupported");
    assert!(keys(&legacy).is_empty());
}

#[test]
fn local_locations_do_not_open_remote_writers() {
    let data = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let request = serde_json::from_value(serde_json::json!({
        "name": "Local", "kind": "local", "endpoint": folder.path(), "remember_credentials": false
    }))
    .unwrap();
    let id = registry.add(request).unwrap().id;
    assert!(registry.open_writer(&id).is_err());
}
