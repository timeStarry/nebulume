import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { abortError } from './concurrency';
import { demoPreviewUrl } from './demo';
import { TIER_PIXELS, type Asset, type PreviewTier } from './model';

export { TIER_PIXELS, type PreviewTier };
const tiers = Object.keys(TIER_PIXELS) as PreviewTier[];

/** Smallest tier whose long side covers the displayed device pixels. */
export function previewTier(cssPixels: number, devicePixelRatio: number): PreviewTier {
  const needed = Math.ceil(cssPixels * (devicePixelRatio || 1));
  return tiers.find((tier) => TIER_PIXELS[tier] >= needed) ?? 'p2560';
}
/** Grid cells never ask for the viewer tier, even at the largest slider size on high-DPI screens. */
export function gridTier(thumbSize: number, devicePixelRatio: number): PreviewTier {
  const tier = previewTier(thumbSize, devicePixelRatio);
  return tier === 'p2560' ? 't1024' : tier;
}
/**
 * Desktop: a `neb` protocol URL carrying everything in the path (`convertFileSrc` encodes `?`).
 * Browser demo: a cached `blob:` URL, produced asynchronously.
 */
export function previewUrl(
  asset: Pick<Asset, 'id' | 'preview_revision'>,
  tier: PreviewTier,
  uncropped = false,
): string | Promise<string> {
  const revision = asset.preview_revision || 0;
  if (!isTauri()) return demoPreviewUrl(asset.id, tier, uncropped, revision);
  return convertFileSrc(`${asset.id}/${tier}/${uncropped ? 1 : 0}/${revision}`, 'neb');
}
/** Fetches and decodes an image; aborting clears `src` so the webview drops the request. */
export async function loadImage(
  url: string | Promise<string>,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  if (signal?.aborted) throw abortError('Image load cancelled');
  const resolved = await url;
  if (signal?.aborted) throw abortError('Image load cancelled');
  const image = new Image();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      image.src = '';
      reject(abortError('Image load cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    image.src = resolved;
    image.decode().then(
      () => {
        signal?.removeEventListener('abort', abort);
        if (settled) return;
        settled = true;
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      },
      () => {
        signal?.removeEventListener('abort', abort);
        if (settled) return;
        settled = true;
        reject(new Error('E_PREVIEW_LOAD: 预览图像载入失败'));
      },
    );
  });
}
