//! Bounded focus-area metadata, independent of image decoding.
//!
//! Follow only standard EXIF pointers and Nikon Type 3 MakerNote directories.
//! Never search image payloads for signatures or disclose arbitrary MakerNotes.

use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use anyhow::{ensure, Context, Result};
use serde::Serialize;

const MAX_READ_BYTES: u64 = 64 * 1024;
const MAX_IFD_ENTRIES: usize = 512;
const MAX_JPEG_SEGMENTS: usize = 256;
const MAX_MAKER_BYTES: u64 = 4 * 1024 * 1024;
const MAX_AF_BYTES: u64 = 4096;

#[derive(Debug, Clone, Serialize)]
pub struct FocusRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct FocusInfo {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub source: Option<&'static str>,
    pub coordinate_space: &'static str,
    pub orientation: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_height: Option<u32>,
    pub regions: Vec<FocusRegion>,
}

impl FocusInfo {
    fn unavailable(
        status: &'static str,
        reason: &'static str,
        orientation: u8,
        source: Option<&'static str>,
    ) -> Self {
        Self {
            status,
            reason: Some(reason),
            source,
            coordinate_space: "oriented_full_image",
            orientation,
            image_width: None,
            image_height: None,
            regions: Vec::new(),
        }
    }
}

#[derive(Debug)]
struct Invalid(&'static str);
type Parsed<T> = std::result::Result<T, Invalid>;

#[derive(Clone, Copy)]
struct Span {
    start: u64,
    length: u64,
}

impl Span {
    fn part(self, relative: u64, length: u64) -> Parsed<Self> {
        if !relative
            .checked_add(length)
            .is_some_and(|end| end <= self.length)
        {
            return Err(Invalid("对焦元数据偏移超出其容器范围。"));
        }
        Ok(Self {
            start: self
                .start
                .checked_add(relative)
                .ok_or(Invalid("对焦元数据偏移无效。"))?,
            length,
        })
    }
}

#[derive(Clone, Copy)]
struct Order(bool);

impl Order {
    fn u16(self, bytes: &[u8]) -> u16 {
        let value = [bytes[0], bytes[1]];
        if self.0 {
            u16::from_le_bytes(value)
        } else {
            u16::from_be_bytes(value)
        }
    }

    fn u32(self, bytes: &[u8]) -> u32 {
        let value = [bytes[0], bytes[1], bytes[2], bytes[3]];
        if self.0 {
            u32::from_le_bytes(value)
        } else {
            u32::from_be_bytes(value)
        }
    }
}

#[derive(Clone, Copy)]
struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    value: [u8; 4],
    value_offset: u64,
}

impl Entry {
    fn span(self, container: Span, order: Order, unit: u64, maximum: u64) -> Parsed<Span> {
        let length = u64::from(self.count)
            .checked_mul(unit)
            .ok_or(Invalid("对焦元数据字段大小无效。"))?;
        if length == 0 || length > maximum {
            return Err(Invalid("对焦元数据字段超过读取上限。"));
        }
        let offset = if length <= 4 {
            self.value_offset
        } else {
            u64::from(order.u32(&self.value))
        };
        container.part(offset, length)
    }

    fn scalar(self, order: Order, kind: u16) -> Parsed<u32> {
        if self.count != 1 || self.kind != kind {
            return Err(Invalid("对焦元数据指针或方向字段类型无效。"));
        }
        match kind {
            3 => Ok(u32::from(order.u16(&self.value))),
            4 => Ok(order.u32(&self.value)),
            _ => Err(Invalid("对焦元数据标量类型不受支持。")),
        }
    }
}

struct Reader<R> {
    input: R,
    file: Span,
    read_bytes: u64,
    directories: HashSet<u64>,
}

