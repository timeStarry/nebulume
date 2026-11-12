//! Non-destructive Adobe/Lightroom/Capture One compatible `.xmp` sidecar sync.
//!
//! Original image files are strictly read-only. Sidecar updates rewrite only
//! `<stem>.xmp` (or an existing companion `.xmp`) atomically while preserving
//! all third-party Camera Raw (`crs:*`), Dublin Core (`dc:*`), and history tags.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{bail, ensure, Context, Result};
use chrono::{SecondsFormat, Utc};
use quick_xml::{
    events::{BytesEnd, BytesStart, Event},
    Reader, Writer,
};

use crate::Crop;

/// Maximum `.xmp` packet size Nebulume will parse (2 MiB).
pub const MAX_XMP_BYTES: u64 = 2 * 1024 * 1024;

const NS_XMP: &str = "http://ns.adobe.com/xap/1.0/";
const NS_XMP_DM: &str = "http://ns.adobe.com/xmp/1.0/DynamicMedia/";
const NS_CRS: &str = "http://ns.adobe.com/camera-raw-settings/1.0/";
const NS_NEB: &str = "https://nebulume.app/ns/1.0/";

#[derive(Debug, Clone, PartialEq)]
pub struct SidecarData {
    pub path: PathBuf,
    pub rating: Option<u8>,
    pub flag: Option<String>,
    /// `Some(Some(crop))` when `crs:HasCrop="True"` with axis-aligned bounds,
    /// `Some(None)` when `crs:HasCrop="False"`, `None` when absent or rotated.
    pub crop: Option<Option<Crop>>,
    pub label: Option<String>,
}

/// Locate an existing sidecar beside `image_path` without following symlinks outside its folder.
pub fn find_sidecar_for_read(image_path: &Path) -> Option<PathBuf> {
    let parent = image_path.parent()?;
    let stem = image_path.file_stem()?.to_str()?;
    let filename = image_path.file_name()?.to_str()?;

    let exact_candidates = [
        format!("{stem}.xmp"),
        format!("{stem}.XMP"),
        format!("{filename}.xmp"),
        format!("{filename}.XMP"),
    ];
    for name in &exact_candidates {
        let candidate = parent.join(name);
        if is_regular_sidecar(&candidate) {
            return Some(candidate);
        }
    }

    let wanted_stem = format!("{}.xmp", stem.to_lowercase());
    let wanted_full = format!("{}.xmp", filename.to_lowercase());
    let entries = fs::read_dir(parent).ok()?;
    for entry in entries.flatten().take(10_000) {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_file() {
            continue;
        }
        let name = entry.file_name();
        let lower = name.to_string_lossy().to_lowercase();
        if lower == wanted_stem || lower == wanted_full {
            let path = entry.path();
            if is_regular_sidecar(&path) {
                return Some(path);
            }
        }
    }
    None
}

/// Target `.xmp` path for writing: reuse an existing sidecar filename if present, else `<stem>.xmp`.
pub fn sidecar_path_for_write(image_path: &Path) -> Result<PathBuf> {
    if let Some(existing) = find_sidecar_for_read(image_path) {
        return Ok(existing);
    }
    let parent = image_path
        .parent()
        .context("E_INVALID: Image path has no parent directory")?;
    let stem = image_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .context("E_INVALID: Image path has no valid file stem")?;
    Ok(parent.join(format!("{stem}.xmp")))
}

fn is_regular_sidecar(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .ok()
        .is_some_and(|meta| meta.file_type().is_file() && meta.len() <= MAX_XMP_BYTES)
}

/// Parse rating, pick/reject flag, label, and axis-aligned normalized crop from an image's `.xmp`.
pub fn read_sidecar_for_image(image_path: &Path) -> Result<Option<SidecarData>> {
    let Some(sidecar_path) = find_sidecar_for_read(image_path) else {
        return Ok(None);
    };
    let meta = fs::symlink_metadata(&sidecar_path)
        .context("E_IO: Cannot inspect XMP sidecar metadata")?;
    ensure!(
        meta.file_type().is_file(),
        "E_INVALID: XMP sidecar must be a regular file"
    );
    ensure!(
        meta.len() <= MAX_XMP_BYTES,
        "E_LIMIT: XMP sidecar exceeds 2 MiB limit"
    );
    let content = fs::read_to_string(&sidecar_path).context("E_IO: Cannot read XMP sidecar")?;
    let mut parsed = parse_xmp_str(&content)?;
    parsed.path = sidecar_path;
    Ok(Some(parsed))
}

