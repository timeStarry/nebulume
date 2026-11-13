import { describe, expect, it } from 'vitest';
import {
  cropFromPointsWithAspect,
  fitCropToAspect,
  resolveAspectRatio,
} from '../src/crop-aspect';
import { validCrop } from '../src/model';

describe('crop-aspect', () => {
  it('resolves presets and orientation swaps accurately', () => {
    expect(resolveAspectRatio('free', false, 6000, 4000)).toBeNull();
    expect(resolveAspectRatio('original', false, 6000, 4000)).toBeCloseTo(1.5);
    expect(resolveAspectRatio('original', true, 6000, 4000)).toBeCloseTo(2 / 3);
    expect(resolveAspectRatio('3:2', false, 6000, 4000)).toBeCloseTo(1.5);
    expect(resolveAspectRatio('3:2', true, 6000, 4000)).toBeCloseTo(2 / 3);
    expect(resolveAspectRatio('4:5', false, 6000, 4000)).toBeCloseTo(0.8);
    expect(resolveAspectRatio('1:1', true, 6000, 4000)).toBeCloseTo(1);
  });

  it('fits a full-frame 3:2 image to an exact pixel 1:1 square centered in [0, 1]', () => {
    const aspect = resolveAspectRatio('1:1', false, 6000, 4000);
    const crop = fitCropToAspect({ x: 0, y: 0, width: 1, height: 1 }, aspect, 6000, 4000);
    expect(validCrop(crop)).toBe(true);
    const pxW = crop.width * 6000;
    const pxH = crop.height * 4000;
    expect(pxW / pxH).toBeCloseTo(1, 4);
    expect(crop.x).toBeCloseTo((1 - crop.width) / 2, 4);
    expect(crop.y).toBeCloseTo(0, 4);
  });

  it('constrains pointer drags to target pixel aspect inside image bounds', () => {
    const aspect = resolveAspectRatio('16:9', false, 6000, 4000)!;
    const crop = cropFromPointsWithAspect(
      { x: 0.1, y: 0.2 },
      { x: 0.8, y: 0.9 },
      aspect,
      6000,
      4000,
    );
    expect(validCrop(crop)).toBe(true);
    expect((crop.width * 6000) / (crop.height * 4000)).toBeCloseTo(16 / 9, 3);
  });
});
