//! Bounded standard-TIFF JPEG preview extraction, independent of camera models.
//! Proprietary MakerNotes, BigTIFF and arbitrary JPEG signature scans are not parsed.

use std::{
    collections::{HashSet, VecDeque},
    fs::File,
    io::{Cursor, Read, Seek, SeekFrom},
    path::Path,
};

use anyhow::{bail, ensure, Context, Result};
use image::{metadata::Orientation, DynamicImage, ImageDecoder, ImageFormat, ImageReader};

const MAX_IFDS: usize = 32;
const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 1024;
const MAX_TOTAL_ENTRIES: usize = 4096;
const MAX_CANDIDATES: usize = 16;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_JPEG_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_READ_BYTES: u64 = 96 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
struct Candidate {
    offset: u64,
    length: u64,
    orientation: Option<u16>,
    inherited_orientation: Option<u16>,
}

struct TiffReader<R> {
    input: R,
    length: u64,
    little: bool,
    read_bytes: u64,
    metadata_bytes: u64,
}

impl<R: Read + Seek> TiffReader<R> {
    fn range(&self, offset: u64, length: u64) -> Result<()> {
        ensure!(
            offset
                .checked_add(length)
                .is_some_and(|end| end <= self.length),
            "E_DECODE: Embedded preview TIFF range is outside the file"
        );
        Ok(())
    }

    fn read_at(&mut self, offset: u64, length: u64, metadata: bool) -> Result<Vec<u8>> {
        self.range(offset, length)?;
        self.read_bytes = self
            .read_bytes
            .checked_add(length)
            .context("E_LIMIT: TIFF read overflow")?;
        ensure!(
            self.read_bytes <= MAX_TOTAL_READ_BYTES,
            "E_LIMIT: Embedded preview total read limit exceeded"
        );
        if metadata {
            self.metadata_bytes = self
                .metadata_bytes
                .checked_add(length)
                .context("E_LIMIT: TIFF metadata overflow")?;
            ensure!(
                self.metadata_bytes <= MAX_METADATA_BYTES,
                "E_LIMIT: Embedded preview metadata limit exceeded"
            );
        }
        let mut bytes = vec![0; usize::try_from(length)?];
        self.input.seek(SeekFrom::Start(offset))?;
        self.input
            .read_exact(&mut bytes)
            .context("E_DECODE: Truncated embedded preview")?;
        Ok(bytes)
    }

    fn u16(&self, data: &[u8]) -> u16 {
        let bytes = [data[0], data[1]];
        if self.little {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        }
    }

