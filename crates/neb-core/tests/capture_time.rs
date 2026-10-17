use neb_core::capture_time::{self, CaptureStatus};
use std::{
    collections::BTreeMap,
    io::{self, Cursor, Read, Seek, SeekFrom},
};

fn metadata(values: &[(&str, &str)]) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn u16_bytes(value: u16, little: bool) -> [u8; 2] {
    if little {
        value.to_le_bytes()
    } else {
        value.to_be_bytes()
    }
}
fn u32_bytes(value: u32, little: bool) -> [u8; 4] {
    if little {
        value.to_le_bytes()
    } else {
        value.to_be_bytes()
    }
}
fn tiff(little: bool, fields: &[(u16, &[u8])]) -> Vec<u8> {
    let exif_offset = 26;
    let values_offset = exif_offset + 2 + 12 * fields.len() + 4;
    let mut bytes = vec![0; values_offset];
    bytes[..2].copy_from_slice(if little { b"II" } else { b"MM" });
    bytes[2..4].copy_from_slice(&u16_bytes(42, little));
    bytes[4..8].copy_from_slice(&u32_bytes(8, little));
    bytes[8..10].copy_from_slice(&u16_bytes(1, little));
    bytes[10..12].copy_from_slice(&u16_bytes(0x8769, little));
    bytes[12..14].copy_from_slice(&u16_bytes(4, little));
    bytes[14..18].copy_from_slice(&u32_bytes(1, little));
    bytes[18..22].copy_from_slice(&u32_bytes(exif_offset as u32, little));
    bytes[exif_offset..exif_offset + 2].copy_from_slice(&u16_bytes(fields.len() as u16, little));
    for (index, (tag, value)) in fields.iter().enumerate() {
        let start = exif_offset + 2 + index * 12;
        bytes[start..start + 2].copy_from_slice(&u16_bytes(*tag, little));
        bytes[start + 2..start + 4].copy_from_slice(&u16_bytes(2, little));
        bytes[start + 4..start + 8].copy_from_slice(&u32_bytes(value.len() as u32, little));
        if value.len() <= 4 {
            bytes[start + 8..start + 8 + value.len()].copy_from_slice(value);
        } else {
            let offset = bytes.len() as u32;
            bytes[start + 8..start + 12].copy_from_slice(&u32_bytes(offset, little));
            bytes.extend_from_slice(value);
        }
    }
    bytes
}
fn jpeg(tiff: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
    bytes.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
    bytes.extend_from_slice(b"Exif\0\0");
    bytes.extend_from_slice(tiff);
    // No valid JPEG pixels are needed to read its EXIF capture time.
    bytes.extend_from_slice(&[0xff, 0xda, 0, 2, 1, 2, 3]);
    bytes
}
fn read(bytes: Vec<u8>) -> anyhow::Result<capture_time::CaptureTime> {
    let length = bytes.len() as u64;
    capture_time::read(&mut Cursor::new(bytes), length)
}

#[test]
fn shooting_time_preserves_wallclock_subseconds_and_explicit_offset() {
    let value = capture_time::from_metadata(&metadata(&[
        ("Captured", "2026:10:17 00:12:34"),
        ("Capture Subsecond", "00123456789"),
        ("Capture Time Zone", "+08:00"),
        ("Make", "Synthetic camera"),
    ]));
    assert_eq!(value.status, CaptureStatus::Available);
    assert_eq!(value.captured_at, "2026-10-17T00:12:34.001234567");
    assert_eq!(value.metadata["Capture Time Zone"], "+08:00");
    assert_eq!(value.metadata.len(), 3);
    let alias = capture_time::from_metadata(&metadata(&[
        ("EXIF DateTimeOriginal", "2026:10:17 00:12:34\0"),
        ("EXIF SubSecTimeOriginal", "5"),
        ("EXIF OffsetTimeOriginal", "-05:30"),
    ]));
    assert_eq!(alias.captured_at, "2026-10-17T00:12:34.500000000");
    assert_eq!(alias.metadata["Capture Subsecond"], "5");
    assert_eq!(alias.metadata["Capture Time Zone"], "-05:30");
}

#[test]
fn old_display_quoting_and_dash_dates_normalize_before_alias_comparison() {
    let value = capture_time::from_metadata(&metadata(&[
        ("Captured", "2026-10-17 00:12:34"),
        ("EXIF DateTimeOriginal", "\"2026:10:17 00:12:34\""),
        ("Capture Subsecond", "\"123\""),
        ("EXIF SubSecTimeOriginal", "123"),
        ("Capture Time Zone", "\"+08:00\""),
        ("EXIF OffsetTimeOriginal", "+08:00"),
    ]));
    assert_eq!(value.status, CaptureStatus::Available);
    assert_eq!(value.captured_at, "2026-10-17T00:12:34.123000000");
    for date in ["\"2026-10-17 00:12:34", "2026-10-17 00:12:34\""] {
        assert_eq!(
            capture_time::from_metadata(&metadata(&[("Captured", date)])).status,
            CaptureStatus::Invalid
        );
    }
}

