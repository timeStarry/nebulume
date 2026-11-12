import { For, Show, createEffect, createSignal, on } from 'solid-js';
import ComparePane from './ComparePane';
import { IDENTITY_TRANSFORM, type CompareTransform } from './compare-sync';
import Icon from './Icon';
import type { Asset } from './model';
import './CompareStage.css';

export default function CompareStage(props: {
  ids: string[];
  assets: Record<string, Asset>;
  activeId?: string;
  count: 2 | 4;
  onCountChange: (count: 2 | 4) => void;
  syncLocked: boolean;
  onToggleSync: () => void;
  preferRaw: boolean;
  clippingEnabled: boolean;
  onToggleClipping: () => void;
  zoomToggle: number;
  onSelect: (id: string) => void;
  onExitCompare: () => void;
}) {
  const [shared, setShared] = createSignal<CompareTransform>(IDENTITY_TRANSFORM);
  const [perPane, setPerPane] = createSignal<Record<string, CompareTransform>>({});
  let computeFocusedActualZoom = () => 2;

  const activeTransform = () =>
    props.syncLocked
      ? shared()
      : (props.activeId && perPane()[props.activeId]) || IDENTITY_TRANSFORM;

  function applyTransform(paneId: string, next: CompareTransform) {
    if (props.syncLocked) setShared(next);
    else setPerPane((map) => ({ ...map, [paneId]: next }));
  }

  function resetAll() {
    setShared(IDENTITY_TRANSFORM);
    setPerPane({});
  }

  function zoomToActual() {
    const z = computeFocusedActualZoom();
    const current = activeTransform();
    const next = current.zoom > 1.02 ? IDENTITY_TRANSFORM : { zoom: z, panX: 0, panY: 0 };
    if (props.syncLocked) setShared(next);
    else if (props.activeId) setPerPane((map) => ({ ...map, [props.activeId!]: next }));
  }

  createEffect(
    on(
      () => props.zoomToggle,
      () => zoomToActual(),
      { defer: true },
    ),
  );

  return (
    <div class="compare-stage-wrap">
      <div
        class={`cull-compare count-${props.ids.length}`}
        role="listbox"
        aria-label="对比视图"
      >
        <For each={props.ids}>
          {(paneId) => (
            <Show
              when={props.assets[paneId]}
              fallback={<div class="compare-pane muted">正在读取…</div>}
            >
              {(item) => (
                <ComparePane
                  asset={item()}
                  focused={paneId === props.activeId}
                  preferRaw={props.preferRaw}
                  clippingEnabled={props.clippingEnabled}
                  transform={
                    props.syncLocked ? shared() : perPane()[paneId] || IDENTITY_TRANSFORM
                  }
                  onTransform={(next) => applyTransform(paneId, next)}
                  onRegisterActualZoom={(fn) => {
                    computeFocusedActualZoom = fn;
                  }}
                  onSelect={() => props.onSelect(paneId)}
                />
              )}
            </Show>
          )}
        </For>
      </div>
      <div class="compare-bar viewer-chrome" role="toolbar" aria-label="对比控制栏">
        <button class={props.count === 2 ? 'active' : ''} onClick={() => props.onCountChange(2)}>
          2 张
        </button>
        <button class={props.count === 4 ? 'active' : ''} onClick={() => props.onCountChange(4)}>
          4 张
        </button>
        <span class="divider" />
        <button
          aria-pressed={props.syncLocked}
          onClick={props.onToggleSync}
          title="锁定后滚轮缩放与拖拽平移同步作用于全部对比窗格"
        >
          <Icon name="link" size={14} />
          同步缩放
        </button>
        <button onClick={resetAll}>适合窗口</button>
        <button
          class={activeTransform().zoom > 1.02 ? 'active' : ''}
          onClick={zoomToActual}
          title="切换 1:1 原生查焦（Z）"
        >
          1:1
        </button>
        <span class="divider" />
        <button
          aria-pressed={props.clippingEnabled}
          onClick={props.onToggleClipping}
          title="高光/暗部溢出警告（J）"
        >
          溢出警告
        </button>
        <button onClick={props.onExitCompare} title="返回单张选片（G）">
          单张视图
        </button>
      </div>
    </div>
  );
}
