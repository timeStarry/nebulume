# Design System and Full App Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one design system (tokens, Tabler icons, shared Solid components, two page layouts) from `docs/mockups/design-system.html`, rebuild every page of `packages/ui` on it, add customisable viewer overlay widgets and pinned inspector fields, and delete the old per-page CSS.

**Architecture:** Tokens in `src/tokens.css`. Components live in `src/ui/`, one `.tsx` and one `.css` per component; only these files and `tokens.css` may set colours, radii, control heights or font sizes. `scripts/check-design.mjs` enforces that rule as part of `pnpm test`. Pages compose `PageHeader` plus an optional `Toolbar` plus `SinglePage` or `SplitPage`. Overlay widgets come from a registry (`src/viewer-widgets.tsx`), and the layout persists in `localStorage`.

**Tech Stack:** SolidJS 1.9, Vite 6, Vitest 3 (node environment), Playwright, Tauri 2. New dependency: `@tabler/icons` (pinned exact version) as the SVG source.

**Spec:** `docs/superpowers/specs/2026-11-10-design-system-design.md`. Visual baseline: `docs/mockups/design-system.html`.

## Global Constraints

- Backend and Rust are unchanged; every service command and payload stays the same.
- Token values are copied exactly from `design-system.html` (`:root` and `[data-theme="light"]`), with the `--nl-` prefix and the names in the spec's token table.
- Control heights are only 24 / 28 / 32 / 40 px. Font weights are only 400 / 500. Font size is never below 11px. No shadows (except `inset` rings and focus rings), gradients, blur or glow.
- Font stack: `-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif`. Mono: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. No "Anthropic Sans".
- Icons are Tabler outline only, bundled and never loaded from a CDN. Sizes: 16 inline, 18 / 16 / 14 for icon buttons md / sm / xs, 20 in the rail.
- At most one `primary` button per page or panel. One visible entry per action; keyboard shortcuts and the context menu don't count as extra entries.
- Viewer stage, chrome and widgets use fixed dark values in both themes.
- Motion uses 120 / 180 / 280ms with `cubic-bezier(.2, 0, 0, 1)`. Everything is instant under `prefers-reduced-motion`.
- Existing behaviour assertions in the 97 unit and 111 browser tests are kept. Selectors may change; behaviour assertions are never deleted.
- New `localStorage` keys: `nebulume.viewer.overlay`, `nebulume.inspector.pinned`, `nebulume.viewer.overlay-fades`, `nebulume.last-library`.
- Copy is Chinese and sentence-style, with no mid-sentence bold.
- Every task ends with `pnpm typecheck`, `pnpm test`, `pnpm test:browser` and `npx prettier --check src tests` passing. Stop the 5173 preview server before running browser tests.
- Work on branch `claude/design-system`. Commit after each task, ending messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A saved overlay layout that is corrupt, from an older version, or names an unknown widget should fall back to the defaults, or drop just the unknown entries, and never crash the viewer. Pinned in Task 3.
2. A photo with no EXIF (screenshots, PNGs, the browser demo) should show no empty widget boxes and no "undefined", and the inspector should show "—" for missing values. Pinned in Tasks 3 and 9.
3. A library that is offline or needs login should still show its sidebar row, status dot and menu, and actions it can't run should be disabled with the reason as a tooltip. Pinned in Task 6.
4. An import to a remote library that hasn't passed a write test should keep "开始导入" disabled, and the side panel should show the write-test row and why. Pinned in Task 11.
5. In a narrow window (1024×700), the page header should collapse its segmented control labels to icons before anything overlaps, and the sidebar should become a drawer as it does today. Pinned in Task 5.

---

## File Structure

```
packages/ui/
  scripts/check-design.mjs          design-rule linter (Task 2)
  src/tokens.css                    rewritten token set (Task 1)
  src/Icon.tsx                      Tabler-backed, same call signature (Task 1)
  src/icons.ts                      generated map name -> SVG inner markup (Task 1)
  src/ui/                           shared components (Tasks 1, 2, 4)
    Button.tsx/.css  IconButton.tsx/.css  Tooltip.tsx/.css  Kbd.tsx
    Field.tsx/.css   TextInput.tsx  Select.tsx  Segmented.tsx/.css
    Switch.tsx/.css  Checkbox.tsx  Radio.tsx  Slider.tsx/.css
    Chip.tsx/.css    Toggle.tsx  Badge.tsx/.css  StatusDot.tsx
    Group.tsx/.css   ListRow.tsx
    Menu.tsx/.css    Toast.tsx/.css  Banner.tsx/.css  Dialog.tsx/.css
    Steps.tsx/.css   Progress.tsx/.css  Spinner.tsx  EmptyState.tsx/.css
    DataTable.tsx/.css  Drawer.tsx/.css
    PageHeader.tsx/.css  Toolbar.tsx/.css  Layout.tsx/.css (SinglePage, SplitPage)
    index.ts                        re-exports
  src/DesignReference.tsx           ?design=1 reference page, dev only (Task 4)
  src/AppShell.tsx                  rail + sidebar slot + main (Task 5)
  src/library/                      LibraryPage.tsx, LibraryToolbar.tsx, BatchBar.tsx,
                                    LibraryMenu.ts (Tasks 6, 7)
  src/viewer-widgets.tsx            widget registry (Task 3)
  src/overlay-layout.ts             layout model + persistence, pure (Task 3)
  src/ViewerOverlay.tsx             renders and edits corners (Task 9)
  src/inspector-fields.ts           pinned-field model + persistence, pure (Task 3)
  src/InfoPanel.tsx                 replaces AssetInspector layout (Task 9)
  src/import/                       ImportPage.tsx, ImportSetup.tsx, ImportReview.tsx,
                                    ImportResult.tsx, ImportHistory.tsx (Tasks 10, 11)
  src/locations/LocationsPage.tsx   (Task 12)
  src/settings/SettingsPage.tsx     (Task 12)
  tests/overlay-layout.test.ts  tests/inspector-fields.test.ts  tests/check-design.test.ts
  tests/browser/design-system.spec.ts  tests/browser/overlay.spec.ts
  tests/browser/import-flow.spec.ts
```

The existing `ManagementApp.tsx` keeps its state, data loading and sync logic, and loses its markup to `AppShell` and the page components. `ImportWorkspace.tsx` keeps its state machine, and its markup moves into `src/import/`. Removed in Task 13: `styles.css`, `import.css`, `cache-settings.css`, `inspector.css`, `viewer.css`, `culling.css`, `capture-index.css`, `update.css`, `viewer-focus.css`, `theme.css`, `VirtualGrid.tsx`, `ThemeControl.tsx` (its control is replaced by `Segmented`), and `AssetInspector.tsx` (its contents move into `InfoPanel.tsx`).

