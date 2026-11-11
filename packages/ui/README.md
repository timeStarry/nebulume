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
- The black viewer keeps management navigation out of the image area. Its toolbar hides when idle; `I` toggles metadata/RGB histograms, arrows switch images, `0–5` rates, `C` crops, `P` toggles focus regions, `F` toggles full screen and `Esc` exits crop/full screen/viewer in order. It supports fit/preview-pixel 1:1, wheel zoom and drag panning. Typing controls suspend global photo shortcuts. Navigation is held during mutations so a delayed response cannot replace another image.
- Focus regions are off by default; `asset.focus` is requested only while enabled. Current metadata support is limited to exact Nikon AFInfo2 versions `0300` and `0301`. Missing, unsupported or failed metadata has an explicit status, without invented center markers. The overlay represents camera-recorded regions, not a new autofocus or sharpness calculation.
- Focus coordinates are already oriented full-image coordinates. The overlay requires the renderer's `coordinate_mapping`, checks orientation (including rotation and mirroring) and full-image aspect ratio within 1%, then projects through the actual quantized crop. It follows image zoom/pan without intercepting gestures or modifying pixels. Missing/incompatible mapping suppresses the overlay with an explanation; regions outside the crop are omitted. Crop editing temporarily hides focus regions. Image changes, original refreshes and disabling the toggle invalidate pending results so delayed metadata cannot cross images.
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
- Returning focus to the manager does not re-request the list, detail or images. Actual viewer changes synchronize the affected asset: rating changes preserve image resources, while crop/original refresh changes invalidate only affected pixels. Changes that affect query membership, paired representation or sorting trigger a background whole-library reconciliation that preserves the loaded range, scroll position and still-valid selection/detail without first emptying the grid. Failed synchronization is visible and retryable; window focus retries only known pending updates or a failed event listener.
- Libraries can be renamed, rebound to a source directory, or removed. Name/pairing edits preserve ratings and recipes; rebinding requires a separate confirmation before clearing the previous index/recipes. Source removal is blocked while libraries reference it. Removal never deletes originals; unused source removal also forgets its saved credentials.
- Unsupported RAW sensor decoding may use a bounded standard-TIFF embedded JPEG for viewing and RGB histograms. Both views explicitly identify the camera preview; preview-only dimensions are labeled, and JPEG export still requires successful sensor decoding. Common EXIF parameters are readable without ASCII padding; all valid raw EXIF fields remain in a collapsed disclosure.
- Browser mode decodes only formats supported by the browser; EXIF, native RAW, durable index, SD card and remote access require the desktop service. Browser metadata, ratings and recipes disappear when the page closes.

## Design tokens and primitives

