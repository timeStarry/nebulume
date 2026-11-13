import { Show, createMemo, createSignal } from 'solid-js';
import { chooseDirectory, desktop } from './api';
import {
  BUILTIN_EXPORT_PRESETS,
  clampExportRecipe,
  describeRecipe,
  exampleExportName,
  exportPrefixError,
  readLastExportState,
  readUserExportPresets,
  removeUserExportPreset,
  saveUserExportPreset,
  writeLastExportState,
  type ExportColorSpace,
  type ExportNamingMode,
  type ExportPreset,
  type ExportRecipe,
} from './export-presets';
import { Button, Dialog, Field, Segmented, Select, Slider, TextInput } from './ui';
import './ExportDialog.css';

const EDGE_CHOICES = ['full', '4096', '3840', '2048', 'custom'] as const;
type EdgeChoice = (typeof EDGE_CHOICES)[number];

function edgeChoiceFor(maxEdge: number | null): EdgeChoice {
  if (!maxEdge) return 'full';
  if (maxEdge === 4096 || maxEdge === 3840 || maxEdge === 2048) return String(maxEdge) as EdgeChoice;
  return 'custom';
}

export default function ExportDialog(props: {
  count: number;
  sample?: { filename: string; captured_at?: string };
  busy?: boolean;
  onClose: () => void;
  onConfirm: (recipe: ExportRecipe, directory: string) => void;
}) {
  const initial = readLastExportState();
  const [userPresets, setUserPresets] = createSignal<ExportPreset[]>(readUserExportPresets());
  const allPresets = createMemo(() => [...BUILTIN_EXPORT_PRESETS, ...userPresets()]);
  const [presetId, setPresetId] = createSignal(initial.presetId);
  const [recipe, setRecipe] = createSignal<ExportRecipe>(initial.recipe);
  const [directory, setDirectory] = createSignal(initial.directory);
  const [edgeMode, setEdgeMode] = createSignal<EdgeChoice>(edgeChoiceFor(initial.recipe.maxEdge));
  const [customEdge, setCustomEdge] = createSignal(String(initial.recipe.maxEdge || 3000));
  const [savingPreset, setSavingPreset] = createSignal(false);
  const [presetName, setPresetName] = createSignal('');

  const activeCustomPreset = createMemo(() =>
    userPresets().find((item) => item.id === presetId()),
  );
  const prefixErr = createMemo(() =>
    recipe().naming === 'prefix_seq' ? exportPrefixError(recipe().customPrefix) : '',
  );
  const canConfirm = createMemo(
    () => !props.busy && !prefixErr() && (!desktop || !!directory().trim()),
  );

  function patchRecipe(patch: Partial<ExportRecipe>) {
    setRecipe((prev) => clampExportRecipe({ ...prev, ...patch }));
  }

  function selectPreset(id: string) {
    setPresetId(id);
    const found = allPresets().find((item) => item.id === id);
    if (!found) return;
    setRecipe({ ...found.recipe });
    setEdgeMode(edgeChoiceFor(found.recipe.maxEdge));
    if (found.recipe.maxEdge) setCustomEdge(String(found.recipe.maxEdge));
  }

  async function pickFolder() {
    const chosen = await chooseDirectory('选择导出目标文件夹');
    if (chosen) setDirectory(chosen);
  }

  function handleSavePreset() {
    const saved = saveUserExportPreset(presetName(), recipe());
    setUserPresets(readUserExportPresets());
    setPresetId(saved.id);
    setPresetName('');
    setSavingPreset(false);
  }

  function handleDeletePreset() {
    const current = activeCustomPreset();
    if (!current) return;
    setUserPresets(removeUserExportPreset(current.id));
    selectPreset('master');
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canConfirm()) return;
    const clean = clampExportRecipe(recipe());
    writeLastExportState({
      presetId: presetId(),
      recipe: clean,
      directory: directory().trim(),
    });
    props.onConfirm(clean, directory().trim());
  }

  return (
    <Dialog
      title={props.count > 1 ? `导出 ${props.count} 张照片` : '导出 JPEG 交付件'}
      subtitle="应用当前裁剪配方、长边缩放与色彩空间转换，绝不修改或覆盖原始照片。"
      width={520}
      busy={props.busy}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={props.busy}>
            取消
          </Button>
          <Button
            type="submit"
            form="export-dialog-form"
            variant="primary"
            icon="export"
            disabled={!canConfirm()}
            busy={props.busy}
          >
            {props.count > 1 ? `导出 ${props.count} 张` : '导出 JPEG'}
          </Button>
        </>
      }
    >
      <form id="export-dialog-form" class="export-dialog-grid" onSubmit={submit}>
        <Field label="导出预设" help={describeRecipe(recipe())}>
          {(id) => (
            <div class="export-preset-bar">
              <Select
                id={id}
                aria-label="导出预设"
                wrapClass="export-preset-select"
                value={presetId()}
                onChange={selectPreset}
                options={allPresets().map((preset) => ({
                  value: preset.id,
                  label: `${preset.name} — ${preset.description}`,
                }))}
              />
              <Button size="sm" onClick={() => setSavingPreset((v) => !v)}>
                存为预设
              </Button>
              <Show when={activeCustomPreset()}>
                <Button size="sm" variant="ghost" onClick={handleDeletePreset}>
                  删除
                </Button>
              </Show>
            </div>
          )}
        </Field>

        <Show when={savingPreset()}>
          <div class="export-preset-save">
            <TextInput
              size="sm"
              aria-label="新导出预设名称"
              wrapClass="export-preset-save-input"
              value={presetName()}
              onInput={(e) => setPresetName(e.currentTarget.value)}
              placeholder="例如 客片精修小样 3000px"
            />
            <Button size="sm" variant="primary" disabled={!presetName().trim()} onClick={handleSavePreset}>
              保存
            </Button>
          </div>
        </Show>

        <Field label="长边尺寸限制" help="仅等比缩小大图，不会放大低像素照片。">
          {() => (
            <div class="export-edge-row">
              <Segmented
                size="sm"
                label="长边尺寸"
                value={edgeMode()}
                onChange={(choice) => {
                  setEdgeMode(choice);
                  if (choice === 'full') patchRecipe({ maxEdge: null });
                  else if (choice === 'custom') patchRecipe({ maxEdge: Number(customEdge()) || 3000 });
                  else patchRecipe({ maxEdge: Number(choice) });
                }}
                options={[
                  { value: 'full', label: '原尺寸' },
                  { value: '4096', label: '4096 px' },
                  { value: '3840', label: '3840 px' },
                  { value: '2048', label: '2048 px' },
                  { value: 'custom', label: '自定义' },
                ]}
              />
              <Show when={edgeMode() === 'custom'}>
                <TextInput
                  size="sm"
                  aria-label="自定义长边像素"
                  value={customEdge()}
                  onInput={(e) => {
                    setCustomEdge(e.currentTarget.value);
                    const n = Number(e.currentTarget.value);
                    if (Number.isFinite(n) && n >= 256) patchRecipe({ maxEdge: n });
                  }}
                  placeholder="256 - 16384"
                />
              </Show>
            </div>
          )}
        </Field>

        <Field label="JPEG 品质">
          {() => (
            <div class="export-quality-row">
              <Slider
                label="JPEG 品质"
                min={30}
                max={100}
                step={1}
                value={recipe().quality}
                onInput={(quality) => patchRecipe({ quality })}
              />
              <span class="export-quality-badge">{recipe().quality}%</span>
            </div>
          )}
        </Field>

        <Field label="输出色彩空间" help="转换至目标色域并嵌入标准 ICC v2.1 配置文件。">
          {(id) => (
            <Select
              id={id}
              aria-label="输出色彩空间"
              value={recipe().colorSpace}
              onChange={(value) => patchRecipe({ colorSpace: value as ExportColorSpace })}
              options={[
                { value: 'preserve', label: '保留原图色彩配置（母版推荐）' },
                { value: 'srgb', label: 'sRGB IEC61966-2.1（网页、微信与客户审片）' },
                { value: 'display_p3', label: 'Display P3（Apple 广色域屏幕）' },
                { value: 'adobe_rgb', label: 'Adobe RGB (1998)（商业印刷与微喷）' },
              ]}
            />
          )}
        </Field>

        <Field label="导出文件命名" error={prefixErr() || undefined}>
          {(id) => (
            <>
              <Select
                id={id}
                aria-label="导出文件命名"
                value={recipe().naming}
                onChange={(value) => patchRecipe({ naming: value as ExportNamingMode })}
                options={[
                  { value: 'edited', label: '原文件名-edited.jpg' },
                  { value: 'original', label: '原文件名.jpg（重名自动编号）' },
                  { value: 'date_stem', label: '拍摄日期_原文件名.jpg' },
                  { value: 'prefix_seq', label: '自定义前缀_四位序号.jpg' },
                ]}
              />
              <Show when={recipe().naming === 'prefix_seq'}>
                <TextInput
                  size="sm"
                  aria-label="导出命名前缀"
                  value={recipe().customPrefix}
                  invalid={!!prefixErr()}
                  onInput={(e) => patchRecipe({ customPrefix: e.currentTarget.value })}
                  placeholder="例如 ClientReview"
                />
              </Show>
            </>
          )}
        </Field>

        <Show when={desktop}>
          <Field label="导出目标文件夹" help="重名文件会自动追加编号，绝不覆盖已有文件。">
            {(id) => (
              <div class="export-dest-row">
                <TextInput
                  id={id}
                  aria-label="导出目标文件夹"
                  wrapClass="export-dest-input"
                  value={directory()}
                  onInput={(e) => setDirectory(e.currentTarget.value)}
                  placeholder="选择导出目录…"
                  required
                />
                <Button size="sm" icon="folder-open" onClick={() => void pickFolder()}>
                  浏览…
                </Button>
              </div>
            )}
          </Field>
        </Show>

        <div class="export-preview-box">
          <span>输出文件名预览</span>
          <code>{exampleExportName(recipe(), props.sample)}</code>
        </div>
      </form>
    </Dialog>
  );
}
