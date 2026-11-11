ALTER TABLE assets ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
CREATE TABLE asset_search(
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    revision TEXT NOT NULL,
    checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),
    camera TEXT NOT NULL DEFAULT '',
    lens TEXT NOT NULL DEFAULT '',
    iso REAL,
    aperture REAL,
    focal_length REAL,
    exposure REAL
);
CREATE INDEX asset_search_camera ON asset_search(camera);
CREATE INDEX asset_search_lens ON asset_search(lens);
CREATE TRIGGER asset_search_revision_changed AFTER UPDATE OF modified_stamp ON assets WHEN old.modified_stamp<>new.modified_stamp BEGIN
    DELETE FROM asset_search WHERE asset_id=new.id;
END;
CREATE TABLE library_index_settings(
    id INTEGER PRIMARY KEY CHECK(id=1),
    auto_update INTEGER NOT NULL DEFAULT 1 CHECK(auto_update IN (0,1))
);
INSERT INTO library_index_settings(id,auto_update) VALUES(1,1);
CREATE TABLE library_index_bindings(
    library_id TEXT PRIMARY KEY NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    epoch TEXT NOT NULL
);
INSERT INTO library_index_bindings(library_id,epoch) SELECT id,lower(hex(randomblob(16))) FROM libraries;
CREATE TRIGGER library_index_binding_added AFTER INSERT ON libraries BEGIN
    INSERT INTO library_index_bindings(library_id,epoch) VALUES(new.id,lower(hex(randomblob(16))));
END;
CREATE TRIGGER library_index_binding_changed AFTER UPDATE OF root,storage_id,source_prefix ON libraries WHEN old.root IS NOT new.root OR old.storage_id IS NOT new.storage_id OR old.source_prefix IS NOT new.source_prefix BEGIN
    UPDATE library_index_bindings SET epoch=lower(hex(randomblob(16))) WHERE library_id=new.id;
END;
CREATE TABLE remote_scan_revisions(
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    revision TEXT NOT NULL
);
PRAGMA user_version=10;