    fn u32(&self, data: &[u8]) -> u32 {
        let bytes = [data[0], data[1], data[2], data[3]];
        if self.little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        }
    }

    fn values(&mut self, entry: &[u8], max_count: usize) -> Result<Vec<u32>> {
        let kind = self.u16(&entry[2..]);
        let count = self.u32(&entry[4..]) as usize;
        ensure!(
            count > 0 && count <= max_count,
            "E_LIMIT: TIFF preview field count exceeds its limit"
        );
        let size = match kind {
            3 => 2,
            4 | 13 => 4,
            _ => bail!("E_DECODE: TIFF preview pointer has an invalid field type"),
        };
        let length = count
            .checked_mul(size)
            .context("E_LIMIT: TIFF value overflow")?;
        let bytes = if length <= 4 {
            entry[8..8 + length].to_vec()
        } else {
            self.read_at(u64::from(self.u32(&entry[8..])), length as u64, true)?
        };
        Ok(bytes
            .chunks_exact(size)
            .map(|value| {
                if size == 2 {
                    u32::from(self.u16(value))
                } else {
                    self.u32(value)
                }
            })
            .collect())
    }

    fn candidates(&mut self) -> Result<Vec<Candidate>> {
        let header = self.read_at(0, 8, true)?;
        self.little = match &header[..2] {
            b"II" => true,
            b"MM" => false,
            _ => bail!("E_UNSUPPORTED_CODEC: Embedded previews require a standard TIFF container"),
        };
        ensure!(
            self.u16(&header[2..]) == 42,
            "E_UNSUPPORTED_CODEC: Embedded previews require classic TIFF (not BigTIFF)"
        );
        let first = u64::from(self.u32(&header[4..]));
        ensure!(first >= 8, "E_DECODE: Invalid TIFF first directory");
        let mut queue = VecDeque::from([(first, 0_usize, None)]);
        let mut visited = HashSet::new();
        let mut total_entries = 0;
        let mut candidates = Vec::new();
        let mut ranges = HashSet::new();
        while let Some((offset, depth, inherited_orientation)) = queue.pop_front() {
            ensure!(
                depth <= MAX_DEPTH,
                "E_LIMIT: Embedded preview directory depth exceeded"
            );
            ensure!(
                visited.insert(offset),
                "E_DECODE: Cyclic or repeated TIFF preview directory"
            );
            ensure!(
                visited.len() <= MAX_IFDS,
                "E_LIMIT: Too many TIFF preview directories"
            );
            ensure!(offset >= 8, "E_DECODE: TIFF directory overlaps the header");
            let count_data = self.read_at(offset, 2, true)?;
            let count = usize::from(self.u16(&count_data));
            ensure!(
                count <= MAX_ENTRIES,
                "E_LIMIT: TIFF directory entry limit exceeded"
            );
            total_entries += count;
            ensure!(
                total_entries <= MAX_TOTAL_ENTRIES,
                "E_LIMIT: TIFF total entry limit exceeded"
            );
            let data = self.read_at(offset + 2, (count * 12 + 4) as u64, true)?;
            let mut jpeg_offset = None;
            let mut jpeg_length = None;
            let mut strip_offset = None;
            let mut strip_length = None;
            let mut compression = None;
            let mut orientation = None;
            let mut children = Vec::new();
            let mut tags = HashSet::new();
            for entry in data[..count * 12].as_chunks::<12>().0 {
                let tag = self.u16(entry);
                // Validate known TIFF value ranges even for fields we do not interpret.
                let unit = match self.u16(&entry[2..]) {
                    1 | 2 | 6 | 7 => Some(1_u64),
                    3 | 8 => Some(2),
                    4 | 9 | 11 | 13 => Some(4),
                    5 | 10 | 12 => Some(8),
                    _ => None,
                };
                if let Some(unit) = unit {
                    let length = u64::from(self.u32(&entry[4..])) * unit;
                    if length > 4 {
                        self.range(u64::from(self.u32(&entry[8..])), length)?;
                    }
                }
                if !matches!(tag, 259 | 273 | 274 | 279 | 330 | 513 | 514) {
                    continue;
                }
                ensure!(tags.insert(tag), "E_DECODE: Duplicate TIFF preview field");
                if tag == 330 {
                    children = self.values(entry, MAX_IFDS)?;
                    continue;
                }
                // Multi-strip JPEG assembly is intentionally outside this fallback.
                if matches!(tag, 273 | 279) && self.u32(&entry[4..]) != 1 {
                    continue;
                }
                let value = self.values(entry, 1)?[0];
                match tag {
                    259 => compression = Some(value),
                    273 => strip_offset = Some(u64::from(value)),
                    274 => {
                        ensure!(
                            (1..=8).contains(&value),
                            "E_DECODE: Invalid TIFF preview orientation"
                        );
                        orientation = Some(value as u16);
                    }
                    279 => strip_length = Some(u64::from(value)),
                    513 => jpeg_offset = Some(u64::from(value)),
                    514 => jpeg_length = Some(u64::from(value)),
                    _ => unreachable!(),
                }
            }
            let effective_orientation = orientation.or(inherited_orientation);
            let next = self.u32(&data[count * 12..]);
            ensure!(
                queue.len() + children.len() + usize::from(next != 0) + visited.len() <= MAX_IFDS,
                "E_LIMIT: Too many queued TIFF preview directories"
            );
            for child in children {
                ensure!(child >= 8, "E_DECODE: Invalid TIFF preview child directory");
                queue.push_back((u64::from(child), depth + 1, effective_orientation));
            }
            if next != 0 {
                // The main-chain next IFD is a sibling, not a child. Its fallback
                // is the primary/parent orientation, never the previous sibling's.
                let fallback = if offset == first {
                    orientation
                } else {
                    inherited_orientation
                };
                queue.push_back((u64::from(next), depth + 1, fallback));
            }
            let mut locations = Vec::new();
            if let (Some(start), Some(length)) = (jpeg_offset, jpeg_length) {
                locations.push((start, length));
            }
            if matches!(compression, Some(6 | 7)) {
                if let (Some(start), Some(length)) = (strip_offset, strip_length) {
                    locations.push((start, length));
                }
            }
            for (start, length) in locations {
                ensure!(
                    start >= 8 && length > 0,
                    "E_DECODE: Invalid TIFF JPEG preview range"
                );
                ensure!(
                    length <= MAX_JPEG_BYTES,
                    "E_LIMIT: Embedded JPEG exceeds 32 MiB"
                );
                self.range(start, length)?;
                if ranges.insert((start, length)) {
                    candidates.push(Candidate {
                        offset: start,
                        length,
                        orientation,
                        inherited_orientation,
                    });
                    ensure!(
                        candidates.len() <= MAX_CANDIDATES,
                        "E_LIMIT: Too many embedded JPEG candidates"
                    );
                }
            }
        }
        Ok(candidates)
    }
}

