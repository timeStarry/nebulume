use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, Cursor},
    path::Path,
};

use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use exif::{In, Tag};
use image::{
    codecs::jpeg::JpegEncoder, metadata::Orientation, DynamicImage, ImageDecoder, ImageReader, Rgb,
    RgbImage,
};
use serde_json::{json, Value};

use crate::Crop;

pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 120_000_000;

pub struct Inspection {
    pub width: u32,
    pub height: u32,
    pub metadata: BTreeMap<String, String>,
}

pub fn kind(extension: &str) -> Option<&'static str> {
    match extension {
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "tif" | "tiff" | "bmp" | "ico" | "ppm"
        | "pgm" | "pnm" | "heic" | "heif" | "avif" => Some("raster"),
        "dng" | "cr2" | "cr3" | "nef" | "nrw" | "arw" | "srf" | "sr2" | "raf" | "orf" | "rw2"
        | "rwl" | "pef" | "srw" | "raw" | "3fr" | "fff" | "iiq" | "kdc" | "dcr" | "mos" | "mef"
        | "erf" | "x3f" => Some("raw"),
        _ => None,
    }
}

fn check_file(path: &Path) -> Result<()> {
    let info = path
        .metadata()
        .with_context(|| format!("E_OFFLINE: Cannot read {}", path.display()))?;
    ensure!(info.is_file(), "E_INVALID: Image is not a regular file");
    ensure!(
        info.len() <= MAX_FILE_BYTES,
        "E_LIMIT: Image exceeds the 512 MiB decode limit"
    );
    Ok(())
}

fn check_dimensions(width: u32, height: u32) -> Result<()> {
    ensure!(
        width > 0 && height > 0 && u64::from(width) * u64::from(height) <= MAX_PIXELS,
        "E_LIMIT: Image dimensions exceed the 120 megapixel decode limit"
    );
    Ok(())
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub fn read_exif(path: &Path) -> BTreeMap<String, String> {
    let mut metadata = BTreeMap::new();
    let Ok(file) = File::open(path) else {
        return metadata;
    };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else {
        return metadata;
    };
    for (tag, label) in [
        (Tag::Make, "Make"),
        (Tag::Model, "Camera"),
        (Tag::LensModel, "Lens"),
        (Tag::ExposureTime, "Exposure"),
        (Tag::FNumber, "Aperture"),
        (Tag::PhotographicSensitivity, "ISO"),
        (Tag::FocalLength, "Focal Length"),
        (Tag::FocalLengthIn35mmFilm, "Focal Length (35 mm)"),
        (Tag::DateTimeOriginal, "Captured"),
        (Tag::OffsetTimeOriginal, "Capture Time Zone"),
        (Tag::Orientation, "Orientation"),
        (Tag::ExposureBiasValue, "Exposure Bias"),
        (Tag::ExposureProgram, "Exposure Program"),
        (Tag::MeteringMode, "Metering"),
        (Tag::Flash, "Flash"),
        (Tag::WhiteBalance, "White Balance"),
        (Tag::ColorSpace, "Color Space"),
        (Tag::Copyright, "Copyright"),
        (Tag::Artist, "Artist"),
        (Tag::Software, "Software"),
    ] {
        if let Some(field) = exif.get_field(tag, In::PRIMARY) {
            if let Some(value) = format_exif_field(field, &exif, 2048) {
                metadata.insert(label.to_owned(), value);
            }
        }
    }
    // Preserve discoverable EXIF fields alongside the common human-readable labels.
    // Do not flatten private MakerNote blobs into the catalog.
    for field in exif.fields().take(256) {
        if field.tag == Tag::MakerNote || field.tag == Tag::UserComment {
            continue;
        }
        let name = format!("EXIF {}", field.tag);
        if let Some(value) = format_exif_field(field, &exif, 512) {
            metadata.entry(name).or_insert(value);
        }
    }
    metadata
}

fn format_exif_field(field: &exif::Field, exif: &exif::Exif, limit: usize) -> Option<String> {
    let value = if let exif::Value::Ascii(values) = &field.value {
        values
            .iter()
            .filter_map(|bytes| {
                let decoded = String::from_utf8_lossy(bytes);
                let text = decoded.trim_matches(|c: char| c == '\0' || c.is_whitespace());
                (!text.is_empty()).then(|| text.to_owned())
            })
            .collect::<Vec<_>>()
            .join("; ")
    } else {
        field.display_value().with_unit(exif).to_string()
    };
    (!value.trim().is_empty()).then(|| value.chars().take(limit).collect())
}

pub fn inspect(path: &Path) -> Result<Inspection> {
    check_file(path)?;
    let mut metadata = read_exif(path);
    let extension = extension(path);
    metadata.insert("Format".into(), extension.to_ascii_uppercase());
    let (mut width, mut height, orientation) = if kind(&extension) == Some("raw") {
        let raw = match raw_header(path) {
            Ok(raw) => raw,
            Err(raw_error) => {
                let preview = crate::embedded_preview::read(path).with_context(|| {
                    format!("RAW metadata unavailable ({raw_error:#}); embedded preview fallback failed")
                })?;
                metadata.insert("Decoder".into(), "相机内嵌预览 · RAW 原始解码不可用".into());
                metadata.insert("Preview Source".into(), "embedded_jpeg".into());
                metadata.insert(
                    "Preview Dimensions".into(),
                    format!("{} × {}", preview.width(), preview.height()),
                );
                metadata.insert(
                    "Decode Status".into(),
                    format!("RAW 原始解码不可用：{raw_error:#}"),
                );
                return Ok(Inspection {
                    width: preview.width(),
                    height: preview.height(),
                    metadata,
                });
            }
        };
        metadata.insert(
            "Camera".into(),
            format!("{} {}", raw.clean_make, raw.clean_model)
                .trim()
                .to_owned(),
        );
        metadata.insert(
            "Sensor Dimensions".into(),
            format!("{} × {}", raw.width, raw.height),
        );
        metadata.insert("CFA".into(), raw.cfa.name.clone());
        metadata.insert(
            "Decoder".into(),
            "rawloader 0.37.2 · basic sensor rendering".into(),
        );
        let (width, height) = raw_dimensions(&raw)?;
        (
            width,
            height,
            Orientation::from_exif(raw.orientation.to_u16() as u8)
                .unwrap_or(Orientation::NoTransforms),
        )
    } else {
        let mut decoder = image_reader(path)?
            .into_decoder()
            .context("E_UNSUPPORTED_CODEC: Image header cannot be decoded")?;
        let dims = decoder.dimensions();
        let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
        metadata.insert(
            "Pixel Format".into(),
            format!("{:?}", decoder.original_color_type()),
        );
        (dims.0, dims.1, orientation)
    };
    check_dimensions(width, height)?;
    if matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    ) {
        std::mem::swap(&mut width, &mut height);
    }
    Ok(Inspection {
        width,
        height,
        metadata,
    })
}

