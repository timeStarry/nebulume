use neb_service::{CommandError, Service};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAX_ASSETS: usize = 10_000;
const MAX_WINDOWS: usize = 16;
const MAX_QUEUE_OPTIONS: usize = 8 * 1024;

#[derive(Clone, Serialize)]
pub struct ViewerContext {
    pub asset_id: String,
    pub asset_ids: Vec<String>,
    /// "view" for ordinary viewing, "cull" to start in culling mode.
    pub mode: String,
    /// A culling queue description; the window snapshots matching ids itself.
    pub queue: Option<ViewerQueue>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ViewerQueue {
    pub library_id: String,
    pub options: serde_json::Value,
}

#[derive(Default)]
pub struct ViewerSessions {
    next: AtomicU64,
    entries: Mutex<HashMap<String, ViewerContext>>,
}

pub fn error(code: &'static str, message: impl Into<String>) -> CommandError {
    CommandError {
        code,
        message: message.into(),
    }
}

fn context(asset_id: String, asset_ids: Vec<String>) -> Result<ViewerContext, CommandError> {
    let valid = |id: &str| !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control);
    if !valid(&asset_id) || asset_ids.iter().any(|id| !valid(id)) {
        return Err(error("E_INVALID", "Invalid viewer asset identifier"));
    }
    if asset_ids.len() > MAX_ASSETS {
        return Err(error(
            "E_LIMIT",
            "A viewer can contain at most 10000 images",
        ));
    }
    let mut seen = HashSet::new();
    let mut asset_ids: Vec<_> = asset_ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    if !seen.contains(&asset_id) {
        asset_ids.insert(0, asset_id.clone());
    }
    if asset_ids.len() > MAX_ASSETS {
        return Err(error(
            "E_LIMIT",
            "A viewer can contain at most 10000 images",
        ));
    }
    Ok(ViewerContext {
        asset_id,
        asset_ids,
        mode: "view".into(),
        queue: None,
    })
}

fn culling_context(
    asset_id: String,
    asset_ids: Vec<String>,
    mode: Option<String>,
    queue: Option<ViewerQueue>,
) -> Result<ViewerContext, CommandError> {
    let mut result = context(asset_id, asset_ids)?;
    let mode = mode.unwrap_or_else(|| "view".into());
    if !matches!(mode.as_str(), "view" | "cull") {
        return Err(error("E_INVALID", "Viewer mode must be view or cull"));
    }
    if let Some(queue) = &queue {
        let valid = !queue.library_id.is_empty()
            && queue.library_id.len() <= 128
            && !queue.library_id.chars().any(char::is_control);
        if !valid || !queue.options.is_object() {
            return Err(error("E_INVALID", "Invalid viewer queue"));
        }
        if queue.options.to_string().len() > MAX_QUEUE_OPTIONS {
            return Err(error("E_LIMIT", "Viewer queue options are too large"));
        }
    }
    result.mode = mode;
    result.queue = queue;
    Ok(result)
}

pub async fn open(
    app: AppHandle,
    asset_id: String,
    asset_ids: Vec<String>,
) -> Result<String, CommandError> {
    open_context(app, context(asset_id, asset_ids)?).await
}

async fn open_context(app: AppHandle, context: ViewerContext) -> Result<String, CommandError> {
    let service = Arc::clone(app.state::<Arc<Service>>().inner());
    let selected = context.asset_id.clone();
    let asset = tauri::async_runtime::spawn_blocking(move || {
        service.execute("asset.get", json!({"id":selected}))
    })
    .await
    .map_err(|_| error("E_WORKER", "Viewer lookup stopped unexpectedly"))??;
    let title = asset
        .get("filename")
        .and_then(|value| value.as_str())
        .unwrap_or("Image");
    let sessions = app.state::<ViewerSessions>();
    let label = format!("viewer-{}", sessions.next.fetch_add(1, Ordering::Relaxed));
    {
        let mut entries = sessions
            .entries
            .lock()
            .map_err(|_| error("E_STATE", "Viewer state is unavailable"))?;
        if entries.len() >= MAX_WINDOWS {
            return Err(error(
                "E_LIMIT",
                "Close a viewer before opening more than 16 windows",
            ));
        }
        // Insert before the webview starts; it may request its context immediately.
        entries.insert(label.clone(), context);
    }
    let built =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html?viewer=1".into()))
            .title(format!("{title} — Nebulume"))
            .inner_size(1280.0, 860.0)
            .min_inner_size(640.0, 480.0)
            .center()
            .disable_drag_drop_handler()
            .build();
    if let Err(cause) = built {
        if let Ok(mut entries) = sessions.entries.lock() {
            entries.remove(&label);
        }
        return Err(error("E_WINDOW", format!("Cannot create viewer: {cause}")));
    }
    Ok(label)
}

