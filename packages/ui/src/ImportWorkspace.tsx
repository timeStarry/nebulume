import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { chooseDirectory, desktop, execute, listVolumes } from './api';
import {
  bytes,
  errorMessage,
  type Card,
  type CardIdentification,
  type ImportBatch,
  type ImportPlan,
  type ImportPreset,
  type ImportResult,
  type Library,
  type OrganizeRules,
  type ScanResult,
  type Volume,
} from './model';
import {
  dateSourceName,
  defaultOrganizeRules,
  displayDate,
  importTargets,
  isRemoteLibrary,
  libraryLocation,
  organizeExample,
  subfolderError,
} from './workspace';
import Icon from './Icon';

const RULES_KEY = 'nebulume.import.rules';
function readRules(): OrganizeRules {
  try {
    const saved = JSON.parse(localStorage.getItem(RULES_KEY) || 'null');
    return saved ? { ...defaultOrganizeRules(), ...saved } : defaultOrganizeRules();
  } catch {
    return defaultOrganizeRules();
  }
}
function writeRules(rules: OrganizeRules) {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    /* Rules still apply to this session. */
  }
}

export default function ImportWorkspace(props: {
  active: boolean;
  libraries: Library[];
  onCreateLibrary: () => void;
  onImported: (library: Library, result: ImportResult) => void;
  onOpenLibrary: (library: Library) => void;
  onCull?: (library: Library, batch: ImportBatch) => void;
  onOpenLocations?: () => void;
}) {
  const [volumes, setVolumes] = createSignal<Volume[]>([]);
  const [showAll, setShowAll] = createSignal(false);
  const [volumeError, setVolumeError] = createSignal('');
  const [source, setSource] = createSignal('');
  const [targetId, setTargetId] = createSignal('');
  const [rules, setRules] = createSignal<OrganizeRules>(readRules());
  const updateRules = (patch: Partial<OrganizeRules>) => {
    const next = { ...rules(), ...patch };
    setRules(next);
    writeRules(next);
  };
  const [deduplicate, setDeduplicate] = createSignal(true);
  const [cards, setCards] = createSignal<Card[]>([]);
  const [presets, setPresets] = createSignal<ImportPreset[]>([]);
  const [presetId, setPresetId] = createSignal('');
  const [presetName, setPresetName] = createSignal('');
  const [identified, setIdentified] = createSignal<CardIdentification>();
  const [cardName, setCardName] = createSignal('');
  const [bindId, setBindId] = createSignal('');
  const knownCard = () => {
    const value = identified();
    return value?.status === 'known' ? value.card : undefined;
  };
  function applyPreset(id: string) {
    setPresetId(id);
    const preset = presets().find((item) => item.id === id);
    if (!preset) return;
    setRules({ ...defaultOrganizeRules(), ...preset.rules });
    setDeduplicate(preset.deduplicate);
    if (targets().some((library) => library.id === preset.library_id))
      setTargetId(preset.library_id);
  }
  async function refreshCards() {
    if (!desktop) return;
    try {
      const [cardList, presetList] = await Promise.all([
        execute<Card[]>('card.list'),
        execute<ImportPreset[]>('preset.list'),
      ]);
      setCards(cardList);
      setPresets(presetList);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function identify(volume: Volume) {
    setSource(volume.path);
    setIdentified(undefined);
    setBindId('');
    if (!desktop || !volume.removable) return;
    try {
      const value = await execute<CardIdentification>('card.identify', {
        mount_path: volume.path,
        volume_label: volume.name || null,
      });
      setIdentified(value);
      if (value.status === 'known') {
        if (value.card.default_preset_id) applyPreset(value.card.default_preset_id);
      } else {
        setCardName(volume.name || '存储卡');
        setBindId(value.candidates[0]?.id || '');
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function registerCard(bind: boolean) {
    const volume = volumes().find((item) => item.path === source());
    if (!volume) return;
    setBusy(bind ? '正在绑定存储卡…' : '正在登记存储卡…');
    setError('');
    try {
      const card = await execute<Card>(bind ? 'card.bind' : 'card.register', {
        mount_path: volume.path,
        volume_label: volume.name || null,
        ...(bind ? { card_id: bindId() } : { name: cardName().trim() }),
      });
      setIdentified({ status: 'known', card });
      if (card.default_preset_id) applyPreset(card.default_preset_id);
      await refreshCards();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function savePreset() {
    const name = presetName().trim();
    if (!name || !targetId()) return;
    setBusy('正在保存导入方案…');
    try {
      const existing = presets().find((item) => item.name === name);
      const saved = await execute<ImportPreset>('preset.save', {
        id: existing?.id,
        name,
        library_id: targetId(),
        rules: rules(),
        deduplicate: deduplicate(),
      });
      await refreshCards();
      setPresetId(saved.id);
      setPresetName('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function setCardDefault() {
    const card = knownCard();
    if (!card) return;
    try {
      const updated = await execute<Card>('card.update', {
        id: card.id,
        default_preset_id: presetId() || null,
      });
      setIdentified({ status: 'known', card: updated });
      await refreshCards();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const [plan, setPlan] = createSignal<ImportPlan>();
  const [plannedTarget, setPlannedTarget] = createSignal<Library>();
  const [reviewed, setReviewed] = createSignal(false);
  const [result, setResult] = createSignal<ImportResult>();
  const [history, setHistory] = createSignal<ImportResult[]>([]);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [scanMessage, setScanMessage] = createSignal('');
  let initialized = false;
  const targets = () => importTargets(props.libraries);
  const [includeLikely, setIncludeLikely] = createSignal(false);
  const historyJobs = () => history().filter((job) => job.id !== result()?.id);
  createEffect(() => {
    const available = targets();
    if (!available.some((l) => l.id === targetId())) setTargetId(available[0]?.id || '');
  });
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active && !initialized) {
          initialized = true;
          void refreshVolumes();
          void refreshHistory();
          void refreshCards();
        }
      },
    ),
  );
  async function refreshVolumes() {
    if (!desktop) return;
    setVolumeError('');
    try {
      setVolumes(await listVolumes());
    } catch (e) {
      setVolumeError(errorMessage(e));
    }
  }
  async function refreshHistory() {
    if (!desktop) return;
    try {
      setHistory(await execute<ImportResult[]>('import.history'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function chooseSource() {
    try {
      const path = await chooseDirectory('选择 SD 卡、DCIM 或来源文件夹');
      if (path) setSource(path);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function makePlan(event: SubmitEvent) {
    event.preventDefault();
    const target = targets().find((l) => l.id === targetId());
    if (!target) return;
    setBusy('正在扫描来源并核对内容…');
    setError('');
    setReviewed(false);
    setResult(undefined);
    setScanMessage('');
    try {
      // NAS libraries are addressed by id; the service plans without downloading.
      const next = await execute<ImportPlan>('import.plan', {
        source: source().trim(),
        ...(isRemoteLibrary(target) ? { library_id: target.id } : { destination: target.root }),
        rules: rules(),
        deduplicate: deduplicate(),
      });
      setIncludeLikely(false);
      setPlannedTarget({ ...target });
      setPlan(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function run() {
    if (!plan() || !reviewed() || !plannedTarget()) return;
    setBusy('正在复制并校验…');
    setError('');
    try {
      const completed = await execute<ImportResult>('import.execute', {
        plan_id: plan()!.id,
        library_id: plannedTarget()!.id,
        ...(knownCard() ? { card_id: knownCard()!.id } : {}),
        ...(includeLikely() ? { include_likely_duplicates: true } : {}),
      });
      if (completed.batch_error) setError(`导入批次未记录：${completed.batch_error}`);
      setResult(completed);
      if (completed.status === 'completed' || completed.status === 'partial') {
        setBusy('正在更新目标图片库索引…');
        try {
          if (completed.indexing_error) throw new Error(completed.indexing_error);
          const scan =
            completed.indexing ||
            (await execute<ScanResult>('library.scan', {
              library_id: plannedTarget()!.id,
            }));
          setScanMessage(
            `图片库已更新${scan.errors.length ? `，${scan.errors.length} 项异常` : ''}。`,
          );
          if (scan.errors.length)
            setError(
              scan.errors
                .slice(0, 3)
                .map((item) => `${item.path}：${item.message}`)
                .join('\n'),
            );
        } catch (e) {
          setError(`导入已结束，图片库更新未完成：${errorMessage(e)}`);
        }
        props.onImported(plannedTarget()!, completed);
      }
      await refreshHistory();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  function reset() {
    setPlan(undefined);
    setResult(undefined);
    setReviewed(false);
    setError('');
    setScanMessage('');
  }
  const statusName = (status: string) =>
    (
      ({
        pending: '待复制',
        duplicate: '重复跳过',
        likely_duplicate: '疑似重复',
        copied: '已复制',
        failed: '失败',
        completed: '已完成',
        partial: '部分完成',
        interrupted: '已中断',
      }) as Record<string, string>
    )[status] || status;
  return (
    <section class="workspace-page import-workspace" aria-label="导入工作区">
      <header class="workspace-heading">
        <div>
          <h1>导入</h1>
        </div>
        <button
          class="button"
          onClick={() => {
            void refreshVolumes();
            void refreshHistory();
          }}
          disabled={!!busy() || !desktop}
        >
          <Icon name="refresh" size={15} />
          刷新设备
        </button>
      </header>
      <Show when={!desktop}>
        <div class="workspace-note">
          存储卡与持久导入任务需要桌面版。浏览器演示只支持选择单独图片进行查看。
        </div>
      </Show>
      <Show when={error()}>
        <div class="workspace-message error" role="alert">
          {error()}
        </div>
      </Show>
      <div class="import-work-grid">
        <section class="import-task-panel" aria-label="导入任务" aria-busy={!!busy()}>
          <div class="work-panel-heading">
            <h2>导入照片</h2>
            <Show when={busy()}>
              <span role="status">{busy()}</span>
            </Show>
          </div>
          <div class="import-steps">
            <span classList={{ current: !plan() }}>
              1 <b>选择位置</b>
            </span>
            <i />
            <span classList={{ current: !!plan() && !result() }}>
              2 <b>审核计划</b>
            </span>
            <i />
            <span classList={{ current: !!result() }}>
              3 <b>导入结果</b>
            </span>
          </div>
          <Show when={!plan()}>
            <form class="workspace-form" onSubmit={makePlan}>
              <div class="volumes-heading">
                <label>可用存储卷</label>
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    checked={showAll()}
                    onChange={(e) => setShowAll(e.currentTarget.checked)}
                  />
                  显示所有卷
                </label>
              </div>
              <Show when={volumeError()}>
                <p class="field-note">设备检测未完成：{volumeError()}。仍可手动选择来源目录。</p>
              </Show>
              <div class="volume-list">
                <For
                  each={volumes().filter((volume) => showAll() || volume.removable)}
                  fallback={
                    <p class="field-note">未检测到可移动存储卷，可手动选择 SD 卡或文件夹。</p>
                  }
                >
                  {(volume) => (
                    <button
                      type="button"
                      class={`volume-item ${source() === volume.path ? 'selected' : ''}`}
                      aria-pressed={source() === volume.path}
                      onClick={() => void identify(volume)}
                    >
                      <Icon name="card" size={20} />
                      <div>
                        <strong>{volume.name || volume.path}</strong>
                        <Show when={volume.name && volume.name !== volume.path}>
                          <span>{volume.path}</span>
                        </Show>
                      </div>
                      <small>
                        {volume.available_bytes != null
                          ? `${bytes(volume.available_bytes)} 可用`
                          : volume.removable
                            ? '可移动卷'
                            : volume.kind}
                      </small>
                    </button>
                  )}
                </For>
              </div>
              <label>
                来源目录
                <div class="path-field">
                  <input
                    value={source()}
                    onInput={(e) => {
                      setSource(e.currentTarget.value);
                      setIdentified(undefined);
                    }}
                    placeholder="SD 卡 / DCIM / 文件夹"
                    required
                    disabled={!!busy()}
                  />
                  <button
                    class="button"
                    type="button"
                    onClick={chooseSource}
                    disabled={!!busy() || !desktop}
                  >
                    选择目录…
                  </button>
                </div>
              </label>
              <label>
                目标图片库
                <select
                  value={targetId()}
                  onChange={(e) => setTargetId(e.currentTarget.value)}
                  required
                  disabled={!!busy()}
                >
                  <option value="" disabled>
                    选择图片库
                  </option>
                  <For each={targets()}>
                    {(library) => (
                      <option value={library.id}>
                        {library.name} — {libraryLocation(library)}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <Show when={!targets().length}>
                <p class="field-note">还没有可导入的图片库。</p>
                <button class="button" type="button" onClick={props.onCreateLibrary}>
                  建立图片库
                </button>
              </Show>
              <Show when={identified()}>
                {(value) => (
                  <div class="card-identity" role="status">
                    <Show
                      when={knownCard()}
                      fallback={
                        <>
                          <p>
                            <strong>未登记的存储卡</strong>
                            登记后会在卡根目录写入一个很小的识别文件
                            .nebulume/volume.json，用来记住名称和默认导入方案。照片不会被改动。
                          </p>
                          <div class="form-row">
                            <label>
                              卡名称
                              <input
                                value={cardName()}
                                onInput={(e) => setCardName(e.currentTarget.value)}
                                disabled={!!busy()}
                              />
                            </label>
                            <button
                              class="button"
                              type="button"
                              disabled={!!busy() || !cardName().trim()}
                              onClick={() => void registerCard(false)}
                            >
                              登记这张卡
                            </button>
                          </div>
                          <Show when={cards().length}>
                            <div class="form-row">
                              <label>
                                {value().status !== 'known' &&
                                (value() as { candidates: Card[] }).candidates.length
                                  ? '可能是已登记的卡（格式化后会丢失识别文件）'
                                  : '或绑定到已有记录'}
                                <select
                                  value={bindId()}
                                  onChange={(e) => setBindId(e.currentTarget.value)}
                                  disabled={!!busy()}
                                >
                                  <option value="">选择已登记的卡</option>
                                  <For each={cards()}>
                                    {(card) => (
                                      <option value={card.id}>
                                        {card.name}
                                        {(value() as { candidates?: Card[] }).candidates?.some(
                                          (item) => item.id === card.id,
                                        )
                                          ? '（可能匹配）'
                                          : ''}
                                      </option>
                                    )}
                                  </For>
                                </select>
                              </label>
                              <button
                                class="button"
                                type="button"
                                disabled={!!busy() || !bindId()}
                                onClick={() => void registerCard(true)}
                              >
                                绑定到此记录
                              </button>
                            </div>
                          </Show>
                          <p class="field-note">也可以不登记，直接按本次设置导入。</p>
                        </>
                      }
                    >
                      {(card) => (
                        <p>
                          <strong>{card().name}</strong>
                          {card().last_import_at
                            ? `上次导入 ${displayDate(card().last_import_at!)}`
                            : '尚未从这张卡导入'}
                          <Show when={card().default_preset_id}>
                            {' · 已应用默认方案 '}
                            {presets().find((item) => item.id === card().default_preset_id)?.name ||
                              ''}
                          </Show>
                        </p>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
              <div class="form-row preset-row">
                <label>
                  导入方案
                  <select
                    value={presetId()}
                    onChange={(e) =>
                      e.currentTarget.value ? applyPreset(e.currentTarget.value) : setPresetId('')
                    }
                    disabled={!!busy()}
                  >
                    <option value="">不使用方案（手动设置）</option>
                    <For each={presets()}>
                      {(preset) => <option value={preset.id}>{preset.name}</option>}
                    </For>
                  </select>
                </label>
                <Show when={knownCard()}>
                  <button
                    class="button"
                    type="button"
                    disabled={!!busy() || knownCard()!.default_preset_id === (presetId() || null)}
                    onClick={() => void setCardDefault()}
                  >
                    {presetId() ? '设为这张卡的默认方案' : '清除这张卡的默认方案'}
                  </button>
                </Show>
              </div>
              <fieldset class="organize-rules" disabled={!!busy()}>
                <legend>目录整理</legend>
                <div class="form-row">
                  <label>
                    分类依据
                    <select
                      value={rules().date_basis}
                      onChange={(e) =>
                        updateRules({
                          date_basis: e.currentTarget.value as OrganizeRules['date_basis'],
                        })
                      }
                    >
                      <option value="capture">按拍摄日期</option>
                      <option value="import">按导入日期</option>
                      <option value="preserve">保留卡内目录</option>
                      <option value="none">不分日期</option>
                    </select>
                  </label>
                  <Show when={rules().date_basis === 'capture' || rules().date_basis === 'import'}>
                    <label>
                      日期层级
                      <select
                        value={rules().date_layout}
                        onChange={(e) =>
                          updateRules({
                            date_layout: e.currentTarget.value as OrganizeRules['date_layout'],
                          })
                        }
                      >
                        <option value="Y-M-D">2026-10-22</option>
                        <option value="Y/Y-M-D">2026 / 2026-10-22</option>
                        <option value="Y/M/Y-M-D">2026 / 10 / 2026-10-22</option>
                        <option value="Y/M/D">2026 / 10 / 22</option>
                      </select>
                    </label>
                  </Show>
                </div>
                <div class="form-row">
                  <label>
                    子目录（可选）
                    <input
                      value={rules().subfolder}
                      onInput={(e) => updateRules({ subfolder: e.currentTarget.value.trim() })}
                      placeholder="例如 Camera/Z8"
                      aria-invalid={!!subfolderError(rules().subfolder)}
                    />
                  </label>
                  <label class="checkbox-label">
                    <input
                      type="checkbox"
                      checked={rules().type_split === 'by_kind'}
                      onChange={(e) =>
                        updateRules({ type_split: e.currentTarget.checked ? 'by_kind' : 'none' })
                      }
                    />
                    按类型分目录（RAW / JPG / TIFF / OTHER）
                  </label>
                </div>
                <Show when={rules().date_basis === 'capture'}>
                  <label class="checkbox-label">
                    <input
                      type="checkbox"
                      checked={rules().unknown_date === 'modified_time'}
                      onChange={(e) =>
                        updateRules({
                          unknown_date: e.currentTarget.checked ? 'modified_time' : 'folder',
                        })
                      }
                    />
                    无拍摄时间时改用文件修改日期（计划中逐项标注）
                  </label>
                </Show>
                <Show when={subfolderError(rules().subfolder)}>
                  <p class="form-error">{subfolderError(rules().subfolder)}</p>
                </Show>
                <p class="field-note organize-example">
                  示例：<code>{organizeExample(rules())}</code>
                  <Show
                    when={rules().date_basis === 'capture' && rules().unknown_date === 'folder'}
                  >
                    ，无拍摄时间的文件归入 unknown-date
                  </Show>
                  <Show when={rules().date_basis === 'import'}>，导入日在生成计划时确定</Show>
                </p>
              </fieldset>
              <div class="form-row preset-save">
                <label>
                  保存当前设置为方案
                  <input
                    value={presetName()}
                    onInput={(e) => setPresetName(e.currentTarget.value)}
                    placeholder="例如 NAS 归档"
                    disabled={!!busy()}
                  />
                </label>
                <button
                  class="button"
                  type="button"
                  disabled={
                    !!busy() ||
                    !presetName().trim() ||
                    !targetId() ||
                    !!subfolderError(rules().subfolder)
                  }
                  onClick={() => void savePreset()}
                >
                  保存方案
                </button>
              </div>
              <div class="form-row">
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    checked={deduplicate()}
                    onChange={(e) => setDeduplicate(e.currentTarget.checked)}
                    disabled={!!busy()}
                  />
                  按文件内容跳过重复
                </label>
              </div>
              <div class="workspace-form-actions">
                <button
                  class="button primary"
                  disabled={
                    !!busy() || !desktop || !targetId() || !!subfolderError(rules().subfolder)
                  }
                >
                  生成导入计划
                </button>
              </div>
            </form>
          </Show>
          <Show when={plan() && !result()}>
            <div class="inline-import-content">
              <div class="import-plan-locations">
                <div>
                  <span>来源</span>
                  <strong>{plan()!.source}</strong>
                </div>
                <Icon name="right" />
                <div>
                  <span>目标 · {plannedTarget()?.name}</span>
                  <strong>{plan()!.destination}</strong>
                </div>
              </div>
              <p class="field-note">保留来源文件，不覆盖已有文件。</p>
              <For each={plan()!.warnings || []}>
                {(warning) => <p class="form-error">{warning}</p>}
              </For>
              <div class="import-metrics">
                <span>
                  <strong>{plan()!.items.length}</strong> 个文件
                </span>
                <span>
                  <strong>{bytes(plan()!.total_bytes)}</strong> 计划大小
                </span>
                <span>
                  <strong>{plan()!.duplicate_count}</strong> 项重复
                </span>
                <Show when={plan()!.likely_duplicate_count}>
                  <span>
                    <strong>{plan()!.likely_duplicate_count}</strong> 项疑似重复
                  </span>
                </Show>
              </div>
              <Show when={plan()!.likely_duplicate_count}>
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeLikely()}
                    onChange={(e) => setIncludeLikely(e.currentTarget.checked)}
                    disabled={!!busy()}
                  />
                  仍然导入疑似重复项（文件名、大小与拍摄日期相同，但未经内容校验；可在图片库设置中建立内容指纹以严格判重）
                </label>
              </Show>
              <Show when={plan()!.write_capability && plan()!.write_capability !== 'verified'}>
                <div class="workspace-message error" role="alert">
                  <span>
                    {plan()!.write_capability === 'unsupported'
                      ? '这个网络位置无法保证不覆盖已有文件，Nebulume 不会向它导入。'
                      : '导入前需要先在“位置”中对这个网络位置“测试写入”，确认它能安全地新建文件且不覆盖已有内容。'}
                  </span>
                  <Show when={props.onOpenLocations && plan()!.write_capability === 'unverified'}>
                    <button class="button small" type="button" onClick={props.onOpenLocations}>
                      前往位置
                    </button>
                  </Show>
                </div>
              </Show>
              <div class="import-review-table">
                <div class="directory-table-head">
                  <span>目标相对路径</span>
                  <span>大小</span>
                  <span>状态</span>
                </div>
                <For each={plan()!.items.slice(0, 200)}>
                  {(item) => (
                    <div class="directory-entry">
                      <span title={item.source}>
                        {item.relative_path}
                        <Show
                          when={
                            item.date_source === 'modified_time' || item.date_source === 'unknown'
                          }
                        >
                          <small class={`date-source ${item.date_source}`}>
                            {dateSourceName(item.date_source)}
                          </small>
                        </Show>
                      </span>
                      <span>{bytes(item.size)}</span>
                      <span>{statusName(item.status)}</span>
                    </div>
                  )}
                </For>
              </div>
              <Show when={plan()!.items.length > 200}>
                <p class="field-note">显示前 200 项，共 {plan()!.items.length} 项。</p>
              </Show>
              <label class="checkbox-label plan-review-confirm">
                <input
                  type="checkbox"
                  checked={reviewed()}
                  onChange={(e) => setReviewed(e.currentTarget.checked)}
                  disabled={!!busy()}
                />
                我已核对来源、目标和导入计划
              </label>
              <div class="workspace-form-actions">
                <button class="button" onClick={reset} disabled={!!busy()}>
                  返回修改
                </button>
                <button
                  class="button primary"
                  onClick={run}
                  disabled={
                    !!busy() ||
                    !reviewed() ||
                    !plan()!.items.length ||
                    (!!plan()!.write_capability && plan()!.write_capability !== 'verified')
                  }
                >
                  开始导入
                </button>
              </div>
            </div>
          </Show>
          <Show when={result()}>
            <div class="inline-import-content">
              <div
                class="import-completion"
                classList={{ 'has-issues': result()!.status !== 'completed' }}
              >
                <Icon name={result()!.failed ? 'info' : 'check'} size={26} />
                <div>
                  <h3>{statusName(result()!.status)}</h3>
                  <p>
                    已复制 {result()!.copied} · 重复跳过 {result()!.duplicates} · 失败{' '}
                    {result()!.failed}
                  </p>
                </div>
              </div>
              <Show when={scanMessage()}>
                <p class="success-message" role="status">
                  {scanMessage()}
                </p>
              </Show>
              <div class="import-review-table">
                <For each={result()!.items}>
                  {(item) => (
                    <div class="directory-entry">
                      <span>
                        {item.destination}
                        <Show when={item.error}>
                          <small class="result-file-error">{item.error}</small>
                        </Show>
                      </span>
                      <span>{bytes(item.size)}</span>
                      <span>{statusName(item.status)}</span>
                    </div>
                  )}
                </For>
              </div>
              <div class="workspace-form-actions">
                <button class="button" disabled={!!busy()} onClick={reset}>
                  继续导入
                </button>
                <button
                  class="button"
                  disabled={!!busy()}
                  onClick={() => plannedTarget() && props.onOpenLibrary(plannedTarget()!)}
                >
                  查看目标图片库
                </button>
                <Show when={result()?.batch?.asset_count && props.onCull}>
                  <button
                    class="button primary"
                    disabled={!!busy()}
                    onClick={() => props.onCull!(plannedTarget()!, result()!.batch!)}
                  >
                    开始选图（{result()!.batch!.asset_count} 张）
                  </button>
                </Show>
              </div>
            </div>
          </Show>
        </section>
        <aside class="import-history-panel">
          <div class="work-panel-heading">
            <h2>导入历史</h2>
            <Show when={historyJobs().length > 0}>
              <span>{historyJobs().length} 个任务</span>
            </Show>
          </div>
          <For
            each={historyJobs()}
            fallback={
              <div class="compact-empty">
                <Icon name="clock" size={25} />
                <p>{result() ? '暂无其他导入记录' : '暂无导入记录'}</p>
              </div>
            }
          >
            {(job) => (
              <details class="import-history-item">
                <summary>
                  <strong>{statusName(job.status)}</strong>
                  <span>{displayDate(job.started_at)}</span>
                  <small>
                    复制 {job.copied} · 重复 {job.duplicates} · 失败 {job.failed}
                  </small>
                </summary>
                <p>{job.destination}</p>
                <For each={job.items?.filter((item) => item.status === 'failed')}>
                  {(item) => (
                    <p class="history-failure">
                      {item.source}：{item.error}
                    </p>
                  )}
                </For>
              </details>
            )}
          </For>
        </aside>
      </div>
    </section>
  );
}
