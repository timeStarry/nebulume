import { For, Show, createSignal, type JSX } from 'solid-js';
import Icon from './Icon';
import OverflowMenu from './OverflowMenu';
import { previewUrl } from './preview-url';
import { Button, EmptyState, PageHeader, StatusDot } from './ui';
import type { MenuEntry } from './ui';
import type { Library } from './model';
import { availabilityPresentation, libraryLocation, sourceKind } from './workspace';
import './library/libraries.css';

const dayLabel = (day: string) => {
  const [, month, date] = day.split('-').map(Number);
  return month && date ? `${month}月${date}日` : day;
};

/** Every library at a glance: covers, size, location and whether it can be reached. */
export default function LibrariesOverview(props: {
  libraries: Library[];
  desktop: boolean;
  leading?: JSX.Element;
  extraActions?: JSX.Element;
  onOpen: (library: Library) => void;
  onCreate: () => void;
  libraryMenu: (library: Library) => MenuEntry[];
}) {
  const total = () => props.libraries.reduce((sum, library) => sum + (library.asset_count ?? 0), 0);
  return (
    <section class="libraries-overview" aria-label="全部图片库">
      <PageHeader
        leading={props.leading}
        title="全部图片库"
        subtitle={
          props.libraries.length
            ? `${props.libraries.length} 个图片库 · ${total().toLocaleString()} 张`
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
          <ul class="libraries-grid">
            <For each={props.libraries}>
              {(library) => {
                const state = () => availabilityPresentation(library);
                const dot = () =>
                  !state().usable ? 'bad' : library.availability === 'online' ? 'ok' : 'off';
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
                        <b>{library.name}</b>
                        <span class="library-tile-meta">
                          {sourceKind(library.source_kind)}
                          {' · '}
                          {library.asset_count
                            ? `${library.asset_count.toLocaleString()} 张`
                            : '尚无照片'}
                        </span>
                        <span class="library-tile-path">{libraryLocation(library)}</span>
                        <span class="library-tile-state">
                          <StatusDot state={dot()} label={state().label} showLabel />
                          <Show when={library.latest_capture}>
                            {(day) => <span>· 最近拍摄 {dayLabel(day())}</span>}
                          </Show>
                        </span>
                      </span>
                    </button>
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
      <Show when={ids().length} fallback={<Icon name="photo" size={24} />}>
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