#[tauri::command]
pub async fn open_viewer(
    app: AppHandle,
    asset_id: String,
    asset_ids: Vec<String>,
    mode: Option<String>,
    queue: Option<ViewerQueue>,
) -> Result<String, CommandError> {
    open_context(app, culling_context(asset_id, asset_ids, mode, queue)?).await
}

#[tauri::command]
pub fn viewer_context(
    window: WebviewWindow,
    sessions: State<'_, ViewerSessions>,
) -> Result<ViewerContext, CommandError> {
    sessions
        .entries
        .lock()
        .map_err(|_| error("E_STATE", "Viewer state is unavailable"))?
        .get(window.label())
        .cloned()
        .ok_or_else(|| error("E_NOT_FOUND", "This window has no viewer session"))
}

#[tauri::command]
pub async fn show_manager(app: AppHandle) -> Result<(), CommandError> {
    show_manager_window(&app)
}

pub fn show_manager_window(app: &AppHandle) -> Result<(), CommandError> {
    let window = if let Some(window) = app.get_webview_window("main") {
        window
    } else {
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .ok_or_else(|| error("E_WINDOW", "Main window configuration is missing"))?;
        WebviewWindowBuilder::from_config(app, config)
            .map_err(|cause| error("E_WINDOW", cause.to_string()))?
            .visible(true)
            .build()
            .map_err(|cause| error("E_WINDOW", cause.to_string()))?
    };
    window
        .show()
        .map_err(|cause| error("E_WINDOW", cause.to_string()))?;
    window
        .unminimize()
        .map_err(|cause| error("E_WINDOW", cause.to_string()))?;
    window
        .set_focus()
        .map_err(|cause| error("E_WINDOW", cause.to_string()))
}

pub fn destroyed(app: &AppHandle, label: &str) {
    if !label.starts_with("viewer-") {
        return;
    }
    let sessions = app.state::<ViewerSessions>();
    let empty = sessions
        .entries
        .lock()
        .map(|mut entries| {
            entries.remove(label);
            entries.is_empty()
        })
        .unwrap_or(false);
    if empty
        && app
            .get_webview_window("main")
            .is_some_and(|window| !window.is_visible().unwrap_or(true))
    {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewer_context_preserves_order_and_selected_image_without_duplicates() {
        let result = context("b".into(), vec!["a".into(), "b".into(), "a".into()]).unwrap();
        assert_eq!(result.asset_id, "b");
        assert_eq!(result.asset_ids, ["a", "b"]);
        assert_eq!(
            context("c".into(), vec!["a".into()]).unwrap().asset_ids,
            ["c", "a"]
        );
    }

    #[test]
    fn viewer_requests_are_bounded_and_reject_invalid_identifiers() {
        assert!(context("".into(), vec![]).is_err());
        assert!(context("ok".into(), vec!["line\nbreak".into()]).is_err());
        assert!(context("ok".into(), vec!["a".into(); MAX_ASSETS + 1]).is_err());
    }

    #[test]
    fn viewer_context_carries_mode_and_bounded_queue() {
        let queue = |options| ViewerQueue {
            library_id: "library".into(),
            options,
        };
        let plain = culling_context("a".into(), vec![], None, None).unwrap();
        assert_eq!(plain.mode, "view");
        let cull = culling_context(
            "a".into(),
            vec![],
            Some("cull".into()),
            Some(queue(serde_json::json!({"flag":"none"}))),
        )
        .unwrap();
        assert_eq!(cull.mode, "cull");
        assert_eq!(cull.queue.unwrap().options["flag"], "none");
        let invalid = culling_context("a".into(), vec![], Some("edit".into()), None);
        assert_eq!(invalid.err().unwrap().code, "E_INVALID");
        let large = serde_json::json!({"query":"x".repeat(MAX_QUEUE_OPTIONS)});
        let limited = culling_context("a".into(), vec![], Some("cull".into()), Some(queue(large)));
        assert_eq!(limited.err().unwrap().code, "E_LIMIT");
        let not_object =
            culling_context("a".into(), vec![], None, Some(queue(serde_json::json!([]))));
        assert_eq!(not_object.err().unwrap().code, "E_INVALID");
    }
}