impl<R: Read + Seek> Reader<R> {
    fn read(&mut self, span: Span) -> Parsed<Vec<u8>> {
        self.file.part(span.start, span.length)?;
        self.read_bytes = self
            .read_bytes
            .checked_add(span.length)
            .ok_or(Invalid("对焦元数据读取大小无效。"))?;
        if self.read_bytes > MAX_READ_BYTES {
            return Err(Invalid("对焦元数据超过总读取上限。"));
        }
        let mut data = vec![0; span.length as usize];
        self.input
            .seek(SeekFrom::Start(span.start))
            .and_then(|_| self.input.read_exact(&mut data))
            .map_err(|_| Invalid("对焦元数据不完整或无法读取。"))?;
        Ok(data)
    }

    fn tiff(&mut self, container: Span) -> Parsed<(Order, u32)> {
        let header = self.read(container.part(0, 8)?)?;
        let order = match &header[..2] {
            b"II" => Order(true),
            b"MM" => Order(false),
            _ => return Err(Invalid("对焦元数据需要标准 TIFF 字节序。")),
        };
        if order.u16(&header[2..]) != 42 {
            return Err(Invalid("对焦元数据仅支持经典 TIFF，不支持 BigTIFF。"));
        }
        Ok((order, order.u32(&header[4..])))
    }

    fn directory(&mut self, container: Span, relative: u32, order: Order) -> Parsed<Vec<Entry>> {
        if relative < 8 {
            return Err(Invalid("对焦元数据目录与 TIFF 头部重叠。"));
        }
        let count_span = container.part(u64::from(relative), 2)?;
        if !self.directories.insert(count_span.start) || self.directories.len() > 3 {
            return Err(Invalid("对焦元数据目录重复或数量超限。"));
        }
        let count = usize::from(order.u16(&self.read(count_span)?));
        if count > MAX_IFD_ENTRIES {
            return Err(Invalid("对焦元数据目录条目数量超限。"));
        }
        let data = self.read(container.part(u64::from(relative) + 2, (count * 12 + 4) as u64)?)?;
        let mut tags = HashSet::new();
        let mut entries = Vec::with_capacity(count);
        for (index, bytes) in data[..count * 12].as_chunks::<12>().0.iter().enumerate() {
            let tag = order.u16(bytes);
            if !tags.insert(tag) {
                return Err(Invalid("对焦元数据目录含重复字段。"));
            }
            entries.push(Entry {
                tag,
                kind: order.u16(&bytes[2..]),
                count: order.u32(&bytes[4..]),
                value: bytes[8..12].try_into().expect("four-byte TIFF value"),
                value_offset: u64::from(relative) + 2 + (index * 12 + 8) as u64,
            });
        }
        Ok(entries)
    }

    fn exif_container(&mut self) -> Parsed<Option<Span>> {
        let header = self.read(self.file.part(0, 2)?)?;
        if matches!(header.as_slice(), b"II" | b"MM") {
            return Ok(Some(self.file));
        }
        if header != [0xff, 0xd8] {
            return Err(Invalid(
                "当前对焦区域解析仅支持带 EXIF 的 JPEG 和经典 TIFF/NEF。",
            ));
        }
        let mut offset = 2;
        for _ in 0..MAX_JPEG_SEGMENTS {
            let marker = self.read(self.file.part(offset, 2)?)?;
            if marker[0] != 0xff {
                return Err(Invalid("JPEG 元数据标记无效。"));
            }
            offset += 2;
            let mut marker = marker[1];
            let mut padding = 0;
            while marker == 0xff {
                if padding == 16 {
                    return Err(Invalid("JPEG 标记填充超过解析上限。"));
                }
                marker = self.read(self.file.part(offset, 1)?)?[0];
                offset += 1;
                padding += 1;
            }
            if marker == 0xda || marker == 0xd9 {
                return Ok(None);
            }
            if marker == 0 || marker == 0xd8 || (0xd0..=0xd7).contains(&marker) {
                return Err(Invalid("JPEG 元数据标记顺序无效。"));
            }
            if marker == 1 {
                continue;
            }
            let length = self.read(self.file.part(offset, 2)?)?;
            let length = u64::from(u16::from_be_bytes([length[0], length[1]]));
            if length < 2 {
                return Err(Invalid("JPEG 元数据段长度无效。"));
            }
            let segment = self.file.part(offset + 2, length - 2)?;
            if marker == 0xe1
                && segment.length >= 6
                && self.read(segment.part(0, 6)?)? == b"Exif\0\0"
            {
                return Ok(Some(segment.part(6, segment.length - 6)?));
            }
            offset += length;
        }
        Err(Invalid("JPEG 元数据段数量超过解析上限。"))
    }

