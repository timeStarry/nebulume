//! Modern Nikon support without changing the established decoder for other cameras.
//! Adapt only the verified Z5 II Bayer layout to the shared basic development path.

use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
};

use anyhow::{anyhow, ensure, Context, Result};
use exif::{In, Tag};
use rawler::{decoders::RawDecodeParams, imgop::xyz::Illuminant, rawsource::RawSource};

pub(crate) const MODEL: &str = "NIKON Z5_2";
pub(crate) const DECODER: &str = "rawler 0.8.0 · basic sensor rendering";

pub(crate) fn supports(exif: &exif::Exif) -> bool {
    let text = |tag| -> Option<&[u8]> {
        exif.get_field(tag, In::PRIMARY)
            .and_then(|field| match &field.value {
                exif::Value::Ascii(values) => values.first(),
                _ => None,
            })
            .map(|bytes| bytes.strip_suffix(&[0]).unwrap_or(bytes))
    };
    text(Tag::Make) == Some(b"NIKON CORPORATION") && text(Tag::Model) == Some(MODEL.as_bytes())
}

pub(crate) fn decode_path(path: &Path, dummy: bool) -> Result<rawloader::RawImage> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(super::imaging::MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    decode_bytes(&bytes, dummy)
}

pub(crate) fn decode_bytes(bytes: &[u8], dummy: bool) -> Result<rawloader::RawImage> {
    ensure!(
        !bytes.is_empty() && bytes.len() as u64 <= super::imaging::MAX_FILE_BYTES,
        "E_LIMIT: Nikon RAW exceeds the 512 MiB decode limit"
    );
    let exif = exif::Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut Cursor::new(bytes))
        .or_else(|error| error.distill_partial_result(|_| {}))?;
    ensure!(
        supports(&exif),
        "E_UNSUPPORTED_CODEC: Unverified Nikon camera"
    );
    let orientation = match exif.get_field(Tag::Orientation, In::PRIMARY) {
        Some(field) => field
            .value
            .get_uint(0)
            .filter(|value| (1..=8).contains(value))
            .context("E_DECODE: Invalid Nikon EXIF orientation")?,
        None => 1,
    };
    let source = RawSource::new_from_slice(bytes);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Validate dimensions before allocating the sensor plane, including the
        // in-memory path. A dummy decode must never become the displayed image.
        let header = rawler::decode_dummy(&source)
            .context("E_UNSUPPORTED_CODEC: Nikon RAW metadata decoding failed")?;
        validate(&header)?;
        let raw = if dummy {
            header
        } else {
            rawler::decode(&source, &RawDecodeParams::default())
                .context("E_UNSUPPORTED_CODEC: Nikon RAW sensor decoding failed")?
        };
        adapt(raw, orientation as u16)
    }))
    .map_err(|_| anyhow!("E_DECODE: Nikon RAW decoder rejected this file"))?
}

fn validate(raw: &rawler::RawImage) -> Result<()> {
    ensure!(
        raw.model == MODEL && raw.cpp == 1 && raw.camera.cfa.to_string() == "RGGB",
        "E_UNSUPPORTED_CODEC: Unverified Nikon sensor layout"
    );
    ensure!(
        raw.width > 0
            && raw.height > 0
            && (raw.width as u64)
                .checked_mul(raw.height as u64)
                .is_some_and(|pixels| pixels <= super::imaging::MAX_PIXELS),
        "E_LIMIT: Nikon RAW exceeds the 120 megapixel decode limit"
    );
    Ok(())
}

