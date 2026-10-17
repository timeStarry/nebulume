import { expect, test, type Page } from '@playwright/test';

async function appearance(page: Page) {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  return page.getByLabel('外观主题');
}

test('Appearance persists and uses a dark mark on a light surface', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.manager-brand .brand-mark')).toHaveAttribute(
    'src',
    /brand-mark\.svg/,
  );
  await (await appearance(page)).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect
    .poll(async () => {
      const source = await page.locator('.manager-brand .brand-mark').getAttribute('src');
      return source?.startsWith('data:')
        ? decodeURIComponent(source).includes("fill='#11151C'")
        : source?.includes('brand-mark-ink');
    })
    .toBe(true);
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(46, 52, 64)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(await appearance(page)).toHaveValue('light');
});

test('system appearance follows OS changes while an explicit choice takes precedence', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const control = await appearance(page);
  await control.selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await control.selectOption('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('appearance synchronizes across open windows without reloading their contents', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const second = await context.newPage();
  await second.goto('/');
  await (await appearance(page)).selectOption('light');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'light');
  await (await appearance(second)).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByLabel('外观主题')).toHaveValue('dark');
  await second.close();
});

test('light UI keeps the actual image and immersive canvas neutral', async ({ page }) => {
  await page.goto('/');
  await (await appearance(page)).selectOption('light');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '图片库', exact: true })
    .click();
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
    name: 'appearance-fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.from(encoded, 'base64'),
  });
  await page.getByRole('button', { name: 'appearance-fixture.png，0 星' }).dblclick();
  const viewer = page.getByRole('dialog', { name: '沉浸影像查看器' });
  await expect(page.locator('.main-photo')).toBeVisible();
  await expect(page.locator('.photo-stage')).toHaveCSS('background-color', 'rgb(24, 24, 24)');
  await expect(page.locator('.main-photo')).toHaveCSS('filter', 'none');
  await expect(page.locator('.main-photo')).toHaveCSS('opacity', '1');
  await expect(page.locator('.main-photo')).toHaveCSS('mix-blend-mode', 'normal');
  await viewer.getByRole('button', { name: '影像信息（I）' }).click();
  await expect(page.getByRole('complementary', { name: '影像详情' })).toBeVisible();
  await viewer.getByRole('button', { name: '影像信息（I）' }).focus();
  await page.waitForTimeout(2700);
  await expect(page.locator('.immersive-toolbar')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'test-results/nord-light-immersive.png' });
});

test('native system mode clears the window override and follows native theme events', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    let callbackId = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number>();
    const frames: unknown[] = [];
    Object.assign(window, {
      isTauri: true,
      __appearanceFrames: frames,
      __emitNativeTheme: (theme: string) =>
        callbacks.get(listeners.get('tauri://theme-changed')!)?.({
          event: 'tauri://theme-changed',
          id: 1,
          payload: theme,
        }),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: unknown) => void) => {
          callbacks.set(++callbackId, callback);
          return callbackId;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, params: Record<string, unknown>) => {
          if (command === 'plugin:window|set_theme') {
            frames.push(params.value);
            return null;
          }
          // The native OS is light even when WebView's media still reports dark.
          if (command === 'plugin:window|theme') return 'light';
          if (command === 'plugin:event|listen') {
            listeners.set(String(params.event), Number(params.handler));
            return 1;
          }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'execute') {
            if (params.command === 'library.list' || params.command === 'storage.list') return [];
            if (params.command === 'system.info') return { originals_read_only: true };
          }
          throw new Error('Unexpected appearance fixture: ' + command);
        },
      },
    });
  });
  await page.goto('/');
  const control = await appearance(page);
  await control.selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(
    await page.evaluate(() =>
      (window as unknown as { __appearanceFrames: unknown[] }).__appearanceFrames.at(-1),
    ),
  ).toBeNull();
  await page.evaluate(() =>
    (window as unknown as { __emitNativeTheme: (value: string) => void }).__emitNativeTheme('dark'),
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await control.selectOption('light');
  await page.evaluate(() =>
    (window as unknown as { __emitNativeTheme: (value: string) => void }).__emitNativeTheme('dark'),
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('compact navigation traps focus, closes with Escape and preserves narrow layout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 768 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: '打开主导航', exact: true });
  await toggle.click();
  const navigation = page.getByRole('navigation', { name: '主导航' });
  await expect(navigation.getByRole('button', { name: '图片库', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(navigation.getByRole('button', { name: '设置', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await toggle.click();
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('外观主题')).toBeVisible();
  await expect(page.getByRole('button', { name: '打开主导航', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  for (const width of [900, 720]) {
    await page.setViewportSize({ width, height: 768 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.screenshot({ path: 'test-results/nord-720-settings.png' });
});
