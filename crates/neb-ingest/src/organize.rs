//! Structured, bounded import organization rules. Not a template language: every
//! option is a fixed choice, so a rule can never produce an unbounded or escaping path.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DateBasis {
    /// Camera DateTimeOriginal day (the default).
    Capture,
    /// The day the plan was made; frozen in the plan, never recomputed.
    Import,
    /// No date folders.
    None,
    /// Keep the card's own folder structure.
    Preserve,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DateLayout {
    #[serde(rename = "Y-M-D")]
    Day,
    #[serde(rename = "Y/Y-M-D")]
    YearDay,
    #[serde(rename = "Y/M/Y-M-D")]
    YearMonthDay,
    #[serde(rename = "Y/M/D")]
    Nested,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TypeSplit {
    None,
    /// RAW / JPG / TIFF / OTHER inside the date folder. XMP follows its RAW.
    ByKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownDate {
    /// `unknown-date/` (the default). Nothing is guessed.
    Folder,
    /// Explicit opt-in: use the source file's modification day, labelled per item.
    ModifiedTime,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenameMode {
    /// Keep original camera filename (the default).
    #[default]
    Keep,
    /// `{YYYYMMDD}_{prefix}_{seq:04}.{ext}` (or `{YYYYMMDD}_{seq:04}.{ext}` when prefix is empty).
    DatePrefixSeq,
    /// `{prefix}_{original_filename}` (keeps original filename when prefix is empty).
    PrefixOriginal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrganizeRules {
    pub date_basis: DateBasis,
    #[serde(default = "default_layout")]
    pub date_layout: DateLayout,
    #[serde(default = "default_split")]
    pub type_split: TypeSplit,
    #[serde(default = "default_unknown")]
    pub unknown_date: UnknownDate,
    /// Fixed folder between the destination root and the date folders, e.g. `Camera/Z8`.
    #[serde(default)]
    pub subfolder: String,
    /// Optional structured filename renaming rule.
    #[serde(default)]
    pub rename_mode: RenameMode,
    #[serde(default)]
    pub rename_prefix: String,
}

fn default_layout() -> DateLayout {
    DateLayout::Day
}
fn default_split() -> TypeSplit {
    TypeSplit::None
}
fn default_unknown() -> UnknownDate {
    UnknownDate::Folder
}

impl Default for OrganizeRules {
    fn default() -> Self {
        Self {
            date_basis: DateBasis::Capture,
            date_layout: DateLayout::Day,
            type_split: TypeSplit::None,
            unknown_date: UnknownDate::Folder,
            subfolder: String::new(),
            rename_mode: RenameMode::Keep,
            rename_prefix: String::new(),
        }
    }
}

fn is_reserved_windows_stem(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
}

impl OrganizeRules {
    /// Earlier API names: `preserve` keeps folders, `date` is capture day in `Y-M-D`.
    pub fn from_legacy_layout(layout: &str) -> Result<Self> {
        match layout {
            "preserve" => Ok(Self {
                date_basis: DateBasis::Preserve,
                ..Self::default()
            }),
            "date" => Ok(Self::default()),
            _ => bail!("Layout must be preserve or date"),
        }
    }

    pub fn validate(&self) -> Result<()> {
        if !self.subfolder.is_empty() {
            if self.subfolder.len() > 120 {
                bail!("Subfolder must be at most 120 bytes");
            }
            for part in self.subfolder.split('/') {
                if part.is_empty()
                    || part == "."
                    || part == ".."
                    || part.ends_with('.')
                    || part.ends_with(' ')
                    || is_reserved_windows_stem(part)
                    || part
                        .chars()
                        .any(|c| c.is_control() || r#"\:*?"<>|"#.contains(c))
                {
                    bail!("Subfolder must be plain folder names separated by /");
                }
            }
        }
        if !self.rename_prefix.is_empty() {
            if self.rename_prefix.len() > 40 {
                bail!("Rename prefix must be at most 40 bytes");
            }
            if self.rename_prefix == "."
                || self.rename_prefix == ".."
                || self.rename_prefix.starts_with('.')
                || self.rename_prefix.ends_with('.')
                || self.rename_prefix.starts_with(' ')
                || self.rename_prefix.ends_with(' ')
                || is_reserved_windows_stem(&self.rename_prefix)
                || self
                    .rename_prefix
                    .chars()
                    .any(|c| c.is_control() || r#"\/:*?"<>|"#.contains(c))
            {
                bail!("Rename prefix must be a plain filename token without path separators");
            }
        }
        Ok(())
    }

    pub fn needs_capture_dates(&self) -> bool {
        self.date_basis == DateBasis::Capture
            || (self.rename_mode == RenameMode::DatePrefixSeq
                && self.date_basis != DateBasis::Import)
    }
}

/// The resolved day for one item, with where it came from.
pub struct ItemDate {
    /// `YYYY-MM-DD`, or None for unknown.
    pub day: Option<String>,
    /// exif, paired_exif, import_date, modified_time, unknown or preserved.
    pub source: String,
}

/// Build a destination key with sequence number `1`.
pub fn target_path(rules: &OrganizeRules, source_key: &str, date: &ItemDate) -> Result<String> {
    target_path_with_seq(rules, source_key, date, 1)
}

/// Build a destination key using a 1-based companion-group sequence number.
pub fn target_path_with_seq(
    rules: &OrganizeRules,
    source_key: &str,
    date: &ItemDate,
    seq: usize,
) -> Result<String> {
    let filename = Path::new(source_key)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("Missing filename"))?;
    let mut parts: Vec<String> = Vec::new();
    if !rules.subfolder.is_empty() {
        parts.push(rules.subfolder.clone());
    }
    match rules.date_basis {
        DateBasis::Preserve => {
            if let Some(parent) = Path::new(source_key).parent().and_then(|p| p.to_str()) {
                if !parent.is_empty() {
                    parts.push(parent.replace('\\', "/"));
                }
            }
        }
        DateBasis::None => {}
        DateBasis::Capture | DateBasis::Import => match &date.day {
            Some(day) => parts.push(day_folder(&rules.date_layout, day)?),
            None => parts.push("unknown-date".into()),
        },
    }
    if rules.type_split == TypeSplit::ByKind {
        parts.push(kind_folder(source_key).into());
    }
    parts.push(format_filename(rules, filename, date.day.as_deref(), seq));
    Ok(parts.join("/"))
}

fn format_filename(rules: &OrganizeRules, filename: &str, day: Option<&str>, seq: usize) -> String {
    let seq = seq.max(1);
    match rules.rename_mode {
        RenameMode::Keep => filename.to_owned(),
        RenameMode::PrefixOriginal => {
            if rules.rename_prefix.is_empty() {
                filename.to_owned()
            } else {
                format!("{}_{filename}", rules.rename_prefix)
            }
        }
        RenameMode::DatePrefixSeq => {
            let ext = Path::new(filename)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{e}"))
                .unwrap_or_default();
            let compact_day = day
                .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                .map(|d| d.format("%Y%m%d").to_string())
                .unwrap_or_else(|| "00000000".into());
            if rules.rename_prefix.is_empty() {
                format!("{compact_day}_{seq:04}{ext}")
            } else {
                format!("{compact_day}_{}_{seq:04}{ext}", rules.rename_prefix)
            }
        }
    }
}

fn day_folder(layout: &DateLayout, day: &str) -> Result<String> {
    let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map_err(|_| anyhow::anyhow!("Invalid capture day {day}"))?;
    Ok(match layout {
        DateLayout::Day => date.format("%Y-%m-%d").to_string(),
        DateLayout::YearDay => date.format("%Y/%Y-%m-%d").to_string(),
        DateLayout::YearMonthDay => date.format("%Y/%m/%Y-%m-%d").to_string(),
        DateLayout::Nested => date.format("%Y/%m/%d").to_string(),
    })
}

/// Sidecars stay with the RAW they describe so companion groups keep one target stem.
pub fn kind_folder(key: &str) -> &'static str {
    let extension = Path::new(key)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => "JPG",
        "tif" | "tiff" => "TIFF",
        "dng" | "nef" | "nrw" | "cr2" | "cr3" | "arw" | "srf" | "sr2" | "raf" | "orf" | "rw2"
        | "pef" | "srw" | "3fr" | "fff" | "iiq" | "rwl" | "x3f" | "raw" | "xmp" => "RAW",
        _ => "OTHER",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(day: Option<&str>) -> ItemDate {
        ItemDate {
            day: day.map(str::to_owned),
            source: "exif".into(),
        }
    }

    #[test]
    fn layouts_produce_the_documented_folders_and_keep_filenames() {
        let mut rules = OrganizeRules::default();
        let day = date(Some("2026-10-22"));
        let cases = [
            (DateLayout::Day, "2026-10-22/DSC_1.NEF"),
            (DateLayout::YearDay, "2026/2026-10-22/DSC_1.NEF"),
            (DateLayout::YearMonthDay, "2026/10/2026-10-22/DSC_1.NEF"),
            (DateLayout::Nested, "2026/10/22/DSC_1.NEF"),
        ];
        for (layout, expected) in cases {
            rules.date_layout = layout;
            assert_eq!(
                target_path(&rules, "DCIM/100NIKON/DSC_1.NEF", &day).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn type_split_subfolder_unknown_and_preserve_compose() {
        let rules = OrganizeRules {
            date_layout: DateLayout::YearDay,
            type_split: TypeSplit::ByKind,
            subfolder: "Camera/Z8".into(),
            ..OrganizeRules::default()
        };
        let day = date(Some("2026-01-05"));
        assert_eq!(
            target_path(&rules, "DCIM/a.NEF", &day).unwrap(),
            "Camera/Z8/2026/2026-01-05/RAW/a.NEF"
        );
        assert_eq!(
            target_path(&rules, "DCIM/a.xmp", &day).unwrap(),
            "Camera/Z8/2026/2026-01-05/RAW/a.xmp"
        );
        assert_eq!(
            target_path(&rules, "DCIM/a.JPG", &day).unwrap(),
            "Camera/Z8/2026/2026-01-05/JPG/a.JPG"
        );
        assert_eq!(
            target_path(&rules, "DCIM/clip.MOV", &date(None)).unwrap(),
            "Camera/Z8/unknown-date/OTHER/clip.MOV"
        );
        let preserve = OrganizeRules::from_legacy_layout("preserve").unwrap();
        assert_eq!(
            target_path(&preserve, "DCIM/100/a.jpg", &date(None)).unwrap(),
            "DCIM/100/a.jpg"
        );
        let flat = OrganizeRules {
            date_basis: DateBasis::None,
            ..OrganizeRules::default()
        };
        assert_eq!(target_path(&flat, "DCIM/100/a.jpg", &day).unwrap(), "a.jpg");
    }

    #[test]
    fn subfolders_reject_escapes_and_reserved_names() {
        for bad in [
            "../x", "/abs", "a//b", "a\\b", "C:", "con", "LPT1", "a.", "x?", "a/./b",
        ] {
            let rules = OrganizeRules {
                subfolder: bad.into(),
                ..OrganizeRules::default()
            };
            assert!(rules.validate().is_err(), "{bad} should be rejected");
        }
        let ok = OrganizeRules {
            subfolder: "Camera/尼康 Z8".into(),
            ..OrganizeRules::default()
        };
        ok.validate().unwrap();
        assert!(OrganizeRules::from_legacy_layout("by-week").is_err());
    }

    #[test]
    fn rules_round_trip_through_their_wire_names() {
        let rules: OrganizeRules = serde_json::from_value(serde_json::json!({
            "date_basis": "import",
            "date_layout": "Y/M/Y-M-D",
            "type_split": "by_kind",
            "unknown_date": "modified_time"
        }))
        .unwrap();
        assert_eq!(rules.date_basis, DateBasis::Import);
        assert_eq!(rules.date_layout, DateLayout::YearMonthDay);
        assert_eq!(
            serde_json::to_value(&rules).unwrap()["date_layout"],
            "Y/M/Y-M-D"
        );
    }

    #[test]
    fn rename_modes_format_companion_stems_identically_and_reject_unsafe_prefixes() {
        let day = date(Some("2026-10-22"));
        let rules = OrganizeRules {
            rename_mode: RenameMode::DatePrefixSeq,
            rename_prefix: "Wedding".into(),
            ..OrganizeRules::default()
        };
        rules.validate().unwrap();
        assert_eq!(
            target_path_with_seq(&rules, "DCIM/100NIKON/DSC_0042.NEF", &day, 7).unwrap(),
            "2026-10-22/20261022_Wedding_0007.NEF"
        );
        assert_eq!(
            target_path_with_seq(&rules, "DCIM/100NIKON/DSC_0042.JPG", &day, 7).unwrap(),
            "2026-10-22/20261022_Wedding_0007.JPG"
        );
        assert_eq!(
            target_path_with_seq(&rules, "DCIM/100NIKON/DSC_0042.xmp", &day, 7).unwrap(),
            "2026-10-22/20261022_Wedding_0007.xmp"
        );

        let prefix_orig = OrganizeRules {
            rename_mode: RenameMode::PrefixOriginal,
            rename_prefix: "ClientA".into(),
            ..OrganizeRules::default()
        };
        assert_eq!(
            target_path_with_seq(&prefix_orig, "DCIM/DSC_0001.ARW", &day, 1).unwrap(),
            "2026-10-22/ClientA_DSC_0001.ARW"
        );

        for bad in ["../escape", "a/b", "a\\b", "CON", ".hidden", "trail."] {
            let invalid = OrganizeRules {
                rename_mode: RenameMode::PrefixOriginal,
                rename_prefix: bad.into(),
                ..OrganizeRules::default()
            };
            assert!(invalid.validate().is_err(), "{bad} should fail validation");
        }
    }
}