fn adapt(raw: rawler::RawImage, orientation: u16) -> Result<rawloader::RawImage> {
    validate(&raw)?;
    let mut crops = [0; 4];
    if let Some(area) = raw.crop_area.or(raw.active_area) {
        let right = area.p.x.checked_add(area.d.w);
        let bottom = area.p.y.checked_add(area.d.h);
        ensure!(
            area.d.w > 0
                && area.d.h > 0
                && right.is_some_and(|edge| edge <= raw.width)
                && bottom.is_some_and(|edge| edge <= raw.height),
            "E_DECODE: Invalid Nikon RAW crop area"
        );
        crops = [
            area.p.y,
            raw.width - right.unwrap(),
            raw.height - bottom.unwrap(),
            area.p.x,
        ];
    }
    let (_, matrix) = raw
        .color_matrix_find_first([Illuminant::D65])
        .context("E_UNSUPPORTED_CODEC: Nikon daylight color matrix is unavailable")?;
    ensure!(matrix.len() == 9, "E_DECODE: Invalid Nikon color matrix");
    let mut xyz_to_cam = [[0.0; 3]; 4];
    for (row, values) in matrix.as_chunks::<3>().0.iter().enumerate() {
        xyz_to_cam[row].copy_from_slice(values);
    }
    // rawler records black levels by CFA location; the shared developer indexes
    // them by RGB channel. RGGB has two green sites, whose levels are averaged.
    let black = raw.blacklevel.as_bayer_array();
    let white = raw.whitelevel.as_bayer_array();
    let levels = |spatial: [f32; 4]| -> Result<[u16; 4]> {
        ensure!(
            spatial
                .iter()
                .all(|n| n.is_finite() && (0.0..=65535.0).contains(n)),
            "E_DECODE: Invalid Nikon sensor levels"
        );
        Ok([
            spatial[0].round() as u16,
            ((spatial[1] + spatial[2]) / 2.0).round() as u16,
            spatial[3].round() as u16,
            spatial[3].round() as u16,
        ])
    };
    let whitelevels = levels(white)?;
    let blacklevels = levels(black)?;
    ensure!(
        whitelevels
            .iter()
            .zip(blacklevels)
            .all(|(white, black)| *white > black),
        "E_DECODE: Nikon white levels must exceed black levels"
    );
    Ok(rawloader::RawImage {
        make: raw.make,
        model: raw.model,
        clean_make: raw.clean_make,
        clean_model: raw.clean_model,
        width: raw.width,
        height: raw.height,
        cpp: raw.cpp,
        wb_coeffs: raw.wb_coeffs,
        whitelevels,
        blacklevels,
        xyz_to_cam,
        cfa: rawloader::CFA::new("RGGB"),
        crops,
        blackareas: Vec::new(),
        orientation: rawloader::Orientation::from_u16(orientation),
        data: match raw.data {
            rawler::RawImageData::Integer(data) => rawloader::RawImageData::Integer(data),
            rawler::RawImageData::Float(_) => {
                anyhow::bail!("E_UNSUPPORTED_CODEC: Unverified Nikon sample type")
            }
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rawler::{
        decoders::Camera,
        imgop::{Dim2, Point, Rect},
        rawimage::{
            BlackLevel, CFAConfig, RawImage, RawImageData, RawPhotometricInterpretation, WhiteLevel,
        },
    };

    fn fixture() -> RawImage {
        let mut camera = Camera::new();
        camera.make = "NIKON CORPORATION".into();
        camera.model = MODEL.into();
        camera.clean_make = "Nikon".into();
        camera.clean_model = "Z 5 II".into();
        camera.cfa = rawler::CFA::new("RGGB");
        camera.color_matrix.insert(
            Illuminant::D65,
            vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        );
        let photometric = RawPhotometricInterpretation::Cfa(CFAConfig::new_from_camera(&camera));
        RawImage::new_with_data(
            camera,
            RawImageData::Integer(vec![500; 48]),
            8,
            6,
            1,
            [2.0, 1.0, 1.5, f32::NAN],
            photometric,
            Some(BlackLevel::new(&[10_u16, 20, 40, 80], 2, 2, 1)),
            Some(WhiteLevel::new(vec![1000])),
            false,
        )
    }

    #[test]
    fn adapter_preserves_sensor_data_levels_matrix_crop_and_exif_orientation() {
        let mut input = fixture();
        input.crop_area = Some(Rect::new(Point::new(1, 2), Dim2::new(6, 3)));
        let raw = adapt(input, 8).unwrap();
        assert_eq!((raw.width, raw.height), (8, 6));
        assert_eq!(raw.crops, [2, 1, 1, 1]);
        assert_eq!(raw.blacklevels, [10, 30, 80, 80]);
        assert_eq!(raw.whitelevels, [1000; 4]);
        assert_eq!(raw.orientation.to_u16(), 8);
        assert_eq!(
            raw.xyz_to_cam,
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0; 3]]
        );
        assert!(
            matches!(raw.data, rawloader::RawImageData::Integer(data) if data == vec![500; 48])
        );
    }

    #[test]
    fn adapter_rejects_unverified_layouts_dimensions_and_corrupt_crop_or_levels() {
        let mut raw = fixture();
        raw.model = "NIKON Z 5".into();
        assert!(adapt(raw, 1).is_err());
        let mut raw = fixture();
        raw.cpp = 3;
        assert!(adapt(raw, 1).is_err());
        let mut raw = fixture();
        raw.camera.cfa = rawler::CFA::new("BGGR");
        assert!(adapt(raw, 1).is_err());
        for (width, height) in [(0, 6), (8, 0), (120_000_001, 1), (usize::MAX, 2)] {
            let mut raw = fixture();
            raw.width = width;
            raw.height = height;
            assert!(adapt(raw, 1).is_err());
        }
        for area in [
            Rect::new(Point::new(0, 0), Dim2::new(0, 6)),
            Rect::new(Point::new(7, 0), Dim2::new(2, 6)),
            Rect::new(Point::new(0, 5), Dim2::new(8, 2)),
            Rect::new(Point::new(usize::MAX, 0), Dim2::new(2, 6)),
        ] {
            let mut raw = fixture();
            raw.crop_area = Some(area);
            assert!(adapt(raw, 1).is_err());
        }
        let mut raw = fixture();
        raw.whitelevel = WhiteLevel::new(vec![70000]);
        assert!(adapt(raw, 1).is_err());
        let mut raw = fixture();
        raw.whitelevel = WhiteLevel::new(vec![20]);
        assert!(adapt(raw, 1).is_err());
        let mut raw = fixture();
        raw.color_matrix.clear();
        assert!(adapt(raw, 1).is_err());
        assert!(decode_bytes(b"damaged NEF", false).is_err());
        assert!(decode_bytes(&[], false).is_err());
    }
}
