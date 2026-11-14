import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { selectChoice } from './fixtures';

const desktopImgCsp = (() => {
  const conf = JSON.parse(
    readFileSync(new URL('../../../../crates/neb-app/tauri.conf.json', import.meta.url), 'utf8'),
  ) as { app: { security: { csp: string } } };
  const imgSrc = conf.app.security.csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('img-src '));
  if (!imgSrc) throw new Error('Missing img-src in tauri.conf.json');
  return imgSrc;
})();

async function appearance(page: Page) {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  return page.getByLabel('外观主题');
}

test('Appearance persists and renders every BrandMark cleanly under desktop img-src CSP', async ({
  page,
}) => {
  // Enforce the exact Tauri desktop `img-src` directive so `data:` image regressions fail immediately.
  await page.addInitScript((imgDirective: string) => {
    const violations: string[] = [];
    Object.assign(window, { __cspViolations: violations });
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective}:${event.blockedURI}`);
    });
    const inject = () => {
      const meta = document.createElement('meta');
      meta.httpEquiv = 'Content-Security-Policy';
      meta.content = imgDirective;
      document.head.prepend(meta);
    };
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }, desktopImgCsp);

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.brand-mark:visible')).toHaveAttribute('src', /brand-mark.*\.svg/);
  await selectChoice(await appearance(page), 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Open About so both the rail mark (24px) and About hero mark (40px) are visible at once.
  await page.getByRole('tab', { name: '关于', exact: true }).click();
  const visibleMarks = page.locator('.brand-mark:visible');
  await expect(visibleMarks).toHaveCount(2);
  await expect
    .poll(async () =>
      visibleMarks.evaluateAll((els) =>
        els.every((el) => {
          const img = el as HTMLImageElement;
          return (
            !img.src.startsWith('data:') &&
            img.src.includes('brand-mark-ink') &&
            img.complete &&
            img.naturalWidth > 0
          );
        }),
      ),
    )
    .toBe(true);

  // Also verify the compact titlebar BrandMark (< 960px) renders cleanly in light mode.
  await page.setViewportSize({ width: 900, height: 768 });
  const titlebarMark = page.locator('.nl-titlebar .brand-mark');
  await expect(titlebarMark).toBeVisible();
  expect(
    await titlebarMark.evaluate(
      (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 960 });

  expect(
    await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations),
  ).toEqual([]);

  await page.getByRole('tab', { name: '外观与浏览', exact: true }).click();
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(31, 31, 31)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(await appearance(page)).toHaveAttribute('data-value', 'light');
});

test('system appearance follows OS changes while an explicit choice takes precedence', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const control = await appearance(page);
  await selectChoice(control, 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await selectChoice(control, 'light');
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
  await selectChoice(await appearance(page), 'light');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'light');
  await selectChoice(await appearance(second), 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByLabel('外观主题')).toHaveAttribute('data-value', 'dark');
  await second.close();
});

test('light UI keeps the actual image and immersive canvas neutral', async ({ page }) => {
  await page.goto('/');
  await selectChoice(await appearance(page), 'light');
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
  await expect(page.locator('.photo-stage')).toHaveCSS('background-color', 'rgb(27, 27, 27)');
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
  await selectChoice(control, 'system');
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
  await selectChoice(control, 'light');
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
