//! Bounded HTTP Range preview extraction for camera JPEGs:
//! - Primary frame dimensions from `SOF0..=SOF2`
//! - EXIF metadata, orientation, Adobe RGB flag, and IFD1 thumbnail from `APP1 Exif\0\0`
//! - Multi-chunk ICC color profile from `APP2 ICC_PROFILE\0`
//! - CIPA DC-007 Multi-Picture Format (`APP2 MPF\0`, tag `0xB002`) HD preview at file tail
//!
//! If no embedded preview meets the resolution floor for the requested tier, returns
//! `E_UNSUPPORTED_CODEC` so the caller cleanly falls back to streamed or cached full decode.

use std::{
    collections::BTreeMap,
    io::{Cursor, Read, Seek, SeekFrom},
};

use anyhow::{bail, ensure, Context, Result};
use exif::{In, Tag};
use image::{metadata::Orientation, DynamicImage, ImageDecoder, ImageFormat, ImageReader};

use crate::PreviewTier;

const MAX_HEADER_SCAN_BYTES: u64 = 256 * 1024;
const MAX_MPF_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MPF_TOTAL_READ_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MPF_ENTRIES: usize = 16;

pub(crate) struct JpegRangePreview {
    pub image: DynamicImage,
    pub orientation: u8,
    pub icc: Option<Vec<u8>>,
    pub full_width: u32,
    pub full_height: u32,
    pub parsed_exif: Option<exif::Exif>,
    pub embedded_long_side: u32,
}

#[derive(Clone, Copy, Debug)]
struct MpfCandidate {
    offset: u64,
    length: u64,
}

/// Minimum embedded preview long-side pixels required to serve `tier` without blur.
pub(crate) fn min_long_side_for_tier(tier: PreviewTier, primary_long: u32) -> u32 {
    let cap = if primary_long > 0 {
        primary_long
    } else {
        u32::MAX
    };
    match tier {
        PreviewTier::T256 => 200.min(cap),
        PreviewTier::T512 => 480.min(cap),
        PreviewTier::T1024 => 960.min(cap),
        PreviewTier::P2560 => 1440.min(cap),
        PreviewTier::Full => cap,
    }
}

