import { expect, test, type Page } from '@playwright/test';
import { selectChoice } from './fixtures';
import { fixture, library } from './viewer-fixture';

const hud = (page: Page) => page.locator('.cull-status');

test('grid culls inside the library window over the filtered queue', async ({ page }) => {
  const { calls } = await fixture(page);
  await page.addInitScript(() => localStorage.setItem('nebulume.filters-open', 'true'));
  await page.goto('/');
  await page
    .getByRole('button', { name: /本地摄影/ })
    .first()
    .click();
  await selectChoice(page.getByRole('combobox', { name: '旗标筛选' }), 'none');
  await expect(page.locator('.thumbnail')).toHaveCount(3);
  await page.locator('.thumbnail').first().click();
  const listsBefore = calls.filter((call) => call.command === 'asset.list').length;
  await page.keyboard.press('Shift+C');
  await expect(hud(page)).toContainText('1 / 3');
  // The queue is frozen from the same filter the grid shows.
  const snapshot = calls.filter((call) => call.command === 'asset.list').slice(listsBefore);
  expect(snapshot.at(-1)?.params).toMatchObject({ flag: 'none', library_id: library.id });
  expect(calls.some((call) => call.command === '$native/open_viewer')).toBe(false);
});

test('marks advance after confirmation, keep a frozen queue and undo across photos', async ({
  page,
}) => {
  const { assets } = await fixture(page);
  await page.goto('/?viewer=1');
  await expect(page.getByRole('tab', { name: '选片', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(hud(page)).toContainText('1 / 3');
  await page.keyboard.press('3');
  await expect(hud(page)).toContainText('2 / 3');
  expect(assets.get('photo-1')!.rating).toBe(3);
  await page.keyboard.press('x');
  await expect(hud(page)).toContainText('3 / 3');
  expect(assets.get('photo-2')!.flag).toBe('reject');
  // The queue was filtered to unflagged images, yet marked ones stay in this session.
  await page.keyboard.press('p');
  await expect(page.getByText('已到最后一张。')).toBeVisible();
  await expect(hud(page)).toContainText('3 / 3');
  await page.keyboard.press('ArrowLeft');
  await expect(hud(page)).toContainText('2 / 3');
  await page.keyboard.press('Control+z');
  await expect(hud(page)).toContainText('3 / 3');
  await expect(hud(page)).toContainText('未标记');
  expect(assets.get('photo-3')!.flag).toBe('none');
  await page.keyboard.press('Control+z');
  await expect(hud(page)).toContainText('2 / 3');
  expect(assets.get('photo-2')!.flag).toBe('none');
});

test('rapid keys within the dwell window combine on the current photo and manual navigation cancels pending advance', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('nebulume.cull.auto-advance', 'standard'));
  const { assets } = await fixture(page);
  await page.goto('/?viewer=1');
  await expect(hud(page)).toContainText('1 / 3');
  await page.keyboard.press('p');
  await page.keyboard.press('2');
  // Still on photo 1 right after both keys; advances once to photo 2 after the 450ms idle dwell.
  await expect(hud(page)).toContainText('1 / 3');
  await expect(hud(page)).toContainText('2 / 3');
  expect(assets.get('photo-1')!.flag).toBe('pick');
  expect(assets.get('photo-1')!.rating).toBe(2);
  expect(assets.get('photo-2')!.rating).toBe(0);

  // Manual ArrowRight during dwell moves immediately and cancels the scheduled auto-advance.
  await page.keyboard.press('3');
  await page.keyboard.press('ArrowRight');
  await expect(hud(page)).toContainText('3 / 3');
  expect(assets.get('photo-2')!.rating).toBe(3);
});

test('bracket keys step ratings with 0–5 saturation, CJK IME codes, and multi-select per-photo undo', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('nebulume.cull.auto-advance', 'standard'));
  const { assets } = await fixture(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /本地摄影/ })
    .first()
    .click();
  const thumbs = page.locator('.thumbnail');
  await expect(thumbs).toHaveCount(3);

  // Set photo-1 to 2 stars and photo-2 to 5 stars, then multi-select both and press `]`.
  await thumbs.nth(0).click();
  await page.keyboard.press('2');
  await expect.poll(() => assets.get('photo-1')!.rating).toBe(2);
  await thumbs.nth(1).click();
  await page.keyboard.press('5');
  await expect.poll(() => assets.get('photo-2')!.rating).toBe(5);

  await thumbs.nth(0).click({ modifiers: ['Shift'] });
  await page.keyboard.press(']');
  await expect.poll(() => assets.get('photo-1')!.rating).toBe(3);
  await expect.poll(() => assets.get('photo-2')!.rating).toBe(5);

  // Undo restores photo-1 back to 2 while keeping photo-2 at 5.
  await page.keyboard.press('Control+z');
  await expect.poll(() => assets.get('photo-1')!.rating).toBe(2);
  await expect.poll(() => assets.get('photo-2')!.rating).toBe(5);

  // Enter Cull Mode on photo-3 (0 stars): `[` clamps at 0, then `]` + CJK `】` step up to 2 before advancing.
  await thumbs.nth(2).click();
  await page.keyboard.press('Shift+C');
  await expect(hud(page)).toContainText('3 / 3');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(hud(page)).toContainText('1 / 3');

  // Switch to plain View mode: `[` steps photo-1 from 2 -> 1 without advancing.
  await page.keyboard.press('Shift+C');
  await page.keyboard.press('[');
  await expect.poll(() => assets.get('photo-1')!.rating).toBe(1);

  // Back in Cull Mode on photo-1 (1 star): `]` + CJK `】` (BracketRight) -> 3 stars, then advances to 2 / 3.
  await page.keyboard.press('Shift+C');
  await expect(hud(page)).toContainText('1 / 3');
  await page.keyboard.press(']');
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '】', code: 'BracketRight', bubbles: true }),
    );
  });
  await expect.poll(() => assets.get('photo-1')!.rating).toBe(3);
  await expect(hud(page)).toContainText('2 / 3');
});

