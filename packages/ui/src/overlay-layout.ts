/** Which overlay widgets sit in each corner of the viewer, and how that choice is saved. */
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export type OverlayLayout = Record<Corner, string[]>;

export const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br'];
export const CORNER_LABELS: Record<Corner, string> = {
  tl: '左上',
  tr: '右上',
  bl: '左下',
  br: '右下',
};
export const OVERLAY_KEY = 'nebulume.viewer.overlay';
export const OVERLAY_FADES_KEY = 'nebulume.viewer.overlay-fades';

export const DEFAULT_OVERLAY: Readonly<OverlayLayout> = Object.freeze({
  tl: ['captured'],
  tr: ['rating', 'flag'],
  bl: ['body-lens', 'exposure'],
  br: ['histogram'],
});

const copy = (layout: Readonly<OverlayLayout>): OverlayLayout => ({
  tl: [...layout.tl],
  tr: [...layout.tr],
  bl: [...layout.bl],
  br: [...layout.br],
});

/**
 * Reads the saved layout. Anything unreadable gives the default; unknown widget ids and
 * repeats are dropped (first occurrence wins), and a missing corner is empty.
 */
export function readOverlay(storage: Pick<Storage, 'getItem'>, known: Set<string>): OverlayLayout {
  let raw: unknown;
  try {
    const text = storage.getItem(OVERLAY_KEY);
    if (text === null) return copy(DEFAULT_OVERLAY);
    raw = JSON.parse(text);
  } catch {
    return copy(DEFAULT_OVERLAY);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return copy(DEFAULT_OVERLAY);
  const record = raw as Record<string, unknown>;
  if (CORNERS.some((corner) => corner in record && !Array.isArray(record[corner])))
    return copy(DEFAULT_OVERLAY);
  if (!CORNERS.some((corner) => corner in record)) return copy(DEFAULT_OVERLAY);
  const seen = new Set<string>();
  const layout = { tl: [], tr: [], bl: [], br: [] } as OverlayLayout;
  for (const corner of CORNERS)
    for (const id of (record[corner] as unknown[] | undefined) ?? []) {
      if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue;
      seen.add(id);
      layout[corner].push(id);
    }
  return layout;
}

export function writeOverlay(storage: Pick<Storage, 'setItem'>, layout: OverlayLayout) {
  try {
    storage.setItem(OVERLAY_KEY, JSON.stringify(layout));
  } catch {
    /* The layout still applies to this window. */
  }
}

export function removeWidget(layout: OverlayLayout, id: string): OverlayLayout {
  const next = copy(layout);
  for (const corner of CORNERS) next[corner] = next[corner].filter((each) => each !== id);
  return next;
}

/** Puts `id` at `index` of `to` (`-1` appends), taking it out of wherever it was. */
export function moveWidget(
  layout: OverlayLayout,
  id: string,
  to: Corner,
  index: number,
): OverlayLayout {
  const next = removeWidget(layout, id);
  const list = next[to];
  const at = index < 0 || index > list.length ? list.length : index;
  list.splice(at, 0, id);
  return next;
}

export function addWidget(layout: OverlayLayout, id: string, corner: Corner): OverlayLayout {
  return moveWidget(layout, id, corner, -1);
}

/** Moves a widget one place up or down within its corner, stopping at the ends. */
export function shiftWidget(layout: OverlayLayout, id: string, delta: -1 | 1): OverlayLayout {
  const corner = cornerOf(layout, id);
  if (!corner) return layout;
  const list = layout[corner];
  const from = list.indexOf(id);
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (to === from) return copy(layout);
  return moveWidget(layout, id, corner, to);
}

export function cornerOf(layout: OverlayLayout, id: string): Corner | undefined {
  return CORNERS.find((corner) => layout[corner].includes(id));
}

export function widgetsNotIn(layout: OverlayLayout, all: string[]): string[] {
  const used = new Set(CORNERS.flatMap((corner) => layout[corner]));
  return all.filter((id) => !used.has(id));
}

export function readOverlayFades(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(OVERLAY_FADES_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeOverlayFades(storage: Pick<Storage, 'setItem'>, value: boolean) {
  try {
    storage.setItem(OVERLAY_FADES_KEY, String(value));
  } catch {
    /* Applies to this window only. */
  }
}
