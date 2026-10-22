//! Remote import against a loopback WebDAV stand-in that honours no-overwrite.
use neb_ingest::{IngestService, KnownAsset, OrganizeRules};
use neb_storage::StorageRegistry;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

type Store = Arc<Mutex<HashMap<String, Vec<u8>>>>;

fn serve() -> (String, Store) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let store: Store = Arc::default();
    let shared = store.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let store = shared.clone();
            thread::spawn(move || handle(stream, &store));
        }
    });
    (format!("http://127.0.0.1:{port}/dav/"), store)
}

fn handle(mut stream: TcpStream, store: &Store) {
    let mut data = Vec::new();
    let mut buffer = [0u8; 8192];
    let end = loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => data.extend_from_slice(&buffer[..n]),
        }
        if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&data[..end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap().split(' ');
    let method = first.next().unwrap().to_owned();
    let path = first.next().unwrap().to_owned();
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = data[end..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut buffer).unwrap_or(0);
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buffer[..n]);
    }
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
            Some(bytes) => ("200 OK", bytes.clone()),
            None => ("404 Not Found", vec![]),
        },
        "DELETE" => {
            files.remove(&path);
            ("204 No Content", vec![])
        }
        "MKCOL" => ("201 Created", vec![]),
        "PUT" if files.contains_key(&path) => ("412 Precondition Failed", vec![]),
        "PUT" => {
            files.insert(path, body);
            ("201 Created", vec![])
        }
        "MOVE" => {
            let destination = headers["destination"]
                .splitn(4, '/')
                .nth(3)
                .map(|p| format!("/{p}"))
                .unwrap();
            if files.contains_key(&destination) {
                ("412 Precondition Failed", vec![])
            } else {
                let bytes = files.remove(&path).unwrap_or_default();
                files.insert(destination, bytes);
                ("201 Created", vec![])
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

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[test]
fn remote_import_publishes_new_files_and_skips_known_content() {
    let (endpoint, store) = serve();
    let data = tempfile::tempdir().unwrap();
    let card = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::create_dir_all(card.path().join("DCIM/100")).unwrap();
    fs::write(card.path().join("DCIM/100/new.NEF"), b"new raw").unwrap();
    fs::write(card.path().join("DCIM/100/old.NEF"), b"already on nas").unwrap();
    fs::write(card.path().join("DCIM/100/copy.NEF"), b"new raw").unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let id = registry
        .add(
            serde_json::from_value(serde_json::json!({
                "name":"NAS","kind":"webdav","endpoint":endpoint,
                "username":"u","password":"p","remember_credentials":false
            }))
            .unwrap(),
        )
        .unwrap()
        .id;
    let known = [KnownAsset {
        key: "photos/archive/old.NEF".into(),
        size: 14,
        sha256: Some(sha(b"already on nas")),
        filename: "old.NEF".into(),
        captured_at: String::new(),
    }];
    let rules: OrganizeRules =
        serde_json::from_value(serde_json::json!({"date_basis":"import","subfolder":"Z8"}))
            .unwrap();
    let mut ingest = IngestService::open(state.path()).unwrap();
    let plan = ingest
        .plan_remote(card.path(), &id, "photos", &rules, true, &known)
        .unwrap();
    assert!(store.lock().unwrap().is_empty(), "planning never writes");
    assert_eq!(plan.duplicate_count, 2, "known hash plus in-batch copy");
    assert_eq!(plan.destination_location.as_deref(), Some(id.as_str()));
    let writer = registry.open_writer(&id).unwrap();
    let result = ingest.execute_remote(&plan.id, &writer, false).unwrap();
    assert_eq!((result.copied, result.duplicates, result.failed), (1, 2, 0));
    let day = &plan.import_day;
    // new.NEF and copy.NEF share bytes: whichever is discovered first is published.
    let stored: Vec<(String, Vec<u8>)> = store
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    assert_eq!(stored.len(), 1, "no temporary files left: {stored:?}");
    let (key, bytes) = &stored[0];
    assert_eq!(bytes, b"new raw");
    let name = key.rsplit('/').next().unwrap().to_owned();
    assert!(key.starts_with(&format!("/dav/photos/Z8/{day}/")), "{key}");
    // Originals stay on the card; a plan can run only once.
    assert!(card.path().join("DCIM/100/new.NEF").exists());
    assert!(ingest.execute_remote(&plan.id, &writer, false).is_err());

    // Same name, different content: renamed with a hash suffix, never overwritten.
    let other = tempfile::tempdir().unwrap();
    fs::write(other.path().join(&name), b"changed").unwrap();
    let plan = ingest
        .plan_remote(other.path(), &id, "photos", &rules, false, &[])
        .unwrap();
    let result = ingest.execute_remote(&plan.id, &writer, false).unwrap();
    assert_eq!((result.copied, result.failed), (1, 0));
    assert_ne!(result.items[0].destination, key.trim_start_matches("/dav/"));
    assert_eq!(
        &store.lock().unwrap()[key],
        b"new raw",
        "existing file untouched"
    );
    assert_eq!(store.lock().unwrap().len(), 2);
}

#[test]
fn unverified_name_matches_are_skipped_unless_included() {
    let (endpoint, store) = serve();
    let data = tempfile::tempdir().unwrap();
    let card = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    // Minimal TIFF with DateTimeOriginal 2026:10:22 so the capture day is known.
    fs::write(card.path().join("a.tif"), tiff("2026:10:22 08:00:00")).unwrap();
    let size = fs::metadata(card.path().join("a.tif")).unwrap().len();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let id = registry
        .add(
            serde_json::from_value(serde_json::json!({
                "name":"NAS","kind":"webdav","endpoint":endpoint,"remember_credentials":false
            }))
            .unwrap(),
        )
        .unwrap()
        .id;
    let known = [KnownAsset {
        key: "old/a.tif".into(),
        size,
        sha256: None,
        filename: "A.TIF".into(),
        captured_at: "2026-10-22T08:00:00.000".into(),
    }];
    let mut ingest = IngestService::open(state.path()).unwrap();
    let rules = OrganizeRules::default();
    let plan = ingest
        .plan_remote(card.path(), &id, "", &rules, true, &known)
        .unwrap();
    assert_eq!(plan.likely_duplicate_count, 1);
    assert_eq!(plan.items[0].status, "likely_duplicate");
    let writer = registry.open_writer(&id).unwrap();
    let skipped = ingest.execute_remote(&plan.id, &writer, false).unwrap();
    assert_eq!(skipped.items[0].status, "likely_duplicate");
    assert!(store.lock().unwrap().is_empty());
    let plan = ingest
        .plan_remote(card.path(), &id, "", &rules, true, &known)
        .unwrap();
    let included = ingest.execute_remote(&plan.id, &writer, true).unwrap();
    assert_eq!(included.copied, 1);
}

fn tiff(datetime: &str) -> Vec<u8> {
    // Little-endian TIFF: IFD0 with one ExifIFD pointer; Exif IFD with DateTimeOriginal.
    let mut value = datetime.as_bytes().to_vec();
    value.push(0);
    let mut out = b"II*\0".to_vec();
    out.extend(8u32.to_le_bytes());
    // IFD0 at 8: 1 entry, ExifIFD (0x8769) LONG -> 26
    out.extend(1u16.to_le_bytes());
    out.extend(0x8769u16.to_le_bytes());
    out.extend(4u16.to_le_bytes());
    out.extend(1u32.to_le_bytes());
    out.extend(26u32.to_le_bytes());
    out.extend(0u32.to_le_bytes());
    // Exif IFD at 26: 1 entry, DateTimeOriginal (0x9003) ASCII count 20 -> 44
    out.extend(1u16.to_le_bytes());
    out.extend(0x9003u16.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend((value.len() as u32).to_le_bytes());
    out.extend(44u32.to_le_bytes());
    out.extend(0u32.to_le_bytes());
    out.extend(value);
    out
}
