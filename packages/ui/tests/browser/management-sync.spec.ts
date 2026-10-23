import { expect, test, type Page } from '@playwright/test';
import type { Asset, AssetListOptions, CaptureIndexStatus } from '../../src/model';
import { browserAssetList } from '../../src/workspace';

type Call = { command: string; params: Record<string, unknown> };
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
async function fixture(
  page: Page,
  count = 410,
  listenerFailures = 0,
  paired = false,
  browserMode = false,
  capturePending = false,
) {
  const calls: Call[] = [];
  let failedReads = 0;
  let failedLists = 0;
  if (browserMode)
    await page.route('**/src/api.ts', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `
      export const desktop = false;
      export async function execute(command, params={}) {
        const body = await (await fetch('/__sync_rpc', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({command,params})})).json();
        if(body.error) throw body.error;
        return body.result;
      }
      export const chooseDirectory = async()=>null, chooseSave = async(path)=>path, chooseImage = async()=>null;
      export const openViewerWindow = async()=>'', viewerContext = async()=>({asset_ids:[]}), listVolumes=async()=>[];
    `,
      }),
    );
  const assets: Asset[] = Array.from({ length: count }, (_, i) => ({
    id: `photo-${i}`,
    library_id: 'library',
    filename: `Photo-${String(i).padStart(3, '0')}.jpg`,
    path: `/photos/Photo-${String(i).padStart(3, '0')}.jpg`,
    extension: 'jpg',
    kind: 'raster',
    size: 100,
    width: 100,
    height: 80,
    rating: 0,
    metadata: { Camera: 'Fixture' },
    availability: 'available',
    captured_at: capturePending ? '' : `2026-10-${String(25 - (i % 20)).padStart(2, '0')}T00:00:00`,
    capture_status: capturePending ? 'pending' : 'available',
    modified_at: `2026-10-${String(25 - (i % 20)).padStart(2, '0')}`,
  }));
  const capture: CaptureIndexStatus = {
    library_id: 'library',
    total: count,
    known: capturePending ? 0 : count,
    missing: 0,
    pending: capturePending ? count : 0,
    job: null,
  };
  if (paired)
    assets[1] = {
      ...assets[1],
      filename: assets[0].filename.replace('.jpg', '.NEF'),
      path: assets[0].path.replace('.jpg', '.NEF'),
      extension: 'nef',
      kind: 'raw',
      rating: 5,
    };
  await page.route('**/__sync_rpc', async (route) => {
    const call = route.request().postDataJSON() as Call;
    calls.push(call);
    if (call.command === 'asset.get' && failedReads > 0) {
      failedReads--;
      await route.fulfill({ json: { error: { message: 'Synthetic unavailable image' } } });
      return;
    }
    if (call.command === 'asset.list' && failedLists > 0) {
      failedLists--;
      await route.fulfill({ json: { error: { message: 'Synthetic unavailable index' } } });
      return;
    }
    let result: unknown;
    switch (call.command) {
      case 'library.list':
        result = [
          {
            id: 'library',
            name: '同步图库',
            root: '/photos',
            created_at: '2026',
            pair_raw_jpeg: paired,
          },
        ];
        break;
      case 'storage.list':
        result = [];
        break;
      case 'system.info':
        result = {};
        break;
      case 'asset.list':
        result = browserAssetList(assets, call.params as AssetListOptions, paired);
        break;
      case 'import.batches':
        result = [];
        break;
      case 'library.capture_index.status':
        result = capture;
        break;
      case 'library.capture_index.start':
        capture.job = {
          id: 'capture-job',
          library_id: 'library',
          status: 'running',
          total: capture.pending,
          processed: 0,
          found: 0,
          missing: 0,
          failed: 0,
        };
        result = capture;
        break;
      case 'library.capture_index.cancel':
        capture.job!.status = 'stopping';
        result = capture;
        break;
      case 'asset.get':
        result = assets.find((a) => a.id === call.params.id);
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
      case 'asset.rate': {
        const asset = assets.find((a) => a.id === call.params.id)!;
        asset.rating = Number(call.params.rating);
        result = asset;
        break;
      }
      case 'asset.preview':
        result = { data_url: image, width: 100, height: 80, source: 'fixture' };
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
      case 'import.history':
        result = [];
        break;
      default:
        result = null;
    }
    await route.fulfill({ json: { result } });
  });
  await page.addInitScript(
    ({ listenerFailures }) => {
      let nextCallback = 0;
      const callbacks = new Map<number, (event: unknown) => void>();
      const listeners = new Map<string, number>();
      Object.assign(window, {
        isTauri: true,
        __emitAssetUpdate: (payload: unknown) =>
          callbacks.get(listeners.get('asset-updated')!)?.({
            event: 'asset-updated',
            id: 1,
            payload,
          }),
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          transformCallback: (callback: (event: unknown) => void) => {
            callbacks.set(++nextCallback, callback);
            return nextCallback;
          },
          unregisterCallback: (id: number) => callbacks.delete(id),
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
          invoke: async (command: string, params: Record<string, unknown>) => {
            if (command === 'plugin:window|set_theme') return null;
            if (command === 'plugin:window|theme') return 'dark';
            if (command === 'plugin:event|listen') {
              if (params.event === 'asset-updated' && listenerFailures-- > 0)
                throw new Error('Synthetic listener unavailable');
              listeners.set(String(params.event), Number(params.handler));
              return 1;
            }
            if (command.startsWith('plugin:event|')) return null;
            const response = await fetch('/__sync_rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                command === 'execute' ? params : { command: '$native/' + command, params },
              ),
            });
            const body = await response.json();
            if (body.error) throw body.error;
            return body.result;
          },
        },
      });
    },
    { listenerFailures },
  );
  await page.goto('/');
  await page.getByRole('button', { name: '打开图片库 同步图库' }).click();
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(
    Math.min(count - (paired ? 1 : 0), 200),
  );
  return { calls, assets, capture, failRead: () => failedReads++, failList: () => failedLists++ };
}
async function emit(
  page: Page,
  asset: Asset,
  change?: 'rating' | 'crop' | 'refresh',
  attached = true,
) {
  await page.evaluate(
    ({ asset, change, attached }) => {
      (window as unknown as { __emitAssetUpdate: (event: unknown) => void }).__emitAssetUpdate({
        id: asset.id,
        change,
        revision: change === 'rating' ? undefined : asset.preview_revision,
        ...(attached ? { asset } : {}),
      });
    },
    { asset, change, attached },
  );
}
async function settle(page: Page, calls: Call[]) {
  await expect(page.locator('.thumbnail-fallback').filter({ hasText: '载入中' })).toHaveCount(0);
  let count = calls.length;
  await expect
    .poll(async () => {
      await page.waitForTimeout(80);
      const stable = calls.length === count;
      count = calls.length;
      return stable;
    })
    .toBe(true);
}
async function rememberNodes(page: Page) {
  await page.evaluate(() =>
    Object.assign(window, { __nodes: [...document.querySelectorAll('.photo-grid .thumbnail')] }),
  );
}
async function nodesUnchanged(page: Page) {
  return page.evaluate(() => {
    const current = [...document.querySelectorAll('.photo-grid .thumbnail')];
    return (window as unknown as { __nodes: Element[] }).__nodes.every((node) =>
      current.includes(node),
    );
  });
}
test('repeated blur/focus preserves all loaded pages, detail, selection, scroll and thumbnail nodes without image/catalog reads', async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await page.getByRole('button', { name: '载入更多（200 / 410）' }).click();
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(400);
  await page.getByRole('button', { name: '影像详情（I）' }).click();
  await expect(page.getByRole('complementary', { name: '影像详情' })).toBeVisible();
  await page.locator('.collection-scroll').evaluate((el) => (el.scrollTop = 700));
  await settle(page, calls);
  await rememberNodes(page);
  const before = calls.length;
  const selected = await page.locator('.thumbnail.selected').getAttribute('aria-label');
  const scroll = await page.locator('.collection-scroll').evaluate((el) => el.scrollTop);
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    }
  });
  await page.waitForTimeout(250);
  expect(calls.slice(before)).toEqual([]);
  expect(await nodesUnchanged(page)).toBe(true);
  expect(await page.locator('.collection-scroll').evaluate((el) => el.scrollTop)).toBe(scroll);
  await expect(page.locator('.thumbnail.selected')).toHaveAttribute('aria-label', selected!);
  await expect(page.locator('.collection-status')).toContainText('已载入 400 / 410');
  await expect(page.getByRole('complementary', { name: '影像详情' })).toBeVisible();
});
test('rating updates fields only; crop and refresh invalidate only the changed asset pixels', async ({
  page,
}) => {
  const { calls, assets } = await fixture(page, 8);
  await page.getByRole('button', { name: '影像详情（I）' }).click();
  await expect(page.getByRole('complementary', { name: '影像详情' })).toBeVisible();
  await settle(page, calls);
  await rememberNodes(page);
  let before = calls.length;
  assets[0].rating = 4;
  await emit(page, assets[0], 'rating');
  await expect(page.locator('.thumbnail.selected')).toHaveAttribute(
    'aria-label',
    'Photo-000.jpg，4 星',
  );
  expect(calls.slice(before)).toEqual([]);
  expect(await nodesUnchanged(page)).toBe(true);
  assets[0].crop = { x: 0, y: 0, width: 0.5, height: 1 };
  assets[0].preview_revision = 100;
  before = calls.length;
  await emit(page, assets[0], 'crop');
  await expect
    .poll(() => calls.slice(before).filter((c) => c.command === 'asset.preview').length)
    .toBe(1);
  await expect
    .poll(() => calls.slice(before).filter((c) => c.command === 'asset.histogram').length)
    .toBe(1);
  expect(
    calls
      .slice(before)
      .every(
        (c) =>
          ['asset.preview', 'asset.histogram'].includes(c.command) && c.params.id === 'photo-0',
      ),
  ).toBe(true);
  expect(await nodesUnchanged(page)).toBe(true);
  before = calls.length;
  assets[0].preview_revision = 200;
  await emit(page, assets[0], 'refresh');
  await expect
    .poll(() => calls.slice(before).filter((c) => c.command === 'asset.preview').length)
    .toBe(1);
  await expect
    .poll(() => calls.slice(before).filter((c) => c.command === 'asset.histogram').length)
    .toBe(1);
  expect(calls.slice(before).every((c) => c.params.id === 'photo-0')).toBe(true);
});
test('rating sort reconciles the loaded window in the background without remounting its thumbnails or detail', async ({
  page,
}) => {
  const { calls, assets } = await fixture(page);
  await page.getByLabel('排序字段').selectOption('rating');
  await expect
    .poll(() => calls.filter((c) => c.command === 'asset.list').at(-1)?.params.sort_by)
    .toBe('rating');
  await page.getByRole('button', { name: '载入更多（200 / 410）' }).click();
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(400);
  await page.getByRole('button', { name: '影像详情（I）' }).click();
  await expect(page.getByRole('complementary', { name: '影像详情' })).toBeVisible();
  await page.locator('.collection-scroll').evaluate((el) => (el.scrollTop = 600));
  await settle(page, calls);
  await rememberNodes(page);
  const selected = await page.locator('.thumbnail.selected').getAttribute('aria-label');
  const before = calls.length;
  // photo-90 lies within the already loaded window but is not selected.
  assets[90].rating = 5;
  await emit(page, assets[90], 'rating');
  await expect(page.locator('.photo-grid .thumbnail').first()).toHaveAttribute(
    'aria-label',
    'Photo-090.jpg，5 星',
  );
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(400);
  expect(calls.slice(before).filter((c) => c.command === 'asset.list')).toHaveLength(1);
  expect(calls.slice(before).find((c) => c.command === 'asset.list')?.params.limit).toBe(400);
  expect(
    calls.slice(before).filter((c) => ['asset.get', 'asset.histogram'].includes(c.command)),
  ).toEqual([]);
  expect(await nodesUnchanged(page)).toBe(true);
  await expect(page.locator('.thumbnail.selected')).toHaveAttribute('aria-label', selected!);
  expect(await page.locator('.collection-scroll').evaluate((el) => el.scrollTop)).toBe(600);
});
test('legacy id event precisely reads one asset and a rating filter can change a paired representative', async ({
  page,
}) => {
  const { calls, assets } = await fixture(page, 4, 0, true);
  await page.getByLabel('最低评级筛选').selectOption('3');
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(1);
  await expect(page.locator('.photo-grid .thumbnail')).toHaveAttribute(
    'aria-label',
    'Photo-000.NEF，5 星',
  );
  const before = calls.length;
  assets[0].rating = 4;
  await emit(page, assets[0], undefined, false);
  await expect(page.locator('.photo-grid .thumbnail')).toHaveAttribute(
    'aria-label',
    'Photo-000.jpg，4 星',
  );
  expect(
    calls
      .slice(before)
      .filter((c) => c.command === 'asset.get')
      .map((c) => c.params.id),
  ).toEqual(['photo-0']);
  expect(calls.slice(before).filter((c) => c.command === 'asset.list')).toHaveLength(1);
});
test('a creation time refresh reconciles the whole loaded catalog in the selected direction', async ({
  page,
}) => {
  const { calls, assets } = await fixture(page, 4);
  assets.forEach((asset, index) => {
    asset.created_at = `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`;
  });
  await page.getByLabel('排序字段').selectOption('created_at');
  await expect(page.locator('.photo-grid .thumbnail').first()).toHaveAttribute(
    'aria-label',
    'Photo-003.jpg，0 星',
  );
  await page.getByLabel('排序方向').selectOption('asc');
  await expect(page.locator('.photo-grid .thumbnail').first()).toHaveAttribute(
    'aria-label',
    'Photo-000.jpg，0 星',
  );
  await settle(page, calls);
  const before = calls.length;
  assets[3].created_at = '2020-01-01T00:00:00Z';
  // Older viewers attach the updated asset without classifying the change.
  await emit(page, assets[3]);
  await expect(page.locator('.photo-grid .thumbnail').first()).toHaveAttribute(
    'aria-label',
    'Photo-003.jpg，0 星',
  );
  const queries = calls.slice(before).filter((call) => call.command === 'asset.list');
  expect(queries).toHaveLength(1);
  expect(queries[0].params).toMatchObject({
    sort_by: 'created_at',
    sort_direction: 'asc',
    offset: 0,
  });
});
test('capture metadata updates reorder the authoritative catalog without decoding thumbnails or histograms again', async ({
  page,
}) => {
  const { calls, assets } = await fixture(page, 8);
  await expect(page.getByLabel('排序字段')).toHaveValue('captured_at');
  await page.getByRole('button', { name: '影像详情（I）' }).click();
  await expect(page.getByRole('complementary', { name: '影像详情' })).toBeVisible();
  await settle(page, calls);
  await rememberNodes(page);
  const before = calls.length;
  assets[0].captured_at = '2020-01-01T08:30:00';
  assets[0].metadata.Captured = '2020:01:01 08:30:00';
  await emit(page, assets[0]);
  await expect(page.locator('.photo-grid .thumbnail').first()).toHaveAttribute(
    'aria-label',
    'Photo-001.jpg，0 星',
  );
  await expect(page.locator('.thumbnail.selected')).toHaveAttribute(
    'aria-label',
    'Photo-000.jpg，0 星',
  );
  await settle(page, calls);
  expect(calls.slice(before).filter((call) => call.command === 'asset.list')).toHaveLength(1);
  expect(
    calls
      .slice(before)
      .filter((call) => ['asset.preview', 'asset.histogram'].includes(call.command)),
  ).toEqual([]);
  expect(await nodesUnchanged(page)).toBe(true);
});
test('capture indexing starts explicitly, remains independent of navigation, and cancellation preserves results with one catalog reconciliation', async ({
  page,
}) => {
  const { calls, assets, capture } = await fixture(page, 8, 0, false, false, true);
  await expect(page.getByRole('button', { name: '索引拍摄时间', exact: true })).toBeVisible();
  expect(calls.filter((call) => call.command === 'library.capture_index.start')).toEqual([]);
  await page.getByRole('button', { name: '索引拍摄时间', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '拍摄时间索引进度' })).toBeVisible();
  await expect(page.getByRole('button', { name: '扫描更新', exact: true })).toBeEnabled();
  const nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  expect(calls.filter((call) => call.command === 'library.capture_index.cancel')).toEqual([]);
  await nav.getByRole('button', { name: '图片库', exact: true }).click();
  await page.getByRole('button', { name: '打开图片库 同步图库' }).click();
  await expect(page.getByRole('progressbar', { name: '拍摄时间索引进度' })).toBeVisible();
  // The task status mounts before the debounced catalog query. Establish the
  // baseline from this gallery's loaded images, not the previous visit's RPCs.
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(8);
  await expect(page.locator('.photo-grid .thumbnail img')).toHaveCount(8);
  await expect
    .poll(() =>
      page
        .locator('.photo-grid .thumbnail img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  await settle(page, calls);
  await page.evaluate(() =>
    Object.assign(window, {
      __captureImages: [...document.querySelectorAll('.photo-grid .thumbnail img')],
    }),
  );
  await rememberNodes(page);
  const selected = await page.locator('.thumbnail.selected').getAttribute('aria-label');
  const before = calls.length;
  await page.getByRole('button', { name: '停止拍摄时间索引' }).click();
  await expect(page.getByRole('button', { name: '停止拍摄时间索引' })).toBeDisabled();
  expect(
    calls.filter((call) => call.command === 'library.capture_index.cancel').at(-1)?.params,
  ).toEqual({ library_id: 'library', job_id: 'capture-job' });
  assets[0].captured_at = '2026-10-17T08:30:00';
  assets[0].capture_status = 'available';
  capture.known = 1;
  capture.pending = 7;
  Object.assign(capture.job!, { status: 'cancelled', processed: 1, found: 1 });
  await expect(page.getByText('已停止，已读取的结果已保留。')).toBeVisible();
  await expect(page.locator('.photo-grid .thumbnail').first()).toHaveAttribute(
    'aria-label',
    'Photo-000.jpg，0 星',
  );
  await settle(page, calls);
  expect(calls.slice(before).filter((call) => call.command === 'asset.list')).toHaveLength(1);
  expect(
    calls
      .slice(before)
      .filter((call) => ['asset.preview', 'asset.histogram'].includes(call.command)),
  ).toEqual([]);
  await expect(page.locator('.thumbnail.selected')).toHaveAttribute('aria-label', selected!);
  expect(await nodesUnchanged(page)).toBe(true);
  expect(
    await page.evaluate(() => {
      const current = [...document.querySelectorAll('.photo-grid .thumbnail img')];
      return (window as unknown as { __captureImages: Element[] }).__captureImages.every((image) =>
        current.includes(image),
      );
    }),
  ).toBe(true);
  await expect(page.getByRole('button', { name: '索引拍摄时间', exact: true })).toBeVisible();
  const finished = calls.length;
  await page.waitForTimeout(1200);
  expect(calls.slice(finished)).toEqual([]);
});
test('capture index failure leaves unread photos pending and exposes retry without claiming missing EXIF', async ({
  page,
}) => {
  const { calls, capture } = await fixture(page, 4, 0, false, false, true);
  await page.getByRole('button', { name: '索引拍摄时间', exact: true }).click();
  Object.assign(capture.job!, {
    status: 'failed',
    processed: 1,
    failed: 1,
    error: '此远端不支持有界元信息读取。',
  });
  await expect(page.getByRole('alert')).toContainText('此远端不支持有界元信息读取。');
  const retry = page.getByRole('button', { name: '重试拍摄时间索引', exact: true });
  await expect(retry).toBeVisible();
  await expect(retry).toHaveAttribute('title', /未获得 0 · 待索引 4/);
  await retry.click();
  await expect(page.getByRole('progressbar', { name: '拍摄时间索引进度' })).toBeVisible();
  expect(calls.filter((call) => call.command === 'library.capture_index.start')).toHaveLength(2);
});
test('capture indexing completes with known and missing counts, reconciles once and does not repeat work on return', async ({
  page,
}, testInfo) => {
  const { calls, assets, capture } = await fixture(page, 4, 0, false, false, true);
  await page.getByRole('button', { name: '索引拍摄时间', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '拍摄时间索引进度' })).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('capture-index-running.png') });
  await settle(page, calls);
  const before = calls.length;
  assets[0].captured_at = '2026-10-17T08:30:00';
  assets[0].capture_status = 'available';
  assets.slice(1).forEach((asset) => (asset.capture_status = 'missing'));
  Object.assign(capture, { known: 1, missing: 3, pending: 0 });
  Object.assign(capture.job!, { status: 'completed', processed: 4, found: 1, missing: 3 });
  await expect(page.getByText('拍摄时间索引完成。')).toBeVisible();
  await settle(page, calls);
  expect(calls.slice(before).filter((call) => call.command === 'asset.list')).toHaveLength(1);
  await expect(page.getByRole('button', { name: '索引拍摄时间', exact: true })).toHaveCount(0);
  await expect(page.getByText('拍摄时间索引完成。')).toHaveAttribute(
    'title',
    /已知 1 · 未获得 3 · 待索引 0/,
  );
  await page.screenshot({ path: testInfo.outputPath('capture-index-completed.png') });
  await page.getByLabel('排序字段').selectOption('filename');
  await expect
    .poll(() => calls.filter((call) => call.command === 'asset.list').at(-1)?.params.sort_by)
    .toBe('filename');
  await settle(page, calls);
  const reenter = calls.length;
  await page.getByLabel('排序字段').selectOption('captured_at');
  await expect
    .poll(() => calls.slice(reenter).filter((call) => call.command === 'asset.list').length)
    .toBe(1);
  await page.waitForTimeout(250);
  expect(calls.slice(reenter).filter((call) => call.command === 'asset.list')).toHaveLength(1);
  expect(calls.filter((call) => call.command === 'library.capture_index.start')).toHaveLength(1);
});
test('failed listener registration is visible and retryable without a full focus refresh', async ({
  page,
}) => {
  const { calls, assets } = await fixture(page, 3, 1);
  await expect(page.getByRole('alert')).toContainText('无法监听查看器变更');
  await settle(page, calls);
  const before = calls.length;
  await page.getByRole('button', { name: '重试影像同步' }).click();
  await expect(page.getByText('无法监听查看器变更', { exact: false })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(calls.slice(before)).toEqual([]);
  assets[0].rating = 3;
  await emit(page, assets[0], 'rating');
  await expect(page.locator('.thumbnail.selected')).toHaveAttribute(
    'aria-label',
    'Photo-000.jpg，3 星',
  );
});

test('focus retries only an actual failed asset event, then becomes network silent again', async ({
  page,
}) => {
  const { calls, assets, failRead } = await fixture(page, 3);
  await settle(page, calls);
  failRead();
  assets[0].rating = 2;
  await emit(page, assets[0], 'rating', false);
  await expect(page.getByRole('alert')).toContainText('影像变更尚未同步');
  const before = calls.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.thumbnail.selected')).toHaveAttribute(
    'aria-label',
    'Photo-000.jpg，2 星',
  );
  expect(calls.slice(before).map((call) => call.command)).toEqual(['asset.get']);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(100);
  expect(calls.slice(before).map((call) => call.command)).toEqual(['asset.get']);
});

