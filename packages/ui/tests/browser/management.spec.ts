import { expect, test, type Page } from '@playwright/test';
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
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';

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
          case 'system.info':
            result = { originals_read_only: true };
            break;
          case 'asset.list':
            result = { items: [{ ...photo, library_id: call.params.library_id }], total: 1 };
            break;
          case 'asset.get':
            result = photo;
            break;
          case 'asset.preview':
            result = { data_url: image, width: 1, height: 1, source: 'test fixture' };
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
          case '$native/plugin:window|set_title':
            result = null;
            break;
          case 'import.history':
            result = [];
            break;
          case 'library.scan':
            result = { indexed: 1, skipped: 0, errors: [] };
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
  await page.goto('/');
  return calls;
}
const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true });

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
      return { data_url: image, width: 1, height: 1, source: 'embedded_jpeg' };
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
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toBeVisible();
  await expect(page.locator('.preview-source')).toHaveText('相机内嵌预览 · RAW 原始解码不可用');
  await page.keyboard.press('i');
  await expect(page.locator('.histogram-source')).toHaveText('相机内嵌预览 · RAW 原始解码不可用');
  await expect(page.locator('.inspector-file')).toContainText('预览尺寸 960 × 640 px');
  await expect(
    page.getByText('Fixture camera', { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  const parameters = page.locator('.shooting-parameters');
  await expect(parameters).toContainText('Fixture lens');
  await expect(parameters).toContainText('400');
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

test('library management is the default, metadata is on demand and native viewing uses scoped context', async ({
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
  await expect
    .poll(() => calls.find((call) => call.command === '$native/open_viewer')?.params)
    .toEqual({ assetId: 'photo-a', assetIds: ['photo-a'] });
  await expect(page.locator('.manager-navigation')).toBeVisible();
  await expect(page.locator('.immersive-viewer')).not.toBeVisible();
  await page.locator('.breadcrumb-button').click();
  await expect(page.getByRole('region', { name: '图片库管理' })).toBeVisible();
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toBeVisible();
  await expect(page.locator('.manager-navigation')).not.toBeVisible();
  await expect(page.getByRole('complementary', { name: '影像详情' })).not.toBeVisible();
  expect(calls.filter((call) => call.command === '$native/viewer_context')).toHaveLength(1);
  await page.keyboard.press('i');
  await expect(page.getByText('Fixture camera')).toBeVisible();
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
  await nav(page, '存储源').click();
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
  });
  await expect
    .poll(() =>
      calls.some(
        (call) => call.command === 'library.scan' && call.params.library_id === 'new-library',
      ),
    )
    .toBe(true);
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
  await nav(page, '存储源').click();
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
  await nav(page, '存储源').click();
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
  await nav(page, '存储卡').click();
  await expect(page.getByLabel('目标图片库').locator('option')).toHaveCount(2);
  await expect(page.getByLabel('目标图片库').locator('option', { hasText: 'NAS' })).toHaveCount(0);
  await page.getByRole('button', { name: /CAMERA CARD/ }).click();
  await page.getByRole('button', { name: '生成导入计划' }).click();
  await expect(page.getByText('待复制', { exact: true })).toBeVisible();
  await expect(page.getByText('没有拍摄日期，归入 unknown-date')).toBeVisible();
  await expect(page.getByRole('button', { name: '开始安全导入' })).toBeDisabled();
  await nav(page, '设置').click();
  await nav(page, '存储卡').click();
  await expect(page.getByText('待复制', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '我已核对来源、目标和导入计划' }).check();
  await page.getByRole('button', { name: '开始安全导入' }).click();
  await expect(page.getByText('目标图片库已更新：索引 1 项，跳过 0 项。')).toBeVisible();
  await expect(
    page.getByText('Destination does not support hard links', { exact: true }),
  ).toBeVisible();
  expect(calls.find((call) => call.command === 'import.execute')?.params).toEqual({
    plan_id: 'plan1',
    library_id: local.id,
  });
  expect(calls.filter((call) => call.command === 'library.scan')).toHaveLength(0);
  await page.screenshot({ path: 'test-results/management-import.png' });
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
  await page.getByRole('button', { name: '重新读取原图', exact: true }).first().click();
  await expect(page.getByText('Refreshed camera metadata')).toBeVisible();
  await expect
    .poll(() => calls.filter((call) => call.command === 'asset.preview').length)
    .toBeGreaterThan(previewsBefore);
  await expect
    .poll(() => calls.filter((call) => call.command === 'asset.histogram').length)
    .toBeGreaterThan(histogramsBefore);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.viewer-filename strong')).toHaveText('Second.png');
  await expect
    .poll(() =>
      calls
        .filter((call) => call.command === '$native/plugin:window|set_title')
        .map((call) => call.params.value),
    )
    .toEqual(['Mountain.png — Nebulume', 'Second.png — Nebulume']);
  await expect(page).toHaveTitle('Second.png — Nebulume');
});
