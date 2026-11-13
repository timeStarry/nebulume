import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';

export interface JustifiedItem {
  /** Width / height of what the tile shows (after crop and orientation). */
  ratio: number;
  /** Section the item belongs to, such as its capture day; consecutive items share one. */
  group?: string;
}

export interface JustifiedGridApi {
  /** Index reached by an arrow, Home/End or Page key from `index`, following the real rows. */
  step(index: number, key: string): number | undefined;
  /** Scrolls the minimum distance that brings the item fully into view. */
  scrollToIndex(index: number): void;
  /** Photos per row on average, for callers that only need an estimate. */
  columns(): number;
  rowsPerPage(): number;
}

type Tile = { index: number; left: number; width: number };
type Row = { top: number; height: number; tiles: Tile[] };
type Section = {
  key: string;
  label: string;
  detail: string;
  top: number;
  bottom: number;
  rows: Row[];
};
type CachedSection = {
  rawKey: string;
  start: number;
  count: number;
  top: number;
  nextTop: number;
  label: string;
  detail: string;
  ratiosKey: string;
  section: Section;
};

const GAP = 4;
const HEADER = 46;
const SECTION_GAP = 18;

/**
 * Photos in justified rows: each row fills the width and every photo keeps its
 * aspect ratio, so nothing is letterboxed or cropped. Rows are grouped into
 * sections (capture days) with a header, and only rows near the viewport are
 * mounted; a spacer keeps the full height so paging and scroll restore still work.
 */
