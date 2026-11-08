import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';

export interface VirtualGridApi {
  columns(): number;
  rowsPerPage(): number;
  /** Scrolls the minimum distance that brings the item's row fully into view. */
  scrollToIndex(index: number): void;
}

/**
 * Renders only the rows near the viewport of `scroller`. A spacer keeps the
 * full scroll height, so the scrollbar, auto-paging sentinel and scroll
 * restoration behave as if every row existed. Rows are uniform: the row height
 * is the tallest rendered card, so a card with extra content never overlaps.
 */
export default function VirtualGrid<T>(props: {
  items: T[];
  itemSize: number;
  scroller: () => HTMLElement | undefined;
  overscanRows?: number;
  class?: string;
  style?: JSX.CSSProperties;
  ref?: (api: VirtualGridApi) => void;
  children: (item: T) => JSX.Element;
}) {
  let root!: HTMLDivElement;
  let inner!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  const [gap, setGap] = createSignal(12);
  const [viewport, setViewport] = createSignal({ top: 0, height: 0 });
  const [rowHeight, setRowHeight] = createSignal(0);
  // Matches `repeat(auto-fill, minmax(itemSize, 1fr))`.
  const columns = createMemo(() =>
    Math.max(1, Math.floor((width() + gap()) / (props.itemSize + gap()))),
  );
  const rowCount = () => Math.ceil(props.items.length / columns());
  const pitch = () => (rowHeight() || props.itemSize) + gap();
  const range = createMemo(() => {
    const overscan = props.overscanRows ?? 3;
    const { top, height } = viewport();
    const first = Math.max(0, Math.floor(top / pitch()) - overscan);
    const last = Math.min(rowCount(), Math.ceil((top + height) / pitch()) + overscan);
    return { first, last: Math.max(first, last) };
  });
  const visible = createMemo(() =>
    props.items.slice(range().first * columns(), range().last * columns()),
  );

  function gridOffset(scroller: HTMLElement) {
    return (
      root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    );
  }
  function measureViewport() {
    const scroller = props.scroller();
    if (!scroller || !root.isConnected) return;
    setViewport({
      top: Math.max(0, scroller.scrollTop - gridOffset(scroller)),
      height: scroller.clientHeight,
    });
  }
  function measureRows() {
    let tallest = 0;
    for (const card of Array.from(inner.children) as HTMLElement[])
      tallest = Math.max(tallest, card.scrollHeight);
    if (tallest && Math.abs(tallest - rowHeight()) > 0.5) setRowHeight(tallest);
  }

  // A different size or column count changes card heights; measure afresh.
  createEffect(() => {
    props.itemSize;
    columns();
    setRowHeight(0);
  });
  createEffect(() => {
    visible();
    rowHeight();
    queueMicrotask(() => root.isConnected && measureRows());
  });

  onMount(() => {
    setGap(Number.parseFloat(getComputedStyle(inner).rowGap) || 12);
    setWidth(root.clientWidth);
    const resize = new ResizeObserver(() => {
      setWidth(root.clientWidth);
      measureViewport();
    });
    resize.observe(root);
    const scroller = props.scroller();
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureViewport();
      });
    };
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    if (scroller) resize.observe(scroller);
    measureViewport();
    onCleanup(() => {
      resize.disconnect();
      scroller?.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    });
  });

  props.ref?.({
    columns,
    rowsPerPage: () => Math.max(1, Math.floor(viewport().height / pitch())),
    scrollToIndex(index) {
      const scroller = props.scroller();
      if (!scroller || index < 0) return;
      const top = gridOffset(scroller) + Math.floor(index / columns()) * pitch();
      const bottom = top + (rowHeight() || props.itemSize);
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (bottom > scroller.scrollTop + scroller.clientHeight)
        scroller.scrollTop = bottom - scroller.clientHeight;
      measureViewport();
    },
  });

  return (
    <div
      ref={root}
      class="virtual-grid"
      style={{ height: `${Math.max(0, rowCount() * pitch() - gap())}px` }}
    >
      <div
        ref={inner}
        class={props.class}
        style={{
          ...props.style,
          transform: `translateY(${range().first * pitch()}px)`,
          'grid-template-columns': `repeat(${columns()}, minmax(0, 1fr))`,
          'grid-auto-rows': rowHeight() ? `${rowHeight()}px` : undefined,
        }}
      >
        <For each={visible()}>{(item) => props.children(item)}</For>
      </div>
    </div>
  );
}
