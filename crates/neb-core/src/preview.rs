//! Tiered JPEG previews: fixed long-side sizes, a binary cache envelope and a
//! byte-bounded in-memory LRU shared by local and remote assets.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const MAGIC: &[u8; 4] = b"NPV2";
const INVALID: &str = "E_CACHE: Invalid preview cache";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewTier {
    T256,
    T512,
    T1024,
    P2560,
    Full,
}

impl PreviewTier {
    pub const ALL: [Self; 5] = [Self::T256, Self::T512, Self::T1024, Self::P2560, Self::Full];

    pub fn pixels(self) -> u32 {
        match self {
            Self::T256 => 256,
            Self::T512 => 512,
            Self::T1024 => 1024,
            Self::P2560 => 2560,
            Self::Full => 9600,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::T256 => "t256",
            Self::T512 => "t512",
            Self::T1024 => "t1024",
            Self::P2560 => "p2560",
            Self::Full => "full",
        }
    }

    pub fn is_grid(self) -> bool {
        matches!(self, Self::T256 | Self::T512 | Self::T1024)
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tier| tier.as_str() == name)
    }

    /// Smallest standard tier whose long side covers `max_size`; larger legacy
    /// `max_size` requests cap at `P2560` (`Full` is requested explicitly).
    pub fn for_max_size(max_size: u32) -> Self {
        [Self::T256, Self::T512, Self::T1024, Self::P2560]
            .into_iter()
            .find(|tier| tier.pixels() >= max_size)
            .unwrap_or(Self::P2560)
    }

    /// All preview tiers default to reading a RAW file's embedded camera JPEG
    /// when its resolution is sufficient, avoiding slow CPU demosaicing unless
    /// explicit RAW sensor development (`prefer_raw`) is requested.
    pub fn prefers_embedded(self) -> bool {
        true
    }

    /// Tier-adaptive JPEG quality: compact encoding for grid cells, high fidelity
    /// for viewer and 1:1 inspection while preserving ICC profiles across all tiers.
    pub fn jpeg_quality(self) -> u8 {
        match self {
            Self::T256 => 80,
            Self::T512 => 82,
            Self::T1024 => 85,
            Self::P2560 | Self::Full => 88,
        }
    }

    /// Standard tiers strictly larger than `self` (excluding `Full`), ordered from
    /// closest/viewer down so downward cascade prefers an already-cached `P2560` or `T1024`.
    pub fn higher_standard_tiers(self) -> &'static [Self] {
        match self {
            Self::T256 => &[Self::P2560, Self::T1024, Self::T512],
            Self::T512 => &[Self::P2560, Self::T1024],
            Self::T1024 => &[Self::P2560],
            Self::P2560 | Self::Full => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreviewImage {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub source: String,
    pub coordinate_mapping: Option<Value>,
    pub extras: Map<String, Value>,
}

impl PreviewImage {
    pub fn meta(&self) -> Value {
        let mut meta = self.extras.clone();
        meta.insert("width".into(), self.width.into());
        meta.insert("height".into(), self.height.into());
        meta.insert("source".into(), self.source.clone().into());
        if let Some(mapping) = &self.coordinate_mapping {
            meta.insert("coordinate_mapping".into(), mapping.clone());
        }
        Value::Object(meta)
    }

    /// `NPV2`, little-endian `u32` meta length, UTF-8 meta JSON, JPEG bytes.
    pub fn to_envelope(&self) -> Vec<u8> {
        let meta = serde_json::to_vec(&self.meta()).expect("preview metadata is valid JSON");
        let length = u32::try_from(meta.len()).expect("preview metadata fits in u32");
        let mut bytes = Vec::with_capacity(8 + meta.len() + self.jpeg.len());
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&length.to_le_bytes());
        bytes.extend_from_slice(&meta);
        bytes.extend_from_slice(&self.jpeg);
        bytes
    }

    pub fn from_envelope(bytes: &[u8]) -> Result<Self> {
        let rest = bytes.strip_prefix(MAGIC).context(INVALID)?;
        let length = rest
            .get(..4)
            .and_then(|length| <[u8; 4]>::try_from(length).ok())
            .map(u32::from_le_bytes)
            .context(INVALID)?;
        let rest = &rest[4..];
        let length = usize::try_from(length).context(INVALID)?;
        let meta = rest.get(..length).context(INVALID)?;
        let meta = std::str::from_utf8(meta).ok().context(INVALID)?;
        let Value::Object(mut meta) = serde_json::from_str(meta).ok().context(INVALID)? else {
            anyhow::bail!(INVALID);
        };
        let dimension = |value: Option<Value>| {
            value
                .as_ref()
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .context(INVALID)
        };
        let width = dimension(meta.remove("width"))?;
        let height = dimension(meta.remove("height"))?;
        let source = match meta.remove("source") {
            Some(Value::String(source)) => source,
            _ => anyhow::bail!(INVALID),
        };
        let coordinate_mapping = meta.remove("coordinate_mapping");
        Ok(Self {
            jpeg: rest[length..].to_vec(),
            width,
            height,
            source,
            coordinate_mapping,
            extras: meta,
        })
    }
}

