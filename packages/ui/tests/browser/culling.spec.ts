import { expect, test, type Page } from '@playwright/test';
import type { Asset, Library } from '../../src/model';
import { servePreviewImages } from './fixtures';

type Call = { command: string; params: Record<string, unknown> };
const library: Library = {
  id: 'library-local',
  name: '本地摄影',
  root: 'D:\\Photos',
  created_at: '2026-10-01',
  source_kind: 'local',
  source_prefix: '',
};
const photo = (index: number): Asset => ({
  id: `photo-${index}`,
  library_id: library.id,
  filename: `Frame-${index}.png`,
  path: `D:\\Photos\\Frame-${index}.png`,
  extension: 'png',
  kind: 'raster',
  size: 1000,
  width: 960,
  height: 640,
  rating: 0,
  flag: 'none',
  metadata: {},
  availability: 'available',
  modified_at: '2026-10-01T10:00:00Z',
});

async function fixture(page: Page, options: { failFlag?: boolean; fromFile?: boolean } = {}) {
  const calls: Call[] = [];
  const assets = new Map([1, 2, 3].map((index) => [`photo-${index}`, photo(index)]));
  const trashed = new Map<string, Asset>();
  let added = false;
  await page.route('**/__culling_rpc', async (route) => {
    const call = route.request().postDataJSON() as Call;
    calls.push(call);
    const target = assets.get(String(call.params.id));
    let result: unknown;
    try {
      switch (call.command) {
        case 'library.list':
          result = options.fromFile && !added ? [] : [library];
          break;
        case 'file.siblings':
          result = {
            folder: '/photos/Trip',
            index: 0,
            files: [1, 2, 3].map((n) => ({
              name: `Frame-${n}.png`,
              path: `/photos/Trip/Frame-${n}.png`,
              size: 1000,
            })),
          };
          break;
        case 'file.open': {
          const n = String(call.params.path).match(/Frame-(\d)/)![1];
          result = { ...assets.get(`photo-${n}`) };
          break;
        }
        case 'library.add':
          added = true;
          result = { ...library, name: String(call.params.name), root: String(call.params.root) };
          break;
        case 'library.scan':
          result = { indexed: 3, skipped: 0, errors: [] };
          break;
        case 'storage.list':
          result = [];
          break;
        case 'system.info':
          result = { originals_read_only: true };
          break;
        case 'import.batches':
          result = [];
          break;
        case 'library.capture_index.status':
          result = {
            library_id: library.id,
            total: 3,
            known: 3,
            missing: 0,
            pending: 0,
            job: null,
          };
          break;
        case 'asset.list': {
          const filter = call.params.flag as string | undefined;
          const items = [...assets.values()].filter(
            (item) =>
              !filter ||
              filter === 'any' ||
              (filter === 'not_reject' ? item.flag !== 'reject' : item.flag === filter),
          );
          const offset = Number(call.params.offset || 0);
          result = {
            items: items.slice(offset, offset + Number(call.params.limit || 200)),
            total: items.length,
          };
          break;
        }
        case 'asset.get':
          result = { ...target };
          break;
        case 'asset.rate':
          target!.rating = Number(call.params.rating);
          result = { ...target };
          break;
        case 'asset.flag':
          if (options.failFlag) throw new Error('catalog is read-only');
          target!.flag = call.params.flag as Asset['flag'];
          result = { ...target };
          break;
        case 'asset.mark_batch':
          for (const id of call.params.ids as string[]) {
            const item = assets.get(id)!;
            if (call.params.rating !== undefined) item.rating = Number(call.params.rating);
            if (call.params.flag !== undefined) item.flag = call.params.flag as Asset['flag'];
          }
          result = { updated: (call.params.ids as string[]).length };
          break;
        case 'asset.focus':
          result = {
            status: 'missing',
            reason: '此照片未记录对焦区域',
            source: null,
            coordinate_space: 'oriented_full_image',
            orientation: 1,
            regions: [],
          };
          break;
        case 'asset.preview':
          result = { width: 1, height: 1, source: 'fixture', tier: call.params.tier || 'p2560' };
          break;
        case 'asset.histogram':
          result = {
            red: Array(256).fill(1),
            green: Array(256).fill(1),
            blue: Array(256).fill(1),
            luminance: Array(256).fill(1),
            pixels: 256,
            source: 'fixture',
          };
          break;
        case 'asset.trash': {
          const ids = call.params.ids as string[];
          for (const id of ids) trashed.set(id, assets.get(id)!);
          for (const id of ids) assets.delete(id);
          result = { trashed: ids, failed: [] };
          break;
        }
        case 'asset.restore': {
          const ids = call.params.ids as string[];
          for (const id of ids) assets.set(id, trashed.get(id)!);
          result = { restored: ids, failed: [] };
          break;
        }
        case '$native/open_viewer':
          result = 'viewer-test';
          break;
        case '$native/viewer_context':
          result = {
            asset_id: 'photo-1',
            asset_ids: ['photo-1'],
            mode: options.fromFile ? 'view' : 'cull',
            queue: options.fromFile ? null : { library_id: library.id, options: { flag: 'none' } },
            from_file: options.fromFile,
          };
          break;
        case '$native/plugin:window|theme':
          result = 'dark';
          break;
        case '$native/plugin:window|set_theme':
        case '$native/plugin:window|set_title':
        case '$native/plugin:window|is_fullscreen':
          result = call.command.endsWith('is_fullscreen') ? false : null;
          break;
        case '$native/plugin:window|close':
          result = null;
          break;
        default:
          throw new Error(`Unexpected culling fixture: ${call.command}`);
      }
      await route.fulfill({ json: { result } });
    } catch (error) {
      await route.fulfill({ json: { error: { code: 'FIXTURE', message: String(error) } } });
    }
  });
  await servePreviewImages(page);
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, scheme: string) =>
          'http://' + scheme + '.localhost/' + encodeURIComponent(path),
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: {
          currentWindow: { label: 'viewer-test' },
          currentWebview: { label: 'viewer-test' },
        },
        invoke: async (command: string, params: Record<string, unknown>) => {
          if (command.startsWith('plugin:event|')) return 1;
          const response = await fetch('/__culling_rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              command === 'execute'
                ? params
                : { command: '$native/' + command, params: params || {} },
            ),
          });
          const body = await response.json();
          if (body.error) throw body.error;
          return body.result;
        },
      },
    });
  });
  return { calls, assets };
}

