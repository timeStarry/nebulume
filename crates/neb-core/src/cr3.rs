//! Bounded ISO-BMFF container support for Canon CR3 (`ftypcrx `) metadata and
//! embedded previews, plus bounded ISO-BMFF `Exif` item span lookup for
//! HEIC / HEIF / AVIF capture-time extraction.
//!
//! No unsafe code, no C codecs, and strict byte/box budgets so both local files
//! and remote HTTP Range readers operate predictably.

use std::io::{Read, Seek, SeekFrom};

use anyhow::{bail, ensure, Context, Result};

const CANON_META_UUID: [u8; 16] = [
    0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48,
];
const CANON_PREVIEW_UUID: [u8; 16] = [
    0xea, 0xf4, 0x2b, 0x5e, 0x1c, 0x98, 0x4b, 0x88, 0xb9, 0xfb, 0xb7, 0xdc, 0x40, 0x6e, 0x4d, 0x16,
];

const MAX_BOXES: usize = 512;
const MAX_META_READ_BYTES: u64 = 512 * 1024;
const MAX_CMT_BYTES: u64 = 64 * 1024;
const MAX_IFD_ENTRIES: usize = 512;
const MAX_FIELD_BYTES: usize = 4 * 1024;
const MAX_JPEG_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ByteSpan {
    pub offset: u64,
    pub length: u64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Cr3Container {
    pub cmt1: Option<ByteSpan>,
    pub cmt2: Option<ByteSpan>,
    /// Candidate embedded JPEG byte ranges (Track 1 full-res JPEG in `mdat`,
    /// `PRVW` preview box, and `THMB` thumbnail box).
    pub jpeg_candidates: Vec<ByteSpan>,
}

#[derive(Clone, Copy, Debug)]
struct BoxHeader {
    kind: [u8; 4],
    payload_offset: u64,
    payload_len: u64,
    next_offset: u64,
}

struct BoundedBmff<'a, R> {
    input: &'a mut R,
    file_len: u64,
    read_bytes: u64,
    max_read_bytes: u64,
    boxes_seen: usize,
}

impl<R: Read + Seek> BoundedBmff<'_, R> {
    fn read_bytes(&mut self, offset: u64, len: u64) -> Result<Vec<u8>> {
        let end = offset
            .checked_add(len)
            .context("E_LIMIT: ISO-BMFF offset overflow")?;
        ensure!(
            end <= self.file_len,
            "E_DECODE: ISO-BMFF range exceeds container length"
        );
        self.read_bytes = self
            .read_bytes
            .checked_add(len)
            .context("E_LIMIT: ISO-BMFF read budget overflow")?;
        ensure!(
            self.read_bytes <= self.max_read_bytes,
            "E_LIMIT: ISO-BMFF metadata read budget exceeded"
        );
        let mut buf = vec![0_u8; usize::try_from(len)?];
        self.input.seek(SeekFrom::Start(offset))?;
        self.input
            .read_exact(&mut buf)
            .context("E_DECODE: Truncated ISO-BMFF container")?;
        Ok(buf)
    }

    fn next_box(&mut self, cursor: u64, end: u64) -> Result<Option<BoxHeader>> {
        if cursor >= end {
            return Ok(None);
        }
        ensure!(end - cursor >= 8, "E_DECODE: Truncated ISO-BMFF box header");
        self.boxes_seen += 1;
        ensure!(
            self.boxes_seen <= MAX_BOXES,
            "E_LIMIT: Too many ISO-BMFF boxes"
        );
        let head = self.read_bytes(cursor, 8)?;
        let size32 = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
        let kind = [head[4], head[5], head[6], head[7]];
        let (header_len, total_size) = match size32 {
            0 => (8_u64, end - cursor),
            1 => {
                ensure!(
                    end - cursor >= 16,
                    "E_DECODE: Truncated 64-bit ISO-BMFF box header"
                );
                let ext = self.read_bytes(cursor + 8, 8)?;
                let size64 = u64::from_be_bytes(ext.try_into().expect("8-byte slice"));
                ensure!(size64 >= 16, "E_DECODE: Invalid 64-bit ISO-BMFF box size");
                (16_u64, size64)
            }
            n if n >= 8 => (8_u64, u64::from(n)),
            _ => bail!("E_DECODE: Invalid ISO-BMFF box size"),
        };
        let next_offset = cursor
            .checked_add(total_size)
            .context("E_LIMIT: ISO-BMFF box offset overflow")?;
        ensure!(
            next_offset <= end,
            "E_DECODE: ISO-BMFF box extends past its parent container"
        );
        Ok(Some(BoxHeader {
            kind,
            payload_offset: cursor + header_len,
            payload_len: total_size - header_len,
            next_offset,
        }))
    }
}

