import { expect, test, type Page } from '@playwright/test';
import type { StorageConfig, TlsCertificate } from '../../src/model';

const endpointA = 'https://nas-a.local:5006/dav/';
const endpointB = 'https://nas-b.local:5006/dav/';
const fingerprintA = 'a1'.repeat(32);
const fingerprintB = 'b2'.repeat(32);
const confirmLabel = '我已核对该设备的 SHA-256 指纹，信任此连接使用这张证书。';
function certificate(endpoint: string, sha256 = fingerprintA): TlsCertificate {
  return {
    endpoint,
    sha256,
    subject: 'CN=Family NAS',
    issuer: 'CN=Home Certificate Authority',
    not_before: '2026-01-01T00:00:00Z',
    not_after: '2027-01-01T00:00:00Z',
    subject_alt_names: ['nas.local', '192.168.1.10'],
  };
}
type Request = { command: string; params: Record<string, unknown> };

// A test-only IPC fixture exercises UI policy; backend TLS is verified by Rust tests.
async function nativeFixture(
  page: Page,
  inspect: (endpoint: string) => Promise<TlsCertificate> = async (endpoint) =>
    certificate(endpoint),
) {
  const requests: Request[] = [];
  const sources: StorageConfig[] = [];
  await page.route('**/__storage_test_rpc', async (route) => {
    const request = route.request().postDataJSON() as Request;
    requests.push(request);
    try {
      let result: unknown;
      switch (request.command) {
        case 'library.list':
          result = [];
          break;
        case 'storage.list':
          result = sources;
          break;
        case 'asset.list':
          result = { items: [], total: 0 };
          break;
        case 'system.info':
          result = {};
          break;
        case 'storage.inspect_tls':
          result = await inspect(String(request.params.endpoint));
          break;
        case 'storage.add': {
          const previous = sources.find((source) => source.endpoint === request.params.endpoint);
          const source: StorageConfig = {
            id: previous?.id || `source-${sources.length + 1}`,
            name: String(request.params.name),
            kind: request.params.kind as 'webdav' | 's3',
            endpoint: String(request.params.endpoint),
            root: String(request.params.root || ''),
            connected: false,
            credential_status: 'session',
            remember_credentials: Boolean(request.params.remember_credentials),
            tls_certificate_sha256: request.params.tls_certificate_sha256 as string | null,
          };
          if (previous) sources.splice(sources.indexOf(previous), 1, source);
          else sources.push(source);
          result = source;
          break;
        }
        case 'storage.browse':
          result = { entries: [], next_cursor: null };
          break;
        default:
          throw new Error(`Unexpected fixture command: ${request.command}`);
      }
      await route.fulfill({ json: { result } });
    } catch (error) {
      await route.fulfill({
        json: { error: { code: 'TLS_TEST', message: (error as Error).message } },
      });
    }
  });
  await page.addInitScript(() => {
    const runtime = window as unknown as {
      isTauri: boolean;
      __TAURI_INTERNALS__: { invoke: (command: string, params: unknown) => Promise<unknown> };
    };
    runtime.isTauri = true;
    runtime.__TAURI_INTERNALS__ = {
      invoke: async (command, params) => {
        if (command !== 'execute') throw new Error(`Unexpected native command: ${command}`);
        const response = await fetch('/__storage_test_rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        const body = await response.json();
        if (body.error) throw body.error;
        return body.result;
      },
    };
  });
  await page.goto('/');
  return { requests, sources };
}

async function openConnection(page: Page, endpoint: string) {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '存储源', exact: true })
    .click();
  await page.getByRole('button', { name: '添加存储源', exact: true }).click();
  await page.getByLabel('显示名称').fill('Home NAS');
  await page.getByLabel('服务端地址').fill(endpoint);
  await page.getByRole('checkbox', { name: '将凭据保存到系统安全存储' }).uncheck();
}

