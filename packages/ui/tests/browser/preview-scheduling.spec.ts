import { expect, test, type Page } from '@playwright/test';
import type { Asset } from '../../src/model';
import { servePreviewImages, type ImageRequest } from './fixtures';
type Call = { command: string; params: Record<string, unknown> };
const asset = (id: string, remote = true, kind: Asset['kind'] = 'raster'): Asset => ({
  id,
  library_id: 'scheduling',
  filename: `${id}.jpg`,
  path: `/test/${id}.jpg`,
  source_key: remote ? `${id}.jpg` : null,
  extension: 'jpg',
  kind,
  size: 1000,
  modified_at: '',
  metadata: {},
  rating: 0,
  availability: remote ? 'remote' : 'available',
});
async function harness(
  page: Page,
  held: string[],
  options: { realObserver?: boolean; imageDelay?: number; failed?: string[] } = {},
) {
  const calls: Call[] = [];
  const finished: string[] = [];
  const errors: string[] = [];
  const gates = new Map<string, () => void>();
  const hold = (id: string) => new Promise<void>((resolve) => gates.set(id, resolve));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/__preview_scheduler_rpc', async (route) => {
    const call = route.request().postDataJSON() as Call;
    calls.push(call);
    const id = String(call.params.id);
    if (held.includes(id)) await hold(id);
    await route.fulfill({
      json: { width: 1, height: 1, source: 'fixture', tier: call.params.tier },
    });
    finished.push(id);
  });
  const images = await servePreviewImages(
    page,
    async ({ id, tier }) => {
      // Viewer IPC is the held step for viewer images; thumbnails are held at the protocol.
      if (tier !== 'p2560' && held.includes(id)) await hold(id);
      if (options.failed?.includes(id))
        return { status: 409, message: 'E_DOWNLOAD_REQUIRED: embedded preview exceeds budget' };
      return { delay: options.imageDelay };
    },
    (id) => finished.push(id),
  );
  await page.addInitScript((realObserver) => {
    if (realObserver) {
      Object.assign(window, { previewVisibility() {} });
    }
    const observers = new Map<Element, IntersectionObserverCallback>();
    class VisibilityObserver {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observers.set(target, this.callback);
        queueMicrotask(() => {
          if (observers.has(target))
            this.callback(
              [{ target, isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
        });
      }
      unobserve(target: Element) {
        observers.delete(target);
      }
      disconnect() {
        for (const [target, callback] of observers)
          if (callback === this.callback) observers.delete(target);
      }
    }
    Object.assign(window, {
      isTauri: true,
      ...(realObserver ? {} : { IntersectionObserver: VisibilityObserver }),
      previewVisibility: (filename: string, visible: boolean) => {
        for (const [target, callback] of observers)
          if ((target as HTMLElement).title === filename)
            callback(
              [{ target, isIntersecting: visible } as IntersectionObserverEntry],
              {} as IntersectionObserver,
            );
      },
      __TAURI_INTERNALS__: {
        convertFileSrc: (p: string, s: string) =>
          'http://' + s + '.localhost/' + encodeURIComponent(p),
        transformCallback: () => 1,
        unregisterCallback() {},
        metadata: { currentWindow: { label: 'scheduler' }, currentWebview: { label: 'scheduler' } },
        invoke: async (command: string, params: Record<string, unknown>) => {
          if (command !== 'execute') throw new Error(`Unexpected native command: ${command}`);
          return (
            await fetch('/__preview_scheduler_rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(params),
            })
          ).json();
        },
      },
    });
  }, !!options.realObserver);
  await page.goto('/tests/browser/preview-harness.html');
  await page.waitForFunction(() => !!window.previewHarness);
  return {
    calls,
    images,
    finished,
    errors,
    release: (id: string) => {
      gates.get(id)?.();
      gates.delete(id);
    },
    releaseAll: () => {
      for (const resolve of gates.values()) resolve();
      gates.clear();
    },
  };
}
const viewerCalls = (calls: Call[]) =>
  calls
    .filter((call) => call.command === 'asset.preview' && call.params.tier === 'p2560')
    .map((call) => String(call.params.id));
const thumbs = (images: ImageRequest[]) =>
  images.filter((image) => image.tier === 't512').map((image) => image.id);

