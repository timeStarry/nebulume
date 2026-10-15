import { describe, expect, it } from 'vitest';
import type { Asset } from '../src/model';
import { browserAssetList, variantViewerIds } from '../src/workspace';

const photo = (id: string, name: string, rating = 0, directory = 'photos'): Asset => ({
  id,
  library_id: 'library',
  filename: name,
  path: `${directory}/${name}`,
  extension: name.split('.').pop()!.toLowerCase(),
  kind: name.endsWith('.nef') ? 'raw' : 'raster',
  rating,
  size: 10,
  modified_at: `2026-10-${String(rating + 1).padStart(2, '0')}`,
  metadata: {},
  availability: 'available',
});
describe('browser catalog mirrors whole-library queries', () => {
  it('combines query/rating/format and sorts before pagination in either direction', () => {
    const items = [
      photo('low', 'a.jpg', 1),
      photo('png', 'b.png', 5),
      photo('raw', 'c.nef', 4),
      photo('high', 'z.jpg', 5),
      photo('mid', 'm.jpeg', 3),
    ];
    const options = {
      rating: 3,
      format: 'jpeg' as const,
      sort_by: 'filename' as const,
      sort_direction: 'asc' as const,
      limit: 1,
    };
    expect(browserAssetList(items, options).items.map((item) => item.id)).toEqual(['mid']);
    expect(browserAssetList(items, { ...options, offset: 1 }).items.map((item) => item.id)).toEqual(
      ['high'],
    );
    expect(
      browserAssetList(items, { ...options, sort_direction: 'desc' }).items.map((item) => item.id),
    ).toEqual(['high']);
    expect(browserAssetList(items, { ...options, query: 'm.' }).total).toBe(1);
    expect(
      browserAssetList(items, { format: 'all', sort_by: 'rating', sort_direction: 'asc' }).items[0]
        .id,
    ).toBe('low');
  });
  it('groups the complete library before filters, exposes both variants and chooses a matching representative', () => {
    const items = [
      photo('raw', 'same.nef', 5),
      photo('jpg', 'same.jpg', 1),
      photo('other', 'other.png', 3),
    ];
    const all = browserAssetList(items, {}, true);
    expect(all.total).toBe(2);
    expect(all.file_total).toBe(3);
    const pair = all.items.find((item) => item.variants)!;
    expect(pair.id).toBe('jpg');
    expect(pair.variants?.map((item) => item.id)).toEqual(['raw', 'jpg']);
    const raw = browserAssetList(items, { format: 'raw', rating: 4 }, true);
    expect(raw.items[0].id).toBe('raw');
    expect(raw.items[0].variants).toHaveLength(2);
    expect(raw.file_total).toBe(1);
    expect(browserAssetList(items, { rating: 4 }, true).items[0].id).toBe('raw');
  });
  it('does not pair different directories, differently cased stems or ambiguous duplicates', () => {
    for (const items of [
      [photo('a', 'same.nef'), photo('b', 'same.jpg', 0, 'other')],
      [photo('a', 'Same.nef'), photo('b', 'same.jpg')],
      [photo('a', 'same.nef'), photo('b', 'same.jpg'), photo('c', 'same.jpeg')],
    ])
      expect(browserAssetList(items, {}, true).items.every((item) => !item.variants)).toBe(true);
  });
  it('replaces only the current pair in viewer navigation without adding a duplicate representative', () => {
    const items = [
      photo('before', 'before.jpg'),
      photo('jpg', 'same.jpg'),
      photo('after', 'after.jpg'),
    ];
    expect(variantViewerIds(items, 'jpg', 'raw')).toEqual(['before', 'raw', 'after']);
    expect(variantViewerIds(items, 'jpg', 'jpg')).toEqual(['before', 'jpg', 'after']);
  });
});
