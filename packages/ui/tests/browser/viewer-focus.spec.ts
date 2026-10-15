import { expect, test, type Page } from '@playwright/test';
import type { Asset, Crop, FocusInfo } from '../../src/model';

type Call = { command: string; params: Record<string, unknown> };
const full = { x: 0, y: 0, width: 1, height: 1 };
const focusInfo = (x = 0.25): FocusInfo => ({
  status: 'available',
  source: 'nikon_afinfo2',
  coordinate_space: 'oriented_full_image',
  orientation: 8,
  image_width: 800,
  image_height: 600,
  regions: [
    { x, y: 0.2, width: 0.2, height: 0.3, kind: 'selected' },
    { x: 0.7, y: 0.7, width: 0.1, height: 0.1, kind: 'active' },
  ],
});
const photo = (id: string): Asset => ({
  id,
  library_id: 'focus-fixture',
  path: `/fixture/${id}.jpg`,
  filename: `${id}.jpg`,
  extension: 'jpg',
  kind: 'raster',
  size: 1000,
  modified_at: '',
  width: 800,
  height: 600,
  rating: 0,
  metadata: {},
  availability: 'available',
});
const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#344756"/></svg>')}`;

async function viewerFixture(
  page: Page,
  options: { ids?: string[]; handler?: (call: Call) => unknown | Promise<unknown> } = {},
) {
  const ids = options.ids || ['first', 'second'];
  const assets = new Map(ids.map((id) => [id, photo(id)]));
  const calls: Call[] = [];
  await page.route('**/__focus_rpc', async (route) => {
    const call = route.request().postDataJSON() as Call;
    calls.push(call);
    try {
      let result = await options.handler?.(call);
      const current = assets.get(String(call.params.id));
      if (result === undefined)
        switch (call.command) {
          case 'viewer_context':
            result = { asset_id: ids[0], asset_ids: ids };
            break;
          case 'asset.get':
            result = current;
            break;
          case 'asset.preview': {
            const crop = call.params.uncropped ? full : current?.crop || full;
            result = {
              data_url: image,
              width: 800 * crop.width,
              height: 600 * crop.height,
              source: 'focus fixture',
              coordinate_mapping: { orientation: 8, full_width: 800, full_height: 600, crop },
            };
            break;
          }
          case 'asset.focus':
            result = focusInfo();
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
          case 'asset.rate':
            current!.rating = Number(call.params.rating);
            result = { ...current };
            break;
          case 'asset.crop':
            current!.crop = {
              x: Number(call.params.x),
              y: Number(call.params.y),
              width: Number(call.params.width),
              height: Number(call.params.height),
            };
            result = { ...current };
            break;
          case 'asset.refresh':
            result = { ...current };
            break;
          case 'plugin:window|set_title':
          case 'plugin:event|emit':
            result = null;
            break;
          default:
            throw new Error(`Unexpected focus fixture command: ${call.command}`);
        }
      await route.fulfill({ json: { result } });
    } catch (error) {
      await route.fulfill({ json: { error: { message: String(error) } } });
    }
  });
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: {
          currentWindow: { label: 'viewer-focus-test' },
          currentWebview: { label: 'viewer-focus-test' },
        },
        invoke: async (command: string, params: Record<string, unknown>) => {
          const response = await fetch('/__focus_rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              command === 'execute' ? params : { command, params: params || {} },
            ),
          });
          const body = await response.json();
          if (body.error) throw body.error;
          return body.result;
        },
      },
    });
  });
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toBeVisible();
  return calls;
}

