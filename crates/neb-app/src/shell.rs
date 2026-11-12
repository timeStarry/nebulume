//! Native desktop shell handoff: reveal in Finder/Explorer, external editor launch
//! (with automatic `.xmp` companion flush), and safe removable-card ejection.
use crate::{viewer, volumes};
use neb_service::{CommandError, Service};
use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::Arc,
};
use tauri::State;

#[derive(Debug, Serialize)]
pub struct EjectReport {
    pub path: String,
    pub name: String,
    pub ejected: bool,
}

fn validate_local_media_path(raw: &str) -> Result<PathBuf, CommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(viewer::error("E_INVALID", "Path is empty"));
    }
    let canonical = fs::canonicalize(trimmed)
        .map_err(|err| viewer::error("E_NOT_FOUND", format!("File is unavailable: {err}")))?;
    let meta = fs::metadata(&canonical)
        .map_err(|err| viewer::error("E_IO", format!("Cannot inspect file: {err}")))?;
    if !meta.is_file() && !meta.is_dir() {
        return Err(viewer::error("E_INVALID", "Target is not a regular file or folder"));
    }
    Ok(canonical)
}

fn validate_external_app(raw: &str) -> Result<PathBuf, CommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(viewer::error("E_INVALID", "Application path is empty"));
    }
    let canonical = fs::canonicalize(trimmed).map_err(|err| {
        viewer::error("E_NOT_FOUND", format!("External application not found: {err}"))
    })?;
    #[cfg(target_os = "macos")]
    {
        let is_app_bundle = canonical.is_dir()
            && canonical
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("app"));
        if !is_app_bundle && !canonical.is_file() {
            return Err(viewer::error(
                "E_INVALID",
                "Choose a macOS .app bundle or executable binary",
            ));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if !canonical.is_file() {
            return Err(viewer::error(
                "E_INVALID",
                "Choose an executable application file",
            ));
        }
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = validate_local_media_path(&path)?;
        #[cfg(target_os = "macos")]
        {
            let mut cmd = Command::new("open");
            if canonical.is_file() {
                cmd.arg("-R").arg(&canonical);
            } else {
                cmd.arg(&canonical);
            }
            let status = cmd
                .status()
                .map_err(|err| viewer::error("E_IO", format!("Failed to open Finder: {err}")))?;
            if !status.success() {
                return Err(viewer::error("E_OPERATION", "Finder could not reveal path"));
            }
        }
        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("explorer.exe");
            if canonical.is_file() {
                cmd.arg(format!("/select,{}", canonical.display()));
            } else {
                cmd.arg(&canonical);
            }
            cmd.spawn()
                .map_err(|err| viewer::error("E_IO", format!("Failed to open Explorer: {err}")))?;
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let target = if canonical.is_file() {
                canonical
                    .parent()
                    .map(std::path::Path::to_path_buf)
                    .unwrap_or(canonical)
            } else {
                canonical
            };
            Command::new("xdg-open").arg(&target).spawn().map_err(|err| {
                viewer::error("E_IO", format!("Failed to open file manager: {err}"))
            })?;
        }
        Ok(())
    })
    .await
    .map_err(|_| viewer::error("E_WORKER", "Shell worker stopped unexpectedly"))?
}

