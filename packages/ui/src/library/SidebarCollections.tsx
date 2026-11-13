import { For, Show } from 'solid-js';
import Icon from '../Icon';
import OverflowMenu from '../OverflowMenu';
import type { Collection } from '../model';

export function SidebarCollections(props: {
  collections: Collection[];
  activeCollectionId: string;
  onSelect: (collectionId: string) => void;
  onCreate: (kind: 'manual' | 'smart') => void;
  onEdit: (collection: Collection) => void;
  onDelete: (collection: Collection) => void;
}) {
  return (
    <div class="sidebar-collections" aria-label="精选集">
      <div class="library-subnav-head">
        <span>精选集</span>
        <OverflowMenu
          size="xs"
          icon="plus"
          label="新建精选集"
          items={[
            {
              label: '新建精选集…',
              icon: 'layout-grid',
              onSelect: () => props.onCreate('manual'),
            },
            {
              label: '新建智能精选集…',
              icon: 'filter',
              onSelect: () => props.onCreate('smart'),
            },
          ]}
        />
      </div>
      <Show when={props.collections.length}>
        <ul class="collection-nav-list" aria-label="精选集列表">
          <For each={props.collections}>
            {(item) => (
              <li>
                <div
                  class="tree-row collection-nav-row"
                  classList={{ current: props.activeCollectionId === item.id }}
                >
                  <button
                    type="button"
                    class="tree-label"
                    aria-current={props.activeCollectionId === item.id ? 'page' : undefined}
                    onClick={() =>
                      props.onSelect(props.activeCollectionId === item.id ? '' : item.id)
                    }
                  >
                    <Icon name={item.kind === 'smart' ? 'filter' : 'layout-grid'} size={14} />
                    <span class="tree-name">{item.name}</span>
                    <span class="tree-count">{item.item_count}</span>
                  </button>
                  <span class="collection-nav-more">
                    <OverflowMenu
                      size="xs"
                      label={`${item.name} 更多操作`}
                      items={[
                        {
                          label: '编辑精选集…',
                          icon: 'settings',
                          onSelect: () => props.onEdit(item),
                        },
                        {
                          label: '删除精选集',
                          icon: 'trash',
                          danger: true,
                          onSelect: () => props.onDelete(item),
                        },
                      ]}
                    />
                  </span>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

const SIDEBAR_KEY = 'nebulume.sidebar-width';
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const clampWidth = (value: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)));

function applyWidth(value: number) {
  document.documentElement.style.setProperty('--nl-sidebar-live', `${value}px`);
}
function savedWidth() {
  try {
    const value = Number(localStorage.getItem(SIDEBAR_KEY));
    return Number.isFinite(value) && value > 0 ? clampWidth(value) : undefined;
  } catch {
    return undefined;
  }
}
const initial = savedWidth();
if (initial) applyWidth(initial);

/** The sidebar's right edge: drag (or use ← →) to resize; double-click resets. */
export function SidebarResizer() {
  let handle!: HTMLDivElement;
  const current = () => (handle.parentElement as HTMLElement).getBoundingClientRect().width;
  const set = (value: number) => {
    const next = clampWidth(value);
    applyWidth(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, String(next));
    } catch {
      /* Width applies to this window only. */
    }
    handle.setAttribute('aria-valuenow', String(next));
  };
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = current();
    handle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('nl-resizing');
    const move = (next: PointerEvent) => set(startWidth + next.clientX - startX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('nl-resizing');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  return (
    <div
      ref={handle}
      class="library-sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-orientation-hint="resize"
      aria-label="拖动调整侧栏"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={initial ?? 220}
      tabIndex={0}
      onPointerDown={pointerDown}
      onDblClick={() => {
        document.documentElement.style.removeProperty('--nl-sidebar-live');
        try {
          localStorage.removeItem(SIDEBAR_KEY);
        } catch {
          /* Nothing saved. */
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        set(current() + (event.key === 'ArrowRight' ? 16 : -16));
      }}
    />
  );
}
