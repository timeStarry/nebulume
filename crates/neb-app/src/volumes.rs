//! Mounted-volume discovery only. This module never mounts, ejects or writes media.
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Volume {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    /// True only when the operating system identifies removable media.
    pub removable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_bytes: Option<u64>,
}

fn volume(
    path: String,
    name: String,
    kind: &str,
    removable: bool,
    available_bytes: Option<u64>,
) -> Volume {
    Volume {
        id: path.clone(),
        name,
        path,
        kind: kind.into(),
        removable,
        available_bytes,
    }
}

pub fn enumerate() -> Result<Vec<Volume>, String> {
    let mut volumes = platform::enumerate()?;
    volumes.sort_by(|a, b| b.removable.cmp(&a.removable).then(a.path.cmp(&b.path)));
    volumes.dedup_by(|a, b| a.path == b.path);
    Ok(volumes)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ptr;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLogicalDriveStringsW(length: u32, buffer: *mut u16) -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn GetDiskFreeSpaceExW(
            root: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
        fn GetVolumeInformationW(
            root: *const u16,
            name: *mut u16,
            name_size: u32,
            serial: *mut u32,
            component_length: *mut u32,
            flags: *mut u32,
            filesystem: *mut u16,
            filesystem_size: u32,
        ) -> i32;
        fn SetThreadErrorMode(mode: u32, previous: *mut u32) -> i32;
    }

    struct ErrorMode(Option<u32>);
    impl Drop for ErrorMode {
        fn drop(&mut self) {
            if let Some(previous) = self.0 {
                // SAFETY: restores this worker thread's previous mode; no pointers are retained.
                unsafe {
                    SetThreadErrorMode(previous, ptr::null_mut());
                }
            }
        }
    }

    pub fn enumerate() -> Result<Vec<Volume>, String> {
        // Avoid OS "insert disk" popups for empty card readers and optical drives.
        let mut previous = 0;
        // SAFETY: valid output pointer for the duration of the Win32 call.
        let changed = unsafe { SetThreadErrorMode(1, &mut previous) } != 0;
        let _mode = ErrorMode(changed.then_some(previous));
        // SAFETY: a zero-length probe does not dereference the null buffer.
        let needed = unsafe { GetLogicalDriveStringsW(0, ptr::null_mut()) };
        if needed == 0 || needed > 32768 {
            return Err("Cannot enumerate Windows drive roots".into());
        }
        let mut buffer = vec![0u16; needed as usize + 1];
        // SAFETY: buffer has the exact advertised capacity in UTF-16 code units.
        let used = unsafe { GetLogicalDriveStringsW(buffer.len() as u32, buffer.as_mut_ptr()) };
        if used == 0 || used as usize >= buffer.len() {
            return Err("Drive list changed; refresh the volumes".into());
        }
        let mut result = Vec::new();
        for root in buffer[..used as usize]
            .split(|unit| *unit == 0)
            .filter(|root| !root.is_empty())
        {
            let path = String::from_utf16_lossy(root);
            let root = root.iter().copied().chain([0]).collect::<Vec<_>>();
            // SAFETY: root is NUL-terminated UTF-16 and remains alive through all calls.
            let drive_type = unsafe { GetDriveTypeW(root.as_ptr()) };
            let (kind, removable) = match drive_type {
                2 => ("removable", true),
                3 => ("fixed", false),
                4 => ("network", false),
                5 => ("optical", true),
                6 => ("ram", false),
                _ => ("unknown", false),
            };
            let mut name = [0u16; 1024];
            // SAFETY: name is writable; other optional outputs are explicitly null.
            let named = unsafe {
                GetVolumeInformationW(
                    root.as_ptr(),
                    name.as_mut_ptr(),
                    name.len() as u32,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    0,
                )
            } != 0;
            let name = if named {
                String::from_utf16_lossy(
                    &name[..name
                        .iter()
                        .position(|unit| *unit == 0)
                        .unwrap_or(name.len())],
                )
            } else {
                String::new()
            };
            let mut available = 0u64;
            // SAFETY: available is a valid u64 output; other outputs are optional.
            let ready = unsafe {
                GetDiskFreeSpaceExW(
                    root.as_ptr(),
                    &mut available,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            } != 0;
            result.push(volume(
                path.clone(),
                if name.is_empty() { path } else { name },
                kind,
                removable,
                ready.then_some(available),
            ));
        }
        Ok(result)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::{ffi::CString, fs, path::Path};

    fn unescape(value: &str) -> String {
        let mut output = Vec::new();
        let bytes = value.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\\'
                && i + 3 < bytes.len()
                && bytes[i + 1..=i + 3]
                    .iter()
                    .all(|b| (b'0'..=b'7').contains(b))
            {
                let value = (bytes[i + 1] - b'0') as u16 * 64
                    + (bytes[i + 2] - b'0') as u16 * 8
                    + (bytes[i + 3] - b'0') as u16;
                if value <= 255 {
                    output.push(value as u8);
                    i += 4;
                    continue;
                }
            }
            output.push(bytes[i]);
            i += 1;
        }
        String::from_utf8_lossy(&output).into_owned()
    }

    fn free_bytes(path: &str) -> Option<u64> {
        let path = CString::new(path).ok()?;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: path is NUL-terminated and stat points to enough writable storage.
        if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: a successful statvfs call initializes the entire structure.
        let stat = unsafe { stat.assume_init() };
        stat.f_bavail.checked_mul(stat.f_frsize)
    }

    fn removable(device: &str) -> bool {
        let Ok(device) = fs::canonicalize(format!("/sys/dev/block/{device}")) else {
            return false;
        };
        // A partition's flag lives on its parent block device on Linux.
        device.ancestors().take(3).any(|path| {
            fs::read_to_string(path.join("removable")).is_ok_and(|flag| flag.trim() == "1")
        })
    }

    pub fn enumerate() -> Result<Vec<Volume>, String> {
        let mounts = fs::read_to_string("/proc/self/mountinfo")
            .map_err(|error| format!("Cannot read mounted volumes: {error}"))?;
        let mut result = Vec::new();
        for line in mounts.lines() {
            let Some((left, right)) = line.split_once(" - ") else {
                continue;
            };
            let fields: Vec<_> = left.split_whitespace().collect();
            let details: Vec<_> = right.split_whitespace().collect();
            if fields.len() < 5 || details.len() < 2 {
                continue;
            }
            let path = unescape(fields[4]);
            let filesystem = details[0];
            let source = unescape(details[1]);
            let network = matches!(
                filesystem,
                "nfs" | "nfs4" | "cifs" | "smb3" | "fuse.sshfs" | "davfs" | "fuse.davfs"
            );
            let disk =
                source.starts_with("/dev/") && !matches!(source.as_str(), "/dev" | "/dev/root");
            if path != "/"
                && !disk
                && !network
                && !path.starts_with("/media/")
                && !path.starts_with("/run/media/")
                && !path.starts_with("/mnt/")
            {
                continue;
            }
            if matches!(
                filesystem,
                "proc"
                    | "sysfs"
                    | "devtmpfs"
                    | "devpts"
                    | "tmpfs"
                    | "cgroup"
                    | "cgroup2"
                    | "securityfs"
                    | "debugfs"
                    | "tracefs"
                    | "pstore"
                    | "mqueue"
            ) {
                continue;
            }
            let optical = matches!(filesystem, "iso9660" | "udf");
            let removable = optical || removable(fields[2]);
            let kind = if optical {
                "optical"
            } else if network {
                "network"
            } else if removable {
                "removable"
            } else if disk {
                "fixed"
            } else {
                "unknown"
            };
            let name = Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("Filesystem")
                .to_string();
            // Avoid contacting offline network mounts while refreshing removable cards.
            let available = if network { None } else { free_bytes(&path) };
            result.push(volume(path, name, kind, removable, available));
        }
        Ok(result)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn mountinfo_escapes_preserve_paths_with_spaces_and_backslashes() {
            assert_eq!(
                unescape(r"/media/My\040Card\134Files"),
                "/media/My Card\\Files"
            );
            assert_eq!(unescape(r"/mnt/invalid\777"), r"/mnt/invalid\777");
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    fn string(bytes: &[libc::c_char]) -> String {
        String::from_utf8_lossy(
            &bytes
                .iter()
                .take_while(|byte| **byte != 0)
                .map(|byte| *byte as u8)
                .collect::<Vec<_>>(),
        )
        .into_owned()
    }

    pub fn enumerate() -> Result<Vec<Volume>, String> {
        // MNT_NOWAIT returns cached mount statistics without contacting offline shares.
        let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
        if count < 0 {
            return Err("Cannot enumerate mounted volumes".into());
        }
        let capacity = (count as usize + 16).min(4096);
        let mut mounts: Vec<libc::statfs> = Vec::with_capacity(capacity);
        let bytes = capacity
            .checked_mul(std::mem::size_of::<libc::statfs>())
            .ok_or("Mount table is too large")?;
        // SAFETY: getfsstat initializes at most capacity complete entries; length is set below.
        let count =
            unsafe { libc::getfsstat(mounts.as_mut_ptr(), bytes as libc::c_int, libc::MNT_NOWAIT) };
        if count < 0 {
            return Err("Cannot read mounted volumes".into());
        }
        unsafe {
            mounts.set_len((count as usize).min(capacity));
        }
        Ok(mounts
            .iter()
            .filter(|mount| mount.f_flags & libc::MNT_DONTBROWSE as u32 == 0)
            .map(|mount| {
                let path = string(&mount.f_mntonname);
                let filesystem = string(&mount.f_fstypename);
                let optical = matches!(filesystem.as_str(), "cd9660" | "udf");
                let network = mount.f_flags & libc::MNT_LOCAL as u32 == 0;
                let kind = if optical {
                    "optical"
                } else if network {
                    "network"
                } else {
                    "unknown"
                };
                let name = std::path::Path::new(&path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Filesystem")
                    .to_string();
                volume(
                    path,
                    name,
                    kind,
                    optical,
                    mount.f_bavail.checked_mul(mount.f_bsize as u64),
                )
            })
            .collect())
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod platform {
    use super::*;
    pub fn enumerate() -> Result<Vec<Volume>, String> {
        Err(
            "Automatic volume discovery is unavailable on this platform; select a folder instead"
                .into(),
        )
    }
}

#[cfg(all(test, any(windows, target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;
    #[test]
    fn native_volume_discovery_returns_real_mounted_roots() {
        let volumes = enumerate().unwrap();
        assert!(!volumes.is_empty());
        assert!(volumes
            .iter()
            .all(|volume| !volume.id.is_empty() && !volume.path.is_empty()));
    }
}
