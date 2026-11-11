import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUndoHistory, groupMarks, markHudText, UNDO_TOAST_MS } from '../src/undo';

describe('undo history', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('undoes the latest action first', async () => {
    const history = createUndoHistory();
    const order: string[] = [];
    history.push({ label: 'a', revert: async () => void order.push('a') });
    history.push({ label: 'b', revert: async () => void order.push('b') });
    await history.undo();
    await history.undo();
    expect(order).toEqual(['b', 'a']);
    expect(await history.undo()).toBeUndefined();
  });

  it('offers a toast for ten seconds, and undoing that entry closes it', async () => {
    const history = createUndoHistory();
    const trash = { label: 'trash', revert: async () => undefined, toast: true };
    history.push(trash);
    expect(history.offer()).toBe(trash);
    vi.advanceTimersByTime(UNDO_TOAST_MS - 1);
    expect(history.offer()).toBe(trash);
    vi.advanceTimersByTime(1);
    expect(history.offer()).toBeUndefined();
    // Ctrl+Z still works after the toast has gone.
    expect(await history.undo()).toBe(trash);
  });

  it('the toast button undoes its own entry even when a later mark exists', async () => {
    const history = createUndoHistory();
    const order: string[] = [];
    const trash = { label: 'trash', revert: async () => void order.push('trash'), toast: true };
    history.push(trash);
    history.push({ label: 'rate', revert: async () => void order.push('rate') });
    await history.undo(trash);
    expect(order).toEqual(['trash']);
    expect(history.offer()).toBeUndefined();
    await history.undo();
    expect(order).toEqual(['trash', 'rate']);
  });

  it('keeps only the most recent entries within its limit', async () => {
    const history = createUndoHistory(2);
    const order: string[] = [];
    for (const label of ['a', 'b', 'c'])
      history.push({ label, revert: async () => void order.push(label) });
    expect(history.size).toBe(2);
    await history.undo();
    await history.undo();
    expect(await history.undo()).toBeUndefined();
    expect(order).toEqual(['c', 'b']);
  });

  it('remove drops a failed action without reverting it', async () => {
    const history = createUndoHistory();
    let reverted = false;
    const entry = { label: 'x', toast: true, revert: async () => void (reverted = true) };
    history.push(entry);
    history.remove(entry);
    expect(history.size).toBe(0);
    expect(history.offer()).toBeUndefined();
    expect(reverted).toBe(false);
  });

  it('a failed revert stays available to retry', async () => {
    const history = createUndoHistory();
    let fail = true;
    history.push({
      label: 'x',
      revert: async () => {
        if (fail) throw new Error('offline');
      },
    });
    await expect(history.undo()).rejects.toThrow('offline');
    expect(history.size).toBe(1);
    fail = false;
    await history.undo();
    expect(history.size).toBe(0);
  });
});

describe('undo history housekeeping', () => {
  it('forgets marks of trashed photos but keeps the Trash entry itself', async () => {
    const history = createUndoHistory();
    const trash = { label: 'trash', revert: async () => undefined, toast: true, ids: ['a'] };
    history.push({ label: 'mark a', ids: ['a'], revert: async () => undefined });
    history.push({ label: 'mark b', ids: ['b'], revert: async () => undefined });
    history.push(trash);
    history.forget(new Set(['a']));
    expect(history.size).toBe(2);
    expect(history.peek()).toBe(trash);
  });
});

describe('mark helpers', () => {
  it('groups previous marks into batch calls of identical values', () => {
    const groups = groupMarks([
      { id: 'a', rating: 3, flag: 'none' },
      { id: 'b', rating: 0, flag: 'pick' },
      { id: 'c', rating: 3, flag: 'none' },
    ]);
    expect(groups).toEqual([
      { ids: ['a', 'c'], rating: 3, flag: 'none' },
      { ids: ['b'], rating: 0, flag: 'pick' },
    ]);
    expect(
      groupMarks(
        Array.from({ length: 2500 }, (_, i) => ({ id: `${i}`, rating: 1, flag: 'none' })),
      ).map((g) => g.ids.length),
    ).toEqual([1000, 1000, 500]);
  });
  it('describes marks for the HUD', () => {
    expect(markHudText({ rating: 3 })).toBe('★★★  3');
    expect(markHudText({ rating: 0 })).toBe('清除星级');
    expect(markHudText({ flag: 'reject' })).toBe('淘汰');
  });
});
