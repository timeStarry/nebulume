import { expect, test } from '@playwright/test';

test('stage 4: settings convergence, color labels, hierarchical keywords, collections, and command palette', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // Verify layout integrity at 960x600 minimum window size first.
  await page.setViewportSize({ width: 960, height: 600 });
  await page.goto('/');

  // 1. Settings 4-tab convergence & productized About panel (zero JSON <pre>, zero "其他配置").
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();

  const settingsTabs = page.getByRole('tablist', { name: '设置分组' });
  await expect(settingsTabs).toBeVisible();
  await expect(settingsTabs.getByRole('tab')).toHaveCount(4);
  await expect(settingsTabs.getByRole('tab', { name: '外观与浏览' })).toBeVisible();
  await expect(settingsTabs.getByRole('tab', { name: '缓存与离线' })).toBeVisible();
  await expect(settingsTabs.getByRole('tab', { name: '快捷键' })).toBeVisible();
  await expect(settingsTabs.getByRole('tab', { name: '关于' })).toBeVisible();
  await expect(settingsTabs.getByText('其他配置')).toHaveCount(0);

  await settingsTabs.getByRole('tab', { name: '关于' }).click();
  const aboutRegion = page.getByRole('region', { name: 'Nebulume · 星雾' });
  await expect(aboutRegion).toBeVisible();
  await expect(aboutRegion.locator('pre')).toHaveCount(0);

  const hasHorizontalOverflow960 = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow960).toBe(false);

  // Switch to standard 1440x900 photographer desktop viewport for DAM workflows.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '图片库', exact: true })
    .click();

  // 2. Load two demo photos into the browser demo library.
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 640;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#3b6d8c';
    ctx.fillRect(0, 0, 480, 640);
    ctx.fillStyle = '#c97a4b';
    ctx.fillRect(480, 0, 480, 640);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('选择浏览器演示图片').setInputFiles([
    {
      name: 'portrait-a.png',
      mimeType: 'image/png',
      buffer: Buffer.from(encoded, 'base64'),
    },
    {
      name: 'landscape-b.png',
      mimeType: 'image/png',
      buffer: Buffer.from(encoded, 'base64'),
    },
  ]);

  const tileA = page.getByRole('button', { name: /portrait-a\.png/ });
  const tileB = page.getByRole('button', { name: /landscape-b\.png/ });
  await expect(tileA).toBeVisible();
  await expect(tileB).toBeVisible();

  // 3. Color label shortcut `6` (Red), undo (`Meta+z` / `Control+z`), and re-apply `6` + `5` stars.
  await tileA.click();
  await page.keyboard.press('6');
  await expect(page.locator('.tile-color-dot[data-color="red"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /portrait-a\.png.*红色标/ })).toBeVisible();

  const undoShortcut = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
  await page.keyboard.press(undoShortcut);
  await expect(page.locator('.tile-color-dot[data-color="red"]')).toHaveCount(0);

  await page.keyboard.press('6');
  await page.keyboard.press('5');
  await expect(page.getByRole('button', { name: /portrait-a\.png，5 星，红色标/ })).toBeVisible();

  // 4. Open Inspector (`i`) and add hierarchical keyword `人像 > 客片` to portrait-a.png.
  await page.keyboard.press('i');
  const inspector = page.getByRole('complementary', { name: '影像详情' });
  await expect(inspector).toBeVisible();

  await inspector.getByLabel('输入关键词').fill('人像 > 客片');
  await inspector.getByRole('button', { name: '添加', exact: true }).click();
  await expect(
    inspector.getByRole('list', { name: '当前照片关键词' }).getByText('人像 > 客片'),
  ).toBeVisible();

  // 5. Filter by color label (`red`) and parent keyword (`人像`) via filter drawer.
  await page.locator('button.filter-toggle').click();
  const filterGroup = page.getByRole('group', { name: '筛选条件' });
  await expect(filterGroup).toBeVisible();

  await filterGroup.getByLabel('色标筛选').selectOption('red');
  await expect(page.getByRole('button', { name: /portrait-a\.png/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /landscape-b\.png/ })).toHaveCount(0);

  await filterGroup.getByLabel('色标筛选').selectOption('any');
  await expect(page.getByRole('button', { name: /landscape-b\.png/ })).toBeVisible();

  // Parent keyword `人像` matches `人像 > 客片`!
  await filterGroup.getByLabel('关键词筛选').selectOption('人像');
  await expect(page.getByRole('button', { name: /portrait-a\.png/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /landscape-b\.png/ })).toHaveCount(0);

  await filterGroup.getByRole('button', { name: '清除全部' }).click();
  await expect(page.getByRole('button', { name: /landscape-b\.png/ })).toBeVisible();

  // 6. Create a Smart Collection ("五星红标精选") from SidebarCollections and verify dynamic match.
  const sidebarCollections = page.locator('.sidebar-collections');
  await sidebarCollections.getByRole('button', { name: '新建精选集' }).click();
  await page.getByRole('menuitem', { name: '新建智能精选集…' }).click();

  const smartDialog = page.getByRole('dialog', { name: '新建智能精选集' });
  await expect(smartDialog).toBeVisible();
  await smartDialog.getByLabel('精选集名称').fill('五星红标精选');
  await smartDialog.getByLabel('最低星级').selectOption('5');
  await smartDialog.getByLabel('色标状态').selectOption('red');
  await smartDialog.getByRole('button', { name: '创建精选集', exact: true }).click();

  await expect(
    sidebarCollections.getByRole('list', { name: '精选集列表' }).getByText('五星红标精选'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /portrait-a\.png/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /landscape-b\.png/ })).toHaveCount(0);

  // Deselect smart collection to return to full library.
  await sidebarCollections
    .getByRole('list', { name: '精选集列表' })
    .getByRole('button', { name: '五星红标精选 1', exact: true })
    .click();
  await expect(page.getByRole('button', { name: /landscape-b\.png/ })).toBeVisible();

  // 7. Open `⌘K` Command Palette, search for "缓存与离线", and jump directly to Settings -> Cache!
  const paletteShortcut = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';
  await page.keyboard.press(paletteShortcut);
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(palette).toBeVisible();
  await palette.getByLabel('搜索命令或目标').fill('缓存与离线');
  await palette.getByLabel('搜索命令或目标').press('Enter');

  await expect(page.getByRole('tab', { name: '缓存与离线', selected: true })).toBeVisible();

  const hasHorizontalOverflow1440 = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow1440).toBe(false);
  expect(errors).toEqual([]);
});
