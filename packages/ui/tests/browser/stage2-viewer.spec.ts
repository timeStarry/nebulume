import { expect, test, type Page } from '@playwright/test';
import type { Asset, Crop, Library } from '../../src/model';
import { servePreviewImages } from './fixtures';

const library: Library = {
  id: 'library-stage2',
  name: 'Stage2 摄影库',
  root: '/Users/photographer/Shoot',
  created_at: '2026-11-12',
  source_kind: 'local',
  source_prefix: '',
};

function makePhoto(index: number): Asset {
  const isRaw = index === 1 || index === 2;
  const ext = isRaw ? 'cr3' : 'heic';
  return {
    id: `shot-${index}`,
    library_id: library.id,
    filename: `EOSR5_000${index}.${ext.toUpperCase()}`,
    path: `/Users/photographer/Shoot/EOSR5_000${index}.${ext.toUpperCase()}`,
    extension: ext,
    kind: isRaw ? 'raw' : 'raster',
    size: 28_000_000,
    width: 6000,
    height: 4000,
    rating: 0,
    flag: 'none',
    metadata: {
      Make: 'Canon',
      Model: 'Canon EOS R5',
      ColorSpace: 'Adobe RGB (1998)',
    },
    availability: 'available',
    modified_at: '2026-11-12T10:00:00Z',
  };
}

