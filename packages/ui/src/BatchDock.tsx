import { For, Show } from 'solid-js';
import type { ColorLabel, Flag } from './model';
import { COLOR_LABEL_NAMES } from './undo';
import { Button, FloatingDock, IconButton } from './ui';
import './BatchDock.css';

const BATCH_COLORS: Array<Exclude<ColorLabel, 'none'>> = ['red', 'yellow', 'green', 'blue'];

/**
 * Floating glass batch-action dock shown when 2+ photos are selected.
 * Replaces the old inline top toolbar so multi-selection never shifts the grid vertically.
 */
export default function BatchDock(props: {
  count: number;
  canTrash: boolean;
  exportBusy?: boolean;
  trashBusy?: boolean;
  onMark: (mark: { rating?: number; flag?: Flag; color_label?: ColorLabel }) => void;
  onCollect?: () => void;
  onRemoveFromCollection?: () => void;
  onExport: () => void;
  onExportPreset?: () => void;
  onTrash: () => void;
  onClear: () => void;
}) {
  return (
    <Show when={props.count > 1}>
      <FloatingDock label="批量操作" class="library-batch batch-dock">
        <b class="batch-dock-count">已选 {props.count.toLocaleString()} 张</b>
        <span class="batch-dock-sep" aria-hidden="true" />
        <span class="library-batch-group" role="group" aria-label="批量评级">
          <For each={[1, 2, 3, 4, 5]}>
            {(value) => (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`将所选照片评为 ${value} 星`}
                onClick={() => props.onMark({ rating: value })}
              >
                {value}★
              </Button>
            )}
          </For>
          <Button
            size="sm"
            variant="ghost"
            aria-label="清除所选照片评级"
            onClick={() => props.onMark({ rating: 0 })}
          >
            0
          </Button>
        </span>
        <span class="batch-dock-sep" aria-hidden="true" />
        <span class="library-batch-group" role="group" aria-label="批量旗标">
          <Button size="sm" variant="ghost" onClick={() => props.onMark({ flag: 'pick' })}>
            留用
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.onMark({ flag: 'reject' })}>
            淘汰
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.onMark({ flag: 'none' })}>
            清除旗标
          </Button>
        </span>
        <span class="batch-dock-sep" aria-hidden="true" />
        <span class="library-batch-group" role="group" aria-label="批量色标">
          <For each={BATCH_COLORS}>
            {(color) => (
              <button
                type="button"
                class="batch-color-btn"
                aria-label={`将所选照片设为${COLOR_LABEL_NAMES[color]}`}
                title={COLOR_LABEL_NAMES[color]}
                onClick={() => props.onMark({ color_label: color })}
              >
                <span class="batch-color-swatch" data-color={color} />
              </button>
            )}
          </For>
          <Button
            size="sm"
            variant="ghost"
            aria-label="清除所选照片色标"
            onClick={() => props.onMark({ color_label: 'none' })}
          >
            无色
          </Button>
        </span>
        <Show when={props.onCollect || props.onRemoveFromCollection}>
          <span class="batch-dock-sep" aria-hidden="true" />
          <Show when={props.onCollect}>
            <Button size="sm" variant="ghost" icon="folder-plus" onClick={() => props.onCollect!()}>
              加入精选集…
            </Button>
          </Show>
          <Show when={props.onRemoveFromCollection}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => props.onRemoveFromCollection!()}
            >
              移出精选集
            </Button>
          </Show>
        </Show>
        <span class="batch-dock-sep" aria-hidden="true" />
        <Button
          size="sm"
          icon="export"
          disabled={props.exportBusy}
          onClick={() => props.onExport()}
        >
          导出 JPEG…
        </Button>
        <Show when={props.onExportPreset}>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.exportBusy}
            onClick={() => props.onExportPreset!()}
          >
            按预设导出…
          </Button>
        </Show>
        <Show when={props.canTrash}>
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            disabled={props.trashBusy}
            onClick={() => props.onTrash()}
          >
            移到废纸篓
          </Button>
        </Show>
        <IconButton size="sm" icon="close" label="取消选择" onClick={() => props.onClear()} />
      </FloatingDock>
    </Show>
  );
}