pub fn parse_xmp_str(xml: &str) -> Result<SidecarData> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut raw_rating: Option<i32> = None;
    let mut neb_flag: Option<String> = None;
    let mut dm_pick: Option<i32> = None;
    let mut label: Option<String> = None;
    let mut has_crop: Option<bool> = None;
    let mut crop_left: Option<f64> = None;
    let mut crop_top: Option<f64> = None;
    let mut crop_right: Option<f64> = None;
    let mut crop_bottom: Option<f64> = None;
    let mut crop_angle: Option<f64> = None;

    let mut current_tag: Option<String> = None;

    let mut apply_kv = |key: &str, val: &str| {
        let local = local_prop_name(key);
        let v = val.trim();
        match local {
            ("xmp" | "", "Rating") => {
                if let Ok(n) = v.parse::<i32>() {
                    raw_rating = Some(n);
                }
            }
            ("neb", "Flag") => {
                if matches!(v, "none" | "pick" | "reject") {
                    neb_flag = Some(v.to_owned());
                }
            }
            ("xmpDM", "pick") => {
                if let Ok(n) = v.parse::<i32>() {
                    dm_pick = Some(n);
                }
            }
            ("xmp", "Label") => {
                if !v.is_empty() {
                    label = Some(v.to_owned());
                }
            }
            ("crs", "HasCrop") => {
                if v.eq_ignore_ascii_case("true") || v == "1" {
                    has_crop = Some(true);
                } else if v.eq_ignore_ascii_case("false") || v == "0" {
                    has_crop = Some(false);
                }
            }
            ("crs", "CropLeft") => crop_left = v.parse::<f64>().ok(),
            ("crs", "CropTop") => crop_top = v.parse::<f64>().ok(),
            ("crs", "CropRight") => crop_right = v.parse::<f64>().ok(),
            ("crs", "CropBottom") => crop_bottom = v.parse::<f64>().ok(),
            ("crs", "CropAngle") => crop_angle = v.parse::<f64>().ok(),
            _ => {}
        }
    };

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if is_rdf_description(&name) {
                    for attr in e.attributes().flatten() {
                        let k = String::from_utf8_lossy(attr.key.as_ref());
                        if let Ok(v) = attr.unescape_value() {
                            apply_kv(&k, &v);
                        }
                    }
                }
                current_tag = Some(name);
            }
            Ok(Event::Empty(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if is_rdf_description(&name) {
                    for attr in e.attributes().flatten() {
                        let k = String::from_utf8_lossy(attr.key.as_ref());
                        if let Ok(v) = attr.unescape_value() {
                            apply_kv(&k, &v);
                        }
                    }
                }
            }
            Ok(Event::Text(ref e)) => {
                if let Some(tag) = current_tag.as_deref() {
                    if let Ok(text) = e.unescape() {
                        apply_kv(tag, &text);
                    }
                }
            }
            Ok(Event::End(_)) => {
                current_tag = None;
            }
            Ok(Event::Eof) => break,
            Err(err) => bail!("E_INVALID: Malformed XMP XML: {err}"),
            _ => {}
        }
    }

    let mut rating = None;
    let mut flag = neb_flag;

    if let Some(r) = raw_rating {
        if r < 0 {
            rating = Some(0);
            if flag.is_none() {
                flag = Some("reject".into());
            }
        } else {
            rating = Some(r.clamp(0, 5) as u8);
        }
    }

    if flag.is_none() {
        if let Some(pick) = dm_pick {
            flag = Some(
                if pick > 0 {
                    "pick"
                } else if pick < 0 {
                    "reject"
                } else {
                    "none"
                }
                .into(),
            );
        }
    }

    let angle_zero = crop_angle.is_none_or(|a| a.is_finite() && a.abs() < 1e-4);
    let crop = match has_crop {
        Some(false) => Some(None),
        Some(true) if angle_zero => {
            if let (Some(l), Some(t), Some(r), Some(b)) =
                (crop_left, crop_top, crop_right, crop_bottom)
            {
                let candidate = Crop {
                    x: l,
                    y: t,
                    width: r - l,
                    height: b - t,
                };
                if candidate.validate().is_ok() {
                    if (candidate.x).abs() < 1e-6
                        && (candidate.y).abs() < 1e-6
                        && (candidate.width - 1.0).abs() < 1e-6
                        && (candidate.height - 1.0).abs() < 1e-6
                    {
                        Some(None)
                    } else {
                        Some(Some(candidate))
                    }
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    };

    Ok(SidecarData {
        path: PathBuf::new(),
        rating,
        flag,
        crop,
        label,
    })
}

/// Atomically write or update `<stem>.xmp` next to `image_path` while preserving third-party tags.
/// Returns `Ok(None)` when no sidecar existed and the asset has only default state (`0 / none / uncropped`).
pub fn write_sidecar_for_image(
    image_path: &Path,
    rating: u8,
    flag: &str,
    crop: Option<Crop>,
) -> Result<Option<PathBuf>> {
    ensure!(rating <= 5, "E_INVALID: Rating must be 0..=5");
    ensure!(
        matches!(flag, "none" | "pick" | "reject"),
        "E_INVALID: Flag must be none, pick or reject"
    );
    if let Some(c) = crop {
        c.validate()?;
    }

    let existing_path = find_sidecar_for_read(image_path);
    if existing_path.is_none() && rating == 0 && flag == "none" && crop.is_none() {
        return Ok(None);
    }

    let target_path = match &existing_path {
        Some(p) => p.clone(),
        None => sidecar_path_for_write(image_path)?,
    };
    let parent = target_path
        .parent()
        .context("E_INVALID: Sidecar target has no parent directory")?;
    ensure!(parent.is_dir(), "E_OFFLINE: Image folder is unavailable");

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let xml_bytes = if let Some(existing) = &existing_path {
        let meta =
            fs::symlink_metadata(existing).context("E_IO: Cannot inspect existing XMP sidecar")?;
        ensure!(
            meta.file_type().is_file(),
            "E_INVALID: Existing XMP sidecar is not a regular file"
        );
        ensure!(
            meta.len() <= MAX_XMP_BYTES,
            "E_LIMIT: Existing XMP sidecar exceeds 2 MiB limit"
        );
        let original_xml =
            fs::read_to_string(existing).context("E_IO: Cannot read existing XMP sidecar")?;
        merge_xmp_str(&original_xml, rating, flag, crop, &now)?
    } else {
        fresh_xmp_packet(rating, flag, crop, &now).into_bytes()
    };

    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .context("E_IO: Cannot create temporary XMP file")?;
    temp.write_all(&xml_bytes)
        .context("E_IO: Cannot write temporary XMP file")?;
    temp.as_file()
        .sync_all()
        .context("E_IO: Cannot sync temporary XMP file")?;
    temp.persist(&target_path)
        .map_err(|e| anyhow::anyhow!("E_IO: Cannot commit XMP sidecar: {}", e.error))?;
    Ok(Some(target_path))
}

pub fn merge_xmp_str(
    original_xml: &str,
    rating: u8,
    flag: &str,
    crop: Option<Crop>,
    metadata_date: &str,
) -> Result<Vec<u8>> {
    // Check whether the existing file has a rotated crop (`crs:CropAngle != 0`) that we must not clobber
    // when Nebulume's own crop is `None`.
    let preserve_existing_crop = crop.is_none() && has_non_zero_crop_angle(original_xml);

    let mut reader = Reader::from_str(original_xml);
    let mut writer = Writer::new(Vec::with_capacity(original_xml.len() + 512));

    let mut patched_description = false;
    let mut skip_depth: usize = 0;
    let mut declared_xmp = original_xml.contains("xmlns:xmp=");
    let mut declared_dm = original_xml.contains("xmlns:xmpDM=");
    let mut declared_crs = original_xml.contains("xmlns:crs=");
    let mut declared_neb = original_xml.contains("xmlns:neb=");

    loop {
        let event = reader
            .read_event()
            .map_err(|e| anyhow::anyhow!("E_INVALID: Existing XMP XML is malformed: {e}"))?;
        match event {
            Event::Eof => break,
            Event::Start(ref e) if skip_depth > 0 => {
                skip_depth += 1;
                let _ = e;
            }
            Event::End(_) if skip_depth > 0 => {
                skip_depth -= 1;
            }
            Event::Empty(_) | Event::Text(_) | Event::CData(_) if skip_depth > 0 => {}
            Event::Start(ref e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if is_managed_child_element(&name, preserve_existing_crop) {
                    skip_depth = 1;
                    continue;
                }
                if !patched_description && is_rdf_description(&name) {
                    let rebuilt = rebuild_description_tag(
                        e,
                        rating,
                        flag,
                        crop,
                        metadata_date,
                        preserve_existing_crop,
                        &mut declared_xmp,
                        &mut declared_dm,
                        &mut declared_crs,
                        &mut declared_neb,
                    )?;
                    writer.write_event(Event::Start(rebuilt))?;
                    patched_description = true;
                } else {
                    writer.write_event(Event::Start(e.clone()))?;
                }
            }
            Event::Empty(ref e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if is_managed_child_element(&name, preserve_existing_crop) {
                    continue;
                }
                if !patched_description && is_rdf_description(&name) {
                    let rebuilt = rebuild_description_tag(
                        e,
                        rating,
                        flag,
                        crop,
                        metadata_date,
                        preserve_existing_crop,
                        &mut declared_xmp,
                        &mut declared_dm,
                        &mut declared_crs,
                        &mut declared_neb,
                    )?;
                    writer.write_event(Event::Empty(rebuilt))?;
                    patched_description = true;
                } else {
                    writer.write_event(Event::Empty(e.clone()))?;
                }
            }
            Event::End(ref e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if !patched_description && name.ends_with("RDF") {
                    // `<rdf:RDF>` had no `<rdf:Description>` at all: inject one before `</rdf:RDF>`.
                    let mut desc = BytesStart::new("rdf:Description");
                    desc.push_attribute(("rdf:about", ""));
                    inject_managed_attributes(
                        &mut desc,
                        rating,
                        flag,
                        crop,
                        metadata_date,
                        true,
                        &mut declared_xmp,
                        &mut declared_dm,
                        &mut declared_crs,
                        &mut declared_neb,
                    );
                    writer.write_event(Event::Empty(desc))?;
                    patched_description = true;
                }
                writer.write_event(Event::End(BytesEnd::new(name)))?;
            }
            other => {
                writer.write_event(other)?;
            }
        }
    }

    if !patched_description {
        return Ok(fresh_xmp_packet(rating, flag, crop, metadata_date).into_bytes());
    }
    Ok(writer.into_inner())
}

#[allow(clippy::too_many_arguments)]
fn rebuild_description_tag(
    original: &BytesStart<'_>,
    rating: u8,
    flag: &str,
    crop: Option<Crop>,
    metadata_date: &str,
    preserve_existing_crop: bool,
    declared_xmp: &mut bool,
    declared_dm: &mut bool,
    declared_crs: &mut bool,
    declared_neb: &mut bool,
) -> Result<BytesStart<'static>> {
    let tag_name = String::from_utf8_lossy(original.name().as_ref()).into_owned();
    let mut rebuilt = BytesStart::new(tag_name);
    let mut had_has_crop = false;

    for attr in original.attributes() {
        let attr = attr.context("E_INVALID: Malformed XMP attribute")?;
        let key = String::from_utf8_lossy(attr.key.as_ref());
        if key == "crs:HasCrop" {
            had_has_crop = true;
        }
        if is_managed_attr(&key, preserve_existing_crop) {
            continue;
        }
        let val = attr
            .unescape_value()
            .context("E_INVALID: Malformed XMP attribute value")?;
        rebuilt.push_attribute((key.as_ref(), val.as_ref()));
    }

    inject_managed_attributes(
        &mut rebuilt,
        rating,
        flag,
        crop,
        metadata_date,
        !preserve_existing_crop && (crop.is_some() || had_has_crop),
        declared_xmp,
        declared_dm,
        declared_crs,
        declared_neb,
    );
    Ok(rebuilt)
}

#[allow(clippy::too_many_arguments)]
fn inject_managed_attributes(
    tag: &mut BytesStart<'_>,
    rating: u8,
    flag: &str,
    crop: Option<Crop>,
    metadata_date: &str,
    write_crop_attrs: bool,
    declared_xmp: &mut bool,
    declared_dm: &mut bool,
    declared_crs: &mut bool,
    declared_neb: &mut bool,
) {
    if !*declared_xmp {
        tag.push_attribute(("xmlns:xmp", NS_XMP));
        *declared_xmp = true;
    }
    if !*declared_dm {
        tag.push_attribute(("xmlns:xmpDM", NS_XMP_DM));
        *declared_dm = true;
    }
    if write_crop_attrs && !*declared_crs {
        tag.push_attribute(("xmlns:crs", NS_CRS));
        *declared_crs = true;
    }
    if !*declared_neb {
        tag.push_attribute(("xmlns:neb", NS_NEB));
        *declared_neb = true;
    }

    // Adobe Bridge / ACR / Photo Mechanic convention: unrated reject uses xmp:Rating="-1";
    // rated photos keep 1..5 while xmpDM:pick and neb:Flag carry exact pick/reject state.
    let xmp_rating = if flag == "reject" && rating == 0 {
        "-1".to_owned()
    } else {
        rating.to_string()
    };
    let dm_pick = match flag {
        "pick" => "1",
        "reject" => "-1",
        _ => "0",
    };

    tag.push_attribute(("xmp:Rating", xmp_rating.as_str()));
    tag.push_attribute(("xmp:MetadataDate", metadata_date));
    tag.push_attribute(("xmpDM:pick", dm_pick));
    tag.push_attribute(("neb:Flag", flag));

    if write_crop_attrs {
        if let Some(c) = crop {
            let left = format!("{:.6}", c.x);
            let top = format!("{:.6}", c.y);
            let right = format!("{:.6}", (c.x + c.width).min(1.0));
            let bottom = format!("{:.6}", (c.y + c.height).min(1.0));
            tag.push_attribute(("crs:HasCrop", "True"));
            tag.push_attribute(("crs:CropLeft", left.as_str()));
            tag.push_attribute(("crs:CropTop", top.as_str()));
            tag.push_attribute(("crs:CropRight", right.as_str()));
            tag.push_attribute(("crs:CropBottom", bottom.as_str()));
            tag.push_attribute(("crs:CropAngle", "0"));
        } else {
            tag.push_attribute(("crs:HasCrop", "False"));
        }
    }
}

fn fresh_xmp_packet(
    rating: u8,
    flag: &str,
    crop: Option<Crop>,
    metadata_date: &str,
) -> String {
    let xmp_rating = if flag == "reject" && rating == 0 {
        -1
    } else {
        rating as i32
    };
    let dm_pick = match flag {
        "pick" => 1,
        "reject" => -1,
        _ => 0,
    };
    let crop_attrs = if let Some(c) = crop {
        format!(
            "\n   xmlns:crs=\"{NS_CRS}\"\n   crs:HasCrop=\"True\"\n   crs:CropLeft=\"{:.6}\"\n   crs:CropTop=\"{:.6}\"\n   crs:CropRight=\"{:.6}\"\n   crs:CropBottom=\"{:.6}\"\n   crs:CropAngle=\"0\"",
            c.x,
            c.y,
            (c.x + c.width).min(1.0),
            (c.y + c.height).min(1.0)
        )
    } else {
        String::new()
    };

    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Nebulume\">\n\
 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
  <rdf:Description rdf:about=\"\"\n\
   xmlns:xmp=\"{NS_XMP}\"\n\
   xmlns:xmpDM=\"{NS_XMP_DM}\"\n\
   xmlns:neb=\"{NS_NEB}\"\n\
   xmp:Rating=\"{xmp_rating}\"\n\
   xmp:MetadataDate=\"{metadata_date}\"\n\
   xmpDM:pick=\"{dm_pick}\"\n\
   neb:Flag=\"{flag}\"{crop_attrs}/>\n\
 </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>\n"
    )
}

