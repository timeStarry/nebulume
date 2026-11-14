//! Synthetic containers only: no camera image or private MakerNote fixture.

use super::*;
use crate::{imaging, PreviewTier};
use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};
use std::{fs, io::Cursor};

struct Entry(u16, u16, u32, Vec<u8>);

fn short(tag: u16, value: u16) -> Entry {
    Entry(tag, 3, 1, value.to_le_bytes().to_vec())
}

fn long(tag: u16, value: u32) -> Entry {
    Entry(tag, 4, 1, value.to_le_bytes().to_vec())
}

fn ascii(tag: u16, text: &str) -> Entry {
    let data = [text.as_bytes(), &[0]].concat();
    Entry(tag, 2, data.len() as u32, data)
}

fn directory(bytes: &mut Vec<u8>, mut entries: Vec<Entry>) -> u32 {
    entries.sort_by_key(|entry| entry.0);
    let offset = bytes.len();
    bytes.extend((entries.len() as u16).to_le_bytes());
    bytes.resize(offset + 2 + entries.len() * 12 + 4, 0);
    for (index, Entry(tag, kind, count, data)) in entries.into_iter().enumerate() {
        let start = offset + 2 + index * 12;
        bytes[start..start + 2].copy_from_slice(&tag.to_le_bytes());
        bytes[start + 2..start + 4].copy_from_slice(&kind.to_le_bytes());
        bytes[start + 4..start + 8].copy_from_slice(&count.to_le_bytes());
        if data.len() <= 4 {
            bytes[start + 8..start + 8 + data.len()].copy_from_slice(&data);
        } else {
            let pointer = bytes.len() as u32;
            bytes[start + 8..start + 12].copy_from_slice(&pointer.to_le_bytes());
            bytes.extend(data);
        }
    }
    offset as u32
}

fn fixture(compression: u16, modern_tag: bool) -> Vec<u8> {
    // The nested Nikon TIFF's offsets are relative to its own header.
    let mut nested = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
    let tag = if modern_tag {
        let mut value = vec![0; 12];
        value[10..12].copy_from_slice(&compression.to_le_bytes());
        Entry(0x51, 7, 12, value)
    } else {
        short(0x93, compression)
    };
    directory(&mut nested, vec![tag]);
    let note = [b"Nikon\0\x02\x11\0\0".as_slice(), &nested].concat();
    let mut bytes = b"II\x2a\x00\x00\x00\x00\x00".to_vec();
    let exif = directory(&mut bytes, vec![Entry(0x927c, 7, note.len() as u32, note)]);
    let mut jpeg = Vec::new();
    JpegEncoder::new(&mut jpeg)
        .encode_image(&RgbImage::from_pixel(8, 6, Rgb([50, 100, 160])))
        .unwrap();
    let jpeg_offset = bytes.len() as u32;
    bytes.extend(&jpeg);
    let pixels = bytes.len() as u32;
    bytes.extend([1000u16.to_le_bytes(); 48].concat());
    let root = directory(
        &mut bytes,
        vec![
            long(254, 0),
            long(256, 8),
            long(257, 6),
            short(258, 14),
            short(259, 1),
            ascii(271, "NIKON CORPORATION"),
            ascii(272, MODEL),
            long(273, pixels),
            short(274, 8),
            long(278, 6),
            long(279, 96),
            long(513, jpeg_offset),
            long(514, jpeg.len() as u32),
            Entry(33422, 1, 4, vec![0, 1, 1, 2]),
            long(34665, exif),
        ],
    );
    bytes[4..8].copy_from_slice(&root.to_le_bytes());
    bytes
}

fn metadata(bytes: &[u8]) -> exif::Exif {
    crate::remote_exif::read(&mut Cursor::new(bytes), bytes.len() as u64)
        .unwrap()
        .unwrap()
}

#[test]
fn shared_guard_decodes_local_and_memory_sources_from_a_small_stack() {
    std::thread::Builder::new().stack_size(1024 * 1024).spawn(|| {
        let bytes = fixture(2, true);
        let exif = metadata(&bytes);
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("synthetic.nef");
        fs::write(&path, &bytes).unwrap();
        for dummy in [true, false] {
            for raw in [decode_path(&path, &exif, dummy).unwrap(), decode_bytes(&bytes, &exif, dummy).unwrap()] {
                assert_eq!((raw.width, raw.height, raw.orientation.to_u16()), (8, 6, 8));
                if !dummy {
                    assert!(matches!(raw.data, rawloader::RawImageData::Integer(data) if data.len() == 48));
                }
            }
        }
        assert!(decode_bytes(b"damaged NEF", &exif, false).is_err());
        assert!(decode_bytes(&[], &exif, false).is_err());
        assert!(decoder_thread(|| panic!("synthetic decoder panic")).is_err());
    }).unwrap().join().unwrap();
}

#[test]
fn he_and_he_star_are_rejected_during_inspection_with_embedded_fallback() {
    for modern_tag in [true, false] {
        for (compression, mode) in [(13, "HighEfficency"), (14, "HighEfficencyStar")] {
            let bytes = fixture(compression, modern_tag);
            let exif = metadata(&bytes);
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("synthetic.nef");
            fs::write(&path, &bytes).unwrap();
            for dummy in [true, false] {
                for error in [
                    decode_path(&path, &exif, dummy).unwrap_err(),
                    decode_bytes(&bytes, &exif, dummy).unwrap_err(),
                ] {
                    assert!(format!("{error:#}").contains(mode), "{error:#}");
                }
            }
            let inspection = imaging::inspect(&path).unwrap();
            assert_eq!(inspection.metadata["Preview Source"], "embedded_jpeg");
            assert!(inspection.metadata["Decode Status"].contains(mode));
            assert!(!inspection.metadata["Decoder"].contains(DECODER));
            let preview =
                imaging::preview_with_options(&path, None, PreviewTier::P2560, false).unwrap();
            assert_eq!(preview.source, "embedded_jpeg");
            assert!(imaging::preview_with_options(&path, None, PreviewTier::P2560, true).is_err());
            let destination = temp.path().join("export.jpg");
            assert!(imaging::export(&path, None, &destination).is_err());
            assert!(!destination.exists());
            let (stream, _) =
                imaging::stream_preview_from_bytes(&bytes, "nef", None, PreviewTier::P2560, false)
                    .unwrap();
            assert_eq!(stream.source, "embedded_jpeg");
            assert!(stream.extras["inspection"]["metadata"]["Decode Status"]
                .as_str()
                .unwrap()
                .contains(mode));
            assert!(imaging::stream_preview_from_bytes(
                &bytes,
                "nef",
                None,
                PreviewTier::P2560,
                true
            )
            .is_err());
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }
}