pub(crate) fn read_jpeg_range_preview<R: Read + Seek>(
    input: &mut R,
    length: u64,
    tier: PreviewTier,
) -> Result<JpegRangePreview> {
    ensure!(
        length >= 4 && length <= crate::imaging::MAX_FILE_BYTES,
        "E_UNSUPPORTED_CODEC: Invalid or oversized remote JPEG"
    );
    let head_len = length.min(MAX_HEADER_SCAN_BYTES) as usize;
    let mut head = vec![0_u8; head_len];
    input.seek(SeekFrom::Start(0))?;
    input
        .read_exact(&mut head)
        .context("E_DECODE: Truncated remote JPEG header")?;
    ensure!(
        head.starts_with(&[0xFF, 0xD8]),
        "E_UNSUPPORTED_CODEC: Remote file is not a standard JPEG"
    );

    let mut pos = 2_usize;
    let mut sof_dims: Option<(u32, u32)> = None;
    let mut exif_tiff: Option<Vec<u8>> = None;
    let mut icc_chunks: BTreeMap<u8, Vec<u8>> = BTreeMap::new();
    let mut icc_expected_chunks: Option<u8> = None;
    let mut mpf_candidates: Vec<MpfCandidate> = Vec::new();

    while pos + 1 < head.len() {
        if head[pos] != 0xFF {
            pos += 1;
            continue;
        }
        while pos < head.len() && head[pos] == 0xFF {
            pos += 1;
        }
        if pos >= head.len() {
            break;
        }
        let marker = head[pos];
        pos += 1;
        if marker == 0x00 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            // EOI or SOS (start of compressed primary scan): all metadata markers precede SOS.
            break;
        }
        if pos + 2 > head.len() {
            break;
        }
        let seg_len = usize::from(u16::from_be_bytes([head[pos], head[pos + 1]]));
        if seg_len < 2 {
            break;
        }
        let payload_start = pos + 2;
        let payload_len = seg_len - 2;
        let Some(payload_end) = payload_start.checked_add(payload_len) else {
            break;
        };
        if payload_end <= head.len() {
            let payload = &head[payload_start..payload_end];
            match marker {
                0xC0..=0xC2 if payload.len() >= 5 && sof_dims.is_none() => {
                    let h = u32::from(u16::from_be_bytes([payload[1], payload[2]]));
                    let w = u32::from(u16::from_be_bytes([payload[3], payload[4]]));
                    if w > 0 && h > 0 {
                        sof_dims = Some((w, h));
                    }
                }
                0xE1 if exif_tiff.is_none() && payload.starts_with(b"Exif\0\0") => {
                    exif_tiff = Some(payload[6..].to_vec());
                }
                0xE2 if payload.len() > 14 && payload.starts_with(b"ICC_PROFILE\0") => {
                    let seq = payload[12];
                    let total = payload[13];
                    if seq >= 1 && total >= 1 && seq <= total {
                        icc_expected_chunks = Some(total);
                        icc_chunks.insert(seq, payload[14..].to_vec());
                    }
                }
                0xE2 if payload.len() > 12 && payload.starts_with(b"MPF\0") => {
                    let mpf_tiff_base = (payload_start + 4) as u64;
                    if let Ok(found) = parse_mpf_directory(&payload[4..], mpf_tiff_base, length) {
                        mpf_candidates.extend(found);
                    }
                }
                _ => {}
            }
        }
        pos = payload_end;
    }

    let parsed_exif = exif_tiff.as_ref().and_then(|tiff| {
        exif::Reader::new()
            .continue_on_error(true)
            .read_raw(tiff.clone())
            .or_else(|e| e.distill_partial_result(|_| {}))
            .ok()
    });

    let primary_orientation = parsed_exif
        .as_ref()
        .and_then(|exif| {
            exif.get_field(Tag::Orientation, In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
        })
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(1) as u8;

    let primary_icc = icc_expected_chunks.and_then(|total| {
        if icc_chunks.len() == usize::from(total) {
            let mut full = Vec::new();
            for seq in 1..=total {
                full.extend_from_slice(icc_chunks.get(&seq)?);
            }
            (!full.is_empty()).then_some(full)
        } else {
            None
        }
    });
    let adobe_rgb = parsed_exif
        .as_ref()
        .is_some_and(crate::icc::is_adobe_rgb_exif);

    let (raw_w, raw_h) = sof_dims.unwrap_or((0, 0));
    let primary_long = raw_w.max(raw_h);
    let min_needed = min_long_side_for_tier(tier, primary_long);

    // 1. Try CIPA MPF embedded previews (largest byte size first, bounded total read).
    mpf_candidates.sort_by_key(|c| std::cmp::Reverse(c.length));
    let mut read_budget = 0_u64;
    let mut best_decoded: Option<(DynamicImage, u8, Option<Vec<u8>>, u32)> = None;

    for cand in mpf_candidates.into_iter().take(MAX_MPF_ENTRIES) {
        if read_budget.saturating_add(cand.length) > MAX_MPF_TOTAL_READ_BYTES {
            break;
        }
        read_budget += cand.length;
        let mut buf = vec![0_u8; usize::try_from(cand.length)?];
        input.seek(SeekFrom::Start(cand.offset))?;
        input
            .read_exact(&mut buf)
            .context("E_DECODE: Truncated MPF preview stream")?;
        if let Some((img, orient, icc, long_side)) =
            decode_embedded_jpeg(&buf, primary_orientation, &primary_icc, adobe_rgb)
        {
            if long_side >= min_needed {
                best_decoded = Some((img, orient, icc, long_side));
                break;
            }
            if best_decoded
                .as_ref()
                .is_none_or(|(_, _, _, prev_long)| long_side > *prev_long)
            {
                best_decoded = Some((img, orient, icc, long_side));
            }
        }
    }

    // 2. If MPF did not satisfy `min_needed`, check APP1 EXIF IFD1 thumbnail already in memory.
    if best_decoded
        .as_ref()
        .is_none_or(|(_, _, _, long_side)| *long_side < min_needed)
    {
        if let Some(tiff) = &exif_tiff {
            if let Ok(emb) = crate::embedded_preview::read_embedded_from(
                Cursor::new(tiff.as_slice()),
                tiff.len() as u64,
            ) {
                let long_side = emb.image.width().max(emb.image.height());
                if long_side >= min_needed {
                    let icc = emb
                        .icc
                        .or_else(|| primary_icc.clone())
                        .or_else(|| adobe_rgb.then(crate::icc::adobe_rgb_1998_icc));
                    best_decoded = Some((emb.image, emb.orientation, icc, long_side));
                }
            }
        }
    }

    let Some((image, orientation, icc, embedded_long_side)) = best_decoded else {
        bail!("E_UNSUPPORTED_CODEC: Remote JPEG has no embedded preview");
    };
    ensure!(
        embedded_long_side >= min_needed,
        "E_UNSUPPORTED_CODEC: Embedded JPEG preview ({embedded_long_side}px) is smaller than tier requirement ({min_needed}px)"
    );

    let (mut full_width, mut full_height) = if raw_w > 0 && raw_h > 0 {
        (raw_w, raw_h)
    } else {
        (image.width(), image.height())
    };
    if raw_w > 0
        && raw_h > 0
        && matches!(
            Orientation::from_exif(orientation).unwrap_or(Orientation::NoTransforms),
            Orientation::Rotate90
                | Orientation::Rotate270
                | Orientation::Rotate90FlipH
                | Orientation::Rotate270FlipH
        )
    {
        std::mem::swap(&mut full_width, &mut full_height);
    }

    Ok(JpegRangePreview {
        image,
        orientation,
        icc,
        full_width,
        full_height,
        parsed_exif,
        embedded_long_side,
    })
}