const hud = (page: Page) => page.locator('.cull-status');

test('grid culls inside the library window over the filtered queue', async ({ page }) => {
  const { calls } = await fixture(page);
  await page.addInitScript(() => localStorage.setItem('nebulume.filters-open', 'true'));
  await page.goto('/');
  await page
    .getByRole('button', { name: /本地摄影/ })
    .first()
    .click();
  await page.getByRole('combobox', { name: '旗标筛选' }).selectOption('none');
  await expect(page.locator('.thumbnail')).toHaveCount(3);
  await page.locator('.thumbnail').first().click();
  const listsBefore = calls.filter((call) => call.command === 'asset.list').length;
  await page.keyboard.press('Shift+C');
  await expect(hud(page)).toContainText('1 / 3');
  // The queue is frozen from the same filter the grid shows.
  const snapshot = calls.filter((call) => call.command === 'asset.list').slice(listsBefore);
  expect(snapshot.at(-1)?.params).toMatchObject({ flag: 'none', library_id: library.id });
  expect(calls.some((call) => call.command === '$native/open_viewer')).toBe(false);
});

test('marks advance after confirmation, keep a frozen queue and undo across photos', async ({
  page,
}) => {
  const { assets } = await fixture(page);
  await page.goto('/?viewer=1');
  await expect(page.getByRole('button', { name: '选图', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(hud(page)).toContainText('1 / 3');
  await page.keyboard.press('3');
  await expect(hud(page)).toContainText('2 / 3');
  expect(assets.get('photo-1')!.rating).toBe(3);
  await page.keyboard.press('x');
  await expect(hud(page)).toContainText('3 / 3');
  expect(assets.get('photo-2')!.flag).toBe('reject');
  // The queue was filtered to unflagged images, yet marked ones stay in this session.
  await page.keyboard.press('p');
  await expect(page.getByText('已到最后一张。')).toBeVisible();
  await expect(hud(page)).toContainText('3 / 3');
  await page.keyboard.press('ArrowLeft');
  await expect(hud(page)).toContainText('2 / 3');
  await page.keyboard.press('Control+z');
  await expect(hud(page)).toContainText('3 / 3');
  await expect(hud(page)).toContainText('未标记');
  expect(assets.get('photo-3')!.flag).toBe('none');
  await page.keyboard.press('Control+z');
  await expect(hud(page)).toContainText('2 / 3');
  expect(assets.get('photo-2')!.flag).toBe('none');
});

test('rapid keys are each applied without skipping photos', async ({ page }) => {
  const { assets } = await fixture(page);
  await page.goto('/?viewer=1');
  await expect(hud(page)).toContainText('1 / 3');
  await page.keyboard.press('1');
  await page.keyboard.press('2');
  await expect(hud(page)).toContainText('3 / 3');
  expect(assets.get('photo-1')!.rating).toBe(1);
  expect(assets.get('photo-2')!.rating).toBe(2);
});

test('auto-advance off keeps the photo and a failed mark rolls back', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nebulume.cull.auto-advance', 'false'));
  const { assets } = await fixture(page, { failFlag: true });
  await page.goto('/?viewer=1');
  await expect(page.getByRole('button', { name: '自动下一张' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.keyboard.press('4');
  await expect(hud(page)).toContainText('1 / 3');
  await expect(hud(page).getByLabel('4 星')).toBeVisible();
  expect(assets.get('photo-1')!.rating).toBe(4);
  await page.keyboard.press('p');
  await expect(page.getByText(/标记未保存/)).toBeVisible();
  await expect(hud(page)).toContainText('未标记');
  await expect(hud(page)).toContainText('1 / 3');
});

test('mode switch restores ordinary viewer shortcuts', async ({ page }) => {
  await fixture(page);
  await page.goto('/?viewer=1');
  await expect(hud(page)).toBeVisible();
  await page.keyboard.press('Shift+C');
  await expect(page.getByRole('button', { name: '查看', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(hud(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '显示对焦点（P）' })).toBeVisible();
});

test('culling shows progress and marks beside the photo, then finishes with export and Trash', async ({
  page,
}) => {
  const { calls, assets } = await fixture(page);
  await page.goto('/?viewer=1');
  const panel = page.getByRole('complementary', { name: '选片面板' });
  await expect(panel).toContainText('已看 1 / 3');
  await expect(page.locator('.cull-strip-item')).toHaveCount(3);
  await page.keyboard.press('p');
  await expect(panel).toContainText('已看 2 / 3');
  await expect(panel).toContainText('1 留用');
  await page.keyboard.press('x');
  await expect(panel).toContainText('1 淘汰');
  await expect(page.locator('.cull-strip-mark.pick')).toHaveCount(1);
  await expect(page.locator('.cull-strip-mark.reject')).toHaveCount(1);
  // The side panel marks the photo on screen like the keys do.
  await panel.getByRole('button', { name: '评为 4 星' }).click();
  await expect.poll(() => assets.get('photo-3')!.rating).toBe(4);

  await panel.getByRole('button', { name: '完成选片' }).click();
  const review = page.getByRole('region', { name: '完成选片' });
  await expect(review).toContainText('留用 1 张');
  await expect(review).toContainText('淘汰 1 张');
  await expect(review.getByRole('button', { name: '继续选片' })).toBeFocused();
  // Moving originals needs a second, explicit press.
  await review.getByRole('button', { name: '移到废纸篓…' }).click();
  expect(calls.some((call) => call.command === 'asset.trash')).toBe(false);
  await review.getByRole('button', { name: '确认移走 1 个文件' }).click();
  await expect(review).toBeHidden();
  await expect
    .poll(() => calls.find((call) => call.command === 'asset.trash')?.params)
    .toEqual({
      ids: ['photo-2'],
    });
  await expect(page.locator('.cull-strip-item')).toHaveCount(2);
  await expect(panel).toContainText('0 淘汰');
  await page.getByRole('button', { name: '撤销' }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'asset.restore')?.params)
    .toEqual({
      ids: ['photo-2'],
    });
  await expect(page.locator('.cull-strip-item')).toHaveCount(3);
  await expect(panel).toContainText('1 淘汰');
});

test('⌘⌫ moves the photo on screen to the Trash and the viewer moves on', async ({ page }) => {
  const { calls } = await fixture(page);
  await page.goto('/?viewer=1');
  await expect(hud(page)).toContainText('1 / 3');
  await page.keyboard.press('Meta+Backspace');
  await expect(hud(page)).toContainText('1 / 2');
  expect(calls.find((call) => call.command === 'asset.trash')?.params).toEqual({
    ids: ['photo-1'],
  });
  await expect(
    page.getByRole('status').filter({ hasText: '已把 1 张照片移到废纸篓' }),
  ).toBeVisible();
});

test('a file opened from the Finder browses its folder and can join the libraries', async ({
  page,
}) => {
  const { calls } = await fixture(page, { fromFile: true });
  await page.goto('/?viewer=1');
  const viewer = page.getByLabel('沉浸影像查看器');
  await expect(
    viewer
      .getByText('第 1 张，共 3 张', { exact: false })
      .or(viewer.getByLabel('第 1 张，共 3 张')),
  ).toBeVisible();
  await expect(viewer.locator('.viewer-folder')).toHaveText('Trip');
  const banner = viewer.getByRole('note');
  await expect(banner).toContainText('“Trip”不在图片库中');
  // Only the file shown is indexed; the next one is indexed when it is about to be needed.
  await expect
    .poll(() => calls.filter((call) => call.command === 'file.open').length)
    .toBeLessThanOrEqual(1);
  await page.keyboard.press('ArrowRight');
  await expect(viewer.getByLabel('第 2 张，共 3 张')).toBeVisible();
  await expect(viewer.locator('.viewer-filename strong')).toHaveText('Frame-2.png');
  expect(
    calls.some(
      (call) => call.command === 'file.open' && call.params.path === '/photos/Trip/Frame-2.png',
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      calls.some(
        (call) => call.command === 'file.open' && String(call.params.path).includes('Frame-3'),
      ),
    )
    .toBe(true);

  await banner.getByRole('button', { name: '加入图片库' }).click();
  await expect(banner).toBeHidden();
  expect(calls.find((call) => call.command === 'library.add')?.params).toEqual({
    name: 'Trip',
    root: '/photos/Trip',
    pair_raw_jpeg: true,
  });
  await expect(
    viewer.getByRole('status').filter({ hasText: '已加入图片库“Trip”，索引了 3 张' }),
  ).toBeVisible();
});

test('the viewer’s more menu reaches export, the path and the Trash', async ({ page }) => {
  const { calls } = await fixture(page, { fromFile: true });
  await page.goto('/?viewer=1');
  const viewer = page.getByLabel('沉浸影像查看器');
  await expect(viewer.locator('.viewer-filename strong')).toHaveText('Frame-1.png');
  await viewer.getByRole('button', { name: '更多操作' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: '把此文件夹加入图片库…' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '在图片库中显示' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: '移到废纸篓' }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'asset.trash')?.params)
    .toEqual({
      ids: ['photo-1'],
    });
  await expect(viewer.locator('.viewer-filename strong')).toHaveText('Frame-2.png');
});

test('the mark confirmation plays on the panel even with no rating widget in the overlay', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'nebulume.viewer.overlay',
      JSON.stringify({ tl: [], tr: [], bl: [], br: [] }),
    ),
  );
  await fixture(page);
  await page.goto('/?viewer=1');
  await expect(hud(page)).toContainText('1 / 3');
  await page.keyboard.press('3');
  await expect(page.locator('.cull-panel')).toHaveClass(/pulse-rate/);
  await expect(hud(page)).toContainText('2 / 3');
  await expect(page.locator('.cull-hud')).toHaveCount(0);
});