fn image_reader(path: &Path) -> Result<ImageReader<BufReader<File>>> {
    let mut reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(65_536);
    limits.max_image_height = Some(65_536);
    limits.max_alloc = Some(MAX_PIXELS * 8);
    reader.limits(limits);
    Ok(reader)
}

// rawloader's metadata-only pass avoids allocating a full sensor plane while
// indexing, and supplies dimensions before the full decode's allocation.
fn raw_header(path: &Path) -> Result<rawloader::RawImage> {
    if extension(path) == "cr3" {
        bail!("E_UNSUPPORTED_CODEC: Canon CR3 decoding is not available in this build");
    }
    let mut file = File::open(path)?;
    let raw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        rawloader::decode_dummy(&mut file)
    }))
    .map_err(|_| anyhow!("E_UNSUPPORTED_CODEC: RAW metadata decoder rejected this file"))?
    .context(
        "E_UNSUPPORTED_CODEC: RAW camera or compression is unsupported or the file is damaged",
    )?;
    check_dimensions(u32::try_from(raw.width)?, u32::try_from(raw.height)?)?;
    raw_dimensions(&raw)?;
    Ok(raw)
}

fn raw_dimensions(raw: &rawloader::RawImage) -> Result<(u32, u32)> {
    let [top, right, bottom, left] = raw.crops;
    let width = raw
        .width
        .checked_sub(left)
        .and_then(|v| v.checked_sub(right))
        .filter(|v| *v > 0)
        .context("E_DECODE: Invalid RAW active area width")?;
    let height = raw
        .height
        .checked_sub(top)
        .and_then(|v| v.checked_sub(bottom))
        .filter(|v| *v > 0)
        .context("E_DECODE: Invalid RAW active area height")?;
    Ok((u32::try_from(width)?, u32::try_from(height)?))
}

pub fn render(
    path: &Path,
    crop: Option<Crop>,
    max_side: Option<u32>,
) -> Result<(DynamicImage, &'static str)> {
    let frame = render_frame(path, crop, max_side)?;
    Ok((frame.image, frame.source))
}

#[derive(serde::Serialize)]
struct CoordinateMapping {
    orientation: u8,
    full_width: u32,
    full_height: u32,
    crop: Crop,
}

