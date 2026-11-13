import { schedulePreview } from './api';
import { untilAborted } from './concurrency';
import type { Asset, Preview } from './model';
import { loadImage } from './preview-url';

const MAX_FRAMES = 12;
const MAX_IMAGES = 14;

export interface CachedViewerFrame {
  data: Preview;
  image: HTMLImageElement;
}

interface PoolEntry {
  request: Promise<HTMLImageElement>;
  image?: HTMLImageElement;
}

const frameCache = new Map<string, CachedViewerFrame>();
const imagePool = new Map<string, PoolEntry>();

export function viewerFrameKey(
  requestKey: string,
  asset: Pick<Asset, 'modified_at' | 'size'>,
): string {
  return `${requestKey}|${asset.modified_at || ''}|${asset.size ?? ''}`;
}

function prepareMainPhoto(source: HTMLImageElement, alt: string): HTMLImageElement {
  const image = source.isConnected ? (source.cloneNode(false) as HTMLImageElement) : source;
  image.className = 'main-photo';
  image.alt = alt;
  image.draggable = false;
  return image;
}

export function getViewerFrame(key: string, alt: string): CachedViewerFrame | undefined {
  const hit = frameCache.get(key);
  if (!hit) return undefined;
  frameCache.delete(key);
  frameCache.set(key, hit);
  return {
    data: hit.data,
    image: prepareMainPhoto(hit.image, alt),
  };
}

export function rememberViewerFrame(key: string, data: Preview, image: HTMLImageElement): void {
  frameCache.delete(key);
  frameCache.set(key, { data, image });
  while (frameCache.size > MAX_FRAMES) {
    const oldest = frameCache.keys().next().value;
    if (oldest === undefined) break;
    frameCache.delete(oldest);
  }
}

function rememberPoolEntry(url: string, entry: PoolEntry): void {
  imagePool.delete(url);
  imagePool.set(url, entry);
  while (imagePool.size > MAX_IMAGES) {
    const oldest = imagePool.keys().next().value;
    if (oldest === undefined) break;
    imagePool.delete(oldest);
  }
}

/**
 * Prefetches and decodes a local viewer-tier image in the background so forward/backward
 * navigation can adopt either the finished bitmap or the in-flight decode without re-requesting.
 */
export function prefetchViewerImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  const existing = imagePool.get(url);
  if (existing) {
    rememberPoolEntry(url, existing);
    return existing.image ? Promise.resolve(existing.image) : untilAborted(existing.request, signal);
  }
  const image = document.createElement('img');
  image.className = 'main-photo';
  image.draggable = false;
  const request = schedulePreview(() => loadImage(url, image), {
    source: 'local',
    priority: 'viewer',
    signal,
  });
  const entry: PoolEntry = { request };
  rememberPoolEntry(url, entry);
  request.then(
    (decoded) => {
      entry.image = decoded;
    },
    () => {
      if (imagePool.get(url) === entry) imagePool.delete(url);
    },
  );
  return request;
}

/**
 * Resolves a decoded `.main-photo` element for `url`, reusing a prefetched or in-flight decode
 * when available instead of issuing a second decode request.
 */
export async function acquireViewerImage(
  url: string,
  alt: string,
  lane: { source: 'local' | 'remote'; priority: 'viewer'; signal: AbortSignal },
): Promise<HTMLImageElement> {
  const existing = imagePool.get(url);
  if (existing?.image) {
    rememberPoolEntry(url, existing);
    return prepareMainPhoto(existing.image, alt);
  }
  if (existing) {
    const decoded = await untilAborted(existing.request, lane.signal);
    return prepareMainPhoto(decoded, alt);
  }
  const image = document.createElement('img');
  image.className = 'main-photo';
  image.alt = alt;
  image.draggable = false;
  const request = schedulePreview(() => loadImage(url, image), {
    ...lane,
    rejectInFlightOnAbort: true,
  });
  const entry: PoolEntry = { request };
  rememberPoolEntry(url, entry);
  lane.signal.addEventListener(
    'abort',
    () => {
      if (!entry.image && imagePool.get(url) === entry) imagePool.delete(url);
    },
    { once: true },
  );
  try {
    const decoded = await request;
    entry.image = decoded;
    return prepareMainPhoto(decoded, alt);
  } catch (error) {
    if (imagePool.get(url) === entry) imagePool.delete(url);
    throw error;
  }
}