    fn parse(&mut self) -> Parsed<FocusInfo> {
        let Some(container) = self.exif_container()? else {
            return Ok(FocusInfo::unavailable(
                "missing",
                "文件未记录 EXIF 对焦区域。",
                1,
                None,
            ));
        };
        let (order, first) = self.tiff(container)?;
        let primary = self.directory(container, first, order)?;
        let orientation = match find(&primary, 0x0112) {
            Some(entry) => {
                let orientation = entry.scalar(order, 3)?;
                if !(1..=8).contains(&orientation) {
                    return Err(Invalid("EXIF 方向无效，不能可靠映射对焦区域。"));
                }
                orientation as u8
            }
            None => 1,
        };
        let Some(make) = find(&primary, 0x010f) else {
            return Ok(FocusInfo::unavailable(
                "missing",
                "文件未记录可识别的相机厂商。",
                orientation,
                None,
            ));
        };
        if make.kind != 2 {
            return Err(Invalid("EXIF 相机厂商字段类型无效。"));
        }
        let make = self.read(make.span(container, order, 1, 128)?)?;
        let make = std::str::from_utf8(&make)
            .map_err(|_| Invalid("EXIF 相机厂商字段无效。"))?
            .trim_matches(|c: char| c == '\0' || c.is_ascii_whitespace());
        if !make.eq_ignore_ascii_case("NIKON") && !make.eq_ignore_ascii_case("NIKON CORPORATION") {
            return Ok(FocusInfo::unavailable(
                "unsupported",
                "暂不支持此相机厂商的对焦区域格式。",
                orientation,
                None,
            ));
        }
        let Some(exif) = find(&primary, 0x8769) else {
            return Ok(FocusInfo::unavailable(
                "missing",
                "文件未记录 EXIF 对焦区域。",
                orientation,
                None,
            ));
        };
        let exif = self.directory(container, exif.scalar(order, 4)?, order)?;
        let Some(maker) = find(&exif, 0x927c) else {
            return Ok(FocusInfo::unavailable(
                "missing",
                "文件未记录 Nikon 对焦区域。",
                orientation,
                None,
            ));
        };
        if maker.kind != 7 {
            return Err(Invalid("Nikon MakerNote 字段类型无效。"));
        }
        let maker = maker.span(container, order, 1, MAX_MAKER_BYTES)?;
        let signature = self.read(maker.part(0, 10)?)?;
        // Type 3's 2.10 and 2.11 headers share the following independent TIFF
        // container. Keep explicit minor versions and reserved-byte validation;
        // AFInfo2 versions and coordinate availability are checked separately.
        if signature != b"Nikon\0\x02\x10\0\0" && signature != b"Nikon\0\x02\x11\0\0" {
            return Ok(FocusInfo::unavailable(
                "unsupported",
                "暂不支持此 Nikon MakerNote 版本。",
                orientation,
                None,
            ));
        }
        let maker = maker.part(10, maker.length - 10)?;
        let (order, first) = self.tiff(maker)?;
        let entries = self.directory(maker, first, order)?;
        let Some(af) = find(&entries, 0x00b7) else {
            return Ok(FocusInfo::unavailable(
                "missing",
                "文件未记录 Nikon AFInfo2 对焦区域。",
                orientation,
                None,
            ));
        };
        if af.kind != 7 {
            return Err(Invalid("Nikon AFInfo2 字段类型无效。"));
        }
        let af = af.span(maker, order, 1, MAX_AF_BYTES)?;
        let version = self.read(af.part(0, 4)?)?;
        // These exact versions share the documented Nikon AFInfo2 v0300 layout.
        // Point-grid codes and inferred positions are intentionally not decoded.
        if version != b"0300" && version != b"0301" {
            return Ok(FocusInfo::unavailable(
                "unsupported",
                "暂不支持此 Nikon AFInfo2 版本。",
                orientation,
                Some("nikon_afinfo2"),
            ));
        }
        let coordinates_available = self.read(af.part(7, 1)?)?[0];
        if coordinates_available != 1 {
            return Ok(FocusInfo::unavailable(
                "unsupported",
                "此照片未记录可用的对焦区域坐标；不会由点位编号推测位置。",
                orientation,
                Some("nikon_afinfo2"),
            ));
        }
        // Only read dimensions and the recorded area. Do not export private
        // MakerNote fields, point bitmaps, or camera/owner identifiers.
        let values = self.read(af.part(42, 12)?)?;
        let numbers: Vec<_> = values
            .as_chunks::<2>()
            .0
            .iter()
            .map(|bytes| order.u16(bytes))
            .collect();
        area(
            numbers[0],
            numbers[1],
            numbers[2],
            numbers[3],
            numbers[4],
            numbers[5],
            orientation,
        )
    }
}

