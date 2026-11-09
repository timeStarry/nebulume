//! Scale check for `asset.list` on a large synthetic catalog. Ignored by default:
//! `cargo test -p neb-core --release --test list_scale -- --ignored --nocapture`.
use neb_core::Core;
use serde_json::json;
use std::time::Instant;

#[test]
#[ignore]
fn list_pages_on_a_hundred_thousand_photos() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    std::fs::write(photos.path().join("seed.jpg"), b"not really a jpeg").unwrap();
    let core = Core::open(data.path()).unwrap();
    let library = core
        .dispatch(
            "library.add",
            json!({"name":"big","root":photos.path(),"pair_raw_jpeg":true}),
        )
        .unwrap();
    let id = library["id"].as_str().unwrap().to_owned();
    core.dispatch("library.scan", json!({"library_id":id}))
        .unwrap();
    let db = rusqlite::Connection::open(data.path().join("catalog.sqlite3")).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(assets)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let select: Vec<String> = columns
        .iter()
        .map(|column| match column.as_str() {
            "id" => "'synthetic-'||n".into(),
            "path" => format!(
                "'{}/d'||(n/500)||'/IMG_'||(n/2)||(CASE WHEN n%2=0 THEN '.nef' ELSE '.jpg' END)",
                photos.path().display()
            ),
            "path_key" => "'synthetic-key-'||n".into(),
            "key" => "'synthetic-'||n".into(),
            "filename" => "'IMG_'||(n/2)||(CASE WHEN n%2=0 THEN '.nef' ELSE '.jpg' END)".into(),
            "extension" => "CASE WHEN n%2=0 THEN 'nef' ELSE 'jpg' END".into(),
            "kind" => "CASE WHEN n%2=0 THEN 'raw' ELSE 'raster' END".into(),
            "captured_at" => "printf('2025-%02d-%02dT10:00:00', 1+n%12, 1+n%28)".into(),
            "rating" => "n%6".into(),
            other => other.into(),
        })
        .collect();
    let started = Instant::now();
    db.execute_batch(&format!(
        "BEGIN; WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100000)
         INSERT INTO assets({}) SELECT {} FROM seq, (SELECT * FROM assets LIMIT 1); COMMIT;",
        columns.join(","),
        select.join(",")
    ))
    .unwrap();
    println!("insert 100k: {:?}", started.elapsed());
    for (label, params) in [
        ("first page", json!({"library_id":id,"limit":200})),
        (
            "deep page",
            json!({"library_id":id,"limit":200,"offset":60000}),
        ),
        (
            "rating sort",
            json!({"library_id":id,"limit":200,"sort_by":"rating"}),
        ),
        (
            "search",
            json!({"library_id":id,"limit":200,"query":"IMG_9"}),
        ),
        (
            "4 stars up",
            json!({"library_id":id,"limit":200,"rating":4}),
        ),
        ("first page again", json!({"library_id":id,"limit":200})),
        (
            "next page",
            json!({"library_id":id,"limit":200,"offset":200}),
        ),
        (
            "deep page again",
            json!({"library_id":id,"limit":200,"offset":60000}),
        ),
    ] {
        let started = Instant::now();
        let result = core.dispatch("asset.list", params).unwrap();
        println!(
            "{label}: {:?} (total {}, files {})",
            started.elapsed(),
            result["total"],
            result["file_total"]
        );
    }
}
