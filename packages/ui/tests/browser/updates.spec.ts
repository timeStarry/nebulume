import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const { version: appVersion } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

type Fixture = {
  support: { supported: boolean; kind: string };
  update: null | { version: string; body: string };
};

async function mockDesktop(page: Page, fixture: Fixture) {
  await page.addInitScript((fixture: Fixture) => {
    const callbacks = new Map<number, (message: unknown) => void>();
    let callbackId = 0;
    const calls: string[] = [];
    Object.assign(window, {
      isTauri: true,
      __updateCalls: calls,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (message: unknown) => void) => {
          callbacks.set(++callbackId, callback);
          return callbackId;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        convertFileSrc: (path: string, scheme: string) =>
          `http://${scheme}.localhost/${encodeURIComponent(path)}`,
        invoke: async (command: string, params: Record<string, unknown>) => {
          calls.push(command);
          if (command === 'update_support') return fixture.support;
          if (command === 'prepare_for_update')
            return { cancelled_jobs: 0, pending_writes: 0, timed_out: false };
          if (command === 'plugin:updater|check') {
            if (!fixture.update) return null;
            return {
              rid: 1,
              currentVersion: '0.1.1',
              version: fixture.update.version,
              body: fixture.update.body,
              rawJson: {},
            };
          }
          if (command === 'plugin:updater|download') {
            const channel = params.onEvent as { id: number };
            const send = (index: number, message: unknown) =>
              callbacks.get(channel.id)?.({ index, message });
            send(0, { event: 'Started', data: { contentLength: 4 * 1024 * 1024 } });
            send(1, { event: 'Progress', data: { chunkLength: 2 * 1024 * 1024 } });
            await new Promise((resolve) => setTimeout(resolve, 300));
            send(2, { event: 'Progress', data: { chunkLength: 2 * 1024 * 1024 } });
            send(3, { event: 'Finished' });
            callbacks.get(channel.id)?.({ index: 4, end: true });
            return 2;
          }
          if (command === 'plugin:updater|install') return null;
          if (command === 'plugin:process|restart') return null;
          if (command === 'plugin:resources|close') return null;
          if (command === 'plugin:window|theme') return 'light';
          if (command === 'plugin:window|set_theme') return null;
          if (command === 'plugin:event|listen') return 1;
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'execute') {
            if (params.command === 'library.list' || params.command === 'storage.list') return [];
            if (params.command === 'system.info') return { originals_read_only: true };
            if (params.command === 'cache.status' || params.command === 'cache.settings') return {};
          }
          throw new Error('Unexpected update fixture: ' + command);
        },
      },
    });
  }, fixture);
}

async function openSettings(page: Page) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('tab', { name: '关于', exact: true }).click();
  return page.getByRole('region', { name: '关于与诊断' });
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __updateCalls: string[] }).__updateCalls);

test('about panel shows the build version and a manual up-to-date check', async ({ page }) => {
  await mockDesktop(page, { support: { supported: true, kind: 'installer' }, update: null });
  const about = await openSettings(page);
  await expect(about).toContainText(`Nebulume ${appVersion} · 桌面应用`);
  await about.getByRole('button', { name: '检查更新' }).click();
  await expect(about.getByRole('status')).toContainText('已是最新版本');
  await expect(about.getByRole('checkbox', { name: '自动检查更新' })).toBeChecked();
});

test('an available update shows notes, download progress, then prepares before installing', async ({
  page,
}) => {
  await mockDesktop(page, {
    support: { supported: true, kind: 'installer' },
    update: { version: '0.2.0', body: '修复若干问题' },
  });
  const about = await openSettings(page);
  await about.getByRole('button', { name: '检查更新' }).click();
  const prompt = page.getByRole('region', { name: 'Nebulume 0.2.0 可用' });
  await expect(prompt).toContainText('修复若干问题');
  await prompt.getByRole('button', { name: '立即重启安装' }).click();
  await expect(prompt.getByRole('progressbar', { name: '更新下载进度' })).toBeVisible();
  await expect(prompt).toContainText('正在下载 2.0/4.0 MB');
  await expect.poll(() => calls(page)).toContain('plugin:process|restart');
  const order = (await calls(page)).filter((command) =>
    [
      'plugin:updater|download',
      'prepare_for_update',
      'plugin:updater|install',
      'plugin:process|restart',
    ].includes(command),
  );
  expect(order).toEqual([
    'plugin:updater|download',
    'prepare_for_update',
    'plugin:updater|install',
    'plugin:process|restart',
  ]);
});

test('later dismisses the prompt without installing', async ({ page }) => {
  await mockDesktop(page, {
    support: { supported: true, kind: 'installer' },
    update: { version: '0.2.0', body: '' },
  });
  const about = await openSettings(page);
  await about.getByRole('button', { name: '检查更新' }).click();
  const prompt = page.getByRole('region', { name: 'Nebulume 0.2.0 可用' });
  await prompt.getByRole('button', { name: '稍后' }).click();
  await expect(prompt).toHaveCount(0);
  expect(await calls(page)).not.toContain('plugin:updater|download');
});

test('portable builds explain why updates are unavailable and offer no check', async ({ page }) => {
  await mockDesktop(page, { support: { supported: false, kind: 'portable' }, update: null });
  const about = await openSettings(page);
  await expect(about).toContainText('独立程序不支持自动更新');
  await expect(about.getByRole('button', { name: '检查更新' })).toHaveCount(0);
  expect(await calls(page)).not.toContain('plugin:updater|check');
});

test('browser demo does not check for updates', async ({ page }) => {
  const about = await openSettings(page);
  await expect(about).toContainText('浏览器演示不检查更新');
  await expect(about.getByRole('button', { name: '检查更新' })).toHaveCount(0);
});