/// Inspects the first `ftyp` box and returns the 4-byte major brand if this stream
/// begins with a valid ISO-BMFF header (`ftyp`). Never fails on non-BMFF files.
pub(crate) fn probe_ftyp_brand<R: Read + Seek>(
    input: &mut R,
    length: u64,
) -> Result<Option<[u8; 4]>> {
    if length < 16 {
        return Ok(None);
    }
    let mut head = [0_u8; 16];
    input.seek(SeekFrom::Start(0))?;
    input.read_exact(&mut head)?;
    if &head[4..8] != b"ftyp" {
        return Ok(None);
    }
    let size = u64::from(u32::from_be_bytes([head[0], head[1], head[2], head[3]]));
    if size < 16 || size > length {
        return Ok(None);
    }
    Ok(Some([head[8], head[9], head[10], head[11]]))
}

pub(crate) fn is_cr3<R: Read + Seek>(input: &mut R, length: u64) -> Result<bool> {
    Ok(probe_ftyp_brand(input, length)? == Some(*b"crx "))
}

pub(crate) fn is_heif_or_avif_brand(brand: [u8; 4]) -> bool {
    matches!(
        &brand,
        b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1" | b"avif" | b"avis"
    )
}

/// Parses a Canon CR3 container's `moov` and preview UUID boxes without reading `mdat`
/// raw image slices.
pub(crate) fn parse_cr3<R: Read + Seek>(input: &mut R, length: u64) -> Result<Cr3Container> {
    ensure!(
        is_cr3(input, length)?,
        "E_UNSUPPORTED_CODEC: Not a Canon CR3 ISO-BMFF container"
    );
    let mut bmff = BoundedBmff {
        input,
        file_len: length,
        read_bytes: 0,
        max_read_bytes: MAX_META_READ_BYTES,
        boxes_seen: 0,
    };
    let mut out = Cr3Container::default();
    let mut cursor = 0_u64;
    while let Some(b) = bmff.next_box(cursor, length)? {
        match &b.kind {
            b"moov" => parse_cr3_moov(&mut bmff, b.payload_offset, b.next_offset, &mut out)?,
            b"uuid" if b.payload_len >= 16 => {
                let uuid = bmff.read_bytes(b.payload_offset, 16)?;
                if uuid.as_slice() == CANON_PREVIEW_UUID {
                    parse_cr3_preview_uuid(
                        &mut bmff,
                        b.payload_offset + 16,
                        b.next_offset,
                        &mut out,
                    )?;
                }
            }
            b"PRVW" => {
                if let Some(span) = parse_prvw_box(&mut bmff, b.payload_offset, b.payload_len)? {
                    out.jpeg_candidates.push(span);
                }
            }
            _ => {}
        }
        cursor = b.next_offset;
    }
    Ok(out)
}

fn parse_cr3_moov<R: Read + Seek>(
    bmff: &mut BoundedBmff<'_, R>,
    start: u64,
    end: u64,
    out: &mut Cr3Container,
) -> Result<()> {
    let mut cursor = start;
    while let Some(b) = bmff.next_box(cursor, end)? {
        match &b.kind {
            b"uuid" if b.payload_len >= 16 => {
                let uuid = bmff.read_bytes(b.payload_offset, 16)?;
                if uuid.as_slice() == CANON_META_UUID {
                    parse_canon_meta_uuid(bmff, b.payload_offset + 16, b.next_offset, out)?;
                } else if uuid.as_slice() == CANON_PREVIEW_UUID {
                    parse_cr3_preview_uuid(bmff, b.payload_offset + 16, b.next_offset, out)?;
                }
            }
            b"trak" => {
                if let Some(span) = parse_trak_jpeg_sample(bmff, b.payload_offset, b.next_offset)? {
                    out.jpeg_candidates.push(span);
                }
            }
            _ => {}
        }
        cursor = b.next_offset;
    }
    Ok(())
}

