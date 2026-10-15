use neb_service::Service;
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
};

const PHOTO: &[u8] = b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00";
const CHANGED_PHOTO: &[u8] = b"P6\n1 2\n255\n\xff\x00\x00\x00\xff\x00";

#[test]
fn local_library_belongs_to_a_source_and_old_root_input_still_works() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::create_dir(photos.path().join("album")).unwrap();
    fs::write(photos.path().join("album/photo.ppm"), PHOTO).unwrap();
    let svc = Service::open(data.path()).unwrap();
    let source=svc.execute("storage.add",json!({"name":"本地磁盘","kind":"local","endpoint":photos.path(),"remember_credentials":false})).unwrap();
    let library = svc
        .execute(
            "library.add",
            json!({"name":"相册","storage_id":source["id"],"prefix":"album"}),
        )
        .unwrap();
    assert_eq!(library["storage_id"], source["id"]);
    assert_eq!(library["source_prefix"], "album");
    assert_eq!(library["source_kind"], "local");
    assert!(library["root"].as_str().unwrap().ends_with("album"));
    assert_eq!(
        svc.execute("library.scan", json!({"library_id":library["id"]}))
            .unwrap()["indexed"],
        1
    );
    assert!(svc
        .execute(
            "library.add",
            json!({"name":"越界","storage_id":source["id"],"prefix":"../outside"})
        )
        .is_err());
    let same = svc
        .execute(
            "library.add",
            json!({"name":"同目录","storage_id":source["id"],"prefix":"album"}),
        )
        .unwrap();
    assert_eq!(same["id"], library["id"]);
    drop(svc);
    let svc = Service::open(data.path()).unwrap();
    assert_eq!(
        svc.execute("library.list", json!({})).unwrap()[0]["storage_id"],
        source["id"]
    );
}

#[test]
fn webdav_library_indexes_without_get_then_caches_on_demand_and_works_offline() {
    let data = tempfile::tempdir().unwrap();
    webdav_library_roundtrip(data.path(), false, false);
}

#[cfg(windows)]
#[test]
fn webdav_long_cache_path_preserves_existing_placeholder_identity_and_edits() {
    use std::os::windows::ffi::OsStrExt;
    for already_published in [false, true] {
        let data = tempfile::tempdir().unwrap();
        // The root stays below MAX_PATH; the hashed cache filename crosses it.
        let base_len = data.path().as_os_str().encode_wide().count();
        let profile = data
            .path()
            .join("p".repeat(115usize.checked_sub(base_len + 1).unwrap()));
        webdav_library_roundtrip(&profile, true, already_published);
    }
}

