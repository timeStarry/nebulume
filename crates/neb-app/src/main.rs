#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod file_open;
mod viewer;
mod volumes;
use neb_service::{CommandError, Service};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Manager, State};

#[tauri::command]
async fn list_volumes() -> Result<Vec<volumes::Volume>, CommandError> {
    tauri::async_runtime::spawn_blocking(volumes::enumerate)
        .await
        .map_err(|_| viewer::error("E_WORKER", "Volume discovery stopped unexpectedly"))?
        .map_err(|message| viewer::error("E_VOLUMES", message))
}

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
    let startup_paths = file_open::startup_paths(std::env::args_os().skip(1));
    let open_from_command_line = !startup_paths.is_empty();
    tauri::Builder::default()
        .manage(viewer::ViewerSessions::default())
        .manage(file_open::OpenRequests::default())
        // Register first: a secondary instance must exit before opening shared state.
        .plugin(tauri_plugin_single_instance::init(|app, arguments, cwd| {
            let paths = file_open::forwarded_paths(arguments, &cwd);
            file_open::request(app, paths);
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let data_dir = std::env::var_os("NEBULUME_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_local_data_dir()?);
            app.manage(Arc::new(Service::open(data_dir)?));
            if !open_from_command_line {
                viewer::show_manager_window(app.handle())
                    .map_err(|error| std::io::Error::other(error.message))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            execute,
            viewer::open_viewer,
            viewer::viewer_context,
            viewer::show_manager,
            list_volumes
        ])
        .build(tauri::generate_context!())
        .expect("Nebulume failed to start")
        .run(move |app, event| match event {
            tauri::RunEvent::Ready => {
                file_open::ready(app);
                if open_from_command_line {
                    file_open::open_paths(app.clone(), startup_paths.clone());
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                file_open::request(app, paths);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                viewer::destroyed(app, &label);
            }
            _ => {}
        });
}
