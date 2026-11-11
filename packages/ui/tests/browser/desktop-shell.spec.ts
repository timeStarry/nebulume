import { expect, test } from '@playwright/test';

for (const size of [
  { width: 960, height: 600 },
  { width: 1440, height: 900 },
])
  test(`no window-level scrollbar at ${size.width}×${size.height} in any workspace`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: '主导航' });
    for (const name of ['图片库', '位置', '导入', '设置']) {
      await nav.getByRole('button', { name, exact: true }).click();
      const overflow = await page.evaluate(() => {
        const root = document.scrollingElement!;
        return {
          vertical: root.scrollHeight - window.innerHeight,
          horizontal: root.scrollWidth - window.innerWidth,
          body: getComputedStyle(document.body).overflow,
        };
      });
      expect(overflow.body, name).toBe('hidden');
      expect(overflow.vertical, name).toBeLessThanOrEqual(0);
      expect(overflow.horizontal, name).toBeLessThanOrEqual(0);
    }
  });

test('the WebView context menu is suppressed except in text fields', async ({ page }) => {
  await page.goto('/');
  const prevented = (selector: string) =>
    page.evaluate((target) => {
      const element = document.querySelector(target)!;
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, selector);
  expect(await prevented('.nl-rail')).toBe(true);
  expect(await prevented('main')).toBe(true);
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.locator('body').evaluate(() => {
    const input = document.createElement('input');
    input.id = 'probe-input';
    document.querySelector('main')!.append(input);
  });
  expect(await prevented('#probe-input')).toBe(false);
});

test('interface text is not selectable while paths and inputs are', async ({ page }) => {
  await page.goto('/');
  const selectable = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((element) => getComputedStyle(element).userSelect);
  expect(await selectable('.nl-rail')).toBe('none');
  expect(await selectable('main')).toBe('none');
  await page.locator('body').evaluate(() => {
    const code = document.createElement('code');
    code.id = 'probe-code';
    code.textContent = '/Volumes/SD/DCIM';
    document.querySelector('main')!.append(code);
  });
  expect(await selectable('#probe-code')).toBe('text');
});

test('the motion preference applies at once, persists and syncs to other windows', async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  const second = await context.newPage();
  await second.goto('/');
  await page.getByLabel('界面动效').selectOption('full');
  // An explicit choice wins over the OS setting.
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  await expect(second.locator('html')).toHaveAttribute('data-motion', 'full');
  const duration = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--nl-d-base').trim(),
  );
  expect(duration).toBe('180ms');
  await page.getByLabel('界面动效').selectOption('standard');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'standard');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'standard');
  await second.close();
});