test('four slow remote thumbnails cannot block local viewer or thumbnails and switching cancels queued work', async ({
  page,
}) => {
  const fixture = await harness(page, ['remote-0', 'remote-1', 'remote-2', 'remote-3']);
  try {
    await page.evaluate(
      (assets) => window.previewHarness.thumbnails(assets),
      Array.from({ length: 8 }, (_, i) => asset(`remote-${i}`)),
    );
    await expect.poll(() => thumbs(fixture.images).length).toBe(4);
    await page.evaluate(
      (photo) => window.previewHarness.photo(photo),
      asset('local-viewer', false),
    );
    await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'local-viewer.jpg');
    await page.evaluate(
      (photo) => window.previewHarness.thumbnails([photo]),
      asset('local-thumb', false),
    );
    await expect(
      page.getByRole('button', { name: 'local-thumb.jpg，0 星' }).locator('img'),
    ).toBeVisible();
    expect(viewerCalls(fixture.calls)).toEqual(['local-viewer']);
    fixture.releaseAll();
    await expect
      .poll(() => fixture.finished.filter((id) => id.startsWith('remote-')).length)
      .toBe(4);
    expect(thumbs(fixture.images).filter((id) => id.startsWith('remote-'))).toHaveLength(4);
    expect(fixture.errors).toEqual([]);
  } finally {
    fixture.releaseAll();
  }
});
test('current remote viewer bypasses the thumbnail backlog, offscreen queued work cancels, and loaded thumbnails persist', async ({
  page,
}) => {
  const fixture = await harness(page, ['remote-0', 'remote-1', 'remote-2', 'remote-3']);
  try {
    await page.evaluate(
      (assets) => window.previewHarness.thumbnails(assets),
      Array.from({ length: 8 }, (_, i) => asset(`remote-${i}`)),
    );
    await expect.poll(() => thumbs(fixture.images).length).toBe(4);
    await page.evaluate(() => window.previewVisibility('remote-4.jpg', false));
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('current-remote'));
    await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'current-remote.jpg');
    expect(thumbs(fixture.images)).toHaveLength(4);
    fixture.release('remote-0');
    await expect.poll(() => thumbs(fixture.images)).toContain('remote-7');
    expect(thumbs(fixture.images)).not.toContain('remote-4');
    const loaded = page.getByRole('button', { name: 'remote-0.jpg，0 星' }).locator('img');
    await expect(loaded).toBeVisible();
    await page.evaluate(() => {
      window.previewVisibility('remote-0.jpg', false);
      window.previewVisibility('remote-0.jpg', true);
    });
    await expect(loaded).toBeVisible();
    expect(thumbs(fixture.images).filter((id) => id === 'remote-0')).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  } finally {
    fixture.releaseAll();
  }
});
test('rapid viewer changes cancel an old queued current image without pretending to interrupt issued IPC', async ({
  page,
}) => {
  const fixture = await harness(page, ['active-a', 'active-b']);
  try {
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('active-a'));
    await expect.poll(() => viewerCalls(fixture.calls)).toEqual(['active-a']);
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('active-b'));
    await expect.poll(() => viewerCalls(fixture.calls)).toEqual(['active-a', 'active-b']);
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('cancelled-c'));
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('current-d'));
    expect(viewerCalls(fixture.calls)).toEqual(['active-a', 'active-b']);
    fixture.release('active-a');
    await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'current-d.jpg');
    expect(viewerCalls(fixture.calls)).toEqual(['active-a', 'active-b', 'current-d']);
    expect(fixture.errors).toEqual([]);
  } finally {
    fixture.releaseAll();
  }
});
test('scrolling away drops queued thumbnail loads so the newest cells get the lanes', async ({
  page,
}) => {
  const fixture = await harness(page, [], { realObserver: true, imageDelay: 400 });
  const assets = Array.from({ length: 600 }, (_, i) => asset(`cell-${i}`, i % 2 === 0));
  await page.evaluate((items) => window.previewHarness.thumbnails(items), assets);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const last = page.getByRole('button', { name: 'cell-599.jpg，0 星' }).locator('img');
  await expect(last).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'cell-596.jpg，0 星' }).locator('img'),
  ).toBeVisible();
  const firstScreen = new Set(assets.slice(0, 40).map((item) => item.id));
  const started = new Set(
    fixture.images.map((image) => image.id).filter((id) => firstScreen.has(id)),
  );
  expect(started.size).toBeLessThanOrEqual(8);
  expect(fixture.images.every((image) => image.tier === 't512')).toBe(true);
  expect(fixture.calls.filter((call) => call.command === 'asset.preview')).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
