import { expect, test, type Page } from '@playwright/test';
import { selectChoice, servePreviewImages } from './fixtures';
import type { Asset, Library, StorageConfig } from '../../src/model';

type Call = { command: string; params: Record<string, unknown> };
const local: Library = {
  id: 'library-local',
  name: '本地摄影',
  root: 'D:\\Photos',
  created_at: '2026-10-01',
  storage_id: 'local',
  source_kind: 'local',
  source_name: '照片磁盘',
  source_prefix: '',
};
const remote: Library = {
  ...local,
  id: 'library-nas',
  name: 'NAS 旅行',
  root: 'D:\\Cache\\internal',
  storage_id: 'nas',
  source_kind: 'webdav',
  source_endpoint: 'https://nas.local/dav/',
  source_prefix: 'trips/',
  source_name: '家庭 NAS',
};
const nas: StorageConfig = {
  id: 'nas',
  name: '家庭 NAS',
  kind: 'webdav',
  endpoint: 'https://nas.local/dav/',
  connected: false,
  remember_credentials: true,
  credential_status: 'system',
};
const photo: Asset = {
  id: 'photo-a',
  library_id: local.id,
  filename: 'Mountain.png',
  path: 'D:\\Photos\\Mountain.png',
  extension: 'png',
  kind: 'raster',
  size: 12000,
  width: 960,
  height: 640,
  rating: 0,
  metadata: { Camera: 'Fixture camera' },
  availability: 'available',
  modified_at: '2026-10-01T10:00:00Z',
};

