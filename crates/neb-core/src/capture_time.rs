//! Bounded capture-time extraction. Reads only the primary EXIF Original tags;
//! image pixels, MakerNotes, filesystem times and EXIF DateTime are not inputs.

use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use anyhow::{bail, ensure, Context, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

const MAX_READ_BYTES: u64 = 128 * 1024;
const MAX_IFD_ENTRIES: usize = 512;
const MAX_TOTAL_ENTRIES: usize = 1024;
const MAX_TAG_BYTES: u64 = 256;
const MAX_JPEG_SEGMENTS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureStatus {
    Available,
    Missing,
    Unsupported,
    Invalid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureTime {
    /// Camera wall-clock ISO datetime with nine fractional digits, without a
    /// timezone. An EXIF offset is preserved in metadata, never inferred.
    pub captured_at: String,
    pub metadata: BTreeMap<String, String>,
    pub status: CaptureStatus,
}

fn result(status: CaptureStatus, metadata: BTreeMap<String, String>) -> CaptureTime {
    CaptureTime {
        captured_at: String::new(),
        metadata,
        status,
    }
}

fn text(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\0' || c.is_ascii_whitespace())
}

fn legacy_text(value: &str, is_date: bool) -> String {
    let value = text(value);
    // Older catalog versions stored exif display_value output, which quoted
    // ASCII values and displayed DateTimeOriginal with dash date separators.
    let value = if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        text(&value[1..value.len() - 1])
    } else {
        value
    };
    let mut value = value.to_owned();
    if is_date && value.len() == 19 && value.as_bytes()[4] == b'-' && value.as_bytes()[7] == b'-' {
        value.replace_range(4..5, ":");
        value.replace_range(7..8, ":");
    }
    value
}

/// Reads only known Original aliases. A present but invalid DateTimeOriginal
/// must not fall back to EXIF DateTime, filesystem creation time, or indexing.
pub fn from_metadata(input: &BTreeMap<String, String>) -> CaptureTime {
    let mut metadata = BTreeMap::new();
    let mut conflict = false;
    for (canonical, aliases) in [
        ("Captured", ["Captured", "EXIF DateTimeOriginal"]),
        (
            "Capture Subsecond",
            ["Capture Subsecond", "EXIF SubSecTimeOriginal"],
        ),
        (
            "Capture Time Zone",
            ["Capture Time Zone", "EXIF OffsetTimeOriginal"],
        ),
    ] {
        let mut found: Option<String> = None;
        let mut alias_conflict = false;
        for alias in aliases {
            if let Some(value) = input.get(alias) {
                let value = legacy_text(value, canonical == "Captured");
                if found.as_ref().is_some_and(|previous| previous != &value) {
                    alias_conflict = true;
                }
                found.get_or_insert(value);
            }
        }
        if alias_conflict {
            if canonical == "Captured" {
                conflict = true;
            } else {
                continue;
            }
        }
        if let Some(value) = found {
            if canonical == "Captured" || !value.is_empty() {
                metadata.insert(canonical.to_owned(), value);
            }
        }
    }
    let Some(date) = metadata.get("Captured") else {
        return result(CaptureStatus::Missing, metadata);
    };
    let bytes = date.as_bytes();
    if conflict
        || bytes.len() != 19
        || ![4, 7].into_iter().all(|index| bytes[index] == b':')
        || bytes[10] != b' '
        || ![13, 16].into_iter().all(|index| bytes[index] == b':')
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [4, 7, 10, 13, 16].contains(&index) || byte.is_ascii_digit())
    {
        return result(CaptureStatus::Invalid, metadata);
    }
    let number = |start: usize, end: usize| date[start..end].parse::<u32>().ok();
    let datetime = number(0, 4)
        .and_then(|year| NaiveDate::from_ymd_opt(year as i32, number(5, 7)?, number(8, 10)?))
        .and_then(|day| day.and_hms_opt(number(11, 13)?, number(14, 16)?, number(17, 19)?));
    let Some(datetime) = datetime else {
        return result(CaptureStatus::Invalid, metadata);
    };
    // Year zero is a common EXIF placeholder, not a recorded shooting date.
    if date.starts_with("0000") {
        return result(CaptureStatus::Invalid, metadata);
    }
    let fraction = match metadata.get("Capture Subsecond").cloned() {
        None => "000000000".to_owned(),
        Some(value) if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
            let mut fraction: String = value.chars().take(9).collect();
            fraction.extend(std::iter::repeat_n('0', 9 - fraction.len()));
            fraction
        }
        Some(_) => {
            metadata.remove("Capture Subsecond");
            "000000000".to_owned()
        }
    };
    if let Some(offset) = metadata.get("Capture Time Zone") {
        let value = offset.as_bytes();
        if value.len() != 6
            || !matches!(value[0], b'+' | b'-')
            || value[3] != b':'
            || ![1, 2, 4, 5]
                .into_iter()
                .all(|index| value[index].is_ascii_digit())
            || offset[1..3].parse::<u32>().unwrap_or(24) > 23
            || offset[4..6].parse::<u32>().unwrap_or(60) > 59
        {
            metadata.remove("Capture Time Zone");
        }
    }
    CaptureTime {
        captured_at: format!("{}.{fraction}", datetime.format("%Y-%m-%dT%H:%M:%S")),
        metadata,
        status: CaptureStatus::Available,
    }
}

