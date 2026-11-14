import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_ADVANCE_KEY,
  AUTO_ADVANCE_MS,
  AUTO_ADVANCE_SPEED_KEY,
  autoAdvanceDelayMs,
  compareWindow,
  cullKeyAction,
  nextAfterMark,
  ratingStepDelta,
  readAutoAdvance,
  readAutoAdvanceMode,
  snapshotQueue,
  stepRating,
  toggleAutoAdvanceMode,
  writeAutoAdvance,
  writeAutoAdvanceMode,
} from '../src/culling';
import type { AssetListResult } from '../src/model';

describe('culling shortcuts', () => {
  it('maps the culling key table including bracket rating step keys and CJK IME codes', () => {
    expect(cullKeyAction({ key: '3' })).toEqual({ kind: 'rate', value: 3 });
    expect(cullKeyAction({ key: '0' })).toEqual({ kind: 'rate', value: 0 });
    expect(cullKeyAction({ key: '[' })).toEqual({ kind: 'rate_step', delta: -1 });
    expect(cullKeyAction({ key: ']' })).toEqual({ kind: 'rate_step', delta: 1 });
    expect(cullKeyAction({ key: '【', code: 'BracketLeft' })).toEqual({
      kind: 'rate_step',
      delta: -1,
    });
    expect(cullKeyAction({ key: '】', code: 'BracketRight' })).toEqual({
      kind: 'rate_step',
      delta: 1,
    });
    expect(cullKeyAction({ key: '{', code: 'BracketLeft', shiftKey: true })).toBeNull();
    expect(cullKeyAction({ key: '[', ctrlKey: true })).toBeNull();
    expect(cullKeyAction({ key: ']', metaKey: true })).toBeNull();
    expect(ratingStepDelta({ key: '[', altKey: true })).toBeNull();
    expect(cullKeyAction({ key: 'p' })).toEqual({ kind: 'flag', value: 'pick' });
    expect(cullKeyAction({ key: 'X' })).toEqual({ kind: 'flag', value: 'reject' });
    expect(cullKeyAction({ key: 'u' })).toEqual({ kind: 'flag', value: 'none' });
    expect(cullKeyAction({ key: 'ArrowRight' })).toEqual({ kind: 'move', delta: 1 });
    expect(cullKeyAction({ key: 'ArrowLeft' })).toEqual({ kind: 'move', delta: -1 });
    expect(cullKeyAction({ key: 'g' })).toEqual({ kind: 'view', value: 'single' });
    expect(cullKeyAction({ key: 'c' })).toEqual({ kind: 'view', value: 'compare' });
    expect(cullKeyAction({ key: 'z' })).toEqual({ kind: 'zoom' });
    expect(cullKeyAction({ key: 'j' })).toEqual({ kind: 'clipping' });
    expect(cullKeyAction({ key: 'r' })).toEqual({ kind: 'raw_mode' });
    expect(cullKeyAction({ key: 'Tab' })).toEqual({ kind: 'overlay' });
    expect(cullKeyAction({ key: 'd' })).toEqual({ kind: 'overlay' });
    expect(cullKeyAction({ key: 'f' })).toEqual({ kind: 'fullscreen' });
    expect(cullKeyAction({ key: ' ' })).toEqual({ kind: 'escape' });
    expect(cullKeyAction({ key: 'Escape' })).toEqual({ kind: 'escape' });
    expect(cullKeyAction({ key: 'C', shiftKey: true })).toEqual({ kind: 'mode' });
    expect(cullKeyAction({ key: 'F', shiftKey: true })).toEqual({ kind: 'focus' });
    expect(cullKeyAction({ key: 'z', ctrlKey: true })).toEqual({ kind: 'undo' });
    expect(cullKeyAction({ key: 'z', metaKey: true })).toEqual({ kind: 'undo' });
    expect(cullKeyAction({ key: 'p', altKey: true })).toBeNull();
    expect(cullKeyAction({ key: 'z', ctrlKey: true, shiftKey: true })).toBeNull();
    expect(cullKeyAction({ key: 'q' })).toBeNull();
  });

  it('clamps rating steps within 0..5 without wrapping', () => {
    expect(stepRating(0, -1)).toBe(0);
    expect(stepRating(1, -1)).toBe(0);
    expect(stepRating(3, 1)).toBe(4);
    expect(stepRating(5, 1)).toBe(5);
  });
});

describe('auto-advance speed tiers and storage migration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('migrates legacy boolean values and remembers last speed across pause/resume', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });

    expect(readAutoAdvanceMode()).toBe('fast');
    expect(readAutoAdvance()).toBe(true);
    expect(autoAdvanceDelayMs('fast')).toBe(AUTO_ADVANCE_MS.fast);

    store.set(AUTO_ADVANCE_KEY, 'false');
    expect(readAutoAdvanceMode()).toBe('off');
    expect(readAutoAdvance()).toBe(false);
    expect(autoAdvanceDelayMs('off')).toBeNull();

    store.set(AUTO_ADVANCE_KEY, 'true');
    expect(readAutoAdvanceMode()).toBe('fast');

    writeAutoAdvanceMode('relaxed');
    expect(readAutoAdvanceMode()).toBe('relaxed');
    expect(store.get(AUTO_ADVANCE_SPEED_KEY)).toBe('relaxed');

    const paused = toggleAutoAdvanceMode('relaxed');
    expect(paused).toBe('off');
    writeAutoAdvanceMode(paused);
    expect(readAutoAdvanceMode()).toBe('off');

    const resumed = toggleAutoAdvanceMode('off');
    expect(resumed).toBe('relaxed');
    writeAutoAdvance(true);
    expect(readAutoAdvanceMode()).toBe('relaxed');
  });
});

describe('culling advance and undo', () => {
  it('advances after a mark and stops at the last image without wrapping', () => {
    expect(nextAfterMark(0, 3, true)).toEqual({ index: 1, atEnd: false });
    expect(nextAfterMark(2, 3, true)).toEqual({ index: 2, atEnd: true });
    expect(nextAfterMark(0, 3, false)).toEqual({ index: 0, atEnd: false });
    expect(nextAfterMark(0, 1, true)).toEqual({ index: 0, atEnd: true });
  });

  it('keeps compare windows inside the queue', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(compareWindow(ids, 0, 2)).toEqual(['a', 'b']);
    expect(compareWindow(ids, 4, 3)).toEqual(['c', 'd', 'e']);
    expect(compareWindow(ids, 1, 9)).toEqual(['b', 'c', 'd', 'e']);
  });
});

describe('culling queue snapshot', () => {
  const library = Array.from({ length: 2500 }, (_, index) => ({ id: `p${index}` }));
  const list = async (_command: 'asset.list', params: Record<string, unknown>) => {
    const offset = Number(params.offset);
    const limit = Number(params.limit);
    return {
      items: library.slice(offset, offset + limit),
      total: library.length,
    } as unknown as AssetListResult;
  };

  it('pages until the total and keeps the start image present', async () => {
    const ids = await snapshotQueue(list, 'library', { flag: 'none' }, 'p10');
    expect(ids).toHaveLength(2500);
    expect(ids[10]).toBe('p10');
    const outside = await snapshotQueue(list, 'library', {}, 'elsewhere');
    expect(outside[0]).toBe('elsewhere');
  });

  it('is not affected by marks made after it was taken', async () => {
    const ids = await snapshotQueue(list, 'library', { flag: 'none' }, 'p0');
    library.splice(0, 1);
    expect(ids[0]).toBe('p0');
    expect(ids).toHaveLength(2500);
  });
});
