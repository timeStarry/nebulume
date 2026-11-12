/**
 * Highlight / shadow clipping mask computation over decoded RGBA8 pixel buffers.
 * Pure data transform (no DOM): blown highlights map to warning red and crushed
 * shadows map to warning blue; non-clipped pixels remain transparent.
 */

export interface ClippingStats {
  highlightPixels: number;
  shadowPixels: number;
  totalPixels: number;
  highlightRatio: number;
  shadowRatio: number;
}

const HIGHLIGHT_CHANNEL = 254;
const HIGHLIGHT_WHITE = 252;
const SHADOW_BLACK = 3;
const MIN_ALPHA = 16;

// High-contrast darkroom zebra colours: red for blown highlights, cobalt blue for crushed blacks.
const HIGHLIGHT_RGBA = [232, 82, 74, 214] as const;
const SHADOW_RGBA = [74, 140, 242, 214] as const;

export function computeClippingMask(
  rgba: Uint8ClampedArray,
  out: Uint8ClampedArray,
): ClippingStats {
  let highlightPixels = 0;
  let shadowPixels = 0;
  let totalPixels = 0;
  const end = Math.min(rgba.length, out.length) & ~3;

  for (let i = 0; i < end; i += 4) {
    const a = rgba[i + 3];
    if (a < MIN_ALPHA) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }
    totalPixels++;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const isHighlight =
      r >= HIGHLIGHT_CHANNEL ||
      g >= HIGHLIGHT_CHANNEL ||
      b >= HIGHLIGHT_CHANNEL ||
      (r >= HIGHLIGHT_WHITE && g >= HIGHLIGHT_WHITE && b >= HIGHLIGHT_WHITE);

    if (isHighlight) {
      highlightPixels++;
      out[i] = HIGHLIGHT_RGBA[0];
      out[i + 1] = HIGHLIGHT_RGBA[1];
      out[i + 2] = HIGHLIGHT_RGBA[2];
      out[i + 3] = HIGHLIGHT_RGBA[3];
    } else if (r <= SHADOW_BLACK && g <= SHADOW_BLACK && b <= SHADOW_BLACK) {
      shadowPixels++;
      out[i] = SHADOW_RGBA[0];
      out[i + 1] = SHADOW_RGBA[1];
      out[i + 2] = SHADOW_RGBA[2];
      out[i + 3] = SHADOW_RGBA[3];
    } else {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
    }
  }

  return {
    highlightPixels,
    shadowPixels,
    totalPixels,
    highlightRatio: totalPixels > 0 ? highlightPixels / totalPixels : 0,
    shadowRatio: totalPixels > 0 ? shadowPixels / totalPixels : 0,
  };
}
