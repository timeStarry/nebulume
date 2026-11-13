import { describe, expect, it } from 'vitest';
import { buildBurstStacks, parseCaptureTimestampMs } from '../src/burst-stacks';
import type { Asset } from '../src/model';

function makeAsset(overrides: Partial<Asset> & { id: string }): Asset {
  return {
    id: overrides.id,
    library_id: overrides.library_id ?? 'lib-1',
    path: overrides.path ?? `/photos/${overrides.id}.ARW`,
    filename: overrides.filename ?? `${overrides.id}.ARW`,
    extension: overrides.extension ?? 'arw',
    kind: overrides.kind ?? 'raw',
    size: 24_000_000,
    modified_at: '2026-11-10T10:00:00Z',
    created_at: '2026-11-10T10:00:00Z',
    captured_at: overrides.captured_at ?? '2026-11-10T10:00:00',
    capture_status: 'available',
    width: 6000,
    height: 4000,
    rating: overrides.rating ?? 0,
    flag: overrides.flag ?? 'none',
    color_label: overrides.color_label ?? 'none',
    metadata: overrides.metadata ?? { Camera: 'Sony ILCE-7RM5' },
    crop: overrides.crop ?? null,
    availability: 'available',
  };
}

describe('burst-stacks', () => {
  it('collapses high-speed burst frames within 2 seconds and promotes picked/highest-rated frame', () => {
    const frames = [
      makeAsset({ id: 'b1', captured_at: '2026-11-10T10:00:01.100' }),
      makeAsset({ id: 'b2', captured_at: '2026-11-10T10:00:01.350', rating: 4 }),
      makeAsset({ id: 'b3', captured_at: '2026-11-10T10:00:01.600', flag: 'pick', rating: 3 }),
      makeAsset({ id: 'solo', captured_at: '2026-11-10T10:00:09.000' }),
    ];

    const collapsed = buildBurstStacks(frames, new Set(), true);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0].asset.id).toBe('b3');
    expect(collapsed[0].stackCount).toBe(3);
    expect(collapsed[0].stackId).toBe('b1');
    expect(collapsed[0].stackMemberIds).toEqual(['b1', 'b2', 'b3']);
    expect(collapsed[1].asset.id).toBe('solo');
    expect(collapsed[1].stackId).toBeNull();

    const expanded = buildBurstStacks(frames, new Set(['b1']), true);
    expect(expanded).toHaveLength(4);
    expect(expanded.slice(0, 3).every((item) => item.isStackExpanded)).toBe(true);
    expect(expanded[2].isRepresentative).toBe(true);
  });

  it('does not merge frames from different cameras or when stacking is disabled', () => {
    const frames = [
      makeAsset({ id: 'a1', captured_at: '2026-11-10T10:00:01.000', metadata: { Camera: 'Nikon Z8' } }),
      makeAsset({ id: 'a2', captured_at: '2026-11-10T10:00:01.200', metadata: { Camera: 'Canon EOS R5' } }),
    ];
    expect(buildBurstStacks(frames, new Set(), true)).toHaveLength(2);
    expect(buildBurstStacks(frames, new Set(), false)).toHaveLength(2);
  });

  it('parses subsecond EXIF fallback accurately', () => {
    const ms = parseCaptureTimestampMs(
      makeAsset({
        id: 'sub',
        captured_at: '2026-11-10T10:00:01',
        metadata: { Camera: 'Nikon Z8', 'Capture Subsecond': '45' },
      }),
    );
    const base = parseCaptureTimestampMs(
      makeAsset({ id: 'base', captured_at: '2026-11-10T10:00:01' }),
    );
    expect(ms! - base!).toBe(450);
  });
});