#[test]
fn modification_and_filesystem_times_never_fill_missing_shooting_time() {
    let value = capture_time::from_metadata(&metadata(&[
        ("EXIF DateTime", "2026:10:17 00:12:34"),
        ("Created", "2026-10-17T00:12:34Z"),
        ("Modified", "2026-10-17T00:12:34Z"),
    ]));
    assert_eq!(value.status, CaptureStatus::Missing);
    assert!(value.captured_at.is_empty());
    assert!(value.metadata.is_empty());
    for date in [
        "",
        "0000:00:00 00:00:00",
        "2026:02:30 12:00:00",
        "2026:10:17 24:00:00",
        "2026:10:17 00:00:60",
        "2026:1:17 00:00:00",
        "2026-10-17T00:00:00Z",
        "2026:10:17 00:00:00; 2026:10:18 00:00:00",
    ] {
        let value = capture_time::from_metadata(&metadata(&[
            ("Captured", date),
            ("EXIF DateTime", "2026:10:17 00:12:34"),
        ]));
        assert_eq!(value.status, CaptureStatus::Invalid, "{date:?}");
        assert!(value.captured_at.is_empty());
    }
    let conflict = capture_time::from_metadata(&metadata(&[
        ("Captured", "2026:10:17 00:12:34"),
        ("EXIF DateTimeOriginal", "2026:10:18 00:12:34"),
    ]));
    assert_eq!(conflict.status, CaptureStatus::Invalid);
}

#[test]
fn optional_original_components_are_validated_without_timezone_inference() {
    let date = ("Captured", "2024:02:29 01:02:03");
    assert_eq!(
        capture_time::from_metadata(&metadata(&[date])).captured_at,
        "2024-02-29T01:02:03.000000000"
    );
    for fraction in ["", "-1", "1.5", "1\0x"] {
        let value =
            capture_time::from_metadata(&metadata(&[date, ("Capture Subsecond", fraction)]));
        assert_eq!(value.status, CaptureStatus::Available);
        assert_eq!(value.captured_at, "2024-02-29T01:02:03.000000000");
        assert!(!value.metadata.contains_key("Capture Subsecond"));
    }
    for offset in ["", "Z", "08:00", "+24:00", "+08:60", "+0800", "+０8:00"] {
        let value = capture_time::from_metadata(&metadata(&[date, ("Capture Time Zone", offset)]));
        assert_eq!(value.status, CaptureStatus::Available, "{offset}");
        assert_eq!(value.captured_at, "2024-02-29T01:02:03.000000000");
        assert!(!value.metadata.contains_key("Capture Time Zone"));
    }
    let value = read(tiff(
        true,
        &[
            (0x9003, b"2024:02:29 01:02:03\0"),
            (0x9291, b"not a fraction\0"),
            (0x9011, b"+24:00\0"),
        ],
    ))
    .unwrap();
    assert_eq!(value.captured_at, "2024-02-29T01:02:03.000000000");
    assert_eq!(value.status, CaptureStatus::Available);
    assert_eq!(value.metadata.len(), 1);
}

#[test]
fn jpeg_and_both_tiff_orders_need_no_embedded_preview_or_pixels() {
    for little in [false, true] {
        let bytes = tiff(
            little,
            &[
                (0x9003, b"2026:10:17 00:12:34\0"),
                (0x9291, b"123\0"),
                (0x9011, b"+08:00\0"),
                // Generic modification DateTime is irrelevant even when newer.
                (0x0132, b"2027:10:17 00:12:34\0"),
            ],
        );
        for bytes in [bytes.clone(), jpeg(&bytes)] {
            let value = read(bytes).unwrap();
            assert_eq!(value.status, CaptureStatus::Available);
            assert_eq!(value.captured_at, "2026-10-17T00:12:34.123000000");
            assert_eq!(value.metadata.len(), 3);
        }
    }
}

struct Metered {
    input: Cursor<Vec<u8>>,
    bytes: usize,
    fail_at: Option<u64>,
}
impl Read for Metered {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self
            .fail_at
            .is_some_and(|offset| self.input.position() >= offset)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "synthetic metadata transport failure",
            ));
        }
        let count = self.input.read(output)?;
        self.bytes += count;
        Ok(count)
    }
}
impl Seek for Metered {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.input.seek(position)
    }
}