struct RenderedFrame {
    image: DynamicImage,
    source: &'static str,
    coordinate_mapping: CoordinateMapping,
}

fn render_frame(path: &Path, crop: Option<Crop>, max_side: Option<u32>) -> Result<RenderedFrame> {
    check_file(path)?;
    let (mut image, source, orientation) = if kind(&extension(path)) == Some("raw") {
        // Keep enough full-frame pixels that a small saved crop can still fill
        // the requested preview. Exports pass None and render all sensor pixels.
        let raw_limit = max_side.map(|limit| {
            let fraction = crop.map(|crop| crop.width.min(crop.height)).unwrap_or(1.0);
            (f64::from(limit) / fraction.max(1e-9))
                .ceil()
                .min(f64::from(u32::MAX)) as u32
        });
        match render_sensor(path, raw_limit) {
            Ok((image, orientation)) => (image, "raw_demosaic", orientation),
            Err(raw_error) if max_side.is_some() => {
                let (preview, orientation) = crate::embedded_preview::read_with_orientation(path).with_context(|| {
                    format!("RAW sensor decoding unavailable ({raw_error:#}); embedded preview fallback failed")
                })?;
                (preview, "embedded_jpeg", orientation)
            }
            Err(error) => {
                return Err(error.context(
                    "RAW 原始解码不可用，不能导出原始分辨率 JPEG；相机内嵌预览仅用于查看。",
                ))
            }
        }
    } else {
        let mut decoder = image_reader(path)?
            .into_decoder()
            .context("E_UNSUPPORTED_CODEC: Image codec unavailable or invalid file")?;
        let (width, height) = decoder.dimensions();
        check_dimensions(width, height)?;
        let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
        let mut image =
            DynamicImage::from_decoder(decoder).context("E_DECODE: Image decoding failed")?;
        image.apply_orientation(orientation);
        (image, "raster", orientation.to_exif())
    };
    let mut coordinate_mapping = CoordinateMapping {
        orientation,
        full_width: image.width(),
        full_height: image.height(),
        crop: Crop {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        },
    };
    if let Some(crop) = crop {
        crop.validate()?;
        let (width, height) = (image.width(), image.height());
        let x = ((crop.x * f64::from(width)).floor() as u32).min(width - 1);
        let y = ((crop.y * f64::from(height)).floor() as u32).min(height - 1);
        let right = (((crop.x + crop.width) * f64::from(width)).ceil() as u32).clamp(x + 1, width);
        let bottom =
            (((crop.y + crop.height) * f64::from(height)).ceil() as u32).clamp(y + 1, height);
        coordinate_mapping.crop = Crop {
            x: f64::from(x) / f64::from(width),
            y: f64::from(y) / f64::from(height),
            width: f64::from(right - x) / f64::from(width),
            height: f64::from(bottom - y) / f64::from(height),
        };
        image = image.crop_imm(x, y, right - x, bottom - y);
    }
    Ok(RenderedFrame {
        image,
        source,
        coordinate_mapping,
    })
}

fn render_sensor(path: &Path, max_side: Option<u32>) -> Result<(DynamicImage, u8)> {
    raw_header(path)?;
    let raw = std::panic::catch_unwind(|| rawloader::decode_file(path))
        .map_err(|_| anyhow!("E_DECODE: RAW sensor decoder rejected this file"))?
        .context("E_UNSUPPORTED_CODEC: RAW decoding failed; this camera or compression may be unsupported")?;
    let orientation = Orientation::from_exif(raw.orientation.to_u16() as u8)
        .unwrap_or(Orientation::NoTransforms)
        .to_exif();
    Ok((develop_raw(&raw, max_side)?, orientation))
}

