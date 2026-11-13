import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import Icon from './Icon';
import OverflowMenu from './OverflowMenu';
import { previewUrl } from './preview-url';
import { Badge, Button, EmptyState, PageHeader, StatusDot } from './ui';
import type { MenuEntry } from './ui';
import type { Library } from './model';
import { librarySourceBadge, summarizeLibraries } from './overview-model';
import { availabilityPresentation, libraryLocation } from './workspace';
import './library/libraries.css';

const dayLabel = (day: string) => {
  const [, month, date] = day.split('-').map(Number);
  return month && date ? `${month}月${date}日` : day;
};

/** Every library at a glance: covers, source kind, reachability, and mount status. */
export default function LibrariesOverview(props: {
  libraries: Library[];
  desktop: boolean;
  leading?: JSX.Element;
  extraActions?: JSX.Element;
  onOpen: (library: Library) => void;
  onCreate: () => void;
  onRelocate?: (library: Library) => void;
  libraryMenu: (library: Library) => MenuEntry[];
}) {
  const summary = createMemo(() => summarizeLibraries(props.libraries));

  return (
    <section class="libraries-overview" aria-label="全部图片库">
      <PageHeader
        leading={props.leading}
        title="全部图片库"
        subtitle={
          props.libraries.length
            ? `${props.libraries.length} 个图片库 · ${summary().totalPhotos.toLocaleString()} 张`
            : undefined
        }
        actions={
          <>
            {props.extraActions}
            <Button icon="plus" onClick={() => props.onCreate()}>
              新建图片库
            </Button>
          </>
        }
      />
      <div class="libraries-page">
        <Show
          when={props.libraries.length}
          fallback={
            <EmptyState
              icon="photo-plus"
              title="还没有图片库"
              description="选一个照片文件夹建立图片库，照片留在原处。"
              actions={
                <Button variant="primary" onClick={() => props.onCreate()}>
                  新建图片库
                </Button>
              }
            />
          }
        >
          <div class="libraries-summary" role="group" aria-label="图片库状态汇总">
            <span class="libraries-summary-item">
              <StatusDot state={summary().online ? 'ok' : 'off'} label="在线" />
              <span>在线</span>
              <b>{summary().online}</b>
            </span>
            <Show when={summary().removable > 0}>
              <span class="libraries-summary-item">
                <Icon name="usb" size={14} />
                <span>外接盘</span>
                <b>{summary().removable}</b>
              </span>
            </Show>
            <Show when={summary().offline > 0}>
              <span class="libraries-summary-item is-warn">
                <StatusDot state="bad" label="离线或受限" />
                <span>离线 / 受限</span>
                <b>{summary().offline}</b>
              </span>
            </Show>
            <Show when={summary().remote > 0}>
              <span class="libraries-summary-item">
                <Icon name="cloud" size={14} />
                <span>远端存储</span>
                <b>{summary().remote}</b>
              </span>
            </Show>
            <span class="libraries-summary-total">
              共索引 <b>{summary().totalPhotos.toLocaleString()}</b> 张照片
            </span>
          </div>

          <ul class="libraries-grid">
            <For each={props.libraries}>
              {(library) => {
                const state = () => availabilityPresentation(library);
                const badge = () => librarySourceBadge(library);
                const dot = () =>
                  !state().usable ? 'bad' : library.availability === 'online' ? 'ok' : 'off';
                const canRelocate = () =>
                  (!library.source_kind || library.source_kind === 'local') &&
                  library.availability === 'offline' &&
                  !!library.relocatable_path;
                return (
                  <li class={`library-tile${state().usable ? '' : ' unavailable'}`}>
                    <button
                      type="button"
                      class="library-tile-open"
                      aria-label={`打开 ${library.name}，${state().label}`}
                      title={state().detail || libraryLocation(library)}
                      onClick={() => props.onOpen(library)}
                    >
                      <Covers library={library} />
                      <span class="library-tile-body">
                        <span class="library-tile-title-row">
                          <b>{library.name}</b>
                          <Badge tone={badge().tone} icon={badge().icon}>
                            {badge().label}
                          </Badge>
                        </span>
                        <span class="library-tile-meta">
                          {library.asset_count
                            ? `${library.asset_count.toLocaleString()} 张`
                            : '尚无照片'}
                          <Show when={library.volume_label}>
                            {(vol) => <span>{` · 卷 ${vol()}`}</span>}
                          </Show>
                        </span>
                        <span class="library-tile-path">{libraryLocation(library)}</span>
                        <span class="library-tile-state">
                          <StatusDot state={dot()} label={state().label} showLabel />
                          <Show when={library.latest_capture}>
                            {(day) => <span>· 最近拍摄 {dayLabel(day())}</span>}
                          </Show>
                          <Show when={canRelocate() && !props.onRelocate}>
                            <Badge
                              tone="info"
                              icon="usb"
                              title={`检测到新挂载路径：${library.relocatable_path}`}
                            >
                              已检测到卷挂载
                            </Badge>
                          </Show>
                        </span>
                      </span>
                    </button>
                    <Show when={canRelocate() && props.onRelocate}>
                      <div class="library-tile-foot">
                        <button
                          type="button"
                          class="library-tile-relocate"
                          title={`重新绑定至 ${library.relocatable_path}`}
                          onClick={() => props.onRelocate?.(library)}
                        >
                          <Icon name="usb" size={13} />
                          <span>已检测到卷挂载</span>
                        </button>
                      </div>
                    </Show>
                    <span class="library-tile-more">
                      <OverflowMenu
                        size="sm"
                        label={`${library.name} 更多操作`}
                        items={props.libraryMenu(library)}
                      />
                    </span>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  );
}

function Covers(props: { library: Library }) {
  const ids = () => (props.library.cover_asset_ids ?? []).slice(0, 4);
  return (
    <span class={`library-tile-covers count-${ids().length}`} aria-hidden="true">
      <Show
        when={ids().length}
        fallback={
          <span class="library-tile-empty-glyph">
            <Icon name="camera" size={24} />
          </span>
        }
      >
        <For each={ids()}>{(id) => <Cover id={id} />}</For>
      </Show>
    </span>
  );
}

function Cover(props: { id: string }) {
  const [src, setSrc] = createSignal<string>();
  void Promise.resolve(previewUrl({ id: props.id }, 't256')).then(setSrc, () => undefined);
  return (
    <Show when={src()} fallback={<i />}>
      {(url) => <img src={url()} alt="" loading="lazy" draggable={false} />}
    </Show>
  );
}
