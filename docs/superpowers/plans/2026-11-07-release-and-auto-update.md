# Release Pipeline and In-App Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `v*` tag builds, signs, packages and drafts a GitHub Release with a verified `latest.json`; installed Windows builds check that file, download the signed installer and restart into the new version.

**Architecture:** `tauri-plugin-updater` + `tauri-plugin-process` in `neb-app`, an `update_support` and `prepare_for_update` command pair, and a pure, injectable update controller in the UI. CI builds the NSIS installer with the Tauri CLI under the updater signing key; `scripts/package-release.py` stays the single authority on upload contents and now also emits `latest.json`; `scripts/verify-release.py` reads the draft back before a human publishes it.

**Tech Stack:** Tauri 2.12, `tauri-plugin-updater =2.14.1`, `tauri-plugin-process =2.4.0`, SolidJS, Vitest, Python 3.11 `unittest`, GitHub Actions on `windows-latest`, `gh` CLI.

**Spec:** `docs/REFACTOR_DESIGN.md` section 8 (主线 D). Deviations recorded here: `tauri-action` is not used (the packaging script owns `latest.json` and uploads); “下次启动时安装” is replaced by “稍后”, because the Windows installer terminates the app as soon as installation starts.

## Global Constraints

- New Rust dependencies use exact versions: `tauri-plugin-updater = "=2.14.1"`, `tauri-plugin-process = "=2.4.0"`, gated `[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]`.
- New npm dependencies use exact versions: `@tauri-apps/plugin-updater` `2.14.1`, `@tauri-apps/plugin-process` `2.4.0`.
- Updater endpoint: `https://github.com/timeStarry/nebulume/releases/latest/download/latest.json`. Windows `installMode`: `passive`.
- `bundle.targets` becomes `["nsis"]`. `latest.json` lists only `windows-x86_64`.
- The updater private key and its password never enter the repository, logs, or `.env` files; CI reads `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from GitHub Secrets.
- The viewer capability (`capabilities/viewer.json`) gets no updater or process permissions.
- Automatic check: first at 10 s after start, then every 24 h; failures are silent except in the “关于与诊断” panel. Preference key: `nebulume.update.auto` (default on).
- Upload whitelist after this plan: `Nebulume_<v>_x64-setup.exe`, `Nebulume_<v>_x64-setup.exe.sig`, `Nebulume_<v>_windows_x64.zip`, `latest.json`, `manifest.json`, `SHA256SUMS.txt`. `SHA256SUMS.txt` covers the other five.
- UI copy is Chinese, sentence case, no exclamation marks; follows existing tokens (`--nl-*`), font weights 400/500 only.
- Published releases are never overwritten; a failed run is resumed after reading remote state.

## Review Focus

- GitHub unreachable or rate-limited during a check: no toast, no modal; the about panel shows “上次检查失败：<原因>” with the time. → test in Task 3.
- Remote version equal to or older than the running one: controller ends in `up-to-date`, no prompt. → test in Task 3.
- Download interrupted midway: state returns to `available` with the error shown, the app keeps running, retry works. → test in Task 3.
- Running from the portable ZIP (no `uninstall.exe` beside the executable) or a debug build: update UI is hidden and the about panel says why. → test in Task 2.
- A malformed `latest.json` (bad version, empty signature, wrong URL) breaks updates for every platform: packaging refuses to write one. → test in Task 5.

---

## File Structure

| File                                                                                    | Responsibility                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `crates/neb-app/src/updates.rs` (new)                                                   | `update_support` (install kind detection) and `prepare_for_update` commands    |
| `crates/neb-service/src/lib.rs`                                                         | `Service::quiesce(timeout)` stops background jobs and waits for preview writes |
| `crates/neb-service/src/capture_index.rs`                                               | `cancel_all_capture_index()` used by `quiesce`                                 |
| `crates/neb-app/src/main.rs`, `Cargo.toml`, `tauri.conf.json`, `capabilities/main.json` | plugin registration and config                                                 |
| `packages/ui/src/update-controller.ts` (new)                                            | pure state machine + scheduling, all effects injected                          |
| `packages/ui/src/updates.ts` (new)                                                      | wires the controller to Tauri plugins and the two Rust commands                |
| `packages/ui/src/UpdatePanel.tsx` (new), `update.css` (new)                             | about-panel section and the update prompt                                      |
| `packages/ui/src/ManagementApp.tsx`                                                     | mounts prompt, replaces hard-coded version, hosts about panel                  |
| `packages/ui/vite.config.ts`                                                            | `define: { __APP_VERSION__ }` from `package.json`                              |
| `scripts/release_lib.py` (new)                                                          | pure helpers: changelog notes, `latest.json`, validation parsing               |
| `scripts/package-release.py`                                                            | consumes `release_lib`, adds `.sig` + `latest.json` to whitelist               |
| `scripts/collect-validation.py` (new)                                                   | builds the validation JSON from CI test reports                                |
| `scripts/verify-release.py` (new)                                                       | reads a draft release back and compares with local output                      |
| `scripts/tests/test_release_lib.py` (new)                                               | unit tests for the pure helpers                                                |
| `.github/workflows/release.yml` (new)                                                   | tag-triggered pipeline                                                         |
| `docs/RELEASING.md`, `docs/STATUS.md`, `docs/API.md`, `CHANGELOG.md`                    | documentation                                                                  |

---

### Task 1: Signing key and updater plugin wiring

**Files:**

- Modify: `crates/neb-app/Cargo.toml`, `crates/neb-app/src/main.rs`, `crates/neb-app/tauri.conf.json`, `crates/neb-app/capabilities/main.json`, `packages/ui/package.json`, `pnpm-lock.yaml`, `Cargo.lock`

**Interfaces:**

- Produces: plugins registered; JS packages `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` importable; capability `updater:default`, `process:allow-restart` on window `main`.

- [ ] **Step 1: Human step — generate the key pair.** The owner runs, outside the repository:

```bash
pnpm --dir crates/neb-app exec tauri signer generate -w ~/.tauri/nebulume-updater.key
```

They store the private key file and password in a password manager and as GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY` (file content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, then hand over the content of `~/.tauri/nebulume-updater.key.pub`. Implementation stops here until the public key is available.

- [ ] **Step 2: Add dependencies.** Cargo entries per Global Constraints; `pnpm --filter @nebulume/ui add -E @tauri-apps/plugin-updater@2.14.1 @tauri-apps/plugin-process@2.4.0`.

- [ ] **Step 3: Register plugins in `main.rs` `setup`**, gated `#[cfg(desktop)]`: `app.handle().plugin(tauri_plugin_updater::Builder::new().build())?` and `app.handle().plugin(tauri_plugin_process::init())?`. Keep `single_instance` registered first.

- [ ] **Step 4: Config.** In `tauri.conf.json`: `"targets": ["nsis"]`, `"createUpdaterArtifacts": true`, and `plugins.updater` with `pubkey` (the key content), the endpoint and `windows.installMode` from Global Constraints. Append `"updater:default"` and `"process:allow-restart"` to `capabilities/main.json` only.

- [ ] **Step 5: Verify.**

Run: `cargo check --locked -p neb-app && cargo clippy --locked -p neb-app -- -D warnings && pnpm typecheck`
Expected: all pass.

- [ ] **Step 6: Commit** — `feat(app): register updater and process plugins`

---

### Task 2: Install-kind detection and quiesce before install

**Files:**

- Create: `crates/neb-app/src/updates.rs`
- Modify: `crates/neb-app/src/main.rs` (register commands), `crates/neb-service/src/lib.rs`, `crates/neb-service/src/capture_index.rs`, `crates/neb-service/src/remote_cache.rs` (expose pending preview write count)
- Test: `crates/neb-service/tests/quiesce.rs` (new), unit tests inside `crates/neb-app/src/updates.rs`

**Interfaces:**

- Produces (Rust):
  - `pub enum InstallKind { Installer, Portable, Development, UnsupportedPlatform }` serialized as `"installer" | "portable" | "development" | "unsupported_platform"`.
  - `pub fn install_kind(executable: &Path, debug: bool, windows: bool) -> InstallKind` — `Development` if `debug`; `UnsupportedPlatform` if not `windows`; `Installer` if `executable.with_file_name("uninstall.exe")` is a file; else `Portable`.
  - `#[tauri::command] fn update_support() -> UpdateSupport` where `UpdateSupport { supported: bool, kind: InstallKind }`, `supported == (kind == Installer)`.
  - `#[tauri::command] async fn prepare_for_update(service) -> Result<QuiesceReport, CommandError>` calling `Service::quiesce(Duration::from_secs(5))` in `spawn_blocking`.
  - `impl Service { pub fn quiesce(&self, timeout: Duration) -> Result<QuiesceReport, CommandError> }`, `QuiesceReport { cancelled_jobs: usize, pending_writes: usize, timed_out: bool }` (serde, snake_case). Cancels every running capture-index job, then polls the pending preview-write counter every 50 ms until 0 or `timeout`.
- Produces (JS, consumed by Task 3): Tauri commands `update_support` → `{supported:boolean, kind:string}` and `prepare_for_update` → `{cancelled_jobs:number, pending_writes:number, timed_out:boolean}`.

- [ ] **Step 1: Write failing unit tests for `install_kind`** in `updates.rs`:

```rust
#[test]
fn install_kind_uses_uninstaller_beside_executable() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("nebulume.exe");
    std::fs::write(&exe, b"MZ").unwrap();
    assert_eq!(install_kind(&exe, false, true), InstallKind::Portable);
    std::fs::write(dir.path().join("uninstall.exe"), b"MZ").unwrap();
    assert_eq!(install_kind(&exe, false, true), InstallKind::Installer);
    assert_eq!(install_kind(&exe, true, true), InstallKind::Development);
    assert_eq!(install_kind(&exe, false, false), InstallKind::UnsupportedPlatform);
}
```

Add `tempfile.workspace = true` to `neb-app` dev-dependencies.

- [ ] **Step 2: Write failing service test** `crates/neb-service/tests/quiesce.rs::quiesce_cancels_capture_jobs_and_reports_idle` — open a `Service` on a temp dir with a local library holding one JPEG, start `library.capture_index.start`, call `service.quiesce(Duration::from_secs(5))`, assert `!report.timed_out`, `report.pending_writes == 0`, and `library.capture_index.status` reports a status in `["cancelled","completed"]`. Second test `quiesce_on_idle_service_returns_immediately`: elapsed `< 200 ms`, `cancelled_jobs == 0`.

- [ ] **Step 3: Run tests to verify they fail.**

Run: `cargo test --locked -p neb-service --test quiesce && cargo test --locked -p neb-app updates`
Expected: FAIL (items not defined).

- [ ] **Step 4: Implement** `install_kind`, `update_support`, `prepare_for_update`, `Service::quiesce`, `cancel_all_capture_index(&self) -> Result<usize>` (cancels each job whose status is `running`, reusing the existing per-job cancel path), and `pending_preview_writes(&self) -> usize` reading `preview_writes`. Register both commands in `generate_handler!`.

- [ ] **Step 5: Run tests to verify they pass** (same command). Expected: PASS. Then `cargo clippy --workspace --all-targets --locked -- -D warnings`.

- [ ] **Step 6: Commit** — `feat(app): detect install kind and quiesce services before update`

---

### Task 3: Update controller (pure logic)

**Files:**

- Create: `packages/ui/src/update-controller.ts`
- Test: `packages/ui/tests/update-controller.test.ts`

**Interfaces:**

- Produces:

```ts
export type UpdateState =
  | { kind: 'unsupported'; reason: 'portable' | 'development' | 'unsupported_platform' | 'browser' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available'; version: string; notes: string; date?: string; error?: string }
  | { kind: 'downloading'; version: string; received: number; total?: number }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; checkedAt: number; message: string };

export interface AvailableUpdate {
  version: string;
  body?: string;
  date?: string;
  download(
    onEvent: (
      e:
        | { event: 'Started'; data: { contentLength?: number } }
        | { event: 'Progress'; data: { chunkLength: number } }
        | { event: 'Finished' },
    ) => void,
  ): Promise<void>;
  install(): Promise<void>; // on Windows the plugin exits the process inside install
}
export interface UpdateEffects {
  support(): Promise<{ supported: boolean; kind: string }>;
  check(): Promise<AvailableUpdate | null>;
  prepare(): Promise<unknown>;
  relaunch(): Promise<void>;
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  readAuto(): boolean;
  writeAuto(value: boolean): void;
}
export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 86_400_000;
export function createUpdateController(effects: UpdateEffects): {
  state(): UpdateState;
  subscribe(listener: (state: UpdateState) => void): () => void;
  start(): Promise<void>; // resolves support, schedules first automatic check when readAuto()
  checkNow(): Promise<void>; // manual; ignored while checking/downloading/installing
  install(): Promise<void>; // only from 'available': downloading → download() → prepare() → installing → update.install() → relaunch()
  dismiss(): void; // 'available' → 'idle'; next scheduled check prompts again
  setAuto(value: boolean): void; // persists; cancels or schedules the timer
  dispose(): void;
};
```

Behavior: `check()` resolving `null` → `up-to-date`; throwing → `failed` (message from the error); after any automatic check, the next one is scheduled `CHECK_INTERVAL_MS` later. `install()` failure during download → back to `available` with `error`, no prepare, no install. `update.install()` failure → back to `available` with `error`, no relaunch. `prepare()` failure or `timed_out` does not block installation. `prepare()` must run before `update.install()` because on Windows tauri-plugin-updater calls `std::process::exit(0)` inside install, so `relaunch()` is only reached on macOS/Linux. A retry after either failure calls `download()` again.

- [ ] **Step 1: Write failing tests** in `update-controller.test.ts` using a fake-effects factory (manual timer queue, controllable `check`). Tests and their assertions:
  - `does not check when unsupported` — `support` → `{supported:false, kind:'portable'}`; after `start()`, `state()` is `{kind:'unsupported', reason:'portable'}`, `check` never called, no timer.
  - `schedules first automatic check after 10 s and then daily` — timer delays recorded equal `[10_000, 86_400_000]` after the first timer fires.
  - `null check result reports up to date without prompting` — final kind `up-to-date`, `checkedAt` equals fake `now()`.
  - `network failure is recorded, not thrown` — `check` rejects `new Error('offline')`; `start()` and the timer run without throwing; state `{kind:'failed', message:'offline'}`.
  - `install reports progress then prepares and relaunches` — events `Started(contentLength 100)`, `Progress(40)`, `Progress(60)`, `Finished`; observed states include `downloading` with `received` 40 then 100 and `total` 100, then `installing`; recorded call order is `download` → `prepare` → `install` → `relaunch`.
  - `prepare runs before install` — the `install` mock records that `prepare` was already called.
  - `install failure returns to available without relaunch` — `install` rejects; state `available` with the error; `relaunch` not called; retry calls `download` again.
  - `interrupted download returns to available with error` — `download` rejects `new Error('reset')`; state `available` with `error: 'reset'`; `prepare`, `install` and `relaunch` not called; a second `install()` calls `download` again.
  - `manual check is ignored while downloading` — `checkNow()` during download does not call `check`.
  - `turning auto off cancels the pending timer and persists` — `writeAuto(false)` called; timer cancel function invoked.

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter @nebulume/ui exec vitest run tests/update-controller.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `createUpdateController`** per the interface; no imports from Tauri.

- [ ] **Step 4: Run to verify pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit** — `feat(ui): add update controller state machine`

---

### Task 4: Update UI and about panel

**Files:**

- Create: `packages/ui/src/updates.ts`, `packages/ui/src/UpdatePanel.tsx`, `packages/ui/src/update.css`
- Modify: `packages/ui/src/ManagementApp.tsx` (Settings section “运行环境” → “关于与诊断”; mount `UpdatePrompt`), `packages/ui/vite.config.ts`, `packages/ui/src/vite-env.d.ts` (create if absent, declares `__APP_VERSION__: string`)
- Test: `packages/ui/tests/browser/updates.spec.ts` (new)

**Interfaces:**

- Consumes: Task 2 commands, Task 3 `createUpdateController`.
- Produces:
  - `updates.ts`: `export const updates: ReturnType<typeof createUpdateController>` built with real effects (`invoke('update_support')`, `check()` from `@tauri-apps/plugin-updater` with `{ timeout: 30_000 }`, `invoke('prepare_for_update')`, `relaunch()` from `@tauri-apps/plugin-process`, `localStorage` key `nebulume.update.auto`). In browser demo mode (`!desktop`), `support()` resolves `{supported:false, kind:'browser'}`.
  - `UpdatePanel.tsx`: `export function AboutPanel()` and `export function UpdatePrompt()`.

Copy (exact):

- About panel title `关于与诊断`; version line `Nebulume ${__APP_VERSION__} · 桌面应用` or `· 浏览器演示`.
- Buttons/labels: `检查更新`, `正在检查…`, `自动检查更新` (checkbox), `已是最新版本 · 检查于 <本地时间>`, `上次检查失败：<message>`.
- Unsupported reasons: portable `独立程序不支持自动更新，请从 Release 页面下载新版本。`; development `开发构建不检查更新。`; unsupported_platform `当前平台暂未提供安装包更新。`; browser `浏览器演示不检查更新。`
- Prompt (shown for `available`, `downloading`, `installing`; rendered in normal flow above the workspace content, not `position: fixed`): title `Nebulume <version> 可用`; notes in a scrollable `<pre>`-free block limited to 12 lines; buttons `立即重启安装` and `稍后`; progress `正在下载 <MB>/<MB>` with a `<progress>` element; installing `正在准备安装，应用将自动重启`; error line `下载失败：<message>，可重试。`
- Existing runtime JSON stays inside a `<details>` titled `运行时能力与限制` within the about panel.

- [ ] **Step 1: Write failing Playwright tests** in `updates.spec.ts`, mocking `__TAURI_INTERNALS__` the way `appearance.spec.ts` does, with `invoke` handling `update_support`, `prepare_for_update`, `plugin:updater|check`, `plugin:updater|download_and_install` (emit progress via the channel argument) and `plugin:process|restart`:
  - `about panel shows injected version and manual check result` — opens 设置, expects text `Nebulume 0.1.1`, clicks `检查更新`, with check returning null expects `已是最新版本`.
  - `available update prompts and installs with progress` — check returns version `0.2.0` with body `修复若干问题`; expects heading `Nebulume 0.2.0 可用`; clicks `立即重启安装`; expects a `progress` element, then `prepare_for_update` invoked before `plugin:process|restart`.
  - `portable build hides update controls` — `update_support` returns `{supported:false, kind:'portable'}`; expects the portable copy and no `检查更新` button.

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter @nebulume/ui test:browser -- updates.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `vite.config.ts` `define: { __APP_VERSION__: JSON.stringify(pkg.version) }` (read `package.json` with `fs`), `updates.ts`, `UpdatePanel.tsx`, `update.css` (tokens only, `0.5px solid var(--nl-border)` style consistent with existing panels), replace the hard-coded `Nebulume 0.1 Alpha` line, call `updates.start()` once in `ManagementApp` `onMount` for the main window only.

- [ ] **Step 4: Run to verify pass**, then the full suite.

Run: `pnpm typecheck && pnpm test && pnpm --filter @nebulume/ui test:browser`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(ui): in-app update prompt and about panel`

---

### Task 5: Release library — notes, `latest.json`, validation parsing

**Files:**

- Create: `scripts/release_lib.py`, `scripts/tests/__init__.py`, `scripts/tests/test_release_lib.py`, `scripts/collect-validation.py`
- Modify: `scripts/package-release.py`

**Interfaces:**

- Produces (`release_lib.py`):
  - `changelog_notes(text: str, version: str) -> str` — body of the `## <version> · YYYY-MM-DD` section up to the next `## ` heading, stripped; raises `ReleaseError` if absent or empty.
  - `updater_manifest(version: str, installer_name: str, signature: str, notes: str, pub_date: str, repository: str = "timeStarry/nebulume") -> dict` — returns `{"version", "notes", "pub_date", "platforms": {"windows-x86_64": {"signature", "url"}}}` with `url = f"https://github.com/{repository}/releases/download/v{version}/{installer_name}"`; raises `ReleaseError` when `version` is not stable semver, `signature` is empty or contains a newline after stripping, or `pub_date` is not RFC 3339 UTC (`...Z`).
  - `parse_cargo_totals(log: str) -> tuple[int, int, int]` — sums `passed`, `failed`, `ignored` over every `test result:` line.
  - `parse_vitest_json(data: dict) -> tuple[int, int]` — `(numPassedTests, numFailedTests)`.
  - `parse_playwright_json(data: dict) -> tuple[int, int]` — `(stats.expected, stats.unexpected + stats.flaky)`.
  - Move `ReleaseError` into `release_lib`; `package-release.py` imports it.
- `collect-validation.py --version V --commit SHA --cargo-log PATH --vitest-json PATH --playwright-json PATH --unsigned true|false --output PATH` writes the validation JSON in the existing schema (`rust_passed`, `rust_ignored`, `ui_unit`, `edge_workflows`, booleans for `clippy`, `fmt`, `tsc`, `production_build`, `windows_release_and_nsis` set `true` because the workflow only reaches this step after those steps succeed); exits 1 if any failed count is non-zero.
- `package-release.py` new required argument `--notes-from CHANGELOG.md`; it requires `bundle/nsis/<installer>.sig` (regular file, newer than inputs, single line) and writes `latest.json` via `updater_manifest`; `names`, upload records and `SHA256SUMS.txt` follow the Global Constraints whitelist; `manifest.json` gains `"updater": {"signature_file": ..., "latest_json_sha256": ...}`.

- [ ] **Step 1: Write failing tests** in `test_release_lib.py` (`unittest`):
  - `test_changelog_notes_extracts_section` — for a two-section sample, `changelog_notes(sample, "0.1.1")` equals the 0.1.1 body only; missing version raises `ReleaseError`.
  - `test_updater_manifest_shape` — exact dict for version `0.2.0`, installer `Nebulume_0.2.0_x64-setup.exe`, signature `"dW50cnVzdGVk"`, date `2026-11-07T00:00:00Z`; `url == "https://github.com/timeStarry/nebulume/releases/download/v0.2.0/Nebulume_0.2.0_x64-setup.exe"`; only key in `platforms` is `windows-x86_64`.
  - `test_updater_manifest_rejects_bad_input` — each of version `v0.2`, signature `""`, signature `"a\nb"`, date `2026-11-07` raises `ReleaseError`.
  - `test_parse_cargo_totals_sums_all_binaries` — two `test result: ok. 3 passed; 0 failed; 1 ignored; ...` lines give `(6, 0, 2)`.
  - `test_parse_reporters` — minimal vitest and playwright JSON dicts give the expected tuples.

- [ ] **Step 2: Run to verify failure.**

Run: `python3 -m unittest discover -s scripts/tests -v`
Expected: FAIL (`ModuleNotFoundError: release_lib`). Tests add `scripts/` to `sys.path`.

- [ ] **Step 3: Implement** `release_lib.py`, `collect-validation.py`, and the `package-release.py` changes.

- [ ] **Step 4: Run to verify pass** (same command), plus `python3 scripts/package-release.py --help` exits 0.

- [ ] **Step 5: Commit** — `feat(release): emit signed latest.json and collect validation from reports`

---

### Task 6: Tag-triggered release workflow and readback

**Files:**

- Create: `.github/workflows/release.yml`, `scripts/verify-release.py`
- Modify: `scripts/tests/test_release_lib.py` (readback comparison test), `scripts/release_lib.py` (`compare_release_assets`)

**Interfaces:**

- Consumes: Task 5 scripts.
- Produces:
  - `release_lib.compare_release_assets(local: dict[str, dict], remote: list[dict]) -> list[str]` — `local` maps filename → `{"bytes", "sha256"}`; `remote` is `gh release view --json assets` `assets` entries augmented with a downloaded `sha256`; returns a list of human-readable mismatches (missing, extra, size, digest), empty when identical.
  - `verify-release.py --tag vX.Y.Z --output-dir DIR` downloads every asset of the draft with `gh release download` into a new temp dir, hashes them, calls `compare_release_assets` against `DIR`, additionally parses the downloaded `latest.json`, checks its `signature` equals the `.sig` content and its URL filename is in the release; exits 1 with the mismatch list.

- [ ] **Step 1: Write failing test** `test_compare_release_assets_reports_each_mismatch` — local `{a: (1,'x'), b: (2,'y')}` vs remote `[a (1,'x'), b (3,'y'), c (1,'z')]` returns exactly three messages mentioning `b` size, `c` extra, none for `a`; identical input returns `[]`.

- [ ] **Step 2: Run to verify failure** — `python3 -m unittest discover -s scripts/tests -v`, expected FAIL.

- [ ] **Step 3: Implement** `compare_release_assets` and `verify-release.py`.

- [ ] **Step 4: Write `release.yml`.** Trigger `push: tags: ['v*']` plus `workflow_dispatch` with input `tag`. `permissions: contents: write`. Single job on `windows-latest`, `concurrency: release-${{ github.ref }}`. Steps, in order:
  1. checkout with `fetch-depth: 0`; toolchains and caches as in `ci.yml`.
  2. Guard: tag `vX.Y.Z` matches `package.json` version; `gh release view <tag>` must fail (a release already exists → stop without changes).
  3. `pnpm install --frozen-lockfile`; `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets --locked -- -D warnings`; `pnpm typecheck`.
  4. `cargo test --workspace --locked 2>&1 | Tee-Object artifacts/cargo-test.log`; `pnpm --filter @nebulume/ui exec vitest run --reporter=json --outputFile=../../artifacts/vitest.json`; `NEBULUME_BROWSER_CHANNEL=msedge` Playwright with `--reporter=json` to `artifacts/playwright.json`.
  5. Build with secrets in env: `pnpm --dir crates/neb-app exec tauri build --bundles nsis -- --locked`.
  6. Signature check: `Get-AuthenticodeSignature` on the installer; `unsigned` = status not `Valid`.
  7. `collect-validation.py` → `artifacts/release-validation.json`; `package-release.py --notes-from CHANGELOG.md --output-dir artifacts/releases/<tag> ...`.
  8. `gh release create <tag> --draft --title "Nebulume <version>" --notes-file <notes>` followed by an explicit list of the six whitelist files (no globs).
  9. `verify-release.py --tag <tag> --output-dir artifacts/releases/<tag>`.
  10. Upload `artifacts/` (logs, validation, manifest) as a workflow artifact, retained 90 days.
      Publishing the draft stays manual: `gh release edit <tag> --draft=false`.

- [ ] **Step 5: Run to verify pass** — unit tests pass; `actionlint .github/workflows/release.yml` if available, otherwise `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"`.

- [ ] **Step 6: Commit** — `ci: tag-triggered signed release with readback`

---

### Task 7: Documentation and end-to-end acceptance

**Files:**

- Modify: `docs/RELEASING.md`, `docs/STATUS.md`, `docs/API.md` (the two Tauri commands), `CHANGELOG.md` (unreleased section), `.github/workflows/ci.yml` (add `python -m unittest discover -s scripts/tests` on one OS)

- [ ] **Step 1: Rewrite `RELEASING.md`**: pipeline as the primary path; key custody and rotation (losing the key cuts off updates; rotating requires shipping one release signed by the old key that carries the new `pubkey`); manual publish; local fallback commands with `TAURI_SIGNING_PRIVATE_KEY` set in the shell; first-time note that 0.1.x users must install the updater-enabled version once by hand.

- [ ] **Step 2: Update `STATUS.md`** (auto-update for the Windows installer only; portable ZIP excluded) and add the unreleased CHANGELOG entry.

- [ ] **Step 3: Acceptance on Windows (human-run, record results in the PR).** Tag `v0.2.0-rc` style is not stable semver and is refused by the guard, so acceptance uses a fork or a throwaway repository: release N (`0.2.0`) and N+1 (`0.2.1`); install N; confirm the prompt appears within ~10 s, progress is shown, the app restarts as N+1, ratings and cache survive; repeat with the network disabled to confirm the silent failure path.

- [ ] **Step 4: Full verification.**

Run: `cargo fmt --all -- --check && cargo test --workspace --locked && cargo clippy --workspace --all-targets --locked -- -D warnings && pnpm test && pnpm typecheck && pnpm build && python3 -m unittest discover -s scripts/tests`
Expected: all pass.

- [ ] **Step 5: Commit** — `docs: release pipeline and in-app updates`
