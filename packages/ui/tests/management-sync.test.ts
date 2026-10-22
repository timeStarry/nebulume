import { describe, expect, it } from 'vitest';
import {
  changedAssetFields,
  mergePendingUpdate,
  needsCatalogReconcile,
} from '../src/management-sync';
import type { Asset } from '../src/model';

const asset: Asset = {
  id: 'a',
  library_id: 'library',
  filename: 'photo.jpg',
  path: '/photo.jpg',
  extension: 'jpg',
  kind: 'raster',
  size: 100,
  modified_at: '2026-10-15',
  rating: 0,
  metadata: { Camera: 'Fixture' },
  availability: 'available',
};
describe('management change classification', () => {
  it('distinguishes ratings and crop from pixel refresh and no change', () => {
    expect(
      changedAssetFields(asset, { ...asset, metadata: { ...asset.metadata } }),
    ).toBeUndefined();
    expect(changedAssetFields(asset, { ...asset, rating: 5 })).toBe('rating');
    expect(
      changedAssetFields(asset, { ...asset, crop: { x: 0, y: 0, width: 0.5, height: 1 } }),
    ).toBe('crop');
    expect(changedAssetFields(asset, { ...asset, preview_revision: 42 })).toBe('refresh');
    expect(changedAssetFields(asset, { ...asset, size: 101 })).toBe('refresh');
    expect(changedAssetFields(asset, { ...asset, created_at: '2026-10-01' })).toBe('metadata');
    expect(
      changedAssetFields(asset, {
        ...asset,
        captured_at: '2026-10-01T10:00:00',
        capture_status: 'available',
        metadata: { ...asset.metadata, Captured: '2026:10:01 10:00:00' },
      }),
    ).toBe('metadata');
  });
  it('only reconciles changes that may affect result membership or ordering', () => {
    const rated = { ...asset, rating: 5 };
    expect(needsCatalogReconcile({}, 'rating', asset, rated)).toBe(false);
    expect(needsCatalogReconcile({ rating: 3 }, 'rating', asset, rated)).toBe(true);
    expect(needsCatalogReconcile({ sort_by: 'rating' }, 'rating', asset, rated)).toBe(true);
    expect(
      needsCatalogReconcile(
        { query: 'camera', rating: 3, sort_by: 'rating' },
        'crop',
        asset,
        asset,
      ),
    ).toBe(false);
    expect(needsCatalogReconcile({ library_id: 'other', rating: 3 }, 'rating', asset, rated)).toBe(
      false,
    );
    expect(needsCatalogReconcile({}, 'refresh', asset, { ...asset, preview_revision: 42 })).toBe(
      false,
    );
    expect(
      needsCatalogReconcile({ sort_by: 'modified_at' }, 'refresh', asset, {
        ...asset,
        modified_at: 'later',
      }),
    ).toBe(true);
    const created = { ...asset, created_at: '2026-10-01' };
    expect(needsCatalogReconcile({ sort_by: 'created_at' }, 'refresh', asset, created)).toBe(true);
    expect(needsCatalogReconcile({ sort_by: 'modified_at' }, 'refresh', asset, created)).toBe(
      false,
    );
    expect(
      needsCatalogReconcile({ sort_by: 'created_at' }, 'refresh', created, {
        ...created,
        modified_at: 'later',
      }),
    ).toBe(false);
    const captured = { ...asset, captured_at: '2026-10-01T10:00:00' };
    expect(needsCatalogReconcile({}, 'metadata', asset, captured)).toBe(true);
    expect(needsCatalogReconcile({ sort_by: 'modified_at' }, 'metadata', asset, captured)).toBe(
      false,
    );
    expect(
      needsCatalogReconcile({ query: 'Camera' }, 'refresh', asset, {
        ...asset,
        metadata: { Camera: 'New' },
      }),
    ).toBe(true);
  });
  it('a later rating keeps pending crop/refresh invalidation and the latest full asset', () => {
    const next = { ...asset, rating: 4, preview_revision: 42 };
    expect(
      mergePendingUpdate(
        { id: 'a', change: 'refresh', revision: 42, asset },
        { id: 'a', change: 'rating', asset: next },
      ),
    ).toEqual({ id: 'a', change: 'refresh', revision: 42, asset: next });
    expect(mergePendingUpdate({ id: 'a', asset }, { id: 'a' }).asset).toBeUndefined();
  });
});

describe('culling flag synchronization', () => {
  it('classifies flag changes and reconciles only flag-filtered lists', () => {
    const picked = { ...asset, flag: 'pick' as const };
    expect(changedAssetFields(asset, picked)).toBe('flag');
    expect(needsCatalogReconcile({ library_id: 'library' }, 'flag', asset, picked)).toBe(false);
    expect(
      needsCatalogReconcile({ library_id: 'library', flag: 'any' }, 'flag', asset, picked),
    ).toBe(false);
    expect(
      needsCatalogReconcile({ library_id: 'library', flag: 'not_reject' }, 'flag', asset, picked),
    ).toBe(true);
  });
});
