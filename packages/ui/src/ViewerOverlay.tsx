import { For, Show, createMemo, createResource, createSignal, type JSX } from 'solid-js';
import { execute } from './api';
import Icon from './Icon';
import { ContextMenu, type ContextMenuState, type MenuEntry } from './ui';
import {
  CORNERS,
  CORNER_LABELS,
  DEFAULT_OVERLAY,
  addWidget,
  cornerOf,
  moveWidget,
  readOverlay,
  removeWidget,
  shiftWidget,
  widgetsNotIn,
  writeOverlay,
  type Corner,
  type OverlayLayout,
} from './overlay-layout';
import {
  WIDGETS,
  WIDGET_IDS,
  widgetById,
  type WidgetContext,
  type WidgetGroup,
} from './viewer-widgets';
import { imageRequestKey, type Asset, type Histogram } from './model';
import './ViewerOverlay.css';

const GROUPS: WidgetGroup[] = ['文件', '曝光', '器材', '评价', '其他'];

/**
 * The four corners of the viewer, each a stack of widgets the user chose. In edit mode
 * widgets can be dragged between corners or from the tray, or moved with the keyboard
 * through each widget's menu and each corner's "+ 添加".
 */
export default function ViewerOverlay(props: {
  asset: Asset;
  context: Omit<WidgetContext, 'histogram'>;
  visible: boolean;
  editing: boolean;
  onEditing: (value: boolean) => void;
}) {
  const [layout, setLayout] = createSignal<OverlayLayout>(readOverlay(localStorage, WIDGET_IDS));
  const [menu, setMenu] = createSignal<ContextMenuState>();
  const [dropTarget, setDropTarget] = createSignal<Corner>();
  const update = (next: OverlayLayout) => {
    setLayout(next);
    writeOverlay(localStorage, next);
  };
  const usesHistogram = createMemo(() =>
    CORNERS.some((corner) => layout()[corner].some((id) => widgetById(id)?.needsHistogram)),
  );
  // Only fetched while a histogram widget is shown; the service answers from its cache.
  const [histogram] = createResource(
    () => (props.visible && usesHistogram() ? imageRequestKey(props.asset) : undefined),
    (key) =>
      execute<Histogram>('asset.histogram', { id: JSON.parse(key).id }).catch(() => undefined),
  );
  const context = (): WidgetContext => ({ ...props.context, histogram: histogram() });
  const content = (id: string): JSX.Element | null => {
    const widget = widgetById(id);
    return widget ? widget.render(props.asset, context()) : null;
  };
  const available = () =>
    widgetsNotIn(
      layout(),
      WIDGETS.map((widget) => widget.id),
    );

  function openMenu(anchor: HTMLElement, items: MenuEntry[], label: string) {
    const rect = anchor.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4, label, returnFocus: anchor, items });
  }
  function addMenu(corner: Corner, anchor: HTMLElement) {
    const items: MenuEntry[] = [];
    for (const group of GROUPS) {
      const inGroup = available().filter((id) => widgetById(id)?.group === group);
      inGroup.forEach((id, index) =>
        items.push({
          label: widgetById(id)!.name,
          heading: index === 0 ? group : undefined,
          onSelect: () => update(addWidget(layout(), id, corner)),
        }),
      );
    }
    if (!items.length)
      items.push({ label: '所有部件都已在画面上', disabled: true, onSelect: () => undefined });
    openMenu(anchor, items, `添加到${CORNER_LABELS[corner]}`);
  }
  function widgetMenu(id: string, anchor: HTMLElement) {
    const here = cornerOf(layout(), id)!;
    const list = layout()[here];
    openMenu(
      anchor,
      [
        {
          label: '上移',
          icon: 'up',
          disabled: list[0] === id,
          onSelect: () => update(shiftWidget(layout(), id, -1)),
        },
        {
          label: '下移',
          icon: 'down',
          disabled: list.at(-1) === id,
          onSelect: () => update(shiftWidget(layout(), id, 1)),
        },
        'separator',
        ...CORNERS.filter((corner) => corner !== here).map((corner) => ({
          label: `移到${CORNER_LABELS[corner]}`,
          onSelect: () => update(moveWidget(layout(), id, corner, -1)),
        })),
        'separator',
        {
          label: '移除',
          icon: 'close',
          danger: true,
          onSelect: () => update(removeWidget(layout(), id)),
        },
      ],
      widgetById(id)?.name ?? id,
    );
  }
  function drop(corner: Corner, event: DragEvent, before?: string) {
    event.preventDefault();
    setDropTarget(undefined);
    const id = event.dataTransfer?.getData('text/plain');
    if (!id || !WIDGET_IDS.has(id)) return;
    const list = layout()[corner].filter((each) => each !== id);
    const index = before ? list.indexOf(before) : -1;
    update(moveWidget(layout(), id, corner, index));
  }
  const dragStart = (id: string) => (event: DragEvent) => {
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      class={`nl-overlay${props.editing ? ' nl-overlay--editing' : ''}`}
      hidden={!props.visible && !props.editing}
      onKeyDown={(event) => {
        if (props.editing && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          props.onEditing(false);
        }
      }}
    >
      <For each={CORNERS}>
        {(corner) => (
          <div
            class={`nl-overlay-corner nl-overlay-corner--${corner}${dropTarget() === corner ? ' drop' : ''}`}
            role="group"
            aria-label={CORNER_LABELS[corner]}
            onDragOver={(event) => {
              if (!props.editing) return;
              event.preventDefault();
              setDropTarget(corner);
            }}
            onDragLeave={() => setDropTarget(undefined)}
            onDrop={(event) => props.editing && drop(corner, event)}
          >
            <For each={layout()[corner]}>
              {(id) => (
                <Show when={props.editing || content(id)}>
                  <div
                    class="nl-widget"
                    data-widget={id}
                    tabIndex={props.editing ? 0 : undefined}
                    role={props.editing ? 'button' : undefined}
                    aria-label={
                      props.editing ? `${widgetById(id)?.name}，按 Enter 调整` : undefined
                    }
                    draggable={props.editing}
                    onDragStart={dragStart(id)}
                    onDragOver={(event) => props.editing && event.preventDefault()}
                    onDrop={(event) => {
                      if (!props.editing) return;
                      event.stopPropagation();
                      drop(corner, event, id);
                    }}
                    onKeyDown={(event) => {
                      if (!props.editing || (event.key !== 'Enter' && event.key !== ' ')) return;
                      event.preventDefault();
                      event.stopPropagation();
                      widgetMenu(id, event.currentTarget);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!props.editing) props.onEditing(true);
                      else widgetMenu(id, event.currentTarget);
                    }}
                  >
                    {content(id) ?? <span class="nl-widget-empty">{widgetById(id)?.name}</span>}
                  </div>
                </Show>
              )}
            </For>
            <Show when={props.editing}>
              <button
                type="button"
                class="nl-overlay-add"
                aria-label={`添加到${CORNER_LABELS[corner]}`}
                aria-haspopup="menu"
                onClick={(event) => addMenu(corner, event.currentTarget)}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <Icon name="plus" size={14} />
                添加
              </button>
            </Show>
          </div>
        )}
      </For>
      <Show when={props.editing}>
        <div
          class="nl-overlay-tray"
          role="toolbar"
          aria-label="可添加的叠加信息"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span class="nl-overlay-hint">拖到任意角</span>
          <For each={available()}>
            {(id) => (
              <span
                class="nl-overlay-chip"
                data-widget={id}
                draggable={true}
                onDragStart={dragStart(id)}
              >
                {widgetById(id)?.name}
              </span>
            )}
          </For>
          <button
            type="button"
            class="nl-overlay-reset"
            onClick={() =>
              update({
                ...DEFAULT_OVERLAY,
                tl: [...DEFAULT_OVERLAY.tl],
                tr: [...DEFAULT_OVERLAY.tr],
                bl: [...DEFAULT_OVERLAY.bl],
                br: [...DEFAULT_OVERLAY.br],
              })
            }
          >
            恢复默认
          </button>
          <button
            type="button"
            class="nl-btn nl-btn--primary nl-btn--sm"
            onClick={() => props.onEditing(false)}
          >
            完成
          </button>
        </div>
      </Show>
      <Show when={menu()}>
        {(state) => <ContextMenu menu={state()} onClose={() => setMenu(undefined)} />}
      </Show>
    </div>
  );
}
