import { expect, test, type Page } from '@playwright/test';
import type { Asset, Crop, FocusInfo, Preview } from '../../src/model';

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
          case 'plugin:window|theme':
            result = 'dark';
            break;
          case 'plugin:window|set_theme':
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
          if (command === 'plugin:event|listen') return 1;
          if (command === 'plugin:event|unlisten') return null;
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

test('focus is detected automatically while display stays opt-in and follows zoom, pan and crop mapping', async ({
  page,
}) => {
  const calls = await viewerFixture(page);
  const focusCalls = () => calls.filter((call) => call.command === 'asset.focus');
  const toggle = page.getByRole('button', { name: '显示对焦点（P）' });
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(focusCalls()).toHaveLength(1);
  await expect(page.locator('.focus-overlay')).toHaveCount(0);
  await page.keyboard.press('p');
  await expect(page.locator('.focus-region')).toHaveCount(2);
  await expect(page.locator('.viewer-focus-status')).toHaveCount(0);
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
  await expect(page.locator('.viewer-focus-status')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('title', '裁剪时暂不显示对焦点');
  await toggle.dispatchEvent('click');
  await page.keyboard.press('p');
  await page.getByLabel('左侧').press('p');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(focusCalls()).toHaveLength(1);
  await page.getByLabel('左侧').fill('25');
  await page.getByLabel('宽度').fill('50');
  await page.getByRole('button', { name: '保存裁剪', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
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
  await toggle.click();
  await expect(page.locator('.focus-overlay')).toBeVisible();
  expect(focusCalls()).toHaveLength(2);
});

test('automatic detection rejects late image and revision responses while refresh retries preserve display preference', async ({
  page,
}) => {
  let releaseFirst: ((value: FocusInfo) => void) | undefined;
  let releaseOld: ((value: FocusInfo) => void) | undefined;
  let releaseRefresh: ((value: FocusInfo) => void) | undefined;
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
          releaseRefresh = resolve;
        });
      return focusInfo(0.5);
    },
  });
  const toggle = page.getByRole('button', { name: '显示对焦点（P）' });
  await expect.poll(() => !!releaseFirst).toBe(true);
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('title', '正在检测对焦信息…');
  await page.keyboard.press('p');
  await toggle.dispatchEvent('click');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'second.jpg');
  await expect.poll(() => !!releaseOld).toBe(true);
  releaseFirst!(focusInfo(0.1));
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.focus-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '重新读取原图', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await page.keyboard.press('p');
  await expect(page.locator('.focus-region.selected')).toBeVisible();
  releaseOld!(focusInfo(0.1));
  await expect(page.locator('.focus-region.selected')).toHaveCSS('left', /./);
  await expect
    .poll(() =>
      page.locator('.focus-region.selected').evaluate((node) => (node as HTMLElement).style.left),
    )
    .toBe('50%');
  await page.getByRole('button', { name: '重新读取原图', exact: true }).click();
  await expect.poll(() => !!releaseRefresh).toBe(true);
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).not.toHaveClass(/active/);
  await expect(page.locator('.focus-overlay')).toHaveCount(0);
  await page.keyboard.press('p');
  await toggle.dispatchEvent('click');
  releaseRefresh!(focusInfo(0.6));
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() =>
      page.locator('.focus-region.selected').evaluate((node) => (node as HTMLElement).style.left),
    )
    .toBe('60%');
  await toggle.click();
  await expect(page.locator('.focus-overlay')).not.toBeVisible();
  expect(calls.filter((call) => call.command === 'asset.focus')).toHaveLength(4);
});

test('missing, unsupported and incompatible coordinate metadata never creates a center marker', async ({
  page,
}) => {
  const cases = [
    'missing',
    'unsupported',
    'orientation',
    'aspect',
    'mapping',
    'error',
    'outside',
    'preview-error',
  ];
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
      if (call.command === 'asset.preview' && call.params.id === 'preview-error')
        throw new Error('预览解码失败');
      if (
        call.command === 'asset.preview' &&
        ['orientation', 'aspect', 'mapping', 'outside'].includes(String(call.params.id))
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
                  crop:
                    call.params.id === 'outside'
                      ? { x: 0.9, y: 0.9, width: 0.1, height: 0.1 }
                      : full,
                },
              }),
        };
    },
  });
  const toggle = page.getByRole('button', { name: '显示对焦点（P）' });
  for (const [index, message] of [
    '未记录对焦区域',
    '尚不支持',
    '方向不匹配',
    '画幅与当前预览不匹配',
    '无法确认对焦坐标',
    '无法读取对焦记录',
    '裁剪范围之外',
    '预览不可用，无法校验对焦坐标',
  ].entries()) {
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await expect(toggle).toHaveAttribute('title', new RegExp(message));
    await expect(toggle).not.toHaveClass(/active/);
    await toggle.hover();
    await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await toggle.focus();
    await expect(toggle).toBeFocused();
    const helpId = await toggle.getAttribute('aria-describedby');
    await expect(page.locator(`[id="${helpId}"]`)).toContainText(message);
    await page.keyboard.press('p');
    await toggle.dispatchEvent('click');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.viewer-focus-status')).toHaveCount(0);
    await expect(page.locator('.focus-overlay')).not.toBeVisible();
    if (index < cases.length - 1) await page.keyboard.press('ArrowRight');
  }
});

