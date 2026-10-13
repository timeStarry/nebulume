// End-to-end smoke against the actual Rust command service, with optional UI QA.
// Run `cargo build -p neb-cli`, start `pnpm dev`, then `node scripts/smoke.mjs --ui`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type),
    size = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function fixture(index, width = 960, height = 640) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * (width * 3 + 1) + 1 + x * 3,
        horizon = height * (0.5 + 0.15 * Math.sin((x / width) * 5 + index));
      const sky = y < horizon;
      raw[p] = Math.min(255, Math.floor((sky ? 110 : 35) + (x / width) * 80 + index * 8));
      raw[p + 1] = Math.floor((sky ? 150 : 65) + (y / height) * 35);
      raw[p + 2] = Math.floor((sky ? 160 : 60) + index * 11);
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const root = await mkdtemp(join(tmpdir(), 'nebulume-smoke-'));
const photos = join(root, 'photos'),
  card = join(root, 'card'),
  destination = join(root, 'archive');
await Promise.all([photos, card, destination].map((p) => mkdir(p)));
for (let i = 0; i < 6; i++) await writeFile(join(photos, `Light-study-${i + 1}.png`), fixture(i));
await writeFile(join(card, 'Card-capture.png'), fixture(8, 120, 80));
const executable = resolve('target/debug', process.platform === 'win32' ? 'neb.exe' : 'neb');
const child = spawn(executable, ['--data-dir', join(root, 'catalog'), 'stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let seq = 0,
  stderr = '';
child.stderr.on('data', (d) => (stderr += d));
child.on('error', (e) => {
  for (const p of pending.values()) p.reject(e);
});
child.on('exit', (code) => {
  for (const p of pending.values()) p.reject(new Error(`Service exited ${code}: ${stderr}`));
});
createInterface({ input: child.stdout }).on('line', (line) => {
  const result = JSON.parse(line),
    p = pending.get(result.id);
  if (!p) return;
  pending.delete(result.id);
  result.error
    ? p.reject(Object.assign(new Error(result.error.message), result.error))
    : p.resolve(result.result);
});
function rpc(command, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, command, params }) + '\n');
  });
}
const checks = [];
let browser;
try {
  const info = await rpc('system.info');
  assert.equal(info.originals_read_only, true);
  const library = await rpc('library.add', { name: '光影试验 · Smoke', root: photos });
  assert.equal((await rpc('library.scan', { library_id: library.id })).indexed, 6);
  const assets = (await rpc('asset.list', {})).items;
  assert.equal(assets.length, 6);
  const asset = assets[0];
  const before = createHash('sha256')
    .update(await readFile(asset.path))
    .digest('hex');
  const histogram = await rpc('asset.histogram', { id: asset.id });
  assert.equal(histogram.red.length, 256);
  assert.equal(
    histogram.red.reduce((a, b) => a + b, 0),
    histogram.pixels,
  );
  await rpc('asset.rate', { id: asset.id, rating: 4 });
  await rpc('asset.crop', { id: asset.id, x: 0.25, y: 0.1, width: 0.5, height: 0.8 });
  const preview = await rpc('asset.preview', { id: asset.id, max_size: 1600 });
  assert.equal(preview.width, 480);
  assert.equal(preview.height, 512);
  const uncropped = await rpc('asset.preview', { id: asset.id, uncropped: true });
  assert.equal(uncropped.width, 960);
  const exported = join(root, 'crop.jpg');
  await rpc('asset.export', { id: asset.id, destination: exported });
  await assert.rejects(rpc('asset.export', { id: asset.id, destination: exported }));
  assert.equal(
    createHash('sha256')
      .update(await readFile(asset.path))
      .digest('hex'),
    before,
  );
  const plan = await rpc('import.plan', { source: card, destination, layout: 'preserve' });
  const imported = await rpc('import.execute', { plan_id: plan.id });
  assert.equal(imported.copied, 1);
  assert.equal(imported.originals_retained, true);
  const plan2 = await rpc('import.plan', { source: card, destination, layout: 'preserve' });
  const repeated = await rpc('import.execute', { plan_id: plan2.id });
  assert.equal(repeated.duplicates, 1);
  assert.equal((await rpc('import.history')).length, 2);
  checks.push(
    'real service: catalog/scan/rating/crop/histogram/export/original immutability/import/verified dedup/history',
  );

  if (process.argv.includes('--ui')) {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({
      headless: true,
      ...(process.env.NEB_BROWSER_CHANNEL ? { channel: process.env.NEB_BROWSER_CHANNEL } : {}),
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const exportPath = join(root, 'ui-export.jpg');
    await page.route('**/__neb_rpc', async (route) => {
      const { command, params } = route.request().postDataJSON();
      try {
        const result = await rpc(command, params);
        await route.fulfill({ json: { result } });
      } catch (e) {
        await route.fulfill({ json: { error: { code: e.code, message: e.message } } });
      }
    });
    await page.addInitScript(
      ({ exportPath }) => {
        window.isTauri = true;
        window.__TAURI_INTERNALS__ = {
          invoke: async (cmd, args) => {
            if (cmd === 'plugin:dialog|save') return exportPath;
            if (cmd === 'plugin:dialog|open') return null;
            if (cmd !== 'execute') throw new Error('Unexpected test IPC ' + cmd);
            const response = await fetch('/__neb_rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(args),
            });
            const value = await response.json();
            if (value.error) throw value.error;
            return value.result;
          },
        };
      },
      { exportPath },
    );
    await page.goto('http://127.0.0.1:5173');
    await page.locator('.thumbnail').first().waitFor();
    await page.locator('.thumbnail img').first().waitFor();
    await page.locator('.thumbnail').first().dblclick();
    await page.locator('.main-photo').waitFor();
    await page.getByRole('button', { name: '评为 5 星', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="评为 5 星"]')?.getAttribute('aria-pressed') === 'true',
    );
    await page.getByRole('button', { name: '裁剪', exact: true }).first().click();
    await page.getByLabel(/宽度/).fill('40');
    await page.getByRole('button', { name: '保存裁剪', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.crop-panel'));
    await page.getByRole('button', { name: '导出 JPEG', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes('已导出：'));
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/workspace-viewer.png', fullPage: true });
    await page.keyboard.press('g');
    await page.locator('.photo-grid').waitFor();
    await page.screenshot({ path: 'artifacts/workspace-grid.png', fullPage: true });
    await page.setViewportSize({ width: 960, height: 720 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({ path: 'artifacts/workspace-compact.png', fullPage: true });
    assert.deepEqual(errors, []);
    checks.push(
      'UI with real Rust bridge: grid/viewer/rating/crop/export; 1440 and 960 px layouts; no uncaught JS errors',
    );
    await browser.close();
    browser = undefined;
  }
  console.log(JSON.stringify({ passed: true, checks, temporary_fixture_root: root }, null, 2));
} finally {
  await browser?.close();
  child.stdin.end();
}