fn parse_canon_meta_uuid<R: Read + Seek>(
    bmff: &mut BoundedBmff<'_, R>,
    start: u64,
    end: u64,
    out: &mut Cr3Container,
) -> Result<()> {
    let mut cursor = start;
    while let Some(b) = bmff.next_box(cursor, end)? {
        match &b.kind {
            b"CMT1" if b.payload_len >= 8 && b.payload_len <= MAX_CMT_BYTES => {
                out.cmt1 = Some(ByteSpan {
                    offset: b.payload_offset,
                    length: b.payload_len,
                });
            }
            b"CMT2" if b.payload_len >= 8 && b.payload_len <= MAX_CMT_BYTES => {
                out.cmt2 = Some(ByteSpan {
                    offset: b.payload_offset,
                    length: b.payload_len,
                });
            }
            b"THMB" => {
                if let Some(span) = parse_thmb_box(bmff, b.payload_offset, b.payload_len)? {
                    out.jpeg_candidates.push(span);
                }
            }
            _ => {}
        }
        cursor = b.next_offset;
    }
    Ok(())
}

fn parse_cr3_preview_uuid<R: Read + Seek>(
    bmff: &mut BoundedBmff<'_, R>,
    start: u64,
    end: u64,
    out: &mut Cr3Container,
) -> Result<()> {
    let mut cursor = start;
    while let Some(b) = bmff.next_box(cursor, end)? {
        if &b.kind == b"PRVW" {
            if let Some(span) = parse_prvw_box(bmff, b.payload_offset, b.payload_len)? {
                out.jpeg_candidates.push(span);
            }
        }
        cursor = b.next_offset;
    }
    Ok(())
}

/// Canon `PRVW` box payload:
/// `[version_flags: 4][reserved: 2][width: 2][height: 2][reserved: 2][jpeg_size: 4][jpeg...]` (16-byte header).
fn parse_prvw_box<R: Read + Seek>(
    bmff: &mut BoundedBmff<'_, R>,
    payload_offset: u64,
    payload_len: u64,
) -> Result<Option<ByteSpan>> {
    if payload_len <= 16 {
        return Ok(None);
    }
    let head = bmff.read_bytes(payload_offset, 16)?;
    let declared_len = u64::from(u32::from_be_bytes([head[12], head[13], head[14], head[15]]));
    let avail = payload_len - 16;
    let jpeg_len = if declared_len > 0 && declared_len <= avail {
        declared_len
    } else {
        avail
    };
    if !(4..=MAX_JPEG_BYTES).contains(&jpeg_len) {
        return Ok(None);
    }
    let sig = bmff.read_bytes(payload_offset + 16, 2)?;
    Ok((sig == [0xff, 0xd8]).then_some(ByteSpan {
        offset: payload_offset + 16,
        length: jpeg_len,
    }))
}

/// Canon `THMB` box payload:
/// `[version_flags: 4][width: 2][height: 2][jpeg_size: 4][reserved: 4][jpeg...]` (16-byte header;
/// version 1 may use a 12-byte header, so check offset 16 and 12 explicitly).
fn parse_thmb_box<R: Read + Seek>(
    bmff: &mut BoundedBmff<'_, R>,
    payload_offset: u64,
    payload_len: u64,
) -> Result<Option<ByteSpan>> {
    if payload_len <= 12 {
        return Ok(None);
    }
    let probe_len = payload_len.min(20);
    let head = bmff.read_bytes(payload_offset, probe_len)?;
    let declared_len = u64::from(u32::from_be_bytes([head[8], head[9], head[10], head[11]]));
    for hdr_size in [16_u64, 12_u64] {
        if payload_len > hdr_size + 2
            && head.get(hdr_size as usize..hdr_size as usize + 2) == Some(&[0xff, 0xd8])
        {
            let avail = payload_len - hdr_size;
            let jpeg_len = if declared_len > 0 && declared_len <= avail {
                declared_len
            } else {
                avail
            };
            if jpeg_len <= MAX_JPEG_BYTES {
                return Ok(Some(ByteSpan {
                    offset: payload_offset + hdr_size,
                    length: jpeg_len,
                }));
            }
        }
    }
    Ok(None)
}

