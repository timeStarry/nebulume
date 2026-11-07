//! Update eligibility and pre-install quiescing. Only the Windows NSIS
//! installer can self-update; portable and debug builds report why not.
use neb_service::{CommandError, QuiesceReport, Service};
use serde::Serialize;
use std::{path::Path, sync::Arc, time::Duration};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    Installer,
    Portable,
    Development,
    UnsupportedPlatform,
}

#[derive(Debug, Serialize)]
pub struct UpdateSupport {
    supported: bool,
    kind: InstallKind,
}

pub fn install_kind(executable: &Path, debug: bool, windows: bool) -> InstallKind {
    if debug {
        InstallKind::Development
    } else if !windows {
        InstallKind::UnsupportedPlatform
    } else if executable.with_file_name("uninstall.exe").is_file() {
        InstallKind::Installer
    } else {
        InstallKind::Portable
    }
}

fn support(kind: InstallKind) -> UpdateSupport {
    UpdateSupport {
        supported: kind == InstallKind::Installer,
        kind,
    }
}

#[tauri::command]
pub fn update_support() -> UpdateSupport {
    // An unknown executable path cannot prove an installer layout.
    let kind = match std::env::current_exe() {
        Ok(executable) => install_kind(&executable, cfg!(debug_assertions), cfg!(windows)),
        Err(_) if cfg!(debug_assertions) => InstallKind::Development,
        Err(_) if !cfg!(windows) => InstallKind::UnsupportedPlatform,
        Err(_) => InstallKind::Portable,
    };
    support(kind)
}

#[tauri::command]
pub async fn prepare_for_update(
    service: State<'_, Arc<Service>>,
) -> Result<QuiesceReport, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.quiesce(Duration::from_secs(5)))
        .await
        .map_err(|_| CommandError {
            code: "E_WORKER",
            message: "Background operation stopped unexpectedly".into(),
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_kind_uses_uninstaller_beside_executable() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("nebulume.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        assert_eq!(install_kind(&exe, false, true), InstallKind::Portable);
        std::fs::write(dir.path().join("uninstall.exe"), b"MZ").unwrap();
        assert_eq!(install_kind(&exe, false, true), InstallKind::Installer);
        assert_eq!(install_kind(&exe, true, true), InstallKind::Development);
        assert_eq!(
            install_kind(&exe, false, false),
            InstallKind::UnsupportedPlatform
        );
    }

    #[test]
    fn uninstaller_directory_is_not_an_installer() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("nebulume.exe");
        std::fs::create_dir(dir.path().join("uninstall.exe")).unwrap();
        assert_eq!(install_kind(&exe, false, true), InstallKind::Portable);
    }

    #[test]
    fn support_serializes_snake_case_and_only_installer_is_supported() {
        assert_eq!(
            serde_json::to_value(support(InstallKind::UnsupportedPlatform)).unwrap(),
            serde_json::json!({"supported": false, "kind": "unsupported_platform"})
        );
        assert_eq!(
            serde_json::to_value(support(InstallKind::Installer)).unwrap(),
            serde_json::json!({"supported": true, "kind": "installer"})
        );
        for kind in [InstallKind::Portable, InstallKind::Development] {
            assert!(!support(kind).supported);
        }
    }
}
