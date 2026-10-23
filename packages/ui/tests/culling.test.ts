import { describe, expect, it } from 'vitest';
import {
  UndoStack,
  compareWindow,
  cullKeyAction,
  nextAfterMark,
  snapshotQueue,
} from '../src/culling';
import type { AssetListResult } from '../src/model';

describe('culling shortcuts', () => {
  it('maps the culling key table', () => {
    expect(cullKeyAction({ key: '3' })).toEqual({ kind: 'rate', value: 3 });
    expect(cullKeyAction({ key: '0' })).toEqual({ kind: 'rate', value: 0 });
    expect(cullKeyAction({ key: 'p' })).toEqual({ kind: 'flag', value: 'pick' });
    expect(cullKeyAction({ key: 'X' })).toEqual({ kind: 'flag', value: 'reject' });
    expect(cullKeyAction({ key: 'u' })).toEqual({ kind: 'flag', value: 'none' });
    expect(cullKeyAction({ key: 'ArrowRight' })).toEqual({ kind: 'move', delta: 1 });
    expect(cullKeyAction({ key: 'ArrowLeft' })).toEqual({ kind: 'move', delta: -1 });
    expect(cullKeyAction({ key: 'g' })).toEqual({ kind: 'view', value: 'single' });
    expect(cullKeyAction({ key: 'c' })).toEqual({ kind: 'view', value: 'compare' });
    expect(cullKeyAction({ key: 'z' })).toEqual({ kind: 'zoom' });
    expect(cullKeyAction({ key: 'Tab' })).toEqual({ kind: 'hud' });
    expect(cullKeyAction({ key: 'f' })).toEqual({ kind: 'fullscreen' });
    expect(cullKeyAction({ key: 'Escape' })).toEqual({ kind: 'escape' });
    expect(cullKeyAction({ key: 'C', shiftKey: true })).toEqual({ kind: 'mode' });
    expect(cullKeyAction({ key: 'F', shiftKey: true })).toEqual({ kind: 'focus' });
    expect(cullKeyAction({ key: 'z', ctrlKey: true })).toEqual({ kind: 'undo' });
    expect(cullKeyAction({ key: 'z', metaKey: true })).toEqual({ kind: 'undo' });
    expect(cullKeyAction({ key: 'p', altKey: true })).toBeNull();
    expect(cullKeyAction({ key: 'z', ctrlKey: true, shiftKey: true })).toBeNull();
    expect(cullKeyAction({ key: 'q' })).toBeNull();
  });
});

describe('culling advance and undo', () => {
  it('advances after a mark and stops at the last image without wrapping', () => {
    expect(nextAfterMark(0, 3, true)).toEqual({ index: 1, atEnd: false });
    expect(nextAfterMark(2, 3, true)).toEqual({ index: 2, atEnd: true });
    expect(nextAfterMark(0, 3, false)).toEqual({ index: 0, atEnd: false });
    expect(nextAfterMark(0, 1, true)).toEqual({ index: 0, atEnd: true });
  });

  it('undoes marks last-in first-out within a bounded stack', () => {
    const stack = new UndoStack(2);
    stack.push({ id: 'a', rating: 0, flag: 'none' });
    stack.push({ id: 'b', rating: 2, flag: 'pick' });
    stack.push({ id: 'c', rating: 5, flag: 'reject' });
    expect(stack.size).toBe(2);
    expect(stack.pop()?.id).toBe('c');
    expect(stack.pop()?.id).toBe('b');
    expect(stack.pop()).toBeUndefined();
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
