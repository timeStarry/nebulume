import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test('stage 3: XMP sidecar policy/sync and preset-driven JPEG delivery export', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');

  // 1. Toggle automatic `.xmp` sidecar sync in Settings.
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  const xmpSwitch = page.getByRole('switch', { name: '自动同步 .xmp 伴随文件' });
  await expect(xmpSwitch).toBeVisible();
  await expect(xmpSwitch).not.toBeChecked();
  await xmpSwitch.click();
  await expect(xmpSwitch).toBeChecked();

  // 2. Load a 1200x800 photo into the browser demo library.
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '图片库', exact: true })
    .click();
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 800;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#d85b38';
    ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = '#2d6e8e';
    ctx.fillRect(600, 0, 600, 800);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('选择浏览器演示图片').setInputFiles([
    {
      name: 'editorial-shot.png',
      mimeType: 'image/png',
      buffer: Buffer.from(encoded, 'base64'),
    },
    {
      name: 'editorial-shot-2.png',
      mimeType: 'image/png',
      buffer: Buffer.from(encoded, 'base64'),
    },
  ]);

  const tile = page.getByRole('button', { name: 'editorial-shot.png，0 星' });
  await expect(tile).toBeVisible();

  // 3. Rate 5 stars (auto-writes demo XMP sidecar), then change rating to 2 stars with auto-write off,
  //    and restore 5 stars from `.xmp` via context menu!
  await tile.click();
  await page.keyboard.press('5');
  const rated5 = page.getByRole('button', { name: 'editorial-shot.png，5 星' });
  await expect(rated5).toBeVisible();

  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('switch', { name: '自动同步 .xmp 伴随文件' }).click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '图片库', exact: true })
    .click();

  await rated5.click();
  await page.keyboard.press('2');
  const rated2 = page.getByRole('button', { name: 'editorial-shot.png，2 星' });
  await expect(rated2).toBeVisible();

  await rated2.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '从 .xmp 重新读取标记' }).click();
  await expect(rated5).toBeVisible();

  // 4. Select both photos to surface BatchDock ("按预设导出…"), configure custom prefix + 1080 resize,
  //    save as a custom preset, and verify downloaded JPEG dimensions & filename!
  await page.getByRole('button', { name: 'editorial-shot-2.png，0 星' }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('button', { name: '按预设导出…' })).toBeVisible();
  await page.getByRole('button', { name: '按预设导出…' }).click();

  const dialog = page.getByRole('dialog', { name: /导出 2 张照片/ });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('导出预设').selectOption('social_2k');
  await dialog.getByRole('tab', { name: '自定义', exact: true }).click();
  await dialog.getByLabel('自定义长边像素').fill('1080');
  await dialog.getByLabel('导出文件命名').selectOption('prefix_seq');
  await dialog.getByLabel('导出命名前缀').fill('Lookbook');
  await expect(dialog.locator('.export-preview-box code')).toHaveText('Lookbook_0001.jpg');

  // Save as custom preset and verify it becomes active and deletable.
  await dialog.getByRole('button', { name: '存为预设', exact: true }).click();
  await dialog.getByLabel('新导出预设名称').fill('画册小样 1080');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '删除', exact: true })).toBeVisible();
  await expect(dialog.locator('.export-preset-select option:checked')).toContainText('画册小样 1080');

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出 2 张', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Lookbook_0001.jpg');
  const bytes = await fs.readFile((await download.path())!);
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

  // Decode downloaded JPEG in browser to verify long edge was resized from 1200 -> 1080!
  const b64 = bytes.toString('base64');
  const dims = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${data}`;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, b64);
  expect(dims).toEqual({ width: 1080, height: 720 });
  expect(errors).toEqual([]);
});
