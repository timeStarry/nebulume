import { expect, test, type Page } from '@playwright/test';
import { fixture } from './viewer-fixture';

const exif = { Aperture: 'f/2.8', Exposure: '1/500 s', ISO: '200', 'Exposure Bias': '+0.3 EV' };
const corner = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
const overlay = (page: Page) => page.locator('.nl-overlay');

async function openViewer(page: Page, metadata: Record<string, string> = exif) {
  await fixture(page, { fromFile: true, metadata });
  await page.goto('/?viewer=1');
  await expect(page.locator('.viewer-filename strong')).toHaveText('Frame-1.png');
}

async function editOverlay(page: Page) {
  await page.locator('.nl-viewer-bar').getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '编辑叠加信息…' }).click();
  await expect(page.locator('.nl-overlay-tray')).toBeVisible();
}

test('default corners show their widgets and missing data shows nothing', async ({ page }) => {
  await openViewer(page);
  await expect(page.locator('[data-widget="exposure"]')).toContainText('f/2.8');
  await expect(page.locator('[data-widget="exposure"]')).toContainText('ISO 200');
  await expect(page.locator('[data-widget="body-lens"]')).toHaveCount(0);
  await expect(overlay(page)).not.toContainText('undefined');
  await expect(overlay(page)).not.toContainText('null');
});

test('D hides and shows the overlay', async ({ page }) => {
  await openViewer(page);
  await expect(overlay(page)).toBeVisible();
  await page.keyboard.press('d');
  await expect(overlay(page)).toBeHidden();
  await expect(
    page.locator('.nl-viewer-bar').getByRole('button', { name: '叠加信息（D）' }),
  ).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('d');
  await expect(overlay(page)).toBeVisible();
});

test('editing by keyboard adds, moves and removes a widget, and the layout persists', async ({
  page,
}) => {
  await openViewer(page);
  await editOverlay(page);
  await corner(page, '左上').getByRole('button', { name: '添加到左上' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'ISO', exact: true }).click();
  await expect(corner(page, '左上').locator('[data-widget="iso"]')).toBeVisible();
  await corner(page, '左上').locator('[data-widget="iso"]').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '移到右下' }).click();
  await expect(corner(page, '右下').locator('[data-widget="iso"]')).toBeVisible();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('.nl-overlay-tray')).toHaveCount(0);
  await page.reload();
  await expect(corner(page, '右下').locator('[data-widget="iso"]')).toBeVisible();

  await editOverlay(page);
  await corner(page, '右下').locator('[data-widget="iso"]').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '移除' }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('nebulume.viewer.overlay') || '{}'),
  );
  expect(saved.br).not.toContain('iso');
});

test('drag from the tray into a corner', async ({ page }) => {
  await openViewer(page);
  await editOverlay(page);
  await page.locator('.nl-overlay-tray [data-widget="exposure-bias"]').dragTo(corner(page, '左上'));
  await expect(corner(page, '左上').locator('[data-widget="exposure-bias"]')).toContainText(
    '+0.3 EV',
  );
});

test('a corrupt saved layout falls back to the default', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nebulume.viewer.overlay', '{bad'));
  await openViewer(page);
  await expect(corner(page, '左下').locator('[data-widget="exposure"]')).toBeVisible();
});

test('pinning a field in the info panel moves it to the top and persists', async ({ page }) => {
  await openViewer(page);
  await page.keyboard.press('i');
  const panel = page.getByRole('complementary', { name: '影像详情' });
  const pinned = panel.getByRole('list', { name: '固定显示' });
  await panel.getByRole('button', { name: '固定 Exposure Bias' }).click();
  await expect(pinned.getByRole('listitem').last()).toContainText('+0.3 EV');
  await pinned.getByRole('listitem').last().focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(pinned.getByRole('listitem').nth(-2)).toContainText('+0.3 EV');
  await page.reload();
  await page.keyboard.press('i');
  await expect(
    page
      .getByRole('complementary', { name: '影像详情' })
      .getByRole('list', { name: '固定显示' })
      .getByRole('listitem')
      .nth(-2),
  ).toContainText('+0.3 EV');
});

test('missing values in pinned fields show a dash, never undefined', async ({ page }) => {
  await openViewer(page, {});
  await page.keyboard.press('i');
  const pinned = page
    .getByRole('complementary', { name: '影像详情' })
    .getByRole('list', { name: '固定显示' });
  await expect(pinned.getByRole('listitem').first()).toContainText('—');
  await expect(pinned).not.toContainText('undefined');
});

test('a photo whose histogram cannot be read shows no empty widget box', async ({ page }) => {
  await fixture(page, { fromFile: true, metadata: exif, failHistogram: true });
  await page.goto('/?viewer=1');
  await expect(page.locator('[data-widget="exposure"]')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator('[data-widget="histogram"]')).toHaveCount(0);
});

test('while editing the overlay, Esc leaves edit mode and photo keys do nothing', async ({
  page,
}) => {
  const { assets } = await fixture(page, { metadata: exif });
  await page.goto('/?viewer=1');
  await expect(page.locator('.cull-status').first()).toContainText('1 / 3');
  await editOverlay(page);
  await expect(page.getByRole('button', { name: '添加到左上' })).toBeFocused();
  await page.keyboard.press('3');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  expect(assets.get('photo-1')!.rating).toBe(0);
  await expect(page.locator('.cull-status').first()).toContainText('1 / 3');
  await page.keyboard.press('Escape');
  await expect(page.locator('.nl-overlay-tray')).toHaveCount(0);
  await expect(page.locator('.immersive-viewer')).toBeVisible();
});