fn has_non_zero_crop_angle(xml: &str) -> bool {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut in_angle = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if is_rdf_description(&name) {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"crs:CropAngle" {
                            if let Ok(v) = attr.unescape_value() {
                                if v.trim().parse::<f64>().is_ok_and(|a| a.abs() >= 1e-4) {
                                    return true;
                                }
                            }
                        }
                    }
                }
                in_angle = local_prop_name(&name) == ("crs", "CropAngle");
            }
            Ok(Event::Empty(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if is_rdf_description(&name) {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"crs:CropAngle" {
                            if let Ok(v) = attr.unescape_value() {
                                if v.trim().parse::<f64>().is_ok_and(|a| a.abs() >= 1e-4) {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(ref e)) if in_angle => {
                if let Ok(t) = e.unescape() {
                    if t.trim().parse::<f64>().is_ok_and(|a| a.abs() >= 1e-4) {
                        return true;
                    }
                }
            }
            Ok(Event::End(_)) => in_angle = false,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    false
}

fn is_rdf_description(name: &str) -> bool {
    name == "rdf:Description" || name.ends_with(":Description")
}

fn local_prop_name(name: &str) -> (&str, &str) {
    match name.split_once(':') {
        Some((ns, prop)) => (ns, prop),
        None => ("", name),
    }
}

fn is_managed_attr(key: &str, preserve_existing_crop: bool) -> bool {
    if matches!(
        key,
        "xmp:Rating" | "xmp:MetadataDate" | "xmpDM:pick" | "neb:Flag"
    ) {
        return true;
    }
    if !preserve_existing_crop
        && matches!(
            key,
            "crs:HasCrop"
                | "crs:CropLeft"
                | "crs:CropTop"
                | "crs:CropRight"
                | "crs:CropBottom"
                | "crs:CropAngle"
        )
    {
        return true;
    }
    false
}

fn is_managed_child_element(name: &str, preserve_existing_crop: bool) -> bool {
    is_managed_attr(name, preserve_existing_crop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_camera_raw_and_dc_subject_tags_losslessly() {
        let lr_xmp = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmp:Rating="2"
    crs:Version="16.5"
    crs:Exposure2012="+0.85"
    crs:Contrast2012="+18"
    crs:Highlights2012="-45">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>Kyoto</rdf:li>
     <rdf:li>Editorial</rdf:li>
    </rdf:Bag>
   </dc:subject>
   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;

        let crop = Crop {
            x: 0.1,
            y: 0.2,
            width: 0.6,
            height: 0.5,
        };
        let merged = String::from_utf8(
            merge_xmp_str(lr_xmp, 5, "pick", Some(crop), "2026-11-12T14:00:00Z").unwrap(),
        )
        .unwrap();

        assert!(merged.contains(r#"crs:Exposure2012="+0.85""#));
        assert!(merged.contains(r#"crs:Contrast2012="+18""#));
        assert!(merged.contains(r#"crs:Highlights2012="-45""#));
        assert!(merged.contains("<rdf:li>Kyoto</rdf:li>"));
        assert!(merged.contains("<crs:ToneCurvePV2012>"));

        let parsed = parse_xmp_str(&merged).unwrap();
        assert_eq!(parsed.rating, Some(5));
        assert_eq!(parsed.flag.as_deref(), Some("pick"));
        let read_crop = parsed.crop.unwrap().unwrap();
        assert!((read_crop.x - 0.1).abs() < 1e-5);
        assert!((read_crop.y - 0.2).abs() < 1e-5);
        assert!((read_crop.width - 0.6).abs() < 1e-5);
        assert!((read_crop.height - 0.5).abs() < 1e-5);
    }

    #[test]
    fn negative_one_rating_maps_to_reject_and_preserves_rotated_crop_when_uncropped() {
        let rotated_xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmp:Rating="-1"
    crs:HasCrop="True"
    crs:CropLeft="0.1"
    crs:CropTop="0.1"
    crs:CropRight="0.9"
    crs:CropBottom="0.9"
    crs:CropAngle="4.25"/>
 </rdf:RDF>
</x:xmpmeta>"#;

        let parsed = parse_xmp_str(rotated_xmp).unwrap();
        assert_eq!(parsed.rating, Some(0));
        assert_eq!(parsed.flag.as_deref(), Some("reject"));
        // Rotated crop is not flattened into axis-aligned crop.
        assert_eq!(parsed.crop, None);

        // Updating rating while Nebulume crop is None keeps the rotated CRS crop intact!
        let merged = String::from_utf8(
            merge_xmp_str(rotated_xmp, 4, "pick", None, "2026-11-12T15:00:00Z").unwrap(),
        )
        .unwrap();
        assert!(merged.contains(r#"crs:CropAngle="4.25""#));
        assert!(merged.contains(r#"crs:CropLeft="0.1""#));
        assert!(merged.contains(r#"xmp:Rating="4""#));
    }
}