test('HTTPS defaults to standard validation and LAN HTTP is explicitly marked without extra confirmation', async ({
  page,
}) => {
  const fixture = await nativeFixture(page);
  await openConnection(page, endpointA);
  await expect(page.getByRole('radio', { name: '标准校验 默认' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: confirmLabel })).toHaveCount(0);
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByRole('button', { name: '浏览目录', exact: true }).click();
  await expect(page.getByText('HTTPS · 标准校验')).toBeVisible();
  expect(
    fixture.requests.filter((request) => request.command === 'storage.inspect_tls'),
  ).toHaveLength(0);
  expect(
    fixture.requests.find((request) => request.command === 'storage.add')!.params
      .tls_certificate_sha256,
  ).toBeNull();
  await page.getByRole('button', { name: '关闭目录浏览' }).click();
  await openConnection(page, 'http://192.168.1.10:5005/dav/');
  await expect(page.getByText('HTTP · 未加密', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page
    .locator('.source-row')
    .filter({ hasText: 'http://192.168.1.10:5005/dav/' })
    .getByRole('button', { name: '浏览目录', exact: true })
    .click();
  await expect(page.getByText('HTTP · 未加密', { exact: true })).toBeVisible();
  expect(
    fixture.requests.filter((request) => request.command === 'storage.add').at(-1)!.params
      .tls_certificate_sha256,
  ).toBeNull();
});

test('device trust requires fingerprint review, sends no credentials during inspection, and supports restoring standard validation', async ({
  page,
}) => {
  const fixture = await nativeFixture(page);
  await openConnection(page, endpointA);
  await page.getByLabel('用户名', { exact: true }).fill('camera-user');
  await page.getByLabel('密码', { exact: true }).fill('test-only-secret');
  await page.getByRole('radio', { name: '信任此设备证书' }).check();
  await expect(page.getByRole('button', { name: '添加连接', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '读取设备证书', exact: true }).click();
  await expect(page.getByText('CN=Family NAS', { exact: true })).toBeVisible();
  await expect(page.getByText('CN=Home Certificate Authority', { exact: true })).toBeVisible();
  await expect(page.getByText('192.168.1.10', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: confirmLabel })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '添加连接', exact: true })).toBeDisabled();
  expect(
    fixture.requests.find((request) => request.command === 'storage.inspect_tls')!.params,
  ).toEqual({ endpoint: endpointA });
  await page.getByRole('checkbox', { name: confirmLabel }).check();
  await expect(page.getByRole('button', { name: '添加连接', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'test-results/storage-certificate-review.png' });
  await page.getByRole('button', { name: '重新读取证书', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: confirmLabel })).not.toBeChecked();
  await page.getByRole('checkbox', { name: confirmLabel }).check();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByRole('button', { name: '浏览目录', exact: true }).click();
  await expect(page.getByText('HTTPS · 已信任设备证书')).toBeVisible();
  expect(
    fixture.requests.find((request) => request.command === 'storage.add')!.params
      .tls_certificate_sha256,
  ).toBe(fingerprintA);
  await page.getByRole('button', { name: '连接设置 / 重连', exact: true }).click();
  await expect(page.getByLabel('服务端地址')).toHaveValue(endpointA);
  await expect(page.getByRole('radio', { name: '信任此设备证书' })).toBeChecked();
  await expect(page.getByRole('button', { name: '保存并重连' })).toBeEnabled();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '保存并重连' }).click();
  const retained = fixture.requests
    .filter((request) => request.command === 'storage.add')
    .at(-1)!.params;
  expect(retained.tls_certificate_sha256).toBe(fingerprintA);
  expect(retained).not.toHaveProperty('password');
  expect(retained).not.toHaveProperty('username');
  await page.getByRole('button', { name: '连接设置 / 重连', exact: true }).click();
  await page.getByRole('radio', { name: '标准校验 默认' }).check();
  await page.getByRole('button', { name: '保存并重连' }).click();
  await expect(page.getByText('HTTPS · 标准校验')).toBeVisible();
  expect(
    fixture.requests.filter((request) => request.command === 'storage.add').at(-1)!.params
      .tls_certificate_sha256,
  ).toBeNull();
  expect(fixture.sources).toHaveLength(1);
});

test('editing the endpoint clears confirmation and late responses cannot replace the new certificate', async ({
  page,
}) => {
  let releaseFirst!: (certificate: TlsCertificate) => void;
  const first = new Promise<TlsCertificate>((resolve) => {
    releaseFirst = resolve;
  });
  const fixture = await nativeFixture(page, (endpoint) =>
    endpoint === endpointA ? first : Promise.resolve(certificate(endpoint, fingerprintB)),
  );
  await openConnection(page, endpointA);
  await page.getByRole('radio', { name: '信任此设备证书' }).check();
  await page.getByRole('button', { name: '读取设备证书', exact: true }).click();
  await expect
    .poll(
      () => fixture.requests.filter((request) => request.command === 'storage.inspect_tls').length,
    )
    .toBe(1);
  await page.getByLabel('服务端地址').fill(endpointB);
  await page.getByRole('button', { name: '读取设备证书', exact: true }).click();
  await page.getByRole('checkbox', { name: confirmLabel }).check();
  releaseFirst(certificate(endpointA));
  await expect(page.locator('.certificate-fingerprint')).toHaveText('B2:'.repeat(31) + 'B2');
  await expect(page.getByRole('checkbox', { name: confirmLabel })).toBeChecked();
  await page.getByLabel('服务端地址').fill(endpointA);
  await expect(page.getByRole('checkbox', { name: confirmLabel })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加连接', exact: true })).toBeDisabled();
});

test('inspection failures remain visible and never enable device trust', async ({ page }) => {
  await nativeFixture(page, async () => {
    throw new Error('TLS handshake failed: connection refused');
  });
  await openConnection(page, endpointA);
  await page.getByRole('radio', { name: '信任此设备证书' }).check();
  await page.getByRole('button', { name: '读取设备证书', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法连接到设备');
  await expect(page.getByRole('alert').locator('pre')).not.toBeVisible();
  await page.getByText('查看错误详情', { exact: true }).click();
  await expect(page.getByRole('alert').locator('pre')).toHaveText(
    'TLS handshake failed: connection refused',
  );
  await expect(page.getByRole('button', { name: '添加连接', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: confirmLabel })).toHaveCount(0);
});

test('browser demonstration shows native-required state instead of simulating certificate access', async ({
  page,
}) => {
  await page.goto('/');
  await openConnection(page, endpointA);
  await expect(page.getByRole('status')).toContainText('需要 Nebulume 桌面版');
  await page.getByRole('radio', { name: '信任此设备证书' }).check();
  await expect(page.getByRole('button', { name: '读取设备证书', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '添加连接', exact: true })).toBeDisabled();
});