fn jpeg_reader(bytes: &[u8]) -> ImageReader<Cursor<&[u8]>> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Jpeg);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(65_536);
    limits.max_image_height = Some(65_536);
    limits.max_alloc = Some(super::imaging::MAX_PIXELS * 4);
    reader.limits(limits);
    reader
}

pub(crate) fn read(path: &Path) -> Result<DynamicImage> {
    read_with_orientation(path).map(|(image, _)| image)
}

pub(crate) fn read_with_orientation(path: &Path) -> Result<(DynamicImage, u8)> {
    let file = File::open(path)?;
    let info = file.metadata()?;
    ensure!(
        info.is_file() && info.len() <= super::imaging::MAX_FILE_BYTES,
        "E_LIMIT: Invalid or oversized RAW preview source"
    );
    decode_with_orientation(TiffReader {
        input: file,
        length: info.len(),
        little: true,
        read_bytes: 0,
        metadata_bytes: 0,
    })
}

#[cfg(test)]
fn decode<R: Read + Seek>(reader: TiffReader<R>) -> Result<DynamicImage> {
    decode_with_orientation(reader).map(|(image, _)| image)
}

fn decode_with_orientation<R: Read + Seek>(
    mut reader: TiffReader<R>,
) -> Result<(DynamicImage, u8)> {
    let mut images = Vec::new();
    for candidate in reader.candidates()? {
        let bytes = reader.read_at(candidate.offset, candidate.length, false)?;
        if !bytes.starts_with(&[0xff, 0xd8]) {
            continue;
        }
        let Ok(decoder) = jpeg_reader(&bytes).into_decoder() else {
            continue;
        };
        let (width, height) = decoder.dimensions();
        let pixels = u64::from(width) * u64::from(height);
        if pixels == 0 || pixels > super::imaging::MAX_PIXELS {
            continue;
        }
        drop(decoder);
        images.push((pixels, candidate, bytes));
    }
    images.sort_by_key(|(pixels, _, _)| std::cmp::Reverse(*pixels));
    let mut decoded_pixels = 0_u64;
    for (pixels, candidate, bytes) in images {
        decoded_pixels += pixels;
        ensure!(
            decoded_pixels <= super::imaging::MAX_PIXELS * 2,
            "E_LIMIT: Embedded JPEG decode pixel budget exceeded"
        );
        let mut decoder = jpeg_reader(&bytes).into_decoder()?;
        let jpeg_orientation = decoder
            .exif_metadata()
            .ok()
            .flatten()
            .and_then(|data| exif::Reader::new().read_raw(data).ok())
            .and_then(|exif| {
                exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                    .and_then(|field| field.value.get_uint(0))
            })
            .filter(|orientation| (1..=8).contains(orientation));
        let orientation = jpeg_orientation
            .or(candidate.orientation.map(u32::from))
            .or(candidate.inherited_orientation.map(u32::from))
            .unwrap_or(1);
        if let Ok(mut image) = DynamicImage::from_decoder(decoder) {
            image.apply_orientation(
                Orientation::from_exif(orientation as u8).unwrap_or(Orientation::NoTransforms),
            );
            return Ok((image, orientation as u8));
        }
    }
    bail!("E_UNSUPPORTED_CODEC: No decodable standard TIFF embedded JPEG preview")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};

    struct Builder {
        bytes: Vec<u8>,
        little: bool,
    }
    impl Builder {
        fn new(little: bool) -> Self {
            let mut value = Self {
                bytes: vec![0; 8],
                little,
            };
            value.bytes[..2].copy_from_slice(if little { b"II" } else { b"MM" });
            value.put16(2, 42);
            value
        }
        fn put16(&mut self, offset: usize, value: u16) {
            let bytes = if self.little {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            };
            self.bytes[offset..offset + 2].copy_from_slice(&bytes);
        }
        fn put32(&mut self, offset: usize, value: u32) {
            let bytes = if self.little {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            };
            self.bytes[offset..offset + 4].copy_from_slice(&bytes);
        }
        fn data(&mut self, bytes: &[u8]) -> u32 {
            let offset = self.bytes.len() as u32;
            self.bytes.extend_from_slice(bytes);
            offset
        }
        fn ifd(&mut self, entries: &[(u16, u16, u32, u32)], next: u32) -> u32 {
            let offset = self.bytes.len();
            self.bytes.resize(offset + 2 + entries.len() * 12 + 4, 0);
            self.put16(offset, entries.len() as u16);
            for (index, &(tag, kind, count, value)) in entries.iter().enumerate() {
                let start = offset + 2 + index * 12;
                self.put16(start, tag);
                self.put16(start + 2, kind);
                self.put32(start + 4, count);
                if kind == 3 && count == 1 {
                    self.put16(start + 8, value as u16);
                } else {
                    self.put32(start + 8, value);
                }
            }
            self.put32(offset + 2 + entries.len() * 12, next);
            offset as u32
        }
        fn finish(mut self, first: u32) -> Vec<u8> {
            self.put32(4, first);
            self.bytes
        }
    }
    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = RgbImage::from_pixel(width, height, Rgb([200, 60, 20]));
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 95)
            .encode_image(&image)
            .unwrap();
        bytes
    }
    fn tiff(little: bool, previews: &[Vec<u8>], orientation: u16, strips: bool) -> Vec<u8> {
        let mut b = Builder::new(little);
        let mut directories = Vec::new();
        for bytes in previews {
            let offset = b.data(bytes);
            let entries = if strips {
                vec![
                    (259, 3, 1, 7),
                    (273, 4, 1, offset),
                    (279, 4, 1, bytes.len() as u32),
                ]
            } else {
                vec![(513, 4, 1, offset), (514, 4, 1, bytes.len() as u32)]
            };
            directories.push(b.ifd(&entries, 0));
        }
        let offsets = if directories.len() == 1 {
            directories[0]
        } else {
            let bytes: Vec<u8> = directories
                .iter()
                .flat_map(|offset| {
                    if little {
                        offset.to_le_bytes()
                    } else {
                        offset.to_be_bytes()
                    }
                })
                .collect();
            b.data(&bytes)
        };
        let root = b.ifd(
            &[
                (274, 3, 1, u32::from(orientation)),
                (330, 4, directories.len() as u32, offsets),
            ],
            0,
        );
        b.finish(root)
    }
    fn from_bytes(bytes: Vec<u8>) -> Result<DynamicImage> {
        decode(TiffReader {
            length: bytes.len() as u64,
            input: Cursor::new(bytes),
            little: true,
            read_bytes: 0,
            metadata_bytes: 0,
        })
    }

    #[test]
    fn both_endian_subifds_choose_largest_and_apply_primary_orientation() {
        for little in [false, true] {
            for strips in [false, true] {
                let image = from_bytes(tiff(little, &[jpeg(2, 3), jpeg(8, 5)], 6, strips)).unwrap();
                assert_eq!((image.width(), image.height()), (5, 8));
            }
        }
    }

    #[test]
    fn ifd0_and_ifd1_jpeg_pointers_are_supported() {
        for in_thumbnail in [false, true] {
            let mut b = Builder::new(true);
            let bytes = jpeg(8, 5);
            let start = b.data(&bytes);
            let directory = b.ifd(&[(513, 4, 1, start), (514, 4, 1, bytes.len() as u32)], 0);
            let first = if in_thumbnail {
                b.ifd(&[(274, 3, 1, 8)], directory)
            } else {
                directory
            };
            let image = from_bytes(b.finish(first)).unwrap();
            assert_eq!(
                (image.width(), image.height()),
                if in_thumbnail { (5, 8) } else { (8, 5) }
            );
        }
    }

    #[test]
    fn embedded_jpeg_explicit_normal_orientation_overrides_rotated_container() {
        let mut exif = Builder::new(true);
        let first = exif.ifd(&[(274, 3, 1, 1)], 0);
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend(exif.finish(first));
        let original = jpeg(8, 5);
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
        bytes.extend(((payload.len() + 2) as u16).to_be_bytes());
        bytes.extend(payload);
        bytes.extend(&original[2..]);
        let file = tiff(true, &[bytes], 6, false);
        let (image, effective_orientation) = decode_with_orientation(TiffReader {
            length: file.len() as u64,
            input: Cursor::new(file),
            little: true,
            read_bytes: 0,
            metadata_bytes: 0,
        })
        .unwrap();
        assert_eq!((image.width(), image.height()), (8, 5));
        assert_eq!(effective_orientation, 1);
    }

    #[test]
    fn next_ifd_inherits_primary_not_previous_sibling_orientation() {
        let mut b = Builder::new(true);
        let larger = jpeg(8, 5);
        let start = b.data(&larger);
        let last = b.ifd(&[(513, 4, 1, start), (514, 4, 1, larger.len() as u32)], 0);
        let smaller = jpeg(2, 3);
        let start = b.data(&smaller);
        let second = b.ifd(
            &[
                (274, 3, 1, 1),
                (513, 4, 1, start),
                (514, 4, 1, smaller.len() as u32),
            ],
            last,
        );
        let first = b.ifd(&[(274, 3, 1, 6)], second);
        let image = from_bytes(b.finish(first)).unwrap();
        assert_eq!((image.width(), image.height()), (5, 8));
    }

    #[test]
    fn invalid_jpeg_candidate_does_not_hide_a_valid_smaller_preview() {
        let image = from_bytes(tiff(
            true,
            &[vec![0xff, 0xd8, 1, 2, 3], jpeg(8, 5)],
            1,
            false,
        ))
        .unwrap();
        assert_eq!((image.width(), image.height()), (8, 5));
    }

    #[test]
    fn rejects_out_of_file_zero_oversized_and_overflowing_preview_ranges() {
        for (offset, length) in [
            (u32::MAX, 32),
            (8, 0),
            (8, (MAX_JPEG_BYTES + 1) as u32),
            (u32::MAX, u32::MAX),
        ] {
            let mut b = Builder::new(true);
            let first = b.ifd(&[(513, 4, 1, offset), (514, 4, 1, length)], 0);
            assert!(from_bytes(b.finish(first)).is_err());
        }
    }

    #[test]
    fn rejects_cycles_directory_depth_entry_and_field_count_limits() {
        let mut b = Builder::new(true);
        let first = b.ifd(&[], 8);
        assert!(from_bytes(b.finish(first))
            .unwrap_err()
            .to_string()
            .contains("Cyclic"));
        let mut b = Builder::new(true);
        let mut next = 0;
        for _ in 0..MAX_DEPTH + 2 {
            next = b.ifd(&[], next);
        }
        assert!(from_bytes(b.finish(next))
            .unwrap_err()
            .to_string()
            .contains("depth"));
        let mut b = Builder::new(true);
        let first = b.ifd(&[], 0);
        b.put16(first as usize, (MAX_ENTRIES + 1) as u16);
        assert!(from_bytes(b.finish(first))
            .unwrap_err()
            .to_string()
            .contains("entry limit"));
        let mut b = Builder::new(true);
        let first = b.ifd(&[(330, 4, u32::MAX, 8)], 0);
        assert!(from_bytes(b.finish(first)).is_err());
    }

    #[test]
    fn rejects_candidate_directory_and_total_entry_budget_exhaustion() {
        assert!(
            from_bytes(tiff(true, &vec![jpeg(2, 2); MAX_CANDIDATES + 1], 1, false))
                .unwrap_err()
                .to_string()
                .contains("candidates")
        );
        assert!(
            from_bytes(tiff(true, &vec![jpeg(2, 2); MAX_IFDS], 1, false))
                .unwrap_err()
                .to_string()
                .contains("directories")
        );
        let mut b = Builder::new(true);
        let mut next = 0;
        for _ in 0..5 {
            next = b.ifd(&vec![(65000, 1, 1, 0); MAX_ENTRIES], next);
        }
        assert!(from_bytes(b.finish(next))
            .unwrap_err()
            .to_string()
            .contains("total entry"));
    }

    #[test]
    fn total_read_and_metadata_budgets_are_enforced_before_allocation() {
        let mut reader = TiffReader {
            length: 16,
            input: Cursor::new(vec![0; 16]),
            little: true,
            read_bytes: MAX_TOTAL_READ_BYTES - 4,
            metadata_bytes: 0,
        };
        assert!(reader
            .read_at(0, 8, false)
            .unwrap_err()
            .to_string()
            .contains("total read"));
        reader.read_bytes = 0;
        reader.metadata_bytes = MAX_METADATA_BYTES - 4;
        assert!(reader
            .read_at(0, 8, true)
            .unwrap_err()
            .to_string()
            .contains("metadata limit"));
    }

    #[test]
    fn rejects_non_tiff_bigtiff_unknown_compression_and_multiple_strips() {
        assert!(from_bytes(vec![0; 32]).is_err());
        let mut b = Builder::new(true);
        b.put16(2, 43);
        let first = b.ifd(&[], 0);
        assert!(from_bytes(b.finish(first))
            .unwrap_err()
            .to_string()
            .contains("BigTIFF"));
        for compression in [1, 7] {
            let mut b = Builder::new(true);
            let bytes = jpeg(8, 5);
            let start = b.data(&bytes);
            let offsets = b.data(&[start.to_le_bytes(), start.to_le_bytes()].concat());
            let counts = b.data(
                &[
                    (bytes.len() as u32).to_le_bytes(),
                    (bytes.len() as u32).to_le_bytes(),
                ]
                .concat(),
            );
            let first = b.ifd(
                &[
                    (259, 3, 1, compression),
                    (273, 4, 2, offsets),
                    (279, 4, 2, counts),
                ],
                0,
            );
            assert!(from_bytes(b.finish(first)).is_err());
        }
    }

    #[test]
    fn rejects_excessive_pixel_dimensions_without_decoding_sensor_sized_buffers() {
        let mut bytes = jpeg(8, 5);
        let sof = bytes
            .windows(2)
            .position(|pair| pair == [0xff, 0xc0])
            .unwrap();
        bytes[sof + 5..sof + 9].fill(0xff);
        assert!(from_bytes(tiff(true, &[bytes], 1, false)).is_err());
    }

    #[test]
    fn unsupported_raw_is_indexed_with_labeled_preview_histogram_and_crop_but_cannot_export() {
        let temp = tempfile::tempdir().unwrap();
        let original = tiff(true, &[jpeg(16, 10)], 6, false);
        let path = temp.path().join("unknown-camera.nef");
        std::fs::write(&path, &original).unwrap();
        let core = crate::Core::open(temp.path().join("catalog")).unwrap();
        let asset = core.open_file(&path).unwrap();
        assert_eq!(asset.availability, "available");
        assert_eq!(asset.metadata["Preview Source"], "embedded_jpeg");
        assert_eq!(asset.metadata["Preview Dimensions"], "10 × 16");
        assert!(asset.metadata["Decode Status"].contains("RAW 原始解码不可用"));
        assert!(!asset.metadata.contains_key("Sensor Dimensions"));
        core.dispatch(
            "asset.crop",
            serde_json::json!({"id":asset.id,"x":0.0,"y":0.0,"width":0.5,"height":1.0}),
        )
        .unwrap();
        let preview = core
            .dispatch(
                "asset.preview",
                serde_json::json!({"id":asset.id,"max_size":32}),
            )
            .unwrap();
        assert_eq!(preview["source"], "embedded_jpeg");
        assert_eq!(
            (preview["width"].as_u64(), preview["height"].as_u64()),
            (Some(5), Some(16))
        );
        let histogram = core
            .dispatch("asset.histogram", serde_json::json!({"id":asset.id}))
            .unwrap();
        assert_eq!(histogram["source"], "embedded_jpeg");
        assert_eq!(histogram["pixels"], 80);
        assert_eq!(
            histogram["red"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap())
                .sum::<u64>(),
            80
        );
        let destination = temp.path().join("must-not-be-preview.jpg");
        let error = core
            .dispatch(
                "asset.export",
                serde_json::json!({"id":asset.id,"destination":destination}),
            )
            .unwrap_err();
        assert!(format!("{error:#}").contains("内嵌预览仅用于查看"));
        assert!(!destination.exists());
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[test]
    fn successful_raw_metadata_does_not_prevent_fallback_after_sensor_decode_failure() {
        // DNG metadata is supported, but its lossless-JPEG sensor strip is corrupt.
        // A separate standard JPEG preview must still be usable for viewing only.
        let temp = tempfile::tempdir().unwrap();
        let mut b = Builder::new(true);
        let make = b.data(b"Nebulume\0");
        let model = b.data(b"Synthetic Bayer\0");
        let broken_strip = b.data(b"broken");
        let preview = jpeg(16, 10);
        let jpeg_offset = b.data(&preview);
        let root = b.ifd(
            &[
                (256, 4, 1, 8),
                (257, 4, 1, 6),
                (258, 3, 1, 16),
                (259, 3, 1, 7),
                (262, 3, 1, 32803),
                (271, 2, 9, make),
                (272, 2, 16, model),
                (273, 4, 1, broken_strip),
                (274, 3, 1, 6),
                (277, 3, 1, 1),
                (278, 4, 1, 6),
                (279, 4, 1, 6),
                (284, 3, 1, 1),
                (513, 4, 1, jpeg_offset),
                (514, 4, 1, preview.len() as u32),
                (33422, 1, 4, 0x02010100),
                (50706, 1, 4, 0x00000401),
                (50717, 4, 1, 4095),
            ],
            0,
        );
        let path = temp.path().join("damaged-sensor.dng");
        std::fs::write(&path, b.finish(root)).unwrap();
        let inspection = crate::imaging::inspect(&path).unwrap();
        assert_eq!(inspection.metadata["Sensor Dimensions"], "8 × 6");
        assert!(!inspection.metadata.contains_key("Preview Source"));
        let rendered = crate::imaging::preview(&path, None, 1600).unwrap();
        assert_eq!(rendered["source"], "embedded_jpeg");
        assert_eq!(rendered["width"], 10);
        assert_eq!(rendered["height"], 16);
        assert_eq!(
            crate::imaging::histogram(&path, None).unwrap()["source"],
            "embedded_jpeg"
        );
        let error = crate::imaging::render(&path, None, None).unwrap_err();
        assert!(format!("{error:#}").contains("内嵌预览仅用于查看"));
    }

    #[test]
    fn exif_ascii_values_drop_nul_padding_without_quotes_or_empty_fields() {
        let temp = tempfile::tempdir().unwrap();
        let mut b = Builder::new(true);
        let model = b.data(b"Camera Model\0\0\0\0\0");
        let lens = b.data(b"Lens Model\0\0\0\0\0\0");
        let blanks = b.data(&[0; 32]);
        let software = b.data(b"Nebulume\0Helper\0\0");
        let exif = b.ifd(&[(42036, 2, 16, lens)], 0);
        let root = b.ifd(
            &[
                (272, 2, 17, model),
                (305, 2, 17, software),
                (315, 2, 32, blanks),
                (33432, 2, 32, blanks),
                (34665, 4, 1, exif),
            ],
            0,
        );
        let path = temp.path().join("padded-exif.tif");
        std::fs::write(&path, b.finish(root)).unwrap();
        let metadata = crate::imaging::read_exif(&path);
        assert_eq!(metadata["Camera"], "Camera Model");
        assert_eq!(metadata["Lens"], "Lens Model");
        assert_eq!(metadata["EXIF LensModel"], "Lens Model");
        assert_eq!(metadata["Software"], "Nebulume; Helper");
        for key in ["Artist", "Copyright", "EXIF Artist", "EXIF Copyright"] {
            assert!(!metadata.contains_key(key), "{key}");
        }
    }
}
