import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
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
/**
 * Fetches and decodes an image into the element that will be displayed, so each image costs
 * one request and one decode. Settles only when the request does (load+decode or error):
 * `src` is never cleared, because that would hide a backend render that keeps running.
 * Callers that stop caring detach through the scheduler's `rejectInFlightOnAbort`.
 */
export function loadImage(
  url: string,
  image: HTMLImageElement = new Image(),
): Promise<HTMLImageElement> {
  image.decoding = 'async';
  image.src = url;
  return image.decode().then(
    () => image,
    () => {
      throw new Error('E_PREVIEW_LOAD: 预览图像载入失败');
    },
  );
}
/**
 * Calls `onChange` whenever the device pixel ratio changes (zoom, moving between monitors).
 * A `resolution` query matches one ratio only, so it is re-registered after every change.
 */
export function watchDevicePixelRatio(
  onChange: (devicePixelRatio: number) => void,
  win: Pick<Window, 'devicePixelRatio' | 'matchMedia'> = window,
): () => void {
  let query: MediaQueryList | undefined;
  const listen = () => {
    query?.removeEventListener('change', update);
    query = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    query.addEventListener('change', update);
  };
  function update() {
    onChange(win.devicePixelRatio || 1);
    listen();
  }
  listen();
  return () => query?.removeEventListener('change', update);
}
