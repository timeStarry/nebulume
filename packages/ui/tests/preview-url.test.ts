import { afterEach, describe, expect, it } from 'vitest';
import { TIER_PIXELS, gridTier, previewTier, previewUrl } from '../src/preview-url';

const runtime = globalThis as unknown as Record<string, unknown>;

describe('preview tiers', () => {
  it('picks the smallest tier covering css pixels at the device ratio', () => {
    expect(previewTier(150, 1)).toBe('t256');
    expect(previewTier(256, 1)).toBe('t256');
    expect(previewTier(257, 1)).toBe('t512');
    expect(previewTier(320, 2)).toBe('t1024');
    expect(previewTier(1200, 2)).toBe('p2560');
    expect(TIER_PIXELS).toEqual({ t256: 256, t512: 512, t1024: 1024, p2560: 2560 });
  });
  it('gridTier caps at t1024', () => {
    expect(gridTier(320, 3)).toBe('t1024');
    expect(gridTier(150, 2)).toBe('t512');
  });
});

describe('previewUrl', () => {
  afterEach(() => {
    delete runtime.window;
    delete runtime.isTauri;
  });
  it('builds neb protocol paths through convertFileSrc on desktop', () => {
    runtime.isTauri = true;
    runtime.window = {
      __TAURI_INTERNALS__: {
        convertFileSrc: (p: string, proto: string) =>
          proto + '://localhost/' + encodeURIComponent(p),
      },
    };
    expect(previewUrl({ id: 'a1', preview_revision: 7 }, 't512')).toBe(
      'neb://localhost/' + encodeURIComponent('a1/t512/0/7'),
    );
    expect(previewUrl({ id: 'a1' }, 'p2560', true)).toBe(
      'neb://localhost/' + encodeURIComponent('a1/p2560/1/0'),
    );
  });
});
