import { describe, expect, it } from 'vitest';
import { chunkIds, createSelection } from '../src/selection';

describe('grid selection state', () => {
  it('supports single click, Shift range, and ⌘/Ctrl toggle in display order', () => {
    const loaded = ['a', 'b', 'c', 'd', 'e'];
    const sel = createSelection(() => loaded);

    sel.select('b');
    expect(sel.selectedIds()).toEqual(['b']);

    sel.select('d', { shiftKey: true });
    expect(sel.selectedIds()).toEqual(['b', 'c', 'd']);
    expect(sel.selectedId()).toBe('d');

    // Toggle off 'c' while keeping multi-selection
    sel.select('c', { metaKey: true });
    expect(sel.selectedIds()).toEqual(['b', 'd']);

    // Toggle on 'a' and verify display order is preserved
    sel.select('a', { ctrlKey: true });
    expect(sel.selectedIds()).toEqual(['a', 'b', 'd']);

    // Plain click collapses multi-selection to a single photo
    sel.select('e');
    expect(sel.selectedIds()).toEqual(['e']);
    expect(sel.picked().size).toBe(0);
  });

  it('retains unloaded IDs when selectAll adopts full asset.ids output', () => {
    const pageOne = ['p1', 'p2', 'p3'];
    const fullFilter = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const sel = createSelection(() => pageOne);

    sel.select('p2');
    sel.selectAll(fullFilter);

    expect(sel.selectedIds()).toEqual(fullFilter);
    expect(sel.selectedId()).toBe('p2');
    expect(sel.isSelected('p6')).toBe(true);

    // Toggling off one loaded item preserves the remaining unloaded items!
    sel.select('p2', { metaKey: true });
    expect(sel.selectedIds()).toEqual(['p1', 'p3', 'p4', 'p5', 'p6']);

    sel.clearPicked();
    expect(sel.selectedIds()).toEqual([sel.selectedId()!]);
  });

  it('chunks large selections into 1000-asset catalog batches', () => {
    const ids = Array.from({ length: 2405 }, (_, i) => `id-${i}`);
    const batches = chunkIds(ids);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(1000);
    expect(batches[1]).toHaveLength(1000);
    expect(batches[2]).toHaveLength(405);
    expect(batches.flat()).toEqual(ids);
  });
});
