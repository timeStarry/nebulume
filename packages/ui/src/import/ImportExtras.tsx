import { For, Show, createMemo } from 'solid-js';
import { chooseDirectory, desktop } from '../api';
import { bytes, type ImportItem, type OrganizeRules, type RenameMode } from '../model';
import { companionGroupKey, renamePrefixError } from '../workspace';
import { Button, ListRow, Select, Switch, TextInput, Toggle } from '../ui';

export { companionGroupKey };
export { ImportLiveProgress, ImportPostActions } from './ImportExecution';

export function isSelectableImportItem(item: ImportItem, includeLikely: boolean): boolean {
  return item.status === 'pending' || (includeLikely && item.status === 'likely_duplicate');
}

export function DualBackupSection(props: {
  enabled: boolean;
  path: string;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
  onPathChange: (path: string) => void;
}) {
  async function pickFolder() {
    const chosen = await chooseDirectory('选择副盘备份目录');
    if (chosen) props.onPathChange(chosen);
  }
  return (
    <>
      <ListRow
        title="双盘同时备份到副盘"
        description="主库复制校验通过后，同步逐字节校验写入副盘目录"
        control={
          <Switch
            label="双盘同时备份到副盘"
            checked={props.enabled}
            onChange={props.onToggle}
            disabled={props.disabled}
          />
        }
      />
      <Show when={props.enabled}>
        <ListRow
          title="副盘备份目录"
          labelFor="import-backup-path"
          description={props.path.trim() ? undefined : '请选择外置 SSD 或第二块硬盘上的备份目录'}
          control={
            <div class="import-inline-controls">
              <TextInput
                id="import-backup-path"
                size="sm"
                wrapClass="import-path-input"
                value={props.path}
                onInput={(e) => props.onPathChange(e.currentTarget.value)}
                placeholder="/Volumes/BackupSSD/Ingest"
                disabled={props.disabled}
                invalid={!props.path.trim()}
              />
              <Show when={desktop}>
                <Button
                  size="sm"
                  icon="folder-open"
                  disabled={props.disabled}
                  onClick={() => void pickFolder()}
                >
                  选择目录…
                </Button>
              </Show>
            </div>
          }
        />
      </Show>
    </>
  );
}

const RENAME_OPTIONS: { value: RenameMode; label: string }[] = [
  { value: 'keep', label: '保留相机原文件名' },
  { value: 'date_prefix_seq', label: '拍摄日期 + 前缀 + 四位序号' },
  { value: 'prefix_original', label: '自定义前缀 + 原文件名' },
];

export function RenameRuleSection(props: {
  rules: OrganizeRules;
  disabled?: boolean;
  onChange: (patch: Partial<OrganizeRules>) => void;
}) {
  const mode = () => props.rules.rename_mode ?? 'keep';
  const prefixErr = () => renamePrefixError(props.rules.rename_prefix);
  return (
    <>
      <ListRow
        title="导入重命名"
        control={
          <Select
            size="sm"
            aria-label="导入重命名"
            value={mode()}
            disabled={props.disabled}
            onChange={(value) => props.onChange({ rename_mode: value as RenameMode })}
            options={RENAME_OPTIONS}
          />
        }
      />
      <Show when={mode() !== 'keep'}>
        <ListRow
          title="命名前缀"
          labelFor="import-rename-prefix"
          description={prefixErr() || '同组 RAW + JPEG + XMP 自动保持同号主文件名'}
          control={
            <TextInput
              id="import-rename-prefix"
              size="sm"
              aria-label="命名前缀"
              value={props.rules.rename_prefix ?? ''}
              disabled={props.disabled}
              invalid={!!prefixErr()}
              placeholder="例如 Wedding 或 Editorial"
              onInput={(e) => props.onChange({ rename_prefix: e.currentTarget.value.trim() })}
            />
          }
        />
      </Show>
    </>
  );
}

function extractItemDay(item: ImportItem): string {
  const iso = item.relative_path.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const slash = item.relative_path.match(/\b(\d{4})\/(\d{2})\/(\d{2})\b/);
  if (slash) return `${slash[1]}-${slash[2]}-${slash[3]}`;
  if (item.relative_path.includes('unknown-date')) return '未知日期';
  const dir = item.relative_path.indexOf('/');
  return dir > 0 ? item.relative_path.slice(0, dir) : '全部文件';
}

export function ImportSelectionBar(props: {
  items: ImportItem[];
  includeLikely: boolean;
  selected: Set<string>;
  disabled?: boolean;
  onChange: (next: Set<string>) => void;
}) {
  const selectable = createMemo(() =>
    props.items.filter((item) => isSelectableImportItem(item, props.includeLikely)),
  );
  const dayBuckets = createMemo(() => {
    const map = new Map<string, ImportItem[]>();
    for (const item of selectable()) {
      const day = extractItemDay(item);
      const bucket = map.get(day) || [];
      bucket.push(item);
      map.set(day, bucket);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  });
  const selectedStats = createMemo(() => {
    let count = 0;
    let totalBytes = 0;
    for (const item of selectable()) {
      if (props.selected.has(item.source)) {
        count += 1;
        totalBytes += item.size;
      }
    }
    return { count, totalBytes };
  });
  function toggleDay(dayItems: ImportItem[]) {
    const allChecked = dayItems.every((item) => props.selected.has(item.source));
    const groups = new Set(dayItems.map((item) => companionGroupKey(item.source)));
    const next = new Set(props.selected);
    for (const item of selectable()) {
      if (!groups.has(companionGroupKey(item.source))) continue;
      if (allChecked) next.delete(item.source);
      else next.add(item.source);
    }
    props.onChange(next);
  }
  return (
    <Show when={selectable().length > 0}>
      <div class="import-selection-bar" aria-label="勾选要导入的照片">
        <div class="import-selection-top">
          <span class="import-selection-summary">
            已勾选 <b>{selectedStats().count}</b> / {selectable().length} 项 ·{' '}
            {bytes(selectedStats().totalBytes)}
          </span>
          <div class="import-inline-controls">
            <Button
              size="sm"
              variant="ghost"
              disabled={props.disabled || selectedStats().count === selectable().length}
              onClick={() => props.onChange(new Set(selectable().map((item) => item.source)))}
            >
              全选待导入
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={props.disabled || selectedStats().count === 0}
              onClick={() => props.onChange(new Set())}
            >
              取消全选
            </Button>
          </div>
        </div>
        <Show when={dayBuckets().length > 1}>
          <div class="import-day-pills" role="group" aria-label="按拍摄日勾选">
            <For each={dayBuckets()}>
              {([day, dayItems]) => (
                <Toggle
                  pressed={dayItems.every((item) => props.selected.has(item.source))}
                  disabled={props.disabled}
                  onChange={() => toggleDay(dayItems)}
                >
                  {day} ({dayItems.length})
                </Toggle>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
