use neb_service::Service;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
};

fn names(page: &Value) -> Vec<&str> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|asset| asset["filename"].as_str().unwrap())
        .collect()
}

#[test]
fn webdav_creation_dates_are_indexed_before_sorting_without_fetching_originals() {
    let data = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let mut bytes = [0u8; 4096];
            let count = stream.read(&mut bytes).unwrap();
            assert!(count > 0);
            request.extend_from_slice(&bytes[..count]);
        }
        assert!(String::from_utf8_lossy(&request).starts_with("PROPFIND "));
        let body = r#"<d:multistatus xmlns:d="DAV:">
            <d:response><d:href>/recent.jpg</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength><d:creationdate>2026-10-16T12:00:00+08:00</d:creationdate></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
            <d:response><d:href>/unknown.jpg</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
            <d:response><d:href>/old.jpg</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength><d:creationdate>2001-01-01T00:00:00Z</d:creationdate></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
        </d:multistatus>"#;
        write!(stream,"HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    });
    let svc = Service::open(data.path()).unwrap();
    let source=svc.execute("storage.add",json!({"name":"DAV","kind":"webdav","endpoint":endpoint,"username":"fixture","password":"synthetic","remember_credentials":false})).unwrap();
    let library = svc
        .execute(
            "library.add",
            json!({"name":"Remote","storage_id":source["id"]}),
        )
        .unwrap();
    assert_eq!(
        svc.execute("library.scan", json!({"library_id":library["id"]}))
            .unwrap()["indexed"],
        3
    );
    server.join().unwrap();
    let asc = svc
        .execute(
            "asset.list",
            json!({"library_id":library["id"],"sort_by":"created_at","sort_direction":"asc"}),
        )
        .unwrap();
    let desc = svc
        .execute(
            "asset.list",
            json!({"library_id":library["id"],"sort_by":"created_at","sort_direction":"desc"}),
        )
        .unwrap();
    assert_eq!(names(&asc), ["old.jpg", "recent.jpg", "unknown.jpg"]);
    assert_eq!(names(&desc), ["recent.jpg", "old.jpg", "unknown.jpg"]);
    assert_eq!(
        desc["items"][0]["created_at"],
        "2026-10-16T04:00:00.000000000Z"
    );
    assert_eq!(desc["items"][0]["modified_at"], "");
    assert_eq!(desc["items"][2]["created_at"], "");
    assert!(desc["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|asset| !std::path::Path::new(asset["path"].as_str().unwrap()).exists()));
}
