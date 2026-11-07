# Preview Protocol and Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Image bytes reach the webview through a `neb` custom protocol in four fixed tiers instead of base64 `data_url` over JSON IPC; RAW grid thumbnails come from the embedded JPEG first.

**Architecture:** `neb-core` renders a `PreviewImage { jpeg: Bytes-like Vec<u8>, meta }` for a `PreviewTier`; `neb-service` caches it on disk as a binary envelope (meta JSON + raw JPEG) and in a byte-bounded memory LRU; `neb-app` serves `neb://localhost/<id>/<tier>/<crop>/<rev>` from `Service::preview_image`. IPC `asset.preview` keeps returning metadata (size, source, coordinate mapping, asset, inspection extras) but no pixels. The UI builds URLs with `convertFileSrc(..., 'neb')`, loads thumbnails through the existing scheduler with an `Image` + `decode()` loader, and the viewer asks IPC for metadata then shows the URL.

**Tech Stack:** Rust (`image =0.25.6`, `tauri 2.12` `register_asynchronous_uri_scheme_protocol`, `tauri::http`), SolidJS, Vitest, Playwright.

**Spec:** `docs/REFACTOR_DESIGN.md` section 5 (A1, A2, A3 first bullet group). Deviations recorded here:

- URL carries everything in the path (`<id>/<tier>/<crop>/<rev>`), because `convertFileSrc` percent-encodes the whole argument including `?`.
- Responses use `Cache-Control: no-cache` + `ETag` (revalidated with `If-None-Match` → 304 without decoding) instead of `immutable`, because the client revision is not guaranteed to change when a file changes on disk.
- Embedded-JPEG-first applies to grid tiers (`t256`, `t512`, `t1024`) only; the viewer tier keeps the current sensor-first order until the “原始渲染” toggle exists.
- DCT-scaled decode, `fast_image_resize`, ICC, cancellation tokens and background pre-generation are out of scope (later plan).

## Global Constraints

- Tiers and long-side pixels, exactly: `t256`=256, `t512`=512, `t1024`=1024, `p2560`=2560. Serialized names are those strings.
- Legacy `max_size` is still accepted by `asset.preview` for one release and maps to the smallest tier ≥ `max_size` (values > 1024 map to `p2560`); `docs/API.md` marks it deprecated.
- Disk preview cache keys move from `preview-v1:` to `preview-v2:`; old entries are not converted and age out through existing eviction.
- Envelope format: bytes `b"NPV2"`, then `u32` little-endian meta length, then UTF-8 meta JSON, then JPEG bytes. Decoding rejects anything else with `E_CACHE: Invalid preview cache`.
- In-memory preview cache: at most 256 entries and 128 MiB of JPEG bytes, shared by local and remote assets; hits return `Arc<PreviewImage>` without copying bytes.
- Protocol status mapping: 200 JPEG; 304 when `If-None-Match` equals the ETag; 400 malformed path/tier; 404 `E_NOT_FOUND`; 409 `E_DOWNLOAD_REQUIRED`; 415 `E_UNSUPPORTED_CODEC`; 503 `E_CACHE_BUSY`, `E_WORKER`, `E_OFFLINE`; 500 otherwise. Error bodies are `{"code","message"}` JSON with `Content-Type: application/json`.
- ETag: lowercase hex SHA-256 of the full `preview-v2:` cache key, quoted.
- CSP `img-src` becomes `'self' blob: neb: http://neb.localhost`; `data:` is removed from `img-src` (kept in `font-src`).
- Every existing safety property in `docs/REFACTOR_DESIGN.md` section 2 is preserved; in particular `E_DOWNLOAD_REQUIRED` still fires instead of silently widening a range read, and range previews never fall back to a full download unless the existing `may_fallback` rule allows it.
- Viewer windows already have `core:default`; the protocol needs no new capability.

## Review Focus