/// Walks `trak -> mdia -> minf -> stbl` to see if sample #1 in `mdat` is a single
/// embedded JPEG frame (Canon CR3 Track 1 stores the full-resolution camera JPEG).
fn parse_trak_jpeg_sample<R: Read + Seek>(
    bmff: &mut BoundedBmff<'_, R>,
    start: u64,
    end: u64,
) -> Result<Option<ByteSpan>> {
    let Some(mdia) = find_child_box(bmff, start, end, *b"mdia")? else {
        return Ok(None);
    };
    let Some(minf) = find_child_box(bmff, mdia.payload_offset, mdia.next_offset, *b"minf")? else {
        return Ok(None);
    };
    let Some(stbl) = find_child_box(bmff, minf.payload_offset, minf.next_offset, *b"stbl")? else {
        return Ok(None);
    };

    let mut sample_size: Option<u64> = None;
    let mut chunk_offset: Option<u64> = None;
    let mut cursor = stbl.payload_offset;
    while let Some(b) = bmff.next_box(cursor, stbl.next_offset)? {
        match &b.kind {
            b"stsz" if b.payload_len >= 12 => {
                let head = bmff.read_bytes(b.payload_offset, b.payload_len.min(16))?;
                let fixed_size = u32::from_be_bytes([head[4], head[5], head[6], head[7]]);
                let count = u32::from_be_bytes([head[8], head[9], head[10], head[11]]);
                if fixed_size > 0 {
                    sample_size = Some(u64::from(fixed_size));
                } else if count >= 1 && head.len() >= 16 {
                    sample_size = Some(u64::from(u32::from_be_bytes([
                        head[12], head[13], head[14], head[15],
                    ])));
                }
            }
            b"stco" if b.payload_len >= 12 => {
                let head = bmff.read_bytes(b.payload_offset, 12)?;
                let count = u32::from_be_bytes([head[4], head[5], head[6], head[7]]);
                if count >= 1 {
                    chunk_offset = Some(u64::from(u32::from_be_bytes([
                        head[8], head[9], head[10], head[11],
                    ])));
                }
            }
            b"co64" if b.payload_len >= 16 => {
                let head = bmff.read_bytes(b.payload_offset, 16)?;
                let count = u32::from_be_bytes([head[4], head[5], head[6], head[7]]);
                if count >= 1 {
                    chunk_offset = Some(u64::from_be_bytes(
                        head[8..16].try_into().expect("8-byte offset"),
                    ));
                }
            }
            _ => {}
        }
        cursor = b.next_offset;
    }

    let (Some(offset), Some(length)) = (chunk_offset, sample_size) else {
        return Ok(None);
    };
    if !(4..=MAX_JPEG_BYTES).contains(&length) {
        return Ok(None);
    }
    if offset
        .checked_add(length)
        .is_none_or(|end| end > bmff.file_len)
    {
        return Ok(None);
    }
    let sig = bmff.read_bytes(offset, 2)?;
    Ok((sig == [0xff, 0xd8]).then_some(ByteSpan { offset, length }))
}

fn find_child_box<R: Read + Seek>(
    bmff: &mut BoundedBmff<'_, R>,
    start: u64,
    end: u64,
    target: [u8; 4],
) -> Result<Option<BoxHeader>> {
    let mut cursor = start;
    while let Some(b) = bmff.next_box(cursor, end)? {
        if b.kind == target {
            return Ok(Some(b));
        }
        cursor = b.next_offset;
    }
    Ok(None)
}

#[derive(Clone)]
struct TiffField {
    tag: u16,
    kind: u16,
    count: u32,
    le_data: Vec<u8>,
}

