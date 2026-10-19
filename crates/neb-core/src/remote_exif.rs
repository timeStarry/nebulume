//! Selective classic-TIFF metadata reads for remote RAW previews. A TIFF-aware
//! container parser may read the entire RAW to reach EXIF; instead, collect only
//! bounded public fields from IFD0 and its ExifIFD, then parse a compact copy.

use std::{
    collections::HashSet,
    io::{Read, Seek, SeekFrom},
};

use anyhow::Result;
use exif::{Context, Exif, Tag};

const MAX_IFD_ENTRIES: usize = 512;
const MAX_FIELDS: usize = 256;
const MAX_FIELD_BYTES: u64 = 4 * 1024;
const MAX_READ_BYTES: u64 = 128 * 1024;

struct Field {
    tag: u16,
    kind: u16,
    count: u32,
    data: Vec<u8>,
}

struct Reader<'a, R> {
    input: &'a mut R,
    length: u64,
    read_bytes: u64,
    little: bool,
    fields: usize,
}

impl<R: Read + Seek> Reader<'_, R> {
    // Invalid optional metadata is omitted, but actual I/O failures must reach
    // the caller (including a range reader's transport/version/budget errors).
    fn read_at(&mut self, offset: u64, length: u64) -> Result<Option<Vec<u8>>> {
        if offset
            .checked_add(length)
            .is_none_or(|end| end > self.length)
            || length > MAX_READ_BYTES - self.read_bytes
        {
            return Ok(None);
        }
        self.read_bytes += length;
        let mut bytes = vec![0; length as usize];
        self.input.seek(SeekFrom::Start(offset))?;
        self.input.read_exact(&mut bytes)?;
        Ok(Some(bytes))
    }

    fn u16(&self, value: &[u8]) -> u16 {
        let value = [value[0], value[1]];
        if self.little {
            u16::from_le_bytes(value)
        } else {
            u16::from_be_bytes(value)
        }
    }

    fn u32(&self, value: &[u8]) -> u32 {
        let value = [value[0], value[1], value[2], value[3]];
        if self.little {
            u32::from_le_bytes(value)
        } else {
            u32::from_be_bytes(value)
        }
    }

    fn directory(&mut self, offset: u64, context: Context) -> Result<(Vec<Field>, Option<u64>)> {
        let mut fields = Vec::new();
        if offset < 8 {
            return Ok((fields, None));
        }
        let Some(count) = self.read_at(offset, 2)? else {
            return Ok((fields, None));
        };
        let count = usize::from(self.u16(&count));
        if count > MAX_IFD_ENTRIES {
            return Ok((fields, None));
        }
        let Some(entries) = self.read_at(offset + 2, (count * 12) as u64)? else {
            return Ok((fields, None));
        };
        let mut exif_offset = None;
        let mut conflicting_pointer = false;
        let mut tags = HashSet::new();
        for entry in entries.as_chunks::<12>().0 {
            let tag = self.u16(entry);
            let kind = self.u16(&entry[2..]);
            let count = self.u32(&entry[4..]);
            if context == Context::Tiff && tag == Tag::ExifIFDPointer.number() {
                if kind != 4 || count != 1 {
                    conflicting_pointer = true;
                    continue;
                }
                let value = u64::from(self.u32(&entry[8..]));
                if exif_offset.is_some_and(|previous| previous != value) {
                    conflicting_pointer = true;
                }
                exif_offset = Some(value);
                continue;
            }
            if self.fields == MAX_FIELDS || !public_field(context, tag) || !tags.insert(tag) {
                continue;
            }
            let unit = match kind {
                1 | 2 | 6 | 7 => 1,
                3 | 8 => 2,
                4 | 9 | 11 => 4,
                5 | 10 | 12 => 8,
                _ => continue,
            };
            let length = u64::from(count) * unit;
            if length == 0 || length > MAX_FIELD_BYTES {
                continue;
            }
            let data = if length <= 4 {
                entry[8..8 + length as usize].to_vec()
            } else {
                let offset = u64::from(self.u32(&entry[8..]));
                let Some(data) = self.read_at(offset, length)? else {
                    continue;
                };
                data
            };
            fields.push(Field {
                tag,
                kind,
                count,
                data,
            });
            self.fields += 1;
        }
        Ok((
            fields,
            (!conflicting_pointer).then_some(exif_offset).flatten(),
        ))
    }
}