export default function JustifiedGrid<T>(props: {
  items: T[];
  measure: (item: T) => JustifiedItem;
  /** Header text for a group key; omitted groups render without a header. */
  section?: (key: string, items: T[]) => { label: string; detail: string } | undefined;
  rowHeight: number;
  scroller: () => HTMLElement | undefined;
  ref?: (api: JustifiedGridApi) => void;
  children: (item: T, size: { width: number; height: number }) => JSX.Element;
}) {
  let root!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  const [viewport, setViewport] = createSignal({ top: 0, height: 0 });

  let prevWidth = 0;
  let prevTarget = 0;
  let prevSections: CachedSection[] = [];

  const layout = createMemo(() => {
    const available = width();
    const target = props.rowHeight;
    const sections: Section[] = [];
    if (available <= 0) {
      prevSections = [];
      return { sections, height: 0, rowOf: [] as { row: Row; tile: Tile }[] };
    }
    const canReuse = available === prevWidth && target === prevTarget;
    const nextCache: CachedSection[] = [];
    const rowOf: { row: Row; tile: Tile }[] = [];
    const items = props.items;
    const firstKey = items.length ? (props.measure(items[0]).group ?? '') : '';
    const firstHasHeader = Boolean(firstKey && props.section?.(firstKey, items.slice(0, 1)));
    let top = firstHasHeader ? 0 : 16;
    let start = 0;
    let sectionIndex = 0;
    while (start < items.length) {
      const key = props.measure(items[start]).group ?? '';
      let end = start;
      const groupRatios: number[] = [];
      while (end < items.length) {
        const measured = props.measure(items[end]);
        if ((measured.group ?? '') !== key) break;
        groupRatios.push(Math.min(4, Math.max(0.25, measured.ratio || 1.5)));
        end++;
      }
      const header = key && props.section ? props.section(key, items.slice(start, end)) : undefined;
      const label = header?.label ?? '';
      const detail = header?.detail ?? '';
      const count = end - start;
      const ratiosKey = groupRatios.join(',');
      const cached = canReuse ? prevSections[sectionIndex] : undefined;
      if (
        cached &&
        cached.rawKey === key &&
        cached.start === start &&
        cached.count === count &&
        cached.top === top &&
        cached.label === label &&
        cached.detail === detail &&
        cached.ratiosKey === ratiosKey
      ) {
        for (const finished of cached.section.rows)
          for (const tile of finished.tiles) rowOf[tile.index] = { row: finished, tile };
        sections.push(cached.section);
        nextCache.push(cached);
        top = cached.nextTop;
        start = end;
        sectionIndex++;
        continue;
      }
      const section: Section = {
        key: `${key}:${start}`,
        label,
        detail,
        top,
        bottom: top,
        rows: [],
      };
      let y = top + (header ? HEADER : 0);
      let row: { index: number; ratio: number }[] = [];
      let ratios = 0;
      const close = (height: number) => {
        let x = 0;
        const placed = row.map((tile) => {
          const w = Math.max(24, tile.ratio * height);
          const result = { index: tile.index, left: x, width: w };
          x += w + GAP;
          return result;
        });
        // Absorb rounding so a full row ends exactly at the right edge.
        if (height < target * 1.6 && placed.length) {
          const extra = available - (x - GAP);
          if (Math.abs(extra) < 8) placed[placed.length - 1].width += extra;
        }
        const finished = { top: y, height, tiles: placed };
        for (const tile of placed) rowOf[tile.index] = { row: finished, tile };
        section.rows.push(finished);
        y += height + GAP;
        row = [];
        ratios = 0;
      };
      for (let offsetIndex = 0; offsetIndex < count; offsetIndex++) {
        const index = start + offsetIndex;
        const ratio = groupRatios[offsetIndex];
        row.push({ index, ratio });
        ratios += ratio;
        const height = (available - GAP * (row.length - 1)) / ratios;
        if (height <= target) close(height);
      }
      // A short last row keeps the target height instead of stretching.
      if (row.length) close(target);
      section.bottom = Math.max(top, y - GAP);
      const nextTop = section.bottom + SECTION_GAP;
      sections.push(section);
      nextCache.push({
        rawKey: key,
        start,
        count,
        top,
        nextTop,
        label,
        detail,
        ratiosKey,
        section,
      });
      top = nextTop;
      start = end;
      sectionIndex++;
    }
    prevWidth = available;
    prevTarget = target;
    prevSections = nextCache;
    return { sections, height: Math.max(0, top - SECTION_GAP), rowOf };
  });

  const visibleRows = createMemo(() => {
    const { top, height } = viewport();
    const margin = Math.max(600, height);
    const from = top - margin;
    const to = top + height + margin;
    // The same Row objects every time, so <For> keeps mounted tiles while scrolling.
    const rows: Row[] = [];
    for (const section of layout().sections)
      for (const row of section.rows)
        if (row.top + row.height >= from && row.top <= to) rows.push(row);
    return rows;
  });
  // Keyed by the item itself for visible rows only: a re-layout moves tiles instead of
  // remounting them, while avoiding an O(N) map rebuild across off-screen rows.
  const placements = createMemo(() => {
    const map = new Map<T, { left: number; top: number; width: number; height: number }>();
    const items = props.items;
    for (const row of visibleRows())
      for (const tile of row.tiles)
        map.set(items[tile.index], {
          left: tile.left,
          top: row.top,
          width: tile.width,
          height: row.height,
        });
    return map;
  });
  const visibleItems = createMemo(() =>
    visibleRows().flatMap((row) => row.tiles.map((tile) => props.items[tile.index])),
  );
  const visibleSections = createMemo(() => {
    const { top, height } = viewport();
    const margin = Math.max(600, height);
    const from = top - margin;
    const to = top + height + margin;
    return layout().sections.filter(
      (section) => section.label && section.bottom >= from && section.top <= to,
    );
  });
  // The section whose rows are under the top edge keeps its header clearance for keyboard jumps.
  const pinned = createMemo(() => {
    const { top } = viewport();
    let current: Section | undefined;
    for (const section of layout().sections)
      if (section.label && section.top <= top && section.bottom > top) current = section;
    return current;
  });

  function offset(scroller: HTMLElement) {
    return (
      root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    );
  }
  function measure() {
    const scroller = props.scroller();
    if (!scroller || !root.isConnected) return;
    setViewport({
      top: Math.max(0, scroller.scrollTop - offset(scroller)),
      height: scroller.clientHeight,
    });
  }
  createEffect(() => {
    layout();
    queueMicrotask(measure);
  });
  onMount(() => {
    setWidth(root.clientWidth);
    const resize = new ResizeObserver(() => {
      setWidth(root.clientWidth);
      measure();
    });
    resize.observe(root);
    const scroller = props.scroller();
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    if (scroller) resize.observe(scroller);
    measure();
    onCleanup(() => {
      resize.disconnect();
      scroller?.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    });
  });

  const allRows = () => layout().sections.flatMap((section) => section.rows);
  function nearestIn(row: Row, center: number) {
    let best = row.tiles[0];
    for (const tile of row.tiles)
      if (
        Math.abs(tile.left + tile.width / 2 - center) <
        Math.abs(best.left + best.width / 2 - center)
      )
        best = tile;
    return best.index;
  }
  props.ref?.({
    step(index, key) {
      const last = props.items.length - 1;
      if (last < 0) return undefined;
      if (index < 0)
        return ['ArrowRight', 'ArrowDown', 'Home', 'PageDown'].includes(key) ? 0 : undefined;
      if (key === 'ArrowRight') return Math.min(last, index + 1);
      if (key === 'ArrowLeft') return Math.max(0, index - 1);
      if (key === 'Home') return 0;
      if (key === 'End') return last;
      const place = layout().rowOf[index];
      const rows = allRows();
      if (!place) return undefined;
      const center = place.tile.left + place.tile.width / 2;
      const at = rows.indexOf(place.row);
      const pageRows = Math.max(1, Math.floor(viewport().height / (props.rowHeight + GAP)));
      const offsetRows = { ArrowDown: 1, ArrowUp: -1, PageDown: pageRows, PageUp: -pageRows }[key];
      if (offsetRows === undefined) return undefined;
      const target = rows[Math.min(rows.length - 1, Math.max(0, at + offsetRows))];
      // Past the first or last row: go to the very first or last photo.
      if (target === place.row) return offsetRows > 0 ? last : 0;
      return nearestIn(target, center);
    },
    scrollToIndex(index) {
      const scroller = props.scroller();
      const place = layout().rowOf[index];
      if (!scroller || !place) return;
      const pinnedHeader = pinned() ? HEADER : 0;
      const top = offset(scroller) + place.row.top;
      const bottom = top + place.row.height;
      if (top - pinnedHeader < scroller.scrollTop) scroller.scrollTop = top - pinnedHeader;
      else if (bottom > scroller.scrollTop + scroller.clientHeight)
        scroller.scrollTop = bottom - scroller.clientHeight;
      measure();
    },
    columns: () => {
      const rows = allRows();
      return rows.length ? Math.max(1, Math.round(props.items.length / rows.length)) : 1;
    },
    rowsPerPage: () => Math.max(1, Math.floor(viewport().height / (props.rowHeight + GAP))),
  });

  return (
    <div ref={root} class="justified-grid photo-grid" style={{ height: `${layout().height}px` }}>
      <For each={visibleSections()}>
        {(section, index) => {
          const marginTop = () => {
            const idx = index();
            const prev = idx > 0 ? visibleSections()[idx - 1] : undefined;
            return prev ? section.top - prev.bottom : section.top;
          };
          return (
            <div
              class="day-section"
              style={{
                'margin-top': `${marginTop()}px`,
                height: `${section.bottom - section.top}px`,
              }}
            >
              <div class="day-head">
                <h2>{section.label}</h2>
                <span>{section.detail}</span>
              </div>
            </div>
          );
        }}
      </For>
      <For each={visibleItems()}>
        {(item) => {
          const place = () => placements().get(item);
          const size = {
            get width() {
              return place()?.width ?? 0;
            },
            get height() {
              return place()?.height ?? 0;
            },
          };
          return (
            <div
              class="justified-tile"
              style={{
                left: `${place()?.left ?? 0}px`,
                top: `${place()?.top ?? 0}px`,
                width: `${size.width}px`,
                height: `${size.height}px`,
              }}
            >
              {props.children(item, size)}
            </div>
          );
        }}
      </For>
    </div>
  );
}
