import { For, Show, createMemo, createSignal } from 'solid-js';
import type { Asset } from '../model';
import './DateScrubber.css';

export interface DateStop {
  id: string;
  monthKey: string;
  shortLabel: string;
  fullLabel: string;
  assetIndex: number;
}

export function buildDateStops(
  items: readonly Asset[],
  field: 'captured_at' | 'created_at' | 'modified_at',
  maxTicks = 16,
): DateStop[] {
  const months: DateStop[] = [];
  let lastMonth = '';
  items.forEach((asset, index) => {
    const raw = asset[field]?.slice(0, 7);
    if (!raw || !/^\d{4}-\d{2}$/.test(raw) || raw === lastMonth) return;
    lastMonth = raw;
    const [year, month] = raw.split('-');
    const prevYear = months.at(-1)?.monthKey.slice(0, 4);
    months.push({
      id: `${raw}:${index}`,
      monthKey: raw,
      shortLabel: prevYear !== year ? year.slice(2) + '年' : `${Number(month)}月`,
      fullLabel: `${year}年${Number(month)}月`,
      assetIndex: index,
    });
  });
  if (months.length <= maxTicks) return months;
  const step = (months.length - 1) / (maxTicks - 1);
  const sampled: DateStop[] = [];
  for (let i = 0; i < maxTicks; i++) {
    sampled.push(months[Math.round(i * step)]);
  }
  return sampled;
}

export default function DateScrubber(props: {
  items: readonly Asset[];
  sortBy: string;
  onJumpToIndex: (index: number) => void;
}) {
  const [hoverStop, setHoverStop] = createSignal<{ label: string; yPercent: number } | null>(null);
  const [activeKey, setActiveKey] = createSignal('');
  let track!: HTMLElement;

  const stops = createMemo(() => {
    if (
      props.sortBy !== 'captured_at' &&
      props.sortBy !== 'created_at' &&
      props.sortBy !== 'modified_at'
    )
      return [];
    return buildDateStops(props.items, props.sortBy);
  });

  function scrubAtClientY(clientY: number, commit: boolean) {
    const list = stops();
    if (!track || list.length < 2) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
    const target = list[Math.min(list.length - 1, Math.round(ratio * (list.length - 1)))];
    setHoverStop({ label: target.fullLabel, yPercent: ratio * 100 });
    setActiveKey(target.id);
    if (commit) props.onJumpToIndex(target.assetIndex);
  }

  return (
    <Show when={stops().length >= 2}>
      <nav
        ref={track}
        class="date-scrubber"
        aria-label="时间轴快速定位"
        onPointerMove={(e) => {
          if (e.buttons === 1) scrubAtClientY(e.clientY, true);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          track.setPointerCapture(e.pointerId);
          scrubAtClientY(e.clientY, true);
        }}
        onPointerLeave={() => setHoverStop(null)}
        onPointerUp={() => setHoverStop(null)}
      >
        <For each={stops()}>
          {(stop, index) => (
            <button
              type="button"
              class="date-scrubber-tick"
              classList={{ active: activeKey() === stop.id }}
              title={`跳转到 ${stop.fullLabel}`}
              onMouseEnter={() =>
                setHoverStop({
                  label: stop.fullLabel,
                  yPercent: (index() / Math.max(1, stops().length - 1)) * 100,
                })
              }
              onClick={() => {
                setActiveKey(stop.id);
                props.onJumpToIndex(stop.assetIndex);
              }}
            >
              {stop.shortLabel}
            </button>
          )}
        </For>
        <Show when={hoverStop()}>
          {(info) => (
            <span class="date-scrubber-hud" style={{ top: `${info().yPercent}%` }}>
              {info().label}
            </span>
          )}
        </Show>
      </nav>
    </Show>
  );
}