/// Least recently used entries are evicted until both the entry and JPEG byte
/// limits hold. Hits share the stored `Arc` instead of copying pixels, using
/// an indexed generation map instead of linear scanning.
pub struct PreviewMemory {
    max_entries: usize,
    max_bytes: usize,
    state: Mutex<MemoryState>,
}

#[derive(Default)]
struct MemoryState {
    entries: HashMap<String, (u64, Arc<PreviewImage>)>,
    order: BTreeMap<u64, String>,
    next_gen: u64,
    bytes: usize,
}

impl PreviewMemory {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            max_entries,
            max_bytes,
            state: Mutex::default(),
        }
    }

    pub fn get(&self, key: &str) -> Option<Arc<PreviewImage>> {
        let mut state = self.state.lock().ok()?;
        let (old_gen, image) = {
            let entry = state.entries.get(key)?;
            (entry.0, Arc::clone(&entry.1))
        };
        state.order.remove(&old_gen);
        let gen = state.next_gen;
        state.next_gen = state.next_gen.wrapping_add(1);
        if let Some(entry) = state.entries.get_mut(key) {
            entry.0 = gen;
        }
        state.order.insert(gen, key.to_owned());
        Some(image)
    }

    /// Checks presence without promoting LRU position.
    pub fn peek(&self, key: &str) -> Option<Arc<PreviewImage>> {
        let state = self.state.lock().ok()?;
        state.entries.get(key).map(|(_, image)| Arc::clone(image))
    }

    pub fn put(&self, key: String, image: Arc<PreviewImage>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Some((old_gen, old_img)) = state.entries.remove(&key) {
            state.order.remove(&old_gen);
            state.bytes = state.bytes.saturating_sub(old_img.jpeg.len());
        }
        if self.max_entries == 0 || image.jpeg.len() > self.max_bytes {
            return;
        }
        let gen = state.next_gen;
        state.next_gen = state.next_gen.wrapping_add(1);
        state.bytes += image.jpeg.len();
        state.order.insert(gen, key.clone());
        state.entries.insert(key, (gen, image));
        while state.entries.len() > self.max_entries || state.bytes > self.max_bytes {
            let Some((_, oldest_key)) = state.order.pop_first() else {
                break;
            };
            if let Some((_, evicted)) = state.entries.remove(&oldest_key) {
                state.bytes = state.bytes.saturating_sub(evicted.jpeg.len());
            }
        }
    }

    /// Drops every entry whose key starts with `prefix`, e.g. `"<asset id>:"`.
    pub fn remove_prefix(&self, prefix: &str) {
        if let Ok(mut state) = self.state.lock() {
            let MemoryState {
                entries,
                order,
                bytes,
                ..
            } = &mut *state;
            entries.retain(|key, (gen, image)| {
                let keep = !key.starts_with(prefix);
                if !keep {
                    order.remove(gen);
                    *bytes = bytes.saturating_sub(image.jpeg.len());
                }
                keep
            });
        }
    }

    pub fn clear(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = MemoryState::default();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn image(bytes: usize) -> Arc<PreviewImage> {
        Arc::new(PreviewImage {
            jpeg: vec![0xff; bytes],
            width: 1,
            height: 1,
            source: "raster".into(),
            coordinate_mapping: None,
            extras: Map::new(),
        })
    }

    #[test]
    fn tier_names_and_sizes_round_trip() {
        for (tier, name, pixels) in [
            (PreviewTier::T256, "t256", 256),
            (PreviewTier::T512, "t512", 512),
            (PreviewTier::T1024, "t1024", 1024),
            (PreviewTier::P2560, "p2560", 2560),
            (PreviewTier::Full, "full", 9600),
        ] {
            assert_eq!(tier.as_str(), name);
            assert_eq!(PreviewTier::parse(tier.as_str()), Some(tier));
            assert_eq!(tier.pixels(), pixels);
            assert_eq!(serde_json::to_value(tier).unwrap(), json!(name));
        }
        assert_eq!(PreviewTier::parse("t9999"), None);
        assert!(PreviewTier::T1024.is_grid());
        assert!(!PreviewTier::P2560.is_grid());
        assert!(!PreviewTier::Full.is_grid());
        assert!(PreviewTier::T1024.prefers_embedded());
        assert!(PreviewTier::P2560.prefers_embedded());
        assert!(PreviewTier::Full.prefers_embedded());
    }

    #[test]
    fn max_size_maps_to_smallest_covering_tier() {
        for (max_size, tier) in [
            (32, PreviewTier::T256),
            (256, PreviewTier::T256),
            (257, PreviewTier::T512),
            (420, PreviewTier::T512),
            (1024, PreviewTier::T1024),
            (1025, PreviewTier::P2560),
            (4096, PreviewTier::P2560),
        ] {
            assert_eq!(PreviewTier::for_max_size(max_size), tier, "{max_size}");
        }
    }

    #[test]
    fn envelope_round_trip_preserves_bytes_and_meta() {
        let mut extras = Map::new();
        extras.insert(
            "inspection".into(),
            json!({"width": 8, "height": 12, "metadata": {"Make": "NIKON"}}),
        );
        let original = PreviewImage {
            jpeg: vec![1, 2, 3],
            width: 8,
            height: 12,
            source: "remote_embedded_jpeg".into(),
            coordinate_mapping: Some(json!({"orientation": 6, "full_width": 8})),
            extras,
        };
        let decoded = PreviewImage::from_envelope(&original.to_envelope()).unwrap();
        assert_eq!(decoded.jpeg, original.jpeg);
        assert_eq!(decoded.width, original.width);
        assert_eq!(decoded.height, original.height);
        assert_eq!(decoded.source, original.source);
        assert_eq!(decoded.coordinate_mapping, original.coordinate_mapping);
        assert_eq!(decoded.extras, original.extras);
        assert_eq!(decoded.meta(), original.meta());
        assert!(original.meta().get("data_url").is_none());
    }

    #[test]
    fn envelope_rejects_wrong_magic_and_truncation() {
        let mut too_long = b"NPV2".to_vec();
        too_long.extend_from_slice(&100_u32.to_le_bytes());
        too_long.extend_from_slice(b"{}");
        let mut invalid_utf8 = b"NPV2".to_vec();
        invalid_utf8.extend_from_slice(&2_u32.to_le_bytes());
        invalid_utf8.extend_from_slice(&[0xff, 0xfe]);
        for bytes in [
            b"NPV1\x02\x00\x00\x00{}".to_vec(),
            b"NPV2\x02".to_vec(),
            too_long,
            invalid_utf8,
        ] {
            let error = PreviewImage::from_envelope(&bytes).unwrap_err();
            assert!(error.to_string().starts_with("E_CACHE:"), "{error}");
        }
    }

    #[test]
    fn memory_cache_evicts_by_bytes_and_entries() {
        let memory = PreviewMemory::new(2, 10);
        let a = image(4);
        memory.put("a".into(), Arc::clone(&a));
        assert!(Arc::ptr_eq(&memory.get("a").unwrap(), &a));
        memory.put("b".into(), image(4));
        memory.put("c".into(), image(4));
        assert!(memory.get("a").is_none());
        assert!(memory.get("b").is_some());
        let d = image(9);
        memory.put("d".into(), Arc::clone(&d));
        assert!(memory.get("b").is_none());
        assert!(memory.get("c").is_none());
        assert!(Arc::ptr_eq(&memory.get("d").unwrap(), &d));
        memory.put("big".into(), image(11));
        assert!(memory.get("big").is_none());
        memory.remove_prefix("d");
        assert!(memory.get("d").is_none());
    }

    #[test]
    fn memory_lru_promotion_and_higher_tier_cascade_order() {
        let memory = PreviewMemory::new(3, 100);
        memory.put("k1".into(), image(10));
        memory.put("k2".into(), image(10));
        memory.put("k3".into(), image(10));
        // Promote k1; k2 becomes oldest, while peek(k2) does not promote it.
        assert!(memory.get("k1").is_some());
        assert!(memory.peek("k2").is_some());
        memory.put("k4".into(), image(10));
        assert!(memory.get("k2").is_none());
        assert!(memory.get("k1").is_some());
        assert!(memory.get("k3").is_some());
        assert!(memory.get("k4").is_some());

        assert_eq!(
            PreviewTier::T256.higher_standard_tiers(),
            &[PreviewTier::P2560, PreviewTier::T1024, PreviewTier::T512]
        );
        assert_eq!(
            PreviewTier::T512.higher_standard_tiers(),
            &[PreviewTier::P2560, PreviewTier::T1024]
        );
        assert!(PreviewTier::T256.jpeg_quality() < PreviewTier::P2560.jpeg_quality());
    }
}