fn public_field(context: Context, number: u16) -> bool {
    let tag = Tag(context, number);
    tag.description().is_some()
        && !matches!(
            tag,
            Tag::MakerNote
                | Tag::UserComment
                | Tag::ExifIFDPointer
                | Tag::GPSInfoIFDPointer
                | Tag::InteropIFDPointer
                | Tag::StripOffsets
                | Tag::StripByteCounts
                | Tag::TileOffsets
                | Tag::TileByteCounts
                | Tag::JPEGInterchangeFormat
                | Tag::JPEGInterchangeFormatLength
        )
}

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

fn write_directory(bytes: &mut Vec<u8>, offset: usize, fields: &[Field], little: bool) {
    put16(bytes, offset, fields.len() as u16, little);
    for (index, field) in fields.iter().enumerate() {
        let start = offset + 2 + index * 12;
        put16(bytes, start, field.tag, little);
        put16(bytes, start + 2, field.kind, little);
        put32(bytes, start + 4, field.count, little);
        if field.data.len() <= 4 {
            bytes[start + 8..start + 8 + field.data.len()].copy_from_slice(&field.data);
        } else {
            let data_offset = bytes.len();
            put32(bytes, start + 8, data_offset as u32, little);
            bytes.extend_from_slice(&field.data);
            if !bytes.len().is_multiple_of(2) {
                bytes.push(0);
            }
        }
    }
}

fn compact_tiff(mut primary: Vec<Field>, exif: Vec<Field>, little: bool) -> Vec<u8> {
    let exif_offset = 8 + 2 + (primary.len() + usize::from(!exif.is_empty())) * 12 + 4;
    if !exif.is_empty() {
        primary.push(Field {
            tag: Tag::ExifIFDPointer.number(),
            kind: 4,
            count: 1,
            data: if little {
                (exif_offset as u32).to_le_bytes()
            } else {
                (exif_offset as u32).to_be_bytes()
            }
            .to_vec(),
        });
    }
    let mut bytes = vec![
        0;
        exif_offset
            + if exif.is_empty() {
                0
            } else {
                2 + exif.len() * 12 + 4
            }
    ];
    bytes[..2].copy_from_slice(if little { b"II" } else { b"MM" });
    put16(&mut bytes, 2, 42, little);
    put32(&mut bytes, 4, 8, little);
    write_directory(&mut bytes, 8, &primary, little);
    if !exif.is_empty() {
        write_directory(&mut bytes, exif_offset, &exif, little);
    }
    bytes
}

/// Reads at most two bounded directory tables and bounded known field values.
/// Never follows image payloads, the next/thumbnail IFD, GPS or MakerNotes.
pub(crate) fn read<R: Read + Seek>(input: &mut R, length: u64) -> Result<Option<Exif>> {
    let mut reader = Reader {
        input,
        length,
        read_bytes: 0,
        little: true,
        fields: 0,
    };
    let Some(header) = reader.read_at(0, 8)? else {
        return Ok(None);
    };
    reader.little = match &header[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return Ok(None),
    };
    if reader.u16(&header[2..]) != 42 {
        return Ok(None);
    }
    let first = u64::from(reader.u32(&header[4..]));
    let (primary, pointer) = reader.directory(first, Context::Tiff)?;
    let exif = match pointer.filter(|offset| *offset != first) {
        Some(offset) => reader.directory(offset, Context::Exif)?.0,
        None => Vec::new(),
    };
    let data = compact_tiff(primary, exif, reader.little);
    Ok(exif::Reader::new()
        .continue_on_error(true)
        .read_raw(data)
        .or_else(|error| error.distill_partial_result(|_| {}))
        .ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn metadata_budget_stops_optional_field_reads_before_allocating_more() {
        let tags: Vec<_> = (0..=u16::MAX)
            .filter(|number| public_field(Context::Exif, *number))
            .collect();
        assert!(tags.len() > 32 && tags.len() <= MAX_IFD_ENTRIES);
        let mut bytes = vec![0; 32 * 1024];
        put16(&mut bytes, 8, tags.len() as u16, true);
        for (index, tag) in tags.iter().enumerate() {
            let start = 10 + index * 12;
            put16(&mut bytes, start, *tag, true);
            put16(&mut bytes, start + 2, 2, true);
            put32(&mut bytes, start + 4, MAX_FIELD_BYTES as u32, true);
            put32(&mut bytes, start + 8, 16 * 1024, true);
        }
        let mut input = Cursor::new(bytes);
        let mut reader = Reader {
            input: &mut input,
            length: 32 * 1024,
            read_bytes: 0,
            little: true,
            fields: 0,
        };
        let (fields, _) = reader.directory(8, Context::Exif).unwrap();
        assert!(!fields.is_empty() && fields.len() < tags.len());
        assert!(reader.read_bytes <= MAX_READ_BYTES);
        assert!(reader.read_bytes + MAX_FIELD_BYTES > MAX_READ_BYTES);
    }
}
