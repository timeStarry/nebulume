import { createSignal } from 'solid-js';

/** One reversible action. `revert` puts the catalog (and files) back as they were. */
export interface UndoEntry {
  label: string;
  revert: () => Promise<void>;
  /** Shown as a bottom toast with an undo button (Trash, batch rejects). */
  toast?: boolean;
  /** Photos the entry touches; `forget` drops mark entries of photos that left the session. */
  ids?: string[];
}

export const UNDO_TOAST_MS = 10_000;

/**
 * Session undo history for one window. `Ctrl/⌘+Z` calls `undo()` (latest first); the toast's
 * button calls `undo(entry)` for the action it shows. A failed revert stays in the history so
 * the user can retry, and the error propagates to the caller.
 */
export function createUndoHistory(limit = 100) {
  const entries: UndoEntry[] = [];
  const [offer, setOffer] = createSignal<UndoEntry>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function dismiss() {
    clearTimeout(timer);
    setOffer(undefined);
  }
  function push(entry: UndoEntry) {
    entries.push(entry);
    if (entries.length > limit) entries.shift();
    if (entry.toast) {
      clearTimeout(timer);
      setOffer(entry);
      timer = setTimeout(() => {
        if (offer() === entry) setOffer(undefined);
      }, UNDO_TOAST_MS);
    }
  }
  async function undo(entry?: UndoEntry): Promise<UndoEntry | undefined> {
    const index = entry ? entries.lastIndexOf(entry) : entries.length - 1;
    if (index < 0) return undefined;
    const [target] = entries.splice(index, 1);
    if (offer() === target) dismiss();
    try {
      await target.revert();
    } catch (error) {
      entries.splice(Math.min(index, entries.length), 0, target);
      throw error;
    }
    return target;
  }
  /** Removes an entry without reverting it (its action failed and was already rolled back). */
  function remove(entry: UndoEntry) {
    const index = entries.lastIndexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    if (offer() === entry) dismiss();
  }
  function peek(): UndoEntry | undefined {
    return entries.at(-1);
  }
  /** Drops non-toast entries for photos that are gone (moved to the Trash). */
  function forget(ids: Set<string>) {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry.toast && entry.ids?.some((id) => ids.has(id))) entries.splice(index, 1);
    }
  }
  function clear() {
    entries.length = 0;
    dismiss();
  }
  return {
    offer,
    push,
    undo,
    dismiss,
    clear,
    peek,
    forget,
    remove,
    get size() {
      return entries.length;
    },
  };
}
export type UndoHistory = ReturnType<typeof createUndoHistory>;

import type { ColorLabel } from './model';

export const COLOR_LABEL_NAMES: Record<ColorLabel, string> = {
  none: '无色标',
  red: '红色色标',
  yellow: '黄色色标',
  green: '绿色色标',
  blue: '蓝色色标',
};

export function keyToColorLabel(key: string): Exclude<ColorLabel, 'none'> | undefined {
  return ({ '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' } as const)[key];
}

/** Previous marks grouped so each group is one `asset.mark_batch` call (≤1000 ids). */
export function groupMarks<
  T extends { id: string; rating: number; flag: string; color_label?: ColorLabel },
>(
  marks: T[],
  chunk = 1000,
): { ids: string[]; rating: number; flag: string; color_label?: ColorLabel }[] {
  const groups = new Map<
    string,
    { ids: string[]; rating: number; flag: string; color_label?: ColorLabel }
  >();
  for (const mark of marks) {
    const key = `${mark.rating}:${mark.flag}:${mark.color_label ?? ''}`;
    const group = groups.get(key) ?? {
      ids: [],
      rating: mark.rating,
      flag: mark.flag,
      ...(mark.color_label !== undefined ? { color_label: mark.color_label } : {}),
    };
    group.ids.push(mark.id);
    groups.set(key, group);
  }
  const out: { ids: string[]; rating: number; flag: string; color_label?: ColorLabel }[] = [];
  for (const group of groups.values())
    for (let start = 0; start < group.ids.length; start += chunk)
      out.push({ ...group, ids: group.ids.slice(start, start + chunk) });
  return out;
}

/** Short HUD text for a mark: stars for a rating, a word for a flag or color label. */
export function markHudText(mark: {
  rating?: number;
  flag?: string;
  color_label?: ColorLabel;
}): string {
  if (mark.rating !== undefined)
    return mark.rating ? `${'★'.repeat(mark.rating)}  ${mark.rating}` : '清除星级';
  if (mark.color_label !== undefined)
    return mark.color_label === 'none' ? '清除色标' : COLOR_LABEL_NAMES[mark.color_label];
  return mark.flag === 'pick' ? '留用' : mark.flag === 'reject' ? '淘汰' : '清除旗标';
}
