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
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub rating: u8,
    pub metadata: BTreeMap<String, String>,
    pub crop: Option<Crop>,
    pub availability: String,
    pub source_key: Option<String>,
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
