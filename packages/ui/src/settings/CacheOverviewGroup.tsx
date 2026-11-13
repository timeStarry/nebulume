import { Show } from 'solid-js';
import { bytes } from '../model';
import { cacheMigrationPercent, type CacheMigration, type CacheStats } from '../cache-model';
import { Button, Group, ListRow } from '../ui';

const MIGRATION_TITLES: Record<CacheMigration['status'], string> = {
  running: '正在迁移缓存',
  completed: '缓存迁移完成',
  cancelled: '缓存迁移已取消',
  failed: '缓存迁移失败',
  cleanup_pending: '旧缓存清理待完成',
};

const knownSpace = (value: number | null | undefined) =>
  value == null ? '暂不可用' : bytes(value);

export default function CacheOverviewGroup(props: {
  stats: CacheStats;
  loading: boolean;
  busy: boolean;
  locked: boolean;
  cacheUnavailable: boolean;
  migrating: boolean;
  pollError: string;
  onRefresh: () => void;
  onChooseLocation: () => void;
  onOpenClean: () => void;
  onOpenCancel: () => void;
  onRetryMigration: (toPath: string) => void;
}) {
  const usage = () => props.stats.usage;
  const policy = () => props.stats.policy;
  const pinnedBytes = () => Math.max(0, usage().pinned_bytes);
  const reclaimableBytes = () => Math.max(0, usage().originals_bytes - usage().pinned_bytes);
  const previewBytes = () => Math.max(0, usage().previews_bytes + usage().temporary_bytes);
  const unmanagedBytes = () => Math.max(0, usage().unmanaged_bytes);
  const barScale = () =>
    Math.max(
      1,
      policy().budget_bytes,
      usage().total_bytes,
      pinnedBytes() + reclaimableBytes() + previewBytes() + unmanagedBytes(),
    );
  const segmentWidth = (value: number) => `${Math.min(100, (value / barScale()) * 100)}%`;

  return (
    <Group
      title="存储占用与缓存目录"
      action={
        <Button
          size="sm"
          icon="refresh"
          onClick={() => props.onRefresh()}
          disabled={props.loading || props.busy}
        >
          刷新状态
        </Button>
      }
    >
      <div class="cache-meter">
        <div class="cache-usage-head">
          <div class="cache-usage-number">
            <strong>{bytes(usage().total_bytes)}</strong>
            <span>/ {bytes(policy().budget_bytes)}</span>
          </div>
          <span class="cache-object-count">{props.stats.objects_count} 项缓存对象</span>
        </div>
        <progress
          class="visually-hidden"
          aria-label="缓存使用量"
          max={policy().budget_bytes}
          value={Math.min(usage().total_bytes, policy().budget_bytes)}
        />
        <div class="cache-bar" aria-hidden="true">
          <Show when={pinnedBytes() > 0}>
            <span
              class="cache-bar-seg cache-bar-seg--pinned"
              style={{ width: segmentWidth(pinnedBytes()) }}
            />
          </Show>
          <Show when={reclaimableBytes() > 0}>
            <span
              class="cache-bar-seg cache-bar-seg--originals"
              style={{ width: segmentWidth(reclaimableBytes()) }}
            />
          </Show>
          <Show when={previewBytes() > 0}>
            <span
              class="cache-bar-seg cache-bar-seg--previews"
              style={{ width: segmentWidth(previewBytes()) }}
            />
          </Show>
          <Show when={unmanagedBytes() > 0}>
            <span
              class="cache-bar-seg cache-bar-seg--unmanaged"
              style={{ width: segmentWidth(unmanagedBytes()) }}
            />
          </Show>
        </div>
        <div class="cache-legend">
          <span class="cache-legend-item">
            <i class="cache-legend-dot cache-bar-seg--pinned" aria-hidden="true" />
            离线固定 <em>{bytes(pinnedBytes())}</em>
          </span>
          <span class="cache-legend-item">
            <i class="cache-legend-dot cache-bar-seg--originals" aria-hidden="true" />
            可回收原图 <em>{bytes(reclaimableBytes())}</em>
          </span>
          <span class="cache-legend-item">
            <i class="cache-legend-dot cache-bar-seg--previews" aria-hidden="true" />
            预览与缩略图 <em>{bytes(previewBytes())}</em>
          </span>
          <Show when={unmanagedBytes() > 0}>
            <span class="cache-legend-item">
              <i class="cache-legend-dot cache-bar-seg--unmanaged" aria-hidden="true" />
              待核对 <em>{bytes(unmanagedBytes())}</em>
            </span>
          </Show>
        </div>
      </div>

      <ListRow
        title="缓存目录"
        description={
          <span class="cache-location-desc">
            <code class="cache-path">{props.stats.location.path}</code>
            <span>
              {props.cacheUnavailable ? '离线' : '可用'} · 剩余空间{' '}
              {knownSpace(props.stats.location.available_bytes)}
            </span>
          </span>
        }
        control={
          <>
            <Button size="sm" onClick={() => props.onChooseLocation()} disabled={props.locked}>
              更改缓存位置…
            </Button>
            <Button
              size="sm"
              onClick={() => props.onOpenClean()}
              disabled={props.locked || props.cacheUnavailable}
            >
              清理缓存…
            </Button>
          </>
        }
      />

      <Show when={props.stats.migration}>
        {(item) => (
          <section class="cache-migration-box" aria-label="缓存迁移状态">
            <div class="cache-migration-head">
              <h4>{MIGRATION_TITLES[item().status]}</h4>
              <Show when={item().status === 'running'}>
                <Button size="sm" disabled={props.busy} onClick={() => props.onOpenCancel()}>
                  取消迁移…
                </Button>
              </Show>
              <Show when={item().status === 'failed'}>
                <Button
                  size="sm"
                  disabled={props.locked}
                  onClick={() => props.onRetryMigration(item().to_path)}
                >
                  重新检查并重试…
                </Button>
              </Show>
            </div>
            <p class="cache-description">
              <code>{item().from_path}</code> → <code>{item().to_path}</code>
            </p>
            <Show when={props.migrating}>
              <div class="cache-migration-progress">
                <progress
                  aria-label="缓存迁移进度"
                  max="100"
                  value={cacheMigrationPercent(item())}
                />
                <span role="status">
                  {bytes(item().copied_bytes)} / {bytes(item().total_bytes)}
                </span>
              </div>
            </Show>
            <Show when={item().status === 'failed' || item().status === 'cancelled'}>
              <p class="cache-description">旧位置与配置保留。</p>
            </Show>
            <Show when={item().status === 'cleanup_pending'}>
              <p class="cache-inline-warn">新位置已启用，旧缓存仍占空间，正在等待清理。</p>
            </Show>
            <Show when={item().error}>
              <p class="cache-inline-error" role="alert">
                {item().error}
              </p>
            </Show>
            <Show when={props.pollError}>
              <p class="cache-inline-error" role="alert">
                状态读取失败：{props.pollError}。将继续重试。
              </p>
            </Show>
          </section>
        )}
      </Show>
    </Group>
  );
}
