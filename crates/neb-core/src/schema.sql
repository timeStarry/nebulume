CREATE TABLE IF NOT EXISTS libraries (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    root TEXT NOT NULL,
    root_key TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY NOT NULL,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    path TEXT NOT NULL,
    path_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    extension TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('raster','raw')),
    size INTEGER NOT NULL,
    modified_at TEXT NOT NULL,
    modified_stamp TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    crop_json TEXT,
    availability TEXT NOT NULL,
    UNIQUE(library_id,path_key)
);
CREATE INDEX IF NOT EXISTS assets_library_modified ON assets(library_id,modified_at DESC);
CREATE INDEX IF NOT EXISTS assets_rating ON assets(rating);
CREATE INDEX IF NOT EXISTS assets_extension ON assets(extension);
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(filename,metadata_json,content=assets,content_rowid=rowid,tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS assets_ai AFTER INSERT ON assets BEGIN
    INSERT INTO assets_fts(rowid,filename,metadata_json) VALUES(new.rowid,new.filename,new.metadata_json);
END;
CREATE TRIGGER IF NOT EXISTS assets_ad AFTER DELETE ON assets BEGIN
    INSERT INTO assets_fts(assets_fts,rowid,filename,metadata_json) VALUES('delete',old.rowid,old.filename,old.metadata_json);
END;
CREATE TRIGGER IF NOT EXISTS assets_au AFTER UPDATE ON assets BEGIN
    INSERT INTO assets_fts(assets_fts,rowid,filename,metadata_json) VALUES('delete',old.rowid,old.filename,old.metadata_json);
    INSERT INTO assets_fts(rowid,filename,metadata_json) VALUES(new.rowid,new.filename,new.metadata_json);
END;
PRAGMA user_version=1;