fn decode_embedded_jpeg(
    bytes: &[u8],
    fallback_orientation: u8,
    primary_icc: &Option<Vec<u8>>,
    primary_adobe_rgb: bool,
) -> Option<(DynamicImage, u8, Option<Vec<u8>>, u32)> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Jpeg);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(65_536);
    limits.max_image_height = Some(65_536);
    limits.max_alloc = Some(crate::imaging::MAX_PIXELS * 4);
    reader.limits(limits);

    let mut decoder = reader.into_decoder().ok()?;
    let (w, h) = decoder.dimensions();
    let pixels = u64::from(w) * u64::from(h);
    if w == 0 || h == 0 || pixels > crate::imaging::MAX_PIXELS {
        return None;
    }
    let emb_icc = decoder.icc_profile().ok().flatten();
    let raw_exif = decoder.exif_metadata().ok().flatten();
    let emb_exif = raw_exif.as_deref().and_then(|data| {
        let tiff = data.strip_prefix(b"Exif\0\0").unwrap_or(data);
        exif::Reader::new()
            .continue_on_error(true)
            .read_raw(tiff.to_vec())
            .or_else(|e| e.distill_partial_result(|_| {}))
            .ok()
    });
    let emb_orientation = emb_exif
        .as_ref()
        .and_then(|exif| {
            exif.get_field(Tag::Orientation, In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
        })
        .filter(|v| (1..=8).contains(v))
        .map(|v| v as u8);
    let emb_adobe_rgb = emb_exif.as_ref().is_some_and(crate::icc::is_adobe_rgb_exif);

    let orientation = emb_orientation.unwrap_or(fallback_orientation);
    let mut image = DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(
        Orientation::from_exif(orientation).unwrap_or(Orientation::NoTransforms),
    );
    let long_side = image.width().max(image.height());
    let icc = emb_icc
        .or_else(|| primary_icc.clone())
        .or_else(|| (emb_adobe_rgb || primary_adobe_rgb).then(crate::icc::adobe_rgb_1998_icc));
    Some((image, orientation, icc, long_side))
}

