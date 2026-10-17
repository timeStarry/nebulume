import { expect, test, type Page } from '@playwright/test';
import type { Asset } from '../../src/model';

async function openInspector(
  page: Page,
  metadata: Record<string, string>,
  options: {
    asset?: Partial<Asset>;
    histogramAsset?: Partial<Asset>;
    source?: string;
    management?: boolean;
  } = {},
) {
  let asset: Asset = {
    id: 'inspector-fixture',
    library_id: 'fixture-library',
    filename: 'Exposure-fixture.jpg',
    path: '/fixture/Exposure-fixture.jpg',
    extension: 'jpg',
    kind: 'raster',
    size: 12000,
    width: 960,
    height: 640,
    rating: 0,
    metadata,
    availability: 'available',
    modified_at: '2026-10-15T10:00:00Z',
    ...options.asset,
  };
  const calls: string[] = [];
  let refreshed = false;
  await page.route('**/__inspector_rpc', async (route) => {
    const { command } = route.request().postDataJSON() as { command: string };
    calls.push(command);
    let result: unknown;
    switch (command) {
      case 'viewer_context':
        result = { asset_id: asset.id, asset_ids: [asset.id] };
        break;
      case 'asset.get':
        result = asset;
        break;
      case 'library.list':
        result = [
          {
            id: asset.library_id,
            name: '远端测试相册',
            root: '/Photos',
            created_at: '2026-10-16',
            source_kind: 'webdav',
            connected: true,
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
        result = { items: [asset], total: 1 };
        break;
      case 'library.capture_index.status':
        result = {
          library_id: asset.library_id,
          total: 1,
          known: 1,
          missing: 0,
          pending: 0,
          job: null,
        };
        break;
      case 'asset.refresh':
        refreshed = true;
        asset = {
          ...asset,
          cache_update_available: false,
          width: 3000,
          height: 2000,
          size: 24000,
          metadata: { Camera: 'Updated remote camera' },
          rating: 4,
        };
        result = asset;
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
        result = {
          data_url:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
          width: 1,
          height: 1,
          source: options.source || 'test fixture',
        };
        break;
      case 'asset.histogram':
        result = {
          red: Array(256).fill(1),
          green: Array(256).fill(1),
          blue: Array(256).fill(1),
          luminance: Array(256).fill(1),
          pixels: 256,
          source: options.source || 'test fixture',
          ...(options.histogramAsset
            ? { asset: refreshed ? asset : { ...asset, ...options.histogramAsset } }
            : {}),
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
        throw new Error(`Unexpected inspector fixture command: ${command}`);
    }
    await route.fulfill({ json: result });
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
          return (
            await fetch('/__inspector_rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(command === 'execute' ? params : { command }),
            })
          ).json();
        },
      },
    });
  });
  await page.goto(options.management ? '/' : '/?viewer=1');
  if (options.management) {
    await page
      .getByRole('button', { name: /远端测试相册/ })
      .first()
      .click();
    await page.getByRole('button', { name: '影像详情（I）', exact: true }).click();
  } else {
    await expect(page.locator('.main-photo')).toBeVisible();
    await page.keyboard.press('i');
  }
  await expect(page.getByRole('img', { name: '当前图片 RGB 直方图' })).toBeVisible();
  return calls;
}

test('exposure appears in three compact columns below the histogram without repeating in capture details', async ({
  page,
}) => {
  await openInspector(page, {
    Aperture: 'f/5.6',
    Exposure: '1/8000 s',
    ISO: '400',
    Camera: 'Fixture camera',
    Lens: 'Fixture lens',
    'Focal Length': '50 mm',
    'EXIF ExposureTime': '1/8000 s',
    Decoder: 'Test decoder',
  });
  const summary = page.getByRole('definition').filter({ hasText: /^f\/5\.6$/ });
  await expect(summary).toBeVisible();
  await expect(page.locator('.exposure-summary dd')).toHaveText(['f/5.6', '1/8000 s', '400']);
  const capture = page.locator('.shooting-parameters');
  await expect(capture).toContainText('设备');
  await expect(capture).toContainText('拍摄');
  await expect(capture).not.toContainText('1/8000 s');
  await expect(capture).not.toContainText('400');
  const graph = await page.locator('.histogram').boundingBox();
  const boxes = await page.locator('.exposure-summary > div').evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        overflows: element.scrollWidth > element.clientWidth,
      };
    }),
  );
  expect(boxes).toHaveLength(3);
  expect(boxes.every((box) => box.y === boxes[0].y && !box.overflows)).toBe(true);
  expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
  expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
  expect(boxes[0].y - (graph!.y + graph!.height)).toBeGreaterThanOrEqual(0);
  expect(boxes[0].y - (graph!.y + graph!.height)).toBeLessThan(35);
  await expect(page.locator('.exif-fields dl')).not.toBeVisible();
  await expect(page.locator('.decode-diagnostics dl')).not.toBeVisible();
  await page.getByText('全部有效 EXIF 字段', { exact: true }).click();
  await expect(page.locator('.exif-fields dl')).toContainText('1/8000 s');
});

