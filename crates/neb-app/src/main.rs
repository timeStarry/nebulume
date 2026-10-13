#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use neb_service::{CommandError, Service};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Manager, State};

#[tauri::command]
async fn execute(
    service: State<'_, Arc<Service>>,
    command: String,
    params: Value,
) -> Result<Value, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.execute(&command, params))
        .await
        .map_err(|_| CommandError {
            code: "E_WORKER",
            message: "Background operation stopped unexpectedly".into(),
        })?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            app.manage(Arc::new(Service::open(data_dir)?));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![execute])
        .run(tauri::generate_context!())
        .expect("Nebulume failed to start");
}
