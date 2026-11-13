import { For, Show, createSignal } from 'solid-js';
import { execute } from '../api';
import {
  errorMessage,
  type Collection,
  type ColorLabelFilter,
  type FlagFilter,
  type SmartCollectionRules,
} from '../model';
import { Button, Dialog, Field, Segmented, Select, TextInput } from '../ui';
import './CollectionDialogs.css';

export function CollectionEditorDialog(props: {
  libraryId: string;
  initialKind?: 'manual' | 'smart';
  existing?: Collection;
  seedAssetIds?: string[];
  cameras?: string[];
  keywords?: string[];
  onClose: () => void;
  onSaved: (collection: Collection) => void;
}) {
  const [kind, setKind] = createSignal<'manual' | 'smart'>(
    props.existing?.kind ?? props.initialKind ?? 'manual',
  );
  const [name, setName] = createSignal(props.existing?.name ?? '');
  const [rating, setRating] = createSignal(String(props.existing?.rules?.rating ?? 0));
  const [flag, setFlag] = createSignal<FlagFilter>(props.existing?.rules?.flag ?? 'any');
  const [colorLabel, setColorLabel] = createSignal<ColorLabelFilter>(
    props.existing?.rules?.color_label ?? 'any',
  );
  const [format, setFormat] = createSignal<'all' | 'raw' | 'jpeg'>(
    props.existing?.rules?.format ?? 'all',
  );
  const [camera, setCamera] = createSignal(props.existing?.rules?.camera ?? '');
  const [keyword, setKeyword] = createSignal(props.existing?.rules?.keyword ?? '');
  const [query, setQuery] = createSignal(props.existing?.rules?.query ?? '');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  function buildRules(): SmartCollectionRules {
    return {
      rating: Number(rating()) > 0 ? Number(rating()) : undefined,
      flag: flag() === 'any' ? undefined : flag(),
      color_label: colorLabel() === 'any' ? undefined : colorLabel(),
      format: format() === 'all' ? undefined : format(),
      camera: camera().trim() || undefined,
      keyword: keyword().trim() || undefined,
      query: query().trim() || undefined,
    };
  }

  async function submit(event?: Event) {
    event?.preventDefault();
    const cleanName = name().trim();
    if (!cleanName) {
      setError('请输入精选集名称。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const saved = props.existing
        ? await execute<Collection>('collection.update', {
            id: props.existing.id,
            name: cleanName,
            ...(props.existing.kind === 'smart' ? { rules: buildRules() } : {}),
          })
        : await execute<Collection>('collection.create', {
            library_id: props.libraryId,
            name: cleanName,
            kind: kind(),
            ...(kind() === 'smart' ? { rules: buildRules() } : {}),
            ...(kind() === 'manual' && props.seedAssetIds?.length
              ? { asset_ids: props.seedAssetIds }
              : {}),
          });
      props.onSaved(saved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={
        props.existing
          ? `编辑${props.existing.kind === 'smart' ? '智能精选集' : '精选集'}`
          : kind() === 'smart'
            ? '新建智能精选集'
            : '新建精选集'
      }
      subtitle="跨目录组织选片与交付；原始文件始终留在原目录不动。"
      width={500}
      busy={busy()}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" disabled={busy()} onClick={props.onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy() || !name().trim()} onClick={() => void submit()}>
            {props.existing ? '保存更改' : '创建精选集'}
          </Button>
        </>
      }
    >
      <form class="collection-dialog-form" onSubmit={(e) => void submit(e)}>
        <Show when={!props.existing}>
          <Segmented
            size="sm"
            label="精选集类型"
            value={kind()}
            onChange={(next) => setKind(next as 'manual' | 'smart')}
            options={[
              { value: 'manual', label: '手动精选集', icon: 'layout-grid' },
              { value: 'smart', label: '智能精选集（规则聚合）', icon: 'filter' },
            ]}
          />
        </Show>
        <Field label="精选集名称">
          {(id) => (
            <TextInput
              id={id}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder={kind() === 'smart' ? '例如：五星红标交付' : '例如：京都客片精修'}
              maxLength={80}
            />
          )}
        </Field>
        <Show when={kind() === 'smart'}>
          <div class="collection-rules-grid" role="group" aria-label="智能聚合规则">
            <Field label="最低星级">
              {(id) => (
                <Select
                  id={id}
                  size="sm"
                  value={rating()}
                  onChange={setRating}
                  options={[
                    { value: '0', label: '不限星级' },
                    { value: '1', label: '★ 及以上' },
                    { value: '2', label: '★★ 及以上' },
                    { value: '3', label: '★★★ 及以上' },
                    { value: '4', label: '★★★★ 及以上' },
                    { value: '5', label: '★★★★★ 五星' },
                  ]}
                />
              )}
            </Field>
            <Field label="选片旗标">
              {(id) => (
                <Select
                  id={id}
                  size="sm"
                  value={flag()}
                  onChange={(v) => setFlag(v as FlagFilter)}
                  options={[
                    { value: 'any', label: '不限旗标' },
                    { value: 'pick', label: '留用 (Pick)' },
                    { value: 'not_reject', label: '排除淘汰' },
                    { value: 'none', label: '未标记' },
                    { value: 'reject', label: '淘汰' },
                  ]}
                />
              )}
            </Field>
            <Field label="色标状态">
              {(id) => (
                <Select
                  id={id}
                  size="sm"
                  value={colorLabel()}
                  onChange={(v) => setColorLabel(v as ColorLabelFilter)}
                  options={[
                    { value: 'any', label: '不限色标' },
                    { value: 'red', label: '红色色标 (6)' },
                    { value: 'yellow', label: '黄色色标 (7)' },
                    { value: 'green', label: '绿色色标 (8)' },
                    { value: 'blue', label: '蓝色色标 (9)' },
                    { value: 'none', label: '无色标' },
                  ]}
                />
              )}
            </Field>
            <Field label="文件格式">
              {(id) => (
                <Select
                  id={id}
                  size="sm"
                  value={format()}
                  onChange={(v) => setFormat(v as 'all' | 'raw' | 'jpeg')}
                  options={[
                    { value: 'all', label: '全部格式' },
                    { value: 'raw', label: '仅 RAW' },
                    { value: 'jpeg', label: '仅 JPEG' },
                  ]}
                />
              )}
            </Field>
            <Field label="机身（可选）">
              {(id) => (
                <TextInput
                  id={id}
                  size="sm"
                  value={camera()}
                  onInput={(e) => setCamera(e.currentTarget.value)}
                  placeholder={props.cameras?.[0] || '例如 Sony ILCE-7RM5'}
                />
              )}
            </Field>
            <Field label="层级关键词（含子词）">
              {(id) => (
                <TextInput
                  id={id}
                  size="sm"
                  value={keyword()}
                  onInput={(e) => setKeyword(e.currentTarget.value)}
                  placeholder={props.keywords?.[0] || '例如 人像'}
                />
              )}
            </Field>
            <div class="collection-rule-wide">
              <Field label="文件名或元数据包含">
                {(id) => (
                  <TextInput
                    id={id}
                    size="sm"
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    placeholder="可选搜索词…"
                  />
                )}
              </Field>
            </div>
          </div>
        </Show>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
      </form>
    </Dialog>
  );
}

export { CollectionPickerDialog } from './CollectionPickerDialog';