- Fast scrolling through 1,000+ thumbnails: images that left the viewport are dropped from the queue and do not replace newer images in reused cells. → test in Task 4.
- An asset whose file changed on disk after its thumbnail was cached: the next load returns the new image (ETag differs), not a stale 304. → test in Task 2.
- A remote RAW whose embedded preview exceeds the range budget, opened in the viewer: the viewer still shows the existing “获取原图后重试” entry, and grid cells show the RAW fallback tile instead of a broken image icon. → tests in Task 2 and Task 4.
- An asset id containing characters outside `[0-9a-f-]` or a tier like `t9999` in the URL: 400, never a filesystem lookup. → test in Task 3.
- High-DPI screen with the grid slider at its maximum (320 css px at dpr 2): `t1024` is requested, not `p2560`. → test in Task 4.

---

## File Structure

| File                                                                                  | Responsibility                                                                     |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `crates/neb-core/src/preview.rs` (new)                                                | `PreviewTier`, `PreviewImage`, envelope encode/decode, `PreviewMemory` LRU         |
| `crates/neb-core/src/imaging.rs`                                                      | rendering returns `PreviewImage`; tier-aware RAW source order                      |
| `crates/neb-core/src/catalog.rs`                                                      | `Core::preview_image`; `asset.preview` uses tiers; old `previews` VecDeque removed |
| `crates/neb-core/src/lib.rs`                                                          | re-exports                                                                         |
| `crates/neb-service/src/remote_cache.rs`                                              | `preview_image` replaces `render_preview`; v2 keys and envelope                    |
| `crates/neb-service/src/lib.rs`                                                       | public `Service::preview_image`, `Service::preview_etag`                           |
| `crates/neb-app/src/preview_protocol.rs` (new)                                        | path parsing, response building, registration                                      |
| `crates/neb-app/src/main.rs`, `tauri.conf.json`                                       | register protocol, CSP                                                             |
| `packages/ui/src/preview-url.ts` (new)                                                | `previewTier`, `previewUrl`, `loadImage`                                           |
| `packages/ui/src/PhotoView.tsx`, `ManagementApp.tsx`, `model.ts`, `api.ts`, `demo.ts` | consumers                                                                          |
| `packages/ui/tests/browser/*.spec.ts`                                                 | fixtures switch from `data_url` to URLs                                            |
| `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/STATUS.md`, `CHANGELOG.md`               | documentation                                                                      |

---

### Task 1: Core preview types, envelope, memory cache, tier-aware rendering

**Files:**

- Create: `crates/neb-core/src/preview.rs`
- Modify: `crates/neb-core/src/imaging.rs:285-330,528-608`, `crates/neb-core/src/catalog.rs:24-29,226-240,1432-1475`, `crates/neb-core/src/lib.rs`
- Test: unit tests in `preview.rs`; update `crates/neb-core/tests/catalog.rs:257,519-523`

**Interfaces:**

