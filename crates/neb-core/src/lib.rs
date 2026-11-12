//! Headless photo catalog and rendering service shared by the desktop and CLI.
//!
//! Originals are read-only. Editing stores normalized recipes in SQLite; only
//! explicit exports create a new file. A catalog remains usable offline.

pub mod cache;
pub mod capture_time;
mod catalog;
mod cr3;
mod embedded_preview;
mod focus_points;
mod icc;
mod imaging;
mod ingest_records;
#[cfg(target_os = "macos")]
mod macos_imageio;
mod model;
pub mod preview;
pub mod recycle;
mod remote_exif;
pub mod xmp;

pub use cache::{CacheLease, CacheManager, Reservation};
pub use catalog::Core;
pub use focus_points::read_from as remote_focus;
pub use focus_points::{FocusInfo, FocusRegion};
pub use imaging::{histogram_from_jpeg, remote_preview, ExportColorSpace, ExportOptions};
pub use ingest_records::{Card, CardIdentity, ImportBatch, ImportPreset};
pub use model::{Asset, Crop, Library, Location};
pub use preview::{PreviewImage, PreviewMemory, PreviewTier};

pub fn image_kind(extension: &str) -> Option<&'static str> {
    imaging::kind(extension)
}

pub fn capabilities() -> serde_json::Value {
    let raster = if cfg!(target_os = "macos") {
        vec![
            "jpeg",
            "png",
            "webp",
            "gif_first_frame",
            "tiff",
            "bmp",
            "ico",
            "pnm",
            "heic",
            "heif",
            "avif",
        ]
    } else {
        vec![
            "jpeg",
            "png",
            "webp",
            "gif_first_frame",
            "tiff",
            "bmp",
            "ico",
            "pnm",
        ]
    };
    serde_json::json!({
        "catalog": "sqlite_fts5",
        "raster": raster,
        "raw": {
            "engine": "rawloader 0.37.2 + bounded CR3/TIFF embedded preview",
            "mode": "embedded_camera_jpeg_default_with_optional_sensor_demosaic",
            "preview_fallback": "bounded_standard_tiff_and_cr3_embedded_jpeg; viewing and rendered RGB histograms only",
            "formats": ["dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef", "srw", "raw"],
            "limitations": "CR3 uses bounded ISO-BMFF EXIF (CMT1/CMT2) and camera-embedded JPEG previews on all platforms; raw sensor demosaicing and full-sensor RAW export are unavailable for CR3. HEIC/HEIF and AVIF decode natively via ImageIO on macOS only. Basic RAW sensor rendering is not a full developing suite."
        },
        "preview_tiers": ["t256", "t512", "t1024", "p2560", "full"],
        "histogram": "256-bin RGB and Rec.709 luma over the rendered crop, sampled at max 2048 pixels per side",
        "focus_points": {
            "source": "Nikon Type 3 MakerNote AFInfo2",
            "versions": ["0300", "0301"],
            "mode": "explicit recorded area coordinates, normalized to oriented full image",
            "limitations": "JPEG/classic TIFF only; selected area does not confirm achieved focus. Other vendors/versions and point-grid-only records are unsupported. No inferred positions or private MakerNote fields are returned."
        },
        "editing": ["normalized_non_destructive_crop", "reset_crop", "jpeg_export_no_overwrite", "xmp_sidecar_sync"],
        "export": {
            "formats": ["jpeg"],
            "color_spaces": ["preserve", "srgb", "display_p3", "adobe_rgb"],
            "quality_range": [30, 100],
            "max_edge_range": [256, 16384]
        },
        "color_management": "ICC profile passthrough + EXIF Adobe RGB (1998) ICC synthesis + linear-light sRGB / Display P3 / Adobe RGB export conversion",
        "max_file_bytes": imaging::MAX_FILE_BYTES,
        "max_pixels": imaging::MAX_PIXELS
    })
}

/// Whether a file extension (any case, without the dot) is one Nebulume indexes.
pub fn is_image_extension(extension: &str) -> bool {
    imaging::kind(&extension.to_ascii_lowercase()).is_some()
}