/// Deliberately simple, deterministic RAW development: channel-specific black /
/// white correction, camera white balance, bilinear neighborhood demosaic, camera
/// matrix to linear sRGB and the sRGB transfer curve. No embedded JPEG is used.
fn develop_raw(raw: &rawloader::RawImage, max_side: Option<u32>) -> Result<DynamicImage> {
    let (full_width, full_height) = raw_dimensions(raw)?;
    check_dimensions(full_width, full_height)?;
    let scale = max_side
        .map(|limit| (f64::from(limit) / f64::from(full_width.max(full_height))).min(1.0))
        .unwrap_or(1.0);
    let width = (f64::from(full_width) * scale).round().max(1.0) as u32;
    let height = (f64::from(full_height) * scale).round().max(1.0) as u32;
    ensure!(
        matches!(raw.cpp, 1 | 3),
        "E_UNSUPPORTED_CODEC: RAW sensor component layout is unsupported"
    );
    ensure!(
        raw.cpp == 3 || raw.is_monochrome() || (raw.cfa.width > 0 && raw.cfa.height > 0),
        "E_UNSUPPORTED_CODEC: RAW color filter pattern is unavailable"
    );
    let sample_count = raw
        .width
        .checked_mul(raw.height)
        .and_then(|n| n.checked_mul(raw.cpp))
        .context("E_LIMIT: RAW dimensions overflow")?;
    let data_len = match &raw.data {
        rawloader::RawImageData::Integer(v) => v.len(),
        rawloader::RawImageData::Float(v) => v.len(),
    };
    ensure!(
        data_len >= sample_count,
        "E_DECODE: RAW sensor data is truncated"
    );
    let mut wb = raw.wb_coeffs;
    if wb[..3].iter().any(|v| !v.is_finite() || *v <= 0.0) {
        wb = raw.neutralwb();
    }
    if wb[..3].iter().any(|v| !v.is_finite() || *v <= 0.0) {
        wb = [1.0; 4];
    }
    let green = wb[1];
    for coeff in &mut wb {
        *coeff = if coeff.is_finite() && *coeff > 0.0 {
            *coeff / green
        } else {
            1.0
        };
    }
    let cam_xyz = raw.cam_to_xyz_normalized();
    let xyz_srgb: [[f32; 3]; 3] = [
        [3.2404542, -1.5371385, -0.4985314],
        [-0.969266, 1.8760108, 0.041556],
        [0.0556434, -0.2040259, 1.0572252],
    ];
    let mut camera_srgb = [[0.0_f32; 4]; 3];
    for row in 0..3 {
        for col in 0..4 {
            for xyz in 0..3 {
                camera_srgb[row][col] += xyz_srgb[row][xyz] * cam_xyz[xyz][col];
            }
        }
    }
    let valid_matrix = camera_srgb.iter().flatten().all(|v| v.is_finite());
    let sample = |row: usize, col: usize, channel: usize| -> f32 {
        let index =
            (row * raw.width + col) * raw.cpp + if raw.cpp == 3 { channel.min(2) } else { 0 };
        let value = match &raw.data {
            rawloader::RawImageData::Integer(v) => f32::from(v[index]),
            rawloader::RawImageData::Float(v) => v[index],
        };
        let black = f32::from(raw.blacklevels[channel]);
        let range = f32::from(raw.whitelevels[channel]).max(black + 1.0) - black;
        ((value - black) / range).max(0.0) * wb[channel]
    };
    let monochrome = raw.is_monochrome();
    let radius = if raw.cfa.width > 2 || raw.cfa.height > 2 {
        3
    } else {
        1
    };
    let [top, _, _, left] = raw.crops;
    let mut output = RgbImage::new(width, height);
    for (x, y, pixel) in output.enumerate_pixels_mut() {
        // Demosaic only requested preview sample locations. A thumbnail of a
        // 100 MP RAW must not allocate or process a second full RGB frame.
        let row = ((u64::from(y) * u64::from(full_height)) / u64::from(height)) as usize + top;
        let col = ((u64::from(x) * u64::from(full_width)) / u64::from(width)) as usize + left;
        let camera = if raw.cpp == 3 {
            [
                sample(row, col, 0),
                sample(row, col, 1),
                sample(row, col, 2),
                0.0,
            ]
        } else if monochrome {
            [sample(row, col, 0); 4]
        } else {
            let mut sum = [0.0_f32; 4];
            let mut count = [0.0_f32; 4];
            for sy in row.saturating_sub(radius)..=(row + radius).min(raw.height - 1) {
                for sx in col.saturating_sub(radius)..=(col + radius).min(raw.width - 1) {
                    let channel = raw.cfa.color_at(sy, sx);
                    ensure!(
                        channel < 4,
                        "E_UNSUPPORTED_CODEC: RAW color plane is unsupported"
                    );
                    sum[channel] += sample(sy, sx, channel);
                    count[channel] += 1.0;
                }
            }
            for channel in 0..4 {
                if count[channel] > 0.0 {
                    sum[channel] /= count[channel];
                }
            }
            let own = raw.cfa.color_at(row, col);
            sum[own] = sample(row, col, own);
            sum
        };
        let mut rgb = [0_u8; 3];
        for channel in 0..3 {
            let linear = if monochrome {
                camera[0]
            } else if valid_matrix {
                (0..4)
                    .map(|c| camera_srgb[channel][c] * camera[c])
                    .sum::<f32>()
            } else {
                camera[channel]
            };
            let linear = linear.clamp(0.0, 1.0);
            let encoded = if linear <= 0.0031308 {
                12.92 * linear
            } else {
                1.055 * linear.powf(1.0 / 2.4) - 0.055
            };
            rgb[channel] = (encoded * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        *pixel = Rgb(rgb);
    }
    let mut image = DynamicImage::ImageRgb8(output);
    image.apply_orientation(
        Orientation::from_exif(raw.orientation.to_u16() as u8).unwrap_or(Orientation::NoTransforms),
    );
    Ok(image)
}

pub fn preview(path: &Path, crop: Option<Crop>, max_size: u32) -> Result<Value> {
    ensure!(
        (32..=4096).contains(&max_size),
        "E_INVALID: Preview max_size must be between 32 and 4096"
    );
    let frame = render_frame(path, crop, Some(max_size))?;
    let image = downsample(frame.image, max_size);
    let mut bytes = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut bytes, 88).encode_image(&image.to_rgb8())?;
    Ok(
        json!({"data_url": format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes.into_inner())), "width": image.width(), "height": image.height(), "source": frame.source, "coordinate_mapping": frame.coordinate_mapping}),
    )
}

