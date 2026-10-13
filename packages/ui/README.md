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

- Library rail, paged collection grid, single-image viewer with fit/preview-pixel 1:1, drag panning, wheel zoom and filmstrip; the right inspector shows real image metadata and RGB histograms.
- `G` grid, `E` single image, arrows previous/next, `0–5` rating, `C` crop, `Esc` cancel crop/back to grid, `Ctrl/Cmd+F` search. Typing controls and dialogs suspend global photo shortcuts.
- Crop gestures and numeric fields use normalized oriented-original coordinates. Saved previews/histograms use the recipe, while editing explicitly requests `uncropped: true`. Recipe changes invalidate all image resources. Original files remain unchanged.
- The viewer requests a maximum 2400-pixel display preview; its 1:1 view refers to decoded preview pixels. Full-resolution/tiled viewing is not implemented in this alpha.
- Import is a source/destination → immutable plan → explicit in-dialog review → execution/result flow. Pending/duplicate statuses, warnings and per-file results remain visible. Date layout uses EXIF dates and `unknown-date` for absent dates.
- Remote connections support browsing and downloading new local files. Session-only credentials and service errors are visible; adding the same source can reconnect it after restart.
- Grid sorting applies to the currently loaded page; the UI shows loaded/total counts and a load-more control. Histograms describe rendered RGB values, not RAW sensor data.
- Browser mode decodes only formats supported by the browser; EXIF, native RAW, durable index, SD card and remote access require the desktop service. Browser metadata, ratings and recipes disappear when the page closes.

## Verification completed

- TypeScript and production Vite build.
- Nine focused unit tests: normalized crop edge cases, pixel-derived histograms, crop resource invalidation, keyboard typing safety, service error propagation and honest browser capability boundaries.
- Two Playwright browser workflows: genuine PNG file selection, histogram, rating, input keyboard safety, saved crop/re-edit/reset, real JPEG download, narrow desktop layout and modal Escape handling.
- UI screenshots are generated in `test-results/` and ignored by Git.