test('closing the browser overlay keeps its direct rating update without reloading the collection', async ({
  page,
}) => {
  const { calls } = await fixture(page, 8, 0, false, true);
  await settle(page, calls);
  await rememberNodes(page);
  await page.locator('.thumbnail').first().dblclick();
  await expect(page.locator('.viewer .photo-stage')).toBeVisible();
  await page.keyboard.press('4');
  await expect.poll(() => calls.filter((call) => call.command === 'asset.rate').length).toBe(1);
  await expect(page.locator('.photo-grid .thumbnail').first()).toHaveAttribute(
    'aria-label',
    'Photo-000.jpg，4 星',
  );
  await settle(page, calls);
  const before = calls.length;
  await page.keyboard.press('Escape');
  await expect(page.locator('.viewer')).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(calls.slice(before)).toEqual([]);
  expect(await nodesUnchanged(page)).toBe(true);
});

test('failed background membership reconciliation remains retryable after the asset fields were already patched', async ({
  page,
}) => {
  const { calls, assets, failList } = await fixture(page, 1);
  await page.getByLabel('搜索照片').fill('Fixture');
  await expect
    .poll(() => calls.filter((call) => call.command === 'asset.list').at(-1)?.params.query)
    .toBe('Fixture');
  await settle(page, calls);
  failList();
  assets[0].metadata = { Camera: 'Changed' };
  assets[0].preview_revision = 300;
  await emit(page, assets[0], 'refresh');
  await expect(page.getByText('影像变更尚未同步', { exact: false })).toBeVisible();
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(1);
  const before = calls.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(0);
  expect(calls.slice(before).filter((call) => call.command === 'asset.list')).toHaveLength(1);
  expect(calls.slice(before).filter((call) => call.command === 'asset.get')).toHaveLength(0);
  await expect(page.getByText('影像变更尚未同步', { exact: false })).toHaveCount(0);
});
