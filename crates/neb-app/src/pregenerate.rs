//! One background worker that renders grid previews for a library after it is indexed.
//! A new request or an update install cancels the running one between photos.
use crate::viewer;
use neb_core::PreviewTier;
use neb_service::{CommandError, Service};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Default)]
pub struct Pregeneration {
    current: Mutex<Option<Arc<AtomicBool>>>,
}

impl Pregeneration {
    fn replace(&self, next: Option<Arc<AtomicBool>>) {
        let previous = match self.current.lock() {
            Ok(mut current) => std::mem::replace(&mut *current, next),
            Err(_) => None,
        };
        if let Some(flag) = previous {
            flag.store(true, Ordering::Release);
        }
    }
    pub fn cancel(&self) {
        self.replace(None);
    }
}

#[tauri::command]
pub fn pregenerate_previews(
    service: State<'_, Arc<Service>>,
    state: State<'_, Pregeneration>,
    library_id: String,
    tier: String,
) -> Result<(), CommandError> {
    let tier = PreviewTier::parse(&tier)
        .filter(|tier| tier.is_grid())
        .ok_or_else(|| viewer::error("E_INVALID", "Pregeneration renders grid tiers only"))?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.replace(Some(Arc::clone(&cancel)));
    let service = Arc::clone(service.inner());
    std::thread::Builder::new()
        .name("preview-pregeneration".into())
        .spawn(move || {
            // Failures are per photo and already counted; on-demand loading still covers them.
            let _ = service.pregenerate_previews(&library_id, tier, &cancel);
        })
        .map_err(|error| viewer::error("E_WORKER", error.to_string()))?;
    Ok(())
}