fn unit_bytes(kind: u16) -> Option<usize> {
    match kind {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

/// Parses a single-IFD classic TIFF buffer (`CMT1` or `CMT2`) and normalizes its
/// multi-byte numeric fields into little-endian bytes so IFD0 and ExifIFD can be
/// merged into one canonical classic TIFF buffer.
fn parse_cmt_fields(bytes: &[u8]) -> Option<Vec<TiffField>> {
    if bytes.len() < 8 {
        return None;
    }
    let little = match &bytes[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |slice: &[u8]| -> u16 {
        if little {
            u16::from_le_bytes([slice[0], slice[1]])
        } else {
            u16::from_be_bytes([slice[0], slice[1]])
        }
    };
    let u32_at = |slice: &[u8]| -> u32 {
        if little {
            u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]])
        } else {
            u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]])
        }
    };
    if u16_at(&bytes[2..4]) != 42 {
        return None;
    }
    let dir_offset = usize::try_from(u32_at(&bytes[4..8])).ok()?;
    if dir_offset < 8 || dir_offset + 2 > bytes.len() {
        return None;
    }
    let count = usize::from(u16_at(&bytes[dir_offset..dir_offset + 2]));
    if count > MAX_IFD_ENTRIES {
        return None;
    }
    let entries_end = dir_offset.checked_add(2 + count * 12)?;
    if entries_end > bytes.len() {
        return None;
    }
    let mut fields = Vec::with_capacity(count);
    for entry in bytes[dir_offset + 2..entries_end].as_chunks::<12>().0 {
        let tag = u16_at(&entry[0..2]);
        // Skip private MakerNotes/UserComment and old sub-IFD pointers.
        if matches!(tag, 0x8769 | 0x8825 | 0x927c | 0x9286 | 0xa005) {
            continue;
        }
        let kind = u16_at(&entry[2..4]);
        let Some(unit) = unit_bytes(kind) else {
            continue;
        };
        let value_count = u32_at(&entry[4..8]);
        let byte_len = usize::try_from(value_count).ok()?.checked_mul(unit)?;
        if byte_len == 0 || byte_len > MAX_FIELD_BYTES {
            continue;
        }
        let raw = if byte_len <= 4 {
            &entry[8..8 + byte_len]
        } else {
            let offset = usize::try_from(u32_at(&entry[8..12])).ok()?;
            let end = offset.checked_add(byte_len)?;
            if end > bytes.len() {
                continue;
            }
            &bytes[offset..end]
        };
        let le_data = if little || unit == 1 {
            raw.to_vec()
        } else {
            let mut converted = Vec::with_capacity(raw.len());
            let swap_unit = match kind {
                5 | 10 => 4, // RATIONAL / SRATIONAL are two u32/i32 components
                _ => unit,
            };
            for chunk in raw.chunks_exact(swap_unit) {
                for b in chunk.iter().rev() {
                    converted.push(*b);
                }
            }
            converted
        };
        fields.push(TiffField {
            tag,
            kind,
            count: value_count,
            le_data,
        });
    }
    Some(fields)
}

fn write_le_ifd(out: &mut Vec<u8>, ifd_offset: usize, fields: &[TiffField]) {
    out[ifd_offset..ifd_offset + 2].copy_from_slice(&(fields.len() as u16).to_le_bytes());
    for (idx, field) in fields.iter().enumerate() {
        let pos = ifd_offset + 2 + idx * 12;
        out[pos..pos + 2].copy_from_slice(&field.tag.to_le_bytes());
        out[pos + 2..pos + 4].copy_from_slice(&field.kind.to_le_bytes());
        out[pos + 4..pos + 8].copy_from_slice(&field.count.to_le_bytes());
        if field.le_data.len() <= 4 {
            out[pos + 8..pos + 8 + field.le_data.len()].copy_from_slice(&field.le_data);
        } else {
            let val_offset = out.len() as u32;
            out[pos + 8..pos + 12].copy_from_slice(&val_offset.to_le_bytes());
            out.extend_from_slice(&field.le_data);
            if !out.len().is_multiple_of(2) {
                out.push(0);
            }
        }
    }
}

/// Reads `CMT1` (IFD0) and `CMT2` (ExifIFD) from a Canon CR3 stream and merges them
/// into a compact, self-contained classic TIFF buffer suitable for `kamadak-exif` and
/// `capture_time`.
pub(crate) fn merged_exif_tiff<R: Read + Seek>(
    input: &mut R,
    length: u64,
) -> Result<Option<Vec<u8>>> {
    if !is_cr3(input, length)? {
        return Ok(None);
    }
    let container = parse_cr3(input, length)?;
    if container.cmt1.is_none() && container.cmt2.is_none() {
        return Ok(None);
    }
    let mut read_span = |span: ByteSpan| -> Result<Vec<u8>> {
        let mut buf = vec![0_u8; usize::try_from(span.length)?];
        input.seek(SeekFrom::Start(span.offset))?;
        input
            .read_exact(&mut buf)
            .context("E_DECODE: Truncated CR3 CMT metadata box")?;
        Ok(buf)
    };
    let mut primary = match container.cmt1 {
        Some(span) => parse_cmt_fields(&read_span(span)?).unwrap_or_default(),
        None => Vec::new(),
    };
    let mut exif = match container.cmt2 {
        Some(span) => parse_cmt_fields(&read_span(span)?).unwrap_or_default(),
        None => Vec::new(),
    };
    primary.sort_by_key(|f| f.tag);
    primary.dedup_by_key(|f| f.tag);
    exif.sort_by_key(|f| f.tag);
    exif.dedup_by_key(|f| f.tag);

    let has_exif = !exif.is_empty();
    let ifd0_count = primary.len() + usize::from(has_exif);
    let exif_offset = 8 + 2 + ifd0_count * 12 + 4;
    if has_exif {
        primary.push(TiffField {
            tag: 0x8769,
            kind: 4,
            count: 1,
            le_data: (exif_offset as u32).to_le_bytes().to_vec(),
        });
        primary.sort_by_key(|f| f.tag);
    }
    let header_and_dirs = exif_offset + if has_exif { 2 + exif.len() * 12 + 4 } else { 0 };
    let mut out = vec![0_u8; header_and_dirs];
    out[0..4].copy_from_slice(b"II\x2a\x00");
    out[4..8].copy_from_slice(&8_u32.to_le_bytes());
    write_le_ifd(&mut out, 8, &primary);
    if has_exif {
        write_le_ifd(&mut out, exif_offset, &exif);
    }
    Ok(Some(out))
}

