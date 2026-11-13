import { describe, expect, it } from 'vitest';
import {
  IDENTITY_TRANSFORM,
  actualPixelZoom,
  fitDimensions,
  needsFullTier,
  panByDelta,
  zoomAroundPoint,
} from '../src/compare-sync';

describe('compare-sync', () => {
  it('computes 1:1 actual pixel zoom relative to fitted pane dimensions', () => {
    const fit = fitDimensions(1024, 724, 6000, 4000, 24);
    expect(fit.width).toBeCloseTo(1000);
    expect(fit.scale).toBeCloseTo(1000 / 6000);
    expect(actualPixelZoom(1024, 724, 6000, 4000, 24)).toBeCloseTo(6);
  });

  it('zooms around cursor offset, clamps pan, and resets pan when returning to fit', () => {
    const zoomed = zoomAroundPoint(IDENTITY_TRANSFORM, 3, 100, -50, 800, 600);
    expect(zoomed.zoom).toBe(3);
    expect(zoomed.panX).toBeLessThan(0);
    expect(zoomed.panY).toBeGreaterThan(0);

    const panned = panByDelta(zoomed, 5000, -5000, 800, 600);
    expect(Math.abs(panned.panX)).toBeLessThanOrEqual(1.151);
    expect(Math.abs(panned.panY)).toBeLessThanOrEqual(1.151);

    expect(zoomAroundPoint(panned, 1, 0, 0, 800, 600)).toEqual(IDENTITY_TRANSFORM);
  });

  it('requests full tier only when zoomed past p2560 on high-res originals', () => {
    expect(needsFullTier(1200, 800, 2, 8192, 5464)).toBe(false);
    expect(needsFullTier(1600, 1067, 2, 8192, 5464)).toBe(true);
    expect(needsFullTier(1600, 1067, 2, 2048, 1365)).toBe(false);
  });
});
