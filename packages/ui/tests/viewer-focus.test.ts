import { describe, expect, it } from 'vitest';
import { fullCrop, type FocusInfo, type Preview } from '../src/model';
import { cropFocusRegion, focusPresentation } from '../src/viewer-focus';

const info: FocusInfo = {
  status: 'available',
  source: 'nikon_afinfo2',
  coordinate_space: 'oriented_full_image',
  orientation: 8,
  image_width: 800,
  image_height: 600,
  regions: [{ x: 0.25, y: 0.2, width: 0.2, height: 0.3, kind: 'selected' }],
};
const mapping: NonNullable<Preview['coordinate_mapping']> = {
  orientation: 8,
  full_width: 800,
  full_height: 600,
  crop: fullCrop,
};
describe('verified focus-to-preview mapping', () => {
  it('keeps already-oriented coordinates without applying orientation twice', () => {
    expect(focusPresentation(info, mapping).regions).toEqual(info.regions);
  });
  it('uses the renderer crop and clips partially visible regions exactly', () => {
    const crop = { x: 0.3, y: 0.1, width: 0.4, height: 0.6 };
    const result = focusPresentation(info, { ...mapping, crop }).regions[0];
    expect(result.x).toBe(0);
    expect(result.y).toBeCloseTo(1 / 6);
    expect(result.width).toBeCloseTo(0.375);
    expect(result.height).toBeCloseTo(0.5);
    expect(result.kind).toBe('selected');
  });
  it('does not invent a point when all recorded regions fall outside the saved crop', () => {
    const result = focusPresentation(info, {
      ...mapping,
      crop: { x: 0.8, y: 0.8, width: 0.2, height: 0.2 },
    });
    expect(result.regions).toEqual([]);
    expect(result.message).toContain('裁剪范围之外');
  });
  it('rejects any rotation or mirror mismatch, including an unchanged aspect ratio', () => {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7]) {
      const result = focusPresentation(info, { ...mapping, orientation });
      expect(result.regions).toEqual([]);
      expect(result.message).toContain('方向不匹配');
    }
  });
  it('accepts a proportional preview and at most one percent frame-aspect difference', () => {
    expect(
      focusPresentation(info, { ...mapping, full_width: 400, full_height: 300 }).regions,
    ).toHaveLength(1);
    expect(focusPresentation(info, { ...mapping, full_width: 804 }).regions).toHaveLength(1);
    expect(focusPresentation(info, { ...mapping, full_width: 820 }).regions).toHaveLength(0);
  });
  it('requires renderer mapping and valid reference dimensions instead of guessing from asset metadata', () => {
    expect(focusPresentation(info).regions).toEqual([]);
    expect(focusPresentation({ ...info, image_width: undefined }, mapping).regions).toEqual([]);
    expect(focusPresentation(info, { ...mapping, full_height: NaN }).regions).toEqual([]);
    expect(
      focusPresentation(info, { ...mapping, crop: { ...fullCrop, width: 0 } }).regions,
    ).toEqual([]);
  });
  it('preserves missing/unsupported reasons and rejects invalid coordinates', () => {
    for (const status of ['missing', 'unsupported'] as const) {
      expect(focusPresentation({ ...info, status, reason: '未记录此信息' }, mapping)).toEqual({
        regions: [],
        message: '未记录此信息',
      });
    }
    expect(cropFocusRegion({ x: NaN, y: 0, width: 1, height: 1 }, fullCrop)).toBeNull();
    expect(cropFocusRegion({ x: -0.1, y: 0, width: 1, height: 1 }, fullCrop)).toBeNull();
    expect(cropFocusRegion({ x: 0, y: 0, width: 1.1, height: 1 }, fullCrop)).toBeNull();
    expect(focusPresentation({ ...info, regions: [] }, mapping).regions).toEqual([]);
  });
});
