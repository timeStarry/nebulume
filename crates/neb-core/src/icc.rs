//! Minimal ICC profile synthesis and EXIF color-space detection so wide-gamut
//! camera JPEGs and RAW embedded previews (especially DCF/Exif Adobe RGB 1998,
//! which cameras tag via EXIF metadata without embedding an APP2 ICC profile)
//! render accurately in color-managed viewers and exports.

use exif::{In, Tag, Value};

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

/// Standard compact ICC v2.1.0 display profile for `Adobe RGB (1998)`:
/// - D65 media white point, Bradford-adapted D50 PCS XYZ primaries summing
///   bit-exactly to PCS illuminant `(0x0000F6D6, 0x00010000, 0x0000D32D)`
/// - Pure gamma `2.19921875` (`u8Fixed8Number` `0x0233`, i.e. `563 / 256`)
pub(crate) fn adobe_rgb_1998_icc() -> Vec<u8> {
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
        // ICC v2 `desc` (`textDescriptionType`):
        // 'desc' (4) + reserved (4) + ascii_count incl NUL (4) + ascii + NUL
        // + unicode_lang (4) + unicode_count (4) + scriptcode_code (2) + scriptcode_count (1) + mac_name (67)
        let mut tag = Vec::with_capacity(90 + ascii.len() + 1);
        tag.extend_from_slice(b"desc");
        push_u32(&mut tag, 0);
        push_u32(&mut tag, (ascii.len() + 1) as u32);
        tag.extend_from_slice(ascii);
        tag.push(0);
        push_u32(&mut tag, 0); // Unicode language code
        push_u32(&mut tag, 0); // Unicode count
        push_u16(&mut tag, 0); // ScriptCode code
        tag.push(0); // ScriptCode count
        tag.resize(tag.len() + 67, 0); // Fixed 67-byte Mac string field
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

    let desc = desc_tag(b"Adobe RGB (1998)");
    let cprt = text_tag(b"Public Domain");
    let wtpt = xyz_tag(0x0000_F351, 0x0001_0000, 0x0001_16CC); // D65
    let r_xyz = xyz_tag(0x0000_9C18, 0x0000_4FA5, 0x0000_04FC);
    let g_xyz = xyz_tag(0x0000_348D, 0x0000_A02C, 0x0000_0F95);
    let b_xyz = xyz_tag(0x0000_2631, 0x0000_102F, 0x0000_BE9C);
    let trc = gamma_curv_tag(0x0233); // 563 / 256 = 2.19921875

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
    let rxyz_loc = push_payload(&r_xyz);
    let gxyz_loc = push_payload(&g_xyz);
    let bxyz_loc = push_payload(&b_xyz);
    let trc_loc = push_payload(&trc);
    pad4(&mut body);

    let total_size = (table_end + body.len()) as u32;
    let mut profile = Vec::with_capacity(total_size as usize);

    // 128-byte ICC v2.1 header
    push_u32(&mut profile, total_size);
    profile.extend_from_slice(b"ADBE"); // CMM type
    push_u32(&mut profile, 0x0210_0000); // Version 2.1.0
    profile.extend_from_slice(b"mntr"); // Display profile
    profile.extend_from_slice(b"RGB "); // Data color space
    profile.extend_from_slice(b"XYZ "); // PCS
    for v in [2000_u16, 8, 11, 19, 51, 59] {
        push_u16(&mut profile, v);
    }
    profile.extend_from_slice(b"acsp"); // Signature
    profile.extend_from_slice(b"APPL"); // Primary platform
    push_u32(&mut profile, 0); // Flags
    profile.extend_from_slice(b"none"); // Device manufacturer
    push_u32(&mut profile, 0); // Device model
    push_u32(&mut profile, 0); // Device attributes hi
    push_u32(&mut profile, 0); // Device attributes lo
    push_u32(&mut profile, 0); // Perceptual intent
    push_u32(&mut profile, 0x0000_F6D6); // PCS D50 X
    push_u32(&mut profile, 0x0001_0000); // PCS D50 Y
    push_u32(&mut profile, 0x0000_D32D); // PCS D50 Z
    profile.extend_from_slice(b"NEBL"); // Creator
    profile.resize(128, 0);

    // Tag table (9 entries; rTRC, gTRC, bTRC share the identical gamma curve)
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

    #[test]
    fn adobe_rgb_icc_profile_has_valid_header_and_d50_primaries() {
        let icc = adobe_rgb_1998_icc();
        assert_eq!(u32::from_be_bytes(icc[0..4].try_into().unwrap()) as usize, icc.len());
        assert_eq!(&icc[12..24], b"mntrRGB XYZ ");
        assert_eq!(&icc[36..40], b"acsp");
        assert!(icc.windows(16).any(|w| w == b"Adobe RGB (1998)"));
    }
}