- Produces:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewTier { T256, T512, T1024, P2560 }
impl PreviewTier {
    pub fn pixels(self) -> u32;                       // 256, 512, 1024, 2560
    pub fn as_str(self) -> &'static str;              // "t256" ...
    pub fn parse(name: &str) -> Option<Self>;
    pub fn for_max_size(max_size: u32) -> Self;       // smallest tier >= max_size, else P2560
    pub fn prefers_embedded(self) -> bool;            // true for T256, T512, T1024
}
pub struct PreviewImage {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub source: String,
    pub coordinate_mapping: Option<serde_json::Value>,
    pub extras: serde_json::Map<String, serde_json::Value>, // "inspection", "histogram" for remote
}
impl PreviewImage {
    pub fn meta(&self) -> serde_json::Value;          // {width,height,source,coordinate_mapping?, ...extras}
    pub fn to_envelope(&self) -> Vec<u8>;
    pub fn from_envelope(bytes: &[u8]) -> anyhow::Result<Self>;
}
pub struct PreviewMemory { /* Mutex inside */ }
impl PreviewMemory {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self;
    pub fn get(&self, key: &str) -> Option<Arc<PreviewImage>>;
    pub fn put(&self, key: String, image: Arc<PreviewImage>);  // evicts least recently used until both limits hold
}
// imaging.rs
pub fn preview(path: &Path, crop: Option<Crop>, tier: PreviewTier) -> Result<PreviewImage>;
pub fn remote_preview<R: Read + Seek>(input: &mut R, length: u64, crop: Option<Crop>, tier: PreviewTier) -> Result<PreviewImage>;
// catalog.rs
impl Core {
    pub fn preview_image(&self, id: &str, tier: PreviewTier, uncropped: bool) -> Result<Arc<PreviewImage>>;
    pub fn preview_fingerprint(&self, id: &str, uncropped: bool) -> Result<String>; // "<id>:<mtime_ns>:<size>:<crop json>", no decode
}
```

- `Core::dispatch("asset.preview", {id, tier? | max_size?, uncropped?})` returns `image.meta()`; absent both → `p2560` (previous default 1600 maps there too).
- Core holds `PreviewMemory::new(256, 128 * 1024 * 1024)` in place of `previews: Mutex<VecDeque<...>>`, keyed by `format!("{}:{}", fingerprint, tier.as_str())`.
- RAW in `render_frame` when `max_side` is `Some` and the caller passes `prefers_embedded`: try `embedded_preview::read_with_orientation` first, fall back to `render_sensor`; source strings stay `"embedded_jpeg"` / `"raw_demosaic"`. Exports (`max_side == None`) are unchanged.

- [ ] **Step 1: Write failing unit tests** in `preview.rs`:
  - `tier_names_and_sizes_round_trip` — each tier: `parse(as_str()) == Some(tier)`; `parse("t9999") == None`; `pixels` values per Global Constraints.
  - `max_size_maps_to_smallest_covering_tier` — `32→T256`, `256→T256`, `257→T512`, `420→T512`, `1024→T1024`, `1025→P2560`, `4096→P2560`.
  - `envelope_round_trip_preserves_bytes_and_meta` — image with `jpeg = vec![1,2,3]`, `extras` containing `"inspection"`; decoded equals original field by field.
  - `envelope_rejects_wrong_magic_and_truncation` — `b"NPV1..."`, a length longer than the buffer, and invalid UTF-8 meta all return `Err` whose message starts with `E_CACHE:`.
  - `memory_cache_evicts_by_bytes_and_entries` — limits `(2, 10)`: put a(4 bytes), b(4), c(4) → `a` gone; touch `b` then put d(9) → only `d` remains (bytes limit); `get` returns the same `Arc` (`Arc::ptr_eq`).

- [ ] **Step 2: Update integration tests to the new contract** in `crates/neb-core/tests/catalog.rs`:
  - Line 257: compare `core.preview_image(id, PreviewTier::P2560, false)` JPEG bytes of the two calls instead of `data_url` strings.
  - Lines 519-523: the synthetic RAW test (no embedded JPEG) asserts `preview["source"] == "raw_demosaic"`, `preview.get("data_url").is_none()`, and `core.preview_image(&id, PreviewTier::T512, false)` starts with `[0xFF, 0xD8]` and reports `source == "raw_demosaic"` (fallback when no embedded preview).
  - New `raw_grid_tier_prefers_embedded_preview`: build a TIFF-structured RAW fixture with a primary IFD JPEG pointer (reuse the IFD-building approach from `crates/neb-service/tests/remote_cache.rs:885-924`, writing to a local `.nef` file); assert `preview_image(T512).source == "embedded_jpeg"` and `preview_image(P2560).source` is unchanged from current behavior for the same file.

- [ ] **Step 3: Run to verify failure.**

Run: `cargo test --locked -p neb-core`
Expected: FAIL (new module and signatures missing).

- [ ] **Step 4: Implement** `preview.rs`, the `imaging.rs` signature changes (JPEG encode quality stays 88; `encode_preview` returns `PreviewImage`; remove the base64 import and the `base64` dependency from `neb-core/Cargo.toml` if nothing else uses it), and the `catalog.rs` changes.

- [ ] **Step 5: Run to verify pass.**

Run: `cargo test --locked -p neb-core && cargo clippy --locked -p neb-core --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(core): tiered binary previews with embedded-first RAW thumbnails`

---

### Task 2: Service preview path, v2 disk cache, public API

**Files:**

- Modify: `crates/neb-service/src/remote_cache.rs:224-433,520-575`, `crates/neb-service/src/lib.rs`
- Test: update `crates/neb-service/tests/remote_cache.rs` (8 `data_url` uses), `library_sources.rs`, `local_libraries.rs`; new tests in `crates/neb-service/tests/preview_protocol.rs`

**Interfaces:**

- Consumes: Task 1 types.
- Produces:

```rust
impl Service {
    pub fn preview_image(&self, id: &str, tier: PreviewTier, uncropped: bool)
        -> Result<Arc<PreviewImage>, CommandError>;
    pub fn preview_etag(&self, id: &str, tier: PreviewTier, uncropped: bool)
        -> Result<String, CommandError>;   // "\"<sha256 hex of preview-v2 key>\"", no decode, no network
}
```

- Inside `remote_cache.rs`: `fn preview_key(&self, asset, tier, uncropped) -> Result<String>` produces `preview-v2:<id>:<fingerprint>:<size>:<tier>:<crop json>`; `fn preview_image(&self, asset, tier, uncropped) -> Result<Arc<PreviewImage>>` replaces `render_preview` and keeps its control flow exactly (local fast path with best-effort background write, cached hit, download slot, range preview with `may_fallback` and `BudgetExceeded → E_DOWNLOAD_REQUIRED`, inspection recording, publication under the refreshed key). Disk values are `to_envelope()`; reads use `from_envelope`. The memory cache (`PreviewMemory`) is consulted before disk for both local and remote, keyed by the v2 key.
- IPC `asset.preview {id, tier?|max_size?, uncropped?}` → `{width,height,source,coordinate_mapping?,tier,asset, ...extras}`; no `data_url`.
- `asset.histogram` for remote assets uses `PreviewTier::P2560` in place of `max_size: 2048` and reads `extras["histogram"]`.
- Both public methods go through the same per-asset operation lock as `asset_dispatch`.

- [ ] **Step 1: Write failing tests** in `crates/neb-service/tests/preview_protocol.rs`:
  - `local_preview_bytes_are_jpeg_and_ipc_has_no_pixels` — local library with one JPEG; `preview_image(id, T512, false)` bytes start with `FF D8`, long side ≤ 512; `execute("asset.preview", {"id":id,"tier":"t512"})` has `width`, `tier == "t512"`, no `data_url`.
  - `legacy_max_size_maps_to_tier` — `{"max_size":420}` returns `tier == "t512"`.
  - `etag_is_stable_and_changes_with_file_content` — two `preview_etag` calls equal; rewrite the file with different bytes and a later mtime; `asset.refresh`; new ETag differs and `preview_image` returns different bytes.
  - `etag_changes_with_crop_and_tier` — after `asset.crop`, ETag differs; `T256` vs `T512` differ.
  - `preview_cache_survives_restart_as_v2_envelope` — render, drop `Service`, reopen on the same data dir; `preview_image` succeeds and the cache object for the asset has a key starting `preview-v2:` (query through `cache.stats` or the existing test helper that lists objects).
- [ ] **Step 2: Convert existing assertions.** Every `preview["data_url"]` check becomes either a `service.preview_image(...)` byte check (`starts_with(&[0xFF, 0xD8])`) or a metadata check; `remote_cache.rs::large_remote_raw_keeps_small_range_preview_and_far_exif_without_downloading_original` keeps all its transfer-budget assertions and additionally checks `source == "remote_embedded_jpeg"` on the metadata. Tests asserting `E_DOWNLOAD_REQUIRED` keep asserting it through both `execute("asset.preview")` and `preview_image`.

- [ ] **Step 3: Run to verify failure.**

Run: `cargo test --locked -p neb-service`
Expected: FAIL.

- [ ] **Step 4: Implement** the service changes. `asset.preview` and the public methods share one internal function; no duplicated control flow.

- [ ] **Step 5: Run to verify pass**, including the loading-regression suite.

Run: `cargo test --workspace --locked && cargo clippy --workspace --all-targets --locked -- -D warnings`
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(service): serve previews as cached binary tiers`

