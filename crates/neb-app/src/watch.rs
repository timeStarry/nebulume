//! Re-indexes local libraries when files change in their folders. Events are
//! debounced per library; the scan is the same incremental `library.scan` the
//! user can run, so moves and renames keep their marks.
use crate::viewer;
use neb_service::{CommandError, Service};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Quiet period after the last change before a library is scanned.
const SETTLE: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct LibraryWatch {
    // Dropping the watcher closes the channel, which ends the worker.
    current: Mutex<Option<RecommendedWatcher>>,
}

/// A change worth a scan: a supported image appeared, changed or went away, or a
/// folder moved. Hidden paths and pure access events are ignored.
fn relevant(kind: &EventKind, path: &Path, root: &Path) -> bool {
    if matches!(kind, EventKind::Access(_) | EventKind::Other) {
        return false;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if relative
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
    {
        return false;
    }
    match path.extension() {
        Some(extension) => neb_core::is_image_extension(&extension.to_string_lossy()),
        // No extension: a folder, whose move or removal changes what is inside.
        None => matches!(
            kind,
            EventKind::Remove(_) | EventKind::Modify(_) | EventKind::Create(_)
        ),
    }
}

/// Watches every online local library, replacing any previous watch. Returns the
/// ids being watched. `enabled: false` stops watching.
#[tauri::command]
pub fn watch_libraries(
    app: AppHandle,
    service: State<'_, Arc<Service>>,
    state: State<'_, LibraryWatch>,
    enabled: bool,
) -> Result<Vec<String>, CommandError> {
    let mut current = state
        .current
        .lock()
        .map_err(|_| viewer::error("E_INTERNAL", "Library watch state is unavailable"))?;
    *current = None;
    if !enabled {
        return Ok(Vec::new());
    }
    let listed = service.execute("library.list", json!({}))?;
    let roots: Vec<(String, PathBuf)> = listed
        .as_array()
        .into_iter()
        .flatten()
        .filter(|library| library["source_kind"] == "local" && library["availability"] == "online")
        .filter_map(|library| {
            Some((
                library["id"].as_str()?.to_owned(),
                dunce::canonicalize(library["root"].as_str()?).ok()?,
            ))
        })
        .collect();
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let (sender, receiver) = mpsc::channel::<String>();
    let matching = roots.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        for path in &event.paths {
            // The deepest root wins when libraries are nested.
            if let Some((id, _)) = matching
                .iter()
                .filter(|(_, root)| relevant(&event.kind, path, root))
                .max_by_key(|(_, root)| root.as_os_str().len())
            {
                let _ = sender.send(id.clone());
            }
        }
    })
    .map_err(|error| viewer::error("E_WATCH", error.to_string()))?;
    let mut watched = Vec::new();
    for (id, root) in &roots {
        // A folder that cannot be watched is skipped; manual scans still work.
        if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
            watched.push(id.clone());
        }
    }
    let service = Arc::clone(service.inner());
    std::thread::Builder::new()
        .name("library-watch".into())
        .spawn(move || settle_and_scan(&receiver, &service, &app))
        .map_err(|error| viewer::error("E_WORKER", error.to_string()))?;
    *current = Some(watcher);
    Ok(watched)
}

fn settle_and_scan(receiver: &mpsc::Receiver<String>, service: &Service, app: &AppHandle) {
    let mut pending: HashMap<String, Instant> = HashMap::new();
    loop {
        let wait = pending
            .values()
            .map(|last| (*last + SETTLE).saturating_duration_since(Instant::now()))
            .min()
            .unwrap_or(Duration::from_secs(3600));
        match receiver.recv_timeout(wait) {
            Ok(id) => {
                pending.insert(id, Instant::now());
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let due: Vec<String> = pending
            .iter()
            .filter(|(_, last)| last.elapsed() >= SETTLE)
            .map(|(id, _)| id.clone())
            .collect();
        for id in due {
            pending.remove(&id);
            if let Ok(report) = service.execute("library.scan", json!({"library_id": id})) {
                let _ = app.emit("library-changed", changed(&id, &report));
            }
        }
    }
}

fn changed(id: &str, report: &Value) -> Value {
    json!({"library_id": id, "indexed": report["indexed"], "moved": report["moved"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    #[test]
    fn only_visible_images_and_folder_moves_trigger_a_scan() {
        let root = Path::new("/photos");
        let create = EventKind::Create(CreateKind::File);
        assert!(relevant(&create, Path::new("/photos/trip/a.JPG"), root));
        assert!(relevant(&create, Path::new("/photos/a.nef"), root));
        assert!(!relevant(&create, Path::new("/photos/notes.txt"), root));
        assert!(!relevant(&create, Path::new("/photos/.cache/a.jpg"), root));
        assert!(!relevant(&create, Path::new("/elsewhere/a.jpg"), root));
        assert!(!relevant(
            &EventKind::Access(notify::event::AccessKind::Any),
            Path::new("/photos/a.jpg"),
            root
        ));
        assert!(relevant(
            &EventKind::Remove(RemoveKind::Folder),
            Path::new("/photos/trip"),
            root
        ));
        assert!(relevant(
            &EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::Any)),
            Path::new("/photos/trip"),
            root
        ));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Real file-system events reach the filter with paths under the canonical root.
    /// `cargo test -p neb-app watch::live -- --ignored`
    #[test]
    #[ignore]
    fn platform_events_for_a_new_photo_match_the_canonical_root() {
        let folder = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(folder.path()).unwrap();
        let (sender, receiver) = mpsc::channel();
        let filter_root = root.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    if event
                        .paths
                        .iter()
                        .any(|path| relevant(&event.kind, path, &filter_root))
                    {
                        let _ = sender.send(());
                    }
                }
            })
            .unwrap();
        watcher.watch(&root, RecursiveMode::Recursive).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(folder.path().join("new.jpg"), b"jpeg").unwrap();
        assert!(receiver.recv_timeout(Duration::from_secs(5)).is_ok());
    }
}