async function fixture(page: Page, handler?: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const libs = [local, remote];
  await page.route('**/__management_rpc', async (route) => {
    const call = route.request().postDataJSON() as Call;
    calls.push(call);
    try {
      let result = await handler?.(call);
      if (result === undefined)
        switch (call.command) {
          case 'library.list':
            result = libs;
            break;
          case 'storage.list':
            result = [nas];
            break;
          case 'storage.check':
            result = {
              id: String(call.params.id),
              connected: true,
              availability: 'online',
              credential_status: 'system',
              checked_at: '2026-11-13T00:00:00Z',
              error: null,
            };
            break;
          case 'storage.probe':
            result = {
              id: 'probe',
              connected: true,
              availability: 'online',
              credential_status: 'system',
              checked_at: '2026-11-13T00:00:00Z',
              error: null,
            };
            break;
          case 'system.info':
            result = { originals_read_only: true };
            break;
          case 'asset.list':
            result = { items: [{ ...photo, library_id: call.params.library_id }], total: 1 };
            break;
          case 'asset.ids':
            result = { ids: [photo.id], total: 1 };
            break;
          case 'asset.facets':
            result = { cameras: [], lenses: [], captured: { first: null, last: null } };
            break;
          case 'library.folders':
            result = { total: 1, folders: [] };
            break;
          case '$native/watch_libraries':
            result = null;
            break;
          case 'import.batches':
            result = [];
            break;
          case 'library.capture_index.status':
            result = {
              library_id: call.params.library_id,
              total: 1,
              known: 1,
              missing: 0,
              pending: 0,
              job: null,
            };
            break;
          case 'asset.get':
            result = photo;
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
            result = { tier: 'p2560' as const, width: 1, height: 1, source: 'test fixture' };
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
            result = { asset_id: photo.id, asset_ids: [photo.id] };
            break;
          case 'card.list':
          case 'preset.list':
            result = [];
            break;
          case 'library.fingerprint.status':
            result = {
              library_id: call.params.library_id,
              total: 1,
              known: 0,
              pending: 1,
              pending_bytes: 12000,
              remote: call.params.library_id === remote.id,
              job: null,
            };
            break;
          case 'card.identify':
            result = { status: 'unknown', candidates: [] };
            break;
          case '$native/list_volumes':
            result = [
              {
                id: 'card',
                name: 'CAMERA CARD',
                path: 'E:\\',
                kind: 'removable',
                removable: true,
                available_bytes: 100000,
              },
            ];
            break;
          case '$native/plugin:window|theme':
            result = 'dark';
            break;
          case '$native/plugin:window|set_theme':
          case '$native/plugin:window|set_title':
            result = null;
            break;
          case 'import.history':
            result = [];
            break;
          case 'library.scan':
            result = { indexed: 1, skipped: 0, errors: [] };
            break;
          case '$native/pregenerate_previews':
            result = null;
            break;
          case 'library.add': {
            result = {
              ...remote,
              id: 'new-library',
              name: call.params.name,
              source_prefix: call.params.prefix,
            };
            libs.push(result as Library);
            break;
          }
          default:
            throw new Error(`Unexpected management fixture: ${call.command}`);
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
        convertFileSrc: (p: string, s: string) =>
          'http://' + s + '.localhost/' + encodeURIComponent(p),
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: {
          currentWindow: { label: 'viewer-test' },
          currentWebview: { label: 'viewer-test' },
        },
        invoke: async (command: string, params: Record<string, unknown>) => {
          if (command.startsWith('plugin:event|')) return 1;
          const response = await fetch('/__management_rpc', {
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
  await servePreviewImages(page);
  await page.addInitScript(() => localStorage.setItem('nebulume.filters-open', 'true'));
  await page.goto('/');
  return calls;
}
const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true });

for (const sortBy of ['filename', 'created_at', 'captured_at'] as const)
  test(`${sortBy}: format, rating, sort key and direction combine in every paged catalog request`, async ({
    page,
  }) => {
    const first = {
      ...photo,
      id: 'server-first',
      filename: 'Zulu.jpg',
      extension: 'jpg',
      rating: 4,
      created_at: '2026-10-15T00:00:00Z',
    };
    const second = {
      ...photo,
      id: 'server-second',
      filename: 'Alpha.jpg',
      extension: 'jpg',
      rating: 4,
      created_at: '2020-01-01T00:00:00Z',
    };
    const third = { ...photo, id: 'page-two', filename: 'Page2.jpg', extension: 'jpg', rating: 4 };
    const calls = await fixture(page, (call) => {
      if (call.command === 'asset.list')
        return { items: call.params.offset ? [third] : [first, second], total: 3, file_total: 3 };
    });
    await page.getByRole('button', { name: '打开图片库 本地摄影' }).click();
    await selectChoice(page.getByLabel('最低评级筛选'), '3');
    await selectChoice(page.getByLabel('文件格式筛选'), 'jpeg');
    await selectChoice(page.getByLabel('排序字段'), sortBy);
    await page.getByRole('button', { name: /^排序方向：降序/ }).click();
    const matching = () => calls.filter((call) => call.command === 'asset.list').at(-1)?.params;
    const firstPage = () =>
      calls.find(
        (call) =>
          call.command === 'asset.list' &&
          call.params.sort_direction === 'asc' &&
          call.params.format === 'jpeg' &&
          call.params.offset === 0,
      )?.params;
    await expect.poll(firstPage).toMatchObject({
      library_id: local.id,
      rating: 3,
      format: 'jpeg',
      sort_by: sortBy,
      sort_direction: 'asc',
      offset: 0,
      limit: 200,
    });
    // The UI must preserve the authoritative service order, even across pages.
    await expect(page.locator('.photo-grid .thumbnail').first()).toHaveAttribute(
      'aria-label',
      'Zulu.jpg，4 星',
    );
    // The next page loads automatically once the end of the grid is near.
    await expect.poll(matching).toMatchObject({
      rating: 3,
      format: 'jpeg',
      sort_by: sortBy,
      sort_direction: 'asc',
      offset: 2,
    });
    await expect(page.locator('.photo-grid .thumbnail').last()).toHaveAttribute(
      'aria-label',
      'Page2.jpg，4 星',
    );
    await page.getByRole('button', { name: /^排序方向：升序/ }).click();
    await selectChoice(page.getByLabel('文件格式筛选'), 'raw');
    await expect
      .poll(
        () =>
          calls.find(
            (call) =>
              call.command === 'asset.list' &&
              call.params.format === 'raw' &&
              call.params.offset === 0,
          )?.params,
      )
      .toMatchObject({
        rating: 3,
        format: 'raw',
        sort_by: sortBy,
        sort_direction: 'desc',
        offset: 0,
      });
    await page.setViewportSize({ width: 1024, height: 768 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

test('library settings persist pairing, variants replace their representative, and rebinding requires explicit review', async ({
  page,
}) => {
  let library: Library = { ...local, pair_raw_jpeg: false };
  let failScan: (() => void) | undefined;
  const raw = {
    id: 'paired-raw',
    filename: 'Mountain.nef',
    extension: 'nef',
    kind: 'raw' as const,
  };
  const jpg = { id: photo.id, filename: 'Mountain.jpg', extension: 'jpg', kind: 'raster' as const };
  const other = { ...photo, id: 'other', filename: 'Other.png' };
  const calls = await fixture(page, (call) => {
    if (call.command === 'library.list') return [library];
    if (call.command === 'storage.list')
      return [{ id: 'local', name: '照片磁盘', kind: 'local', endpoint: 'D:\\Photos' }, nas];
    if (call.command === 'library.update') {
      library = { ...library, ...call.params } as Library;
      return library;
    }
    if (call.command === 'library.scan')
      return new Promise((_resolve, reject) => {
        failScan = () => reject(new Error('新来源离线，扫描未完成'));
      });
    if (call.command === 'asset.list')
      return {
        items: library.pair_raw_jpeg
          ? [{ ...photo, ...jpg, variants: [raw, jpg] }, other]
          : [{ ...photo, ...jpg }, { ...photo, ...raw }, other],
        total: library.pair_raw_jpeg ? 2 : 3,
        file_total: 3,
      };
  });
  await page.getByRole('button', { name: '打开图片库 本地摄影' }).click();
  await page.getByRole('button', { name: '本地摄影 更多操作' }).click();
  await page.getByRole('menuitem', { name: '本地摄影 图片库设置' }).click();
  await page.getByLabel('图片库名称').fill('配对照片');
  await page.getByLabel('合并显示 RAW + JPEG').check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'library.update')?.params)
    .toEqual({ id: local.id, name: '配对照片', pair_raw_jpeg: true });
  await expect(page.locator('.asset-variants').getByRole('button')).toHaveText(['RAW', 'JPEG']);
  await expect(page.locator('.collection-status')).toContainText('2 张 · 3 文件');
  await expect(page.locator('.collection-status')).toHaveAttribute(
    'title',
    '已载入 2 / 2 项 · 3 个匹配文件',
  );
  // Each variant opens in place, in a sequence where it replaces its representative.
  const viewer = page.getByRole('dialog', { name: '沉浸影像查看器' });
  await page.getByRole('button', { name: '打开 Mountain.nef RAW' }).click();
  await expect
    .poll(() => calls.filter((call) => call.command === 'asset.get').at(-1)?.params)
    .toEqual({ id: raw.id });
  await expect(viewer.getByLabel('第 1 张，共 2 张')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await page.getByRole('button', { name: '打开 Mountain.jpg JPEG' }).click();
  await expect
    .poll(() => calls.filter((call) => call.command === 'asset.get').at(-1)?.params)
    .toEqual({ id: jpg.id });
  await expect(viewer.getByLabel('第 1 张，共 2 张')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await page.getByRole('button', { name: '配对照片 更多操作' }).click();
  await page.getByRole('menuitem', { name: '配对照片 图片库设置' }).click();
  await expect(page.getByLabel('合并显示 RAW + JPEG')).toBeChecked();
  await selectChoice(page.getByLabel('来源类型'), 'remote');
  await selectChoice(page.getByLabel('存储源', { exact: true }), 'nas');
  await page.getByLabel('源内目录（可选）').fill('trips/');
  await page.getByRole('button', { name: '检查位置更改' }).click();
  expect(calls.filter((call) => call.command === 'library.update')).toHaveLength(1);
  await expect(page.getByRole('dialog')).toContainText('旧索引、评级和裁剪配方');
  await page.getByRole('button', { name: '确认更改位置并清空索引' }).click();
  await expect
    .poll(() => calls.filter((call) => call.command === 'library.update').at(-1)?.params)
    .toEqual({
      id: local.id,
      name: '配对照片',
      pair_raw_jpeg: true,
      storage_id: 'nas',
      source_prefix: 'trips/',
    });
  await expect.poll(() => calls.some((call) => call.command === 'library.scan')).toBe(true);
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '影像详情' })).not.toBeVisible();
  failScan!();
  await expect(page.getByRole('alert')).toContainText('新来源离线，扫描未完成');
  await expect(page.getByRole('heading', { name: '图片库尚无照片' })).toBeVisible();
  await expect(page.locator('.photo-grid .thumbnail')).toHaveCount(0);
});

test('removal dialogs preserve originals, block referenced sources and retain a raced reference error', async ({
  page,
}) => {
  let libraries = [local, remote];
  let sourcePresent = true;
  let raced = false;
  const calls = await fixture(page, (call) => {
    if (call.command === 'library.list') return libraries;
    if (call.command === 'storage.list') return sourcePresent ? [nas] : [];
    if (call.command === 'library.remove') {
      libraries = libraries.filter((library) => library.id !== call.params.id);
      return { id: call.params.id };
    }
    if (call.command === 'storage.remove') {
      if (!raced) {
        raced = true;
        throw new Error('E_IN_USE: Storage is used by libraries: 新增归档');
      }
      sourcePresent = false;
      return { id: nas.id };
    }
  });
  await page.getByRole('button', { name: 'NAS 旅行 更多操作' }).click();
  await page.getByRole('menuitem', { name: '移除图片库 NAS 旅行' }).click();
  await expect(page.getByRole('dialog')).toContainText('原始照片及目录不会删除');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(calls.some((call) => call.command === 'library.remove')).toBe(false);
  await nav(page, '位置').click();
  await page.getByRole('button', { name: '移除位置 家庭 NAS' }).click();
  await expect(page.getByRole('dialog')).toContainText('NAS 旅行');
  await expect(page.getByRole('button', { name: '确认移除', exact: true })).toBeDisabled();
  expect(calls.some((call) => call.command === 'storage.remove')).toBe(false);
  await page.getByRole('button', { name: '管理关联图片库' }).click();
  await page.getByRole('button', { name: 'NAS 旅行 更多操作' }).click();
  await page.getByRole('menuitem', { name: '移除图片库 NAS 旅行' }).click();
  await page.clock.install();
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开图片库 NAS 旅行' })).not.toBeVisible();
  const removedNotice = page.getByRole('status').filter({ hasText: '已移除 NAS 旅行' });
  await expect(removedNotice).toBeVisible();
  await page.clock.runFor(6500);
  await expect(removedNotice).toHaveCount(0);
  await page.clock.resume();
  await nav(page, '位置').click();
  await page.getByRole('button', { name: '移除位置 家庭 NAS' }).click();
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('关联图片库：新增归档');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '移除位置 家庭 NAS' })).not.toBeVisible();
  expect(calls.filter((call) => call.command === 'storage.remove')).toHaveLength(2);
});

test('embedded RAW preview is labeled and raw EXIF is disclosed without duplicating main parameters', async ({
  page,
}) => {
  await fixture(page, (call) => {
    if (call.command === 'asset.get')
      return {
        ...photo,
        kind: 'raw',
        extension: 'nef',
        filename: 'Camera.nef',
        metadata: {
          Camera: 'Fixture camera',
          Lens: 'Fixture lens',
          ISO: '400',
          'Capture Time Zone': '+08:00',
          'Exposure Bias': '0 EV',
          'Exposure Program': 'Aperture priority',
          Flash: 'No flash',
          'White Balance': 'Auto',
          'EXIF Model': 'Fixture camera',
          'Preview Source': 'embedded_jpeg',
          'Preview Dimensions': '960 × 640',
          Decoder: '相机内嵌预览 · RAW 原始解码不可用',
          'Decode Status': 'RAW 原始解码不可用：完整底层诊断 '.repeat(20),
          Format: 'NEF',
        },
      };
    if (call.command === 'asset.preview')
      return { tier: 'p2560' as const, width: 1, height: 1, source: 'embedded_jpeg' };
    if (call.command === 'asset.histogram')
      return {
        red: Array(256).fill(1),
        green: Array(256).fill(1),
        blue: Array(256).fill(1),
        luminance: Array(256).fill(1),
        pixels: 256,
        source: 'embedded_jpeg',
      };
  });
  await servePreviewImages(page);
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toBeVisible();
  await expect(page.locator('.preview-source')).toHaveCount(0);
  await page.keyboard.press('i');
  await expect(page.locator('.histogram-source')).toHaveText('相机内嵌预览 · RAW 原始解码不可用');
  await expect(
    page.getByText('相机内嵌预览 · RAW 原始解码不可用', { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  await expect(page.locator('.viewer-filename strong')).toHaveCount(0);
  await expect(page.locator('.inspector-file')).toContainText('预览尺寸 960 × 640 px');
  await expect(
    page.getByText('Fixture camera', { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  const parameters = page.locator('.shooting-parameters');
  await expect(parameters).toContainText('Fixture lens');
  await expect(page.locator('.exposure-summary')).toContainText('400');
  for (const label of ['拍摄时区', '曝光补偿', '曝光程序', '闪光灯', '白平衡']) {
    await expect(parameters).toContainText(label);
  }
  for (const label of [
    '原始解码状态',
    '解析方式',
    '预览来源',
    '预览尺寸',
    '文件格式',
    '完整底层诊断',
  ]) {
    await expect(parameters).not.toContainText(label);
  }
  await expect(page.locator('.decode-diagnostics dl')).not.toBeVisible();
  await expect(page.locator('.exif-fields dl')).not.toBeVisible();
  await page.getByText('全部有效 EXIF 字段').click();
  await expect(page.locator('.exif-fields dl')).toContainText('Fixture camera');
  await page.getByText('解码诊断', { exact: true }).click();
  await expect(page.locator('.decode-diagnostics dl')).toContainText(
    'RAW 原始解码不可用：完整底层诊断 '.repeat(20),
  );
});

test('library management is the default, metadata is on demand, photos open in place and a window on request', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = await fixture(page);
  await expect(page.getByRole('button', { name: '打开图片库 NAS 旅行' })).toBeVisible();
  expect(calls.filter((call) => call.command === 'asset.list')).toHaveLength(0);
  await expect(page.getByText('D:\\Cache\\internal')).not.toBeVisible();
  await page.screenshot({ path: 'test-results/management-libraries.png' });
  await page.getByRole('button', { name: '打开图片库 本地摄影' }).click();
  const thumb = page.getByRole('button', { name: 'Mountain.png，0 星' });
  await expect(thumb).toBeVisible();
  expect(calls.filter((call) => call.command === 'asset.get')).toHaveLength(0);
  await thumb.press('Enter');
  // The library opens photos inside its own window; Escape returns to the tile.
  const viewer = page.getByRole('dialog', { name: '沉浸影像查看器' });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText('Mountain.png').first()).toBeVisible();
  expect(calls.filter((call) => call.command === '$native/open_viewer')).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(thumb).toBeFocused();
  // A separate window stays one menu item away, with the same scoped photo list.
  await thumb.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '在新窗口中打开' }).click();
  await expect
    .poll(() => calls.find((call) => call.command === '$native/open_viewer')?.params)
    .toEqual({ assetId: 'photo-a', assetIds: ['photo-a'] });
  await expect(page.locator('.manager-navigation')).toBeVisible();
  await nav(page, '图片库').click();
  await expect(
    page.locator('.nl-page-header:visible').getByRole('heading', { name: '本地摄影' }),
  ).toBeVisible();
  await servePreviewImages(page);
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toBeVisible();
  await expect(page.locator('.manager-navigation')).not.toBeVisible();
  await expect(page.getByRole('complementary', { name: '影像详情' })).not.toBeVisible();
  expect(calls.filter((call) => call.command === '$native/viewer_context')).toHaveLength(1);
  await page.keyboard.press('i');
  await expect(
    page.getByRole('complementary', { name: '影像详情' }).getByText('Fixture camera'),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: '当前图片 RGB 直方图' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a failed connection is reported, stored credentials can browse, and a directory becomes a library', async ({
  page,
}) => {
  const calls = await fixture(page, (call) => {
    if (call.command === 'storage.check')
      return {
        id: nas.id,
        connected: false,
        credential_status: 'system',
        checked_at: '',
        error: 'HTTP 401 Unauthorized',
      };
    if (call.command === 'storage.browse')
      return {
        entries: call.params.prefix
          ? [{ key: 'trips/Mountain.png', is_dir: false, size: 12000 }]
          : [{ key: 'trips/', is_dir: true, size: 0 }],
        next_cursor: null,
      };
  });
  await nav(page, '位置').click();
  await expect(page.getByText('已保存至系统安全存储')).toBeVisible();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('账号认证失败');
  await expect(page.getByRole('alert').locator('pre')).not.toBeVisible();
  await page.getByText('查看错误详情', { exact: true }).click();
  await expect(page.getByRole('alert').locator('pre')).toHaveText('HTTP 401 Unauthorized');
  await expect(page.getByText('连接失败', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '浏览目录', exact: true }).click();
  await page.getByRole('button', { name: 'trips', exact: true }).click();
  await expect(page.getByText('Mountain.png', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/management-storage.png' });
  await page.getByRole('button', { name: '从此目录建立图片库' }).click();
  await expect(page.getByLabel('源内目录（可选）')).toHaveValue('trips/');
  await page.getByLabel('图片库名称').fill('旅行归档');
  await page.getByRole('button', { name: '建立并扫描' }).click();
  await expect(page.getByRole('heading', { name: '旅行归档' })).toBeVisible();
  expect(calls.find((call) => call.command === 'library.add')?.params).toEqual({
    name: '旅行归档',
    storage_id: 'nas',
    prefix: 'trips/',
    pair_raw_jpeg: false,
  });
  await expect
    .poll(() =>
      calls.some(
        (call) => call.command === 'library.scan' && call.params.library_id === 'new-library',
      ),
    )
    .toBe(true);
  // After the scan the grid's tier is rendered in the background (210px at 1x is t256).
  await expect
    .poll(() => calls.find((call) => call.command === '$native/pregenerate_previews')?.params)
    .toEqual({ libraryId: 'new-library', tier: 't256' });
});

test('a failed browse revokes previous verification and refreshes missing credential state without losing its directory', async ({
  page,
}) => {
  let fail = false;
  await fixture(page, (call) => {
    if (call.command === 'storage.list' && fail)
      return [{ ...nas, connected: false, credential_status: 'missing' }];
    if (call.command === 'storage.browse') {
      if (fail) throw new Error('Credentials are missing; reconnect this storage');
      return {
        entries: call.params.prefix
          ? [{ key: 'trips/Mountain.png', is_dir: false, size: 12000 }]
          : [{ key: 'trips/', is_dir: true, size: 0 }],
        next_cursor: null,
      };
    }
  });
  await nav(page, '位置').click();
  await page.getByRole('button', { name: '浏览目录', exact: true }).click();
  await page.getByRole('button', { name: 'trips', exact: true }).click();
  await expect(page.locator('.source-row .source-status')).toHaveText('已验证');
  fail = true;
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(page.locator('.source-row .source-status')).toHaveText('连接失败');
  await expect(page.locator('.source-row .credential-status')).toHaveText('需要连接凭据');
  await expect(page.getByRole('alert')).toContainText('此连接没有可用的登录信息');
  await expect(page.locator('.directory-path code')).toHaveText('trips/');
  await expect(page.getByRole('button', { name: '打开连接设置', exact: true })).toBeEnabled();
});

test('a late failed-browse status refresh cannot overwrite a newer successful connection', async ({
  page,
}) => {
  let fail = false;
  let release!: (sources: StorageConfig[]) => void;
  const pending = new Promise<StorageConfig[]>((resolve) => {
    release = resolve;
  });
  const calls = await fixture(page, (call) => {
    if (call.command === 'storage.list' && fail) return pending;
    if (call.command === 'storage.browse') {
      if (fail) throw new Error('Credentials are missing; reconnect this storage');
      return { entries: [], next_cursor: null };
    }
  });
  await nav(page, '位置').click();
  await page.getByRole('button', { name: '浏览目录', exact: true }).click();
  await expect(page.locator('.source-row .source-status')).toHaveText('已验证');
  fail = true;
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect.poll(() => calls.filter((call) => call.command === 'storage.list').length).toBe(2);
  await expect(page.locator('.source-row .source-status')).toHaveText('连接失败');
  await page.getByRole('button', { name: '关闭目录浏览' }).click();
  fail = false;
  await page.getByRole('button', { name: '浏览目录', exact: true }).click();
  await expect(page.locator('.source-row .source-status')).toHaveText('已验证');
  const returned = page.waitForResponse(
    (response) =>
      response.url().includes('__management_rpc') &&
      response.request().postDataJSON()?.command === 'storage.list',
  );
  release([{ ...nas, connected: false, credential_status: 'unavailable' }]);
  await (await returned).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator('.source-row .source-status')).toHaveText('已验证');
  await expect(page.locator('.source-row .credential-status')).toHaveText('已保存至系统安全存储');
  await expect(page.getByRole('alert')).not.toBeVisible();
});

test('local libraries are created directly from a directory and become import targets without a local storage connection', async ({
  page,
}) => {
  const libraries: Library[] = [remote];
  const root = 'D:\\New Photos';
  const legacySource: StorageConfig = {
    id: 'legacy-local',
    kind: 'local',
    name: '旧本地来源',
    endpoint: 'D:\\Old Photos',
  };
  const calls = await fixture(page, (call) => {
    if (call.command === 'library.list') return libraries;
    if (call.command === 'storage.list') return [legacySource, nas];
    if (call.command === '$native/plugin:dialog|open') return root;
    if (call.command === 'library.add') {
      const library: Library = {
        id: 'direct-local',
        name: String(call.params.name),
        root: String(call.params.root),
        storage_id: null,
        source_kind: 'local',
        created_at: '2026-10-16',
        pair_raw_jpeg: Boolean(call.params.pair_raw_jpeg),
      };
      libraries.push(library);
      return library;
    }
    if (call.command === 'import.plan')
      return {
        id: 'direct-plan',
        source: call.params.source,
        destination: call.params.destination,
        items: [],
        duplicate_count: 0,
        total_bytes: 0,
        warnings: [],
      };
  });
  await page.getByRole('button', { name: '添加图片库', exact: true }).click();
  await expect(page.getByLabel('来源类型')).toHaveAttribute('data-value', 'local');
  await expect(page.getByLabel('存储源', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '建立并扫描', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '选择本地文件夹…', exact: true }).click();
  await expect(page.getByLabel('本地目录', { exact: true })).toHaveValue(root);
  await page.getByLabel('图片库名称').fill('直接本地库');
  await page.getByRole('button', { name: '建立并扫描', exact: true }).click();
  await expect(page.getByRole('heading', { name: '直接本地库', exact: true })).toBeVisible();
  expect(calls.find((call) => call.command === 'library.add')?.params).toEqual({
    name: '直接本地库',
    root,
    pair_raw_jpeg: false,
  });
  expect(calls.filter((call) => call.command === 'storage.add')).toHaveLength(0);
  await nav(page, '导入').click();
  // NAS libraries are import targets too; this test imports into the new local one.
  await page.getByLabel('目标图片库').click();
  const targetPopover = page.locator('.nl-select-popover[role="listbox"]');
  await expect(
    targetPopover.locator('[role="option"]').filter({ hasText: 'NAS 旅行' }),
  ).toHaveCount(1);
  await targetPopover.locator('[role="option"][data-value="direct-local"]').click();
  await page.getByRole('button', { name: /CAMERA CARD/ }).click();
  await page.getByRole('button', { name: '生成导入计划', exact: true }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'import.plan')?.params.destination)
    .toBe(root);
  await nav(page, '位置').click();
  await expect(page.locator('.source-row').filter({ hasText: '家庭 NAS' })).toHaveCount(1);
  await expect(page.locator('.source-row').filter({ hasText: '旧本地来源' })).toHaveCount(0);
  await page.getByRole('button', { name: '添加网络位置', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '本地文件夹', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'WebDAV', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'S3 兼容存储', exact: true }),
  ).toBeVisible();
});

test('legacy local library settings retain their binding until an explicitly reviewed directory change', async ({
  page,
}) => {
  let library: Library = { ...local };
  let picks = 0;
  const calls = await fixture(page, (call) => {
    if (call.command === 'library.list') return [library];
    if (call.command === 'storage.list')
      return [{ id: 'local', kind: 'local', name: '照片磁盘', endpoint: local.root }, nas];
    if (call.command === '$native/plugin:dialog|open')
      return ++picks === 1 ? 'E:\\Cancelled' : 'F:\\Replacement';
    if (call.command === 'library.update') {
      library = {
        ...library,
        ...call.params,
        storage_id: null,
        source_kind: 'local',
        source_prefix: '',
      } as Library;
      return library;
    }
  });
  await page.getByRole('button', { name: '本地摄影 更多操作' }).click();
  await page.getByRole('menuitem', { name: '本地摄影 图片库设置' }).click();
  await expect(page.getByLabel('来源类型')).toHaveAttribute('data-value', 'local');
  await expect(page.getByLabel('本地目录', { exact: true })).toHaveValue(local.root);
  await page.getByRole('button', { name: '选择本地文件夹…', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('旧索引、评级和裁剪配方');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(calls.filter((call) => call.command === 'library.update')).toHaveLength(0);
  await page.getByRole('button', { name: '本地摄影 更多操作' }).click();
  await page.getByRole('menuitem', { name: '本地摄影 图片库设置' }).click();
  await expect(page.getByLabel('本地目录', { exact: true })).toHaveValue(local.root);
  await page.getByRole('button', { name: '选择本地文件夹…', exact: true }).click();
  await page.getByRole('button', { name: '检查位置更改', exact: true }).click();
  expect(calls.filter((call) => call.command === 'library.update')).toHaveLength(0);
  await page.getByRole('button', { name: '确认更改位置并清空索引', exact: true }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'library.update')?.params)
    .toEqual({ id: local.id, name: local.name, pair_raw_jpeg: false, root: 'F:\\Replacement' });
  expect(calls.filter((call) => call.command === 'storage.add')).toHaveLength(0);
});

test('card imports target local libraries, retain review across navigation and consume backend indexing results', async ({
  page,
}) => {
  const result = {
    id: 'job1',
    plan_id: 'plan1',
    source: 'E:\\',
    destination: local.root,
    status: 'partial',
    copied: 1,
    duplicates: 0,
    failed: 1,
    total: 2,
    originals_retained: true,
    started_at: '2026-10-15',
    library_id: local.id,
    indexing: { indexed: 1, skipped: 0, errors: [] },
    items: [
      { source: 'E:\\a.png', destination: 'D:\\Photos\\a.png', size: 10, status: 'copied' },
      {
        source: 'E:\\b.png',
        destination: 'D:\\Photos\\b.png',
        size: 10,
        status: 'failed',
        error: 'Destination does not support hard links',
      },
    ],
  };
  let finished = false;
  const calls = await fixture(page, (call) => {
    if (call.command === 'import.plan')
      return {
        id: 'plan1',
        source: call.params.source,
        destination: call.params.destination,
        duplicate_count: 0,
        total_bytes: 20,
        warnings: ['没有拍摄日期，归入 unknown-date'],
        items: [
          { source: 'E:\\a.png', relative_path: 'unknown-date/a.png', size: 10, status: 'pending' },
        ],
      };
    if (call.command === 'import.execute') {
      finished = true;
      return result;
    }
    if (call.command === 'import.history') return finished ? [result] : [];
  });
  await nav(page, '导入').click();
  // Placeholder, the local library and the NAS library.
  await page.getByLabel('目标图片库').click();
  const importTargets = page.locator('.nl-select-popover[role="listbox"]');
  await expect(importTargets.locator('[role="option"]')).toHaveCount(3);
  await importTargets.locator(`[role="option"][data-value=${JSON.stringify(local.id)}]`).click();
  await page.getByRole('button', { name: /CAMERA CARD/ }).click();
  await page.getByRole('button', { name: '生成导入计划' }).click();
  await expect(page.getByText('待复制', { exact: true })).toBeVisible();
  await expect(page.getByText('没有拍摄日期，归入 unknown-date')).toBeVisible();
  await expect(page.getByRole('button', { name: '开始导入' })).toBeDisabled();
  await nav(page, '设置').click();
  await nav(page, '导入').click();
  await expect(page.getByText('待复制', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '我已核对来源、目标和导入计划' }).check();
  await page.getByRole('button', { name: '开始导入' }).click();
  await expect(page.getByText('图片库已更新。', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Destination does not support hard links', { exact: true }),
  ).toBeVisible();
  expect(calls.find((call) => call.command === 'import.execute')?.params).toEqual({
    plan_id: 'plan1',
    library_id: local.id,
  });
  expect(calls.filter((call) => call.command === 'library.scan')).toHaveLength(0);
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.locator('.import-history-item')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/management-import.png' });
  await page.getByRole('button', { name: '继续导入', exact: true }).click();
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.locator('.import-history-item')).toHaveCount(1);
  await expect(page.locator('.import-history-item')).toContainText('部分完成');
});

test('viewer holds navigation during an edit and explicitly refreshing the original invalidates image resources', async ({
  page,
}) => {
  let releaseRating!: (asset: Asset) => void;
  const pendingRating = new Promise<Asset>((resolve) => {
    releaseRating = resolve;
  });
  const calls = await fixture(page, (call) => {
    if (call.command === '$native/viewer_context')
      return { asset_id: photo.id, asset_ids: [photo.id, 'photo-b'] };
    if (call.command === 'asset.rate') return pendingRating;
    if (call.command === 'asset.get' && call.params.id === 'photo-b')
      return { ...photo, id: 'photo-b', filename: 'Second.png' };
    if (call.command === 'asset.refresh')
      return { ...photo, rating: 4, metadata: { Camera: 'Refreshed camera metadata' } };
  });
  await servePreviewImages(page);
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toBeVisible();
  await page.keyboard.press('i');
  await page.getByRole('button', { name: '评为 4 星' }).click();
  await expect.poll(() => calls.some((call) => call.command === 'asset.rate')).toBe(true);
  await page.keyboard.press('ArrowRight');
  expect(calls.some((call) => call.command === 'asset.get' && call.params.id === 'photo-b')).toBe(
    false,
  );
  releaseRating({ ...photo, rating: 4 });
  await expect(page.getByRole('button', { name: '评为 4 星' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const previewsBefore = calls.filter((call) => call.command === 'asset.preview').length;
  const histogramsBefore = calls.filter((call) => call.command === 'asset.histogram').length;
  await page.locator('.nl-viewer-bar').getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '重新读取原图' }).click();
  await expect(
    page.getByRole('complementary', { name: '影像详情' }).getByText('Refreshed camera metadata'),
  ).toBeVisible();
  await expect
    .poll(() => calls.filter((call) => call.command === 'asset.preview').length)
    .toBeGreaterThan(previewsBefore);
  await expect
    .poll(() => calls.filter((call) => call.command === 'asset.histogram').length)
    .toBeGreaterThan(histogramsBefore);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.inspector-heading h2')).toHaveText('Second.png');
  await expect
    .poll(() =>
      calls
        .filter((call) => call.command === '$native/plugin:window|set_title')
        .map((call) => call.params.value),
    )
    .toEqual(['Mountain.png — Lumen', 'Second.png — Lumen']);
  await expect(page).toHaveTitle('Second.png — Lumen');
});
test.describe('high-DPI grid', () => {
  test.use({ deviceScaleFactor: 2 });
  test('grid requests tier from slider and dpr', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('http://neb.localhost/')) requested.push(request.url());
    });
    await page.addInitScript(() => localStorage.setItem('nebulume.thumbnail-size', '320'));
    const calls = await fixture(page);
    await page.getByRole('button', { name: /打开图片库 本地摄影/ }).click();
    await expect(page.locator('.photo-grid .thumbnail img')).toHaveCount(1);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((url) => url.includes('%2Ft1024%2F'))).toBe(true);
    const before = requested.length;
    await page.getByLabel('缩略图大小').fill('150');
    await expect.poll(() => requested.slice(before).length).toBeGreaterThan(0);
    expect(requested.slice(before).every((url) => url.includes('%2Ft512%2F'))).toBe(true);
    await expect(page.locator('.photo-grid .thumbnail img')).toHaveAttribute('src', /t512/);
    expect(calls.filter((call) => call.command === 'asset.preview')).toEqual([]);
  });
});

test('an offline NAS library is greyed, explains why, keeps marks usable and blocks scanning', async ({
  page,
}) => {
  const calls = await fixture(page, (call) => {
    if (call.command === 'library.list')
      return [local, { ...remote, connected: false, availability: 'offline' }];
    return undefined;
  });
  const card = page.getByRole('button', { name: /打开图片库 NAS 旅行/ });
  await expect(card).toHaveAccessibleName('打开图片库 NAS 旅行，不可达');
  await expect(page.locator('.nav-library-item .nl-dot--bad')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /打开图片库 本地摄影/ })).toHaveAccessibleName(
    /未连接|在线/,
  );
  await card.click();
  const banner = page.locator('.availability-banner');
  await expect(banner).toContainText('不可达');
  await expect(banner).toContainText('评级与旗标仍可修改');
  await expect(page.getByRole('button', { name: '扫描更新' })).toBeDisabled();
  // Browsing the existing index still works while the location is offline.
  await expect(page.getByRole('button', { name: /Mountain\.png/ })).toBeVisible();
  expect(calls.some((call) => call.command === 'library.scan')).toBe(false);
  await banner.getByRole('button', { name: '检查连接' }).click();
  await expect(page.getByRole('heading', { name: '位置' })).toBeVisible();
});