#[tauri::command]
pub async fn open_external(
    service: State<'_, Arc<Service>>,
    id: Option<String>,
    path: String,
    app_path: Option<String>,
) -> Result<(), CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = validate_local_media_path(&path)?;
        if !canonical.is_file() {
            return Err(viewer::error(
                "E_INVALID",
                "Only regular image files can be opened in an external editor",
            ));
        }
        let ext = canonical
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if neb_core::image_kind(&ext).is_none() {
            return Err(viewer::error(
                "E_UNSUPPORTED",
                "File extension is not a supported image format",
            ));
        }
        if let Some(asset_id) = id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            // Best-effort companion sidecar flush so Lightroom / Camera Raw / Capture One
            // immediately see catalog rating, pick/reject flag, and crop.
            let _ = service.flush_xmp_for_external(asset_id);
        }
        let chosen_app = app_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(validate_external_app)
            .transpose()?;

        #[cfg(target_os = "macos")]
        {
            let mut cmd = Command::new("open");
            if let Some(app) = &chosen_app {
                cmd.arg("-a").arg(app);
            }
            cmd.arg(&canonical);
            let status = cmd.status().map_err(|err| {
                viewer::error("E_IO", format!("Failed to launch external editor: {err}"))
            })?;
            if !status.success() {
                return Err(viewer::error(
                    "E_OPERATION",
                    "External application failed to open the photo",
                ));
            }
        }
        #[cfg(target_os = "windows")]
        {
            if let Some(app) = &chosen_app {
                Command::new(app).arg(&canonical).spawn().map_err(|err| {
                    viewer::error("E_IO", format!("Failed to launch external editor: {err}"))
                })?;
            } else {
                Command::new("rundll32.exe")
                    .arg("url.dll,FileProtocolHandler")
                    .arg(&canonical)
                    .spawn()
                    .map_err(|err| {
                        viewer::error("E_IO", format!("Failed to launch default viewer: {err}"))
                    })?;
            }
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let program = chosen_app
                .as_deref()
                .and_then(|p| p.to_str())
                .unwrap_or("xdg-open");
            Command::new(program).arg(&canonical).spawn().map_err(|err| {
                viewer::error("E_IO", format!("Failed to launch external editor: {err}"))
            })?;
        }
        Ok(())
    })
    .await
    .map_err(|_| viewer::error("E_WORKER", "Shell worker stopped unexpectedly"))?
}

#[tauri::command]
pub async fn eject_volume(path: String) -> Result<EjectReport, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(viewer::error("E_INVALID", "Volume path is empty"));
        }
        let canonical = fs::canonicalize(trimmed).map_err(|err| {
            viewer::error("E_NOT_FOUND", format!("Volume is no longer mounted: {err}"))
        })?;
        if canonical.parent().is_none() {
            return Err(viewer::error(
                "E_INVALID",
                "Refusing to eject the system root volume",
            ));
        }
        let candidates = volumes::enumerate()
            .map_err(|msg| viewer::error("E_VOLUMES", msg))?;
        let matched = candidates
            .into_iter()
            .filter_map(|vol| {
                let vol_canon = fs::canonicalize(&vol.path).ok()?;
                canonical.starts_with(&vol_canon).then_some((vol, vol_canon))
            })
            .max_by_key(|(_, vol_canon)| vol_canon.as_os_str().len())
            .ok_or_else(|| {
                viewer::error(
                    "E_NOT_FOUND",
                    "Target folder does not belong to an ejectable external volume",
                )
            })?;
        let (vol, mount_root) = matched;
        if mount_root.parent().is_none() {
            return Err(viewer::error(
                "E_INVALID",
                "Refusing to eject the system root volume",
            ));
        }

        #[cfg(target_os = "macos")]
        {
            let output = Command::new("diskutil")
                .arg("eject")
                .arg(&mount_root)
                .output()
                .map_err(|err| viewer::error("E_IO", format!("Failed to run diskutil: {err}")))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                let detail = if stderr.is_empty() {
                    String::from_utf8_lossy(&output.stdout).trim().to_owned()
                } else {
                    stderr
                };
                return Err(viewer::error(
                    "E_IN_USE",
                    format!("Cannot eject {}: {detail}", vol.name),
                ));
            }
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let output = Command::new("gio")
                .arg("mount")
                .arg("-e")
                .arg(&mount_root)
                .output()
                .map_err(|err| viewer::error("E_IO", format!("Failed to run gio mount: {err}")))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                return Err(viewer::error(
                    "E_IN_USE",
                    format!("Cannot eject {}: {stderr}", vol.name),
                ));
            }
        }
        #[cfg(target_os = "windows")]
        {
            return Err(viewer::error(
                "E_UNSUPPORTED",
                "Please use Windows Safely Remove Hardware to eject this card",
            ));
        }

        Ok(EjectReport {
            path: mount_root.to_string_lossy().into_owned(),
            name: vol.name,
            ejected: true,
        })
    })
    .await
    .map_err(|_| viewer::error("E_WORKER", "Volume eject worker stopped unexpectedly"))?
}