/// Locates a single-extent classic TIFF `Exif` item inside a HEIC / HEIF / AVIF
/// ISO-BMFF `meta` box (`iinf` `infe` item_type `Exif` + `iloc` extent), returning
/// the byte span of the TIFF header (`II` or `MM`) inside the file.
pub(crate) fn find_heif_exif_tiff_span<R: Read + Seek>(
    input: &mut R,
    length: u64,
    max_read_bytes: u64,
) -> Result<Option<ByteSpan>> {
    let Some(brand) = probe_ftyp_brand(input, length)? else {
        return Ok(None);
    };
    if !is_heif_or_avif_brand(brand) {
        return Ok(None);
    }
    let mut bmff = BoundedBmff {
        input,
        file_len: length,
        read_bytes: 0,
        max_read_bytes,
        boxes_seen: 0,
    };
    let mut cursor = 0_u64;
    let mut meta_box = None;
    while let Some(b) = bmff.next_box(cursor, length)? {
        if &b.kind == b"meta" {
            meta_box = Some(b);
            break;
        }
        cursor = b.next_offset;
    }
    let Some(meta) = meta_box else {
        return Ok(None);
    };
    // ISO/IEC 14496-12 `meta` is a FullBox (4-byte version+flags before children).
    if meta.payload_len < 12 {
        return Ok(None);
    }
    let children_start = meta.payload_offset + 4;
    let mut exif_item_id: Option<u32> = None;
    let mut iloc_box: Option<BoxHeader> = None;
    let mut idat_offset: Option<u64> = None;
    let mut child_cursor = children_start;
    while let Some(b) = bmff.next_box(child_cursor, meta.next_offset)? {
        match &b.kind {
            b"iinf" if b.payload_len >= 6 => {
                exif_item_id = parse_iinf_for_exif(&mut bmff, b.payload_offset, b.next_offset)?;
            }
            b"iloc" if b.payload_len >= 8 => {
                iloc_box = Some(b);
            }
            b"idat" => {
                idat_offset = Some(b.payload_offset);
            }
            _ => {}
        }
        child_cursor = b.next_offset;
    }
    let (Some(target_id), Some(iloc)) = (exif_item_id, iloc_box) else {
        return Ok(None);
    };
    let Some(item_span) = parse_iloc_single_extent(
        &mut bmff,
        iloc.payload_offset,
        iloc.payload_len,
        target_id,
        idat_offset,
    )?
    else {
        return Ok(None);
    };
    // ISO/IEC 23008-12 Annex A.2.1: ExifDataBlock starts with 4-byte `exif_tiff_header_offset`.
    if item_span.length < 12 {
        return Ok(None);
    }
    let prefix = bmff.read_bytes(item_span.offset, 4)?;
    let tiff_rel = 4_u64
        + u64::from(u32::from_be_bytes([
            prefix[0], prefix[1], prefix[2], prefix[3],
        ]));
    if tiff_rel + 8 > item_span.length {
        return Ok(None);
    }
    Ok(Some(ByteSpan {
        offset: item_span.offset + tiff_rel,
        length: item_span.length - tiff_rel,
    }))
}

