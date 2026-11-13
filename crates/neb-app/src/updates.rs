//! Update eligibility and pre-install quiescing. Windows NSIS installers and
//! installed macOS `.app` bundles can self-update; portable, read-only disk
//! images, AppTranslocation, Linux, and debug builds report why not.
use neb_service::{CommandError, QuiesceReport, Service};
use serde::Serialize;
use std::{
    path::{Component, Path},
    sync::Arc,
    time::Duration,
};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Other,
}

impl Platform {
    const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Other
        }
    }
}

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

fn macos_bundle_is_updatable(executable: &Path) -> bool {
    let Some(macos_dir) = executable.parent() else {
        return false;
    };
    if macos_dir.file_name().and_then(|name| name.to_str()) != Some("MacOS") {
        return false;
    }
    let Some(contents_dir) = macos_dir.parent() else {
        return false;
    };
    if contents_dir.file_name().and_then(|name| name.to_str()) != Some("Contents") {
        return false;
    }
    let Some(bundle_dir) = contents_dir.parent() else {
        return false;
    };
    if bundle_dir.extension().and_then(|ext| ext.to_str()) != Some("app")
        || bundle_dir.file_stem().is_none()
    {
        return false;
    }
    // Apps opened directly from a mounted DMG (/Volumes/...) or Gatekeeper
    // AppTranslocation sit on read-only filesystems and cannot self-update.
    let mut components = bundle_dir.components();
    if matches!(
        (components.next(), components.next()),
        (Some(Component::RootDir), Some(Component::Normal(first))) if first == "Volumes"
    ) {
        return false;
    }
    !bundle_dir
        .components()
        .any(|part| part.as_os_str() == "AppTranslocation")
}

pub fn install_kind(executable: &Path, debug: bool, platform: Platform) -> InstallKind {
    if debug {
        return InstallKind::Development;
    }
    match platform {
        Platform::Windows => {
            if executable.with_file_name("uninstall.exe").is_file() {
                InstallKind::Installer
            } else {
                InstallKind::Portable
            }
        }
        Platform::MacOs => {
            if macos_bundle_is_updatable(executable) {
                InstallKind::Installer
            } else {
                InstallKind::Portable
            }
        }
        Platform::Other => InstallKind::UnsupportedPlatform,
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
    let platform = Platform::current();
    let kind = match std::env::current_exe() {
        Ok(executable) => install_kind(&executable, cfg!(debug_assertions), platform),
        Err(_) if cfg!(debug_assertions) => InstallKind::Development,
        Err(_) if platform == Platform::Other => InstallKind::UnsupportedPlatform,
        Err(_) => InstallKind::Portable,
    };
    support(kind)
}

#[tauri::command]
pub async fn prepare_for_update(
    service: State<'_, Arc<Service>>,
    pregeneration: State<'_, crate::pregenerate::Pregeneration>,
) -> Result<QuiesceReport, CommandError> {
    // Background rendering must not hold an asset lock while the installer runs.
    pregeneration.cancel();
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
    fn install_kind_uses_uninstaller_beside_executable_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("nebulume.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        assert_eq!(
            install_kind(&exe, false, Platform::Windows),
            InstallKind::Portable
        );
        std::fs::write(dir.path().join("uninstall.exe"), b"MZ").unwrap();
        assert_eq!(
            install_kind(&exe, false, Platform::Windows),
            InstallKind::Installer
        );
        assert_eq!(
            install_kind(&exe, true, Platform::Windows),
            InstallKind::Development
        );
        assert_eq!(
            install_kind(&exe, false, Platform::Other),
            InstallKind::UnsupportedPlatform
        );
    }

    #[test]
    fn macos_app_bundle_supports_updates_except_volumes_and_translocation() {
        let installed = Path::new("/Applications/Lumen.app/Contents/MacOS/nebulume");
        assert_eq!(
            install_kind(installed, false, Platform::MacOs),
            InstallKind::Installer
        );
        assert_eq!(
            install_kind(installed, true, Platform::MacOs),
            InstallKind::Development
        );
        let user_apps = Path::new("/Users/demo/Applications/Lumen.app/Contents/MacOS/nebulume");
        assert_eq!(
            install_kind(user_apps, false, Platform::MacOs),
            InstallKind::Installer
        );
        let dmg_mount = Path::new("/Volumes/Lumen 0.2.2/Lumen.app/Contents/MacOS/nebulume");
        assert_eq!(
            install_kind(dmg_mount, false, Platform::MacOs),
            InstallKind::Portable
        );
        let translocated = Path::new(
            "/private/var/folders/xx/yy/T/AppTranslocation/1234/d/Lumen.app/Contents/MacOS/nebulume",
        );
        assert_eq!(
            install_kind(translocated, false, Platform::MacOs),
            InstallKind::Portable
        );
        let bare_binary = Path::new("/usr/local/bin/nebulume");
        assert_eq!(
            install_kind(bare_binary, false, Platform::MacOs),
            InstallKind::Portable
        );
    }

    #[test]
    fn uninstaller_directory_is_not_an_installer() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("nebulume.exe");
        std::fs::create_dir(dir.path().join("uninstall.exe")).unwrap();
        assert_eq!(
            install_kind(&exe, false, Platform::Windows),
            InstallKind::Portable
        );
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