---

### Task 1: Tokens, icons and core controls

**Files:**
- Modify: `src/tokens.css` (full rewrite), `src/Icon.tsx`, `src/main.tsx`, `package.json`
- Create: `src/icons.ts`, `scripts/build-icons.mjs`, `src/ui/{Button,IconButton,Tooltip,Kbd,Field,TextInput,Select,Segmented,Switch,Checkbox,Radio,Slider}.tsx` with their `.css`, `src/ui/index.ts`
- Test: `tests/icons.test.ts`

**Interfaces:**
- Produces:
  - `Icon(props: { name: IconName; size?: 14 | 16 | 18 | 20 | 24; class?: string })`, always `aria-hidden`. `IconName` is a union of the keys in `src/icons.ts`. Every old icon name (`grid photo folder cloud card plus search left right down crop export refresh star check close info settings expand minus menu clock filter more`) maps to a Tabler icon, so existing call sites compile.
  - `Button(props: { variant?: 'primary'|'secondary'|'ghost'|'danger'; size?: 'sm'|'md'|'lg'; icon?: IconName; busy?: boolean; type?; disabled?; onClick?; children; ...button attrs })`, class `nl-btn nl-btn--{variant} nl-btn--{size}`.
  - `IconButton(props: { icon: IconName; label: string; size?: 'xs'|'sm'|'md'; shortcut?: string; pressed?: boolean; onClick?; ...button attrs })`. `label` sets `aria-label` and the tooltip text, `shortcut` sets `aria-keyshortcuts` and appears in the tooltip, and `pressed` sets `aria-pressed`.
  - `Tooltip(props: { label: string; shortcut?: string; children: JSX.Element })` shows after 500ms of hover or focus and is positioned in normal flow (no `position: fixed` on the document).
  - `Kbd(props: { children })`.
  - `Field(props: { label: string; help?: string; error?: string; children: (id: string) => JSX.Element })`.
  - `TextInput(props: { value; onInput; icon?: IconName; suffix?: string; shortcut?: string; invalid?: boolean; size?: 'sm'|'md'; ...input attrs })`.
  - `Select(props: { value; onChange; options: { value: string; label: string; disabled?: boolean }[]; size?: 'sm'|'md'; ...select attrs })`.
  - `Segmented<T extends string>(props: { value: T; onChange(v: T); options: { value: T; label: string; icon?: IconName; shortcut?: string; disabled?: boolean }[]; size?: 'sm'|'md'; label: string; role?: 'tablist'|'radiogroup'; compact?: boolean })`. `compact` hides labels and shows icons only, with each label kept as `aria-label`.
  - `Switch(props: { checked; onChange(v: boolean); label: string; disabled? })`, where `label` sets `aria-label`.
  - `Checkbox` and `Radio(props: { checked; onChange; children; name?; disabled? })`.
  - `Slider(props: { value; min; max; step?; onInput; label: string })`.

- [ ] **Step 1: Write the failing test** `tests/icons.test.ts`

```ts
import { icons } from '../src/icons';
const legacy = ['grid','photo','folder','cloud','card','plus','search','left','right','down','crop','export','refresh','star','check','close','info','settings','expand','minus','menu','clock','filter','more'];
test('every legacy icon name still resolves', () => { for (const name of legacy) expect(icons[name as keyof typeof icons]).toMatch(/<(path|circle|rect|line|polyline)/); });
test('no filled variants are bundled', () => { expect(Object.keys(icons).some((k) => k.endsWith('-filled'))).toBe(false); });
```

- [ ] **Step 2: Run it.** `pnpm vitest run tests/icons.test.ts` should FAIL with "Cannot find module '../src/icons'".

