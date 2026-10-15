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
    expect(needsCatalogReconcile({}, 'refresh', asset, { ...asset, modified_at: 'later' })).toBe(
      true,
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