fn find(entries: &[Entry], tag: u16) -> Option<Entry> {
    entries.iter().copied().find(|entry| entry.tag == tag)
}

fn area(
    image_width: u16,
    image_height: u16,
    center_x: u16,
    center_y: u16,
    width: u16,
    height: u16,
    orientation: u8,
) -> Parsed<FocusInfo> {
    if image_width == 0
        || image_height == 0
        || width == 0
        || height == 0
        || u64::from(image_width) * u64::from(image_height) > super::imaging::MAX_PIXELS
    {
        return Err(Invalid("对焦区域尺寸缺失或超过支持范围。"));
    }
    let (image_width, image_height, width, height) = (
        f64::from(image_width),
        f64::from(image_height),
        f64::from(width),
        f64::from(height),
    );
    let x = f64::from(center_x) - width / 2.0;
    let y = f64::from(center_y) - height / 2.0;
    if x < 0.0 || y < 0.0 || x + width > image_width || y + height > image_height {
        return Err(Invalid("相机记录的对焦区域超出图像范围，不能可靠显示。"));
    }
    let (x, y, width, height) = match orientation {
        1 => (x, y, width, height),
        2 => (image_width - x - width, y, width, height),
        3 => (
            image_width - x - width,
            image_height - y - height,
            width,
            height,
        ),
        4 => (x, image_height - y - height, width, height),
        5 => (y, x, height, width),
        6 => (image_height - y - height, x, height, width),
        7 => (
            image_height - y - height,
            image_width - x - width,
            height,
            width,
        ),
        8 => (y, image_width - x - width, height, width),
        _ => return Err(Invalid("EXIF 方向无效，不能可靠映射对焦区域。")),
    };
    let (image_width, image_height) = if orientation >= 5 {
        (image_height, image_width)
    } else {
        (image_width, image_height)
    };
    Ok(FocusInfo {
        status: "available",
        reason: None,
        source: Some("nikon_afinfo2"),
        coordinate_space: "oriented_full_image",
        orientation,
        image_width: Some(image_width as u32),
        image_height: Some(image_height as u32),
        regions: vec![FocusRegion {
            x: x / image_width,
            y: y / image_height,
            width: width / image_width,
            height: height / image_height,
            kind: "selected",
        }],
    })
}

pub(crate) fn read(path: &Path) -> Result<FocusInfo> {
    let file = File::open(path).context("E_OFFLINE: Cannot read focus metadata")?;
    let metadata = file
        .metadata()
        .context("E_OFFLINE: Cannot inspect focus metadata source")?;
    ensure!(
        metadata.is_file(),
        "E_INVALID: Focus metadata requires a regular file"
    );
    if metadata.len() > super::imaging::MAX_FILE_BYTES {
        return Ok(FocusInfo::unavailable(
            "unsupported",
            "文件超过对焦元数据解析大小上限。",
            1,
            None,
        ));
    }
    Ok(parse(file, metadata.len()))
}