test('a registered card applies its default preset, and import leads straight into culling the batch', async ({
  page,
}) => {
  const card = {
    id: '6f1c2a3b-0000-4000-8000-000000000001',
    name: 'Z8 主卡',
    location_id: 'loc-card',
    created_at: '2026-10-01',
    last_import_at: null,
    default_preset_id: null as string | null,
  };
  const preset = {
    id: 'preset-nas',
    name: 'NAS 归档',
    library_id: local.id,
    rules: {
      date_basis: 'capture',
      date_layout: 'Y/Y-M-D',
      type_split: 'by_kind',
      unknown_date: 'folder',
      subfolder: 'Z8',
    },
    deduplicate: true,
    created_at: '2026-10-01',
  };
  const batch = {
    id: 'batch-1',
    library_id: local.id,
    card_id: card.id,
    source: 'E:\\',
    started_at: '2026-10-23T08:00:00Z',
    status: 'completed',
    copied: 1,
    duplicates: 0,
    failed: 0,
    asset_count: 1,
  };
  let registered = false;
  const calls = await fixture(page, (call) => {
    switch (call.command) {
      case 'card.list':
        return registered ? [card] : [];
      case 'preset.list':
        return [preset];
      case 'card.identify':
        return registered ? { status: 'known', card } : { status: 'unknown', candidates: [] };
      case 'card.register':
        registered = true;
        return card;
      case 'card.update':
        card.default_preset_id = call.params.default_preset_id as string;
        return card;
      case 'import.plan':
        return {
          id: 'plan1',
          source: call.params.source,
          destination: call.params.destination,
          duplicate_count: 0,
          total_bytes: 10,
          warnings: [],
          items: [
            {
              source: 'E:\\a.NEF',
              relative_path: 'Z8/2026/2026-10-22/RAW/a.NEF',
              size: 10,
              status: 'pending',
              date_source: 'exif',
            },
          ],
        };
      case 'import.execute':
        return {
          id: 'batch-1',
          plan_id: 'plan1',
          source: 'E:\\',
          destination: local.root,
          status: 'completed',
          copied: 1,
          duplicates: 0,
          failed: 0,
          total: 1,
          originals_retained: true,
          started_at: '2026-10-23T08:00:00Z',
          library_id: local.id,
          indexing: { indexed: 1, skipped: 0, errors: [] },
          items: [],
          batch,
        };
      case 'import.history':
        return [];
      case 'import.batches':
        return [batch];
    }
    return undefined;
  });
  await nav(page, '导入').click();
  await page.getByRole('button', { name: /CAMERA CARD/ }).click();
  await expect(page.getByText('未登记的存储卡')).toBeVisible();
  await page.getByLabel('卡名称').fill('Z8 主卡');
  await page.getByRole('button', { name: '登记这张卡' }).click();
  await expect(page.locator('.card-identity')).toContainText('尚未从这张卡导入');
  expect(calls.find((call) => call.command === 'card.register')?.params).toMatchObject({
    mount_path: 'E:\\',
    name: 'Z8 主卡',
  });
  await selectChoice(page.getByLabel('导入方案'), preset.id);
  await expect(page.locator('.organize-example')).toContainText(
    'Z8/2026/2026-10-22/RAW/DSC_0001.NEF',
  );
  await selectChoice(page.getByLabel('导入方案'), { label: '设为这张卡的默认方案' });
  await expect
    .poll(() => calls.find((call) => call.command === 'card.update')?.params)
    .toEqual({ id: card.id, default_preset_id: preset.id });
  await page.getByRole('button', { name: '生成导入计划' }).click();
  expect(calls.find((call) => call.command === 'import.plan')?.params.rules).toMatchObject(
    preset.rules,
  );
  await page.getByRole('checkbox', { name: '我已核对来源、目标和导入计划' }).check();
  await page.getByRole('button', { name: '开始导入' }).click();
  expect(calls.find((call) => call.command === 'import.execute')?.params).toMatchObject({
    card_id: card.id,
  });
  await page.getByRole('button', { name: '开始选图（1 张）' }).click();
  await expect
    .poll(() => calls.find((call) => call.command === '$native/open_viewer')?.params)
    .toMatchObject({
      mode: 'cull',
      queue: { library_id: local.id, options: { import_batch_id: 'batch-1' } },
    });
  await expect(page.getByLabel('导入批次')).toHaveAttribute('data-value', 'batch-1');
});

