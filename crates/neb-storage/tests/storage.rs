use neb_storage::{
    publish_reader, safe_join, validate_key, AddStorageRequest, PreparedDestination,
    StorageRegistry,
};
use std::{
    fs,
    io::{Cursor, Read, Write},
    net::TcpListener,
    path::Path,
};

fn request(kind: &str, endpoint: &str) -> AddStorageRequest {
    serde_json::from_value(serde_json::json!({"name":"Fixture", "kind":kind, "endpoint":endpoint,
        "bucket":if kind == "s3" { Some("bucket") } else { None },
        "access_key":"fixture-key", "secret_key":"fixture-secret", "username":"test", "password":"fixture-password"})).unwrap()
}

#[test]
fn publication_rejects_overwrite_and_bad_hash_and_cleans_temporary_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("photo.jpg");
    assert!(publish_reader(&mut Cursor::new(b"photo"), &path, Some("invalid")).is_err());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    let (size, _) = publish_reader(&mut Cursor::new(b"photo"), &path, None).unwrap();
    assert_eq!(size, 5);
    assert!(publish_reader(&mut Cursor::new(b"different"), &path, None).is_err());
    assert_eq!(fs::read(path).unwrap(), b"photo");
}

#[test]
fn hostile_keys_are_rejected_cross_platform() {
    for key in [
        "../a", "/a", "a/../b", "C:/a", "a\\b", "a//b", "CON.jpg", "a./b", "a/./b", "a\0b",
    ] {
        assert!(validate_key(key, false).is_err(), "{key}");
    }
    assert!(validate_key("照片/IMG_001.CR3", false).is_ok());
}

#[test]
fn local_listing_is_paginated_and_credentials_are_never_saved() {
    let data = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("b.jpg"), b"b").unwrap();
    fs::write(source.path().join("a.jpg"), b"a").unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let config = registry
        .add(request("local", source.path().to_str().unwrap()))
        .unwrap();
    let page = registry.browse(&config.id, "", 1, None).unwrap();
    assert_eq!(page.entries[0].key, "a.jpg");
    let page = registry
        .browse(&config.id, "", 1, page.next_cursor.as_deref())
        .unwrap();
    assert_eq!(page.entries[0].key, "b.jpg");
    assert!(page.next_cursor.is_none());
    let json = fs::read_to_string(data.path().join("storage.json")).unwrap();
    assert!(!json.contains("fixture-password"));
    assert!(!json.contains("fixture-secret"));
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_escape_local_root() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("private.jpg"), b"private").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
    assert!(safe_join(root.path(), "link/private.jpg", false).is_err());
}

fn server(
    body: &'static str,
    inspect: impl FnOnce(String) + Send + 'static,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            if request.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        inspect(String::from_utf8(request).unwrap());
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/xml\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    (format!("http://{address}"), handle)
}

#[test]
fn webdav_lists_and_rejects_an_out_of_root_href() {
    let (endpoint, thread) = server("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/album/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/album/photo.jpg</d:href><d:propstat><d:prop><d:getcontentlength>42</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>", |request| {
        assert!(request.starts_with("PROPFIND /album/ HTTP/1.1")); assert!(request.to_lowercase().contains("depth: 1"));
    });
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let mut input = request("webdav", &endpoint);
    input.root = Some("album".to_string());
    let config = registry.add(input).unwrap();
    let page = registry.browse(&config.id, "", 50, None).unwrap();
    assert_eq!(page.entries[0].key, "photo.jpg");
    assert_eq!(page.entries[0].size, 42);
    thread.join().unwrap();
    let (endpoint, thread) = server("<multistatus><response><href>/other/private.jpg</href><propstat><prop><getcontentlength>3</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>", |_| {});
    let mut input = request("webdav", &endpoint);
    input.root = Some("album".to_string());
    let config = registry.add(input).unwrap();
    assert!(registry.browse(&config.id, "", 50, None).is_err());
    thread.join().unwrap();
}

#[test]
fn s3_signs_paginated_list_and_reconnect_is_required_after_restart() {
    let (endpoint, thread) = server("<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next token</NextContinuationToken><Contents><Key>album/photo.jpg</Key><Size>42</Size></Contents></ListBucketResult>", |request| {
        assert!(request.starts_with("GET /bucket?")); assert!(request.contains("prefix=album%2F"));
        assert!(request.to_lowercase().contains("authorization: aws4-hmac-sha256 credential=fixture-key/"));
        assert!(request.contains("/us-east-1/s3/aws4_request")); assert!(!request.contains("fixture-secret"));
    });
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let mut input = request("s3", &endpoint);
    input.root = Some("album".to_string());
    let config = registry.add(input).unwrap();
    let page = registry.browse(&config.id, "", 50, None).unwrap();
    assert_eq!(page.entries[0].key, "photo.jpg");
    assert_eq!(page.next_cursor.as_deref(), Some("next token"));
    thread.join().unwrap();
    let registry = StorageRegistry::open(data.path()).unwrap();
    assert!(!registry.list()[0].connected);
    assert!(registry.browse(&config.id, "", 50, None).is_err());
}

