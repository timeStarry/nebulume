import type { Page } from '@playwright/test';

const jpegBase64 =
  '/9j/4AAQSkZJRgABAQAAkACQAAD/4QCARXhpZgAATU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEo' +
  'AAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAACQAAAAAQAAAJAAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAA' +
  'AAGgAwAEAAAAAQAAAAEAAAAA/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYH' +
  'CAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYX' +
  'GBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqi' +
  'o6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEB' +
  'AQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRC' +
  'kaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5' +
  'eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz' +
  '9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4O' +
  'Dw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ' +
  'EBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/dyiiigD/9k=';
export const jpegBytes = Buffer.from(jpegBase64, 'base64');

/** Parses a `neb.localhost` path back into its id / tier / crop / revision / raw segments. */
export function parseNebUrl(raw: string) {
  const path = decodeURIComponent(new URL(raw).pathname).replace(/^\//, '');
  const [id, tier, crop, revision, mode] = path.split('/');
  return { id, tier, crop, revision, preferRaw: mode === 'raw' };
}

export type ImageGate = (path: {
  id: string;
  tier: string;
}) =>
  | true
  | { delay?: number; status?: number; message?: string }
  | Promise<true | { delay?: number; status?: number; message?: string }>;

export type ImageRequest = ReturnType<typeof parseNebUrl> & { url: string };
/**
 * Serves preview bytes for `neb` protocol URLs as the Windows webview sees them
 * (`http://neb.localhost/<encoded path>`). Init scripts must mock
 * `__TAURI_INTERNALS__.convertFileSrc` as `(p, s) => 'http://' + s + '.localhost/' + encodeURIComponent(p)`.
 */
export async function servePreviewImages(
  page: Page,
  gate?: ImageGate,
  onServed?: (id: string) => void,
): Promise<ImageRequest[]> {
  const requested: ImageRequest[] = [];
  await page.route('http://neb.localhost/**', async (route) => {
    const url = route.request().url();
    const parsed = parseNebUrl(url);
    requested.push({ ...parsed, url });
    const verdict = gate ? await gate(parsed) : true;
    if (verdict !== true && verdict.delay)
      await new Promise((resolve) => setTimeout(resolve, verdict.delay));
    try {
      if (verdict !== true && verdict.status)
        await route.fulfill({
          status: verdict.status,
          contentType: 'application/json',
          body: JSON.stringify({
            code: verdict.status === 409 ? 'E_DOWNLOAD_REQUIRED' : 'E_PREVIEW',
            message: verdict.message || 'fixture error',
          }),
        });
      else
        await route.fulfill({
          status: 200,
          contentType: 'image/jpeg',
          headers: {
            'access-control-allow-origin': '*',
            'cache-control': 'no-cache',
            etag: `"fixture-${parsed.id}-${parsed.revision}${parsed.preferRaw ? '-raw' : ''}"`,
          },
          body: jpegBytes,
        });
    } catch {
      // The page dropped the request (an aborted image load clears `src`).
    }
    onServed?.(parsed.id);
  });
  return requested;
}