test('a NAS import is planned by library id and blocked until the location passes a write test', async ({
  page,
}) => {
  let capability = 'unverified';
  const calls = await fixture(page, (call) => {
    if (call.command === 'storage.list') return [{ ...nas, write_capability: capability }];
    if (call.command === 'storage.write_check') {
      capability = 'verified';
      return { id: nas.id, write_capability: 'verified', checked_at: '2026-10-23' };
    }
    if (call.command === 'import.plan')
      return {
        id: 'nas-plan',
        source: call.params.source,
        destination: 'location:nas/trips',
        library_id: remote.id,
        write_capability: capability,
        duplicate_count: 0,
        likely_duplicate_count: 1,
        total_bytes: 10,
        warnings: [],
        items: [
          { source: 'E:\\a.NEF', relative_path: '2026-10-22/a.NEF', size: 10, status: 'pending' },
          {
            source: 'E:\\b.NEF',
            relative_path: '2026-10-22/b.NEF',
            size: 10,
            status: 'likely_duplicate',
          },
        ],
      };
    if (call.command === 'import.execute')
      return {
        id: 'job-nas',
        plan_id: 'nas-plan',
        source: 'E:\\',
        destination: 'location:nas/trips',
        status: 'completed',
        copied: 2,
        duplicates: 0,
        failed: 0,
        total: 2,
        originals_retained: true,
        started_at: '2026-10-23',
        library_id: remote.id,
        indexing: { indexed: 2, skipped: 0, errors: [] },
        items: [],
      };
    if (call.command === 'import.history') return [];
    return undefined;
  });
  await nav(page, '导入').click();
  await selectChoice(page.getByLabel('目标图片库'), remote.id);
  await page.getByRole('button', { name: /CAMERA CARD/ }).click();
  await page.getByRole('button', { name: '生成导入计划' }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'import.plan')?.params)
    .toMatchObject({ library_id: remote.id });
  expect(calls.find((call) => call.command === 'import.plan')?.params.destination).toBeUndefined();
  await expect(
    page.getByRole('table', { name: '导入文件' }).getByText('疑似重复', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/需要先在“位置”中对这个网络位置“测试写入”/)).toBeVisible();
  await page.getByRole('checkbox', { name: '我已核对来源、目标和导入计划' }).check();
  await expect(page.getByRole('button', { name: '开始导入' })).toBeDisabled();
  await page.getByRole('button', { name: '前往位置' }).click();
  await page.getByRole('button', { name: '测试写入' }).click();
  await expect(page.getByRole('button', { name: '可导入' })).toBeVisible();
  expect(calls.some((call) => call.command === 'storage.write_check')).toBe(true);
  await nav(page, '导入').click();
  await page.getByRole('button', { name: '返回修改' }).click();
  await selectChoice(page.getByLabel('目标图片库'), remote.id);
  await page.getByRole('button', { name: '生成导入计划' }).click();
  await page.getByRole('checkbox', { name: /仍然导入疑似重复项/ }).check();
  await page.getByRole('checkbox', { name: '我已核对来源、目标和导入计划' }).check();
  await page.getByRole('button', { name: '开始导入' }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'import.execute')?.params)
    .toMatchObject({ plan_id: 'nas-plan', library_id: remote.id, include_likely_duplicates: true });
});