fn parse<R: Read + Seek>(input: R, length: u64) -> FocusInfo {
    let mut reader = Reader {
        input,
        file: Span { start: 0, length },
        read_bytes: 0,
        directories: HashSet::new(),
    };
    reader
        .parse()
        .unwrap_or_else(|error| FocusInfo::unavailable("unsupported", error.0, 1, None))
}

pub fn read_from<R: Read + Seek>(input: R, length: u64) -> FocusInfo {
    parse(input, length)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const EXIF_OFFSET: usize = 56;
    const MAKER_OFFSET: usize = 74;
    const MAKER_TIFF: usize = MAKER_OFFSET + 10;
    const AF_ENTRY: usize = MAKER_TIFF + 10;
    const AF_OFFSET: usize = MAKER_TIFF + 38;

    fn put16(bytes: &mut [u8], offset: usize, value: u16, little: bool) {
        bytes[offset..offset + 2].copy_from_slice(&if little {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        });
    }

    fn put32(bytes: &mut [u8], offset: usize, value: u32, little: bool) {
        bytes[offset..offset + 4].copy_from_slice(&if little {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        });
    }

    fn entry(
        bytes: &mut [u8],
        offset: usize,
        tag: u16,
        kind: u16,
        count: u32,
        value: u32,
        little: bool,
    ) {
        put16(bytes, offset, tag, little);
        put16(bytes, offset + 2, kind, little);
        put32(bytes, offset + 4, count, little);
        if kind == 3 && count == 1 {
            put16(bytes, offset + 8, value as u16, little);
        } else {
            put32(bytes, offset + 8, value, little);
        }
    }

    fn header(bytes: &mut [u8], start: usize, little: bool) {
        bytes[start..start + 2].copy_from_slice(if little { b"II" } else { b"MM" });
        put16(bytes, start + 2, 42, little);
        put32(bytes, start + 4, 8, little);
    }

    fn fixture(
        outer_little: bool,
        maker_little: bool,
        orientation: u8,
        version: &[u8; 4],
    ) -> Vec<u8> {
        let private = b"PRIVATE-FIXTURE-SERIAL";
        let mut bytes = vec![0; AF_OFFSET + 60 + private.len()];
        header(&mut bytes, 0, outer_little);
        put16(&mut bytes, 8, 3, outer_little);
        entry(&mut bytes, 10, 0x010f, 2, 6, 50, outer_little);
        entry(
            &mut bytes,
            22,
            0x0112,
            3,
            1,
            u32::from(orientation),
            outer_little,
        );
        entry(
            &mut bytes,
            34,
            0x8769,
            4,
            1,
            EXIF_OFFSET as u32,
            outer_little,
        );
        bytes[50..56].copy_from_slice(b"NIKON\0");
        put16(&mut bytes, EXIF_OFFSET, 1, outer_little);
        let maker_length = bytes.len() - MAKER_OFFSET;
        entry(
            &mut bytes,
            EXIF_OFFSET + 2,
            0x927c,
            7,
            maker_length as u32,
            MAKER_OFFSET as u32,
            outer_little,
        );
        bytes[MAKER_OFFSET..MAKER_TIFF].copy_from_slice(b"Nikon\0\x02\x10\0\0");
        header(&mut bytes, MAKER_TIFF, maker_little);
        put16(&mut bytes, MAKER_TIFF + 8, 2, maker_little);
        entry(&mut bytes, AF_ENTRY, 0x00b7, 7, 60, 38, maker_little);
        entry(
            &mut bytes,
            AF_ENTRY + 12,
            0x001d,
            2,
            private.len() as u32,
            98,
            maker_little,
        );
        bytes[AF_OFFSET..AF_OFFSET + 4].copy_from_slice(version);
        bytes[AF_OFFSET + 4] = 2;
        bytes[AF_OFFSET + 6] = 0; // A disabled point-grid schema does not invalidate explicit coordinates.
        bytes[AF_OFFSET + 7] = 1;
        for (index, value) in [400, 300, 100, 90, 40, 60].into_iter().enumerate() {
            put16(&mut bytes, AF_OFFSET + 42 + index * 2, value, maker_little);
        }
        bytes[AF_OFFSET + 60..].copy_from_slice(private);
        bytes
    }

    fn inspect(bytes: Vec<u8>) -> FocusInfo {
        let length = bytes.len() as u64;
        parse(Cursor::new(bytes), length)
    }

    fn jpeg(tiff: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
        bytes.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
        bytes.extend_from_slice(b"Exif\0\0");
        bytes.extend_from_slice(tiff);
        bytes.extend_from_slice(&[0xff, 0xda, 0, 2, 1, 2, 3, 4, 0xff, 0xd9]);
        bytes
    }

    fn assert_region(info: &FocusInfo, expected: [f64; 4]) {
        assert_eq!(info.status, "available", "{:?}", info.reason);
        assert_eq!(info.regions.len(), 1);
        let region = &info.regions[0];
        assert_eq!(region.kind, "selected");
        for (got, expected) in [region.x, region.y, region.width, region.height]
            .into_iter()
            .zip(expected)
        {
            assert!((got - expected).abs() < 1e-12, "{got} versus {expected}");
        }
    }

    #[test]
    fn supported_versions_use_maker_byte_order_in_both_tiff_and_jpeg() {
        for outer in [false, true] {
            for maker in [false, true] {
                for version in [b"0300", b"0301"] {
                    let bytes = fixture(outer, maker, 1, version);
                    for container in [bytes.clone(), jpeg(&bytes)] {
                        let info = inspect(container);
                        assert_region(&info, [0.2, 0.2, 0.1, 0.2]);
                        assert_eq!(info.image_width, Some(400));
                        assert_eq!(info.image_height, Some(300));
                        assert_eq!(info.source, Some("nikon_afinfo2"));
                        let json = serde_json::to_string(&info).unwrap();
                        assert!(!json.contains("PRIVATE-FIXTURE-SERIAL"));
                        assert!(!json.contains("MakerNote"));
                    }
                }
            }
        }
    }

    #[test]
    fn nikon_type3_minor_versions_are_explicit_and_do_not_bypass_coordinate_availability() {
        for minor in [0x10, 0x11] {
            for outer in [false, true] {
                for maker in [false, true] {
                    let mut bytes = fixture(outer, maker, 1, b"0301");
                    bytes[MAKER_OFFSET + 7] = minor;
                    for container in [bytes.clone(), jpeg(&bytes)] {
                        assert_region(&inspect(container), [0.2, 0.2, 0.1, 0.2]);
                    }
                    bytes[AF_OFFSET + 7] = 0;
                    let unavailable = inspect(jpeg(&bytes));
                    assert_eq!(unavailable.status, "unsupported");
                    assert_eq!(unavailable.source, Some("nikon_afinfo2"));
                    assert!(unavailable.reason.unwrap().contains("未记录可用"));
                    assert!(unavailable.regions.is_empty());
                }
            }
        }
        for (offset, value) in [(6, 1), (7, 0), (7, 0x12), (8, 1), (9, 1)] {
            let mut bytes = fixture(true, true, 1, b"0301");
            bytes[MAKER_OFFSET + offset] = value;
            let info = inspect(bytes);
            assert_eq!(info.status, "unsupported");
            assert!(info.regions.is_empty());
        }
    }

    #[test]
    fn all_eight_exif_orientations_transform_area_edges_and_dimensions() {
        let expected = [
            [0.2, 0.2, 0.1, 0.2],
            [0.7, 0.2, 0.1, 0.2],
            [0.7, 0.6, 0.1, 0.2],
            [0.2, 0.6, 0.1, 0.2],
            [0.2, 0.2, 0.2, 0.1],
            [0.6, 0.2, 0.2, 0.1],
            [0.6, 0.7, 0.2, 0.1],
            [0.2, 0.7, 0.2, 0.1],
        ];
        for orientation in 1..=8 {
            let info = inspect(fixture(true, true, orientation, b"0301"));
            assert_region(&info, expected[usize::from(orientation - 1)]);
            assert_eq!(info.orientation, orientation);
            assert_eq!(
                (info.image_width, info.image_height),
                if orientation >= 5 {
                    (Some(300), Some(400))
                } else {
                    (Some(400), Some(300))
                }
            );
        }
    }

    #[test]
    fn absent_metadata_is_missing_and_unsupported_formats_never_infer_points() {
        assert_eq!(inspect(vec![0xff, 0xd8, 0xff, 0xda]).status, "missing");
        for offset in [10, 34, EXIF_OFFSET + 2, AF_ENTRY] {
            let mut bytes = fixture(true, true, 1, b"0300");
            put16(&mut bytes, offset, 0xffff, true);
            assert_eq!(inspect(bytes).status, "missing");
        }
        for version in [b"0100", b"0200", b"0302", b"0400", b"9999"] {
            let info = inspect(fixture(true, true, 1, version));
            assert_eq!(info.status, "unsupported");
            assert!(info.regions.is_empty());
        }
        for flag in [0, 2, 255] {
            let mut bytes = fixture(true, true, 1, b"0300");
            bytes[AF_OFFSET + 7] = flag;
            bytes[AF_OFFSET + 6] = 8;
            bytes[AF_OFFSET + 10] = 255; // Used-point bitmap must not become guessed coordinates.
            let info = inspect(bytes);
            assert_eq!(info.status, "unsupported");
            assert!(info.regions.is_empty());
        }
        let mut bytes = fixture(true, true, 1, b"0300");
        bytes[50..56].copy_from_slice(b"CANON\0");
        assert_eq!(inspect(bytes).status, "unsupported");
        assert_eq!(inspect(b"\x89PNG\r\n\x1a\n".to_vec()).status, "unsupported");
    }

    #[test]
    fn invalid_dimensions_bounds_and_orientation_are_not_clamped_or_guessed() {
        for (field, value) in [
            (0, 0),
            (1, 0),
            (4, 0),
            (5, 0),
            (2, 0),
            (3, 0),
            (2, 400),
            (3, 300),
            (4, 401),
            (5, 301),
        ] {
            let mut bytes = fixture(true, true, 1, b"0301");
            put16(&mut bytes, AF_OFFSET + 42 + field * 2, value, true);
            let info = inspect(bytes);
            assert_eq!(info.status, "unsupported");
            assert!(info.regions.is_empty());
        }
        for orientation in [0, 9, 255] {
            assert_eq!(
                inspect(fixture(true, true, orientation, b"0300")).status,
                "unsupported"
            );
        }
        // An exact image-edge rectangle is valid, with no rounding-induced escape.
        let info = area(400, 300, 20, 30, 40, 60, 7).unwrap();
        assert_region(&info, [0.8, 0.9, 0.2, 0.1]);
    }

    #[test]
    fn truncated_and_out_of_container_offsets_fail_without_signature_searches() {
        let bytes = fixture(true, true, 1, b"0301");
        for length in 0..bytes.len() {
            assert_ne!(
                inspect(bytes[..length].to_vec()).status,
                "available",
                "length={length}"
            );
        }
        let mut escaped_jpeg = jpeg(&bytes);
        // All TIFF bytes still exist in the file, but the APP1 no longer owns them.
        put16(&mut escaped_jpeg, 4, (bytes.len() + 8 - 16) as u16, false);
        assert_eq!(inspect(escaped_jpeg).status, "unsupported");
        let mut escaped_maker = bytes.clone();
        escaped_maker.extend_from_slice(&[0; 256]);
        put32(&mut escaped_maker, AF_ENTRY + 8, 100, true);
        assert_eq!(inspect(escaped_maker).status, "unsupported");
        let mut fake = b"unrelated payload Nikon\0\x02\x10\0\0".to_vec();
        fake.extend_from_slice(&bytes);
        assert_eq!(inspect(fake).status, "unsupported");
    }

    #[test]
    fn invalid_field_types_cycles_duplicates_and_resource_limits_are_bounded() {
        for (offset, value) in [
            (8, 513),
            (2, 43),
            (24, 4),
            (EXIF_OFFSET + 4, 4),
            (AF_ENTRY + 2, 4),
        ] {
            let mut bytes = fixture(true, true, 1, b"0300");
            put16(&mut bytes, offset, value, true);
            assert_eq!(inspect(bytes).status, "unsupported");
        }
        for (offset, value) in [
            (42, 8),
            (42, u32::MAX),
            (EXIF_OFFSET + 6, u32::MAX),
            (AF_ENTRY + 4, u32::MAX),
            (AF_ENTRY + 8, u32::MAX),
        ] {
            let mut bytes = fixture(true, true, 1, b"0300");
            put32(&mut bytes, offset, value, true);
            assert_eq!(inspect(bytes).status, "unsupported");
        }
        let mut duplicate = fixture(true, true, 1, b"0300");
        put16(&mut duplicate, AF_ENTRY + 12, 0xb7, true);
        assert_eq!(inspect(duplicate).status, "unsupported");
        let mut many_segments = vec![0xff, 0xd8];
        for _ in 0..=MAX_JPEG_SEGMENTS {
            many_segments.extend_from_slice(&[0xff, 0xe0, 0, 2]);
        }
        many_segments.extend_from_slice(&[0xff, 0xd9]);
        assert_eq!(inspect(many_segments).status, "unsupported");
        let mut reader = Reader {
            input: Cursor::new(vec![0; (MAX_READ_BYTES + 1) as usize]),
            file: Span {
                start: 0,
                length: MAX_READ_BYTES + 1,
            },
            read_bytes: 0,
            directories: HashSet::new(),
        };
        assert!(reader.read(reader.file).is_err());
        assert!(Span {
            start: u64::MAX,
            length: 2
        }
        .part(1, 1)
        .is_err());
    }

    #[test]
    fn asset_focus_works_without_raw_rendering_and_does_not_apply_crop_or_write_original() {
        let temporary = tempfile::tempdir().unwrap();
        let original = fixture(true, true, 6, b"0301");
        let photo = temporary.path().join("metadata-only.nef");
        std::fs::write(&photo, &original).unwrap();
        let core = crate::Core::open(temporary.path().join("catalog")).unwrap();
        let asset = core.open_file(&photo).unwrap();
        assert_eq!(asset.availability, "unsupported");
        core.dispatch(
            "asset.crop",
            serde_json::json!({"id":asset.id,"x":0.0,"y":0.0,"width":0.5,"height":0.5}),
        )
        .unwrap();
        let info = core
            .dispatch("asset.focus", serde_json::json!({"id":asset.id}))
            .unwrap();
        assert_eq!(info["status"], "available");
        assert_eq!(info["coordinate_space"], "oriented_full_image");
        assert_eq!(info["regions"][0]["x"], 0.6);
        assert_eq!(info["regions"][0]["y"], 0.2);
        assert_eq!(info["image_width"], 300);
        assert_eq!(std::fs::read(&photo).unwrap(), original);
        std::fs::remove_file(photo).unwrap();
        assert!(core
            .dispatch("asset.focus", serde_json::json!({"id":asset.id}))
            .unwrap_err()
            .to_string()
            .contains("E_OFFLINE"));
    }

    #[cfg(unix)]
    #[test]
    fn asset_focus_rejects_an_original_replaced_with_an_external_symlink() {
        let temporary = tempfile::tempdir().unwrap();
        let photos = temporary.path().join("photos");
        std::fs::create_dir(&photos).unwrap();
        let original = fixture(true, true, 1, b"0300");
        let photo = photos.join("photo.nef");
        let outside = temporary.path().join("outside.nef");
        std::fs::write(&photo, &original).unwrap();
        std::fs::write(&outside, &original).unwrap();
        let core = crate::Core::open(temporary.path().join("catalog")).unwrap();
        let asset = core.open_file(&photo).unwrap();
        std::fs::remove_file(&photo).unwrap();
        std::os::unix::fs::symlink(&outside, &photo).unwrap();
        let error = core
            .dispatch("asset.focus", serde_json::json!({"id":asset.id}))
            .unwrap_err();
        assert!(error.to_string().contains("E_PATH"));
    }
}
