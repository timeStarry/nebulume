//! Import from a card into a WebDAV library through the service, against a loopback
//! server that honours no-overwrite. Never contacts a real NAS.
use neb_service::Service;
use serde_json::json;
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

#[test]
fn card_imports_into_a_nas_library_only_after_a_write_test() {
    let (endpoint, store) = serve();
    let data = tempfile::tempdir().unwrap();
    let card = tempfile::tempdir().unwrap();
    fs::create_dir_all(card.path().join("DCIM/100")).unwrap();
    fs::write(card.path().join("DCIM/100/a.jpg"), b"jpeg bytes").unwrap();
    let svc = Service::open(data.path()).unwrap();
    let source = svc
        .execute(
            "storage.add",
            json!({"name":"NAS","kind":"webdav","endpoint":endpoint,"username":"u","password":"p"}),
        )
        .unwrap();
    let library = svc
        .execute(
            "library.add",
            json!({"name":"NAS 照片","storage_id":source["id"],"prefix":"photos"}),
        )
        .unwrap();
    let listed = svc.execute("storage.list", json!({})).unwrap();
    assert_eq!(listed[0]["write_capability"], "unverified");
    let rules = json!({"date_basis":"import","subfolder":"Z8"});
    let plan = svc
        .execute(
            "import.plan",
            json!({"source":card.path(),"library_id":library["id"],"rules":rules}),
        )
        .unwrap();
    assert_eq!(plan["write_capability"], "unverified");
    assert!(store.lock().unwrap().is_empty(), "planning never writes");
    // Without an explicit write test the import is refused and nothing is written.
    let refused = svc
        .execute(
            "import.execute",
            json!({"plan_id":plan["id"],"library_id":library["id"]}),
        )
        .unwrap_err();
    assert_eq!(refused.code, "E_WRITE_UNVERIFIED");
    assert!(store.lock().unwrap().is_empty());
    let check = svc
        .execute("storage.write_check", json!({"id":source["id"]}))
        .unwrap();
    assert_eq!(check["write_capability"], "verified", "{check}");
    assert!(store.lock().unwrap().is_empty(), "test object removed");
    let result = svc
        .execute(
            "import.execute",
            json!({"plan_id":plan["id"],"library_id":library["id"]}),
        )
        .unwrap();
    assert_eq!(result["copied"], 1, "{result}");
    assert_eq!(result["indexing"]["indexed"], 1);
    let day = plan["import_day"].as_str().unwrap();
    let key = format!("photos/Z8/{day}/a.jpg");
    assert_eq!(store.lock().unwrap()[&format!("/dav/{key}")], b"jpeg bytes");
    // The library lists the published photo at its location key, tagged by batch.
    let assets = svc
        .execute(
            "asset.list",
            json!({"library_id":library["id"],"import_batch_id":result["batch"]["id"]}),
        )
        .unwrap();
    assert_eq!(assets["total"], 1);
    assert_eq!(assets["items"][0]["key"], key);
    assert_eq!(result["batch"]["asset_count"], 1);
    // A second plan sees the stored hash and skips without any download.
    let again = svc
        .execute(
            "import.plan",
            json!({"source":card.path(),"library_id":library["id"],"rules":rules}),
        )
        .unwrap();
    assert_eq!(again["duplicate_count"], 1);
    assert!(
        card.path().join("DCIM/100/a.jpg").exists(),
        "card originals retained"
    );
}