test('files without exposure metadata keep all three explicit missing values', async ({ page }) => {
  await openInspector(page, { Format: 'JPEG' });
  await expect(page.locator('.exposure-summary dd')).toHaveText(['—', '—', '—']);
  for (const field of ['光圈', '快门', 'ISO']) {
    await expect(page.getByLabel(`${field}未记录`, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('此文件未提供可读取的 EXIF 信息。')).toBeVisible();
  await page.getByText('解码诊断', { exact: true }).click();
  await expect(page.locator('.decode-diagnostics dl')).toContainText('JPEG');
});

test('cold remote inspector uses histogram snapshot and explicitly updates its offline version', async ({
  page,
}) => {
  const calls = await openInspector(
    page,
    {},
    {
      management: true,
      source: 'remote_embedded_jpeg',
      asset: {
        filename: 'Remote.NEF',
        extension: 'nef',
        kind: 'raw',
        path: '/logical/Remote.NEF',
        source_key: 'Trip/Remote.NEF',
        width: undefined,
        height: undefined,
        cache_pinned: true,
        cache_update_available: true,
        rating: 4,
        crop: { x: 0, y: 0, width: 0.5, height: 1 },
      },
      histogramAsset: {
        width: 6000,
        height: 4000,
        size: 22000000,
        metadata: {
          Camera: 'Offline snapshot camera',
          Aperture: 'f/4',
          Exposure: '1/500 s',
          ISO: '200',
        },
        cache_pinned: true,
        cache_update_available: true,
        rating: 0,
      },
    },
  );
  const inspector = page.locator('.asset-inspector');
  await expect(inspector).toContainText('Offline snapshot camera');
  await expect(inspector.locator('.inspector-file')).toContainText('预览尺寸 6000 × 4000 px');
  await expect(inspector.locator('.exposure-summary dd')).toHaveText(['f/4', '1/500 s', '200']);
  await expect(inspector.getByRole('button', { name: '评为 4 星' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(inspector).toContainText('已保存裁剪配方');
  await expect(inspector.getByText('有更新', { exact: true })).toBeVisible();
  await expect(inspector).not.toContainText('本地缓存路径');
  await expect(inspector).not.toContainText('/logical/Remote.NEF');
  await expect(inspector.locator('.histogram-source:not(.offline-update)')).toHaveText(
    '相机内嵌预览',
  );
  await expect(inspector).not.toContainText('RAW 原始解码不可用');
  const update = inspector.getByRole('button', { name: '更新离线版本', exact: true });
  await expect(update).toHaveCount(1);
  await update.click();
  await expect(inspector).toContainText('Updated remote camera');
  await expect(inspector.getByText('有更新', { exact: true })).toHaveCount(0);
  expect(calls.filter((command) => command === 'asset.refresh')).toHaveLength(1);
});

test('embedded RAW fallback keeps its decode limitation while remote embedded selection does not invent one', async ({
  page,
}) => {
  await openInspector(
    page,
    {},
    { asset: { extension: 'nef', kind: 'raw' }, source: 'embedded_jpeg' },
  );
  await expect(page.locator('.histogram-source')).toHaveText('相机内嵌预览 · RAW 原始解码不可用');
  await expect(page.locator('.inspector-file')).toContainText('预览尺寸 960 × 640 px');
});
