# Native application

The manager and every independent viewer share one `Arc<Service>` within the process. `open_viewer({assetId, assetIds})` validates the selected catalog asset, then creates a new `viewer-*` window. The URL contains only `?viewer=1`; image identifiers live in native window-specific state. `viewer_context()` reads only the calling window's `{asset_id, asset_ids}`. Sessions preserve navigation order, deduplicate identifiers, limit each window to 10,000 images and the process to 16 viewers, and are removed on window destruction. The manager has no viewer context.

Viewer capabilities allow the window to close itself, query/change fullscreen and use explicit file/save dialogs. Closing a viewer opened from the manager leaves the manager open. `show_manager()` shows or recreates the independent manager. A command-line file launch initially hides the manager; closing its last viewer exits if the manager was never shown.

## Opening image files

`nebulume image.jpg` and `nebulume -- "path with spaces/image.dng"` accept up to 100 positional files. Local file URLs are also supported. Each path calls the shared `file.open` command, which indexes only that image in the core's hidden external-file catalog; this entry point does not scan its containing directory. Successful files open together in one viewer. Failed files produce a visible native error dialog without preventing other supplied images from opening. Non-Unicode filenames fail explicitly instead of being opened under a lossy path.

macOS file-open events use `RunEvent::Opened`. Windows/Linux file associations supply command-line arguments. The official single-instance plugin is registered before other plugins: later invocations forward paths into the existing process and resolve relative paths against the launching process's working directory. An invocation with no files shows the existing manager. Requests received before service initialization wait until `RunEvent::Ready`. Linux single-instance forwarding requires its desktop session D-Bus; sandboxed packages need the matching D-Bus permission. The plugin transports Unicode arguments; non-Unicode filenames are not a supported file-association workflow.

Installed bundle metadata declares supported raster and basic RAW extensions with a Viewer role; it excludes CR3, HEIC/HEIF and AVIF. Individual RAW camera/compression support remains decoder-dependent. Development/unbundled executables do not install associations, and this application does not change the user's system default image viewer.

## Mounted volumes

`list_volumes()` returns `{id,name,path,kind,removable,available_bytes?}`. It is read-only and runs outside the UI thread. The identifier is the current mount path, not a physical-card identity. The directory picker remains available for cameras mounted through other software, unlisted folders and arbitrary import locations.

- Windows uses `GetLogicalDriveStringsW`, `GetDriveTypeW`, `GetVolumeInformationW` and `GetDiskFreeSpaceExW`; empty readers remain listed, and unavailable space is omitted. Worker-thread critical-error dialogs are suppressed and the prior mode is restored.
- Linux reads `/proc/self/mountinfo`, decodes escaped mount paths, uses `/sys/dev/block` removable flags, and queries `statvfs` for local space. Network mounts omit space to avoid contacting an offline share during card discovery.
- macOS uses `getfsstat(MNT_NOWAIT)` cached mount data. Generic local mounts are marked `unknown`: this API does not reliably identify removable SD/USB media. Optical media is identified separately.

`removable: false` means the enumeration did not identify removable media; it is not a guarantee that a disk is internal. No OS-specific mount, eject, formatting or SD-card writes occur. USB bridges and readers may report fixed or unknown media, and only currently mounted volumes can be selected.

## Validation

`cargo test -p neb-app` covers viewer-context bounds/order, command-line path handling, forwarded working directories, requests queued before service readiness, codec association boundaries and real mounted-volume discovery. Linux also tests mountinfo escape decoding. `cargo check -p neb-app` validates native APIs and generated Tauri capability/config schemas. Actual multiwindow/fullscreen, process forwarding and installed OS file associations require native runtime testing; macOS-specific code requires a macOS build before distribution.

API sources: [Tauri configuration](https://v2.tauri.app/reference/config/), [Tauri single instance](https://v2.tauri.app/plugin/single-instance/), [Tauri file-open events](https://tauri.app/learn/mobile-file-associations/), [Windows drive enumeration](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getlogicaldrivestringsw), [Windows drive types](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew).
