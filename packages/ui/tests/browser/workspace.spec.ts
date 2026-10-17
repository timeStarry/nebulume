import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test('real browser files support review, crop invalidation, reset and JPEG export', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('region', { name: '图片库管理' })).toBeVisible();
  await expect(page.getByText('浏览器演示', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace-empty.png' });
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e26040';
    context.fillRect(0, 0, 400, 600);
    context.fillStyle = '#487994';
    context.fillRect(400, 0, 400, 600);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('选择浏览器演示图片').setInputFiles({
    name: 'review-fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.from(encoded, 'base64'),
  });
  await expect(page.getByRole('button', { name: 'review-fixture.png，0 星' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '影像详情' })).not.toBeVisible();
  await page.getByRole('button', { name: '影像详情（I）' }).click();
  await expect(page.getByRole('img', { name: '当前图片 RGB 直方图' })).toBeVisible();
  await page.getByRole('button', { name: '评为 4 星' }).click();
  await expect(page.getByRole('button', { name: '评为 4 星' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('textbox', { name: '搜索照片' }).fill('5');
  await page.getByRole('textbox', { name: '搜索照片' }).press('0');
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.getByRole('button', { name: 'review-fixture.png，4 星' })).toBeVisible();
  await page.getByRole('button', { name: 'review-fixture.png，4 星' }).dblclick();
  const viewer = page.getByRole('dialog', { name: '沉浸影像查看器' });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('complementary')).not.toBeVisible();
  await expect(page.locator('.main-photo')).toHaveJSProperty('naturalWidth', 800);
  await viewer.getByRole('button', { name: '裁剪（C）', exact: true }).click();
  await page.getByLabel('左侧').fill('25');
  await page.getByLabel('宽度').fill('50');
  await page.getByRole('button', { name: '保存裁剪' }).click();
  await expect(page.locator('.main-photo')).toHaveJSProperty('naturalWidth', 400);
  await expect(viewer.locator('.histogram-source')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/workspace-cropped.png' });
  await viewer.getByRole('button', { name: '裁剪（C）', exact: true }).click();
  await expect(page.locator('.main-photo')).toHaveJSProperty('naturalWidth', 800);
  await expect(page.getByLabel('左侧')).toHaveValue('25');
  await page.getByRole('button', { name: '退出裁剪' }).click();
  await expect(page.locator('.main-photo')).toHaveJSProperty('naturalWidth', 400);
  const downloadEvent = page.waitForEvent('download');
  await viewer.getByRole('button', { name: '导出 JPEG', exact: true }).first().click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('review-fixture-edited.jpg');
  const data = await fs.readFile((await download.path())!);
  expect(data[0]).toBe(0xff);
  expect(data[1]).toBe(0xd8);
  expect(data.length).toBeGreaterThan(500);
  await viewer.getByRole('button', { name: '重置', exact: true }).click();
  await expect(page.locator('.main-photo')).toHaveJSProperty('naturalWidth', 800);
  await expect(viewer.locator('.histogram-source')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(viewer).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'review-fixture.png，4 星' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('keyboard modal focus is trapped and narrow desktop view remains accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '存储源', exact: true })
    .click();
  await page.getByRole('button', { name: '添加存储源', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭对话框' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '关闭对话框' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