#[derive(Clone, Copy)]
struct Span {
    start: u64,
    length: u64,
}

impl Span {
    fn part(self, offset: u64, length: u64) -> Result<Self> {
        ensure!(
            offset
                .checked_add(length)
                .is_some_and(|end| end <= self.length),
            "E_DECODE: Capture metadata range is outside the source"
        );
        Ok(Self {
            start: self
                .start
                .checked_add(offset)
                .context("E_LIMIT: Capture metadata offset overflow")?,
            length,
        })
    }
}

struct MetadataReader<'a, R> {
    input: &'a mut R,
    read_bytes: u64,
}

impl<R: Read + Seek> MetadataReader<'_, R> {
    fn read(&mut self, span: Span) -> Result<Vec<u8>> {
        self.read_bytes = self
            .read_bytes
            .checked_add(span.length)
            .context("E_LIMIT: Capture metadata read overflow")?;
        ensure!(
            self.read_bytes <= MAX_READ_BYTES,
            "E_LIMIT: Capture metadata read budget exceeded"
        );
        let mut value = vec![0; usize::try_from(span.length)?];
        self.input.seek(SeekFrom::Start(span.start))?;
        self.input
            .read_exact(&mut value)
            .context("E_DECODE: Truncated capture metadata")?;
        Ok(value)
    }

    fn jpeg(&mut self, source: Span) -> Result<CaptureTime> {
        let mut offset = 2_u64;
        for _ in 0..MAX_JPEG_SEGMENTS {
            let marker = self.read(source.part(offset, 1)?)?[0];
            ensure!(marker == 0xff, "E_DECODE: Invalid JPEG metadata marker");
            offset += 1;
            let mut kind = 0xff;
            for _ in 0..32 {
                kind = self.read(source.part(offset, 1)?)?[0];
                offset += 1;
                if kind != 0xff {
                    break;
                }
            }
            ensure!(kind != 0xff, "E_LIMIT: Too much JPEG marker padding");
            if kind == 0xd9 {
                return Ok(result(CaptureStatus::Missing, BTreeMap::new()));
            }
            ensure!(
                kind != 0 && kind != 0xd8,
                "E_DECODE: Invalid JPEG metadata marker"
            );
            if kind == 0x01 || (0xd0..=0xd7).contains(&kind) {
                continue;
            }
            let size = self.read(source.part(offset, 2)?)?;
            let size = u64::from(u16::from_be_bytes([size[0], size[1]]));
            ensure!(size >= 2, "E_DECODE: Invalid JPEG metadata segment size");
            let payload = source.part(offset + 2, size - 2)?;
            if kind == 0xda {
                return Ok(result(CaptureStatus::Missing, BTreeMap::new()));
            }
            if kind == 0xe1 && payload.length >= 6 && self.read(payload.part(0, 6)?)? == b"Exif\0\0"
            {
                return self.tiff(payload.part(6, payload.length - 6)?);
            }
            offset = offset
                .checked_add(size)
                .context("E_LIMIT: JPEG metadata offset overflow")?;
        }
        bail!("E_LIMIT: Too many JPEG metadata segments")
    }

    fn tiff(&mut self, source: Span) -> Result<CaptureTime> {
        let header = self.read(source.part(0, 8)?)?;
        let little = match &header[..2] {
            b"II" => true,
            b"MM" => false,
            _ => return Ok(result(CaptureStatus::Unsupported, BTreeMap::new())),
        };
        let u16_at = |bytes: &[u8]| {
            let value = [bytes[0], bytes[1]];
            if little {
                u16::from_le_bytes(value)
            } else {
                u16::from_be_bytes(value)
            }
        };
        let u32_at = |bytes: &[u8]| {
            let value = [bytes[0], bytes[1], bytes[2], bytes[3]];
            if little {
                u32::from_le_bytes(value)
            } else {
                u32::from_be_bytes(value)
            }
        };
        if u16_at(&header[2..]) != 42 {
            return Ok(result(CaptureStatus::Unsupported, BTreeMap::new()));
        }
        let mut offset = u64::from(u32_at(&header[4..]));
        if offset == 0 {
            return Ok(result(CaptureStatus::Missing, BTreeMap::new()));
        }
        let mut visited = HashSet::new();
        let mut total_entries = 0;
        let mut metadata = BTreeMap::new();
        let mut invalid = false;
        let mut invalid_optional = HashSet::new();
        // Only primary IFD0 -> ExifIFD is relevant. Thumbnail/subimage IFDs
        // cannot supply the original photograph's shooting time.
        for is_exif in [false, true] {
            ensure!(
                offset >= 8 && visited.insert(offset),
                "E_DECODE: Invalid or repeated capture metadata directory"
            );
            let count = self.read(source.part(offset, 2)?)?;
            let count = usize::from(u16_at(&count));
            ensure!(
                count <= MAX_IFD_ENTRIES,
                "E_LIMIT: Capture metadata directory entry limit exceeded"
            );
            total_entries += count;
            ensure!(
                total_entries <= MAX_TOTAL_ENTRIES,
                "E_LIMIT: Capture metadata total entry limit exceeded"
            );
            let directory = self.read(source.part(offset + 2, (count * 12 + 4) as u64)?)?;
            let mut pointer = None;
            for entry in directory[..count * 12].as_chunks::<12>().0 {
                let tag = u16_at(entry);
                let kind = u16_at(&entry[2..]);
                let count = u64::from(u32_at(&entry[4..]));
                if !is_exif && tag == 0x8769 {
                    ensure!(
                        kind == 4 && count == 1,
                        "E_DECODE: Invalid EXIF directory pointer"
                    );
                    let value = u64::from(u32_at(&entry[8..]));
                    ensure!(
                        pointer.is_none_or(|previous| previous == value),
                        "E_DECODE: Conflicting EXIF directory pointers"
                    );
                    pointer = Some(value);
                    continue;
                }
                if !is_exif {
                    continue;
                }
                let key = match tag {
                    0x9003 => "Captured",
                    0x9011 => "Capture Time Zone",
                    0x9291 => "Capture Subsecond",
                    _ => continue,
                };
                if kind != 2 || count == 0 {
                    if key == "Captured" {
                        invalid = true;
                    } else {
                        invalid_optional.insert(key);
                    }
                    continue;
                }
                ensure!(
                    count <= MAX_TAG_BYTES,
                    "E_LIMIT: Capture metadata text field limit exceeded"
                );
                let value = if count <= 4 {
                    entry[8..8 + count as usize].to_vec()
                } else {
                    self.read(source.part(u64::from(u32_at(&entry[8..])), count)?)?
                };
                match std::str::from_utf8(&value) {
                    Ok(value) if value.is_ascii() => {
                        let value = text(value).to_owned();
                        if metadata.get(key).is_some_and(|previous| previous != &value) {
                            if key == "Captured" {
                                invalid = true;
                            } else {
                                invalid_optional.insert(key);
                            }
                        }
                        metadata.entry(key.to_owned()).or_insert(value);
                    }
                    _ => {
                        if key == "Captured" {
                            invalid = true;
                        } else {
                            invalid_optional.insert(key);
                        }
                    }
                }
            }
            if !is_exif {
                let Some(next) = pointer.filter(|value| *value != 0) else {
                    return Ok(result(CaptureStatus::Missing, metadata));
                };
                offset = next;
            }
        }
        for key in invalid_optional {
            metadata.remove(key);
        }
        let mut captured = from_metadata(&metadata);
        if invalid {
            captured.status = CaptureStatus::Invalid;
            captured.captured_at.clear();
        }
        Ok(captured)
    }
}

/// Reads JPEG APP1 or classic TIFF EXIF independently of previews/decoders.
/// The caller supplies the actual accessible length. Out-of-range pointers,
/// transport failures and exhausted limits are errors, not a missing tag.
pub fn read<R: Read + Seek>(input: &mut R, length: u64) -> Result<CaptureTime> {
    let source = Span { start: 0, length };
    let mut reader = MetadataReader {
        input,
        read_bytes: 0,
    };
    let signature = reader.read(source.part(0, length.min(4))?)?;
    if signature.starts_with(&[0xff, 0xd8]) {
        reader.jpeg(source)
    } else if signature.starts_with(b"II") || signature.starts_with(b"MM") {
        reader.tiff(source)
    } else {
        Ok(result(CaptureStatus::Unsupported, BTreeMap::new()))
    }
}

/// Local counterpart with the same byte and structure limits; no pixels decode.
pub fn read_path(path: &Path) -> Result<CaptureTime> {
    let mut input = File::open(path)?;
    let length = input.metadata()?.len();
    read(&mut input, length)
}