test('failed thumbnail shows fallback tile instead of a broken image', async ({ page }) => {
  const fixture = await harness(page, [], { failed: ['broken-raw'] });
  await page.evaluate(
    (items) => window.previewHarness.thumbnails(items),
    [asset('broken-raw', true, 'raw'), asset('fine', true)],
  );
  await expect(page.getByRole('button', { name: 'fine.jpg，0 星' }).locator('img')).toBeVisible();
  await expect.poll(() => fixture.images.map((image) => image.id)).toContain('broken-raw');
  const broken = page.getByRole('button', { name: 'broken-raw.jpg，0 星' });
  await expect(broken.locator('.thumbnail-fallback')).toHaveText('RAW');
  await expect(broken.locator('img')).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});
test('each thumbnail and the viewer image are requested exactly once on first display', async ({
  page,
}) => {
  const fixture = await harness(page, []);
  const items = Array.from({ length: 6 }, (_, i) => asset(`once-${i}`, i % 2 === 0));
  await page.evaluate((list) => window.previewHarness.thumbnails(list), items);
  for (const item of items)
    await expect(
      page.getByRole('button', { name: `${item.id}.jpg，0 星` }).locator('img'),
    ).toBeVisible();
  await page.evaluate((photo) => window.previewHarness.photo(photo), asset('once-viewer'));
  await expect(page.locator('.main-photo')).toHaveJSProperty('naturalWidth', 1);
  await page.waitForTimeout(200);
  const counts = new Map<string, number>();
  for (const image of fixture.images) counts.set(image.url, (counts.get(image.url) ?? 0) + 1);
  expect([...counts.values()].every((count) => count === 1)).toBe(true);
  expect(thumbs(fixture.images).sort()).toEqual(items.map((item) => item.id).sort());
  expect(fixture.images.filter((image) => image.tier === 'p2560').map((image) => image.id)).toEqual(
    ['once-viewer'],
  );
  expect(fixture.errors).toEqual([]);
});
test('a thumbnail that leaves the viewport mid-request keeps its lane slot until the request settles', async ({
  page,
}) => {
  const fixture = await harness(page, ['slow-0', 'slow-1', 'slow-2', 'slow-3']);
  try {
    await page.evaluate(
      (list) => window.previewHarness.thumbnails(list),
      Array.from({ length: 5 }, (_, i) => asset(`slow-${i}`)),
    );
    await expect.poll(() => thumbs(fixture.images).length).toBe(4);
    await page.evaluate(() => window.previewVisibility('slow-0.jpg', false));
    await page.waitForTimeout(200);
    expect(thumbs(fixture.images)).not.toContain('slow-4');
    fixture.release('slow-0');
    await expect.poll(() => thumbs(fixture.images)).toContain('slow-4');
    await page.evaluate(() => window.previewVisibility('slow-0.jpg', true));
    await expect(
      page.getByRole('button', { name: 'slow-0.jpg，0 星' }).locator('img'),
    ).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally {
    fixture.releaseAll();
  }
});
test('while the viewer tier is pending, an already decoded thumbnail fills the stage without a new request', async ({
  page,
}) => {
  const fixture = await harness(page, ['seen']);
  try {
    // 'seen' is held twice: first its thumbnail at the protocol, then its viewer IPC.
    await page.evaluate((list) => window.previewHarness.thumbnails(list), [asset('seen', false)]);
    await expect.poll(() => thumbs(fixture.images)).toContain('seen');
    fixture.release('seen');
    await expect(page.getByRole('button', { name: 'seen.jpg，0 星' }).locator('img')).toBeVisible();
    const before = fixture.images.length;
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('seen', false));
    const placeholder = page.locator('.photo-placeholder');
    await expect(placeholder).toBeVisible();
    expect(await placeholder.getAttribute('src')).toBe(
      fixture.images.find((image) => image.id === 'seen' && image.tier === 't512')!.url,
    );
    expect(fixture.images.slice(before).filter((image) => image.tier !== 'p2560')).toEqual([]);
    fixture.releaseAll();
    await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'seen.jpg');
    await expect(placeholder).toHaveCount(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    fixture.releaseAll();
  }
});
