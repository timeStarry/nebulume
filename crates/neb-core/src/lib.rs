//! Headless photo catalog and rendering service shared by the desktop and CLI.
//!
//! Originals are read-only. Editing stores normalized recipes in SQLite; only
//! explicit exports create a new file. A catalog remains usable offline.

mod catalog;
mod embedded_preview;
mod focus_points;
mod imaging;
mod model;

pub use catalog::Core;
pub use focus_points::{FocusInfo, FocusRegion};
pub use model::{Asset, Crop, Library};

pub fn image_kind(extension: &str) -> Option<&'static str> {
    imaging::kind(extension)
}

pub fn capabilities() -> serde_json::Value {
    serde_json::json!({
        "catalog": "sqlite_fts5",
        "raster": ["jpeg", "png", "webp", "gif_first_frame", "tiff", "bmp", "ico", "pnm"],
        "raw": {
            "engine": "rawloader 0.37.2",
            "mode": "sensor_decode_basic_demosaic",
            "preview_fallback": "bounded_standard_tiff_embedded_jpeg; viewing and rendered RGB histograms only",
            "formats": ["dng", "cr2", "nef", "arw", "raf", "orf", "rw2", "pef", "srw", "raw"],
            "limitations": "Camera-dependent; CR3, HEIC/HEIF and AVIF are not decoded. Basic RAW rendering is not a color-managed professional development pipeline. Unsupported TIFF RAW files may display a clearly labeled embedded camera JPEG; this is not sensor decoding and never substitutes for RAW export. MakerNotes, BigTIFF and arbitrary JPEG scans are not supported by the fallback."
        },
        "histogram": "256-bin RGB and Rec.709 luma over the rendered crop, sampled at max 2048 pixels per side",
        "focus_points": {
            "source": "Nikon Type 3 MakerNote AFInfo2",
            "versions": ["0300", "0301"],
            "mode": "explicit recorded area coordinates, normalized to oriented full image",
            "limitations": "JPEG/classic TIFF only; selected area does not confirm achieved focus. Other vendors/versions and point-grid-only records are unsupported. No inferred positions or private MakerNote fields are returned."
        },
        "editing": ["normalized_non_destructive_crop", "reset_crop", "jpeg_export_no_overwrite"],
        "color_management": "unmanaged raster / basic camera-matrix RAW to sRGB",
        "max_file_bytes": imaging::MAX_FILE_BYTES,
        "max_pixels": imaging::MAX_PIXELS
    })
}
