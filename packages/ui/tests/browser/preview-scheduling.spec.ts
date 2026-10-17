import { expect, test, type Page } from '@playwright/test';
import type { Asset } from '../../src/model';
type Call = { command: string; params: Record<string, unknown> };
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const asset = (id: string, remote = true): Asset => ({
  id,
  library_id: 'scheduling',
  filename: `${id}.jpg`,
  path: `/test/${id}.jpg`,
  source_key: remote ? `${id}.jpg` : null,
  extension: 'jpg',
  kind: 'raster',
  size: 1000,
  modified_at: '',
  metadata: {},
  rating: 0,
  availability: remote ? 'remote' : 'available',
});
async function harness(page: Page, held: string[]) {
  const calls: Call[] = [];
  const finished: string[] = [];
  const errors: string[] = [];
  const gates = new Map<string, () => void>();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/__preview_scheduler_rpc', async (route) => {
    const call = route.request().postDataJSON() as Call;
    calls.push(call);
    const id = String(call.params.id);
    if (held.includes(id)) await new Promise<void>((resolve) => gates.set(id, resolve));
    await route.fulfill({ json: { data_url: image, width: 1, height: 1, source: 'fixture' } });
    finished.push(id);
  });
  await page.addInitScript(() => {
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
      IntersectionObserver: VisibilityObserver,
      previewVisibility: (filename: string, visible: boolean) => {
        for (const [target, callback] of observers)
          if ((target as HTMLElement).title === filename)
            callback(
              [{ target, isIntersecting: visible } as IntersectionObserverEntry],
              {} as IntersectionObserver,
            );
      },
      __TAURI_INTERNALS__: {
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
  });
  await page.goto('/tests/browser/preview-harness.html');
  await page.waitForFunction(() => !!window.previewHarness);
  return {
    calls,
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
const previews = (calls: Call[], size: number) =>
  calls
    .filter((call) => call.command === 'asset.preview' && call.params.max_size === size)
    .map((call) => String(call.params.id));

test('four slow remote thumbnails cannot block local viewer or thumbnails and switching cancels queued work', async ({
  page,
}) => {
  const fixture = await harness(page, ['remote-0', 'remote-1', 'remote-2', 'remote-3']);
  try {
    await page.evaluate(
      (assets) => window.previewHarness.thumbnails(assets),
      Array.from({ length: 8 }, (_, i) => asset(`remote-${i}`)),
    );
    await expect.poll(() => previews(fixture.calls, 420).length).toBe(4);
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
    expect(previews(fixture.calls, 2400)).toEqual(['local-viewer']);
    fixture.releaseAll();
    await expect
      .poll(() => fixture.finished.filter((id) => id.startsWith('remote-')).length)
      .toBe(4);
    expect(previews(fixture.calls, 420).filter((id) => id.startsWith('remote-'))).toHaveLength(4);
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
    await expect.poll(() => previews(fixture.calls, 420).length).toBe(4);
    await page.evaluate(() => window.previewVisibility('remote-4.jpg', false));
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('current-remote'));
    await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'current-remote.jpg');
    expect(previews(fixture.calls, 420)).toHaveLength(4);
    fixture.release('remote-0');
    await expect.poll(() => previews(fixture.calls, 420)).toContain('remote-7');
    expect(previews(fixture.calls, 420)).not.toContain('remote-4');
    const loaded = page.getByRole('button', { name: 'remote-0.jpg，0 星' }).locator('img');
    await expect(loaded).toBeVisible();
    await page.evaluate(() => {
      window.previewVisibility('remote-0.jpg', false);
      window.previewVisibility('remote-0.jpg', true);
    });
    await expect(loaded).toBeVisible();
    expect(previews(fixture.calls, 420).filter((id) => id === 'remote-0')).toHaveLength(1);
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
    await expect.poll(() => previews(fixture.calls, 2400)).toEqual(['active-a']);
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('active-b'));
    await expect.poll(() => previews(fixture.calls, 2400)).toEqual(['active-a', 'active-b']);
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('cancelled-c'));
    await page.evaluate((photo) => window.previewHarness.photo(photo), asset('current-d'));
    expect(previews(fixture.calls, 2400)).toEqual(['active-a', 'active-b']);
    fixture.release('active-a');
    await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'current-d.jpg');
    expect(previews(fixture.calls, 2400)).toEqual(['active-a', 'active-b', 'current-d']);
    expect(fixture.errors).toEqual([]);
  } finally {
    fixture.releaseAll();
  }
});