test('focus stays disabled until the actual preview mapping arrives and then restores the enabled preference', async ({
  page,
}) => {
  let releasePreview: ((preview: Preview) => void) | undefined;
  const calls = await viewerFixture(page, {
    ids: ['ready', 'waiting'],
    handler: (call) => {
      if (call.command === 'asset.preview' && call.params.id === 'waiting')
        return new Promise<Preview>((resolve) => {
          releasePreview = resolve;
        });
    },
  });
  const toggle = page.getByRole('button', { name: '显示对焦点（P）' });
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await page.keyboard.press('p');
  await expect(page.locator('.focus-overlay')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => !!releasePreview).toBe(true);
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('title', '正在校验预览坐标…');
  await expect(page.locator('.focus-overlay')).toHaveCount(0);
  await page.keyboard.press('p');
  await toggle.dispatchEvent('click');
  releasePreview!({
    data_url: image,
    width: 800,
    height: 600,
    source: 'fixture',
    coordinate_mapping: { orientation: 8, full_width: 800, full_height: 600, crop: full },
  });
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.focus-overlay')).toBeVisible();
  expect(calls.filter((call) => call.command === 'asset.focus')).toHaveLength(2);
  await expect(page.locator('.viewer-focus-status')).toHaveCount(0);
});

test('disabled missing and failed images retain the preference, reuse detections and retry only after refresh', async ({
  page,
}) => {
  let errorReads = 0;
  const calls = await viewerFixture(page, {
    ids: ['good', 'missing', 'error', 'good-again'],
    handler: (call) => {
      if (call.command !== 'asset.focus') return;
      if (call.params.id === 'missing')
        return {
          ...focusInfo(),
          status: 'missing',
          reason: '此照片未记录可用的对焦区域坐标；不会由点位编号推测位置。',
          regions: [],
        };
      if (call.params.id === 'error' && ++errorReads === 1) throw new Error('相机对焦记录读取失败');
      return focusInfo();
    },
  });
  const toggle = page.getByRole('button', { name: '显示对焦点（P）' });
  const detections = () => calls.filter((call) => call.command === 'asset.focus');
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('p');
  await expect(page.locator('.focus-overlay')).toBeVisible();

  for (const [filename, reason] of [
    ['missing.jpg', '未记录可用的对焦区域坐标'],
    ['error.jpg', '相机对焦记录读取失败'],
  ]) {
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.main-photo')).toHaveAttribute('alt', filename);
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await expect(toggle).toHaveAttribute('title', new RegExp(reason));
    await expect(toggle).not.toHaveAttribute('title', /点位编号/);
    await expect(toggle).not.toHaveClass(/active/);
    await expect(page.locator('.focus-overlay')).toHaveCount(0);
    await page.keyboard.press('p');
    await toggle.dispatchEvent('click');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  }

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'good-again.jpg');
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.focus-overlay')).toBeVisible();
  expect(detections()).toHaveLength(4);

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'error.jpg');
  await expect(toggle).toHaveAttribute('title', /相机对焦记录读取失败/);
  expect(detections()).toHaveLength(4);
  await page.getByRole('button', { name: '重新读取原图', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.focus-overlay')).toBeVisible();
  expect(detections()).toHaveLength(5);

  await page.keyboard.press('ArrowLeft');
  await expect(toggle).toHaveAttribute('title', /未记录可用的对焦区域坐标/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'good.jpg');
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.focus-overlay')).toBeVisible();
  expect(detections()).toHaveLength(5);
  await expect(page.locator('.viewer-focus-status')).toHaveCount(0);
});

test('revisiting an externally replaced original detects new focus data even with the same id, direction and frame', async ({
  page,
}) => {
  let originalChanged = false;
  const calls = await viewerFixture(page, {
    ids: ['replaced', 'other'],
    handler: (call) => {
      if (call.params.id !== 'replaced') return;
      if (call.command === 'asset.get')
        return {
          ...photo('replaced'),
          size: originalChanged ? 2000 : 1000,
          modified_at: originalChanged ? '2026-10-16T13:10:00Z' : '2026-10-16T13:00:00Z',
        };
      if (call.command === 'asset.focus') return focusInfo(originalChanged ? 0.6 : 0.25);
    },
  });
  const toggle = page.getByRole('button', { name: '显示对焦点（P）' });
  const reads = () => calls.filter((call) => call.command === 'asset.focus');
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  await page.keyboard.press('p');
  await expect
    .poll(() =>
      page.locator('.focus-region.selected').evaluate((node) => (node as HTMLElement).style.left),
    )
    .toBe('25%');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'other.jpg');
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  originalChanged = true;
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'replaced.jpg');
  await expect
    .poll(() =>
      page.locator('.focus-region.selected').evaluate((node) => (node as HTMLElement).style.left),
    )
    .toBe('60%');
  expect(reads().filter((call) => call.params.id === 'replaced')).toHaveLength(2);
  expect(reads()).toHaveLength(3);

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'other.jpg');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'replaced.jpg');
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  expect(reads()).toHaveLength(3);
});
