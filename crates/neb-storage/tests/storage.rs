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
        "access_key":"fixture-key", "secret_key":"fixture-secret", "username":"test", "password":"fixture-password", "remember_credentials":false})).unwrap()
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
    body: impl Into<String>,
    inspect: impl FnOnce(String) + Send + 'static,
) -> (String, std::thread::JoinHandle<()>) {
    let body = body.into();
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

fn browse_webdav_xml(body: String) -> anyhow::Result<Vec<neb_storage::StorageEntry>> {
    let (endpoint, thread) = server(body, |request| {
        assert!(request.starts_with("PROPFIND /album/ HTTP/1.1"));
        assert!(request.to_ascii_lowercase().contains("depth: 1"));
    });
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let mut input = request("webdav", &endpoint);
    input.root = Some("album".to_string());
    let config = registry.add(input).unwrap();
    let result = registry.browse(&config.id, "", 50, None);
    thread.join().unwrap();
    result.map(|page| page.entries)
}

#[test]
fn webdav_content_lengths_accept_empty_missing_whitespace_and_unsigned_numbers() {
    let cases = [
        ("folder/", "<d:getcontentlength/>", true, 0),
        (
            "empty.jpg",
            "<d:getcontentlength></d:getcontentlength>",
            false,
            0,
        ),
        ("self-closing.jpg", "<d:getcontentlength/>", false, 0),
        ("missing.jpg", "", false, 0),
        (
            "whitespace.jpg",
            "<d:getcontentlength> \t\r\n </d:getcontentlength>",
            false,
            0,
        ),
        (
            "zero.jpg",
            "<d:getcontentlength>0</d:getcontentlength>",
            false,
            0,
        ),
        (
            "number.jpg",
            "<d:getcontentlength>42</d:getcontentlength>",
            false,
            42,
        ),
        (
            "padded.jpg",
            "<d:getcontentlength> \n 123 \t </d:getcontentlength>",
            false,
            123,
        ),
        (
            "maximum.jpg",
            "<d:getcontentlength>18446744073709551615</d:getcontentlength>",
            false,
            u64::MAX,
        ),
    ];
    // The collection's own response often contains an empty size too. It is not an entry.
    let mut xml = String::from("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/album/</d:href><d:propstat><d:prop><d:getcontentlength></d:getcontentlength><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>");
    for (name, length, directory, _) in cases {
        let resource_type = if directory {
            "<d:resourcetype><d:collection/></d:resourcetype>"
        } else {
            "<d:resourcetype/>"
        };
        xml.push_str(&format!("<d:response><d:href>/album/{name}</d:href><d:propstat><d:prop>{length}{resource_type}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"));
    }
    xml.push_str("</d:multistatus>");
    let entries = browse_webdav_xml(xml).unwrap();
    assert_eq!(entries.len(), cases.len());
    for (name, _, is_dir, size) in cases {
        let entry = entries
            .iter()
            .find(|entry| entry.key == name.trim_end_matches('/'))
            .unwrap();
        assert_eq!((entry.is_dir, entry.size), (is_dir, size), "{name}");
    }
}

#[test]
fn webdav_failed_propstats_do_not_parse_or_override_successful_properties() {
    for invalid_length in ["", "garbage"] {
        for failed_first in [false, true] {
            let failed = format!("<d:propstat><d:prop><d:getcontentlength>{invalid_length}</d:getcontentlength><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>");
            let success = "<d:propstat><d:prop><d:resourcetype/><d:getcontentlength>27</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>";
            let properties = if failed_first {
                format!("{failed}{success}")
            } else {
                format!("{success}{failed}")
            };
            let entries = browse_webdav_xml(format!("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/album/photo.jpg</d:href>{properties}</d:response></d:multistatus>"))
                .unwrap_or_else(|error| panic!("failed_first={failed_first}, value={invalid_length:?}: {error:#}"));
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].key, "photo.jpg");
            assert_eq!(entries[0].size, 27);
            assert!(!entries[0].is_dir);
        }
    }
}

#[test]
fn webdav_merges_resource_type_and_length_across_successful_propstats() {
    for length_first in [false, true] {
        let mut xml = String::from("<d:multistatus xmlns:d=\"DAV:\">");
        for (name, resource_type) in [("folder/", "<d:collection/>"), ("photo.jpg", "")] {
            let resource = format!("<d:propstat><d:prop><d:resourcetype>{resource_type}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>");
            let length = "<d:propstat><d:prop><d:getcontentlength> 43 </d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>";
            let properties = if length_first {
                format!("{length}{resource}")
            } else {
                format!("{resource}{length}")
            };
            xml.push_str(&format!(
                "<d:response><d:href>/album/{name}</d:href>{properties}</d:response>"
            ));
        }
        xml.push_str("</d:multistatus>");
        let entries = browse_webdav_xml(xml).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "folder");
        assert!(entries[0].is_dir, "length_first={length_first}");
        assert_eq!(entries[1].key, "photo.jpg");
        assert!(!entries[1].is_dir, "length_first={length_first}");
        assert_eq!(entries[1].size, 43, "length_first={length_first}");
    }
    for second_length in [43, 44] {
        let result = browse_webdav_xml(format!("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/album/photo.jpg</d:href><d:propstat><d:prop><d:getcontentlength>43</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontentlength>{second_length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"));
        if second_length == 43 {
            assert_eq!(result.unwrap()[0].size, 43);
        } else {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("Conflicting WebDAV getcontentlength"));
        }
    }
}

#[test]
fn webdav_successful_file_lengths_reject_nonempty_invalid_negative_and_overflow_values() {
    for invalid_length in ["garbage", "-1", "18446744073709551616"] {
        let result = browse_webdav_xml(format!("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/album/photo.jpg</d:href><d:propstat><d:prop><d:getcontentlength>{invalid_length}</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"));
        let error = result.expect_err("A malformed nonempty file size must not become zero");
        assert!(
            error
                .to_string()
                .contains("Invalid WebDAV getcontentlength"),
            "{invalid_length}: {error:#}"
        );
    }
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
    assert!(!reopened.list()[0].connected);
    assert_eq!(reopened.list()[0].credential_status, "session");
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
