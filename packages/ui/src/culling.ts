import type { Asset, AssetListOptions, AssetListResult, Flag } from './model';

/** Actions available while the viewer is in culling mode. */
export type CullAction =
  | { kind: 'rate'; value: number }
  | { kind: 'flag'; value: Flag }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'view'; value: 'single' | 'compare' }
  | { kind: 'zoom' }
  | { kind: 'undo' }
  | { kind: 'hud' }
  | { kind: 'mode' }
  | { kind: 'focus' }
  | { kind: 'fullscreen' }
  | { kind: 'escape' };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export const CULL_QUEUE_LIMIT = 10_000;
export const CULL_MARK_ANIMATION_MS = 250;
export const AUTO_ADVANCE_KEY = 'nebulume.cull.auto-advance';

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
  if (/^[0-5]$/.test(key)) return { kind: 'rate', value: Number(key) };
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
    case 'tab':
      return { kind: 'hud' };
    case 'f':
      return { kind: 'fullscreen' };
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
}

export function markOf(asset: Pick<Asset, 'id' | 'rating' | 'flag'>): Mark {
  return { id: asset.id, rating: asset.rating, flag: asset.flag || 'none' };
}

/** Session-only undo of marks; each entry is the state before one mark. */
export class UndoStack {
  private entries: Mark[] = [];
  constructor(private readonly limit = 200) {}
  push(before: Mark) {
    this.entries.push(before);
    if (this.entries.length > this.limit) this.entries.shift();
  }
  pop(): Mark | undefined {
    return this.entries.pop();
  }
  get size() {
    return this.entries.length;
  }
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
    offset += page.items.length;
    if (!page.items.length || offset >= page.total) break;
  }
  const unique = [...new Set(ids)].slice(0, CULL_QUEUE_LIMIT);
  return unique.includes(startId) ? unique : [startId, ...unique].slice(0, CULL_QUEUE_LIMIT);
}

export function readAutoAdvance(): boolean {
  try {
    return localStorage.getItem(AUTO_ADVANCE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeAutoAdvance(value: boolean) {
  try {
    localStorage.setItem(AUTO_ADVANCE_KEY, String(value));
  } catch {
    /* The choice still applies for this window. */
  }
}