test('focus is opt-in, uses oriented coordinates and follows zoom/pan while crop editing hides it', async ({
  page,
}) => {
  const calls = await viewerFixture(page);
  const focusCalls = () => calls.filter((call) => call.command === 'asset.focus');
  const toggle = page.getByRole('button', { name: '显示对焦点（P）' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(focusCalls()).toHaveLength(0);
  await page.keyboard.press('p');
  await expect(page.locator('.focus-region')).toHaveCount(2);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.focus-overlay')).toHaveCSS('pointer-events', 'none');
  const selected = page.locator('.focus-region.selected');
  expect(await selected.evaluate((node) => (node as HTMLElement).style.left)).toBe('25%');
  const before = (await selected.boundingBox())!;
  await page.getByRole('button', { name: '放大', exact: true }).click();
  const enlarged = (await selected.boundingBox())!;
  expect(enlarged.width).toBeCloseTo(before.width * 1.25, 0);
  const wrap = (await page.locator('.photo-wrap').boundingBox())!;
  await page.mouse.move(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2);
  await page.mouse.down();
  await page.mouse.move(wrap.x + wrap.width / 2 + 40, wrap.y + wrap.height / 2 + 30);
  await page.mouse.up();
  const moved = (await selected.boundingBox())!;
  expect(moved.x - enlarged.x).toBeCloseTo(40, 0);
  expect(moved.y - enlarged.y).toBeCloseTo(30, 0);
  await page.keyboard.press('3');
  await expect
    .poll(() => calls.filter((call) => call.command === 'plugin:event|emit').at(-1)?.params.payload)
    .toMatchObject({ change: 'rating', asset: { id: 'first', rating: 3 } });
  expect(focusCalls()).toHaveLength(1);
  await page.keyboard.press('c');
  await expect(page.locator('.focus-overlay')).not.toBeVisible();
  await expect(page.locator('.viewer-focus-status')).toContainText('裁剪模式中暂不显示');
  await page.getByLabel('左侧').press('p');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(focusCalls()).toHaveLength(1);
  await page.getByLabel('左侧').fill('25');
  await page.getByLabel('宽度').fill('50');
  await page.getByRole('button', { name: '保存裁剪', exact: true }).click();
  await expect(page.locator('.focus-region.selected')).toBeVisible();
  expect(
    await page
      .locator('.focus-region.selected')
      .evaluate((node) => (node as HTMLElement).style.left),
  ).toBe('0%');
  expect(
    await page
      .locator('.focus-region.selected')
      .evaluate((node) => (node as HTMLElement).style.width),
  ).toBe('40%');
  expect(focusCalls()).toHaveLength(2);
  await expect
    .poll(() => calls.filter((call) => call.command === 'plugin:event|emit').at(-1)?.params.payload)
    .toMatchObject({ change: 'crop', asset: { id: 'first', crop: { x: 0.25, width: 0.5 } } });
  await toggle.click();
  await expect(page.locator('.focus-overlay')).not.toBeVisible();
});

test('late focus responses cannot cross images, original refreshes or a disabled toggle', async ({
  page,
}) => {
  let releaseFirst: ((value: FocusInfo) => void) | undefined;
  let releaseOld: ((value: FocusInfo) => void) | undefined;
  let releaseDisabled: ((value: FocusInfo) => void) | undefined;
  let secondRequests = 0;
  const calls = await viewerFixture(page, {
    handler: (call) => {
      if (call.command !== 'asset.focus') return;
      if (call.params.id === 'first')
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      secondRequests++;
      if (secondRequests === 1)
        return new Promise((resolve) => {
          releaseOld = resolve;
        });
      if (secondRequests === 3)
        return new Promise((resolve) => {
          releaseDisabled = resolve;
        });
      return focusInfo(0.5);
    },
  });
  await page.keyboard.press('p');
  await expect.poll(() => !!releaseFirst).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'second.jpg');
  await expect.poll(() => !!releaseOld).toBe(true);
  releaseFirst!(focusInfo(0.1));
  await page.getByRole('button', { name: '重新读取原图', exact: true }).click();
  await expect(page.locator('.focus-region.selected')).toBeVisible();
  releaseOld!(focusInfo(0.1));
  await expect(page.locator('.focus-region.selected')).toHaveCSS('left', /./);
  await expect
    .poll(() =>
      page.locator('.focus-region.selected').evaluate((node) => (node as HTMLElement).style.left),
    )
    .toBe('50%');
  await page.keyboard.press('p');
  await page.keyboard.press('p');
  await expect.poll(() => !!releaseDisabled).toBe(true);
  await page.keyboard.press('p');
  releaseDisabled!(focusInfo(0.1));
  await expect(page.getByRole('button', { name: '显示对焦点（P）' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.locator('.focus-overlay')).not.toBeVisible();
  expect(calls.filter((call) => call.command === 'asset.focus')).toHaveLength(4);
});

test('missing, unsupported and incompatible coordinate metadata never creates a center marker', async ({
  page,
}) => {
  const cases = ['missing', 'unsupported', 'orientation', 'aspect', 'mapping', 'error'];
  await viewerFixture(page, {
    ids: cases,
    handler: (call) => {
      if (call.command === 'asset.focus') {
        if (call.params.id === 'error') throw new Error('无法读取对焦记录');
        if (call.params.id === 'missing' || call.params.id === 'unsupported')
          return {
            ...focusInfo(),
            status: call.params.id,
            reason:
              call.params.id === 'missing' ? '此照片未记录对焦区域' : '此相机对焦格式尚不支持',
            regions: [],
          };
        return focusInfo();
      }
      if (
        call.command === 'asset.preview' &&
        ['orientation', 'aspect', 'mapping'].includes(String(call.params.id))
      )
        return {
          data_url: image,
          width: 800,
          height: 600,
          source: 'fixture',
          ...(call.params.id === 'mapping'
            ? {}
            : {
                coordinate_mapping: {
                  orientation: call.params.id === 'orientation' ? 2 : 8,
                  full_width: call.params.id === 'aspect' ? 1000 : 800,
                  full_height: 600,
                  crop: full,
                },
              }),
        };
    },
  });
  await page.keyboard.press('p');
  for (const [index, message] of [
    '未记录对焦区域',
    '尚不支持',
    '方向不匹配',
    '画幅与当前预览不匹配',
    '无法确认对焦坐标',
    '无法读取对焦记录',
  ].entries()) {
    await expect(page.locator('.viewer-focus-status')).toContainText(message);
    await expect(page.locator('.focus-overlay')).not.toBeVisible();
    if (index < cases.length - 1) await page.keyboard.press('ArrowRight');
  }
});