fn parse_iinf_for_exif<R: Read + Seek>(
    bmff: &mut BoundedBmff<'_, R>,
    payload_offset: u64,
    end: u64,
) -> Result<Option<u32>> {
    let head = bmff.read_bytes(payload_offset, 6)?;
    let version = head[0];
    let entry_start = if version == 0 {
        payload_offset + 6
    } else {
        if end - payload_offset < 8 {
            return Ok(None);
        }
        payload_offset + 8
    };
    let mut cursor = entry_start;
    while let Some(infe) = bmff.next_box(cursor, end)? {
        if &infe.kind == b"infe" && infe.payload_len >= 12 {
            let data = bmff.read_bytes(infe.payload_offset, infe.payload_len.min(20))?;
            let infe_ver = data[0];
            if infe_ver == 2 && data.len() >= 12 && &data[8..12] == b"Exif" {
                return Ok(Some(u32::from(u16::from_be_bytes([data[4], data[5]]))));
            } else if infe_ver == 3 && data.len() >= 14 && &data[10..14] == b"Exif" {
                return Ok(Some(u32::from_be_bytes([
                    data[4], data[5], data[6], data[7],
                ])));
            }
        }
        cursor = infe.next_offset;
    }
    Ok(None)
}

fn read_be_uint(bytes: &[u8], size: usize) -> Option<u64> {
    match size {
        0 => Some(0),
        4 => Some(u64::from(u32::from_be_bytes(
            bytes.get(..4)?.try_into().ok()?,
        ))),
        8 => Some(u64::from_be_bytes(bytes.get(..8)?.try_into().ok()?)),
        _ => None,
    }
}

fn parse_iloc_single_extent<R: Read + Seek>(
    bmff: &mut BoundedBmff<'_, R>,
    payload_offset: u64,
    payload_len: u64,
    target_id: u32,
    idat_offset: Option<u64>,
) -> Result<Option<ByteSpan>> {
    if payload_len > 64 * 1024 {
        return Ok(None);
    }
    let data = bmff.read_bytes(payload_offset, payload_len)?;
    let file_len = bmff.file_len;
    Ok((|| -> Option<ByteSpan> {
        if data.len() < 8 {
            return None;
        }
        let version = data[0];
        let offset_size = usize::from(data[4] >> 4);
        let length_size = usize::from(data[4] & 0x0f);
        let base_offset_size = usize::from(data[5] >> 4);
        let index_size = if version == 1 || version == 2 {
            usize::from(data[5] & 0x0f)
        } else {
            0
        };
        let (item_count, mut pos) = if version < 2 {
            (u32::from(u16::from_be_bytes([data[6], data[7]])), 8_usize)
        } else if version == 2 && data.len() >= 10 {
            (
                u32::from_be_bytes([data[6], data[7], data[8], data[9]]),
                10_usize,
            )
        } else {
            return None;
        };
        if item_count > 1024 {
            return None;
        }
        for _ in 0..item_count {
            let item_id = if version < 2 {
                let s: [u8; 2] = data.get(pos..pos + 2)?.try_into().ok()?;
                pos += 2;
                u32::from(u16::from_be_bytes(s))
            } else {
                let s: [u8; 4] = data.get(pos..pos + 4)?.try_into().ok()?;
                pos += 4;
                u32::from_be_bytes(s)
            };
            let construction_method = if version == 1 || version == 2 {
                let m = data.get(pos + 1).copied()? & 0x0f;
                pos += 2;
                m
            } else {
                0
            };
            pos += 2; // data_reference_index
            let base_offset = read_be_uint(data.get(pos..)?, base_offset_size)?;
            pos += base_offset_size;
            let ext_s: [u8; 2] = data.get(pos..pos + 2)?.try_into().ok()?;
            let extent_count = usize::from(u16::from_be_bytes(ext_s));
            pos += 2;
            let extent_entry_size = index_size + offset_size + length_size;
            if item_id == target_id && extent_count == 1 {
                pos += index_size;
                let ext_offset = read_be_uint(data.get(pos..)?, offset_size)?;
                pos += offset_size;
                let ext_length = read_be_uint(data.get(pos..)?, length_size)?;
                let origin = match construction_method {
                    0 => 0_u64,
                    1 => idat_offset?,
                    _ => return None,
                };
                let final_offset = origin.checked_add(base_offset)?.checked_add(ext_offset)?;
                if ext_length > 0
                    && final_offset
                        .checked_add(ext_length)
                        .is_some_and(|end| end <= file_len)
                {
                    return Some(ByteSpan {
                        offset: final_offset,
                        length: ext_length,
                    });
                }
                return None;
            }
            pos = pos.checked_add(extent_count.checked_mul(extent_entry_size)?)?;
        }
        None
    })())
}