#[test]
fn s3_download_encodes_reserved_key_bytes_and_never_replaces_local_files() {
    let (endpoint, thread) = server("photo-content", |request| {
        assert!(
            request.starts_with("GET /bucket/a%20%2B%21%27%E9%9B%AA.jpg HTTP/1.1"),
            "unexpected request path"
        );
    });
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let config = registry.add(request("s3", &endpoint)).unwrap();
    let path = data.path().join("photo.jpg");
    let result = registry.fetch(&config.id, "a +!'雪.jpg", &path).unwrap();
    assert_eq!(result.size, 13);
    assert_eq!(result.sha256.len(), 64);
    assert_eq!(fs::read(path).unwrap(), b"photo-content");
    thread.join().unwrap();
}

#[test]
fn safe_join_does_not_accept_missing_root() {
    assert!(safe_join(Path::new("missing-nebulume-test-root"), "x.jpg", false).is_err());
}

#[test]
fn source_specific_environment_credentials_reconnect_without_persistence() {
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let config = registry
        .add(request("s3", "https://example.invalid"))
        .unwrap();
    let prefix = format!(
        "NEBULUME_STORAGE_{}_",
        config.id.replace('-', "_").to_ascii_uppercase()
    );
    std::env::set_var(format!("{prefix}ACCESS_KEY"), "env-access");
    std::env::set_var(format!("{prefix}SECRET_KEY"), "env-secret");
    let reopened = StorageRegistry::open(data.path()).unwrap();
    std::env::remove_var(format!("{prefix}ACCESS_KEY"));
    std::env::remove_var(format!("{prefix}SECRET_KEY"));
    assert!(reopened.list()[0].connected);
    assert!(!fs::read_to_string(data.path().join("storage.json"))
        .unwrap()
        .contains("env-secret"));
}

#[test]
fn prepared_destination_remains_read_only_until_materialized() {
    let parent = tempfile::tempdir().unwrap();
    let destination = parent.path().join("new-library");
    let prepared = PreparedDestination::new(&destination).unwrap();
    assert!(!destination.exists());
    let scoped = prepared.materialize().unwrap();
    scoped
        .publish(&mut Cursor::new(b"original"), "date/photo.jpg", None)
        .unwrap();
    assert_eq!(
        fs::read(destination.join("date/photo.jpg")).unwrap(),
        b"original"
    );
}

#[cfg(unix)]
#[test]
fn publication_stays_on_pinned_parent_when_path_is_replaced_during_copy() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("date")).unwrap();
    let scoped = PreparedDestination::new(root.path())
        .unwrap()
        .materialize()
        .unwrap();
    struct SwapOnRead {
        source: Cursor<Vec<u8>>,
        before: std::path::PathBuf,
        moved: std::path::PathBuf,
        outside: std::path::PathBuf,
        swapped: bool,
    }
    impl Read for SwapOnRead {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            if !self.swapped {
                fs::rename(&self.before, &self.moved)?;
                std::os::unix::fs::symlink(&self.outside, &self.before)?;
                self.swapped = true;
            }
            self.source.read(bytes)
        }
    }
    let mut reader = SwapOnRead {
        source: Cursor::new(b"original".to_vec()),
        before: root.path().join("date"),
        moved: root.path().join("pinned-date"),
        outside: outside.path().to_path_buf(),
        swapped: false,
    };
    scoped.publish(&mut reader, "date/photo.jpg", None).unwrap();
    assert!(!outside.path().join("photo.jpg").exists());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    assert_eq!(
        fs::read(root.path().join("pinned-date/photo.jpg")).unwrap(),
        b"original"
    );
}

#[cfg(unix)]
#[test]
fn replacing_an_unopened_target_child_with_a_link_fails_safely() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let scoped = PreparedDestination::new(root.path())
        .unwrap()
        .materialize()
        .unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("date")).unwrap();
    assert!(scoped
        .publish(&mut Cursor::new(b"original"), "date/photo.jpg", None)
        .is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}
