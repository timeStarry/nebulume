import { expect, test, type Page } from '@playwright/test';
import type { CacheMigration, CacheStats } from '../../src/cache-model';
import type { Asset } from '../../src/model';
const GiB = 1024 ** 3;
type Request = { command: string; params: Record<string, unknown> };

async function nativeCache(
  page: Page,
  options: { offline?: boolean; statsError?: boolean; remote?: boolean } = {},
) {
  const requests: Request[] = [];
  const state: CacheStats = {
    policy: { budget_bytes: 10 * GiB, max_unused_days: 30, preview_policy: 'automatic' },
    location: {
      path: 'C:\\Nebulume\\Cache',
      state: options.offline ? 'offline' : 'online',
      available_bytes: options.offline ? null : 80 * GiB,
    },
    usage: {
      total_bytes: 7.8 * GiB,
      originals_bytes: 6.9 * GiB,
      previews_bytes: 0.6 * GiB,
      temporary_bytes: 0.3 * GiB,
      pinned_bytes: 1.4 * GiB,
      reserved_bytes: 0,
      unmanaged_bytes: 0,
      in_use_bytes: 0.2 * GiB,
    },
    objects_count: 20,
    pinned: [
      {
        asset_id: 'remote-photo',
        name: 'Remote.NEF',
        size: 1.4 * GiB,
        last_used: '2026-10-16T10:00:00Z',
      },
    ],
    migration: null,
  };
  const asset: Asset = {
    id: 'remote-photo',
    library_id: 'remote-library',
    filename: 'Remote.NEF',
    path: '',
    source_key: 'Trip/Remote.NEF',
    cache_pinned: false,
    extension: 'nef',
    kind: 'raw',
    size: 12_000,
    modified_at: '2026-10-16T10:00:00Z',
    rating: 0,
    metadata: {},
    availability: 'remote',
  };
  const control = {
    paths: ['D:\\NebulumeCache'],
    statsErrors: options.statsError ? 1 : 0,
    policyError: '',
    pruneError: '',
    pinError: '',
    migrationStatus: 'running' as CacheMigration['status'],
    getCalls: 0,
  };
  await page.route('**/__cache_rpc', async (route) => {
    const request = route.request().postDataJSON() as Request;
    requests.push(request);
    try {
      let result: unknown;
      switch (request.command) {
        case 'library.list':
          result = options.remote
            ? [
                {
                  id: 'remote-library',
                  name: '远端相册',
                  root: '/Photos',
                  created_at: '2026-10-16',
                  source_kind: 'webdav',
                  connected: true,
                },
              ]
            : [];
          break;
        case 'storage.list':
          result = [];
          break;
        case 'system.info':
          result = {};
          break;
        case 'asset.list':
          result = { items: options.remote ? [asset] : [], total: options.remote ? 1 : 0 };
          break;
        case 'library.capture_index.status':
          result = {
            library_id: request.params.library_id,
            total: 1,
            known: 1,
            missing: 0,
            pending: 0,
            job: null,
          };
          break;
        case 'asset.get':
          result = asset;
          break;
        case 'asset.preview':
          result = {
            data_url:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
            width: 1,
            height: 1,
            source: 'embedded_jpeg',
          };
          break;
        case 'asset.histogram':
          result = {
            red: Array(256).fill(1),
            green: Array(256).fill(1),
            blue: Array(256).fill(1),
            luminance: Array(256).fill(1),
            pixels: 256,
          };
          break;
        case 'cache.stats':
          if (control.statsErrors-- > 0)
            throw new Error('E_CACHE_OFFLINE: cache volume unavailable');
          result = state;
          break;
        case 'cache.policy.set':
          if (control.policyError) throw new Error(control.policyError);
          state.policy = { ...state.policy, ...request.params } as CacheStats['policy'];
          result = state;
          break;
        case 'cache.prune':
          if (control.pruneError) throw new Error(control.pruneError);
          result = {
            reclaimable_bytes: 2 * GiB,
            freed_bytes: request.params.dry_run ? 0 : 2 * GiB,
            skipped_bytes: 1.6 * GiB,
          };
          if (!request.params.dry_run) {
            state.usage.originals_bytes -= 2 * GiB;
            state.usage.total_bytes -= 2 * GiB;
          }
          break;
        case 'cache.location.check':
          result = {
            path: request.params.path,
            valid: !String(request.params.path).startsWith('R:'),
            reason: '目录为只读',
            available_bytes: 40 * GiB,
          };
          break;
        case 'cache.migration.plan': {
          const copied =
            request.params.mode === 'pinned' ? state.usage.pinned_bytes : state.usage.total_bytes;
          result = {
            plan_id: 'plan-1',
            from_path: state.location.path,
            to_path: request.params.path,
            bytes: copied,
            extra_bytes: copied,
            budget_overage_bytes: Math.max(
              0,
              state.usage.total_bytes + copied - state.policy.budget_bytes,
            ),
            available_bytes: 40 * GiB,
            can_start: true,
          };
          break;
        }
        case 'cache.migration.start':
          state.migration = {
            id: 'migration-1',
            status: 'running',
            from_path: state.location.path,
            to_path: 'D:\\NebulumeCache',
            total_bytes: state.usage.total_bytes,
            copied_bytes: 0,
          };
          result = state.migration;
          break;
        case 'cache.migration.get': {
          control.getCalls++;
          state.migration = {
            ...state.migration!,
            status: control.migrationStatus,
            copied_bytes:
              control.migrationStatus === 'completed'
                ? state.migration!.total_bytes
                : state.migration!.total_bytes / 2,
            error:
              control.migrationStatus === 'failed' ? 'E_CACHE_IO: destination disconnected' : null,
          };
          if (control.migrationStatus === 'completed')
            state.location.path = state.migration.to_path;
          result = state.migration;
          break;
        }
        case 'cache.migration.cancel':
          state.migration = { ...state.migration!, status: 'cancelled' };
          result = state.migration;
          break;
        case 'asset.offline.set':
          if (control.pinError) throw new Error(control.pinError);
          asset.cache_pinned = Boolean(request.params.pinned);
          if (!request.params.pinned)
            state.pinned = state.pinned.filter((item) => item.asset_id !== request.params.id);
          result = { pinned: asset.cache_pinned };
          break;
        case '__directory':
          result = control.paths.shift() ?? null;
          break;
        default:
          throw new Error(`Unexpected cache test command: ${request.command}`);
      }
      await route.fulfill({ json: { result } });
    } catch (cause) {
      await route.fulfill({
        json: { error: { code: 'CACHE_TEST', message: (cause as Error).message } },
      });
    }
  });
  await page.addInitScript(() => {
    let callback = 0;
    const runtime = window as unknown as {
      isTauri: boolean;
      __TAURI_INTERNALS__: Record<string, unknown>;
      __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown>;
    };
    runtime.isTauri = true;
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    runtime.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'cache-test' }, currentWebview: { label: 'cache-test' } },
      transformCallback: () => ++callback,
      unregisterCallback() {},
      invoke: async (command: string, params: Record<string, unknown>) => {
        if (command.startsWith('plugin:event|')) return 1;
        if (command === 'plugin:window|theme') return 'dark';
        if (command === 'plugin:window|set_theme') return null;
        const request =
          command === 'plugin:dialog|open' ? { command: '__directory', params } : params;
        if (command !== 'execute' && command !== 'plugin:dialog|open')
          throw new Error(`Unexpected native command: ${command}`);
        const response = await fetch('/__cache_rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });
        const body = await response.json();
        if (body.error) throw body.error;
        return body.result;
      },
    };
  });
  await page.goto('/');
  return { state, control, requests };
}
async function settings(page: Page) {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
}
async function expectCompactDialogChoices(page: Page, choices: number) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.cache-checkbox')).toHaveCount(choices);
  const geometry = await dialog.evaluate((node) => ({
    width: node.clientWidth,
    scroll: node.scrollWidth,
    choices: [...node.querySelectorAll<HTMLElement>('.cache-checkbox')].map((label) => {
      const input = label.querySelector<HTMLInputElement>('input')!;
      const text = label.querySelector<HTMLElement>('span')!;
      const row = label.getBoundingClientRect();
      const box = input.getBoundingClientRect();
      const copy = text.getBoundingClientRect();
      return {
        inputWidth: box.width,
        inputLeft: box.left - row.left,
        gap: copy.left - box.right,
        textRight: copy.right,
        rowRight: row.right,
        textWidth: text.clientWidth,
        textScroll: text.scrollWidth,
      };
    }),
  }));
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
  for (const choice of geometry.choices) {
    expect(choice.inputWidth).toBeGreaterThanOrEqual(16);
    expect(choice.inputWidth).toBeLessThanOrEqual(20);
    expect(choice.inputLeft).toBeGreaterThanOrEqual(0);
    expect(choice.inputLeft).toBeLessThanOrEqual(16);
    expect(choice.gap).toBeGreaterThanOrEqual(6);
    expect(choice.gap).toBeLessThanOrEqual(10);
    expect(choice.textRight).toBeLessThanOrEqual(choice.rowRight + 1);
    expect(choice.textScroll).toBeLessThanOrEqual(choice.textWidth + 1);
  }
}
for (const width of [1440, 720, 390])
  test(`cache choices stay compact without horizontal overflow at ${width}px`, async ({ page }) => {
    const fixture = await nativeCache(page);
    await settings(page);
    await page.setViewportSize({ width, height: 960 });
    await page.getByRole('button', { name: '清理缓存…', exact: true }).click();
    await expect(page.getByRole('button', { name: '清理所选缓存', exact: true })).toBeEnabled();
    await expectCompactDialogChoices(page, 3);
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    fixture.control.paths = ['D:\\NebulumeCache'];
    await page.getByRole('button', { name: '更改缓存位置…', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: /允许本次迁移临时超过总上限/ })).toBeVisible();
    await expectCompactDialogChoices(page, 3);
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  });
test('browser settings honestly require desktop without fabricated cache statistics', async ({
  page,
}) => {
  await page.goto('/');
  await settings(page);
  await expect(page.getByText('缓存位置、容量和离线保留需在桌面应用中设置。')).toBeVisible();
  await expect(page.getByLabel('缓存总上限，GiB')).toHaveCount(0);
});
test('cache errors retry, invalid capacity is blocked, and service rejection preserves the policy', async ({
  page,
}) => {
  const fixture = await nativeCache(page, { statsError: true });
  await settings(page);
  await expect(page.getByRole('alert')).toContainText('cache volume unavailable');
  await page.locator('.cache-settings').getByRole('button', { name: '重试', exact: true }).click();
  const limit = page.getByLabel('缓存总上限，GiB');
  await expect(limit).toHaveValue('10');
  await limit.fill('1');
  await expect(page.locator('#cache-budget-help')).toContainText('至少需要 2 GiB');
  await expect(page.getByRole('button', { name: '保存缓存策略' })).toBeDisabled();
  expect(fixture.requests.filter((r) => r.command === 'cache.policy.set')).toHaveLength(0);
  await limit.fill('12');
  await page.getByRole('button', { name: '保存缓存策略' }).click();
  await expect(limit).toHaveValue('12');
  fixture.control.policyError = 'E_CACHE_IN_USE: protected contents exceed requested budget';
  await limit.fill('3');
  await page.getByRole('button', { name: '保存缓存策略' }).click();
  await page.getByRole('button', { name: '应用上限', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'protected contents exceed requested budget',
  );
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(fixture.state.policy.budget_bytes).toBe(12 * GiB);
});
test('offline cache permits local limit increases and never switches path', async ({ page }) => {
  const fixture = await nativeCache(page, { offline: true });
  await settings(page);
  await page.getByLabel('缓存总上限，GiB').fill('9');
  await expect(page.locator('#cache-budget-help')).toContainText('降低需连接后核对');
  await page.getByLabel('缓存总上限，GiB').fill('12');
  await page.getByRole('button', { name: '保存缓存策略' }).click();
  await expect(page.getByLabel('缓存总上限，GiB')).toHaveValue('12');
  expect(fixture.state.location.path).toBe('C:\\Nebulume\\Cache');
  await expect(page.getByRole('button', { name: '清理缓存…', exact: true })).toBeDisabled();
});
test('cleanup previews selected classes before mutation and pin removal is separate', async ({
  page,
}) => {
  const fixture = await nativeCache(page);
  await settings(page);
  await page.getByRole('button', { name: '清理缓存…', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('预计释放');
  expect(
    fixture.requests.filter((r) => r.command === 'cache.prune' && !r.params.dry_run),
  ).toHaveLength(0);
  await page.getByRole('checkbox', { name: '预览与缩略图', exact: true }).check();
  await expect(page.getByRole('button', { name: '清理所选缓存', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '清理所选缓存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    fixture.requests.find((r) => r.command === 'cache.prune' && !r.params.dry_run)?.params,
  ).toEqual({ originals: true, previews: true, temporary: true, dry_run: false });
  expect(fixture.state.pinned).toHaveLength(1);
  await page.getByRole('button', { name: '解除 Remote.NEF 的离线保留' }).click();
  await page.getByRole('button', { name: '解除固定', exact: true }).click();
  await expect(page.getByText('尚无离线固定的原图。')).toBeVisible();
});
test('migration validates directories, authorizes bounded extra space, and resumes real polling after navigation', async ({
  page,
}) => {
  const fixture = await nativeCache(page);
  fixture.state.policy.budget_bytes = 8 * GiB;
  fixture.control.paths = ['R:\\Cache', 'D:\\NebulumeCache'];
  await settings(page);
  await page.getByRole('button', { name: '更改缓存位置…' }).click();
  await expect(page.getByRole('dialog')).toContainText('目录为只读');
  await expect(page.getByRole('button', { name: '开始迁移', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重新选择…' }).click();
  await page.getByRole('radio', { name: '仅保留离线内容，其余重建' }).check();
  await expect(page.getByRole('dialog')).toContainText('临时额外空间');
  await expect(page.getByRole('button', { name: '开始迁移', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /允许本次迁移临时超过总上限/ }).check();
  await page.getByRole('button', { name: '开始迁移', exact: true }).click();
  await expect(page.getByRole('region', { name: '缓存迁移状态' })).toContainText('正在迁移缓存');
  await expect(page.getByLabel('缓存总上限，GiB')).toBeDisabled();
  await expect.poll(() => fixture.control.getCalls).toBeGreaterThan(0);
  expect(fixture.state.location.path).toBe('C:\\Nebulume\\Cache');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '图片库', exact: true })
    .click();
  fixture.control.migrationStatus = 'completed';
  await settings(page);
  await expect(page.getByRole('region', { name: '缓存迁移状态' })).toContainText('缓存迁移完成');
  await expect(page.locator('.cache-path').first()).toHaveText('D:\\NebulumeCache');
  expect(
    fixture.requests.find((r) => r.command === 'cache.migration.start')?.params.allow_overage,
  ).toBe(true);
  expect(
    fixture.requests.some(
      (r) => r.command === 'cache.migration.plan' && r.params.mode === 'pinned',
    ),
  ).toBe(true);
});
test('migration copies within the total budget do not request an over-budget authorization', async ({
  page,
}) => {
  const fixture = await nativeCache(page);
  fixture.state.policy.budget_bytes = 20 * GiB;
  await settings(page);
  await page.getByRole('button', { name: '更改缓存位置…' }).click();
  await expect(page.getByRole('dialog')).toContainText('临时额外空间');
  await expect(page.getByRole('checkbox', { name: /允许本次迁移临时超过总上限/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始迁移', exact: true })).toBeEnabled();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(
    fixture.requests.filter((request) => request.command === 'cache.migration.start'),
  ).toHaveLength(0);
  expect(fixture.state.location.path).toBe('C:\\Nebulume\\Cache');
});
test('failed migration retains old location and cancellation uses the service', async ({
  page,
}) => {
  const fixture = await nativeCache(page);
  await settings(page);
  await page.getByRole('button', { name: '更改缓存位置…' }).click();
  await page.getByRole('checkbox', { name: /允许本次迁移临时超过总上限/ }).check();
  fixture.control.migrationStatus = 'failed';
  await page.getByRole('button', { name: '开始迁移', exact: true }).click();
  await expect(page.getByRole('region', { name: '缓存迁移状态' })).toContainText(
    'destination disconnected',
  );
  expect(fixture.state.location.path).toBe('C:\\Nebulume\\Cache');
  await page.getByRole('button', { name: '重新检查并重试…' }).click();
  await page.getByRole('checkbox', { name: /允许本次迁移临时超过总上限/ }).check();
  fixture.control.migrationStatus = 'running';
  await page.getByRole('button', { name: '开始迁移', exact: true }).click();
  await page.getByRole('button', { name: '取消迁移…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消迁移', exact: true }).click();
  await expect(page.getByRole('region', { name: '缓存迁移状态' })).toContainText('缓存迁移已取消');
  expect(fixture.state.location.path).toBe('C:\\Nebulume\\Cache');
});
test('remote inspector pin is explicit, uses metadata state, and surfaces backend failure', async ({
  page,
}) => {
  const fixture = await nativeCache(page, { remote: true });
  await page
    .getByRole('button', { name: /远端相册/ })
    .first()
    .click();
  await page.getByRole('button', { name: '影像详情（I）', exact: true }).click();
  const pin = page.getByRole('button', { name: '离线保留', exact: true });
  await expect(pin).toBeEnabled();
  expect(fixture.requests.filter((r) => r.command === 'asset.offline.set')).toHaveLength(0);
  fixture.control.pinError = 'E_CACHE_FULL: no unprotected space';
  await pin.click();
  await expect(page.getByRole('alert')).toContainText('no unprotected space');
  fixture.control.pinError = '';
  await pin.click();
  await expect(page.getByRole('button', { name: '解除离线保留', exact: true })).toBeVisible();
});
