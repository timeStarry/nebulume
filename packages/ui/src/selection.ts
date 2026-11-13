import { createSignal } from 'solid-js';

export interface SelectionModifier {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export const MARK_BATCH_CHUNK = 1000;

/** Splits an arbitrarily large ID list into catalog-safe 1,000-item batch chunks. */
export function chunkIds(ids: readonly string[], size = MARK_BATCH_CHUNK): string[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    out.push(ids.slice(start, start + size));
  }
  return out;
}

/**
 * Pure grid selection state supporting single click, Shift range, ⌘/Ctrl toggle,
 * and full-filter `selectAll` backed by `asset.ids` (even when `total > loaded.length`).
 */
export function createSelection(loadedIds: () => readonly string[]) {
  const [selectedId, setSelectedId] = createSignal<string>();
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const [fullOrder, setFullOrder] = createSignal<readonly string[]>();
  let anchor: string | undefined;

  /** Ordered selected IDs across both loaded pages and full-filter `⌘A` snapshots. */
  const selectedIds = (): string[] => {
    const pickedSet = picked();
    const current = selectedId();
    if (!pickedSet.size && !current) return [];
    const wanted = new Set(pickedSet);
    if (current) wanted.add(current);

    const catalog = fullOrder();
    const loaded = loadedIds();
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const id of catalog ?? loaded) {
      if (wanted.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    // Include any loaded IDs that arrived after `fullOrder` or vice versa.
    for (const id of loaded) {
      if (wanted.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    for (const id of wanted) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    return ordered;
  };

  const isSelected = (id: string): boolean => picked().has(id) || selectedId() === id;

  function clearPicked() {
    if (picked().size) setPicked(new Set<string>());
    if (fullOrder()) setFullOrder(undefined);
    const current = selectedId();
    const loaded = loadedIds();
    if (current && loaded.length > 0 && !loaded.includes(current)) {
      setSelectedId(loaded[0]);
    }
  }

  function reset(nextSelectedId?: string) {
    clearPicked();
    anchor = nextSelectedId;
    setSelectedId(nextSelectedId);
  }

  function setAnchor(id: string | undefined) {
    anchor = id;
  }

  function getAnchor(): string | undefined {
    return anchor;
  }

  function select(id: string, event?: SelectionModifier) {
    const order = fullOrder() ?? loadedIds();
    if (event?.shiftKey && (anchor ?? selectedId())) {
      const fromId = anchor ?? selectedId()!;
      const from = order.indexOf(fromId);
      const to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setPicked(new Set(order.slice(start, end + 1)));
        setSelectedId(id);
        return;
      }
    }
    if (event?.ctrlKey || event?.metaKey) {
      const next = new Set(selectedIds());
      if (next.has(id) && next.size > 1) {
        next.delete(id);
        setPicked(next);
        if (selectedId() === id) setSelectedId([...next].at(-1));
      } else {
        next.add(id);
        setPicked(next);
        setSelectedId(id);
      }
      anchor = id;
      return;
    }
    clearPicked();
    anchor = id;
    setSelectedId(id);
  }

  /**
   * Adopts a full-filter ID list (from `asset.ids`, or loaded IDs as fallback)
   * so `⌘A` selects every matching photo in the library rather than just page 1.
   */
  function selectAll(allIds: readonly string[]) {
    if (!allIds.length) return;
    setFullOrder(allIds);
    setPicked(new Set(allIds));
    const current = selectedId();
    const keep = current && allIds.includes(current) ? current : allIds[0];
    setSelectedId(keep);
    anchor = allIds[0];
  }

  /** Prunes IDs that were removed/trashed or filtered out when reconciling a list. */
  function pruneTo(validIds: ReadonlySet<string>, allowUnloaded = false) {
    if (allowUnloaded && fullOrder()) return;
    const prev = picked();
    if (prev.size) {
      const kept = new Set([...prev].filter((id) => validIds.has(id)));
      if (kept.size !== prev.size) setPicked(kept);
    }
    if (!prev.size && fullOrder()) setFullOrder(undefined);
  }

  return {
    selectedId,
    setSelectedId,
    picked,
    setPicked,
    hasFullOrder: () => !!fullOrder(),
    selectedIds,
    isSelected,
    clearPicked,
    reset,
    select,
    selectAll,
    pruneTo,
    setAnchor,
    getAnchor,
  };
}
