import { createMemo, For, Show } from 'solid-js';
import { bytes } from '../model';
import type { CachePolicy, CacheStats } from '../cache-model';
import { Button, Group, ListRow, Select, TextInput, type SelectOption } from '../ui';

const BASE_DAY_OPTIONS: SelectOption[] = [
  { value: '0', label: '仅按容量上限' },
  { value: '30', label: '30 天未使用' },
  { value: '60', label: '60 天未使用' },
  { value: '90', label: '90 天未使用' },
];

export default function CachePolicyGroup(props: {
  budget: string;
  days: number;
  preview: CachePolicy['preview_policy'];
  pinned: CacheStats['pinned'];
  budgetError: string;
  policyChanged: boolean;
  locked: boolean;
  migrating: boolean;
  cacheUnavailable: boolean;
  onBudgetChange: (value: string) => void;
  onDaysChange: (value: number) => void;
  onPreviewChange: (value: CachePolicy['preview_policy']) => void;
  onReset: () => void;
  onSave: () => void;
  onUnpin: (item: CacheStats['pinned'][number]) => void;
}) {
  const dayOptions = createMemo<SelectOption[]>(() =>
    [0, 30, 60, 90].includes(props.days)
      ? BASE_DAY_OPTIONS
      : [...BASE_DAY_OPTIONS, { value: String(props.days), label: `${props.days} 天未使用` }],
  );

  return (
    <>
      <Group title="容量上限与回收策略">
        <ListRow
          title="最大容量"
          labelFor="cache-budget"
          description={
            <span
              id="cache-budget-help"
              class="cache-budget-help"
              classList={{ 'cache-field-error': !!props.budgetError }}
              role={props.budgetError ? 'alert' : undefined}
            >
              {props.budgetError ||
                (props.migrating
                  ? '迁移中暂不更改策略。'
                  : props.cacheUnavailable
                    ? '离线时仅允许提高上限，降低需连接后核对。'
                    : '降低上限前将确认回收；离线固定与在用内容受保护。')}
            </span>
          }
          control={
            <TextInput
              id="cache-budget"
              size="sm"
              wrapClass="cache-budget-input"
              aria-label="缓存总上限，GiB"
              aria-describedby="cache-budget-help"
              invalid={!!props.budgetError}
              type="number"
              min="1"
              max="1024"
              step="1"
              suffix="GiB"
              value={props.budget}
              onInput={(event) => props.onBudgetChange(event.currentTarget.value)}
              disabled={props.locked}
            />
          }
        />

        <ListRow
          title="远端预览获取"
          description="浏览网络存储图片库时的预览与完整原片拉取策略"
          control={
            <Select
              size="sm"
              aria-label="远端预览"
              value={props.preview}
              disabled={props.locked || props.cacheUnavailable}
              onChange={(value) => props.onPreviewChange(value as CachePolicy['preview_policy'])}
              options={[
                { value: 'automatic', label: '智能按需（默认）' },
                { value: 'manual', label: '完整文件手动获取' },
              ]}
            />
          }
        />

        <ListRow
          title="普通原图自动回收"
          description="超过期限未访问的非固定原图缓存将优先释放"
          control={
            <Select
              size="sm"
              aria-label="普通原图自动回收"
              value={String(props.days)}
              disabled={props.locked || props.cacheUnavailable}
              onChange={(value) => props.onDaysChange(Number(value))}
              options={dayOptions()}
            />
          }
        />

        <div class="nl-row cache-policy-footer">
          <p class="cache-policy-hint">
            {props.preview === 'manual'
              ? '使用已有缓存浏览；需要完整文件时由你手动获取，下载内容计入总上限。'
              : '优先使用已有缩略图与远端预览；不支持 Range 或解码需要完整文件时按需获取，计入总上限。'}
          </p>
          <div class="cache-policy-actions">
            <Show when={props.policyChanged}>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.locked}
                onClick={() => props.onReset()}
              >
                还原
              </Button>
            </Show>
            <Button
              size="sm"
              variant="primary"
              disabled={props.locked || !props.policyChanged || !!props.budgetError}
              onClick={() => props.onSave()}
            >
              保存缓存策略
            </Button>
          </div>
        </div>
      </Group>

      <Group title="离线固定照片" meta="计入总上限，不自动回收">
        <Show
          when={props.pinned.length}
          fallback={<div class="nl-row cache-empty-row">尚无离线固定的原图。</div>}
        >
          <For each={props.pinned}>
            {(item) => (
              <ListRow
                leading="pin"
                title={item.name}
                description={bytes(item.size)}
                control={
                  <Button
                    size="sm"
                    disabled={props.locked || props.cacheUnavailable}
                    aria-label={`解除 ${item.name} 的离线保留`}
                    onClick={() => props.onUnpin(item)}
                  >
                    解除固定…
                  </Button>
                }
              />
            )}
          </For>
        </Show>
      </Group>
    </>
  );
}
