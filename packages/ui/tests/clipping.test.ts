import { describe, expect, it } from 'vitest';
import { computeClippingMask } from '../src/clipping';

describe('computeClippingMask', () => {
  it('marks blown highlights red, crushed shadows blue, and leaves midtones transparent', () => {
    const src = new Uint8ClampedArray([
      255, 210, 180, 255, // channel highlight (>= 254)
      253, 253, 252, 255, // pure white highlight (>= 252 all channels)
      2, 3, 1, 255,       // crushed shadow (<= 3 all channels)
      128, 130, 125, 255, // neutral midtone
      0, 0, 0, 0,         // transparent background ignored
    ]);
    const out = new Uint8ClampedArray(src.length);
    const stats = computeClippingMask(src, out);

    expect(stats.totalPixels).toBe(4);
    expect(stats.highlightPixels).toBe(2);
    expect(stats.shadowPixels).toBe(1);
    expect(stats.highlightRatio).toBeCloseTo(0.5);
    expect(stats.shadowRatio).toBeCloseTo(0.25);

    // Pixel 0 & 1 -> red warning
    expect(out[0]).toBeGreaterThan(200);
    expect(out[3]).toBeGreaterThan(180);
    expect(out[4]).toBeGreaterThan(200);
    expect(out[7]).toBeGreaterThan(180);

    // Pixel 2 -> blue warning
    expect(out[10]).toBeGreaterThan(200);
    expect(out[11]).toBeGreaterThan(180);

    // Pixel 3 (midtone) & Pixel 4 (transparent) -> alpha 0
    expect(out[15]).toBe(0);
    expect(out[19]).toBe(0);
  });
});
