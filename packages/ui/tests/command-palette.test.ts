import { describe, expect, it } from 'vitest';
import { buildCommandItems, filterCommandItems } from '../src/command-palette';

describe('command-palette', () => {
  const items = buildCommandItems({
    libraries: [
      {
        id: 'lib-1',
        name: '京都秋日客片',
        root: '/Volumes/Samsung_T9/Kyoto',
        created_at: '2026-11-01T00:00:00Z',
        removable: true,
        volume_label: 'Samsung_T9',
        asset_count: 320,
      },
    ],
    activeLibrary: {
      id: 'lib-1',
      name: '京都秋日客片',
      root: '/Volumes/Samsung_T9/Kyoto',
      created_at: '2026-11-01T00:00:00Z',
      asset_count: 320,
    },
    collections: [
      {
        id: 'col-1',
        library_id: 'lib-1',
        name: '精修交付 20 张',
        kind: 'manual',
        item_count: 20,
        created_at: '2026-11-02T00:00:00Z',
      },
    ],
    folders: [
      {
        name: 'Day1_Arashiyama',
        path: 'Day1_Arashiyama',
        count: 140,
        children: [{ name: 'Selects', path: 'Day1_Arashiyama/Selects', count: 18, children: [] }],
      },
    ],
    burstStacksEnabled: false,
  });

  it('indexes collections, nested folders, libraries, color filters, and settings sections', () => {
    expect(filterCommandItems(items, '精修交付')[0]?.id).toBe('coll:col-1');
    expect(filterCommandItems(items, 'Selects')[0]?.id).toBe('folder:Day1_Arashiyama/Selects');
    expect(filterCommandItems(items, '红标')[0]?.id).toBe('flt:red');
    expect(filterCommandItems(items, '缓存')[0]?.id).toBe('act:settings-cache');
  });

  it('requires multi-word tokens to match simultaneously', () => {
    const hits = filterCommandItems(items, 'Day1 Selects');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('folder:Day1_Arashiyama/Selects');
  });
});