async function setupStage2Fixture(page: Page, mode: 'view' | 'cull' = 'cull') {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const assets = new Map([1, 2, 3, 4].map((i) => [`shot-${i}`, makePhoto(i)]));

  await page.route('**/__stage2_rpc', async (route) => {
    const call = route.request().postDataJSON() as {
      command: string;
      params: Record<string, unknown>;
    };
    calls.push(call);
    const target = assets.get(String(call.params.id));
    let result: unknown = null;

    switch (call.command) {
      case 'library.list':
        result = [library];
        break;
      case 'storage.list':
      case 'import.batches':
        result = [];
        break;
      case 'system.info':
        result = { originals_read_only: true };
        break;
      case 'asset.list': {
        const items = [...assets.values()];
        result = { items, total: items.length };
        break;
      }
      case 'asset.ids': {
        const ids = [...assets.keys()];
        result = { ids, total: ids.length };
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
      case 'asset.crop': {
        const crop: Crop = {
          x: Number(call.params.x),
          y: Number(call.params.y),
          width: Number(call.params.width),
          height: Number(call.params.height),
        };
        target!.crop = crop;
        result = { ...target };
        break;
      }
      case 'asset.reset_crop':
        delete target!.crop;
        result = { ...target };
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
      case 'asset.histogram':
        result = {
          red: Array(256).fill(2),
          green: Array(256).fill(2),
          blue: Array(256).fill(2),
          luminance: Array(256).fill(2),
          pixels: 512,
          source: 'embedded_jpeg',
        };
        break;
      case 'asset.preview': {
        const tier = String(call.params.tier || 'p2560');
        const preferRaw = !!call.params.prefer_raw;
        const crop = (!call.params.uncropped && target?.crop) || {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        };
        const width = tier === 'full' ? 6000 : 2560;
        const height = tier === 'full' ? 4000 : 1707;
        result = {
          width,
          height,
          tier,
          source:
            target?.kind === 'raw' ? (preferRaw ? 'raw_sensor' : 'embedded_jpeg') : 'raster',
          coordinate_mapping: {
            source_space: 'oriented_full_image',
            full_width: 6000,
            full_height: 4000,
            crop,
            preview_width: width,
            preview_height: height,
          },
          asset: { ...target },
        };
        break;
      }
      case '$native/viewer_context':
        result = {
          asset_id: 'shot-1',
          asset_ids: ['shot-1', 'shot-2', 'shot-3', 'shot-4'],
          mode,
          queue: mode === 'cull' ? { library_id: library.id, options: {} } : null,
          from_file: false,
        };
        break;
      case '$native/plugin:window|theme':
        result = 'dark';
        break;
      case '$native/plugin:window|is_fullscreen':
        result = false;
        break;
      default:
        result = null;
        break;
    }
    await route.fulfill({ json: { result } });
  });

  const imageRequests = await servePreviewImages(page);

  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, scheme: string) =>
          'http://' + scheme + '.localhost/' + encodeURIComponent(path),
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: {
          currentWindow: { label: 'viewer-stage2' },
          currentWebview: { label: 'viewer-stage2' },
        },
        invoke: async (command: string, params: Record<string, unknown>) => {
          if (command.startsWith('plugin:event|')) return 1;
          const response = await fetch('/__stage2_rpc', {
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

  return { calls, assets, imageRequests };
}

test('1:1 zoom (Z) upgrades to native full tier and R toggles RAW sensor decode', async ({
  page,
}) => {
  const { calls, imageRequests } = await setupStage2Fixture(page, 'view');
  await page.goto('/?viewer=1');

  await expect(page.locator('img.main-photo')).toBeVisible();
  const rawBtn = page.getByRole('button', { name: '相机预览' });
  await expect(rawBtn).toHaveAttribute('aria-pressed', 'false');

  // Press Z to enter native 1:1 pixel zoom; PhotoView upgrades from p2560 to full tier.
  await page.keyboard.press('z');
  await expect(page.locator('.zoom-controls')).toContainText('1:1 原生');
  await expect
    .poll(() => imageRequests.some((req) => req.id === 'shot-1' && req.tier === 'full'))
    .toBe(true);

  // Press R to toggle manual RAW sensor decode; protocol path gains `/raw`.
  await page.keyboard.press('r');
  await expect(page.getByRole('button', { name: 'RAW 显影' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() => imageRequests.some((req) => req.id === 'shot-1' && req.preferRaw === true))
    .toBe(true);
  expect(
    calls.some(
      (call) =>
        call.command === 'asset.preview' &&
        call.params.id === 'shot-1' &&
        call.params.prefer_raw === true,
    ),
  ).toBe(true);
});

test('J shortcut toggles highlight/shadow clipping zebra overlay', async ({ page }) => {
  await setupStage2Fixture(page, 'view');
  await page.goto('/?viewer=1');
  await expect(page.locator('img.main-photo')).toBeVisible();

  const clipBtn = page.getByRole('button', { name: '溢出警告' });
  await expect(clipBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('canvas.clipping-overlay')).toHaveCount(0);

  await page.keyboard.press('j');
  await expect(clipBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('canvas.clipping-overlay')).toBeVisible();

  await page.keyboard.press('j');
  await expect(clipBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('canvas.clipping-overlay')).toHaveCount(0);
});

test('2-up and 4-up CompareStage synchronizes zoom and marks focused pane in place', async ({
  page,
}) => {
  const { assets } = await setupStage2Fixture(page, 'cull');
  await page.goto('/?viewer=1');
  await expect(page.locator('.cull-status')).toContainText('1 / 4');

  // Enter 2-up compare view via C shortcut.
  await page.keyboard.press('c');
  const compare = page.getByRole('listbox', { name: '对比视图' });
  await expect(compare).toBeVisible();
  await expect(compare.locator('.compare-pane')).toHaveCount(2);

  // Synchronized 1:1 zoom expands both panes simultaneously.
  const pane1Box = compare.locator('.compare-pane').nth(0).locator('.compare-photo-box');
  const pane2Box = compare.locator('.compare-pane').nth(1).locator('.compare-photo-box');
  await expect(pane1Box).toBeVisible();
  await expect(pane2Box).toBeVisible();
  const initialW1 = await pane1Box.evaluate((el) => parseFloat(getComputedStyle(el).width));
  await page.keyboard.press('z');
  await expect
    .poll(() => pane1Box.evaluate((el) => parseFloat(getComputedStyle(el).width)))
    .toBeGreaterThan(initialW1 * 1.5);
  const zoomedW2 = await pane2Box.evaluate((el) => parseFloat(getComputedStyle(el).width));
  expect(zoomedW2).toBeGreaterThan(initialW1 * 1.5);

  // Clicking pane 2 focuses shot-2 without sliding shot-1 out of the 2-up window, and marks in place.
  await compare.locator('.compare-pane[data-asset-id="shot-2"]').click();
  await expect(compare.locator('.compare-pane[data-asset-id="shot-1"]')).toBeVisible();
  await expect(compare.locator('.compare-pane[data-asset-id="shot-2"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('p');
  await page.keyboard.press('4');
  await expect.poll(() => assets.get('shot-2')?.flag).toBe('pick');
  await expect.poll(() => assets.get('shot-2')?.rating).toBe(4);
  await expect(compare.locator('.compare-pane[data-asset-id="shot-1"]')).toBeVisible();

  // Switch to 4-up compare layout.
  await page.getByRole('button', { name: '4 张' }).click();
  await expect(compare.locator('.compare-pane')).toHaveCount(4);
});

test('aspect-ratio crop presets constrain pixel ratio and swap orientation cleanly', async ({
  page,
}) => {
  const { assets } = await setupStage2Fixture(page, 'view');
  await page.goto('/?viewer=1');
  await expect(page.locator('img.main-photo')).toBeVisible();

  await page.keyboard.press('c');
  const bar = page.getByRole('group', { name: '裁剪画幅比例' });
  await expect(bar).toBeVisible();

  // On a 6000x4000 image, 1:1 square crop yields 4000x4000 pixels -> width = 0.6667, height = 1.
  await bar.getByRole('button', { name: '1:1' }).click();
  await bar.getByRole('button', { name: '4:5' }).click();
  // 4:5 portrait on 6000x4000 -> pixel width = 3200 (0.5333), pixel height = 4000 (1.0).
  const swapBtn = bar.getByRole('button', { name: /横竖/ });
  await expect(swapBtn).toBeEnabled();
  await swapBtn.click();
  // Swapped to 5:4 landscape on 6000x4000 -> pixel width = 5000 (0.8333), pixel height = 4000 (1.0).

  await page.getByRole('button', { name: '保存裁剪' }).click();
  await expect.poll(() => !!assets.get('shot-1')?.crop).toBe(true);
  const saved = assets.get('shot-1')!.crop!;
  const pixelRatio = (saved.width * 6000) / (saved.height * 4000);
  expect(pixelRatio).toBeCloseTo(5 / 4, 2);
});
