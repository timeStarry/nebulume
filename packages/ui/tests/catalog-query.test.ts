import { describe, expect, it } from 'vitest';
import type { Asset } from '../src/model';
import { availabilityPresentation, browserAssetList, variantViewerIds } from '../src/workspace';

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
  it('uses creation time independently of modification time, sorting unknown times last before pagination', () => {
    const items = [
      {
        ...photo('new', 'a.jpg', 3),
        created_at: '2026-10-15T00:00:00Z',
        modified_at: '2020-01-01',
      },
      {
        ...photo('old', 'z.jpg', 5),
        created_at: '2020-01-01T00:00:00Z',
        modified_at: '2026-10-15',
      },
      { ...photo('empty', 'b.jpg', 4), created_at: '' },
      photo('missing', 'c.jpg', 4),
      { ...photo('png', 'd.png', 5), created_at: '2030-01-01T00:00:00Z' },
      { ...photo('low', 'e.jpg', 1), created_at: '2030-01-01T00:00:00Z' },
    ];
    const options = {
      rating: 3,
      format: 'jpeg' as const,
      sort_by: 'created_at' as const,
      limit: 2,
    };
    for (const [direction, known, unknown] of [
      ['asc', ['old', 'new'], ['empty', 'missing']],
      ['desc', ['new', 'old'], ['missing', 'empty']],
    ] as const) {
      const first = browserAssetList(items, { ...options, sort_direction: direction });
      expect(first.items.map((item) => item.id)).toEqual(known);
      expect(first.total).toBe(4);
      expect(
        browserAssetList(items, { ...options, sort_direction: direction, offset: 2 }).items.map(
          (item) => item.id,
        ),
      ).toEqual(unknown);
    }
  });
  it('defaults to camera capture time while pending and missing timestamps stay last in both directions', () => {
    const items: Asset[] = [
      {
        ...photo('early', 'z.jpg', 5),
        captured_at: '2020-01-01T08:30:00',
        created_at: '2030-01-01',
        modified_at: '2030-01-01',
        capture_status: 'available',
      },
      {
        ...photo('late', 'a.jpg', 3),
        captured_at: '2026-10-17T08:30:00',
        created_at: '2000-01-01',
        modified_at: '2000-01-01',
        capture_status: 'available',
      },
      { ...photo('pending', 'b.jpg', 4), captured_at: '', capture_status: 'pending' },
      { ...photo('missing', 'c.jpg', 4), capture_status: 'missing' },
    ];
    expect(browserAssetList(items, {}).items.map((item) => item.id)).toEqual([
      'late',
      'early',
      'pending',
      'missing',
    ]);
    expect(
      browserAssetList(items, {
        sort_by: 'captured_at',
        sort_direction: 'asc',
        rating: 3,
        format: 'jpeg',
        limit: 1,
      }).items.map((item) => item.id),
    ).toEqual(['early']);
    expect(
      browserAssetList(items, {
        sort_by: 'captured_at',
        sort_direction: 'asc',
        offset: 2,
      }).items.map((item) => item.id),
    ).toEqual(['missing', 'pending']);
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

describe('browser catalog flag filter', () => {
  it('filters picks, unflagged and hides rejects', () => {
    const items = [
      { ...photo('a', 'a.jpg'), flag: 'pick' as const },
      { ...photo('b', 'b.jpg'), flag: 'reject' as const },
      photo('c', 'c.jpg'),
    ];
    const ids = (flag: 'any' | 'pick' | 'none' | 'reject' | 'not_reject') =>
      browserAssetList(items, { flag, sort_by: 'filename', sort_direction: 'asc' }).items.map(
        (item) => item.id,
      );
    expect(ids('pick')).toEqual(['a']);
    expect(ids('none')).toEqual(['c']);
    expect(ids('reject')).toEqual(['b']);
    expect(ids('not_reject')).toEqual(['a', 'c']);
    expect(ids('any')).toEqual(['a', 'b', 'c']);
  });
});

describe('location availability presentation', () => {
  it('keeps online and unchecked usable and explains every unavailable state', () => {
    const base = { name: 'NAS 照片', source_kind: 'webdav' as const, source_name: '家庭 NAS' };
    expect(availabilityPresentation({ ...base, availability: 'online' }).usable).toBe(true);
    expect(availabilityPresentation({ ...base, availability: 'unchecked' }).label).toBe('未连接');
    const offline = availabilityPresentation({ ...base, availability: 'offline' });
    expect(offline).toMatchObject({ usable: false, label: '不可达' });
    expect(offline.detail).toContain('评级与旗标仍可修改');
    expect(availabilityPresentation({ ...base, availability: 'auth_required' }).action).toEqual({
      label: '重新登录',
      section: 'sources',
    });
    expect(availabilityPresentation({ ...base, availability: 'trust_required' }).label).toBe(
      '证书待确认',
    );
    const local = availabilityPresentation({
      name: '外接盘',
      source_kind: 'local',
      availability: 'offline',
    });
    expect(local).toMatchObject({ label: '未挂载', action: undefined });
    // Older payloads without availability fall back to the connected flag.
    expect(availabilityPresentation({ ...base, connected: true }).label).toBe('在线');
  });
});
