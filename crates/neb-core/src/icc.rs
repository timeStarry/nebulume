//! Minimal ICC profile synthesis, gamut detection, and linear-light RGB gamut
//! conversion so wide-gamut camera JPEGs, HEICs, and RAW previews render and
//! export accurately across sRGB, Display P3, and Adobe RGB (1998).

use exif::{In, Tag, Value};
use image::RgbImage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KnownGamut {
    Srgb,
    DisplayP3,
    AdobeRgb,
}

/// Returns `true` when EXIF metadata declares Adobe RGB (1998) via any of the
/// three standard camera conventions:
/// 1. `ColorSpace == 2` (Nikon / Sony / Fujifilm / Adobe convention)
/// 2. `InteroperabilityIndex == "R03"` (JEITA CP-3451 / DCF Adobe RGB standard,
///    typically paired with `ColorSpace == 0xFFFF` Uncalibrated)
/// 3. `PrimaryChromaticities` matching Adobe RGB `(0.64, 0.33), (0.21, 0.71), (0.15, 0.06)`
pub(crate) fn is_adobe_rgb_exif(exif: &exif::Exif) -> bool {
    if exif
        .get_field(Tag::ColorSpace, In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        == Some(2)
    {
        return true;
    }

    for field in exif.fields() {
        if field.tag == Tag::InteroperabilityIndex {
            if let Value::Ascii(values) = &field.value {
                if values.iter().any(|bytes| {
                    let text = std::str::from_utf8(bytes)
                        .unwrap_or_default()
                        .trim_matches(|c: char| c == '\0' || c.is_ascii_whitespace());
                    text.eq_ignore_ascii_case("R03")
                }) {
                    return true;
                }
            }
        }
    }

    if let Some(field) = exif.get_field(Tag::PrimaryChromaticities, In::PRIMARY) {
        if let Value::Rational(values) = &field.value {
            if values.len() >= 6 && values.iter().take(6).all(|r| r.denom != 0) {
                let coords: Vec<f64> = values
                    .iter()
                    .take(6)
                    .map(|r| f64::from(r.num) / f64::from(r.denom))
                    .collect();
                let target = [0.64, 0.33, 0.21, 0.71, 0.15, 0.06];
                if coords
                    .iter()
                    .zip(target)
                    .all(|(actual, expected)| (actual - expected).abs() < 0.008)
                {
                    return true;
                }
            }
        }
    }

    false
}

/// Inspect an embedded ICC profile byte slice to identify common photography color spaces.
pub(crate) fn detect_gamut(icc: Option<&[u8]>) -> Option<KnownGamut> {
    let Some(bytes) = icc else {
        return Some(KnownGamut::Srgb);
    };
    let contains_ascii = |needle: &[u8]| {
        bytes
            .windows(needle.len())
            .any(|w| w.eq_ignore_ascii_case(needle))
    };
    // Also check UTF-16BE `mluc` strings used in ICC v4 profiles (e.g. Apple ImageIO Display P3).
    let contains_utf16be = |ascii: &[u8]| {
        let mut wide = Vec::with_capacity(ascii.len() * 2);
        for &b in ascii {
            wide.push(0);
            wide.push(b);
        }
        bytes.windows(wide.len()).any(|w| w == wide.as_slice())
    };
    let matches_name = |name: &[u8]| contains_ascii(name) || contains_utf16be(name);

    if matches_name(b"Adobe RGB") || matches_name(b"ClayRGB") {
        Some(KnownGamut::AdobeRgb)
    } else if matches_name(b"Display P3") || matches_name(b"DCI-P3") {
        Some(KnownGamut::DisplayP3)
    } else if matches_name(b"sRGB") || matches_name(b"IEC 61966") {
        Some(KnownGamut::Srgb)
    } else {
        None
    }
}

/// Convert an 8-bit `RgbImage` in-place between `Srgb`, `DisplayP3`, and `AdobeRgb`
/// using D65 linear-light 3x3 chromaticity matrices and exact transfer functions.
pub(crate) fn convert_rgb_image(rgb: &mut RgbImage, from: KnownGamut, to: KnownGamut) {
    if from == to {
        return;
    }
    let mut eotf = [0.0_f32; 256];
    for (i, slot) in eotf.iter_mut().enumerate() {
        let u = (i as f32) / 255.0;
        *slot = match from {
            KnownGamut::Srgb | KnownGamut::DisplayP3 => srgb_to_linear(u),
            KnownGamut::AdobeRgb => u.powf(563.0 / 256.0),
        };
    }

    let to_xyz = rgb_to_xyz_d65(from);
    let from_xyz = xyz_d65_to_rgb(to);
    let mat = mul3x3(from_xyz, to_xyz);

    for pixel in rgb.pixels_mut() {
        let r = eotf[pixel[0] as usize];
        let g = eotf[pixel[1] as usize];
        let b = eotf[pixel[2] as usize];

        let lr = (mat[0][0] * r + mat[0][1] * g + mat[0][2] * b).clamp(0.0, 1.0);
        let lg = (mat[1][0] * r + mat[1][1] * g + mat[1][2] * b).clamp(0.0, 1.0);
        let lb = (mat[2][0] * r + mat[2][1] * g + mat[2][2] * b).clamp(0.0, 1.0);

        let encode = |v: f32| -> u8 {
            let encoded = match to {
                KnownGamut::Srgb | KnownGamut::DisplayP3 => linear_to_srgb(v),
                KnownGamut::AdobeRgb => v.powf(256.0 / 563.0),
            };
            (encoded * 255.0 + 0.5).clamp(0.0, 255.0) as u8
        };
        pixel[0] = encode(lr);
        pixel[1] = encode(lg);
        pixel[2] = encode(lb);
    }
}

#[inline]
fn srgb_to_linear(u: f32) -> f32 {
    if u <= 0.04045 {
        u / 12.92
    } else {
        ((u + 0.055) / 1.055).powf(2.4)
    }
}

#[inline]
fn linear_to_srgb(l: f32) -> f32 {
    if l <= 0.003_130_8 {
        l * 12.92
    } else {
        1.055 * l.powf(1.0 / 2.4) - 0.055
    }
}

#[allow(clippy::excessive_precision)]
fn rgb_to_xyz_d65(gamut: KnownGamut) -> [[f32; 3]; 3] {
    match gamut {
        KnownGamut::Srgb => [
            [0.412_456_4, 0.357_576_1, 0.180_437_5],
            [0.212_672_9, 0.715_152_2, 0.072_175_0],
            [0.019_333_9, 0.119_192_0, 0.950_304_1],
        ],
        KnownGamut::DisplayP3 => [
            [0.486_570_9, 0.265_667_7, 0.198_217_3],
            [0.228_974_6, 0.691_738_5, 0.079_286_9],
            [0.000_000_0, 0.045_113_4, 1.043_944_4],
        ],
        KnownGamut::AdobeRgb => [
            [0.576_730_9, 0.185_554_0, 0.188_185_2],
            [0.297_376_9, 0.627_349_1, 0.075_274_1],
            [0.027_034_3, 0.070_687_2, 0.991_108_5],
        ],
    }
}

#[allow(clippy::excessive_precision)]
fn xyz_d65_to_rgb(gamut: KnownGamut) -> [[f32; 3]; 3] {
    match gamut {
        KnownGamut::Srgb => [
            [3.240_454_2, -1.537_138_5, -0.498_531_4],
            [-0.969_266_0, 1.876_010_8, 0.041_556_0],
            [0.055_643_4, -0.204_025_9, 1.057_225_2],
        ],
        KnownGamut::DisplayP3 => [
            [2.493_496_9, -0.931_383_6, -0.402_710_8],
            [-0.829_489_0, 1.762_664_1, 0.023_624_7],
            [0.035_845_8, -0.076_172_4, 0.956_884_5],
        ],
        KnownGamut::AdobeRgb => [
            [2.041_369_0, -0.564_946_4, -0.344_694_4],
            [-0.969_266_0, 1.876_010_8, 0.041_556_0],
            [0.013_447_4, -0.118_389_7, 1.015_409_6],
        ],
    }
}

fn mul3x3(a: [[f32; 3]; 3], b: [[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut out = [[0.0_f32; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
        }
    }
    out
}

/// Standard compact ICC v2.1.0 display profile for `Adobe RGB (1998)`.
pub(crate) fn adobe_rgb_1998_icc() -> Vec<u8> {
    build_icc_v2(
        b"Adobe RGB (1998)",
        (0x0000_9C18, 0x0000_4FA5, 0x0000_04FC),
        (0x0000_348D, 0x0000_A02C, 0x0000_0F95),
        (0x0000_2631, 0x0000_102F, 0x0000_BE9C),
        &gamma_curv_tag(0x0233),
    )
}

/// Standard compact ICC v2.1.0 display profile for `sRGB IEC61966-2.1`.
pub(crate) fn srgb_icc() -> Vec<u8> {
    build_icc_v2(
        b"sRGB IEC61966-2.1",
        (0x0000_6FA2, 0x0000_38F5, 0x0000_0390),
        (0x0000_6294, 0x0000_B785, 0x0000_18DA),
        (0x0000_24A0, 0x0000_0F86, 0x0000_B6C3),
        &srgb_curv_tag(),
    )
}

/// Standard compact ICC v2.1.0 display profile for `Display P3`.
pub(crate) fn display_p3_icc() -> Vec<u8> {
    build_icc_v2(
        b"Display P3",
        (0x0000_83D6, 0x0000_3D6E, 0x0000_0000),
        (0x0000_4AD8, 0x0000_B11D, 0x0000_0AD4),
        (0x0000_2828, 0x0000_1175, 0x0000_C859),
        &srgb_curv_tag(),
    )
}

fn push_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn pad4(out: &mut Vec<u8>) {
    while !out.len().is_multiple_of(4) {
        out.push(0);
    }
}
fn xyz_tag(x: u32, y: u32, z: u32) -> Vec<u8> {
    let mut tag = Vec::with_capacity(20);
    tag.extend_from_slice(b"XYZ ");
    push_u32(&mut tag, 0);
    push_u32(&mut tag, x);
    push_u32(&mut tag, y);
    push_u32(&mut tag, z);
    tag
}
fn desc_tag(ascii: &[u8]) -> Vec<u8> {
    let mut tag = Vec::with_capacity(90 + ascii.len() + 1);
    tag.extend_from_slice(b"desc");
    push_u32(&mut tag, 0);
    push_u32(&mut tag, (ascii.len() + 1) as u32);
    tag.extend_from_slice(ascii);
    tag.push(0);
    push_u32(&mut tag, 0);
    push_u32(&mut tag, 0);
    push_u16(&mut tag, 0);
    tag.push(0);
    tag.resize(tag.len() + 67, 0);
    tag
}
fn text_tag(ascii: &[u8]) -> Vec<u8> {
    let mut tag = Vec::with_capacity(8 + ascii.len() + 1);
    tag.extend_from_slice(b"text");
    push_u32(&mut tag, 0);
    tag.extend_from_slice(ascii);
    tag.push(0);
    tag
}
fn gamma_curv_tag(gamma_u8f8: u16) -> Vec<u8> {
    let mut tag = Vec::with_capacity(14);
    tag.extend_from_slice(b"curv");
    push_u32(&mut tag, 0);
    push_u32(&mut tag, 1);
    push_u16(&mut tag, gamma_u8f8);
    tag
}
fn srgb_curv_tag() -> Vec<u8> {
    const N: u32 = 1024;
    let mut tag = Vec::with_capacity(12 + (N as usize) * 2);
    tag.extend_from_slice(b"curv");
    push_u32(&mut tag, 0);
    push_u32(&mut tag, N);
    for i in 0..N {
        let u = (i as f32) / ((N - 1) as f32);
        let lin = srgb_to_linear(u);
        let q = (lin * 65535.0 + 0.5).clamp(0.0, 65535.0) as u16;
        push_u16(&mut tag, q);
    }
    tag
}

fn build_icc_v2(
    description: &[u8],
    r_xyz: (u32, u32, u32),
    g_xyz: (u32, u32, u32),
    b_xyz: (u32, u32, u32),
    trc: &[u8],
) -> Vec<u8> {
    let desc = desc_tag(description);
    let cprt = text_tag(b"Public Domain");
    let wtpt = xyz_tag(0x0000_F351, 0x0001_0000, 0x0001_16CC); // D65
    let r_tag = xyz_tag(r_xyz.0, r_xyz.1, r_xyz.2);
    let g_tag = xyz_tag(g_xyz.0, g_xyz.1, g_xyz.2);
    let b_tag = xyz_tag(b_xyz.0, b_xyz.1, b_xyz.2);

    let tag_count: u32 = 9;
    let table_end = 128 + 4 + (tag_count as usize) * 12;
    let mut body = Vec::new();
    let mut push_payload = |payload: &[u8]| -> (u32, u32) {
        pad4(&mut body);
        let offset = (table_end + body.len()) as u32;
        let size = payload.len() as u32;
        body.extend_from_slice(payload);
        (offset, size)
    };

    let desc_loc = push_payload(&desc);
    let cprt_loc = push_payload(&cprt);
    let wtpt_loc = push_payload(&wtpt);
    let rxyz_loc = push_payload(&r_tag);
    let gxyz_loc = push_payload(&g_tag);
    let bxyz_loc = push_payload(&b_tag);
    let trc_loc = push_payload(trc);
    pad4(&mut body);

    let total_size = (table_end + body.len()) as u32;
    let mut profile = Vec::with_capacity(total_size as usize);

    push_u32(&mut profile, total_size);
    profile.extend_from_slice(b"ADBE");
    push_u32(&mut profile, 0x0210_0000);
    profile.extend_from_slice(b"mntr");
    profile.extend_from_slice(b"RGB ");
    profile.extend_from_slice(b"XYZ ");
    for v in [2000_u16, 8, 11, 19, 51, 59] {
        push_u16(&mut profile, v);
    }
    profile.extend_from_slice(b"acsp");
    profile.extend_from_slice(b"APPL");
    push_u32(&mut profile, 0);
    profile.extend_from_slice(b"none");
    push_u32(&mut profile, 0);
    push_u32(&mut profile, 0);
    push_u32(&mut profile, 0);
    push_u32(&mut profile, 0);
    push_u32(&mut profile, 0x0000_F6D6);
    push_u32(&mut profile, 0x0001_0000);
    push_u32(&mut profile, 0x0000_D32D);
    profile.extend_from_slice(b"NEBL");
    profile.resize(128, 0);

    push_u32(&mut profile, tag_count);
    for (sig, (offset, size)) in [
        (*b"desc", desc_loc),
        (*b"cprt", cprt_loc),
        (*b"wtpt", wtpt_loc),
        (*b"rXYZ", rxyz_loc),
        (*b"gXYZ", gxyz_loc),
        (*b"bXYZ", bxyz_loc),
        (*b"rTRC", trc_loc),
        (*b"gTRC", trc_loc),
        (*b"bTRC", trc_loc),
    ] {
        profile.extend_from_slice(&sig);
        push_u32(&mut profile, offset);
        push_u32(&mut profile, size);
    }
    profile.extend_from_slice(&body);
    debug_assert_eq!(profile.len(), total_size as usize);
    profile
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn icc_profiles_have_valid_headers_and_roundtrip_detection() {
        for (icc, expected) in [
            (adobe_rgb_1998_icc(), KnownGamut::AdobeRgb),
            (srgb_icc(), KnownGamut::Srgb),
            (display_p3_icc(), KnownGamut::DisplayP3),
        ] {
            assert_eq!(
                u32::from_be_bytes(icc[0..4].try_into().unwrap()) as usize,
                icc.len()
            );
            assert_eq!(&icc[12..24], b"mntrRGB XYZ ");
            assert_eq!(&icc[36..40], b"acsp");
            assert_eq!(detect_gamut(Some(&icc)), Some(expected));
        }
    }

    #[test]
    fn gamut_conversion_preserves_neutrals_and_maps_saturated_primaries() {
        let mut img = RgbImage::from_fn(2, 1, |x, _| {
            if x == 0 {
                Rgb([128, 128, 128])
            } else {
                Rgb([40, 200, 60])
            }
        });
        convert_rgb_image(&mut img, KnownGamut::AdobeRgb, KnownGamut::Srgb);
        // Neutral grey adjusts for gamma difference (2.2 vs sRGB) while keeping R == G == B!
        let grey = img.get_pixel(0, 0);
        assert_eq!(grey[0], grey[1]);
        assert_eq!(grey[1], grey[2]);
        // Saturated AdobeRGB green boosts G relative to R/B when mapped into narrower sRGB primaries.
        let green = img.get_pixel(1, 0);
        assert!(green[1] > 200);
    }
}
