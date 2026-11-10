import { expect, test } from '@playwright/test';

test('the reference page renders every control at the four heights only', async ({ page }) => {
  await page.goto('/?design=1');
  await expect(page.getByRole('heading', { name: '按钮', exact: true })).toBeVisible();
  const heights = await page.$$eval(
    '.nl-btn, .nl-icon-btn, .nl-input, .nl-select, .nl-seg, .nl-chip, .nl-toggle',
    (els) => [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().height)))].sort(),
  );
  expect(heights.length).toBeGreaterThan(0);
  for (const height of heights) expect([24, 28, 32, 40]).toContain(height);
  const weights = await page.$$eval('body *', (els) => [
    ...new Set(els.map((el) => getComputedStyle(el).fontWeight)),
  ]);
  expect(weights.every((weight) => weight === '400' || weight === '500')).toBe(true);
  const tiny = await page.$$eval(
    'body *',
    (els) =>
      els.filter(
        (el) =>
          el.childNodes[0]?.nodeType === 3 &&
          el.textContent!.trim() &&
          parseFloat(getComputedStyle(el).fontSize) < 11,
      ).length,
  );
  expect(tiny).toBe(0);
});

test('switching theme swaps the canvas colour', async ({ page }) => {
  await page.goto('/?design=1');
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.getByRole('tab', { name: '浅色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
    before,
  );
});

test('the rail lists library, import and locations in that order, settings at the bottom', async ({
  page,
}) => {
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: '主导航' });
  const names = await rail
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label') || button.textContent!.trim()),
    );
  expect(names.slice(0, 3)).toEqual(['图片库', '导入', '位置']);
  expect(names.at(-1)).toBe('设置');
  const settings = await rail.getByRole('button', { name: '设置', exact: true }).boundingBox();
  const railBox = await rail.boundingBox();
  // Settings sits at the bottom of the rail, below 打开文件….
  expect(settings!.y + settings!.height).toBeGreaterThan(railBox!.y + railBox!.height - 80);
});