test('library settings build content fingerprints, confirming before a NAS download', async ({
  page,
}) => {
  const calls = await fixture(page, (call) => {
    if (call.command === 'library.fingerprint.start')
      return {
        library_id: remote.id,
        total: 1,
        known: 0,
        pending: 1,
        pending_bytes: 12000,
        remote: true,
        job: {
          id: 'fp-1',
          status: 'completed',
          total: 1,
          processed: 1,
          hashed: 1,
          failed: 0,
          bytes_read: 12000,
        },
      };
    return undefined;
  });
  await page.getByRole('button', { name: 'NAS 旅行 更多操作' }).click();
  await page.getByRole('menuitem', { name: 'NAS 旅行 图片库设置' }).click();
  const control = page.getByRole('region', { name: '内容指纹' });
  await expect(control).toContainText('已建立 0 / 1');
  await control.getByRole('button', { name: '建立内容指纹' }).click();
  await expect(control).toContainText('需要完整下载 1 个文件');
  expect(calls.some((call) => call.command === 'library.fingerprint.start')).toBe(false);
  await control.getByRole('button', { name: '开始下载并建立' }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'library.fingerprint.start')?.params)
    .toEqual({ library_id: remote.id });
});

test('the library header has one entry per action', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: '打开图片库 本地摄影' }).click();
  const header = page.locator('.nl-page-header:visible');
  await expect(header.getByRole('heading', { name: '本地摄影' })).toBeVisible();
  await expect(header.getByRole('tab', { name: '选片' })).toBeVisible();
  await expect(header.getByRole('button', { name: '选图' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: /详情/ })).toHaveCount(0);
  await expect(header.getByRole('button', { name: '扫描更新' })).toBeVisible();
  await expect(page.getByRole('button', { name: '影像详情（I）' })).toHaveCount(1);
});

