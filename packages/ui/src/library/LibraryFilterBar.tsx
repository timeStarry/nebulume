import { Show } from 'solid-js';
import type {
  AssetFacets,
  AssetListOptions,
  ColorLabelFilter,
  FlagFilter,
  ImportBatch,
} from '../model';
import { Button, Select, TextInput } from '../ui';

export default function LibraryFilterBar(props: {
  rating: number;
  onRating: (value: number) => void;
  flag: FlagFilter;
  onFlag: (value: FlagFilter) => void;
  colorLabel: ColorLabelFilter;
  onColorLabel: (value: ColorLabelFilter) => void;
  format: NonNullable<AssetListOptions['format']>;
  onFormat: (value: NonNullable<AssetListOptions['format']>) => void;
  facets?: AssetFacets;
  camera: string;
  onCamera: (value: string) => void;
  lens: string;
  onLens: (value: string) => void;
  keywords: { path: string; count: number }[];
  keyword: string;
  onKeyword: (value: string) => void;
  capturedFrom: string;
  onCapturedFrom: (value: string) => void;
  capturedTo: string;
  onCapturedTo: (value: string) => void;
  batches: ImportBatch[];
  batchId: string;
  onBatchId: (value: string) => void;
  hasActiveFilters: boolean;
  onClearAll: () => void;
}) {
  return (
    <div
      class="filter-panel library-filters"
      id="collection-filters"
      role="group"
      aria-label="筛选条件"
    >
      <Select
        size="sm"
        aria-label="最低评级筛选"
        value={String(props.rating)}
        onChange={(value) => props.onRating(Number(value))}
        options={[
          { value: '0', label: '所有评级' },
          ...[1, 2, 3, 4, 5].map((value) => ({
            value: String(value),
            label: `${'★'.repeat(value)}${value < 5 ? ' 及以上' : ''}`,
          })),
        ]}
      />
      <Select
        size="sm"
        aria-label="旗标筛选"
        value={props.flag}
        onChange={(value) => props.onFlag(value as FlagFilter)}
        options={[
          { value: 'any', label: '所有旗标' },
          { value: 'pick', label: '留用' },
          { value: 'none', label: '未标记' },
          { value: 'reject', label: '淘汰' },
          { value: 'not_reject', label: '隐藏淘汰' },
        ]}
      />
      <Select
        size="sm"
        aria-label="色标筛选"
        value={props.colorLabel}
        onChange={(value) => props.onColorLabel(value as ColorLabelFilter)}
        options={[
          { value: 'any', label: '所有色标' },
          { value: 'red', label: '红色标（6）' },
          { value: 'yellow', label: '黄色标（7）' },
          { value: 'green', label: '绿色标（8）' },
          { value: 'blue', label: '蓝色标（9）' },
          { value: 'none', label: '无色标' },
        ]}
      />
      <Select
        size="sm"
        aria-label="文件格式筛选"
        value={props.format}
        onChange={(value) => props.onFormat(value as NonNullable<AssetListOptions['format']>)}
        options={[
          { value: 'all', label: '所有格式' },
          { value: 'raw', label: 'RAW' },
          { value: 'jpeg', label: 'JPEG' },
        ]}
      />
      <Show when={props.facets?.cameras.length}>
        <Select
          size="sm"
          aria-label="机身筛选"
          value={props.camera}
          onChange={props.onCamera}
          options={[
            { value: '', label: '所有机身' },
            ...props.facets!.cameras.map((item) => ({
              value: item.value,
              label: `${item.value}（${item.count}）`,
            })),
          ]}
        />
      </Show>
      <Show when={props.facets?.lenses.length}>
        <Select
          size="sm"
          aria-label="镜头筛选"
          value={props.lens}
          onChange={props.onLens}
          options={[
            { value: '', label: '所有镜头' },
            ...props.facets!.lenses.map((item) => ({
              value: item.value,
              label: `${item.value}（${item.count}）`,
            })),
          ]}
        />
      </Show>
      <Show when={props.keywords.length || props.keyword}>
        <Select
          size="sm"
          aria-label="关键词筛选"
          value={props.keyword}
          onChange={props.onKeyword}
          options={[
            { value: '', label: '所有关键词' },
            ...props.keywords.map((item) => ({
              value: item.path,
              label: `${item.path}（${item.count}）`,
            })),
          ]}
        />
      </Show>
      <span class="library-dates" role="group" aria-label="拍摄日期范围">
        <TextInput
          size="sm"
          type="date"
          value={props.capturedFrom}
          min={props.facets?.captured.first ?? undefined}
          max={props.capturedTo || props.facets?.captured.last || undefined}
          onChange={(event) => props.onCapturedFrom(event.currentTarget.value)}
          aria-label="拍摄日期起"
        />
        <span aria-hidden="true">–</span>
        <TextInput
          size="sm"
          type="date"
          value={props.capturedTo}
          min={props.capturedFrom || props.facets?.captured.first || undefined}
          max={props.facets?.captured.last ?? undefined}
          onChange={(event) => props.onCapturedTo(event.currentTarget.value)}
          aria-label="拍摄日期止"
        />
      </span>
      <Show when={props.batches.length}>
        <Select
          size="sm"
          aria-label="导入批次"
          value={props.batchId}
          onChange={props.onBatchId}
          options={[
            { value: '', label: '所有导入' },
            ...props.batches.map((batch) => ({
              value: batch.id,
              label: `${batch.started_at.slice(0, 16).replace('T', ' ')} · ${batch.asset_count} 张`,
            })),
          ]}
        />
      </Show>
      <Show when={props.hasActiveFilters}>
        <Button size="sm" variant="ghost" class="filter-clear" onClick={props.onClearAll}>
          清除全部
        </Button>
      </Show>
    </div>
  );
}