fn webdav_library_roundtrip(
    data: &std::path::Path,
    expect_long_cache: bool,
    already_published: bool,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for step in 0..if already_published { 2 } else { 3 } {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request);
            let (status, content_type, body) = if step == 0 {
                assert!(request.starts_with("PROPFIND /album/ HTTP/1.1"));
                ("207 Multi-Status","application/xml",b"<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/album/photo.ppm</d:href><d:propstat><d:prop><d:getcontentlength/><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>".as_slice())
            } else {
                assert!(request.starts_with("GET /album/photo.ppm HTTP/1.1"));
                (
                    "200 OK",
                    "image/x-portable-pixmap",
                    if step == 1 && !already_published {
                        PHOTO
                    } else {
                        CHANGED_PHOTO
                    },
                )
            };
            write!(stream,"HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
            stream.write_all(body).unwrap();
        }
    });
    let svc = Service::open(data).unwrap();
    let source=svc.execute("storage.add",json!({"name":"测试DAV","kind":"webdav","endpoint":endpoint,"username":"test-user","password":"synthetic-fixture","remember_credentials":false})).unwrap();
    let library = svc
        .execute(
            "library.add",
            json!({"name":"远端相册","storage_id":source["id"],"prefix":"album"}),
        )
        .unwrap();
    assert_eq!(library["source_kind"], "webdav");
    assert_eq!(
        svc.execute("library.scan", json!({"library_id":library["id"]}))
            .unwrap()["indexed"],
        1
    );
    let assets = svc
        .execute("asset.list", json!({"library_id":library["id"]}))
        .unwrap();
    let asset = &assets["items"][0];
    assert_eq!(asset["source_key"], "album/photo.ppm");
    assert_eq!(asset["availability"], "remote");
    assert!(!std::path::Path::new(asset["path"].as_str().unwrap()).exists());
    if expect_long_cache {
        assert!(library["root"].as_str().unwrap().len() < 260);
        assert!(asset["path"].as_str().unwrap().len() > 260);
        assert!(!library["root"].as_str().unwrap().starts_with(r"\\?\"));
    }
    if already_published {
        // An old failed preview may have downloaded the original before hitting
        // the path guard. Recovery must reuse that cache without another GET.
        fs::write(asset["path"].as_str().unwrap(), PHOTO).unwrap();
    }
    // Edit the already indexed placeholder, then reopen the catalog before the
    // first GET. The fix must work with existing indexes without rebuilding them.
    svc.execute("asset.rate", json!({"id":asset["id"],"rating":3}))
        .unwrap();
    let cropped = svc
        .execute(
            "asset.crop",
            json!({"id":asset["id"],"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
        )
        .unwrap();
    drop(svc);
    let svc = Service::open(data).unwrap();
    svc.execute("storage.add",json!({"name":"测试DAV","kind":"webdav","endpoint":endpoint,"username":"test-user","password":"synthetic-fixture","remember_credentials":false})).unwrap();
    // Focus inspection is itself an explicit original read. It must materialize
    // a remote file even when no image/EXIF panel has been opened yet.
    let focus = svc
        .execute("asset.focus", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(focus["status"], "unsupported"); // PPM has no MakerNote.
    assert_eq!(focus["regions"], json!([]));
    let opened = svc.execute("asset.get", json!({"id":asset["id"]})).unwrap();
    assert_eq!(opened["id"], asset["id"]);
    assert_eq!(opened["path"], asset["path"]);
    assert_eq!(opened["rating"], 3);
    assert_eq!(opened["crop"], cropped["crop"]);
    assert_eq!(opened["width"], 2);
    assert_eq!(opened["height"], 1);
    assert_eq!(opened["availability"], "available");
    assert_eq!(opened["modified_at"], "");
    assert_eq!(opened["filename"], "photo.ppm");
    assert_eq!(
        svc.execute("asset.list", json!({"query":"photo"})).unwrap()["total"],
        1
    );
    svc.execute("asset.rate", json!({"id":asset["id"],"rating":3}))
        .unwrap();
    let refreshed = svc
        .execute("asset.refresh", json!({"id":asset["id"]}))
        .unwrap();
    assert_eq!(PHOTO.len(), CHANGED_PHOTO.len());
    assert_eq!(refreshed["id"], asset["id"]);
    assert_eq!(refreshed["filename"], "photo.ppm");
    assert_eq!(refreshed["width"], 1);
    assert_eq!(refreshed["height"], 2);
    assert_eq!(refreshed["rating"], 3);
    assert_eq!(refreshed["crop"], cropped["crop"]);
    assert_ne!(refreshed["path"], opened["path"]);
    assert_eq!(
        fs::read(refreshed["path"].as_str().unwrap()).unwrap(),
        CHANGED_PHOTO
    );
    assert_eq!(fs::read(opened["path"].as_str().unwrap()).unwrap(), PHOTO);
    server.join().unwrap();
    drop(svc);
    let svc = Service::open(data).unwrap();
    let preview = svc
        .execute("asset.preview", json!({"id":asset["id"],"max_size":32}))
        .unwrap();
    assert!(preview["data_url"]
        .as_str()
        .unwrap()
        .starts_with("data:image/"));
    assert_eq!(
        svc.execute("asset.get", json!({"id":asset["id"]})).unwrap()["rating"],
        3
    );
    assert_eq!(
        svc.execute("asset.list", json!({"library_id":library["id"]}))
            .unwrap()["total"],
        1
    );
    let histogram = svc
        .execute("asset.histogram", json!({"id":asset["id"]}))
        .unwrap();
    assert!(histogram["pixels"].as_u64().unwrap() > 0);
}

#[test]
fn file_open_is_available_through_the_same_service_without_implicit_directory_scan() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    fs::write(photos.path().join("opened.ppm"), PHOTO).unwrap();
    fs::write(photos.path().join("sibling.ppm"), PHOTO).unwrap();
    let svc = Service::open(data.path()).unwrap();
    let asset = svc
        .execute(
            "file.open",
            json!({"path":photos.path().join("opened.ppm")}),
        )
        .unwrap();
    assert_eq!(asset["width"], 2);
    assert_eq!(svc.execute("library.list", json!({})).unwrap(), json!([]));
    assert_eq!(svc.execute("asset.list", json!({})).unwrap()["total"], 0);
    assert_eq!(fs::read(photos.path().join("opened.ppm")).unwrap(), PHOTO);
    assert!(svc
        .execute("file.open", json!({"path":photos.path()}))
        .is_err());
}

#[test]
fn local_asset_reads_reinspect_changes_and_keep_offline_metadata_and_edits() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let path = photos.path().join("photo.ppm");
    fs::write(&path, PHOTO).unwrap();
    let svc = Service::open(data.path()).unwrap();
    let asset = svc.execute("file.open", json!({"path":path})).unwrap();
    svc.execute("asset.rate", json!({"id":asset["id"],"rating":4}))
        .unwrap();
    svc.execute(
        "asset.crop",
        json!({"id":asset["id"],"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
    )
    .unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, CHANGED_PHOTO).unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified + std::time::Duration::from_secs(2)))
        .unwrap();
    let refreshed = svc.execute("asset.get", json!({"id":asset["id"]})).unwrap();
    assert_eq!(refreshed["id"], asset["id"]);
    assert_eq!(refreshed["width"], 1);
    assert_eq!(refreshed["height"], 2);
    assert_eq!(refreshed["rating"], 4);
    assert_eq!(refreshed["crop"]["width"], 0.5);
    assert_ne!(refreshed["modified_at"], asset["modified_at"]);
    fs::remove_file(&path).unwrap();
    let offline = svc.execute("asset.get", json!({"id":asset["id"]})).unwrap();
    assert_eq!(offline, refreshed);
    assert!(svc
        .execute("asset.preview", json!({"id":asset["id"]}))
        .is_err());
    assert!(svc
        .execute("asset.refresh", json!({"id":asset["id"]}))
        .is_err());
}

#[test]
fn completed_card_import_updates_its_target_library_automatically() {
    let data = tempfile::tempdir().unwrap();
    let card = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let mut photo = vec![0u8; 62];
    photo[..2].copy_from_slice(b"BM");
    for (offset, value) in [(2, 62u32), (10, 54), (14, 40), (18, 2), (22, 1), (34, 8)] {
        photo[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    photo[26..28].copy_from_slice(&1u16.to_le_bytes());
    photo[28..30].copy_from_slice(&24u16.to_le_bytes());
    photo[54..].copy_from_slice(&[0, 0, 255, 0, 255, 0, 0, 0]);
    fs::write(card.path().join("card.bmp"), &photo).unwrap();
    let svc = Service::open(data.path()).unwrap();
    let library = svc
        .execute(
            "library.add",
            json!({"name":"导入目标","root":target.path()}),
        )
        .unwrap();
    let plan = svc
        .execute(
            "import.plan",
            json!({"source":card.path(),"destination":target.path()}),
        )
        .unwrap();
    let result = svc
        .execute("import.execute", json!({"plan_id":plan["id"]}))
        .unwrap();
    assert_eq!(result["copied"], 1);
    assert_eq!(result["library_id"], library["id"]);
    assert_eq!(result["indexing"]["indexed"], 1);
    assert_eq!(
        svc.execute("asset.list", json!({"library_id":library["id"]}))
            .unwrap()["total"],
        1
    );
    assert_eq!(fs::read(card.path().join("card.bmp")).unwrap(), photo);
}