test('with no libraries the page offers to create one', async ({ page }) => {
  await fixture(page, (call) => (call.command === 'library.list' ? [] : undefined));
  await expect(page.getByRole('heading', { name: '还没有图片库' })).toBeVisible();
  await page.getByRole('button', { name: '新建图片库' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('the app opens the last library and the sidebar menu holds the library actions', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('nebulume.last-library', 'library-nas'));
  await fixture(page);
  await expect(
    page.locator('.nl-page-header:visible').getByRole('heading', { name: 'NAS 旅行' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '本地摄影 更多操作' }).click();
  const menu = page.getByRole('menu', { name: '本地摄影 更多操作' });
  for (const name of [
    '本地摄影 图片库设置',
    '扫描更新',
    '预生成缩略图',
    '补全拍摄时间…',
    '内容指纹…',
    '移除图片库 本地摄影',
  ])
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
});

test('an offline library keeps its sidebar row and disables scanning with the reason', async ({
  page,
}) => {
  await fixture(page, (call) =>
    call.command === 'library.list'
      ? [local, { ...remote, connected: false, availability: 'offline' }]
      : undefined,
  );
  const row = page.getByRole('button', { name: /打开图片库 NAS 旅行/ });
  await expect(row).toHaveAccessibleName('打开图片库 NAS 旅行，不可达');
  await page.getByRole('button', { name: 'NAS 旅行 更多操作' }).click();
  const scan = page.getByRole('menuitem', { name: '扫描更新' });
  await expect(scan).toBeDisabled();
  await expect(scan).toHaveAttribute('title', /当前无法连接/);
});

test('at 1024×700 the header view switch goes icon-only and nothing overlaps', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await fixture(page);
  await page.getByRole('button', { name: '打开图片库 本地摄影' }).click();
  const header = page.locator('.nl-page-header:visible');
  await expect(header.locator('.nl-seg')).toHaveClass(/nl-seg--compact/);
  const boxes = await header.evaluate((el) =>
    [...el.children].map((child) => child.getBoundingClientRect()).map((r) => [r.left, r.right]),
  );
  for (let i = 1; i < boxes.length; i++)
    expect(boxes[i][0]).toBeGreaterThanOrEqual(boxes[i - 1][1] - 0.5);
});

test('import shows one progress indicator and one primary action per step', async ({ page }) => {
  await fixture(page);
  await nav(page, '导入').click();
  const header = page.locator('.nl-page-header:visible');
  await expect(header.getByRole('heading', { name: '导入' })).toBeVisible();
  await expect(header.getByRole('list', { name: '导入步骤' })).toBeVisible();
  await expect(
    page.locator('.import-stepper, .import-card-index, .import-route-arrow'),
  ).toHaveCount(0);
  await expect(page.locator('.nl-btn--primary:visible')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '生成导入计划' })).toHaveClass(/nl-btn--primary/);
  // History moved into a drawer.
  await expect(page.getByRole('complementary', { name: '导入历史' })).toHaveCount(0);
  await header.getByRole('button', { name: '历史' }).click();
  await expect(page.getByRole('dialog', { name: '导入历史' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '导入历史' })).toHaveCount(0);
});

test('the setup aside summarises the route and shows where files will land', async ({ page }) => {
  await fixture(page);
  await nav(page, '导入').click();
  await selectChoice(page.getByLabel('目标图片库'), local.id);
  const aside = page.getByRole('complementary', { name: '将会导入' });
  await expect(aside).toContainText('本地摄影');
  await expect(aside).toContainText('按拍摄日期');
  await expect(aside.locator('.organize-example')).toContainText('DSC_0001.NEF');
});

test('an unverified network target keeps 开始导入 disabled and says why in the aside', async ({
  page,
}) => {
  await fixture(page, (call) => {
    if (call.command === 'import.plan')
      return {
        id: 'nas-plan',
        source: call.params.source,
        destination: '',
        duplicate_count: 0,
        total_bytes: 10,
        warnings: [],
        write_capability: 'unverified',
        items: [{ source: 'E:\\a.png', relative_path: 'a.png', size: 10, status: 'pending' }],
      };
    return undefined;
  });
  await nav(page, '导入').click();
  await selectChoice(page.getByLabel('目标图片库'), remote.id);
  await page.getByRole('button', { name: /CAMERA CARD/ }).click();
  await page.getByRole('button', { name: '生成导入计划' }).click();
  const aside = page.getByRole('complementary', { name: '导入计划摘要' });
  await expect(aside).toContainText('需要先');
  await page.getByRole('checkbox', { name: '我已核对来源、目标和导入计划' }).check();
  await expect(aside.getByRole('button', { name: '开始导入' })).toBeDisabled();
});

test('settings sections switch with a segmented control and keep their content', async ({
  page,
}) => {
  await fixture(page);
  await nav(page, '设置').click();
  const header = page.locator('.nl-page-header:visible');
  await expect(header.getByRole('heading', { name: '设置' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '设置分区' })).toHaveCount(0);
  await header.getByRole('tab', { name: '快捷键' }).click();
  await expect(page.getByRole('table', { name: '查看窗口' })).toContainText('显示或隐藏叠加信息');
  await expect(page.getByRole('table', { name: '选图模式' })).toContainText('显示或隐藏叠加信息');
  await header.getByRole('tab', { name: '外观与浏览' }).click();
  await page.getByRole('switch', { name: '叠加信息随工具栏淡出' }).click();
  expect(await page.evaluate(() => localStorage.getItem('nebulume.viewer.overlay-fades'))).toBe(
    'true',
  );
  await expect(page.getByRole('switch', { name: '打标后自动下一张' })).toBeChecked();
});

test('choosing a menu action returns focus to the button that opened the menu', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '打开图片库 本地摄影' }).click();
  const more = page.locator('.nl-page-header:visible').getByRole('button', { name: '更多' });
  await more.click();
  await page.getByRole('menuitem', { name: '补全拍摄时间…' }).click();
  await expect(more).toBeFocused();
});

