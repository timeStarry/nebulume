import { exposureParameters } from './inspector-metadata';
import type { Asset } from './model';

/**
 * Info-panel fields the user pins to the top. Named ids combine or format decoder values;
 * any other id is a raw metadata key shown as-is.
 */
export type FieldId = string;

export const PINNED_KEY = 'nebulume.inspector.pinned';
export const DEFAULT_PINNED: readonly FieldId[] = Object.freeze([
  'exposure',
  'focal',
  'lens',
  'body',
  'captured',
  'dimensions',
]);

export const NAMED_FIELDS: Record<string, string> = {
  exposure: '曝光',
  focal: '焦距',
  lens: '镜头',
  body: '相机',
  captured: '拍摄时间',
  dimensions: '尺寸',
};

const text = (value: string | undefined | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** `M月D日 HH:mm` from the catalog's camera-local stamp, or null. */
export function formatCaptured(stamp: string | undefined): string | null {
  const match = stamp?.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return null;
  return `${Number(match[2])}月${Number(match[3])}日 ${match[4]}:${match[5]}`;
}

/** The shown value of a field for this photo, or null when the photo does not record it. */
export function fieldValue(id: FieldId, asset: Asset): string | null {
  const metadata: Record<string, string> = asset.metadata ?? {};
  switch (id) {
    case 'exposure': {
      const [aperture, shutter, iso] = exposureParameters(metadata).map((field) => field.value);
      const parts = [aperture, shutter, iso && (/^\d+$/.test(iso) ? `ISO ${iso}` : iso)].filter(
        Boolean,
      );
      return parts.length ? parts.join(' · ') : null;
    }
    case 'focal':
      return text(metadata['Focal Length'] ?? metadata.FocalLength);
    case 'lens':
      return text(metadata.Lens ?? metadata.LensModel);
    case 'body':
      return text(metadata.Camera ?? metadata.Model);
    case 'captured':
      return formatCaptured(asset.captured_at);
    case 'dimensions':
      return asset.width && asset.height ? `${asset.width} × ${asset.height}` : null;
    default:
      return text(metadata[id]);
  }
}

export function fieldLabel(id: FieldId): string {
  return NAMED_FIELDS[id] ?? id;
}

/** Saved order, falling back to the default when unreadable; unknown ids and repeats are dropped. */
export function readPinned(storage: Pick<Storage, 'getItem'>, known: Set<string>): FieldId[] {
  let raw: unknown;
  try {
    const value = storage.getItem(PINNED_KEY);
    if (value === null) return [...DEFAULT_PINNED];
    raw = JSON.parse(value);
  } catch {
    return [...DEFAULT_PINNED];
  }
  if (!Array.isArray(raw)) return [...DEFAULT_PINNED];
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && known.has(id)))];
}

export function writePinned(storage: Pick<Storage, 'setItem'>, list: FieldId[]) {
  try {
    storage.setItem(PINNED_KEY, JSON.stringify(list));
  } catch {
    /* Applies to this window only. */
  }
}

export function togglePinned(list: FieldId[], id: FieldId): FieldId[] {
  return list.includes(id) ? list.filter((each) => each !== id) : [...list, id];
}

export function movePinned(list: FieldId[], id: FieldId, delta: -1 | 1): FieldId[] {
  const from = list.indexOf(id);
  if (from < 0) return list;
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (to === from) return [...list];
  const next = list.filter((each) => each !== id);
  next.splice(to, 0, id);
  return next;
}