---

### Task 3: `neb` protocol in the desktop app

**Files:**

- Create: `crates/neb-app/src/preview_protocol.rs`
- Modify: `crates/neb-app/src/main.rs`, `crates/neb-app/tauri.conf.json` (CSP), `crates/neb-app/Cargo.toml` (`percent-encoding = "=2.3.2"`, already in the lockfile)
- Test: unit tests in `preview_protocol.rs`

**Interfaces:**

- Consumes: `Service::preview_image`, `Service::preview_etag`, `CommandError { code, message }`.
- Produces:

```rust
#[derive(Debug, PartialEq, Eq)]
pub struct PreviewRequest { pub id: String, pub tier: PreviewTier, pub uncropped: bool }
pub fn parse_request(path: &str) -> Result<PreviewRequest, &'static str>;
// path is the request URI path; percent-decode it, strip one leading '/',
// expect exactly "<id>/<tier>/<0|1>/<rev>"; id matches ^[0-9A-Za-z-]{1,64}$; rev is digits and ignored.
pub fn respond(request: &PreviewRequest, if_none_match: Option<&str>, service: &Service)
    -> tauri::http::Response<Vec<u8>>;
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R>;
// register_asynchronous_uri_scheme_protocol("neb", ...): parse → spawn_blocking(respond) → responder.respond
```

