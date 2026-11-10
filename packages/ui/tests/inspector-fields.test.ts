import { describe, expect, test } from 'vitest';
import type { Asset } from '../src/model';
import {
  DEFAULT_PINNED,
  fieldValue,
  movePinned,
  readPinned,
  togglePinned,
} from '../src/inspector-fields';

const asset = (metadata: Record<string, string>, extra: Partial<Asset> = {}) =>
  ({ metadata, ...extra }) as unknown as Asset;

describe('pinned inspector fields', () => {
  test('missing storage gives the default; unknown ids are dropped', () => {
    const known = new Set([...DEFAULT_PINNED, 'Exposure Bias']);
    expect(readPinned({ getItem: () => null }, known)).toEqual(DEFAULT_PINNED);
    expect(readPinned({ getItem: () => '{bad' }, known)).toEqual(DEFAULT_PINNED);
    expect(
      readPinned({ getItem: () => '["Exposure Bias","nope","Exposure Bias"]' }, known),
    ).toEqual(['Exposure Bias']);
  });
  test('toggle appends or removes; move clamps', () => {
    expect(togglePinned(['exposure'], 'Exposure Bias')).toEqual(['exposure', 'Exposure Bias']);
    expect(togglePinned(['exposure', 'focal'], 'exposure')).toEqual(['focal']);
    expect(movePinned(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(movePinned(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
  });
  test('missing EXIF gives null, never "undefined"', () => {
    const bare = asset({});
    for (const id of DEFAULT_PINNED) expect(fieldValue(id, bare)).toBeNull();
    expect(fieldValue('Exposure Bias', asset({ 'Exposure Bias': '  ' }))).toBeNull();
  });
  test('exposure joins aperture, shutter and ISO', () => {
    expect(
      fieldValue('exposure', asset({ Aperture: 'f/2.8', Exposure: '1/500 s', ISO: '200' })),
    ).toBe('f/2.8 · 1/500 s · ISO 200');
    expect(fieldValue('exposure', asset({ Aperture: 'f/4' }))).toBe('f/4');
  });
  test('named fields read the decoder keys', () => {
    const a = asset(
      {
        Camera: 'X-T5',
        Lens: 'XF 23mm F1.4',
        'Focal Length': '23 mm',
        Captured: '2026:10:18 16:42:05',
      },
      { width: 6240, height: 4160, captured_at: '2026-10-18T16:42:05' },
    );
    expect(fieldValue('body', a)).toBe('X-T5');
    expect(fieldValue('lens', a)).toBe('XF 23mm F1.4');
    expect(fieldValue('focal', a)).toBe('23 mm');
    expect(fieldValue('captured', a)).toBe('10月18日 16:42');
    expect(fieldValue('dimensions', a)).toBe('6240 × 4160');
  });
});