Governance rules live in [AGENTS.md](../../AGENTS.md#ui--ux-工程治理铁律); the development and review workflow in [UI_WORKFLOW.md](../../docs/UI_WORKFLOW.md). Values are defined once in [`src/tokens.css`](src/tokens.css), with dark (default) and light sets switched by `data-theme` on `<html>` (`src/theme.ts`). The viewer is dark in both themes and uses the fixed `--nl-v-*` set.

`pnpm check:design` (part of `pnpm test`) rejects, in any CSS outside `src/ui/` and `tokens.css`: hex/`rgb()`/named colours, outer shadows, weights other than 400/500, pixel font sizes, gradients, `blur()`, `backdrop-filter` (`glass`), transitions on layout properties (`layout-transition`) and pixel spacing above 2px in `gap`/`padding`/`margin` (`spacing-px`; use `--nl-s-*` or `calc()` of them). Opt-outs are line comments: `/* design: mask */` (crop mask shadow) and `/* design: bounded */` (one fixed element such as a progress fill; never a grid item).

### Spatial surfaces

Dark theme orders surfaces by lightness: stage < rail < sidebar < canvas < card.

| Role            | Token                            | Alias                        | Use                                                                                      |
| --------------- | -------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| Stage           | `--nl-stage`                     |                              | Viewer and loupe background, dark in both themes                                         |
| Rail            | `--nl-rail`                      |                              | Icon rail                                                                                |
| Sidebar         | `--nl-side`                      | `--nl-surface-sidebar`       | Library tree, settings sub-navigation                                                    |
| Canvas          | `--nl-canvas`                    | `--nl-surface-canvas`        | Main work area and grid background                                                       |
| Card / raised   | `--nl-raised`                    | `--nl-surface-card`          | Buttons, inputs, segmented controls, cards, menus                                        |
| Hover / pressed | `--nl-hover` `--nl-pressed`      |                              | Interaction states                                                                       |
| Overlay glass   | `--nl-glass` + `--nl-glass-blur` | `--nl-v-glass` in the viewer | Floating layers only: toast, HUD, floating dock, menus, viewer toolbar                   |
| Scrim           | `--nl-scrim`                     |                              | Dialog backdrop                                                                          |
| Border subtle   | `--nl-line`                      | `--nl-border-subtle`         | Default 1px divider                                                                      |
| Border strong   | `--nl-line-strong`               |                              | Hover and emphasis                                                                       |
| Highlight       | `--nl-highlight`                 | `--nl-v-highlight`           | Top 1px edge on raised/floating layers (`box-shadow: inset 0 1px 0 var(--nl-highlight)`) |
| Skeleton        | `--nl-skeleton`                  |                              | Static placeholder cells, no shimmer                                                     |

Text: `--nl-text` (primary), `--nl-text-2` (secondary), `--nl-text-3` (hint), `--nl-inverse`. Action: `--nl-primary`, `--nl-primary-hover`, `--nl-ring` (focus ring).

### Photographic semantics

Each state colour always appears with an icon or a word, never alone. Every value exists in both themes.

| Meaning                      | Foreground                                | Tint                                          | Family                                      |
| ---------------------------- | ----------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Pick / keep                  | `--nl-pick`                               | `--nl-tint-pick`                              | Emerald                                     |
| Reject                       | `--nl-reject`                             | `--nl-tint-reject`, `--nl-tint-reject-strong` | Coral                                       |
| Rating stars                 | `--nl-rating` (= `--nl-star`)             | `--nl-tint-rating`                            | Amber gold                                  |
| Remote, not cached           | `--nl-remote`                             | `--nl-tint-remote`                            | Slate blue                                  |
| Crop recipe / read-only edit | `--nl-recipe`                             | `--nl-tint-recipe`                            | Muted violet                                |
| Warning                      | `--nl-warn`                               | `--nl-tint-warn`                              |                                             |
| Info, chart series           | `--nl-info`, `--nl-series`                | `--nl-tint-info`                              |                                             |
| Histogram, AF points, crop   | `--nl-hist-*`, `--nl-af-*`, `--nl-crop-*` |                                               | Photo-content colours, fixed in both themes |

### Space, radius, size, type

| Scale              | Tokens                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spacing (4px grid) | `--nl-s-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-10` 40                                                                  |
| Radius             | `--nl-r-thumb` 2 (thumbnails) · `-xs` 4 (badges, kbd) · `-sm` 6 (controls) · `-md` 8 (menus, toasts) · `-lg` 12 (dialogs, cards) · `-pill`          |
| Control height     | `--nl-h-xs` 24 · `-sm` 28 · `-md` 32 · `-lg` 40                                                                                                     |
| Layout             | `--nl-rail-width` 56 · `--nl-sidebar-width` 220 · `--nl-aside-width` 300 · `--nl-header-height` 56 · `--nl-toolbar-height` 44 · `--nl-page-max` 760 |
| Type               | `--nl-t-11` … `--nl-t-22`; weights 400/500 only; `--nl-font`, `--nl-mono`; numbers use `tabular-nums` (set on `body`)                               |

### Motion

| Token                             | Value                    | Use                                                                                              |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `--nl-ease`                       | `cubic-bezier(.2,0,0,1)` | Default for every transition                                                                     |
| `--nl-d-fast` / `-base` / `-slow` | 120 / 180 / 280ms        | Hover · open/close · grid-to-viewer                                                              |
| `--nl-spring` + `--nl-d-spring`   | overshoot curve, 220ms   | Segmented thumb, floating dock, single-tile hover, local state flips; `transform`/`opacity` only |
| `--nl-d-hud`                      | 1200ms                   | Blind-action HUD capsule lifetime                                                                |
| `--nl-d-undo`                     | 10000ms                  | Undo toast lifetime                                                                              |

Motion strength is a user setting (Settings → 外观 → 界面动效, `src/motion.ts`), written to `<html data-motion>`: `full` (default when the OS does not ask for less) runs springs and the grid-to-viewer zoom; `standard` maps `--nl-spring` to `--nl-ease` and skips the zoom; `reduced` sets every duration to 0. `system` follows `prefers-reduced-motion`. Style reduced variants with `[data-motion='reduced']`, never the media query directly.

### Primitives (`src/ui/`, exported from `src/ui/index.ts`)

| Primitive                                                                          | Notes                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Button`                                                                           | `primary` `secondary` `ghost` `danger`; `sm`/`md`/`lg`; `busy`; one primary per area |
| `IconButton`                                                                       | Required `label` (aria-label + tooltip); optional shortcut shown as `Kbd`            |
| `Tooltip`, `Kbd`                                                                   | Every high-frequency action shows its key in `<Kbd>`                                 |
| `Field`, `TextInput`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`            | Form controls; inputs keep text selection                                            |
| `Segmented`                                                                        | View switch / single choice; the spring-motion candidate                             |
| `Chip`, `Toggle`, `Badge`, `StatusDot`                                             | Filters, pill toggles, `pick`/`reject`/`warn`/`info` badges                          |
| `Banner`, `Toast`, `Progress`, `EmptyState`                                        | `toasts.show({ message, action })` is the single undo channel (10s with action)      |
| `Group`, `ListRow`                                                                 | All settings rows                                                                    |
| `Dialog`, `Drawer`                                                                 | Focus trap; only for irreversible or wide-scope actions                              |
| `PageHeader`, `Toolbar`, `Spacer`, `SinglePage`, `SplitPage`, `Steps`, `DataTable` | Page skeletons                                                                       |
| `ContextMenu`, `MenuList`                                                          | The only right-click surface; suppresses the WebView menu                            |

| `createHud()` / `Hud.Host` | Blind-action glass capsule (`role="status"`, mounted only while showing) |

Window-level helpers outside `src/ui/`:

- `src/feedback.tsx`: `createFeedback()` owns busy/error/notice/sync-error state, the undo history and the HUD; `<FeedbackStack>` renders them with `Toast`.
- `src/undo.ts`: `createUndoHistory()`; `Ctrl/⌘+Z` reverts the latest entry, the toast reverts its own; a revert waits for the forward write.
- `src/desktop.ts` + `src/ui/desktop.css`: viewport lock, default `user-select: none` with selectable paths/EXIF/inputs, WebView context menu suppressed (Shift+right-click passes in dev builds).
- `src/keymap.ts`: the shortcut table rendered by Settings → 快捷键.

Still planned: `FloatingDock` (batch bar) and a `Skeleton` primitive. New views must not hand-roll them in feature CSS; add them under `src/ui/` first.

## Validation scope

Unit tests cover pure interaction and coordinate behavior; Playwright workflows cover browser UI behavior and IPC contracts. Browser IPC fixtures do not establish real network transport or native OS window behavior. The root `node scripts/smoke.mjs --ui` workflow connects the UI to the Rust stdio service. Generated screenshots belong in ignored `test-results/` or root `artifacts/` directories.

Current verification evidence and platform limitations are maintained in [TESTING.md](../../docs/TESTING.md) and [STATUS.md](../../docs/STATUS.md).