pub fn histogram(path: &Path, crop: Option<Crop>) -> Result<Value> {
    let (image, source) = render(path, crop, Some(2048))?;
    let image = downsample(image, 2048).to_rgb8();
    let mut red = vec![0_u64; 256];
    let mut green = vec![0_u64; 256];
    let mut blue = vec![0_u64; 256];
    let mut luminance = vec![0_u64; 256];
    for pixel in image.pixels() {
        let [r, g, b] = pixel.0;
        red[r as usize] += 1;
        green[g as usize] += 1;
        blue[b as usize] += 1;
        let luma = (0.2126 * f64::from(r) + 0.7152 * f64::from(g) + 0.0722 * f64::from(b)).round()
            as usize;
        luminance[luma.min(255)] += 1;
    }
    Ok(
        json!({"red": red, "green": green, "blue": blue, "luminance": luminance,
        "pixels": u64::from(image.width()) * u64::from(image.height()), "source": source}),
    )
}

fn downsample(image: DynamicImage, max_side: u32) -> DynamicImage {
    if image.width() > max_side || image.height() > max_side {
        image.thumbnail(max_side, max_side)
    } else {
        image
    }
}

pub fn export(path: &Path, crop: Option<Crop>, destination: &Path) -> Result<Value> {
    ensure!(
        matches!(extension(destination).as_str(), "jpg" | "jpeg"),
        "E_INVALID: Export destination must end in .jpg or .jpeg"
    );
    ensure!(!destination.exists(), "E_EXISTS: Export destination already exists; originals and previous exports are never overwritten");
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure!(
        parent.is_dir(),
        "E_NOT_FOUND: Export destination folder does not exist"
    );
    let (image, _) = render(path, crop, None)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    JpegEncoder::new_with_quality(temp.as_file_mut(), 95).encode_image(&image.to_rgb8())?;
    temp.as_file().sync_all()?;
    // This atomic no-clobber commit also closes the check-then-write race above.
    temp.persist_noclobber(destination).map_err(|e| {
        anyhow!(
            "E_EXISTS_OR_IO: Cannot commit export without replacing an existing file: {}",
            e.error
        )
    })?;
    Ok(json!({"path": dunce::canonicalize(destination)?.to_string_lossy()}))
}

#[cfg(test)]
mod coordinate_tests {
    use super::*;

    #[test]
    fn preview_reports_actual_crop_rounding_and_full_frame_before_downsample() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("grid.png");
        RgbImage::from_pixel(70, 50, Rgb([30, 90, 120]))
            .save(&path)
            .unwrap();
        let crop = Crop {
            x: 0.13,
            y: 0.22,
            width: 0.32,
            height: 0.5,
        };
        let cropped = preview(&path, Some(crop), 32).unwrap();
        let mapping = &cropped["coordinate_mapping"];
        assert_eq!(mapping["orientation"], 1);
        assert_eq!(mapping["full_width"], 70);
        assert_eq!(mapping["full_height"], 50);
        assert_eq!(mapping["crop"]["x"], 9.0 / 70.0);
        assert_eq!(mapping["crop"]["y"], 11.0 / 50.0);
        assert_eq!(mapping["crop"]["width"], 23.0 / 70.0);
        assert_eq!(mapping["crop"]["height"], 25.0 / 50.0);
        let uncropped = preview(&path, None, 32).unwrap();
        assert_eq!(uncropped["coordinate_mapping"]["full_width"], 70);
        assert_eq!(uncropped["coordinate_mapping"]["crop"]["width"], 1.0);
        assert_eq!(uncropped["width"], 32);
    }
}
