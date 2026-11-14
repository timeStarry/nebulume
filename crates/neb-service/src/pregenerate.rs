//! Low-priority rendering of grid previews for local photos after indexing, so the first
//! scroll through a new library reads cached tiers instead of decoding on demand.
use super::*;
use std::sync::atomic::AtomicBool;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PregenerateReport {
    pub rendered: usize,
    pub cached: usize,
    pub failed: usize,
    pub cancelled: bool,
}

impl Service {
    /// Renders `tier` (cropped, as the grid shows it) for every local photo of a library
    /// that has no cached copy. Remote photos are skipped, so nothing is downloaded. Each
    /// photo goes through the same locks as an on-demand preview; `cancel` is checked
    /// between photos. Results bypass the in-memory preview set to keep it for what is
    /// on screen.
    pub fn pregenerate_previews(
        &self,
        library_id: &str,
        tier: PreviewTier,
        cancel: &AtomicBool,
    ) -> Result<PregenerateReport, CommandError> {
        self.pregenerate_previews_with_progress(library_id, tier, cancel, |_, _| {})
    }

    pub fn pregenerate_previews_with_progress(
        &self,
        library_id: &str,
        tier: PreviewTier,
        cancel: &AtomicBool,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<PregenerateReport, CommandError> {
        let mut report = PregenerateReport::default();
        if self
            .cache
            .preview_policy()
            .is_ok_and(|policy| policy == "memory_only")
        {
            on_progress(0, 0);
            return Ok(report);
        }
        let ids = self.core.local_asset_ids(library_id)?;
        let total = ids.len();
        on_progress(0, total);
        for (idx, id) in ids.into_iter().enumerate() {
            if cancel.load(Ordering::Acquire) {
                report.cancelled = true;
                break;
            }
            let outcome = self.preview_entry(&id, || {
                let asset = self.core.asset(&id)?;
                if asset.source_key.is_some() {
                    return Ok(false);
                }
                let key = self.preview_key(&asset, tier, false)?;
                if self.previews.get(&key).is_some() || self.cache.has_preview(&key)? {
                    return Ok(false);
                }
                let image = self.core.preview_image(&id, tier, false)?;
                self.cache.preview_put(&key, &image.to_envelope())?;
                Ok(true)
            });
            match outcome {
                Ok(true) => report.rendered += 1,
                Ok(false) => report.cached += 1,
                Err(_) => report.failed += 1,
            }
            let done = idx + 1;
            if done == total || done % 4 == 0 {
                on_progress(done, total);
            }
        }
        Ok(report)
    }
}
