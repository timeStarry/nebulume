/**
 * Pure viewport synchronization math for single-photo 1:1 inspection and 2-up / 4-up
 * CompareStage. Pan offsets (`panX`, `panY`) are normalized to fitted image dimensions
 * so panes with slightly different crops or resolutions pan in lockstep over the same
 * relative region of the frame.
 */

export interface CompareTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export const IDENTITY_TRANSFORM: CompareTransform = { zoom: 1, panX: 0, panY: 0 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;

export function fitDimensions(
  stageWidth: number,
  stageHeight: number,
  imageWidth: number,
  imageHeight: number,
  padding = 24,
): { width: number; height: number; scale: number } {
  const w = Math.max(1, imageWidth || 1);
  const h = Math.max(1, imageHeight || 1);
  const availW = Math.max(1, stageWidth - padding);
  const availH = Math.max(1, stageHeight - padding);
  const scale = Math.max(0.01, Math.min(availW / w, availH / h, 1));
  return { width: w * scale, height: h * scale, scale };
}

/** Zoom multiplier above fit-to-pane where 1 source image pixel equals 1 CSS pixel. */
export function actualPixelZoom(
  stageWidth: number,
  stageHeight: number,
  fullWidth: number,
  fullHeight: number,
  padding = 24,
): number {
  const { scale } = fitDimensions(stageWidth, stageHeight, fullWidth, fullHeight, padding);
  return Math.min(MAX_ZOOM, Math.max(1, 1 / scale));
}

function clampPan(pan: number, zoom: number): number {
  if (zoom <= 1.001) return 0;
  const limit = (zoom - 1) / 2 + 0.15;
  return Math.max(-limit, Math.min(limit, pan));
}

/**
 * Zooms around `(offsetX, offsetY)` (CSS pixels relative to pane center) while keeping
 * normalized pan coordinates bounded.
 */
export function zoomAroundPoint(
  current: CompareTransform,
  nextZoom: number,
  offsetX: number,
  offsetY: number,
  fitWidth: number,
  fitHeight: number,
): CompareTransform {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  if (zoom <= 1.001) return IDENTITY_TRANSFORM;
  const safeW = Math.max(1, fitWidth);
  const safeH = Math.max(1, fitHeight);
  const factor = zoom / Math.max(MIN_ZOOM, current.zoom);
  const currPx = current.panX * safeW;
  const currPy = current.panY * safeH;
  const nextPx = offsetX - (offsetX - currPx) * factor;
  const nextPy = offsetY - (offsetY - currPy) * factor;
  return {
    zoom,
    panX: clampPan(nextPx / safeW, zoom),
    panY: clampPan(nextPy / safeH, zoom),
  };
}

/** Applies a pointer drag delta `(dx, dy)` in CSS pixels to normalized pan coordinates. */
export function panByDelta(
  current: CompareTransform,
  dx: number,
  dy: number,
  fitWidth: number,
  fitHeight: number,
): CompareTransform {
  if (current.zoom <= 1.001) return IDENTITY_TRANSFORM;
  const safeW = Math.max(1, fitWidth);
  const safeH = Math.max(1, fitHeight);
  return {
    zoom: current.zoom,
    panX: clampPan(current.panX + dx / safeW, current.zoom),
    panY: clampPan(current.panY + dy / safeH, current.zoom),
  };
}

/**
 * Returns `true` when the displayed image exceeds the `p2560` preview budget in device
 * pixels AND the source frame has higher native resolution available in the `full` tier.
 */
export function needsFullTier(
  displayedWidth: number,
  displayedHeight: number,
  devicePixelRatio: number,
  fullWidth: number,
  fullHeight: number,
): boolean {
  const dpr = Math.max(1, devicePixelRatio || 1);
  const displayedDeviceLong = Math.max(displayedWidth, displayedHeight) * dpr;
  const sourceLong = Math.max(fullWidth || 0, fullHeight || 0);
  return displayedDeviceLong > 2600 && sourceLong > 2560;
}
