import type { Asset, AssetListOptions } from './model';

export type AssetChange = 'rating' | 'flag' | 'crop' | 'metadata' | 'refresh';
export interface AssetUpdated {
  id: string;
  revision?: number;
  change?: AssetChange;
  asset?: Asset;
}

/** Older viewers and browser callbacks can be classified without reloading the library. */
export function changedAssetFields(
  previous: Asset | undefined,
  next: Asset,
): AssetChange | undefined {
  if (!previous) return undefined;
  if (
    previous.preview_revision !== next.preview_revision ||
    previous.path !== next.path ||
    previous.size !== next.size ||
    previous.modified_at !== next.modified_at ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.availability !== next.availability
  )
    return 'refresh';
  if (JSON.stringify(previous.crop || null) !== JSON.stringify(next.crop || null)) return 'crop';
  if (
    previous.created_at !== next.created_at ||
    previous.captured_at !== next.captured_at ||
    previous.capture_status !== next.capture_status ||
    JSON.stringify(previous.metadata) !== JSON.stringify(next.metadata)
  )
    return 'metadata';
  if (previous.rating !== next.rating) return 'rating';
  if ((previous.flag || 'none') !== (next.flag || 'none')) return 'flag';
  return undefined;
}

/** Only changes that can affect membership, representation or ordering need an index query. */
export function needsCatalogReconcile(
  options: AssetListOptions,
  change: AssetChange | undefined,
  previous: Asset | undefined,
  next: Asset,
): boolean {
  if (!change || (options.library_id && next.library_id !== options.library_id)) return false;
  if (change === 'crop') return false;
  if (change === 'rating') return !!options.rating || options.sort_by === 'rating';
  if (change === 'flag') return !!options.flag && options.flag !== 'any';
  if (!previous) return true;
  if (options.query && JSON.stringify(previous.metadata) !== JSON.stringify(next.metadata))
    return true;
  if (
    previous.filename !== next.filename ||
    previous.kind !== next.kind ||
    previous.extension !== next.extension
  )
    return true;
  const field = options.sort_by || 'captured_at';
  return previous[field] !== next[field] || (!!options.rating && previous.rating !== next.rating);
}

/** Coalesce bursts while retaining a pixel change followed by a rating change. */
export function mergePendingUpdate(
  previous: AssetUpdated | undefined,
  next: AssetUpdated,
): AssetUpdated {
  if (!previous) return next;
  const priority = (change?: AssetChange) =>
    change === 'refresh'
      ? 4
      : change === 'crop'
        ? 3
        : change === 'metadata'
          ? 2
          : change === 'rating' || change === 'flag'
            ? 1
            : 0;
  return {
    ...next,
    // A bare event requires a fresh read; an older attached object must not hide it.
    asset: next.asset,
    revision: next.revision ?? previous.revision,
    change: priority(previous.change) > priority(next.change) ? previous.change : next.change,
  };
}