test('arrow keys move across the view switch without starting culling', async ({ page }) => {
  const calls = await fixture(page);
  await page.getByRole('button', { name: '打开图片库 本地摄影' }).click();
  await expect(page.getByRole('button', { name: 'Mountain.png，0 星' })).toBeVisible();
  const views = page.locator('.nl-page-header:visible').getByRole('tablist', { name: '视图' });
  await views.getByRole('tab', { name: '照片' }).focus();
  // 选片 is an action, not a view: the arrow skips it and lands on 概览.
  await page.keyboard.press('ArrowRight');
  await expect(views.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog', { name: '沉浸影像查看器' })).toHaveCount(0);
  expect(calls.some((call) => call.command === '$native/open_viewer')).toBe(false);
});

test('the rail marks 图片库 while a library is open, without scrollbars, and its tips are not clipped', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '打开图片库 本地摄影' }).click();
  const rail = page.getByRole('navigation', { name: '主导航' });
  await expect(rail.getByRole('button', { name: '图片库', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const box = await rail.evaluate((el) => ({
    overflowX: el.scrollWidth > el.clientWidth,
    overflow: getComputedStyle(el).overflow,
  }));
  expect(box.overflowX).toBe(false);
  expect(box.overflow).toBe('visible');
  // A tip to the right of a rail item draws over the sidebar: the rail stacks above it
  // and does not clip its children.
  const stacking = await page.evaluate(() => {
    const rail = document.querySelector('.nl-rail')!;
    const side = document.querySelector('.library-sidebar')!;
    const z = (el: Element) => Number(getComputedStyle(el).zIndex) || 0;
    return { above: z(rail) > z(side), clip: getComputedStyle(rail).overflowX };
  });
  expect(stacking).toEqual({ above: true, clip: 'visible' });
  const settings = rail.getByRole('button', { name: '设置', exact: true });
  await settings.hover();
  const floatingTip = page.locator('body > .nl-floating-tooltip[data-open="true"]');
  await expect(floatingTip).toBeVisible();
  await expect(floatingTip).toContainText('设置');
  const tipLayer = await floatingTip.evaluate((el) => ({
    position: getComputedStyle(el).position,
    zIndex: Number(getComputedStyle(el).zIndex) || 0,
  }));
  expect(tipLayer.position).toBe('fixed');
  expect(tipLayer.zIndex).toBeGreaterThanOrEqual(900);
});

test('the library sidebar can be widened by dragging its edge, and the width is remembered', async ({
  page,
}) => {
  await fixture(page, (call) =>
    call.command === 'library.folders'
      ? {
          library_id: 'library-local',
          total: 3,
          folders: [
            {
              path: 'Photos Library.photoslibrary',
              name: 'Photos Library.photoslibrary',
              count: 3,
              children: [],
            },
          ],
        }
      : undefined,
  );
  await page.getByRole('button', { name: '打开图片库 本地摄影' }).click();
  const sidebar = page.getByRole('complementary', { name: '图片库与文件夹' });
  const handle = page.getByRole('separator', { name: '拖动调整侧栏' });
  await expect(handle).toBeVisible();
  const before = (await sidebar.boundingBox())!.width;
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x + 120, grip.y + 200, { steps: 6 });
  await page.mouse.up();
  const after = (await sidebar.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 100);
  await expect(
    page.locator('.tree-name', { hasText: 'Photos Library.photoslibrary' }),
  ).toHaveJSProperty(
    'scrollWidth',
    await page
      .locator('.tree-name', { hasText: 'Photos Library.photoslibrary' })
      .evaluate((el) => el.clientWidth),
  );
  // Keyboard: arrows resize too.
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  expect((await sidebar.boundingBox())!.width).toBeLessThan(after);
  await page.reload();
  await expect(page.getByRole('complementary', { name: '图片库与文件夹' })).toBeVisible();
  expect(
    (await page.getByRole('complementary', { name: '图片库与文件夹' }).boundingBox())!.width,
  ).toBeGreaterThan(before + 80);
});

test('the header view switch stays centred whatever the title and subtitle are', async ({
  page,
}) => {
  await fixture(page, (call) =>
    call.command === 'library.list'
      ? [
          { ...local, name: '短' },
          { ...remote, name: '一个名字非常非常长的图片库，用来撑开标题区域' },
        ]
      : undefined,
  );
  const centre = async () => {
    const header = (await page.locator('.nl-page-header:visible').boundingBox())!;
    const views = (await page.locator('.nl-page-header:visible .nl-seg').boundingBox())!;
    return { offset: views.x + views.width / 2 - (header.x + header.width / 2), x: views.x };
  };
  await page.getByRole('button', { name: /打开图片库 短/ }).click();
  await expect(
    page.locator('.nl-page-header:visible').getByRole('heading', { name: '短' }),
  ).toBeVisible();
  const short = await centre();
  await page.getByRole('button', { name: /打开图片库 一个名字非常非常长/ }).click();
  await expect(page.locator('.nl-page-header:visible h1')).toContainText('一个名字');
  const long = await centre();
  expect(Math.abs(short.offset)).toBeLessThan(1);
  expect(Math.abs(long.x - short.x)).toBeLessThan(1);
});

test('全部图片库 at the foot of the sidebar opens a card overview of every library', async ({
  page,
}) => {
  await fixture(page, (call) =>
    call.command === 'library.list'
      ? [
          { ...local, asset_count: 1284, latest_capture: '2026-11-09' },
          { ...remote, asset_count: 9120, availability: 'auth_required' },
        ]
      : undefined,
  );
  const sidebar = page.getByRole('complementary', { name: '图片库与文件夹' });
  const all = sidebar.getByRole('button', { name: '全部图片库' });
  await all.click();
  await expect(all).toHaveAttribute('aria-current', 'page');
  const overview = page.getByRole('region', { name: '全部图片库' });
  await expect(
    page.locator('.nl-page-header:visible').getByRole('heading', { name: '全部图片库' }),
  ).toBeVisible();
  const cards = overview.getByRole('listitem');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('本地摄影');
  await expect(cards.nth(0)).toContainText('1,284 张');
  await expect(cards.nth(0)).toContainText('最近拍摄 11月9日');
  await expect(cards.nth(1)).toContainText('需要登录');
  // Each card opens its library; the header creates one; each card has the library menu.
  await expect(
    page.locator('.nl-page-header:visible').getByRole('button', { name: '新建图片库' }),
  ).toBeVisible();
  await expect(cards.nth(1).getByRole('button', { name: 'NAS 旅行 更多操作' })).toBeVisible();
  await cards
    .nth(0)
    .getByRole('button', { name: /打开 本地摄影/ })
    .click();
  await expect(
    page.locator('.nl-page-header:visible').getByRole('heading', { name: '本地摄影' }),
  ).toBeVisible();
  await expect(all).not.toHaveAttribute('aria-current', 'page');
});

test('the library rail item opens the last library, not the overview', async ({ page }) => {
  await fixture(page);
  await page
    .getByRole('complementary', { name: '图片库与文件夹' })
    .getByRole('button', { name: '全部图片库' })
    .click();
  await expect(page.getByRole('region', { name: '全部图片库' })).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '图片库', exact: true })
    .click();
  await expect(
    page.locator('.nl-page-header:visible').getByRole('heading', { name: '本地摄影' }),
  ).toBeVisible();
});

