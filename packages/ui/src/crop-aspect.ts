/**
 * Photographer aspect-ratio crop presets and normalized `[0, 1]` coordinate math.
 * Accounts for source pixel dimensions (`imageWidth / imageHeight`) so a `1:1` or
 * `3:2` crop produces exact pixel aspect ratios on any landscape or portrait frame.
 */
import { cropFromPoints, type Crop } from './model';

export type AspectPreset = 'free' | 'original' | '3:2' | '4:3' | '16:9' | '4:5' | '1:1';

export const ASPECT_PRESETS: ReadonlyArray<{ id: AspectPreset; label: string }> = [
  { id: 'free', label: '自由' },
  { id: 'original', label: '原图' },
  { id: '3:2', label: '3:2' },
  { id: '4:3', label: '4:3' },
  { id: '16:9', label: '16:9' },
  { id: '4:5', label: '4:5' },
  { id: '1:1', label: '1:1' },
];

const BASE_RATIOS: Record<Exclude<AspectPreset, 'free' | 'original'>, number> = {
  '3:2': 3 / 2,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
  '4:5': 4 / 5,
  '1:1': 1,
};

const MIN_SPAN = 0.005;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Returns target pixel `width / height` ratio, or `null` when unconstrained (`free`). */
export function resolveAspectRatio(
  preset: AspectPreset,
  swapped: boolean,
  imageWidth: number,
  imageHeight: number,
): number | null {
  if (preset === 'free') return null;
  const safeW = Math.max(1, imageWidth || 1);
  const safeH = Math.max(1, imageHeight || 1);
  const base = preset === 'original' ? safeW / safeH : BASE_RATIOS[preset];
  return swapped ? 1 / base : base;
}

/** Converts a target pixel `width / height` ratio into normalized `[0..1]` crop ratio. */
function normalizedRatio(pixelAspect: number, imageWidth: number, imageHeight: number): number {
  const imageAspect = Math.max(1, imageWidth || 1) / Math.max(1, imageHeight || 1);
  return Math.max(0.01, Math.min(100, pixelAspect / imageAspect));
}

/**
 * Fits `current` crop to `pixelAspect` around its center (or maximizes around center when
 * near full-frame), staying strictly inside `[0, 1] × [0, 1]`.
 */
export function fitCropToAspect(
  current: Crop,
  pixelAspect: number | null,
  imageWidth: number,
  imageHeight: number,
): Crop {
  if (!pixelAspect) return current;
  const norm = normalizedRatio(pixelAspect, imageWidth, imageHeight);
  const cx = clamp01(current.x + current.width / 2);
  const cy = clamp01(current.y + current.height / 2);

  // Start from current crop area if already cropped, or maximal centered frame if full-frame.
  const isNearFull = current.width >= 0.99 && current.height >= 0.99;
  let width: number;
  let height: number;
  if (isNearFull) {
    if (norm >= 1) {
      width = 1;
      height = 1 / norm;
    } else {
      height = 1;
      width = norm;
    }
  } else {
    const area = Math.max(MIN_SPAN * MIN_SPAN, current.width * current.height);
    width = Math.sqrt(area * norm);
    height = width / norm;
    const scale = Math.min(1, 1 / width, 1 / height);
    width *= scale;
    height *= scale;
  }

  width = Math.max(MIN_SPAN, Math.min(1, width));
  height = Math.max(MIN_SPAN, Math.min(1, height));
  const x = Math.min(1 - width, Math.max(0, cx - width / 2));
  const y = Math.min(1 - height, Math.max(0, cy - height / 2));
  return { x, y, width, height };
}

/**
 * Constrains pointer drag from `start` toward `end` to preserve `pixelAspect` inside `[0, 1]`.
 */
export function cropFromPointsWithAspect(
  start: { x: number; y: number },
  end: { x: number; y: number },
  pixelAspect: number | null,
  imageWidth: number,
  imageHeight: number,
): Crop {
  if (!pixelAspect) return cropFromPoints(start, end);
  const norm = normalizedRatio(pixelAspect, imageWidth, imageHeight);
  const sx = clamp01(start.x);
  const sy = clamp01(start.y);
  const dx = clamp01(end.x) - sx;
  const dy = clamp01(end.y) - sy;
  const signX = dx >= 0 ? 1 : -1;
  const signY = dy >= 0 ? 1 : -1;

  const maxW = signX > 0 ? 1 - sx : sx;
  const maxH = signY > 0 ? 1 - sy : sy;
  const limitW = Math.min(maxW, maxH * norm);
  if (limitW < MIN_SPAN || limitW / norm < MIN_SPAN) {
    return fitCropToAspect({ x: sx, y: sy, width: MIN_SPAN, height: MIN_SPAN }, pixelAspect, imageWidth, imageHeight);
  }

  const desiredW = Math.max(Math.abs(dx), Math.abs(dy) * norm, MIN_SPAN, MIN_SPAN * norm);
  const width = Math.min(limitW, desiredW);
  const height = width / norm;
  const x = signX > 0 ? sx : sx - width;
  const y = signY > 0 ? sy : sy - height;
  return {
    x: Math.max(0, Math.min(1 - width, x)),
    y: Math.max(0, Math.min(1 - height, y)),
    width,
    height,
  };
}