- Response headers on 200: `Content-Type: image/jpeg`, `Cache-Control: no-cache`, `ETag`, `X-Neb-Width`, `X-Neb-Height`, `X-Neb-Source`, and `Access-Control-Allow-Origin` set to the requesting origin when it is `tauri://localhost` or `http://tauri.localhost` (so canvas reads stay possible). 304 carries `ETag` and no body.
- Status mapping and error body per Global Constraints. `respond` checks the ETag first and returns 304 without calling `preview_image`.

- [ ] **Step 1: Write failing tests:**
  - `parses_valid_paths` — `"/0f8c-ab/t512/0/17"` and its percent-encoded form `"/0f8c-ab%2Ft512%2F0%2F17"` both parse to `{id:"0f8c-ab", tier:T512, uncropped:false}`; `"/x/p2560/1/0"` → `uncropped:true`.
  - `rejects_malformed_paths` — `"/../etc/t512/0/1"`, `"/a/t9999/0/1"`, `"/a/t512/2/1"`, `"/a/t512/0"`, `"/a/t512/0/1/extra"`, `"/a b/t512/0/1"`, an id of 65 characters → `Err`.
  - `respond_maps_errors_and_not_modified` — with a temp `Service` and a local JPEG asset: OK → 200 with `image/jpeg`; same ETag in `If-None-Match` → 304 empty body; unknown id → 404 with JSON body `code == "E_NOT_FOUND"`; a `.cr3` asset (unsupported) → 415.
- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --locked -p neb-app preview_protocol`
Expected: FAIL.

- [ ] **Step 3: Implement**, call `preview_protocol::register(tauri::Builder::default())` before the existing chain, and update the CSP `img-src` per Global Constraints.

- [ ] **Step 4: Run to verify pass.**

Run: `cargo test --locked -p neb-app && cargo clippy --locked -p neb-app -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(app): serve tiered previews over the neb protocol`

---

### Task 4: Frontend switches to protocol URLs

**Files:**

- Create: `packages/ui/src/preview-url.ts`
- Modify: `packages/ui/src/model.ts:81-93` (`Preview`), `packages/ui/src/api.ts`, `packages/ui/src/PhotoView.tsx:24-140,170-230`, `packages/ui/src/ManagementApp.tsx:985-1000` (pass `tier`), `packages/ui/src/demo.ts:195-215`, `packages/ui/src/concurrency.ts` (no behavior change; image loads use the existing `thumbnail` / `viewer` lanes)
- Test: `packages/ui/tests/preview-url.test.ts` (new); update the seven Playwright specs that return `data_url`; new cases in `packages/ui/tests/browser/preview-scheduling.spec.ts`

**Interfaces:**

- Consumes: protocol path format from Task 3; IPC metadata from Task 2.
- Produces:

```ts
export type PreviewTier = 't256' | 't512' | 't1024' | 'p2560';
export const TIER_PIXELS: Record<PreviewTier, number>;
export function previewTier(cssPixels: number, devicePixelRatio: number): PreviewTier;
// smallest tier with pixels >= ceil(cssPixels * dpr), but grid callers never exceed 't1024'
export function gridTier(thumbSize: number, devicePixelRatio: number): PreviewTier; // previewTier capped at t1024
export function previewUrl(
  asset: Pick<Asset, 'id' | 'preview_revision'>,
  tier: PreviewTier,
  uncropped?: boolean,
): string;
// desktop: convertFileSrc(`${id}/${tier}/${uncropped ? 1 : 0}/${revision}`, 'neb'); browser demo: demoPreviewUrl(...)
export function loadImage(
  url: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }>;
// new Image(); src = url; await decode(); on abort sets src = '' and rejects with the scheduler's abort error type
```

- `model.ts` `Preview` drops `data_url`, adds `tier: PreviewTier`; viewer components keep using `width`, `height`, `source`, `coordinate_mapping`, `asset`.
- `Thumbnail` gets a required `tier: PreviewTier` prop. It no longer calls IPC: when visible, it schedules `loadImage(previewUrl(asset, tier))` on the `thumbnail` lane (`source` local/remote as today), then renders `<img src={url} alt="">`. Load failure shows the existing fallback tile (`RAW` / `无预览`). Leaving the viewport aborts as today.
- `ManagementApp` computes `gridTier(thumbSize(), window.devicePixelRatio)` once per render and passes it.
- Viewer (`PhotoView` second resource) keeps the IPC call with `tier: 'p2560'` for metadata and errors (`E_DOWNLOAD_REQUIRED` UI unchanged), then sets `<img src={previewUrl(asset, 'p2560', uncropped)}>`.
- `demo.ts`: `asset.preview` returns metadata only; a new exported `demoPreviewUrl(id, tier, uncropped)` returns a cached `blob:` URL produced with `canvas.toBlob('image/jpeg', 0.88)`.

- [ ] **Step 1: Write failing unit tests** in `preview-url.test.ts`:
  - `previewTier` — `(150,1)→t256`, `(256,1)→t256`, `(257,1)→t512`, `(320,2)→t1024`, `(1200,2)→p2560`.
  - `gridTier caps at t1024` — `(320,3)→t1024`.
  - `previewUrl` — with `globalThis.window.__TAURI_INTERNALS__.convertFileSrc` stubbed to `(p, proto) => proto + '://localhost/' + encodeURIComponent(p)` and `isTauri` true, `previewUrl({id:'a1', preview_revision: 7}, 't512')` equals `'neb://localhost/' + encodeURIComponent('a1/t512/0/7')`; missing revision encodes `0`.
- [ ] **Step 2: Write failing browser tests** in `preview-scheduling.spec.ts`, mocking `__TAURI_INTERNALS__` with `convertFileSrc: (p, s) => 'http://neb.localhost/' + encodeURIComponent(p)` and `page.route('http://neb.localhost/**', ...)` serving a 1×1 JPEG with an artificial delay:
  - `grid requests tier from slider and dpr` — viewport `deviceScaleFactor: 2`, slider at 320 → every requested path contains `%2Ft1024%2F`; slider at 150 → `%2Ft512%2F` (150×2=300).
  - `scrolling away drops queued thumbnail loads` — 600 assets, scroll to bottom immediately; at most 8 requests for the first screen's ids are ever started (4 lanes × 2 sources), and cells at the bottom display images.
  - `failed thumbnail shows fallback tile` — route returns 409 JSON for one id; that cell shows text `RAW` (asset kind raw) and no `img` element.
- [ ] **Step 3: Run to verify failure.**

Run: `pnpm --filter @nebulume/ui exec vitest run tests/preview-url.test.ts && pnpm --filter @nebulume/ui test:browser -- preview-scheduling.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement** the UI changes, then update every Playwright fixture that returned `data_url` (`inspector`, `management-sync`, `cache-settings`, `remote-preview`, `management`, `preview-scheduling`, `viewer-focus`): IPC mocks return metadata; image bytes are served through the `neb.localhost` route; mocks provide `convertFileSrc`.

