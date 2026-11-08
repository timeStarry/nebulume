//! Classifies paths dropped on the main window. Nothing is read beyond file
//! metadata: folders become library candidates, image files are opened.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct DroppedPaths {
    pub folders: Vec<String>,
    pub images: Vec<String>,
    /// Neither a folder nor a supported image, or not representable as Unicode.
    pub ignored: usize,
}

pub fn classify(paths: &[PathBuf]) -> DroppedPaths {
    let mut dropped = DroppedPaths::default();
    for path in paths {
        let Some(text) = path.to_str().map(str::to_owned) else {
            dropped.ignored += 1;
            continue;
        };
        if path.is_dir() {
            dropped.folders.push(text);
        } else if path.is_file() && is_image(path) {
            dropped.images.push(text);
        } else {
            dropped.ignored += 1;
        }
    }
    dropped
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| neb_core::image_kind(&extension.to_ascii_lowercase()).is_some())
}

#[tauri::command]
pub fn classify_dropped(paths: Vec<PathBuf>) -> DroppedPaths {
    classify(&paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_and_images_are_separated_and_other_files_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Trip");
        std::fs::create_dir(&folder).unwrap();
        let photo = dir.path().join("IMG_0001.JPG");
        std::fs::write(&photo, b"jpeg").unwrap();
        let raw = dir.path().join("DSC_0002.nef");
        std::fs::write(&raw, b"raw").unwrap();
        let note = dir.path().join("notes.txt");
        std::fs::write(&note, b"text").unwrap();
        let gone = dir.path().join("missing.jpg");
        let dropped = classify(&[folder.clone(), photo.clone(), raw.clone(), note, gone]);
        assert_eq!(dropped.folders, vec![folder.to_str().unwrap().to_owned()]);
        assert_eq!(
            dropped.images,
            vec![
                photo.to_str().unwrap().to_owned(),
                raw.to_str().unwrap().to_owned()
            ]
        );
        assert_eq!(dropped.ignored, 2);
    }
}
