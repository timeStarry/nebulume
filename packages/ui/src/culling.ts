import type { Asset, AssetListOptions, AssetListResult, ColorLabel, Flag } from './model';

/** Actions available while the viewer is in culling mode. */
export type CullAction =
  | { kind: 'rate'; value: number }
  | { kind: 'rate_step'; delta: 1 | -1 }
  | { kind: 'flag'; value: Flag }
  | { kind: 'color_label'; value: Exclude<ColorLabel, 'none'> }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'view'; value: 'single' | 'compare' }
  | { kind: 'zoom' }
  | { kind: 'clipping' }
  | { kind: 'raw_mode' }
  | { kind: 'undo' }
  | { kind: 'overlay' }
  | { kind: 'mode' }
  | { kind: 'focus' }
  | { kind: 'fullscreen' }
  | { kind: 'escape' };

export interface KeyLike {
  key: string;
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export type AutoAdvanceMode = 'off' | 'fast' | 'standard' | 'relaxed';
export type AutoAdvanceSpeed = Exclude<AutoAdvanceMode, 'off'>;

export const CULL_QUEUE_LIMIT = 10_000;
export const CULL_MARK_ANIMATION_MS = 200;
export const AUTO_ADVANCE_KEY = 'nebulume.cull.auto-advance';
export const AUTO_ADVANCE_SPEED_KEY = 'nebulume.cull.auto-advance-speed';

export const AUTO_ADVANCE_MS: Record<AutoAdvanceSpeed, number> = {
  fast: 200,
  standard: 450,
  relaxed: 800,
};

export const AUTO_ADVANCE_OPTIONS: { value: AutoAdvanceMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'fast', label: '快（0.2 秒）' },
  { value: 'standard', label: '标准（0.45 秒）' },
  { value: 'relaxed', label: '从容（0.8 秒）' },
];

/** Saturating star step within `0..=5` (`0` + `-1` -> `0`, `5` + `+1` -> `5`). */
export function stepRating(rating: number, delta: 1 | -1): number {
  return Math.max(0, Math.min(5, Math.round(rating) + delta));
}

/**
 * Returns `-1` for `[` and `+1` for `]`, including physical `BracketLeft` / `BracketRight`
 * so Chinese / Japanese full-width `【` / `】` still step ratings outside text inputs.
 */
export function ratingStepDelta(event: KeyLike): 1 | -1 | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === '[' || event.code === 'BracketLeft') return -1;
  if (event.key === ']' || event.code === 'BracketRight') return 1;
  return null;
}

export function cullKeyAction(event: KeyLike): CullAction | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey)
    return key === 'z' && !event.shiftKey ? { kind: 'undo' } : null;
  if (event.shiftKey) {
    if (key === 'c') return { kind: 'mode' };
    if (key === 'f') return { kind: 'focus' };
    return null;
  }
  const stepDelta = ratingStepDelta(event);
  if (stepDelta !== null) return { kind: 'rate_step', delta: stepDelta };
  if (/^[0-5]$/.test(key)) return { kind: 'rate', value: Number(key) };
  if (key === '6') return { kind: 'color_label', value: 'red' };
  if (key === '7') return { kind: 'color_label', value: 'yellow' };
  if (key === '8') return { kind: 'color_label', value: 'green' };
  if (key === '9') return { kind: 'color_label', value: 'blue' };
  switch (key) {
    case 'p':
      return { kind: 'flag', value: 'pick' };
    case 'x':
      return { kind: 'flag', value: 'reject' };
    case 'u':
      return { kind: 'flag', value: 'none' };
    case 'arrowright':
      return { kind: 'move', delta: 1 };
    case 'arrowleft':
      return { kind: 'move', delta: -1 };
    case 'g':
      return { kind: 'view', value: 'single' };
    case 'c':
      return { kind: 'view', value: 'compare' };
    case 'z':
      return { kind: 'zoom' };
    case 'j':
      return { kind: 'clipping' };
    case 'r':
      return { kind: 'raw_mode' };
    case 'tab':
    case 'd':
      return { kind: 'overlay' };
    case 'f':
      return { kind: 'fullscreen' };
    case ' ':
    case 'escape':
      return { kind: 'escape' };
    default:
      return null;
  }
}

