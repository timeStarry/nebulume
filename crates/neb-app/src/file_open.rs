use crate::viewer;
use neb_service::Service;
use serde_json::json;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[derive(Default)]
struct PendingRequests {
    ready: bool,
    paths: Vec<Vec<PathBuf>>,
}

impl PendingRequests {
    fn enqueue(&mut self, paths: Vec<PathBuf>) -> Option<Vec<PathBuf>> {
        if self.ready {
            Some(paths)
        } else {
            self.paths.push(paths);
            None
        }
    }
    fn ready(&mut self) -> Vec<Vec<PathBuf>> {
        self.ready = true;
        std::mem::take(&mut self.paths)
    }
}

#[derive(Default)]
pub struct OpenRequests(Mutex<PendingRequests>);

/// The single-instance callback can arrive before setup manages Service.
pub fn request(app: &AppHandle, paths: Vec<PathBuf>) {
    let queued = app.state::<OpenRequests>();
    let ready = queued
        .0
        .lock()
        .ok()
        .and_then(|mut queue| queue.enqueue(paths));
    if let Some(paths) = ready {
        dispatch(app.clone(), paths);
    }
}

pub fn ready(app: &AppHandle) {
    let queued = app.state::<OpenRequests>();
    let paths = queued
        .0
        .lock()
        .map(|mut queue| queue.ready())
        .unwrap_or_default();
    for paths in paths {
        dispatch(app.clone(), paths);
    }
}

fn dispatch(app: AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        // Recreating a webview from a Windows event callback must not block that event thread.
        tauri::async_runtime::spawn(async move {
            if let Err(error) = viewer::show_manager_window(&app) {
                app.dialog()
                    .message(error.message)
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        });
    } else {
        open_paths(app, paths);
    }
}

pub fn forwarded_paths(arguments: Vec<String>, cwd: &str) -> Vec<PathBuf> {
    startup_paths(arguments.into_iter().skip(1).map(OsString::from))
        .into_iter()
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                Path::new(cwd).join(path)
            }
        })
        .collect()
}

pub fn startup_paths(arguments: impl IntoIterator<Item = OsString>) -> Vec<PathBuf> {
    let mut positional = false;
    arguments
        .into_iter()
        .filter_map(|argument| {
            if argument == "--" {
                positional = true;
                return None;
            }
            if !positional && argument.to_string_lossy().starts_with('-') {
                return None;
            }
            if argument.to_string_lossy().starts_with("file://") {
                return tauri::Url::parse(&argument.to_string_lossy())
                    .ok()?
                    .to_file_path()
                    .ok();
            }
            Some(PathBuf::from(argument))
        })
        .collect()
}

pub fn open_paths(app: AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let service = Arc::clone(app.state::<Arc<Service>>().inner());
        let result = tauri::async_runtime::spawn_blocking(move || {
            if paths.len() > 100 {
                return (
                    Vec::new(),
                    vec!["Open at most 100 image files at a time".to_string()],
                );
            }
            let mut ids = Vec::new();
            let mut errors = Vec::new();
            for path in paths {
                let Some(path_text) = path.to_str() else {
                    errors
                        .push("The selected filename cannot be represented as Unicode".to_string());
                    continue;
                };
                match service.execute("file.open", json!({"path":path_text})) {
                    Ok(asset) => match asset.get("id").and_then(|value| value.as_str()) {
                        Some(id) => ids.push(id.to_string()),
                        None => errors
                            .push("File indexing did not return an image identifier".to_string()),
                    },
                    Err(error) => errors.push(format!("{}: {}", path.display(), error.message)),
                }
            }
            (ids, errors)
        })
        .await;
        let (ids, mut errors) =
            result.unwrap_or_else(|_| (vec![], vec!["File opening stopped unexpectedly".into()]));
        let opened = if let Some(id) = ids.first() {
            match viewer::open(app.clone(), id.clone(), ids).await {
                Ok(_) => true,
                Err(error) => {
                    errors.push(error.message);
                    false
                }
            }
        } else {
            false
        };
        if !opened {
            let _ = viewer::show_manager_window(&app);
        }
        if !errors.is_empty() {
            let extra = errors.len().saturating_sub(5);
            let mut message = errors.into_iter().take(5).collect::<Vec<_>>().join("\n\n");
            if extra > 0 {
                message.push_str(&format!("\n\n…and {extra} more errors"));
            }
            app.dialog()
                .message(message)
                .title("Nebulume · Cannot open image")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments_preserve_paths_and_honor_option_separator() {
        let values = ["--unrelated-flag", "photo one.jpg", "--", "-photo.png"];
        assert_eq!(
            startup_paths(values.map(OsString::from)),
            [PathBuf::from("photo one.jpg"), PathBuf::from("-photo.png")]
        );
    }
    #[test]
    fn file_urls_decode_without_accepting_remote_urls_as_files() {
        #[cfg(windows)]
        let local = "file:///C:/Pictures/photo%20one.jpg";
        #[cfg(not(windows))]
        let local = "file:///tmp/photo%20one.jpg";
        let values = [local, "file://remote.invalid/photo.jpg"];
        let paths = startup_paths(values.map(OsString::from));
        assert!(paths
            .iter()
            .any(|path| path.to_string_lossy().ends_with("photo one.jpg")));
        #[cfg(not(windows))]
        assert_eq!(paths.len(), 1);
    }

    #[test]
    fn bundle_associations_do_not_advertise_unsupported_codecs() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let extensions: Vec<_> = config["bundle"]["fileAssociations"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|association| {
                association["ext"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|value| value.as_str())
            })
            .collect();
        assert!(extensions.contains(&"jpg") && extensions.contains(&"dng"));
        for unsupported in ["cr3", "heic", "heif", "avif"] {
            assert!(!extensions.contains(&unsupported));
        }
    }

    #[test]
    fn secondary_instance_resolves_relative_paths_from_its_own_working_directory() {
        let cwd = std::env::temp_dir().join("second-launch-directory");
        let result = forwarded_paths(
            vec!["nebulume".into(), "nested/photo.jpg".into()],
            cwd.to_str().unwrap(),
        );
        assert_eq!(result, [cwd.join("nested/photo.jpg")]);
        assert!(forwarded_paths(vec!["nebulume".into()], cwd.to_str().unwrap()).is_empty());
    }

    #[test]
    fn file_open_requests_arriving_before_service_setup_are_delivered_after_ready() {
        let mut pending = PendingRequests::default();
        assert!(pending.enqueue(vec![PathBuf::from("first.jpg")]).is_none());
        assert!(pending.enqueue(vec![]).is_none());
        assert_eq!(pending.ready(), [vec![PathBuf::from("first.jpg")], vec![]]);
        assert_eq!(
            pending.enqueue(vec![PathBuf::from("next.jpg")]),
            Some(vec![PathBuf::from("next.jpg")])
        );
        assert!(pending.ready().is_empty());
    }
}