- [ ] **Step 3: Add `@tabler/icons` and write `scripts/build-icons.mjs`.**
  - Add `@tabler/icons` as a devDependency at an exact version.
  - The script reads the outline SVGs for a fixed list of names (legacy aliases plus every icon used by `design-system.html` and the spec's pages) and writes `src/icons.ts`: `export const icons = { name: '<path …/>' … } as const; export type IconName = keyof typeof icons;`. Legacy aliases: `grid→layout-grid, photo→photo, folder→folder, cloud→cloud, card→sd, plus→plus, search→search, left→chevron-left, right→chevron-right, down→chevron-down, crop→crop, export→download, refresh→refresh, star→star, check→check, close→x, info→info-circle, settings→settings, expand→arrows-maximize, minus→minus, menu→menu-2, clock→clock, filter→filter, more→dots`.
  - Commit the generated file. Add the script as `"icons": "node scripts/build-icons.mjs"`.

- [ ] **Step 4: Rewrite `Icon.tsx`.** Render `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width={size} height={size} aria-hidden="true" innerHTML={icons[name]} />`. The default size is 16.

- [ ] **Step 5: Rewrite `tokens.css`.** Use the spec's token table and the demo's values. Keep the old variable names that existing CSS still uses as aliases in a clearly separated `/* legacy aliases, removed in Task 13 */` block, mapped to the new tokens, so nothing breaks before pages migrate. Add `--nl-hist-red/green/blue` (fill and stroke, copied from today's `inspector.css`).

- [ ] **Step 6: Build the core controls in `src/ui/`** with the classes and sizes above. Each component's CSS uses only tokens. Import `./ui/index.ts` styles from `main.tsx` before the legacy CSS.

- [ ] **Step 7: Verify.** `pnpm vitest run tests/icons.test.ts` passes, `pnpm typecheck` passes, and the full browser suite passes. The legacy pages look the same because the aliases keep them working.

- [ ] **Step 8: Commit.** `feat(ui): design tokens, bundled Tabler icons and core controls`

### Task 2: Design check, feedback components and layout components

**Files:**
- Create: `scripts/check-design.mjs`, `tests/check-design.test.ts`, `src/ui/{Chip,Toggle,Badge,StatusDot,Group,ListRow,Menu,Toast,Banner,Dialog,Drawer,Steps,Progress,Spinner,EmptyState,DataTable,PageHeader,Toolbar,Layout}.tsx` with their `.css`
- Modify: `package.json` (`"test": "node scripts/check-design.mjs && vitest run"`), `src/ui/index.ts`

**Interfaces:**
- Produces:
  - `checkCss(path: string, text: string): { line: number; rule: string; snippet: string }[]`, exported from `scripts/check-design.mjs` and runnable as a CLI that exits 1 with a report.
  - Its rules are `hex-color`, `rgb-color`, `shadow`, `font-weight`, `font-size-px`, `gradient` and `blur`.
  - Files under `src/ui/`, `src/tokens.css` and the legacy files listed in `scripts/design-allowlist.json` are skipped. That allowlist starts with every current legacy CSS file and must be empty by Task 13.
  - `Chip(props: { label; onRemove?: () => void; removeLabel?: string })`
  - `Toggle(props: { pressed; onChange; icon?; children })`
  - `Badge(props: { tone?: 'neutral'|'pick'|'reject'|'warn'|'info'; icon?; children })`
  - `StatusDot(props: { state: 'ok'|'off'|'warn'|'bad'; label: string })`, where `label` is visually hidden unless `showLabel`.
  - `Group(props: { title: string; meta?: JSX.Element; action?: JSX.Element; children })`
  - `ListRow(props: { title: string; description?: string | JSX.Element; leading?: IconName; control?: JSX.Element; onClick?: () => void; nav?: boolean })`. With `nav`, the whole row is a `<button>` and shows a trailing chevron.
  - `Menu(props: { state: ContextMenuState; onClose })`. `ContextMenuState` and `OverflowItem` keep their current shapes, and `OverflowItem` gains `icon?: IconName; shortcut?: string; destructive?: boolean; heading?: string`. Keyboard behaviour is copied from `ContextMenu.tsx`. `ContextMenu.tsx` and `OverflowMenu.tsx` become thin wrappers so call sites compile.
  - `Toast(props: { tone?: 'neutral'|'error'; icon?; message; action?: { label; run }; onClose })`, plus `toasts.show(t: ToastInput): void` from `src/ui/toasts.ts`, a single-slot store where a new toast replaces the old one. It auto-dismisses after 6s, 10s when there's an `action`, and never for errors.
  - `Banner(props: { tone?: 'neutral'|'info'|'warn'|'error'; message; detail?; action?: JSX.Element; onClose? })`
  - `Dialog(props: { title; onClose; footer: JSX.Element; children; width?: number })`. It keeps the focus trap and return-focus logic of today's `Modal`.
  - `Drawer(props: { title; onClose; width?: 360; children })`
  - `Steps(props: { steps: string[]; current: number; label: string })`
  - `Progress(props: { value?: number; label: string })`, indeterminate when `value` is undefined.
  - `Spinner`
  - `EmptyState(props: { icon: IconName; title; description?; actions?: JSX.Element })`
  - `DataTable<T>(props: { columns: { key; label; align?: 'end'; render?(row: T) }[]; rows: T[]; empty?: string })`
  - `PageHeader(props: { title; subtitle?; center?: JSX.Element; actions?: JSX.Element; leading?: JSX.Element })`, 56px.
  - `Toolbar(props: { children })`, 44px.
  - `SinglePage(props: { children })`, max 760px and centred.
  - `SplitPage(props: { main: JSX.Element; aside: JSX.Element; asideFooter?: JSX.Element })`, with a 300px aside whose footer is pinned.

- [ ] **Step 1: Write the failing test** `tests/check-design.test.ts`

```ts
import { checkCss } from '../scripts/check-design.mjs';
test('flags each forbidden pattern', () => {
  const r = checkCss('src/x.css', '.a{color:#fff}\n.b{box-shadow:0 1px 2px red}\n.c{font-weight:600}\n.d{font-size:10px}\n.e{background:linear-gradient(red,blue)}\n.f{filter:blur(2px)}\n.g{color:rgb(1,2,3)}');
  expect(r.map((x) => x.rule)).toEqual(['hex-color','shadow','font-weight','font-size-px','gradient','blur','rgb-color']);
});
test('allows tokens, inset rings and focus outlines', () => {
  expect(checkCss('src/x.css', '.a{color:var(--nl-text);box-shadow:inset 0 0 0 1px var(--nl-line);font-size:var(--nl-t-13);font-weight:500;outline:2px solid var(--nl-ring)}')).toEqual([]);
});
test('ui components and tokens are exempt', () => {
  expect(checkCss('src/ui/Button.css', '.a{color:#fff}')).toEqual([]);
  expect(checkCss('src/tokens.css', '.a{color:#fff}')).toEqual([]);
});
```

- [ ] **Step 2: Run it.** It should FAIL because the module is not found.
- [ ] **Step 3: Implement `checkCss` and the CLI** using a line-based regex scan with comments stripped first. Build the remaining components.
- [ ] **Step 4: Verify.** `pnpm test` passes, and the check passes because legacy files are on the allowlist. Typecheck and browser tests pass.
- [ ] **Step 5: Commit.** `feat(ui): design check and the remaining shared components`

### Task 3: Overlay layout and pinned-field models (pure)

**Files:**
- Create: `src/overlay-layout.ts`, `src/inspector-fields.ts`, `src/viewer-widgets.tsx`
- Test: `tests/overlay-layout.test.ts`, `tests/inspector-fields.test.ts`

**Interfaces:**
- Produces:
  - `type Corner = 'tl'|'tr'|'bl'|'br'`, `type OverlayLayout = Record<Corner, string[]>`, `DEFAULT_OVERLAY: OverlayLayout = { tl: ['captured'], tr: ['rating','flag'], bl: ['body-lens','exposure'], br: ['histogram'] }`.
  - `readOverlay(storage: Pick<Storage,'getItem'>, known: Set<string>): OverlayLayout`. It parses `nebulume.viewer.overlay`, returns the default on missing, corrupt or wrong-shape data, drops unknown ids and duplicates, and keeps the first occurrence across corners.
  - `writeOverlay(storage, layout)`
  - `moveWidget(layout, id, to: Corner, index: number): OverlayLayout`. Use `index = -1` to append. It removes `id` from wherever it was.
  - `removeWidget(layout, id)`
  - `addWidget(layout, id, corner)`
  - `shiftWidget(layout, id, delta: -1|1)`, which moves the widget within its corner and clamps at the ends.
  - `widgetsNotIn(layout, all: string[]): string[]`
  - `readOverlayFades(storage): boolean` defaults to false, and `writeOverlayFades`.
  - `type FieldId = string`, `DEFAULT_PINNED: FieldId[] = ['exposure','focal','lens','body','captured','dimensions']`.
  - `readPinned(storage, known: Set<string>): FieldId[]` reads `nebulume.inspector.pinned` with the same fallback rules.
  - `writePinned`, `togglePinned(list, id): FieldId[]`, which appends when pinning, and `movePinned(list, id, delta: -1|1)`.
  - `fieldValue(id: FieldId, asset: Asset): string | null`, built on `inspector-metadata.ts` aliases. `exposure` joins aperture, shutter and ISO with ` · `, `focal` is the focal length, `body` is `Camera` or `Model`, `lens` is `Lens`, `captured` formats `captured_at` as `M月D日 HH:mm`, and `dimensions` is `W × H`. Everything else is a raw metadata key. It returns null when the value is missing or blank.
  - `WIDGETS: WidgetDef[]`, where `WidgetDef = { id: string; name: string; group: '文件'|'曝光'|'器材'|'评价'|'其他'; needsHistogram?: boolean; render(asset: Asset, ctx: WidgetContext): JSX.Element | null }` and `WidgetContext = { index: number; total: number; folder?: string; histogram?: Histogram }`.
  - The ids are `filename`, `position`, `folder`, `captured`, `rating`, `flag`, `exposure`, `aperture`, `shutter`, `iso`, `focal`, `exposure-bias`, `metering`, `white-balance`, `body`, `lens`, `body-lens`, `histogram`, `dimensions`, `file-size`, `format` and `gps`. `render` returns null when its data is missing.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/overlay-layout.test.ts
const store = (v: string | null) => ({ getItem: () => v });
const known = new Set(['captured','rating','flag','body-lens','exposure','histogram','iso']);
test('missing or corrupt storage gives the default', () => {
  expect(readOverlay(store(null), known)).toEqual(DEFAULT_OVERLAY);
  expect(readOverlay(store('{oops'), known)).toEqual(DEFAULT_OVERLAY);
  expect(readOverlay(store('[1,2]'), known)).toEqual(DEFAULT_OVERLAY);
});
test('unknown ids and duplicates are dropped', () => {
  expect(readOverlay(store(JSON.stringify({ tl: ['iso','nope'], tr: ['iso','flag'], bl: [], br: [] })), known)).toEqual({ tl: ['iso'], tr: ['flag'], bl: [], br: [] });
});
test('moving keeps one copy and appends with -1', () => {
  const l = moveWidget(DEFAULT_OVERLAY, 'rating', 'bl', -1);
  expect(l.tr).toEqual(['flag']);
  expect(l.bl).toEqual(['body-lens','exposure','rating']);
});
test('shift clamps at the ends', () => {
  expect(shiftWidget(DEFAULT_OVERLAY, 'body-lens', -1).bl).toEqual(['body-lens','exposure']);
  expect(shiftWidget(DEFAULT_OVERLAY, 'body-lens', 1).bl).toEqual(['exposure','body-lens']);
});
test('fades default to off', () => { expect(readOverlayFades(store(null))).toBe(false); });

// tests/inspector-fields.test.ts
test('pinned fields default and toggle', () => {
  expect(readPinned({ getItem: () => null }, new Set(DEFAULT_PINNED))).toEqual(DEFAULT_PINNED);
  expect(togglePinned(['exposure'], 'Exposure Bias')).toEqual(['exposure','Exposure Bias']);
  expect(togglePinned(['exposure','focal'], 'exposure')).toEqual(['focal']);
});
test('missing EXIF gives null, never "undefined"', () => {
  const bare = { metadata: {}, width: undefined, height: undefined } as unknown as Asset;
  for (const id of DEFAULT_PINNED) expect(fieldValue(id, bare)).toBeNull();
});
test('exposure joins the three values', () => {
  const a = { metadata: { 'F Number': 'f/2.8', 'Exposure': '1/500', 'ISO': '200' } } as unknown as Asset;
  expect(fieldValue('exposure', a)).toBe('f/2.8 · 1/500 · ISO 200');
});
```

- [ ] **Step 2: Run them.** They should FAIL because the modules are not found.
- [ ] **Step 3: Implement the two pure modules and the widget registry.** Widgets render with the `.nl-widget` class, styled in `src/ui/Widget.css` (viewer dark values).
- [ ] **Step 4: Verify.** The new tests pass and the full suite passes.
- [ ] **Step 5: Commit.** `feat(ui): overlay layout and pinned field models with a widget registry`

### Task 4: Reference page `?design=1`

**Files:**
- Create: `src/DesignReference.tsx`, `tests/browser/design-system.spec.ts`
- Modify: `src/main.tsx`, so that `?design=1` renders `DesignReference` only when `import.meta.env.DEV`

**Interfaces:**
- Consumes: everything in `src/ui/` (Tasks 1 and 2) and `WIDGETS` (Task 3).

- [ ] **Step 1: Write the failing test** `tests/browser/design-system.spec.ts`

```ts
test('the reference page renders every control at the four heights only', async ({ page }) => {
  await page.goto('/?design=1');
  await expect(page.getByRole('heading', { name: '按钮' })).toBeVisible();
  const heights = await page.$$eval('.nl-btn, .nl-icon-btn, .nl-input, .nl-select, .nl-seg, .nl-chip, .nl-toggle', (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().height)))].sort());
  for (const h of heights) expect([24, 28, 32, 40]).toContain(h);
  const weights = await page.$$eval('body *', (els) => [...new Set(els.map((e) => getComputedStyle(e).fontWeight))]);
  expect(weights.every((w) => w === '400' || w === '500')).toBe(true);
  const tiny = await page.$$eval('body *', (els) => els.filter((e) => e.childNodes[0]?.nodeType === 3 && e.textContent!.trim() && parseFloat(getComputedStyle(e).fontSize) < 11).length);
  expect(tiny).toBe(0);
});
test('switching theme swaps the canvas colour', async ({ page }) => {
  await page.goto('/?design=1');
  await page.getByRole('tab', { name: '浅色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
```

- [ ] **Step 2: Run it.** It should FAIL because the heading is not found.
- [ ] **Step 3: Build the page** with the same sections as `design-system.html` (principles, colour, type, spacing, motion, buttons, inputs, tags, lists, overlays, feedback, plus one viewer corner with real widgets). It uses only `src/ui` components. Theme switching goes through `theme.ts`.
- [ ] **Step 4: Verify** that the test passes.
- [ ] **Step 5: Commit.** `feat(ui): dev-only design reference page`

### Task 5: App shell

**Files:**
- Create: `src/AppShell.tsx`, `src/AppShell.css`
- Modify: `src/ManagementApp.tsx` (shell markup only), `src/workspace.ts`
- Test: `tests/browser/management.spec.ts` (navigation tests), `tests/browser/design-system.spec.ts`

**Interfaces:**
- Produces:
  - `AppShell(props: { section: WorkspaceSection; onSection(s); sidebar?: JSX.Element; drawerOpen; onDrawer(open: boolean); compact: boolean; onOpenFile(); children })`.
  - The rail order is 图片库 (`libraries`), 导入 (`cards`), 位置 (`sources`); the bottom holds 打开文件… and 设置 (`settings`).
  - Rail buttons are `IconButton`-styled at 40px with icon size 20, and keep their current accessible names.
  - The compact drawer, focus trap and Escape handling move here unchanged from `ManagementApp`.

- [ ] **Step 1: Write the failing test** (appended to `design-system.spec.ts`)

```ts
test('the rail lists library, import and locations in that order, settings at the bottom', async ({ page }) => {
  await page.goto('/');
  const names = await page.getByRole('navigation', { name: '主导航' }).getByRole('button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label') || x.textContent!.trim()));
  expect(names.slice(0, 3)).toEqual(['图片库', '导入', '位置']);
  expect(names.at(-1)).toBe('设置');
});
test('at 1024×700 the header segmented control is icon-only and nothing overlaps', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  // open a library using the existing fixture from management-sync.spec (fixture(page, 12))
  // then assert .nl-seg[aria-label="视图"] has the class nl-seg--compact and that the header's children don't overlap
});
```

Copy the existing navigation label and the `fixture()` helper from `management-sync.spec.ts`. If today's navigation landmark is named differently, keep that name.

- [ ] **Step 2: Run it.** It should FAIL on the order, which today is 图片库 / 位置 / 导入.
- [ ] **Step 3: Implement `AppShell`** and replace the shell markup in `ManagementApp.tsx`. `PageHeader` compacts its centre `Segmented` when the header's own width is under 760px, measured with a `ResizeObserver`.
- [ ] **Step 4: Verify.** The new tests and all existing navigation, drawer and focus tests pass.
- [ ] **Step 5: Commit.** `feat(ui): app shell on the design system`

### Task 6: Library page, sidebar menu and the no-library state

**Files:**
- Create: `src/library/LibraryPage.tsx`, `src/library/LibraryToolbar.tsx`, `src/library/BatchBar.tsx`, `src/library/libraryMenu.ts`, `src/library/library.css`
- Modify: `src/ManagementApp.tsx` (remove the library-card page and the collection markup), `src/LibrarySidebar.tsx`
- Test: `tests/browser/management.spec.ts`, `tests/browser/management-sync.spec.ts`, `tests/workspace.test.ts`

**Interfaces:**
- Consumes: the `src/ui` components and the existing `ManagementApp` state (`libraries`, `libraryId`, `assets`, filters, `markSelection`, `exportSelection`, `trashSelection`, `scan`, …).
- Produces:
  - `libraryMenuItems(library: Library, ctx: { busy: boolean; desktop: boolean; edit(); scan(); pregenerate(); captureIndex(); fingerprint(); remove() }): OverflowItem[]`. Items are 编辑…, 扫描更新, 预生成缩略图, 补全拍摄时间…, 内容指纹…, separator, 移除登记… (destructive). An unavailable library disables 扫描更新 and 预生成缩略图 with the availability reason as `title`.
  - `pickInitialLibrary(libraries: Library[], last: string | null): Library | undefined` in `workspace.ts` returns the last-opened library if it's still visible, otherwise the first.
  - `LibraryPage` renders the `PageHeader` (title, subtitle with the photo count or folder path, centre `Segmented` 照片 / 选片 / 概览, actions 扫描更新 plus a 更多 `IconButton` using `libraryMenuItems`), then `LibraryToolbar` or `BatchBar`, then the content.
  - `LibraryToolbar` contains a search `TextInput sm` (shortcut ⌘F), 筛选 `Button ghost sm` (expands the second toolbar row; the state is remembered as today), `Chip`s, a spacer, the photo count in `--nl-text-3`, a 隐藏淘汰 `Toggle`, a sort `Select sm` plus a direction `IconButton`, a thumbnail `Slider`, and a 详情 `IconButton` (I).
  - `BatchBar` (shown when more than one photo is selected) contains `已选 N 张`, stars, 留用 / 淘汰 / 清除, 导出…, 移到废纸篓, and 取消选择.

- [ ] **Step 1: Write the failing tests** (in `management.spec.ts`)

```ts
test('the library header has one entry per action', async ({ page }) => {
  // existing desktop fixture, open the library
  const header = page.locator('.nl-page-header');
  await expect(header.getByRole('tab', { name: '选片' })).toBeVisible();
  await expect(header.getByRole('button', { name: '选图' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: '详情' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: '扫描更新' })).toBeVisible();
});
test('with no libraries the page offers to create one', async ({ page }) => {
  // fixture returning library.list = []
  await expect(page.getByRole('heading', { name: '还没有图片库' })).toBeVisible();
  await page.getByRole('button', { name: '新建图片库' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
test('the app opens the last library and the sidebar menu holds the library actions', async ({ page }) => {
  // two libraries, localStorage nebulume.last-library = second id
  // expect the header title to be the second library's name
  // open the sidebar row "⋯" and expect menu items 编辑…, 扫描更新, 预生成缩略图, 补全拍摄时间…, 内容指纹…, 移除登记…
});
test('an offline library keeps its row and disables scanning with the reason', async ({ page }) => {
  // library with availability 'offline'
  // expect StatusDot with label 离线 in its row; menu item 扫描更新 disabled with a title containing the reason
});
```

```ts
// tests/workspace.test.ts
test('pickInitialLibrary prefers the last visible library', () => {
  const libs = [{ id: 'a' }, { id: 'b' }] as Library[];
  expect(pickInitialLibrary(libs, 'b')?.id).toBe('b');
  expect(pickInitialLibrary(libs, 'gone')?.id).toBe('a');
  expect(pickInitialLibrary([], 'b')).toBeUndefined();
});
```

- [ ] **Step 2: Run them.** They should FAIL because the old header still has 选图 and 详情, and the card page still shows.
- [ ] **Step 3: Implement it.**
  - Delete the library-card page markup.
  - Opening the 图片库 section calls `enterLibrary(pickInitialLibrary(...))` and writes `nebulume.last-library` on every `enterLibrary`.
  - The no-library `EmptyState` uses 新建图片库 (primary) and 从存储卡导入 (secondary, navigates to `cards`). The browser demo shows 选择照片.
  - Move every current card action into `libraryMenuItems`. The sidebar header "+" opens `LibraryDialog`.
  - Rewrite the existing tests that clicked library cards so they use the sidebar rows instead. Keep their assertions.
- [ ] **Step 4: Verify.** The new and existing library tests pass.
- [ ] **Step 5: Commit.** `feat(ui): library page on the design system without a separate library list`

### Task 7: Photo wall, overview and culling on the system

**Files:**
- Modify: `src/JustifiedGrid.tsx` (classes only), `src/PhotoView.tsx` (tile classes), `src/LibraryOverview.tsx`, `src/CullPanel.tsx`, `src/CullStrip.tsx`, `src/CullReview.tsx`, `src/Viewer.tsx` (HUD removal), `src/culling.ts`
- Create: `src/library/wall.css`, `src/library/overview.css`, `src/cull.css`
- Test: `tests/culling.test.ts`, `tests/browser/culling.spec.ts`

**Interfaces:**
- Produces:
  - `CullPanel` gains a `pulse?: { kind: 'rate'|'flag'; key: number }` prop and shows `序号 / 总数` above the counts.
  - `cullKeyAction` maps `Tab` to `{ kind: 'overlay' }`, which replaces `'hud'`, and the viewer handles it the same way as D.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/culling.test.ts
test('Tab toggles the overlay in culling', () => { expect(cullKeyAction({ key: 'Tab' })).toEqual({ kind: 'overlay' }); });
```

```ts
// tests/browser/culling.spec.ts: replace hud() reads with the panel
// const position = (page) => page.getByRole('complementary', { name: '选片面板' }).locator('.cull-position');
// every expect(hud(page)).toContainText('1 / 3') becomes expect(position(page)).toHaveText('1 / 3'); assertions are otherwise unchanged
test('the mark confirmation plays on the panel even with no rating widget in the overlay', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nebulume.viewer.overlay', JSON.stringify({ tl: [], tr: [], bl: [], br: [] })));
  // open ?viewer=1 in cull mode, press 3
  // expect the panel to have class pulse-rate, and expect position to advance to 2 / 3
});
```

- [ ] **Step 2: Run them.** They should FAIL with `kind: 'hud'`, and `.cull-position` is missing.
- [ ] **Step 3: Implement it.**
  - Remove the `.cull-hud` markup and its CSS.
  - Move the pulse to `CullPanel`.
  - Restyle the wall, day headers, tiles, overview and cull components with tokens and `src/ui` components (`Button`, `Badge`, `Group`, `Progress`).
  - Keep the overview's chart colour on `--nl-series`.
- [ ] **Step 4: Verify.** All culling, overview and grid tests pass.
- [ ] **Step 5: Commit.** `feat(ui): wall, overview and culling on the design system; culling feedback lives on the panel`

### Task 8: Viewer chrome and the more menu

**Files:**
- Modify: `src/Viewer.tsx` (toolbar markup, keyboard), `src/PhotoView.tsx` (zoom controls)
- Create: `src/viewer-chrome.css`
- Test: `tests/browser/viewer-focus.spec.ts`, `tests/browser/workspace.spec.ts`, `tests/browser/culling.spec.ts`

**Interfaces:**
- Produces:
  - A 48px top bar with: back, filename (followed by `folder · i / n`), a spacer, a 查看 / 选片 `Segmented sm`, 叠加信息 `IconButton` (D, pressed state), 对焦点 (P / Shift+F), 信息 (I), 裁剪 (C), and 更多.
  - The standalone window adds 关闭 (Esc).
  - The 更多 items are 导出为 JPEG…, 重新读取原图 (desktop), 全屏 (F), 复制文件路径, 在图片库中显示, 加入图片库… (when outside), 编辑叠加信息…, separator, 移到废纸篓 (⌘⌫, local only).
  - Signals `overlayVisible: boolean`, toggled by D, Tab in culling, and the toolbar button, and `editingOverlay: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// viewer-focus.spec.ts or workspace.spec.ts:
// tests that clicked toolbar buttons '导出 JPEG' and '重新读取原图' now open 更多 and choose the menu item
// the assertions on the resulting calls stay unchanged
test('the viewer top bar has one entry per action', async ({ page }) => {
  // open the viewer via the existing fixture
  const bar = page.locator('.nl-viewer-bar');
  for (const name of ['叠加信息（D）', '信息（I）', '裁剪（C）', '更多']) await expect(bar.getByRole('button', { name })).toBeVisible();
  await expect(bar.getByRole('button', { name: '导出 JPEG' })).toHaveCount(0);
  await bar.getByRole('button', { name: '更多' }).click();
  await expect(page.getByRole('menuitem', { name: '编辑叠加信息…' })).toBeVisible();
});
```

- [ ] **Step 2: Run it.** It should FAIL because the export button is still in the bar.
- [ ] **Step 3: Implement the bar** with `IconButton`, `Segmented` and `Menu`. Keep the 2.4s auto-hide timer and the focus handling unchanged.
- [ ] **Step 4: Verify** with the full viewer, culling and workspace browser suites.
- [ ] **Step 5: Commit.** `feat(ui): viewer chrome with a more menu`

### Task 9: Overlay widgets and the info panel

**Files:**
- Create: `src/ViewerOverlay.tsx`, `src/ViewerOverlay.css`, `src/InfoPanel.tsx`, `src/InfoPanel.css`, `tests/browser/overlay.spec.ts`
- Modify: `src/Viewer.tsx`, `src/ManagementApp.tsx` (library 详情 uses `InfoPanel`), `tests/browser/inspector.spec.ts` (selectors)
- Delete: the markup in `src/AssetInspector.tsx` (its logic moves into `InfoPanel`)

**Interfaces:**
- Consumes: `readOverlay`, `writeOverlay`, `moveWidget`, `addWidget`, `removeWidget`, `shiftWidget`, `widgetsNotIn`, `readOverlayFades`, `WIDGETS`, `readPinned`, `writePinned`, `togglePinned`, `movePinned` and `fieldValue` from Task 3.
- Produces:
  - `ViewerOverlay(props: { asset: Asset; context: WidgetContext; visible: boolean; editing: boolean; onEditing(v: boolean); fades: boolean; chromeVisible: boolean })`.
    - Each corner is `role="group"` with `aria-label` 左上 / 右上 / 左下 / 右下.
    - Each widget is a focusable `.nl-widget` carrying `data-widget={id}`.
    - In edit mode the photo dims to 40% opacity, each corner shows a "+ 添加" button, and there's a bottom tray with the `widgetsNotIn` chips, 恢复默认, and 完成.
    - Drag and drop uses HTML5 DnD with `dataTransfer` `text/plain` = id.
    - Keyboard: "+ 添加" opens a `Menu` of available widgets grouped by `group`. Focusing a widget and pressing Enter (or the context menu) opens a `Menu` with 上移, 下移, 移到左上/右上/左下/右下 (excluding its own corner), and 移除. Escape leaves edit mode.
    - The histogram is fetched only while a histogram widget is in the layout and visible.
  - `InfoPanel(props: { asset: Asset; busy; cropMode; crop; setCrop; onSaveCrop; onResetCrop; onRate; onCrop; onExport; onRefresh?; onClose })`. These are the same props as `AssetInspector`, and all its content is kept (histogram with source note, file info, offline cache, focus status, diagnostics, crop editor).
    - The pinned list is first: rows are focusable, with a pin `IconButton` on each, and Alt+↑/↓ reorders.
    - Then 全部 EXIF (collapsed), where each row has a pin.
    - Missing values show "—".

- [ ] **Step 1: Write the failing tests** `tests/browser/overlay.spec.ts`

```ts
test('default corners show their widgets and missing data shows nothing', async ({ page }) => {
  // culling fixture, ?viewer=1, photo-1 with metadata { 'F Number': 'f/2.8', Exposure: '1/500', ISO: '200' } and no Camera or Lens
  await expect(page.locator('[data-widget="exposure"]')).toContainText('f/2.8');
  await expect(page.locator('[data-widget="body-lens"]')).toHaveCount(0);
  await expect(page.locator('.nl-overlay')).not.toContainText('undefined');
});
test('D hides and shows the overlay', async ({ page }) => { /* press d, expect .nl-overlay hidden; press d again, visible */ });
test('editing by keyboard adds, moves and removes a widget, and the layout persists', async ({ page }) => {
  // 更多 → 编辑叠加信息…; focus the 左上 group's "+ 添加", Enter, choose ISO
  // focus [data-widget="iso"], Enter, choose 移到右下
  // 完成; reload; expect [data-widget="iso"] inside the 右下 group
  // edit again, iso → 移除, 完成; expect localStorage overlay.br not to contain 'iso'
});
test('drag from the tray into a corner', async ({ page }) => {
  // enter edit, dragTo('.nl-overlay-tray [data-widget="gps"]' → group 左上); expect the 左上 group to contain data-widget="gps"
});
test('a corrupt saved layout falls back to the default', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nebulume.viewer.overlay', '{bad'));
  // open the viewer; expect [data-widget="captured"] inside the 左上 group
});
test('pinning a field in the info panel moves it to the top and persists', async ({ page }) => {
  // open info (I); expand 全部 EXIF; click pin on 曝光补偿; expect the pinned list to end with 曝光补偿
  // focus it, Alt+ArrowUp; expect it to be second-to-last; reload and expect the same order
});
```

- [ ] **Step 2: Run them.** They should FAIL because `.nl-overlay` is not found.
- [ ] **Step 3: Implement `ViewerOverlay` and `InfoPanel`.** Wire them into `Viewer` (overlay above `PhotoView`, `InfoPanel` in place of `AssetInspector`) and into the library 详情. Make the inspector tests target `InfoPanel` roles and names, keeping every assertion on content.
- [ ] **Step 4: Verify** with the full suite.
- [ ] **Step 5: Commit.** `feat(ui): customisable viewer overlay widgets and pinned info fields`

### Task 10: Import page skeleton, step 1 and the history drawer

**Files:**
- Create: `src/import/ImportPage.tsx`, `src/import/ImportSetup.tsx`, `src/import/ImportHistory.tsx`, `src/import/import.css`, `tests/browser/import-flow.spec.ts`
- Modify: `src/ImportWorkspace.tsx` (keeps its state and calls, renders `ImportPage`), `tests/browser/management.spec.ts` (import selectors)

**Interfaces:**
- Consumes: the existing `ImportWorkspace` signals and handlers. Keep their names, and pass them as props.
- Produces:
  - `ImportPage(props: { step: 0|1|2; onHistory(); children })` renders a `PageHeader` with title 导入, centre `Steps` (`['设置','核对','完成']`) and action 历史 (`Button ghost`).
  - `ImportSetup` has three `Group`s and a `SplitPage` aside "将会导入", with the aside footer holding `Button primary lg` 核对导入计划 and the note "下一步逐项列出，确认后才开始复制".
    - Sources are cards (`button[aria-pressed]`), with 选择其他文件夹… and 刷新 in the group action, and 所有卷 in the refresh menu.
    - Unregistered card rows: 卡名称, 登记这张卡, 绑定到已登记的卡.
    - Registered card rows: 卡名称 (rename).
    - 导入到 has the target `Select` (showing source type and `StatusDot`), the 跳过图片库里已有的照片 `Switch`, and the write-test row for remote targets.
    - 怎么整理 has the plan `Select` in the group action. Its options are 手动设置, the saved plans, 另存为方案… (opens a `Dialog`), and 设为这张卡的默认方案 when a registered card is selected. Its rows are 分类依据 `Segmented`, 日期层级 `Select`, 没有拍摄时间时 `Select`, 子目录 `TextInput`, 按类型分开 `Switch`, and 疑似重复也导入 `Switch` (remote only).
    - The aside summarises the source, the target and a one-line rule, plus the folder example tree (mono). It shows no counts.
  - `ImportHistory` is a `Drawer` titled 导入历史 with the current history items. Opening one shows its details and a 查看这批照片 action, which keeps today's batch filter.

- [ ] **Step 1: Write the failing tests** `tests/browser/import-flow.spec.ts`

```ts
// Reuse the card and import fixtures from management.spec.ts (copy the helper into this file or into fixtures.ts).
test('step 1 has one progress indicator and one primary action', async ({ page }) => {
  // open 导入
  await expect(page.getByRole('list', { name: '导入步骤' })).toBeVisible();
  await expect(page.locator('.nl-btn--primary')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '核对导入计划' })).toBeVisible();
  await expect(page.getByLabel('导入历史')).toHaveCount(0);
});
test('history opens in a drawer', async ({ page }) => {
  await page.getByRole('button', { name: '历史' }).click();
  await expect(page.getByRole('dialog', { name: '导入历史' })).toBeVisible();
});
test('a registered card can set the current plan as its default', async ({ page }) => {
  // registered card fixture; choose a saved plan, then in the plan select choose 设为这张卡的默认方案
  // expect a card.update call with default_preset_id
});
```

Port the existing import tests in `management.spec.ts` (card identify, register, bind, preset save, organise rules, example path) to the new labels. Keep every assertion on the service calls.

- [ ] **Step 2: Run them.** They should FAIL because the old layout has no 历史 button.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Verify** with the import tests and the full suite.
- [ ] **Step 5: Commit.** `feat(ui): import setup and history on the design system`

### Task 11: Import steps 2 and 3

**Files:**
- Create: `src/import/ImportReview.tsx`, `src/import/ImportResult.tsx`
- Modify: `src/ImportWorkspace.tsx`, `tests/browser/import-flow.spec.ts`

**Interfaces:**
- Produces:
  - `ImportReview`:
    - The main area has a `Toolbar` with a status `Segmented` (全部 / 新 / 已存在 / 疑似重复 / 问题, `aria-label="按状态筛选"`), then a `DataTable` (文件, 去向, 状态 `Badge`, 大小), with today's paging.
    - The aside shows the counts (新照片, 跳过, 疑似重复, 占用, 目标可用空间) and a `Banner warn` when there are issues.
    - The aside footer holds 开始导入 (`primary lg`) and 返回修改 (`ghost`).
    - While copying, the footer shows an indeterminate `Progress` labelled 正在复制并校验…, and 开始导入 is disabled.
  - `ImportResult`: the main area has an `EmptyState`-style result (icon, the title from `statusName`, one line) and a failures `DataTable`. The aside shows the summary, 打开图片库 (`primary`) and 再导入一批 (`secondary`).

- [ ] **Step 1: Write the failing tests**

```ts
test('review shows counts and starts the import; copying shows indeterminate progress', async ({ page }) => {
  // plan fixture with 3 new and 1 duplicate; make import.execute resolve after a 500ms delay
  await page.getByRole('button', { name: '核对导入计划' }).click();
  await expect(page.getByRole('complementary')).toContainText('新照片');
  await page.getByRole('button', { name: '开始导入' }).click();
  await expect(page.getByRole('progressbar', { name: '正在复制并校验…' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始导入' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: /导入完成|部分完成/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开图片库' })).toBeVisible();
});
test('an unverified remote target keeps 开始导入 disabled and says why', async ({ page }) => {
  // remote library fixture, write_capability 'unverified'
  // expect 开始导入 disabled, and the aside to contain the write-test row text
});
```

- [ ] **Step 2: Run them.** They should FAIL because the old review markup is still in place.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Verify** with the full suite.
- [ ] **Step 5: Commit.** `feat(ui): import review and result on the design system`

### Task 12: Locations, settings and dialogs

**Files:**
- Create: `src/locations/LocationsPage.tsx`, `src/settings/SettingsPage.tsx`, `src/settings/settings.css`
- Modify:
  - `src/StorageWorkspace.tsx` (state kept, markup to `LocationsPage`)
  - `src/ManagementApp.tsx` (the `Settings` function moves into `SettingsPage`)
  - `src/CacheSettings.tsx`, `src/UpdatePanel.tsx`, `src/TlsCertificatePanel.tsx`, `src/FingerprintControl.tsx`, `src/CaptureIndexControl.tsx`
  - `src/Dialogs.tsx` (all on `Dialog`, `Field`, `Group`)
  - `tests/browser/{cache-settings,storage-trust,updates,appearance,management}.spec.ts` (selectors)

**Interfaces:**
- Produces:
  - `LocationsPage`:
    - `PageHeader` 位置, with action 添加网络位置 (`secondary`).
    - A 网络位置 `Group` of `ListRow nav` (icon, name, address, `StatusDot` plus status text).
    - An in-page detail view with a back `IconButton` and the existing detail content.
    - Browser-demo limits shown as a `Banner info`.
  - `SettingsPage`:
    - `PageHeader` 设置, centre `Segmented` (外观与浏览 / 缓存与离线 / 快捷键 / 其他配置 / 关于), with the current section kept in the URL hash as today.
    - Each section is a `SinglePage` of `Group`s.
    - 外观与浏览 gains a 叠加信息随工具栏淡出 `Switch` (`nebulume.viewer.overlay-fades`).
    - Shortcuts are a `DataTable` that lists D and Tab in culling as 显示或隐藏叠加信息.
    - Destructive rows come last, as `Button danger sm` with a `Dialog` to confirm.

- [ ] **Step 1: Write the failing tests**

```ts
test('settings sections switch with a segmented control and keep their content', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '快捷键' }).click();
  await expect(page.getByRole('table')).toContainText('显示或隐藏叠加信息');
  await page.getByRole('tab', { name: '外观与浏览' }).click();
  await page.getByRole('switch', { name: '叠加信息随工具栏淡出' }).click();
  expect(await page.evaluate(() => localStorage.getItem('nebulume.viewer.overlay-fades'))).toBe('true');
});
test('locations list rows open the detail view and come back', async ({ page }) => { /* storage fixture, click row, expect the detail heading, click back */ });
```

`Switch` renders `role="switch"`. Port all of the cache, TLS, update, appearance and storage tests to the new names, keeping their assertions.

- [ ] **Step 2: Run them.** They should FAIL because the old settings nav is still in place.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Verify** with the full suite.
- [ ] **Step 5: Commit.** `feat(ui): locations, settings and dialogs on the design system`

### Task 13: Remove legacy CSS, docs, PR and app rebuild

**Files:**
- Delete: `src/styles.css`, `src/import.css`, `src/cache-settings.css`, `src/inspector.css`, `src/viewer.css`, `src/culling.css`, `src/capture-index.css`, `src/update.css`, `src/viewer-focus.css`, `src/theme.css`, `src/VirtualGrid.tsx`, `src/ThemeControl.tsx`, `src/AssetInspector.tsx`
- Modify: `src/tokens.css` (drop the legacy aliases), `scripts/design-allowlist.json` (empty), `src/main.tsx`, `docs/INTERACTION.md`, `docs/STATUS.md`, `docs/REDESIGN.md`
- Test: the full suite plus screenshots

- [ ] **Step 1: Empty the allowlist and drop the aliases.** Run `pnpm test`. The check now FAILS on every legacy file that is still imported, which is the list of what's left to move.
- [ ] **Step 2: Move any surviving rules into the owning page's CSS** using tokens, and delete the legacy files and unused components. `pnpm typecheck` and `pnpm test` should pass with the check clean.
- [ ] **Step 3: Run the browser suite.** All tests pass.
- [ ] **Step 4: Take screenshots.** A throwaway Playwright script (not committed) captures the library, culling, overview, viewer (overlay, edit mode, info), import steps 1–3 and history, locations, settings, and the no-library state, each at 1440×900 and 1024×700 in both themes, into `test-results/design-shots/`. Compare them with `design-system.html` and fix any visible deviation.
- [ ] **Step 5: Update the docs.** `INTERACTION.md` gets the shell, library page without a list, viewer overlay and its editing, info panel pins, import steps, settings and shortcuts. `STATUS.md` gets the implemented items. `REDESIGN.md` points to the design system spec as the visual source of truth.
- [ ] **Step 6: Commit, push and open the PR.**
  - Commit as `refactor(ui): remove legacy styles; every page on the design system`.
  - Push `claude/design-system` and open a PR based on `claude/redesign-darkroom`. Attach the screenshots and note that the backend is unchanged.
  - Then call `get_status` and bind the PR.
- [ ] **Step 7: Rebuild and install Nebulume Preview.app.**
  - From `crates/neb-app`, run `pnpm exec tauri build --bundles app --config '{"identifier":"app.nebulume.preview","productName":"Nebulume Preview"}' -- --locked`.
  - Quit the running preview app with AppleScript, move the old bundle to `/tmp/nebtools/`, and `ditto` the new bundle into `/Applications`.
