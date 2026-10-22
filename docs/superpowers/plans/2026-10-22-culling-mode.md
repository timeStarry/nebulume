# 选图模式（阶段 B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在查看窗口中加入选图模式：留用/淘汰旗标、快捷键打星打旗、确认动效、可配置自动前进、对比视图、撤销，并在网格中按旗标筛选。

**Architecture:** neb-core 新增 v6 迁移与 `flag` 字段及命令；neb-service 透传并加库租约；neb-app 的查看窗口上下文增加 `mode` 与可选队列描述；前端以纯函数模块 `culling.ts` 承载按键映射、撤销栈与前进决策，`Viewer.tsx` 在选图模式下渲染 HUD 与对比视图。

**Tech Stack:** Rust（rusqlite、serde）、Tauri 2、SolidJS、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-22-location-library-culling-design.md` §7、§4.3、§4.5、§9

## Global Constraints

- schema v6 = `assets.flag TEXT NOT NULL DEFAULT 'none' CHECK(flag IN ('none','pick','reject'))`、`assets.import_batch_id TEXT`、`assets.sha256 TEXT`，索引 `assets_library_flag(library_id,flag)`、`assets_library_batch(library_id,import_batch_id)`。迁移不读原片、不联网，保留 id/评级/裁剪。
- 选图只写 SQLite 标记，永不修改原片、不触发网络写入，标记不使预览失效。
- 选图模式快捷键：`1–5/0` 星级，`P/X/U` 留用/淘汰/清除，`←/→`，`G/C` 单张/对比，`Z` 适合↔1:1，`Ctrl/⌘+Z` 撤销，`Tab` HUD，`Shift+C` 切换模式，`Shift+F` 对焦区域，`F` 全屏，`Esc` 退出全屏否则关闭。普通查看模式快捷键不变（另加 `Shift+C` 进入选图）。
- 确认动效 ≤300ms（定为 250ms）；`prefers-reduced-motion` 时无位移；自动前进默认开启。
- 选图会话内队列成员冻结；写失败回滚 HUD 并不前进。
- 契约变更同步 docs/API.md；行为写入 docs/INTERACTION.md、docs/STATUS.md。

## Review Focus

- 自动前进到队列最后一张：停在最后一张并提示“已到最后一张”，不循环、不关闭窗口。（Task 4 测试）
- 动效期间连续快速按键：每个按键都被处理，不丢键、不重复前进两张。（Task 4 测试）
- 撤销跨照片：撤销把上一次标记的照片恢复到原星级/旗标并切回该照片。（Task 4 测试）
- 筛选为“未标记”时进入选图：打标后照片仍在队列中。（Task 3 测试：快照 id 列表与后续 asset.list 无关）
- 旧库升级到 v6：所有资产 flag=none，评级裁剪不变；v6 二进制打开 v6 库不重复迁移。（Task 1 测试）

---

### Task 1: Core v6 迁移与旗标命令

**Files:**
- Modify: `crates/neb-core/src/catalog.rs`（迁移、`ASSET_COLUMNS`、行映射、dispatch、`AssetQuery`、`list_assets` where）
- Modify: `crates/neb-core/src/model.rs`（`Asset.flag: String`，serde default `"none"`）
- Test: `crates/neb-core/tests/culling.rs`

**Interfaces:**
- Produces: `asset.flag {id, flag}` → `Asset`；`asset.mark_batch {ids: string[] (1–1000), rating?: 0..5, flag?}` → `{updated: number}`（单事务，任一 id 不存在则 `E_NOT_FOUND` 且全部回滚）；`asset.list` 接受 `flag?: 'any'|'pick'|'none'|'reject'|'not_reject'`（默认 any）；`Asset.flag`。

- [ ] Step 1: 写测试 `flag_round_trip_and_filters`：建库扫描 3 张 → `asset.flag` pick/reject → `asset.list {flag:'pick'}` total=1，`not_reject` total=2，`any` total=3；非法 flag 返回 `E_INVALID`。
- [ ] Step 2: 写测试 `mark_batch_is_atomic`：含一个不存在 id 时报错且无任何资产改变；合法批次同时设置 rating=3、flag=pick 返回 updated=2。
- [ ] Step 3: 写测试 `v5_catalog_upgrades_to_v6_preserving_marks`：手工构造 v5 库（用当前二进制建库后 `PRAGMA user_version=5` 并 `ALTER TABLE assets DROP COLUMN flag/import_batch_id/sha256`），重开后 flag 为 none、评级裁剪保留、`user_version=6`。
- [ ] Step 4: 运行 `cargo test -p neb-core --test culling`，预期失败。
- [ ] Step 5: 实现迁移（`version<=6` 上限）、字段、命令、筛选。
- [ ] Step 6: `cargo test -p neb-core` 全部通过；提交。

### Task 2: Service 路由与锁

**Files:**
- Modify: `crates/neb-service/src/lib.rs`（`asset.mark_batch` 取首个 id 所在库加锁并校验所有 id 同库，否则 `E_INVALID`）
- Modify: `crates/neb-service/src/remote_cache.rs:601`（`asset.flag` 与 rate 同路径返回 `asset_value`；`asset.mark_batch` 直通 core）
- Test: `crates/neb-service/tests/culling.rs`

- [ ] Step 1: 测试 `service_flags_local_assets_and_rejects_cross_library_batch`。
- [ ] Step 2: 运行失败 → 实现 → `cargo test -p neb-service --test culling` 通过；提交。

### Task 3: 查看窗口上下文增加模式与队列

**Files:**
- Modify: `crates/neb-app/src/viewer.rs`（`ViewerContext {asset_id, asset_ids, mode: "view"|"cull", queue: Option<ViewerQueue>}`；`ViewerQueue {library_id, options: serde_json::Value}`；`open_viewer` 新增可选 `mode`、`queue` 参数；`options` 序列化后 ≤8KiB）
- Modify: `packages/ui/src/api.ts`（`openViewerWindow(assetId, assetIds, extra?: {mode?, queue?})`，`viewerContext()` 返回新类型）
- Create: `packages/ui/src/culling.ts`（`snapshotQueue(execute, libraryId, options, startId): Promise<string[]>`：以 limit 1000 分页拉取 id，最多 10000，起点不在结果中时置首）
- Test: `crates/neb-app/src/viewer.rs` 单元测试；`packages/ui/tests/culling.test.ts`

决定：冻结方式为“窗口打开时一次性分页快照 id 列表到查看窗口内存”。上下文只传队列描述，快照之后与 asset.list 无关，满足冻结语义。

- [ ] Step 1: Rust 测试 `viewer_context_carries_mode_and_bounded_queue`（mode 非法 → E_INVALID；options 超 8KiB → E_LIMIT）。
- [ ] Step 2: Vitest `snapshotQueue pages until total and keeps start first`、`snapshot is unaffected by later marks`。
- [ ] Step 3: 实现；`cargo test -p neb-app`（若平台依赖不可用则 `cargo check -p neb-app`）、`pnpm test` 通过；提交。

### Task 4: 选图状态机（纯函数）

**Files:**
- Modify: `packages/ui/src/culling.ts`
- Test: `packages/ui/tests/culling.test.ts`

**Interfaces:**
- `type CullAction = {kind:'rate',value:0..5} | {kind:'flag',value:'pick'|'reject'|'none'} | {kind:'move',delta:1|-1} | {kind:'view',value:'single'|'compare'} | {kind:'zoom'} | {kind:'undo'} | {kind:'hud'} | {kind:'mode'} | {kind:'focus'} | {kind:'fullscreen'} | {kind:'escape'}`
- `cullKeyAction(event: {key, shiftKey, ctrlKey, metaKey, altKey}): CullAction | null`
- `type Mark = {id:string, rating:number, flag:Flag}`；`class UndoStack {push(before: Mark): void; pop(): Mark | undefined}`，上限 200。
- `nextAfterMark(index, length, autoAdvance): {index:number, atEnd:boolean}`

- [ ] Step 1: 测试按键映射全表（含 `Shift+C`→mode、`Shift+F`→focus、`P`→pick、`c`→compare、Ctrl+Z→undo、Alt 组合→null）。
- [ ] Step 2: 测试 `nextAfterMark` 在末尾 atEnd=true 不越界；autoAdvance=false 不移动。
- [ ] Step 3: 测试撤销栈 LIFO 与上限。
- [ ] Step 4: 实现并 `pnpm test` 通过；提交。

### Task 5: 前端模型、浏览器演示与同步

**Files:**
- Modify: `packages/ui/src/model.ts`（`Asset.flag?: Flag`、`AssetListOptions.flag?`、`export type Flag`）
- Modify: `packages/ui/src/workspace.ts`（`browserAssetList` 支持 flag）
- Modify: `packages/ui/src/demo.ts`（`asset.flag`、`asset.mark_batch`、新资产 flag none）
- Modify: `packages/ui/src/management-sync.ts`（`AssetChange` 增加 `'flag'`；`changedAssetFields` 识别 flag；`needsCatalogReconcile` 在 flag 筛选非 any 时返回 true）
- Test: `packages/ui/tests/catalog-query.test.ts`、`packages/ui/tests/management-sync.test.ts`

- [ ] Step 1: 加测试 → 失败 → 实现 → `pnpm test`、`pnpm typecheck` 通过；提交。

### Task 6: 选图模式 UI 与网格入口

**Files:**
- Modify: `packages/ui/src/Viewer.tsx`（`mode` 信号；选图模式下键盘走 `cullKeyAction`；HUD：星级、旗标、n/N、自动前进开关；250ms 动效 class；对比视图 2–4 张由当前及后续照片组成，焦点项打标；写失败回滚）
- Create: `packages/ui/src/culling.css`
- Modify: `packages/ui/src/ManagementApp.tsx`（工具栏“选图”按钮与 `Shift+C`；旗标筛选 select：全部/留用/未标记/淘汰/隐藏淘汰；设置页“浏览与选图”中自动前进开关，存 `localStorage` 键 `nebulume.cull.auto-advance`，阶段 E 迁入 Rust 设置）
- Modify: `packages/ui/src/PhotoView.tsx`（缩略图标题显示旗标）
- Test: `packages/ui/tests/browser/culling.spec.ts`

- [ ] Step 1: Playwright `culling.spec.ts`：浏览器模式加载演示图 → 网格按 `Shift+C` → 覆盖层显示“选图” → 按 `3` 后 HUD 显示 3 星且序号前进 → 按 `X` 后前进 → `Ctrl+Z` 回到上一张并恢复旗标 → 关闭后网格筛选“淘汰”为空。
- [ ] Step 2: 实现；`pnpm typecheck`、`pnpm test`、`pnpm test:browser -- culling` 通过；提交。

### Task 7: 文档

- Modify: `docs/API.md`（v6、`asset.flag`、`asset.mark_batch`、`flag` 筛选、`Asset.flag`、`open_viewer` 新参数）、`docs/INTERACTION.md`（选图模式一节）、`docs/STATUS.md`（已实现与边界）、`docs/ARCHITECTURE.md`（v6）
- [ ] 更新并提交。
