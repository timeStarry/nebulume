import { expect, test, type Page } from '@playwright/test';
import type { Asset } from '../../src/model';

async function openInspector(page: Page, metadata: Record<string, string>) {
  const asset: Asset = {
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
  };
  await page.route('**/__inspector_rpc', async (route) => {
    const { command } = route.request().postDataJSON() as { command: string };
    let result: unknown;
    switch (command) {
      case 'viewer_context':
        result = { asset_id: asset.id, asset_ids: [asset.id] };
        break;
      case 'asset.get':
        result = asset;
        break;
      case 'asset.preview':
        result = {
          data_url:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
          width: 1,
          height: 1,
          source: 'test fixture',
        };
        break;
      case 'asset.histogram':
        result = {
          red: Array(256).fill(1),
          green: Array(256).fill(1),
          blue: Array(256).fill(1),
          luminance: Array(256).fill(1),
          pixels: 256,
          source: 'test fixture',
        };
        break;
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
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toBeVisible();
  await page.keyboard.press('i');
  await expect(page.getByRole('img', { name: '当前图片 RGB 直方图' })).toBeVisible();
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
