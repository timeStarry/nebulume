# Nebulume UI

SolidJS + TypeScript + Vite. The desktop application calls the shared Rust service through `invoke('execute', { command, params })`; see `../../docs/API.md`. The browser fallback is an explicit, memory-only demonstration using files selected by the user. It never reports successful native import or remote storage operations.

## Run and validate

```sh
pnpm --filter @nebulume/ui dev
pnpm --filter @nebulume/ui build
pnpm --filter @nebulume/ui test
pnpm --filter @nebulume/ui test:browser
```

Browser tests use Playwright Chromium by default (`pnpm exec playwright install chromium`). Set `NEBULUME_BROWSER_CHANNEL=msedge` or `chrome` to use an installed browser. The tests reuse a Nebulume dev server on port 5173 or start one. The root native-service smoke test separately validates the UI against actual Rust commands.

## Interaction and boundaries

- Four main workspaces: library management, storage sources, memory-card import and settings. Startup shows library cards; opening a library shows its paged grid, search/rating filters and an optional detail inspector. A breadcrumb returns to management.
- Double click or `Enter` opens a separate native viewer window. Its URL contains only `?viewer=1`; `viewer_context` retrieves the asset IDs scoped to the calling window. The browser demonstration uses a focus-contained immersive overlay. A native file picker also opens individual images without scanning the containing folder.
- The black viewer keeps management navigation out of the image area. Its toolbar hides when idle; `I` toggles metadata/RGB histograms, arrows switch images, `0–5` rates, `C` crops, `F` toggles full screen and `Esc` exits crop/full screen/viewer in order. It supports fit/preview-pixel 1:1, wheel zoom and drag panning. Typing controls suspend global photo shortcuts. Navigation is held during mutations so a delayed response cannot replace another image.
- `Ctrl/Cmd+F` focuses collection search. The settings workspace explains shortcuts/runtime capabilities and persists thumbnail-size preference locally.
- Crop gestures and numeric fields use normalized oriented-original coordinates. Saved previews/histograms use the recipe, while editing explicitly requests `uncropped: true`. Recipe changes invalidate all image resources. Original files remain unchanged.
- The viewer requests a maximum 2400-pixel display preview; its 1:1 view refers to decoded preview pixels. Full-resolution/tiled viewing is not implemented in this alpha.
- Thumbnails request previews only after entering the viewport/nearby overscan, with at most four active preview requests per window. Directory browsing never hydrates photos. Remote source locations are displayed instead of internal cache paths. “重新读取原图” invokes `asset.refresh` and invalidates preview/histogram resources without losing ratings or crop recipes.
- The import workspace offers detected removable volumes plus manual directory selection. Destinations are visible local libraries. Its source/library → immutable plan → explicit review → results flow stays mounted while switching workspaces. It consumes backend automatic-indexing results, with a fallback scan for older services; copy errors and indexing errors remain distinct. Per-file failures and history are visible. Date layout uses EXIF dates and `unknown-date` for absent dates.
- Storage sources have connection tests, reconnect settings and paged directory browsing. A directory can become a library using `storage_id` and `prefix`, without exposing a backend-specific library form. Failed connection checks are failures even when the RPC itself returns successfully; an unverified source can still be browsed.
- Credentials default to OS secure storage; the form explains session-only mode and deletion of an existing system credential when opting out. Existing blank identity/secret fields preserve saved credentials, and no secret is returned into the form. Synthetic tests explicitly opt out of persistence.
- Connection errors present short Chinese recovery steps for untrusted/changed certificates, missing credentials, rejected authentication, locked system credential stores and common network failures. Original diagnostics remain inside a collapsed details disclosure; source-level errors offer a direct connection-settings action.
- LAN HTTP is explicitly marked as unencrypted; network scope is enforced by the backend. HTTPS defaults to standard certificate validation. Device-certificate trust first inspects the current endpoint without credentials, displays the certificate and SHA-256 fingerprint, and requires explicit user confirmation before saving a new pin. Reopening unchanged settings retains an already approved pin at that exact endpoint. Address changes, policy changes and repeated inspection revoke that retained trust/confirmation; request versions reject delayed results. Restoring standard validation explicitly sends a null pin. The browser demonstration cannot inspect or connect to devices.
- Search, minimum rating, RAW/JPEG format, sort field and ascending/descending direction combine in a whole-library query before pagination. Library settings persist optional unambiguous RAW/JPEG pairing; merged cards can open either original independently. Histograms describe rendered RGB values, not RAW sensor data; aperture, shutter and ISO appear directly below the histogram.
- Libraries can be renamed, rebound to a source directory, or removed. Name/pairing edits preserve ratings and recipes; rebinding requires a separate confirmation before clearing the previous index/recipes. Source removal is blocked while libraries reference it. Removal never deletes originals; unused source removal also forgets its saved credentials.
- Unsupported RAW sensor decoding may use a bounded standard-TIFF embedded JPEG for viewing and RGB histograms. Both views explicitly identify the camera preview; preview-only dimensions are labeled, and JPEG export still requires successful sensor decoding. Common EXIF parameters are readable without ASCII padding; all valid raw EXIF fields remain in a collapsed disclosure.
- Browser mode decodes only formats supported by the browser; EXIF, native RAW, durable index, SD card and remote access require the desktop service. Browser metadata, ratings and recipes disappear when the page closes.

## Verification completed

- TypeScript and production Vite build.
- Forty focused unit tests cover crop coordinates, real pixel histograms, rendition labels, image invalidation, shortcut safety, native capability boundaries, TLS approval/retention and asynchronous races, local import destinations, remote location presentation, connection-check semantics, actionable storage diagnostics, preview concurrency after success/failure, exposure-field aliases and library queries/variant navigation.
- Nineteen Playwright workflows cover real PNG selection/crop/reset/JPEG download, modal keyboard focus, TLS/HTTP trust and reconnection, late-response/error handling, the four-workspace hierarchy, scoped native viewer routing, directory-to-library creation, reviewed import and automatic indexing, failed browse status synchronization, embedded RAW preview labels and EXIF disclosure, delayed edit/navigation with original-refresh invalidation, combined sorting/filtering/pagination, library settings and RAW/JPEG pairing, failed rebind cleanup, and removal/reference protection. Test IPC fixtures verify UI contracts; they are not real network transport or native OS window tests.
- `node scripts/smoke.mjs --ui` validates the UI against the real Rust stdio service for scan, previews, rating, crop and JPEG export, with separate browser-popup viewer context and 1440/960 px layouts. Native window creation remains a separate desktop integration concern.
- Inspected screenshots are generated under `test-results/` and root `artifacts/`, both ignored by Git.
