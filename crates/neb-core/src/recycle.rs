//! Moving originals to the system Trash and putting them back.
//!
//! macOS asks `NSFileManager` directly: it reports where each item landed, so an
//! undo moves that exact file back and no Finder automation permission is needed.
//! Other platforms use the freedesktop / Windows recycle bin through `trash`.
use anyhow::{bail, ensure, Context, Result};
use std::path::{Path, PathBuf};

/// Moves `path` to the Trash. Returns where it now is when the platform says so.
pub fn move_to_trash(path: &Path) -> Result<Option<PathBuf>> {
    ensure!(path.is_file(), "E_NOT_FOUND: The original is not available");
    platform::move_to_trash(path)
}

/// Moves a trashed item back to `original`. Never replaces an existing file.
pub fn put_back(original: &Path, trashed: Option<&Path>) -> Result<()> {
    ensure!(
        !original.exists(),
        "E_EXISTS: A file already exists where this photo was; it was left in the Trash"
    );
    platform::put_back(original, trashed)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    pub fn move_to_trash(path: &Path) -> Result<Option<PathBuf>> {
        let text = path.to_str().context("E_PATH: Path is not valid UTF-8")?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        let manager = NSFileManager::defaultManager();
        let mut resulting = None;
        if let Err(error) =
            manager.trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
        {
            bail!("E_TRASH: {}", error.localizedDescription());
        }
        Ok(resulting
            .and_then(|url| url.path())
            .map(|path| PathBuf::from(path.to_string())))
    }

    pub fn put_back(original: &Path, trashed: Option<&Path>) -> Result<()> {
        let trashed = trashed.context("E_TRASH: The Trash location of this photo is unknown")?;
        ensure!(
            trashed.exists(),
            "E_TRASH: The photo is no longer in the Trash"
        );
        std::fs::rename(trashed, original).context("E_TRASH: Could not move the photo back")
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn move_to_trash(path: &Path) -> Result<Option<PathBuf>> {
        trash::delete(path).map_err(|error| anyhow::anyhow!("E_TRASH: {error}"))?;
        Ok(None)
    }

    #[cfg(any(windows, all(unix, not(target_os = "ios"), not(target_os = "android"))))]
    pub fn put_back(original: &Path, _trashed: Option<&Path>) -> Result<()> {
        let items =
            trash::os_limited::list().map_err(|error| anyhow::anyhow!("E_TRASH: {error}"))?;
        let item = items
            .into_iter()
            .filter(|item| item.original_path() == original)
            .max_by_key(|item| item.time_deleted)
            .context("E_TRASH: The photo is no longer in the Trash")?;
        trash::os_limited::restore_all([item]).map_err(|error| anyhow::anyhow!("E_TRASH: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trashed_file_comes_back_to_its_place_and_never_overwrites() {
        let folder = tempfile::tempdir().unwrap();
        let photo = folder.path().join("trash-probe.jpg");
        std::fs::write(&photo, b"jpeg").unwrap();
        let trashed = move_to_trash(&photo).unwrap();
        assert!(!photo.exists());
        std::fs::write(&photo, b"other").unwrap();
        assert!(put_back(&photo, trashed.as_deref()).is_err());
        std::fs::remove_file(&photo).unwrap();
        put_back(&photo, trashed.as_deref()).unwrap();
        assert_eq!(std::fs::read(&photo).unwrap(), b"jpeg");
    }
}
