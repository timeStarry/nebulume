import { expect, test, type Page } from '@playwright/test';
import type { Asset, Preview } from '../../src/model';

type Call = { command: string; params: Record<string, unknown> };
const pixels = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#344756"/></svg>')}`;
const remote = (id: string): Asset => ({
  id,
  library_id: 'remote-preview',
  source_key: `Trip/${id}.NEF`,
  path: '',
  filename: `${id}.NEF`,
  extension: 'nef',
  kind: 'raw',
  size: 12000,
  modified_at: '2026-10-16T10:00:00Z',
  rating: 0,
  metadata: {},
  availability: 'remote',
  cache_pinned: false,
});
function decoded(asset: Asset): Preview {
  return {
    data_url: pixels,
    width: 800,
    height: 600,
    source: 'embedded_jpeg',
    asset: {
      ...asset,
      width: 800,
      height: 600,
      availability: 'available',
      metadata: {
        Camera: `Camera ${asset.id}`,
        Aperture: 'f/2.8',
        Exposure: '1/250 s',
        ISO: '400',
      },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function viewer(
  page: Page,
  handler: (call: Call, asset: Asset | undefined) => unknown | Promise<unknown>,
  ids = ['first', 'second'],
) {
  const assets = new Map(ids.map((id) => [id, remote(id)]));
  const calls: Call[] = [];
  const settled: Call[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/__remote_preview_rpc', async (route) => {
    const call = route.request().postDataJSON() as Call;
    calls.push(call);
    const asset = assets.get(String(call.params.id));
    try {
      let result = await handler(call, asset);
      if (result === undefined)
        switch (call.command) {
          case 'viewer_context':
            result = { asset_id: ids[0], asset_ids: ids };
            break;
          case 'asset.get':
            result = asset;
            break;
          case 'asset.preview':
            result = decoded(asset!);
            break;
          case 'asset.fetch_original':
            result = { ...asset, path: `C:/Cache/${asset!.id}.NEF` };
            break;
          case 'asset.focus':
            result = {
              status: 'missing',
              reason: '未记录可用的对焦区域坐标',
              regions: [],
              orientation: 1,
              coordinate_space: 'oriented_full_image',
            };
            break;
          case 'asset.histogram':
            result = {
              red: Array(256).fill(1),
              green: Array(256).fill(1),
              blue: Array(256).fill(1),
              luminance: Array(256).fill(1),
              pixels: 256,
              source: 'embedded_jpeg',
            };
            break;
          case 'plugin:window|theme':
            result = 'dark';
            break;
          case 'plugin:window|set_theme':
          case 'plugin:window|set_title':
            result = null;
            break;
          default:
            throw new Error(`Unexpected remote preview command: ${call.command}`);
        }
      await route.fulfill({ json: { result } });
    } catch (cause) {
      await route.fulfill({
        json: { error: { code: 'REMOTE_PREVIEW_TEST', message: (cause as Error).message } },
      });
    }
    settled.push(call);
  });
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: 'remote-preview-test' },
          currentWebview: { label: 'remote-preview-test' },
        },
        transformCallback: () => 1,
        unregisterCallback() {},
        invoke: async (command: string, params: Record<string, unknown>) => {
          if (command.startsWith('plugin:event|')) return 1;
          const response = await fetch('/__remote_preview_rpc', {
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
  return { assets, calls, settled, errors };
}
const count = (calls: Call[], command: string, id: string) =>
  calls.filter((call) => call.command === command && call.params.id === id).length;

test('remote metadata stays empty until preview enriches current EXIF without repeated preview IPC', async ({
  page,
}) => {
  const pending = deferred<Preview>();
  const fixture = await viewer(
    page,
    (call) => (call.command === 'asset.preview' ? pending.promise : undefined),
    ['first'],
  );
  await page.getByRole('button', { name: '影像信息（I）', exact: true }).click();
  await expect(page.locator('.asset-inspector')).not.toContainText('Camera first');
  expect(fixture.assets.get('first')?.metadata).toEqual({});
  pending.resolve(decoded(fixture.assets.get('first')!));
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'first.NEF');
  await expect(page.locator('.asset-inspector')).toContainText('Camera first');
  await expect(page.locator('.exposure-summary')).toContainText('f/2.8');
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.getByRole('button', { name: '关闭影像详情', exact: true }).click();
  await page.getByRole('button', { name: '影像信息（I）', exact: true }).click();
  await expect(page.locator('.asset-inspector')).toContainText('Camera first');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(count(fixture.calls, 'asset.get', 'first')).toBe(1);
  expect(count(fixture.calls, 'asset.preview', 'first')).toBe(1);
  expect(fixture.errors).toEqual([]);
});
test('manual full-file request shows service errors and refetches only the active preview after success', async ({
  page,
}) => {
  let fetched = false;
  let attempts = 0;
  const fixture = await viewer(page, (call, asset) => {
    if (call.command === 'asset.preview' && !fetched)
      throw new Error('E_DOWNLOAD_REQUIRED: manual download required');
    if (call.command === 'asset.fetch_original') {
      if (++attempts === 1) throw new Error('E_CACHE_FULL: protected files occupy cache budget');
      fetched = true;
      return asset;
    }
  });
  const download = page.getByRole('button', { name: '下载原图并预览', exact: true });
  await expect(download).toBeVisible();
  expect(count(fixture.calls, 'asset.fetch_original', 'first')).toBe(0);
  await download.click();
  await expect(page.getByRole('alert')).toContainText('protected files occupy cache budget');
  await download.click();
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'first.NEF');
  expect(count(fixture.calls, 'asset.fetch_original', 'first')).toBe(2);
  expect(count(fixture.calls, 'asset.preview', 'first')).toBe(2);
  expect(count(fixture.calls, 'asset.get', 'first')).toBe(1);
  expect(count(fixture.calls, 'asset.preview', 'second')).toBe(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});
for (const outcome of ['success', 'failure'] as const)
  test(`late ${outcome} from old manual download does not refetch or alter the new photo`, async ({
    page,
  }) => {
    const pending = deferred<Asset>();
    const fixture = await viewer(page, (call) => {
      if (call.command === 'asset.preview' && call.params.id === 'first')
        throw new Error('E_DOWNLOAD_REQUIRED: manual download required');
      if (call.command === 'asset.fetch_original') return pending.promise;
    });
    await page.getByRole('button', { name: '下载原图并预览', exact: true }).click();
    await expect(page.getByRole('button', { name: '正在下载…', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '下一张（→）', exact: true }).click();
    await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'second.NEF');
    expect(count(fixture.calls, 'asset.preview', 'second')).toBe(1);
    if (outcome === 'success') pending.resolve(fixture.assets.get('first')!);
    else pending.reject(new Error('E_CACHE_IO: old download failed'));
    await expect.poll(() => count(fixture.settled, 'asset.fetch_original', 'first')).toBe(1);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'second.NEF');
    expect(count(fixture.calls, 'asset.preview', 'first')).toBe(1);
    expect(count(fixture.calls, 'asset.preview', 'second')).toBe(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(fixture.errors).toEqual([]);
  });
