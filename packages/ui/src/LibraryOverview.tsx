import { createResource, For, Show } from 'solid-js';
import { execute } from './api';
import { Button } from './ui';
import './library/overview.css';
import type { AssetListOptions, LibraryStats, StatsBin } from './model';

export type OverviewPick = { label: string; options: Partial<AssetListOptions> };

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dayLabel = (day: string) => {
  const date = new Date(`${day}T00:00:00`);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
};
const gigabytes = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`;

/** Every day from the first to the last capture, so trips show as clusters with gaps. */
function continuousDays(days: { day: string; count: number }[]) {
  if (!days.length) return [];
  const counts = new Map(days.map((entry) => [entry.day, entry.count]));
  const out: { day: string; count: number }[] = [];
  const end = new Date(`${days.at(-1)!.day}T00:00:00`);
  for (
    let d = new Date(`${days[0].day}T00:00:00`);
    d <= end && out.length < 1500;
    d.setDate(d.getDate() + 1)
  ) {
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ day, count: counts.get(day) ?? 0 });
  }
  return out;
}

/**
 * The library at a glance, for exactly the photos the grid would show. Every bar,
 * segment and row is a way into those photos: it returns a filter for the grid.
 */
export default function LibraryOverview(props: {
  options: AssetListOptions;
  onPick: (pick: OverviewPick) => void;
  onCull: () => void;
}) {
  const [stats] = createResource(
    () => JSON.stringify({ ...props.options, limit: undefined, offset: undefined }),
    (key) => execute<LibraryStats>('asset.stats', JSON.parse(key)),
  );
  const Bars = (barProps: {
    label: string;
    items: { key: string; tick: string; count: number; title: string; pick?: OverviewPick }[];
  }) => {
    const max = () => Math.max(1, ...barProps.items.map((item) => item.count));
    return (
      <div class="ov-bars" role="list" aria-label={barProps.label}>
        <For each={barProps.items}>
          {(item) => (
            <button
              class="ov-bar"
              role="listitem"
              disabled={!item.count || !item.pick}
              aria-label={`${item.title}：${item.count} 张`}
              title={`${item.title}：${item.count} 张`}
              onClick={() => item.pick && props.onPick(item.pick)}
            >
              <span class="ov-bar-fill" style={{ height: `${(item.count / max()) * 100}%` }} />
              <span class="ov-bar-tick">{item.tick}</span>
            </button>
          )}
        </For>
      </div>
    );
  };
  const binItems = (
    bins: StatsBin[],
    unit: string,
    keys: [keyof AssetListOptions, keyof AssetListOptions],
  ) =>
    bins.map((bin) => ({
      key: bin.label,
      tick: bin.label,
      count: bin.count,
      title: `${bin.label}${unit}`,
      pick: {
        label: `${unit === ' mm' ? '焦距' : 'ISO'} ${bin.label}${unit}`,
        options: { [keys[0]]: bin.min, [keys[1]]: bin.max ?? undefined },
      },
    }));
  const Ranked = (rankedProps: {
    rows: { name: string; count: number }[];
    filter: 'camera' | 'lens';
  }) => {
    const max = () => Math.max(1, ...rankedProps.rows.map((row) => row.count));
    return (
      <ul class="ov-ranked">
        <For each={rankedProps.rows} fallback={<li class="ov-empty">没有记录</li>}>
          {(row) => (
            <li>
              <button
                onClick={() =>
                  props.onPick({ label: row.name, options: { [rankedProps.filter]: row.name } })
                }
              >
                <span class="ov-name">{row.name}</span>
                <span class="ov-meter">
                  <span style={{ width: `${(row.count / max()) * 100}%` }} />
                </span>
                <span class="ov-num">{row.count}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    );
  };
  return (
    <div class="library-overview" aria-label="图片库概览" aria-busy={stats.loading}>
      <Show when={stats.error}>
        <p class="ov-error" role="alert">
          无法读取统计：{String(stats.error?.message ?? stats.error)}
        </p>
      </Show>
      <Show when={stats()}>
        {(data) => {
          const s = data();
          const share = (count: number) => `${s.photos ? (count / s.photos) * 100 : 0}%`;
          const days = continuousDays(s.days);
          return (
            <>
              <div class="ov-figures">
                <div>
                  <b>{s.photos}</b>
                  <span>张照片</span>
                </div>
                <div>
                  <b>{s.photos ? Math.round((s.picks / s.photos) * 100) : 0}%</b>
                  <span>留用率</span>
                </div>
                <div>
                  <b>{gigabytes(s.bytes)}</b>
                  <span>原片占用，{s.files} 个文件</span>
                </div>
                <div>
                  <b>{s.unprocessed}</b>
                  <span>张还没处理</span>
                </div>
              </div>
              <section>
                <h2>拍摄时间线</h2>
                <p class="ov-hint">
                  每天一根柱子。点有照片的一天，看那天的照片。
                  <Show when={s.undated}>另有 {s.undated} 张没有拍摄时间。</Show>
                </p>
                <Show when={days.length} fallback={<p class="ov-empty">没有拍摄时间记录</p>}>
                  <Bars
                    label="每日拍摄数量"
                    items={days.map((entry, index) => ({
                      key: entry.day,
                      tick:
                        index === 0 || entry.day.endsWith('-01')
                          ? `${Number(entry.day.slice(5, 7))}月${index === 0 ? Number(entry.day.slice(8)) + '日' : ''}`
                          : '',
                      count: entry.count,
                      title: dayLabel(entry.day),
                      pick: {
                        label: dayLabel(entry.day),
                        options: { captured_from: entry.day, captured_to: entry.day },
                      },
                    }))}
                  />
                </Show>
              </section>
              <section>
                <div class="ov-head">
                  <h2>选片进度</h2>
                  <Button size="sm" icon="flag" onClick={() => props.onCull()}>
                    继续选片
                  </Button>
                </div>
                <p class="ov-hint">点一段，只看这部分照片。</p>
                <div class="ov-funnel">
                  <button
                    class="f-pick"
                    style={{ width: share(s.picks) }}
                    aria-label={`留用 ${s.picks} 张`}
                    onClick={() => props.onPick({ label: '留用', options: { flag: 'pick' } })}
                  />
                  <button
                    class="f-reject"
                    style={{ width: share(s.rejects) }}
                    aria-label={`淘汰 ${s.rejects} 张`}
                    onClick={() => props.onPick({ label: '淘汰', options: { flag: 'reject' } })}
                  />
                  <button
                    class="f-rated"
                    style={{ width: share(s.rated) }}
                    aria-label={`评了星 ${s.rated} 张`}
                    onClick={() =>
                      props.onPick({
                        label: '评了星，未打旗',
                        options: { flag: 'none', rating: 1 },
                      })
                    }
                  />
                  <button
                    class="f-unseen"
                    style={{ width: share(s.unprocessed) }}
                    aria-label={`未处理 ${s.unprocessed} 张`}
                    onClick={() =>
                      props.onPick({ label: '未处理', options: { flag: 'none', rating_max: 0 } })
                    }
                  />
                </div>
                <div class="ov-legend">
                  <span>
                    <i class="f-pick" />
                    留用 <b>{s.picks}</b>
                  </span>
                  <span>
                    <i class="f-reject" />
                    淘汰 <b>{s.rejects}</b>
                  </span>
                  <span>
                    <i class="f-rated" />
                    评了星 <b>{s.rated}</b>
                  </span>
                  <span>
                    <i class="f-unseen" />
                    未处理 <b>{s.unprocessed}</b>
                  </span>
                </div>
              </section>
              <section class="ov-two">
                <div>
                  <h2>相机</h2>
                  <Ranked rows={s.cameras} filter="camera" />
                </div>
                <div>
                  <h2>镜头</h2>
                  <Ranked rows={s.lenses} filter="lens" />
                </div>
              </section>
              <section class="ov-two">
                <div>
                  <h2>焦距</h2>
                  <Bars
                    label="焦距分布"
                    items={binItems(s.focal, ' mm', ['focal_min', 'focal_max'])}
                  />
                </div>
                <div>
                  <h2>ISO</h2>
                  <Bars label="ISO 分布" items={binItems(s.iso, '', ['iso_min', 'iso_max'])} />
                </div>
              </section>
            </>
          );
        }}
      </Show>
    </div>
  );
}
