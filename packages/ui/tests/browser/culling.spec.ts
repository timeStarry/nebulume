import { expect, test, type Page } from '@playwright/test';
import type { Asset, Library } from '../../src/model';

type Call = { command: string; params: Record<string, unknown> };
const library: Library = {
  id: 'library-local',
  name: '本地摄影',
  root: 'D:\\Photos',
  created_at: '2026-10-01',
  source_kind: 'local',
  source_prefix: '',
};
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
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

async function fixture(page: Page, options: { failFlag?: boolean } = {}) {
  const calls: Call[] = [];
  const assets = new Map([1, 2, 3].map((index) => [`photo-${index}`, photo(index)]));
  await page.route('**/__culling_rpc', async (route) => {
    const call = route.request().postDataJSON() as Call;
    calls.push(call);
    const target = assets.get(String(call.params.id));
    let result: unknown;
    try {
      switch (call.command) {
        case 'library.list':
          result = [library];
          break;
        case 'storage.list':
          result = [];
          break;
        case 'system.info':
          result = { originals_read_only: true };
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
          result = { data_url: image, width: 1, height: 1, source: 'fixture' };
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
        case '$native/open_viewer':
          result = 'viewer-test';
          break;
        case '$native/viewer_context':
          result = {
            asset_id: 'photo-1',
            asset_ids: ['photo-1'],
            mode: 'cull',
            queue: { library_id: library.id, options: { flag: 'none' } },
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
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
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

const hud = (page: Page) => page.locator('.cull-hud');

test('grid opens the culling window with the filtered queue description', async ({ page }) => {
  const { calls } = await fixture(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /本地摄影/ })
    .first()
    .click();
  await page.getByRole('combobox', { name: '旗标筛选' }).selectOption('none');
  await expect(page.locator('.thumbnail')).toHaveCount(3);
  await page.locator('.thumbnail').first().click();
  await page.keyboard.press('Shift+C');
  await expect
    .poll(() => calls.find((call) => call.command === '$native/open_viewer')?.params)
    .toMatchObject({
      mode: 'cull',
      queue: { library_id: library.id, options: { flag: 'none', library_id: library.id } },
    });
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