/** Where to go after a successful mark. The last image stays put rather than wrapping. */
export function nextAfterMark(
  index: number,
  length: number,
  autoAdvance: boolean,
): { index: number; atEnd: boolean } {
  const atEnd = index >= length - 1;
  if (!autoAdvance || atEnd) return { index, atEnd: autoAdvance && atEnd };
  return { index: index + 1, atEnd: false };
}

export interface Mark {
  id: string;
  rating: number;
  flag: Flag;
  color_label: ColorLabel;
}

export function markOf(asset: Pick<Asset, 'id' | 'rating' | 'flag' | 'color_label'>): Mark {
  return {
    id: asset.id,
    rating: asset.rating,
    flag: asset.flag || 'none',
    color_label: asset.color_label || 'none',
  };
}

/** Ids shown together in compare view: the focused image and the ones after it. */
export function compareWindow(ids: string[], index: number, count: number): string[] {
  const size = Math.max(2, Math.min(4, count));
  const start = Math.max(0, Math.min(index, ids.length - size));
  return ids.slice(start, start + size);
}

type ListCommand = (
  command: 'asset.list',
  params: Record<string, unknown>,
) => Promise<AssetListResult>;

/**
 * Freeze the culling queue when the window opens. Later marks never change
 * membership, so an "unflagged" filter does not make images disappear mid-session.
 */
export async function snapshotQueue(
  list: ListCommand,
  libraryId: string,
  options: AssetListOptions,
  startId: string,
  /** Receives every listed photo, so the strip and counts need no extra reads. */
  collect?: (items: Asset[]) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ids.length < CULL_QUEUE_LIMIT; ) {
    const page = await list('asset.list', {
      ...options,
      library_id: libraryId,
      limit: 1000,
      offset,
    });
    ids.push(...page.items.map((item) => item.id));
    collect?.(page.items);
    offset += page.items.length;
    if (!page.items.length || offset >= page.total) break;
  }
  const unique = [...new Set(ids)].slice(0, CULL_QUEUE_LIMIT);
  return unique.includes(startId) ? unique : [startId, ...unique].slice(0, CULL_QUEUE_LIMIT);
}

function isAutoAdvanceSpeed(value: string | null): value is AutoAdvanceSpeed {
  return value === 'fast' || value === 'standard' || value === 'relaxed';
}

export function readLastAutoAdvanceSpeed(): AutoAdvanceSpeed {
  try {
    const savedSpeed = localStorage.getItem(AUTO_ADVANCE_SPEED_KEY);
    if (isAutoAdvanceSpeed(savedSpeed)) return savedSpeed;
    const current = localStorage.getItem(AUTO_ADVANCE_KEY);
    if (isAutoAdvanceSpeed(current)) return current;
  } catch {
    /* Fall back to default speed. */
  }
  return 'fast';
}

export function readAutoAdvanceMode(): AutoAdvanceMode {
  try {
    const raw = localStorage.getItem(AUTO_ADVANCE_KEY);
    if (raw === 'off' || raw === 'false') return 'off';
    if (isAutoAdvanceSpeed(raw)) return raw;
    return 'fast';
  } catch {
    return 'fast';
  }
}

export function writeAutoAdvanceMode(mode: AutoAdvanceMode) {
  try {
    localStorage.setItem(AUTO_ADVANCE_KEY, mode);
    if (mode !== 'off') localStorage.setItem(AUTO_ADVANCE_SPEED_KEY, mode);
  } catch {
    /* The choice still applies for this window. */
  }
}

export function toggleAutoAdvanceMode(current: AutoAdvanceMode): AutoAdvanceMode {
  return current === 'off' ? readLastAutoAdvanceSpeed() : 'off';
}

export function autoAdvanceDelayMs(mode: AutoAdvanceMode): number | null {
  return mode === 'off' ? null : AUTO_ADVANCE_MS[mode];
}

export function readAutoAdvance(): boolean {
  return readAutoAdvanceMode() !== 'off';
}

export function writeAutoAdvance(value: boolean) {
  writeAutoAdvanceMode(value ? readLastAutoAdvanceSpeed() : 'off');
}
