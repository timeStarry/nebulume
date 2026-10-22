use std::collections::BTreeMap;

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Library {
    pub id: String,
    pub name: String,
    pub root: String,
    pub created_at: String,
    pub storage_id: Option<String>,
    pub source_prefix: String,
    pub hidden: bool,
    #[serde(default)]
    pub pair_raw_jpeg: bool,
    /// The location that holds this library (v7). Local directories get an implicit one.
    #[serde(default)]
    pub location_id: Option<String>,
}

/// A storage location's non-secret identity. Credentials never enter the catalog.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Location {
    pub id: String,
    /// local, removable, webdav or s3.
    pub kind: String,
    pub name: String,
    pub endpoint: String,
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub bucket: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub tls_certificate_sha256: Option<String>,
    /// Created automatically for a library added by choosing a folder.
    #[serde(default)]
    pub implicit: bool,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Crop {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            [self.x, self.y, self.width, self.height]
                .iter()
                .all(|v| v.is_finite()),
            "E_INVALID: Crop coordinates must be finite"
        );
        ensure!(
            self.x >= 0.0
                && self.y >= 0.0
                && self.width > 0.0
                && self.height > 0.0
                && self.x < 1.0
                && self.y < 1.0
                && self.x + self.width <= 1.0 + 1e-9
                && self.y + self.height <= 1.0 + 1e-9,
            "E_INVALID: Crop must fit within normalized oriented image bounds (0..1)"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub library_id: String,
    pub path: String,
    pub filename: String,
    pub extension: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: String,
    /// Source filesystem creation/birth time. Empty when the source cannot supply it.
    #[serde(default)]
    pub created_at: String,
    /// Camera-recorded DateTimeOriginal, as local wall-clock time without a guessed zone.
    #[serde(default)]
    pub captured_at: String,
    #[serde(default = "pending_capture_status")]
    pub capture_status: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub rating: u8,
    pub metadata: BTreeMap<String, String>,
    pub crop: Option<Crop>,
    pub availability: String,
    pub source_key: Option<String>,
    /// Culling flag: none, pick or reject. A catalog mark only; never written to the source.
    #[serde(default = "no_flag")]
    pub flag: String,
    /// Location-relative key including the library prefix, with `/` separators (v7).
    /// None only when an old path could not be expressed under its library root.
    #[serde(default)]
    pub key: Option<String>,
}

fn no_flag() -> String {
    "none".to_owned()
}

fn pending_capture_status() -> String {
    "pending".to_owned()
}

#[derive(Debug, Serialize)]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Default, Serialize)]
pub struct ScanReport {
    pub indexed: usize,
    pub skipped: usize,
    pub errors: Vec<ScanError>,
}