#[test]
fn sparse_tiff_fields_and_large_jpeg_non_exif_segments_are_seeked_not_downloaded() {
    let mut bytes = tiff(true, &[(0x9003, b"2026:10:17 00:12:34\0")]);
    // Move the Original value near the end of a large raw-like container.
    bytes[36..40].copy_from_slice(&900_000_u32.to_le_bytes());
    bytes.resize(1_000_000, 0);
    bytes[900_000..900_020].copy_from_slice(b"2026:10:17 00:12:34\0");
    let mut reader = Metered {
        input: Cursor::new(bytes),
        bytes: 0,
        fail_at: None,
    };
    let value = capture_time::read(&mut reader, 1_000_000).unwrap();
    assert_eq!(value.status, CaptureStatus::Available);
    assert!(
        reader.bytes < 128,
        "only header, directories, and one tag are read"
    );

    let bytes = jpeg(&tiff(true, &[(0x9003, b"2026:10:17 00:12:34\0")]));
    let mut padded = vec![0xff, 0xd8, 0xff, 0xe2, 0xff, 0xff];
    padded.resize(65_539, 0);
    padded.extend_from_slice(&bytes[2..]);
    let length = padded.len() as u64;
    let mut reader = Metered {
        input: Cursor::new(padded),
        bytes: 0,
        fail_at: None,
    };
    assert_eq!(
        capture_time::read(&mut reader, length).unwrap().status,
        CaptureStatus::Available
    );
    assert!(reader.bytes < 256, "ICC/image payload is not read");
}

#[test]
fn unknown_and_absent_metadata_are_distinct_from_truncation_or_transport_errors() {
    assert_eq!(
        read(b"not an EXIF container".to_vec()).unwrap().status,
        CaptureStatus::Unsupported
    );
    let mut big_tiff = tiff(true, &[]);
    big_tiff[2..4].copy_from_slice(&43_u16.to_le_bytes());
    assert_eq!(read(big_tiff).unwrap().status, CaptureStatus::Unsupported);
    assert_eq!(
        read(tiff(true, &[])).unwrap().status,
        CaptureStatus::Missing
    );
    assert_eq!(
        read(vec![0xff, 0xd8, 0xff, 0xda, 0, 2]).unwrap().status,
        CaptureStatus::Missing
    );

    let bytes = tiff(true, &[(0x9003, b"2026:10:17 00:12:34\0")]);
    let truncated = bytes[..bytes.len() - 1].to_vec();
    assert!(read(truncated)
        .unwrap_err()
        .to_string()
        .contains("outside the source"));
    let prefix = bytes[..32].to_vec();
    assert!(
        read(prefix).is_err(),
        "a prefix unable to reach an EXIF directory stays pending"
    );
    let length = bytes.len() as u64;
    let mut reader = Metered {
        input: Cursor::new(bytes),
        bytes: 0,
        fail_at: Some(26),
    };
    let error = capture_time::read(&mut reader, length).unwrap_err();
    assert!(error.chain().any(|cause| cause
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == io::ErrorKind::PermissionDenied)));
}

#[test]
fn malformed_fields_are_invalid_and_structure_limits_are_errors() {
    let mut bytes = tiff(true, &[(0x9003, b"2026:10:17 00:12:34\0")]);
    bytes[30..32].copy_from_slice(&3_u16.to_le_bytes());
    assert_eq!(read(bytes).unwrap().status, CaptureStatus::Invalid);
    let bytes = tiff(
        true,
        &[
            (0x9003, b"2026:10:17 00:12:34\0"),
            (0x9003, b"2026:10:18 00:12:34\0"),
        ],
    );
    assert_eq!(read(bytes).unwrap().status, CaptureStatus::Invalid);
    let mut bytes = tiff(true, &[]);
    bytes[26..28].copy_from_slice(&513_u16.to_le_bytes());
    assert!(read(bytes).unwrap_err().to_string().starts_with("E_LIMIT:"));
    let mut bytes = tiff(true, &[]);
    bytes[18..22].copy_from_slice(&8_u32.to_le_bytes());
    assert!(read(bytes)
        .unwrap_err()
        .to_string()
        .starts_with("E_DECODE:"));
    let mut bytes = vec![0xff, 0xd8];
    for _ in 0..257 {
        bytes.extend_from_slice(&[0xff, 0xe0, 0, 2]);
    }
    bytes.extend_from_slice(&[0xff, 0xd9]);
    assert!(read(bytes).unwrap_err().to_string().starts_with("E_LIMIT:"));
}

#[test]
fn local_read_path_uses_same_exif_only_reader() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("synthetic.nef");
    std::fs::write(&path, tiff(true, &[(0x9003, b"2026:10:17 00:12:34\0")])).unwrap();
    assert_eq!(
        capture_time::read_path(&path).unwrap().captured_at,
        "2026-10-17T00:12:34.000000000"
    );
    assert!(capture_time::read_path(&directory.path().join("missing.nef")).is_err());
}
