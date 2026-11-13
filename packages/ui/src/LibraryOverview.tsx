import { createResource, For, Show } from 'solid-js';
import { execute } from './api';
import { Badge, Button, EmptyState } from './ui';
import './library/overview.css';
import type { AssetListOptions, LibraryStats } from './model';
import {
  buildTimelineBuckets,
  cullFunnelSegments,
  formatCaptureSpan,
  formatSharePercent,
  formatStorageBytes,
  granularityLabel,
  pickRatePercent,
  statsBinItems,
  type OverviewPick,
} from './overview-model';

export type { OverviewPick };

/**
 * Card-based insight dashboard for the currently scoped library or folder/filter set.
 * Every bar, funnel stage, KPI action, and equipment row drills straight into matching photos.
 */
export default function LibraryOverview(props: {
  options: AssetListOptions;
  refreshToken?: number;
  scanning?: boolean;
  onPick: (pick: OverviewPick) => void;
  onCull: () => void;
}) {
  const [stats] = createResource(
    () => ({
      query: JSON.stringify({ ...props.options, limit: undefined, offset: undefined }),
      rev: props.refreshToken ?? 0,
    }),
    ({ query }) => execute<LibraryStats>('asset.stats', JSON.parse(query)),
  );

  const Bars = (barProps: {
    label: string;
    compact?: boolean;
    items: { key: string; tick: string; count: number; title: string; pick?: OverviewPick }[];
  }) => {
    const max = () => Math.max(1, ...barProps.items.map((item) => item.count));
    return (
      <div
        class={`ov-bars${barProps.compact ? ' ov-bars--compact' : ''}`}
        role="list"
        aria-label={barProps.label}
      >
        <For each={barProps.items}>
          {(item) => (
            <button
              type="button"
              class="ov-bar"
              role="listitem"
              disabled={!item.count || !item.pick}
              aria-label={`${item.title}：${item.count} 张`}
              title={`${item.title}：${item.count.toLocaleString()} 张`}
              onClick={() => item.count && item.pick && props.onPick(item.pick)}
            >
              <span class="ov-bar-track">
                <span class="ov-bar-fill" style={{ height: `${(item.count / max()) * 100}%` }} />
              </span>
              <Show when={item.tick}>
                <span class="ov-bar-tick">{item.tick}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    );
  };

  const Ranked = (rankedProps: {
    rows: { name: string; count: number }[];
    total: number;
    filter: 'camera' | 'lens';
  }) => {
    const max = () => Math.max(1, ...rankedProps.rows.map((row) => row.count));
    return (
      <ul class="ov-ranked">
        <For each={rankedProps.rows} fallback={<li class="ov-empty">没有记录</li>}>
          {(row) => (
            <li>
              <button
                type="button"
                title={`${row.name} · ${row.count.toLocaleString()} 张`}
                onClick={() =>
                  props.onPick({ label: row.name, options: { [rankedProps.filter]: row.name } })
                }
              >
                <span class="ov-name">{row.name}</span>
                <span class="ov-meter" aria-hidden="true">
                  <span style={{ width: `${(row.count / max()) * 100}%` }} />
                </span>
                <span class="ov-share">{formatSharePercent(row.count, rankedProps.total)}</span>
                <span class="ov-num">{row.count.toLocaleString()}</span>
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
          const pickRate = pickRatePercent(s);
          const segments = cullFunnelSegments(s);
          const timeline = buildTimelineBuckets(s.days);
          const spanText = formatCaptureSpan(s.days);
          return (
            <Show
              when={!props.scanning || s.photos > 0}
              fallback={
                <EmptyState
                  icon="chart-bar"
                  loading
                  role="status"
                  title="正在扫描图片库…"
                  description="正在扫描目录并建立照片索引，完成后将自动生成统计概览。"
                />
              }
            >
              <>
                <div class="ov-kpi-grid">
                <div class="ov-kpi-card">
                  <div class="ov-kpi-main">
                    <b>{s.photos}</b>
                    <span>张照片</span>
                  </div>
                  <p class="ov-kpi-sub">{s.files.toLocaleString()} 个原始文件</p>
                </div>

                <button
                  type="button"
                  class="ov-kpi-card ov-kpi-action"
                  disabled={!s.picks}
                  onClick={() =>
                    s.picks && props.onPick({ label: '留用', options: { flag: 'pick' } })
                  }
                >
                  <div class="ov-kpi-main">
                    <b>{pickRate}%</b>
                    <span>留用率</span>
                  </div>
                  <p class="ov-kpi-sub">已留用 {s.picks.toLocaleString()} 张</p>
                </button>

                <button
                  type="button"
                  class="ov-kpi-card ov-kpi-action"
                  disabled={!s.unprocessed}
                  onClick={() =>
                    s.unprocessed &&
                    props.onPick({ label: '未处理', options: { flag: 'none', rating_max: 0 } })
                  }
                >
                  <div class="ov-kpi-main">
                    <b>{s.unprocessed}</b>
                    <span>张待选片</span>
                  </div>
                  <p class="ov-kpi-sub">
                    {s.rated > 0 ? `已评星 ${s.rated.toLocaleString()} 张` : '尚未开始筛选'}
                  </p>
                </button>

                <div class="ov-kpi-card">
                  <div class="ov-kpi-main">
                    <b>{formatStorageBytes(s.bytes)}</b>
                    <span>原片体积</span>
                  </div>
                  <p class="ov-kpi-sub">
                    {s.undated ? `${s.undated.toLocaleString()} 张缺拍摄时间` : '拍摄时间完整'}
                  </p>
                </div>
              </div>

              <section class="ov-card">
                <div class="ov-card-head">
                  <div class="ov-card-titles">
                    <h2>选片漏斗</h2>
                    <span class="ov-subtitle">点按任一阶段直接过滤对应照片</span>
                  </div>
                  <Button size="sm" variant="primary" icon="flag" onClick={() => props.onCull()}>
                    继续选片
                  </Button>
                </div>
                <div class="ov-funnel">
                  <For each={segments}>
                    {(seg) => (
                      <Show when={seg.count > 0}>
                        <button
                          type="button"
                          class={`f-${seg.tone}`}
                          style={{ width: `${seg.widthPercent}%` }}
                          aria-label={`${seg.label} ${seg.count} 张`}
                          title={`${seg.label}：${seg.count.toLocaleString()} 张（${seg.shareLabel}）`}
                          onClick={() => props.onPick(seg.pick)}
                        />
                      </Show>
                    )}
                  </For>
                </div>
                <div class="ov-pills">
                  <For each={segments}>
                    {(seg) => (
                      <button
                        type="button"
                        class="ov-pill"
                        disabled={!seg.count}
                        aria-label={`按${seg.label}筛选（${seg.shareLabel}）`}
                        onClick={() => seg.count && props.onPick(seg.pick)}
                      >
                        <i class={`f-${seg.tone}`} aria-hidden="true" />
                        <span>{seg.label}</span>
                        <b>{seg.count.toLocaleString()}</b>
                        <em>{seg.shareLabel}</em>
                      </button>
                    )}
                  </For>
                </div>
              </section>

              <section class="ov-card">
                <div class="ov-card-head">
                  <div class="ov-card-titles">
                    <h2>拍摄时间分布</h2>
                    <Show when={timeline.buckets.length}>
                      <Badge tone="info">{granularityLabel(timeline.granularity)}</Badge>
                      <span class="ov-subtitle">{spanText}</span>
                    </Show>
                  </div>
                  <Show when={s.undated}>
                    <span class="ov-meta-note">另有 {s.undated.toLocaleString()} 张缺拍摄时间</span>
                  </Show>
                </div>
                <Show
                  when={timeline.buckets.length}
                  fallback={<p class="ov-empty">没有拍摄时间记录</p>}
                >
                  <Bars
                    label="拍摄时间分布"
                    items={timeline.buckets.map((bucket) => ({
                      key: bucket.key,
                      tick: bucket.tick,
                      count: bucket.count,
                      title: bucket.title,
                      pick: {
                        label: bucket.title,
                        options: { captured_from: bucket.from, captured_to: bucket.to },
                      },
                    }))}
                  />
                </Show>
              </section>

              <div class="ov-two-grid">
                <section class="ov-card">
                  <div class="ov-card-head">
                    <h2>常用机身</h2>
                  </div>
                  <Ranked rows={s.cameras} total={s.photos} filter="camera" />
                </section>

                <section class="ov-card">
                  <div class="ov-card-head">
                    <h2>常用镜头</h2>
                  </div>
                  <Ranked rows={s.lenses} total={s.photos} filter="lens" />
                </section>

                <section class="ov-card">
                  <div class="ov-card-head">
                    <h2>焦段分布</h2>
                    <span class="ov-subtitle">等效 / 物理焦距 mm</span>
                  </div>
                  <Show when={s.focal.length} fallback={<p class="ov-empty">没有焦段记录</p>}>
                    <Bars label="焦段分布" compact items={statsBinItems(s.focal, 'focal')} />
                  </Show>
                </section>

                <section class="ov-card">
                  <div class="ov-card-head">
                    <h2>感光度 ISO</h2>
                  </div>
                  <Show when={s.iso.length} fallback={<p class="ov-empty">没有感光度记录</p>}>
                    <Bars label="感光度 ISO" compact items={statsBinItems(s.iso, 'iso')} />
                  </Show>
                </section>
              </div>
              </>
            </Show>
          );
        }}
      </Show>
    </div>
  );
}
