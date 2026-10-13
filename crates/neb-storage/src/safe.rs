use anyhow::{bail, Context, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

/// Storage keys are portable relative paths, not filesystem paths or URLs.
pub fn validate_key(key: &str, allow_empty: bool) -> Result<()> {
    if key.is_empty() {
        if allow_empty {
            return Ok(());
        }
        bail!("Empty storage key");
    }
    if !allow_empty && key.ends_with('/') {
        bail!("File keys must not end with a separator");
    }
    if key.starts_with('/') || key.contains(['\\', ':', '\0', '?', '*', '"', '<', '>', '|']) {
        bail!("Invalid storage key");
    }
    for part in key.trim_end_matches('/').split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.chars().any(char::is_control)
        {
            bail!("Unsafe storage key component");
        }
        let stem = part.split('.').next().unwrap_or("").to_uppercase();
        if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            bail!("Reserved filename");
        }
    }
    Ok(())
}

pub(crate) fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

/// Reject links, reparse points and components outside the selected root.
pub fn safe_join(root: &Path, key: &str, allow_empty: bool) -> Result<PathBuf> {
    validate_key(key, allow_empty)?;
    let root = fs::canonicalize(root).context("Storage root is unavailable")?;
    let mut current = root.clone();
    for part in Path::new(key).components() {
        match part {
            Component::Normal(name) => current.push(name),
            _ => bail!("Invalid relative path"),
        }
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() || is_reparse(&metadata) {
                bail!("Links and reparse points are not followed");
            }
            if !fs::canonicalize(&current)?.starts_with(&root) {
                bail!("Path escaped the storage root");
            }
        }
    }
    Ok(current)
}

pub fn open_scoped(root: &Path, key: &str) -> Result<File> {
    safe_join(root, key, false)?;
    // Capability-relative open also confines a concurrently replaced ancestor.
    let dir = cap_std::fs::Dir::open_ambient_dir(root, cap_std::ambient_authority())?;
    Ok(dir.open(key)?.into_std())
}

pub fn hash_reader(reader: &mut impl Read) -> Result<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut size = 0;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        size += count as u64;
    }
    Ok((size, hex::encode(hasher.finalize())))
}

/// Stream to an owned sibling temporary file, fsync, re-read SHA-256, then
/// atomically publish without replacement. Original sources are never removed.
pub fn publish_reader(
    reader: &mut dyn Read,
    destination: &Path,
    expected: Option<&str>,
) -> Result<(u64, String)> {
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .context("Destination must have a parent directory")?;
    if !parent.is_dir() {
        bail!("Destination parent does not exist");
    }
    let parent = fs::canonicalize(parent)?;
    let name = destination
        .file_name()
        .context("Destination filename is missing")?;
    validate_key(&name.to_string_lossy(), false)?;
    PreparedDestination::new(&parent)?.materialize()?.publish(
        reader,
        &name.to_string_lossy(),
        expected,
    )
}

/// Holds the nearest existing ancestor during review. No directories are made
/// until execution; each missing component is then created/opened without links.
pub struct PreparedDestination {
    ancestor: Dir,
    missing: Vec<String>,
}

impl PreparedDestination {
    pub fn new(path: &Path) -> Result<Self> {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()?.join(path)
        };
        let mut anchor = PathBuf::new();
        let mut names = Vec::new();
        for component in absolute.components() {
            match component {
                Component::Prefix(prefix) => anchor.push(prefix.as_os_str()),
                Component::RootDir => anchor.push(component.as_os_str()),
                Component::Normal(name) => {
                    let name = name.to_str().context("Destination must be valid Unicode")?;
                    validate_key(name, false)?;
                    names.push(name.to_string());
                }
                _ => bail!("Destination must not contain traversal components"),
            }
        }
        let mut ancestor = Dir::open_ambient_dir(anchor, cap_std::ambient_authority())?;
        for (index, name) in names.iter().enumerate() {
            match ancestor.open_dir_nofollow(name) {
                Ok(directory) => ancestor = directory,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Self {
                        ancestor,
                        missing: names[index..].to_vec(),
                    })
                }
                Err(error) => {
                    return Err(error).context("Destination ancestor is inaccessible or is a link")
                }
            }
        }
        Ok(Self {
            ancestor,
            missing: Vec::new(),
        })
    }

    pub fn materialize(&self) -> Result<ScopedDestination> {
        let mut directory = self.ancestor.try_clone()?;
        for name in &self.missing {
            match directory.create_dir(name) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            directory = directory
                .open_dir_nofollow(name)
                .context("Destination directory was replaced by a link")?;
        }
        Ok(ScopedDestination { directory })
    }
}

/// All target filesystem operations are relative to pinned directory handles.
pub struct ScopedDestination {
    directory: Dir,
}

impl ScopedDestination {
    fn parent(&self, key: &str, create: bool) -> Result<(Dir, String)> {
        validate_key(key, false)?;
        let mut parts: Vec<_> = key.split('/').collect();
        let filename = parts.pop().context("Missing target filename")?.to_string();
        let mut directory = self.directory.try_clone()?;
        for part in parts {
            if create {
                match directory.create_dir(part) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
            }
            directory = directory
                .open_dir_nofollow(part)
                .context("Target directory is unavailable or was replaced by a link")?;
        }
        Ok((directory, filename))
    }

    pub fn exists(&self, key: &str) -> Result<bool> {
        match self
            .parent(key, false)
            .and_then(|(directory, name)| Ok(directory.symlink_metadata(name)?))
        {
            Ok(_) => Ok(true),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    pub fn reader(&self, key: &str) -> Result<File> {
        let (directory, name) = self.parent(key, false)?;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        Ok(directory.open_with(name, &options)?.into_std())
    }

    pub fn publish(
        &self,
        reader: &mut dyn Read,
        key: &str,
        expected: Option<&str>,
    ) -> Result<(u64, String)> {
        let (parent, name) = self.parent(key, true)?;
        if parent.symlink_metadata(&name).is_ok() {
            bail!("Destination already exists; replacement is forbidden");
        }
        let temporary_name = format!(".nebulume-{}.partial", uuid::Uuid::new_v4());
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut temporary = parent.open_with(&temporary_name, &options)?.into_std();
        let outcome = (|| -> Result<(u64, String)> {
            let mut hasher = Sha256::new();
            let mut size = 0;
            let mut buffer = [0u8; 128 * 1024];
            loop {
                let count = reader.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                temporary.write_all(&buffer[..count])?;
                hasher.update(&buffer[..count]);
                size += count as u64;
            }
            temporary.sync_all()?;
            let hash = hex::encode(hasher.finalize());
            if expected.is_some_and(|expected| expected != hash) {
                bail!("Source content changed after planning");
            }
            temporary.seek(SeekFrom::Start(0))?;
            if hash_reader(&mut temporary)? != (size, hash.clone()) {
                bail!("Destination readback verification failed");
            }
            // link creation is atomic and never replaces an existing entry.
            // Filesystems without hard links fail safely; there is no path fallback.
            parent.hard_link(&temporary_name, &parent, &name).context("Safe publication failed: destination must support hard links (FAT/exFAT destinations are not supported), and the filename must remain free")?;
            let mut committed = parent.open(&name)?.into_std();
            if hash_reader(&mut committed)? != (size, hash.clone()) {
                bail!("Published destination verification failed");
            }
            Ok((size, hash))
        })();
        drop(temporary);
        // Only this operation's randomized temporary name is removed, through
        // the same pinned parent capability; no ambient or discovered paths.
        let _ = parent.remove_file(&temporary_name);
        outcome
    }
}

pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("JSON destination needs a parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut temporary, value)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}