- [ ] **Step 5: Run to verify pass.**

Run: `pnpm typecheck && pnpm test && pnpm --filter @nebulume/ui test:browser`
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(ui): load previews from neb protocol tiers`

---

### Task 5: Documentation, before/after measurement, desktop check

**Files:**

- Modify: `docs/API.md:20` (`asset.preview` contract, `neb` protocol section, deprecation of `max_size`), `docs/ARCHITECTURE.md` (byte path, cache envelope), `docs/STATUS.md` (RAW thumbnails use embedded JPEG first; viewer 2560px), `CHANGELOG.md` (unreleased)
- Create: `scripts/bench-preview.mjs`

**Interfaces:**

- `scripts/bench-preview.mjs --data-dir DIR --library ID --tier t512 --count 200` drives `neb stdio`, requests `asset.list` then the preview of the first `count` assets twice (cold, warm) through the CLI, and prints cold/warm totals and p50/p95 in ms as one JSON line. For the protocol path the CLI equivalent is a new `neb-cli` command `preview --id ID --tier TIER --out FILE` that calls `Service::preview_image` and writes the JPEG, used by the script.

- [ ] **Step 1: Add the CLI `preview` subcommand** with a test in `crates/neb-cli` (or an integration test invoking the binary through `assert_cmd` if already a dev-dependency; otherwise a unit test of the argument handler) asserting the written file starts with `FF D8`.
- [ ] **Step 2: Write `bench-preview.mjs`** and run it on a 1,000-file local folder containing at least 200 NEF/ARW files, once on `main` (using `asset.preview` with `max_size: 420` and decoding `data_url` length as the byte count) and once on this branch; record both JSON lines in `docs/STATUS.md` with the machine description.
- [ ] **Step 3: Manual desktop check (Windows and macOS dev build):** grid scrolls with images, viewer opens and zooms, crop mode shows the uncropped image, remote RAW over budget shows the download entry, DevTools network panel shows `neb` requests with 304 on revisit, no CSP violations in the console.
- [ ] **Step 4: Update docs** per Files.
- [ ] **Step 5: Full verification.**

Run: `cargo fmt --all -- --check && cargo test --workspace --locked && cargo clippy --workspace --all-targets --locked -- -D warnings && pnpm test && pnpm typecheck && pnpm build && pnpm --filter @nebulume/ui test:browser`
Expected: all pass.

- [ ] **Step 6: Commit** — `docs: preview protocol contract and measurements`