test('toolbar auto-advance toggle pauses and restores the configured speed tier', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('nebulume.cull.auto-advance', 'relaxed');
    localStorage.setItem('nebulume.cull.auto-advance-speed', 'relaxed');
  });
  await fixture(page);
  await page.goto('/?viewer=1');
  const toggle = page.getByRole('button', { name: '自动下一张' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('nebulume.cull.auto-advance'))).toBe('off');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('nebulume.cull.auto-advance'))).toBe(
    'relaxed',
  );
});

test('auto-advance off keeps the photo and a failed mark rolls back', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nebulume.cull.auto-advance', 'false'));
  const { assets } = await fixture(page, { failFlag: true });
  await page.goto('/?viewer=1');
  await expect(page.getByRole('button', { name: '自动下一张' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.keyboard.press('4');
  await expect(hud(page)).toContainText('1 / 3');
  await expect(hud(page).getByLabel('4 星')).toBeVisible();
  expect(assets.get('photo-1')!.rating).toBe(4);
  await page.keyboard.press('p');
  await expect(page.getByText(/标记未保存/)).toBeVisible();
  await expect(hud(page)).toContainText('未标记');
  await expect(hud(page)).toContainText('1 / 3');
});

test('mode switch restores ordinary viewer shortcuts and plain viewer supports P/X/U flags with undo', async ({
  page,
}) => {
  const { assets } = await fixture(page);
  await page.goto('/?viewer=1');
  await expect(hud(page)).toBeVisible();
  await page.keyboard.press('Shift+C');
  await expect(page.getByRole('tab', { name: '查看', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(hud(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '显示对焦点（Shift+F）' })).toBeVisible();
  await page.keyboard.press('p');
  await expect.poll(() => assets.get('photo-1')!.flag).toBe('pick');
  await page.keyboard.press('x');
  await expect.poll(() => assets.get('photo-1')!.flag).toBe('reject');
  await page.keyboard.press('u');
  await expect.poll(() => assets.get('photo-1')!.flag).toBe('none');
  await page.keyboard.press('Control+z');
  await expect.poll(() => assets.get('photo-1')!.flag).toBe('reject');
});

test('culling shows progress and marks beside the photo, then finishes with export and Trash', async ({
  page,
}) => {
  const { calls, assets } = await fixture(page);
  await page.goto('/?viewer=1');
  const panel = page.getByRole('complementary', { name: '选片面板' });
  await expect(panel).toContainText('已看 1 / 3');
  await expect(page.locator('.cull-strip-item')).toHaveCount(3);
  await page.keyboard.press('p');
  await expect(panel).toContainText('已看 2 / 3');
  await expect(panel).toContainText('1 留用');
  await page.keyboard.press('x');
  await expect(panel).toContainText('已看 3 / 3');
  await expect(panel).toContainText('1 淘汰');
  await expect(page.locator('.cull-strip-mark.pick')).toHaveCount(1);
  await expect(page.locator('.cull-strip-mark.reject')).toHaveCount(1);
  // The side panel marks the photo on screen like the keys do.
  await panel.getByRole('button', { name: '评为 4 星' }).click();
  await expect.poll(() => assets.get('photo-3')!.rating).toBe(4);

  await panel.getByRole('button', { name: '完成选片' }).click();
  const review = page.getByRole('region', { name: '完成选片' });
  await expect(review).toContainText('留用 1 张');
  await expect(review).toContainText('淘汰 1 张');
  await expect(review.getByRole('button', { name: '继续选片' })).toBeFocused();
  // Moving originals needs a second, explicit press.
  await review.getByRole('button', { name: '移到废纸篓…' }).click();
  expect(calls.some((call) => call.command === 'asset.trash')).toBe(false);
  await review.getByRole('button', { name: '确认移走 1 个文件' }).click();
  await expect(review).toBeHidden();
  await expect
    .poll(() => calls.find((call) => call.command === 'asset.trash')?.params)
    .toEqual({
      ids: ['photo-2'],
    });
  await expect(page.locator('.cull-strip-item')).toHaveCount(2);
  await expect(panel).toContainText('0 淘汰');
  await page.getByRole('button', { name: '撤销' }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'asset.restore')?.params)
    .toEqual({
      ids: ['photo-2'],
    });
  await expect(page.locator('.cull-strip-item')).toHaveCount(3);
  await expect(panel).toContainText('1 淘汰');
});

test('⌘⌫ moves the photo on screen to the Trash and the viewer moves on', async ({ page }) => {
  const { calls } = await fixture(page);
  await page.goto('/?viewer=1');
  await expect(hud(page)).toContainText('1 / 3');
  await page.keyboard.press('Meta+Backspace');
  await expect(hud(page)).toContainText('1 / 2');
  expect(calls.find((call) => call.command === 'asset.trash')?.params).toEqual({
    ids: ['photo-1'],
  });
  await expect(
    page.getByRole('status').filter({ hasText: '已把 1 张照片移到废纸篓' }),
  ).toBeVisible();
});

test('a file opened from the Finder browses its folder and can join the libraries', async ({
  page,
}) => {
  const { calls } = await fixture(page, { fromFile: true });
  await page.goto('/?viewer=1');
  const viewer = page.getByLabel('沉浸影像查看器');
  await expect(
    viewer
      .getByText('第 1 张，共 3 张', { exact: false })
      .or(viewer.getByLabel('第 1 张，共 3 张')),
  ).toBeVisible();
  await expect(viewer.locator('.viewer-folder')).toHaveText('Trip');
  const banner = viewer.getByRole('note');
  await expect(banner).toContainText('“Trip”不在图片库中');
  // Only the file shown is indexed; the next one is indexed when it is about to be needed.
  await expect
    .poll(() => calls.filter((call) => call.command === 'file.open').length)
    .toBeLessThanOrEqual(1);
  await page.keyboard.press('ArrowRight');
  await expect(viewer.getByLabel('第 2 张，共 3 张')).toBeVisible();
  await expect(viewer.locator('.viewer-filename strong')).toHaveText('Frame-2.png');
  expect(
    calls.some(
      (call) => call.command === 'file.open' && call.params.path === '/photos/Trip/Frame-2.png',
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      calls.some(
        (call) => call.command === 'file.open' && String(call.params.path).includes('Frame-3'),
      ),
    )
    .toBe(true);

  await banner.getByRole('button', { name: '加入图片库' }).click();
  await expect(banner).toBeHidden();
  expect(calls.find((call) => call.command === 'library.add')?.params).toEqual({
    name: 'Trip',
    root: '/photos/Trip',
    pair_raw_jpeg: true,
  });
  await expect(
    viewer.getByRole('status').filter({ hasText: '已加入图片库“Trip”，索引了 3 张' }),
  ).toBeVisible();
});

test('the viewer’s more menu reaches export, the path and the Trash', async ({ page }) => {
  const { calls } = await fixture(page, { fromFile: true });
  await page.goto('/?viewer=1');
  const viewer = page.getByLabel('沉浸影像查看器');
  await expect(viewer.locator('.viewer-filename strong')).toHaveText('Frame-1.png');
  await viewer.getByRole('button', { name: '更多', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: '把此文件夹加入图片库…' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '在图片库中显示' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: '移到废纸篓' }).click();
  await expect
    .poll(() => calls.find((call) => call.command === 'asset.trash')?.params)
    .toEqual({
      ids: ['photo-1'],
    });
  await expect(viewer.locator('.viewer-filename strong')).toHaveText('Frame-2.png');
});

test('the mark confirmation plays on the panel even with no rating widget in the overlay', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'nebulume.viewer.overlay',
      JSON.stringify({ tl: [], tr: [], bl: [], br: [] }),
    ),
  );
  await fixture(page);
  await page.goto('/?viewer=1');
  await expect(hud(page)).toContainText('1 / 3');
  await page.keyboard.press('3');
  await expect(page.locator('.cull-panel')).toHaveClass(/pulse-rate/);
  await expect(hud(page)).toContainText('2 / 3');
  await expect(page.locator('.cull-hud')).toHaveCount(0);
});

test('the viewer top bar has one entry per action', async ({ page }) => {
  await fixture(page, { fromFile: true });
  await page.goto('/?viewer=1');
  const bar = page.locator('.nl-viewer-bar');
  for (const name of ['叠加信息（D）', '影像信息（I）', '裁剪（C）', '更多'])
    await expect(bar.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: '导出 JPEG' })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: '重新读取原图' })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: /切换全屏/ })).toHaveCount(0);
  await bar.getByRole('button', { name: '更多', exact: true }).click();
  for (const name of ['导出原片…', '导出 JPEG…', '全屏', '复制文件路径', '编辑叠加信息…', '移到废纸篓'])
    await expect(page.getByRole('menuitem', { name })).toBeVisible();
});
