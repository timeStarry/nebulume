//! Headless photo catalog and rendering service shared by the desktop and CLI.
//!
//! Originals are read-only. Editing stores normalized recipes in SQLite; only
//! explicit exports create a new file. A catalog remains usable offline.

mod catalog;
mod imaging;
mod model;

pub use catalog::Core;
pub use model::{Asset, Crop, Library};

pub fn capabilities() -> serde_json::Value {
    serde_json::json!({
        "catalog": "sqlite_fts5",
        "raster": ["jpeg", "png", "webp", "gif_first_frame", "tiff", "bmp", "ico", "pnm"],
        "raw": {
            "engine": "rawloader 0.37.2",
            "mode": "sensor_decode_basic_demosaic",
            "formats": ["dng", "cr2", "nef", "arw", "raf", "orf", "rw2", "pef", "srw", "raw"],
            "limitations": "Camera-dependent; CR3, HEIC/HEIF and AVIF are not decoded. Basic RAW rendering is not a color-managed professional development pipeline. No embedded preview substitution."
        },
        "histogram": "256-bin RGB and Rec.709 luma over the rendered crop, sampled at max 2048 pixels per side",
        "editing": ["normalized_non_destructive_crop", "reset_crop", "jpeg_export_no_overwrite"],
        "color_management": "unmanaged raster / basic camera-matrix RAW to sRGB",
        "max_file_bytes": imaging::MAX_FILE_BYTES,
        "max_pixels": imaging::MAX_PIXELS
    })
}