test('sidebar overflow menu floats in body portal without clipping or scrolling sidebar, and subnav sections collapse', async ({
  page,
}) => {
  await fixture(page, (call) => {
    if (call.command === 'collection.list')
      return [
        {
          id: 'coll-1',
          library_id: local.id,
          name: '年度精选',
          kind: 'manual',
          item_count: 12,
          created_at: '2026-11-01',
        },
      ];
    if (call.command === 'library.folders')
      return {
        library_id: local.id,
        total: 10,
        folders: [{ path: '2026-11', name: '2026-11', count: 10, children: [] }],
      };
  });

  const sidebar = page.getByRole('complementary', { name: '图片库与文件夹' });
  const list = sidebar.locator('.nav-library-list');

  // Open the library-level '...' overflow menu.
  await sidebar.getByRole('button', { name: '本地摄影 更多操作' }).click();
  const menu = page.getByRole('menu', { name: '本地摄影 更多操作' });
  await expect(menu).toBeVisible();

  // Verify the menu is portaled to document.body (outside .library-sidebar), fixed-positioned,
  // and never scrolls .nav-library-list horizontally.
  const layout = await page.evaluate(() => {
    const sidebarEl = document.querySelector('.library-sidebar')!;
    const listEl = document.querySelector('.nav-library-list') as HTMLElement;
    const menuEl = document.querySelector('[role="menu"][aria-label="本地摄影 更多操作"]') as HTMLElement;
    const style = window.getComputedStyle(menuEl);
    const rect = menuEl.getBoundingClientRect();
    return {
      insideSidebar: sidebarEl.contains(menuEl),
      position: style.position,
      zIndex: Number(style.zIndex),
      listScrollLeft: listEl.scrollLeft,
      sidebarScrollLeft: sidebarEl.scrollLeft,
      rectRight: rect.right,
      sidebarRight: sidebarEl.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.insideSidebar).toBe(false);
  expect(layout.position).toBe('fixed');
  expect(layout.zIndex).toBeGreaterThanOrEqual(200);
  expect(layout.listScrollLeft).toBe(0);
  expect(layout.sidebarScrollLeft).toBe(0);
  expect(layout.rectRight).toBeLessThanOrEqual(layout.viewportWidth - 8);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Collapsible 精选集 and 文件夹 sections.
  await expect(sidebar.getByText('年度精选')).toBeVisible();
  await expect(sidebar.getByText('2026-11')).toBeVisible();

  await sidebar.getByRole('button', { name: '收起精选集' }).click();
  await expect(sidebar.getByText('年度精选')).toHaveCount(0);
  await sidebar.getByRole('button', { name: '收起文件夹' }).click();
  await expect(sidebar.getByText('2026-11')).toHaveCount(0);

  await sidebar.getByRole('button', { name: '展开精选集' }).click();
  await expect(sidebar.getByText('年度精选')).toBeVisible();
  await sidebar.getByRole('button', { name: '展开文件夹' }).click();
  await expect(sidebar.getByText('2026-11')).toBeVisible();
});

test('startup auto-probes remote connections, empty library scan shows loading state, and TaskPill renders accurate progress bar', async ({
  page,
}) => {
  let releaseScan!: (res: { indexed: number; skipped: number; errors: never[] }) => void;
  const emptyLocal: Library = { ...local, id: 'lib-empty', name: '新图库', asset_count: 0 };
  let indexedItems: Asset[] = [];

  const calls = await fixture(page, (call) => {
    if (call.command === 'library.list') return [emptyLocal, remote];
    if (call.command === 'asset.list')
      return {
        items: call.params.library_id === emptyLocal.id ? indexedItems : [photo],
        total: call.params.library_id === emptyLocal.id ? indexedItems.length : 1,
      };
    if (call.command === 'library.scan')
      return new Promise((resolve) => {
        releaseScan = resolve;
      });
  });

  // 1. Startup auto-probe checks 'nas' automatically without opening Locations, turning NAS library dot green.
  await expect
    .poll(() => calls.some((c) => c.command === 'storage.check' && c.params.id === nas.id))
    .toBe(true);
  await expect(page.getByRole('button', { name: /打开图片库 NAS 旅行/ })).toHaveAccessibleName(
    '打开图片库 NAS 旅行，在线',
  );

  // 2. Scanning an empty library shows the indexing loading state in both header + center empty view + portaled TaskPill progress.
  await expect(page.getByRole('heading', { name: '图片库尚无照片' })).toBeVisible();
  await page.getByRole('button', { name: '扫描图片库' }).click();
  await expect(page.getByRole('heading', { name: '正在扫描图片库…' })).toBeVisible();
  await expect(page.getByRole('button', { name: '正在扫描…' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: '正在扫描…' }).first()).toBeDisabled();

  // Open TaskPill popover while scan is running -> rendered in Portal (position: fixed) with indeterminate progressbar.
  await page.getByRole('button', { name: /后台任务：扫描 新图库/ }).click();
  const taskDialog = page.getByRole('dialog', { name: '后台任务列表' });
  await expect(taskDialog.getByRole('progressbar')).toBeVisible();
  const taskPopoverLayout = await taskDialog.evaluate((el) => ({
    inHeader: !!el.closest('.nl-page-header'),
    position: getComputedStyle(el).position,
  }));
  expect(taskPopoverLayout).toEqual({ inHeader: false, position: 'fixed' });
  await page.keyboard.press('Escape');

  indexedItems = [{ ...photo, library_id: emptyLocal.id }];
  releaseScan({ indexed: 1, skipped: 0, errors: [] });
  await expect(page.getByRole('button', { name: /Mountain\.png/ })).toBeVisible();
});

test('active library subtree folds and unfolds via double-click or chevron while keeping active highlight', async ({
  page,
}) => {
  await fixture(page, (call) => {
    if (call.command === 'collection.list')
      return [
        {
          id: 'coll-1',
          library_id: local.id,
          name: '年度精选',
          kind: 'manual',
          item_count: 8,
          created_at: '2026-11-01',
        },
      ];
    if (call.command === 'library.folders')
      return {
        library_id: local.id,
        total: 10,
        folders: [{ path: '2026-11', name: '2026-11', count: 10, children: [] }],
      };
  });

  const sidebar = page.getByRole('complementary', { name: '图片库与文件夹' });
  const libButton = sidebar.getByRole('button', { name: /打开图片库 本地摄影/ });
  await expect(libButton).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar.getByText('年度精选')).toBeVisible();
  await expect(sidebar.getByText('2026-11')).toBeVisible();

  // Double-click folds the active library's entire subnav while keeping the row active.
  await libButton.dblclick();
  await expect(libButton).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.locator('.library-subnav')).toHaveCount(0);
  await expect(sidebar.locator('.nav-library-row.active')).toContainText('本地摄影');

  // Chevron click unfolds, then folds again; double-click unfolds again.
  await sidebar.getByRole('button', { name: '展开 本地摄影 目录树' }).click();
  await expect(libButton).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar.getByText('年度精选')).toBeVisible();
  await expect(sidebar.getByText('2026-11')).toBeVisible();

  await sidebar.getByRole('button', { name: '折叠 本地摄影 目录树' }).click();
  await expect(sidebar.locator('.library-subnav')).toHaveCount(0);

  await libButton.dblclick();
  await expect(sidebar.getByText('2026-11')).toBeVisible();
});

test('导出原片 prompts RAW / JPEG / RAW+JPEG choice when paired variants exist and exports untouched files', async ({
  page,
}) => {
  const rawVariant = {
    id: 'paired-raw',
    filename: 'Mountain.nef',
    extension: 'nef',
    kind: 'raw' as const,
  };
  const jpgVariant = {
    id: photo.id,
    filename: 'Mountain.jpg',
    extension: 'jpg',
    kind: 'raster' as const,
  };
  const pairedAsset: Asset = {
    ...photo,
    filename: 'Mountain.jpg',
    extension: 'jpg',
    variants: [rawVariant, jpgVariant],
  };
  const calls = await fixture(page, (call) => {
    if (call.command === 'library.list') return [{ ...local, pair_raw_jpeg: true }];
    if (call.command === 'asset.list')
      return { items: [pairedAsset], total: 1, file_total: 2 };
    if (call.command === 'asset.get') return pairedAsset;
    if (call.command === '$native/plugin:dialog|open') return 'D:\\Exports';
    if (call.command === 'asset.export_original')
      return { path: call.params.destination, bytes: 12000 };
  });

  await page.getByRole('button', { name: /打开图片库 本地摄影/ }).click();
  const tile = page.getByRole('button', { name: 'Mountain.jpg，0 星' });
  await expect(tile).toBeVisible();

  // Right-click -> 导出原片… opens OriginalExportDialog because Mountain has RAW + JPEG variants.
  await tile.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '导出原片…' }).click();
  const dialog = page.getByRole('dialog', { name: '导出原片' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: '仅 RAW（1）' }).click();
  await dialog.getByRole('button', { name: '导出 1 个原片…' }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      calls
        .filter((call) => call.command === 'asset.export_original')
        .map((call) => ({ id: call.params.id, destination: call.params.destination })),
    )
    .toEqual([{ id: 'paired-raw', destination: 'D:\\Exports\\Mountain.nef' }]);

  // Re-open and choose RAW + JPEG（2） -> copies both files byte-for-byte.
  await tile.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '导出原片…' }).click();
  const dialogBoth = page.getByRole('dialog', { name: '导出原片' });
  await dialogBoth.getByRole('tab', { name: 'RAW + JPEG（2）' }).click();
  await dialogBoth.getByRole('button', { name: '导出 2 个原片…' }).click();
  await expect(dialogBoth).toHaveCount(0);
  await expect
    .poll(() =>
      calls
        .filter((call) => call.command === 'asset.export_original')
        .slice(1)
        .map((call) => ({ id: call.params.id, destination: call.params.destination })),
    )
    .toEqual([
      { id: 'paired-raw', destination: 'D:\\Exports\\Mountain.nef' },
      { id: photo.id, destination: 'D:\\Exports\\Mountain.jpg' },
    ]);
});

test('hovering the sidebar overflow button renders a top-layer portal tooltip without sidebar clipping', async ({
  page,
}) => {
  await fixture(page);
  const sidebar = page.locator('.library-sidebar');
  const moreBtn = sidebar.getByRole('button', { name: '本地摄影 更多操作' });
  await expect(moreBtn).toBeVisible();

  await moreBtn.hover();
  const floatingTip = page.locator('body > .nl-floating-tooltip[data-open="true"]');
  await expect(floatingTip).toBeVisible();
  await expect(floatingTip).toHaveText('本地摄影 更多操作');

  const sidebarBox = await sidebar.boundingBox();
  const tipBox = await floatingTip.boundingBox();
  expect(sidebarBox).not.toBeNull();
  expect(tipBox).not.toBeNull();
  // The '...' button is at the right edge of .library-sidebar, so the centered tooltip naturally
  // extends past sidebarBox.right into the main workspace without being clipped by sidebar overflow.
  expect(tipBox!.x + tipBox!.width).toBeGreaterThan(sidebarBox!.x + sidebarBox!.width);
  expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(1280);

  // Opening the menu suppresses and dismisses the tooltip immediately so the two never overlap.
  await moreBtn.click();
  await expect(page.getByRole('menu', { name: '本地摄影 更多操作' })).toBeVisible();
  await expect(floatingTip).toHaveCount(0);
});
