//! One-time inspection refresh for the newly supported camera. Keep unrelated
//! photos' cache fingerprints, remote metadata and all user edits intact.

use anyhow::Result;
use rusqlite::Transaction;

const KEY: &str = "inspection.nikon-z5ii.v1";

pub(super) fn invalidate(transaction: &Transaction<'_>) -> Result<()> {
    let applied: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key=?1)",
        [KEY],
        |row| row.get(0),
    )?;
    if !applied {
        transaction.execute(
            "UPDATE assets SET modified_stamp='' WHERE source_key IS NULL
             AND lower(extension)='nef'
             AND json_extract(metadata_json,'$.Camera') IN ('NIKON Z5_2','Nikon Z 5 II')",
            [],
        )?;
        transaction.execute("INSERT INTO app_settings(key,value) VALUES(?1,'1')", [KEY])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Core;
    use rusqlite::{params, Connection};
    use serde_json::json;

    fn legacy_catalog(directory: &std::path::Path) -> Connection {
        drop(Core::open(directory).unwrap());
        let db = Connection::open(directory.join("catalog.sqlite3")).unwrap();
        db.execute("DELETE FROM app_settings WHERE key=?1", [KEY])
            .unwrap();
        db.execute(
            "INSERT INTO libraries(id,name,root,root_key,created_at) VALUES('lib','photos','photos','photos','')",
            [],
        ).unwrap();
        db
    }

    fn insert(db: &Connection, id: &str, ext: &str, camera: &str, remote: bool) {
        db.execute(
            "INSERT INTO assets(id,library_id,path,path_key,filename,extension,kind,size,modified_at,
             modified_stamp,availability,metadata_json,source_key,rating,flag,crop_json)
             VALUES(?1,'lib',?1,?1,?1,?2,'raw',100,'','inspect-v2:unchanged','available',?3,?4,4,'pick',?5)",
            params![id, ext, json!({"Camera":camera,"Decode Status":"RAW 原始解码不可用"}).to_string(),
                remote.then_some(id), r#"{"x":0,"y":0,"width":0.5,"height":1}"#],
        ).unwrap();
    }

    #[test]
    fn opening_a_mixed_catalog_refreshes_only_local_z5ii_nefs_once() {
        let temp = tempfile::tempdir().unwrap();
        let db = legacy_catalog(temp.path());
        for (id, ext, camera, remote) in [
            ("old", "nef", "NIKON Z5_2", false),
            ("clean-name", "NEF", "Nikon Z 5 II", false),
            ("jpeg", "jpg", "NIKON Z5_2", false),
            ("other-nikon", "nef", "NIKON Z 5", false),
            ("unknown", "nef", "", false),
            ("remote", "nef", "NIKON Z5_2", true),
        ] {
            insert(&db, id, ext, camera, remote);
        }
        let before: Vec<(String, String)> = db
            .prepare("SELECT id,metadata_json FROM assets ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        drop(Core::open(temp.path()).unwrap());
        for (id, metadata) in before {
            let (stamp, actual, rating, flag, crop): (String, String, i64, String, String) = db.query_row(
                "SELECT modified_stamp,metadata_json,rating,flag,crop_json FROM assets WHERE id=?1",
                [&id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
            ).unwrap();
            assert_eq!(
                stamp,
                if id == "old" || id == "clean-name" {
                    ""
                } else {
                    "inspect-v2:unchanged"
                }
            );
            assert_eq!(actual, metadata);
            assert_eq!((rating, flag.as_str()), (4, "pick"));
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&crop).unwrap()["width"],
                0.5
            );
        }
        // A refreshed row must not be invalidated on every app start.
        db.execute(
            "UPDATE assets SET modified_stamp='inspect-v2:refreshed' WHERE id='old'",
            [],
        )
        .unwrap();
        drop(Core::open(temp.path()).unwrap());
        let stamp: String = db
            .query_row(
                "SELECT modified_stamp FROM assets WHERE id='old'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stamp, "inspect-v2:refreshed");
    }

    #[test]
    fn failed_marker_write_rolls_back_invalidation_and_can_be_retried() {
        let temp = tempfile::tempdir().unwrap();
        let db = legacy_catalog(temp.path());
        insert(&db, "old", "nef", "NIKON Z5_2", false);
        db.execute_batch("CREATE TRIGGER fail_marker BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(Core::open(temp.path()).is_err());
        let stamp: String = db
            .query_row("SELECT modified_stamp FROM assets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamp, "inspect-v2:unchanged");
        db.execute_batch("DROP TRIGGER fail_marker;").unwrap();
        drop(Core::open(temp.path()).unwrap());
        let stamp: String = db
            .query_row("SELECT modified_stamp FROM assets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamp, "");
    }
}
