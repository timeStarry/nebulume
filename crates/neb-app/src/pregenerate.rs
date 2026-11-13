//! One background worker that renders grid previews for a library after it is indexed.
//! A new request or an update install cancels the running one between photos.
use crate::viewer;
use neb_core::PreviewTier;
use neb_service::{CommandError, Service};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
pub struct PregenerateProgressEvent {
    pub library_id: String,
    pub processed: usize,
    pub total: usize,
    pub status: &'static str,
    pub rendered: usize,
    pub cached: usize,
    pub failed: usize,
}

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
    app: AppHandle,
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
            let mut last_total = 0usize;
            let mut last_done = 0usize;
            // Failures are per photo and already counted; on-demand loading still covers them.
            let outcome = service.pregenerate_previews_with_progress(
                &library_id,
                tier,
                &cancel,
                |done, total| {
                    last_done = done;
                    last_total = total;
                    let _ = app.emit(
                        "pregenerate-progress",
                        PregenerateProgressEvent {
                            library_id: library_id.clone(),
                            processed: done,
                            total,
                            status: "running",
                            rendered: 0,
                            cached: 0,
                            failed: 0,
                        },
                    );
                },
            );
            match outcome {
                Ok(report) => {
                    let _ = app.emit(
                        "pregenerate-progress",
                        PregenerateProgressEvent {
                            library_id,
                            processed: if report.cancelled {
                                last_done
                            } else {
                                last_total
                            },
                            total: last_total,
                            status: if report.cancelled {
                                "cancelled"
                            } else {
                                "completed"
                            },
                            rendered: report.rendered,
                            cached: report.cached,
                            failed: report.failed,
                        },
                    );
                }
                Err(_) => {
                    let _ = app.emit(
                        "pregenerate-progress",
                        PregenerateProgressEvent {
                            library_id,
                            processed: last_done,
                            total: last_total,
                            status: "failed",
                            rendered: 0,
                            cached: 0,
                            failed: 1,
                        },
                    );
                }
            }
        })
        .map_err(|error| viewer::error("E_WORKER", error.to_string()))?;
    Ok(())
}