fn parse_mpf_directory(
    mpf_tiff: &[u8],
    mpf_tiff_base: u64,
    file_length: u64,
) -> Result<Vec<MpfCandidate>> {
    ensure!(mpf_tiff.len() >= 8, "Invalid MPF header");
    let little = match &mpf_tiff[..4] {
        b"II\x2a\x00" => true,
        b"MM\x00\x2a" => false,
        _ => bail!("Invalid MPF endianness"),
    };
    let read_u16 = |slice: &[u8]| -> u16 {
        if little {
            u16::from_le_bytes([slice[0], slice[1]])
        } else {
            u16::from_be_bytes([slice[0], slice[1]])
        }
    };
    let read_u32 = |slice: &[u8]| -> u32 {
        if little {
            u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]])
        } else {
            u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]])
        }
    };

    let ifd_offset = read_u32(&mpf_tiff[4..8]) as usize;
    ensure!(
        ifd_offset >= 8 && ifd_offset + 2 <= mpf_tiff.len(),
        "MPF IFD outside segment"
    );
    let entry_count = usize::from(read_u16(&mpf_tiff[ifd_offset..ifd_offset + 2]));
    ensure!(entry_count <= 64, "Too many MPF IFD entries");
    let entries_end = ifd_offset
        .checked_add(2 + entry_count * 12)
        .filter(|end| *end <= mpf_tiff.len())
        .context("MPF IFD truncated")?;

    let mut out = Vec::new();
    for idx in 0..entry_count {
        let start = ifd_offset + 2 + idx * 12;
        let entry = &mpf_tiff[start..start + 12];
        let tag = read_u16(&entry[0..2]);
        if tag != 0xB002 {
            continue;
        }
        let byte_count = read_u32(&entry[4..8]) as usize;
        if byte_count < 32 || byte_count % 16 != 0 || byte_count > MAX_MPF_ENTRIES * 16 {
            continue;
        }
        let value_offset = read_u32(&entry[8..12]) as usize;
        let Some(value_end) = value_offset.checked_add(byte_count) else {
            continue;
        };
        if value_end > mpf_tiff.len() {
            continue;
        }
        let mp_entries = &mpf_tiff[value_offset..value_end];
        // Skip entry 0 (the primary full-resolution JPEG itself).
        for chunk in mp_entries.chunks_exact(16).skip(1) {
            let attr = read_u32(&chunk[0..4]);
            let format = (attr >> 24) & 0x07;
            if format != 0 {
                continue;
            }
            let img_size = u64::from(read_u32(&chunk[4..8]));
            let rel_offset = u64::from(read_u32(&chunk[8..12]));
            if rel_offset == 0 || img_size == 0 || img_size > MAX_MPF_PREVIEW_BYTES {
                continue;
            }
            let Some(abs_offset) = mpf_tiff_base.checked_add(rel_offset) else {
                continue;
            };
            if abs_offset
                .checked_add(img_size)
                .is_some_and(|end| end <= file_length)
            {
                out.push(MpfCandidate {
                    offset: abs_offset,
                    length: img_size,
                });
            }
        }
    }
    let _ = entries_end;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};

    fn encode_jpeg(w: u32, h: u32, color: [u8; 3]) -> Vec<u8> {
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 85)
            .encode_image(&RgbImage::from_pixel(w, h, Rgb(color)))
            .unwrap();
        out
    }

    fn inject_segment_after_soi(mut base_jpeg: Vec<u8>, marker: u8, payload: &[u8]) -> Vec<u8> {
        let len = (payload.len() + 2) as u16;
        let mut seg = Vec::with_capacity(4 + payload.len());
        seg.extend_from_slice(&[0xFF, marker]);
        seg.extend_from_slice(&len.to_be_bytes());
        seg.extend_from_slice(payload);
        base_jpeg.splice(2..2, seg);
        base_jpeg
    }

    fn build_camera_mpf_jpeg(
        primary_w: u32,
        primary_h: u32,
        mpf_preview: &[u8],
        padding_middle: usize,
    ) -> Vec<u8> {
        let primary = encode_jpeg(primary_w, primary_h, [40, 80, 160]);
        // Build MPF APP2 payload: "MPF\0" + little-endian TIFF header + 1 IFD entry (0xB002) + 2 MP entries (32 bytes)
        // Layout inside MPF TIFF (starting at offset 0 = 'I','I'):
        // 0..8: II 2a 00 08 00 00 00
        // 8..10: count = 1
        // 10..22: tag=0xB002, type=7, count=32, value_offset=26
        // 22..26: next_ifd = 0
        // 26..42: MP Entry 0 (primary)
        // 42..58: MP Entry 1 (preview at tail)
        let mpf_tiff_len = 58_usize;
        let app2_payload_len = 4 + mpf_tiff_len;
        let app2_total_seg_len = 4 + app2_payload_len;
        // mpf_tiff_base in final file: SOI(2) + marker(2) + seg_len(2) + "MPF\0"(4) = 10
        let mpf_tiff_base = 10_u32;
        let tail_offset = (primary.len() + app2_total_seg_len + padding_middle) as u32;
        let rel_offset = tail_offset - mpf_tiff_base;

        let mut mpf = Vec::with_capacity(app2_payload_len);
        mpf.extend_from_slice(b"MPF\0");
        mpf.extend_from_slice(b"II\x2a\x00\x08\x00\x00\x00");
        mpf.extend_from_slice(&1_u16.to_le_bytes());
        mpf.extend_from_slice(&0xB002_u16.to_le_bytes());
        mpf.extend_from_slice(&7_u16.to_le_bytes());
        mpf.extend_from_slice(&32_u32.to_le_bytes());
        mpf.extend_from_slice(&26_u32.to_le_bytes());
        mpf.extend_from_slice(&0_u32.to_le_bytes());
        // Entry 0: primary
        mpf.extend_from_slice(&0x030000_u32.to_le_bytes());
        mpf.extend_from_slice(&(primary.len() as u32).to_le_bytes());
        mpf.extend_from_slice(&0_u32.to_le_bytes());
        mpf.extend_from_slice(&0_u32.to_le_bytes());
        // Entry 1: dependent preview JPEG
        mpf.extend_from_slice(&0x010002_u32.to_le_bytes());
        mpf.extend_from_slice(&(mpf_preview.len() as u32).to_le_bytes());
        mpf.extend_from_slice(&rel_offset.to_le_bytes());
        mpf.extend_from_slice(&0_u32.to_le_bytes());

        let mut file = inject_segment_after_soi(primary, 0xE2, &mpf);
        file.resize(file.len() + padding_middle, 0x00);
        assert_eq!(file.len() as u32, tail_offset);
        file.extend_from_slice(mpf_preview);
        file
    }

    #[test]
    fn reads_tail_mpf_preview_without_touching_middle_megabytes() {
        let preview_jpg = encode_jpeg(1620, 1080, [210, 90, 40]);
        let file = build_camera_mpf_jpeg(60, 40, &preview_jpg, 12 * 1024 * 1024);
        let len = file.len() as u64;
        let mut cursor = Cursor::new(file);

        // Both T512 and P2560 succeed from the 1620x1080 MPF preview!
        let p2560 = read_jpeg_range_preview(&mut cursor, len, PreviewTier::P2560).unwrap();
        assert_eq!((p2560.image.width(), p2560.image.height()), (1620, 1080));
        assert_eq!((p2560.full_width, p2560.full_height), (60, 40));
    }

    #[test]
    fn tiny_embedded_preview_falls_back_cleanly_for_high_tiers() {
        let tiny_preview = encode_jpeg(320, 240, [100, 150, 200]);
        let file = build_camera_mpf_jpeg(4000, 3000, &tiny_preview, 1024);
        let len = file.len() as u64;
        let mut cursor = Cursor::new(file);

        // 320x240 is enough for T256 (>= 200px), but rejected for T512/P2560 so caller streams full JPEG!
        assert!(read_jpeg_range_preview(&mut cursor, len, PreviewTier::T256).is_ok());
        let err = read_jpeg_range_preview(&mut cursor, len, PreviewTier::P2560)
            .err()
            .expect("must reject tiny embedded preview for P2560");
        assert!(err.to_string().starts_with("E_UNSUPPORTED_CODEC"));
    }
}
