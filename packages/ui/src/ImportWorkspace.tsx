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
  type StorageConfig,
  type Volume,
} from './model';
import {
  availabilityPresentation,
  dateSourceName,
  defaultOrganizeRules,
  displayDate,
  importTargets,
  isRemoteLibrary,
  libraryLocation,
  organizeExample,
  sourceKind,
  subfolderError,
} from './workspace';
import Icon from './Icon';
import './import.css';

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
  /** Saved locations, used to show a NAS target's write status before planning. */
  sources?: StorageConfig[];
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
    setFilter('all');
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
  type ReviewFilter = 'all' | 'pending' | 'existing' | 'likely';
  const [filter, setFilter] = createSignal<ReviewFilter>('all');
  const tabs = (): [ReviewFilter, string][] => [
    ['all', `全部 ${counts().all}`],
    ['pending', `待导入 ${counts().pending}`],
    ['existing', `已在库中 ${counts().existing}`],
    ...(counts().likely
      ? ([['likely', `疑似 ${counts().likely}`]] as [ReviewFilter, string][])
      : []),
  ];
  const selectedTarget = () => targets().find((library) => library.id === targetId());
  const selectedVolume = () => volumes().find((volume) => volume.path === source());
  const shownVolumes = () => volumes().filter((volume) => showAll() || volume.removable);
  const locationOf = (library?: Library) =>
    props.sources?.find((item) => item.id === library?.storage_id);
  const candidates = () => {
    const value = identified();
    return value && value.status !== 'known' ? value.candidates : [];
  };
  const sourceLabel = () => {
    if (knownCard()) return knownCard()!.name;
    const volume = selectedVolume();
    if (volume) return volume.name || volume.path;
    const path = source().trim();
    return path ? path.split(/[\\/]/).filter(Boolean).pop() || path : '';
  };
  const basisName = (basis: OrganizeRules['date_basis']) =>
    ({ capture: '按拍摄日期', import: '按导入日期', preserve: '保留卡内目录', none: '不分日期' })[
      basis
    ];
  const counts = () => {
    const items = plan()?.items || [];
    const count = (status: string) => items.filter((item) => item.status === status).length;
    return {
      all: items.length,
      pending: count('pending'),
      existing: count('duplicate'),
      likely: count('likely_duplicate'),
    };
  };
  const visibleItems = () =>
    (plan()?.items || []).filter(
      (item) =>
        filter() === 'all' ||
        (filter() === 'pending' && item.status === 'pending') ||
        (filter() === 'existing' && item.status === 'duplicate') ||
        (filter() === 'likely' && item.status === 'likely_duplicate'),
    );
  /** Where new files will land, grouped by destination folder. */
  const folders = () => {
    const groups = new Map<string, number>();
    for (const item of plan()?.items || []) {
      if (item.status !== 'pending') continue;
      const folder = item.relative_path.includes('/')
        ? item.relative_path.slice(0, item.relative_path.lastIndexOf('/'))
        : '（根目录）';
      groups.set(folder, (groups.get(folder) || 0) + 1);
    }
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  };
  const writeBlocked = () => !!plan()?.write_capability && plan()!.write_capability !== 'verified';
  const splitPath = (path: string) => {
    const index = path.lastIndexOf('/');
    return index < 0 ? ['', path] : [path.slice(0, index + 1), path.slice(index + 1)];
  };
  const step = () => (result() ? 3 : plan() ? 2 : 1);
  return (
    <section class="workspace-page import-workspace" aria-label="导入工作区">
      <header class="import-header">
        <div>
          <h1>导入</h1>
          <p>从存储卡或文件夹导入到图片库。原片始终保留在卡上，已有文件不会被覆盖。</p>
        </div>
        <ol class="import-stepper" aria-label="导入步骤">
          <li classList={{ current: step() === 1, done: step() > 1 }}>
            <span>1</span>选择
          </li>
          <li classList={{ current: step() === 2, done: step() > 2 }}>
            <span>2</span>审核
          </li>
          <li classList={{ current: step() === 3 }}>
            <span>3</span>完成
          </li>
        </ol>
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
      <div class="import-layout">
        <div class="import-main" aria-busy={!!busy()}>
          <Show when={!plan()}>
            <form class="import-setup" onSubmit={makePlan}>
              <div class="import-route">
                <section class="import-card" aria-labelledby="import-source-title">
                  <header class="import-card-head">
                    <span class="import-card-index">1</span>
                    <h2 id="import-source-title">从哪里导入</h2>
                    <div class="import-card-tools">
                      <label class="import-mini-check">
                        <input
                          type="checkbox"
                          checked={showAll()}
                          onChange={(e) => setShowAll(e.currentTarget.checked)}
                        />
                        所有卷
                      </label>
                      <button
                        type="button"
                        class="icon-button"
                        onClick={() => {
                          void refreshVolumes();
                          void refreshHistory();
                        }}
                        disabled={!!busy() || !desktop}
                        aria-label="刷新设备"
                        title="刷新设备"
                      >
                        <Icon name="refresh" size={16} />
                      </button>
                    </div>
                  </header>
                  <Show when={volumeError()}>
                    <p class="field-note">设备检测未完成：{volumeError()}。仍可手动选择文件夹。</p>
                  </Show>
                  <div class="source-tiles">
                    <For each={shownVolumes()}>
                      {(volume) => (
                        <button
                          type="button"
                          class="source-tile"
                          classList={{ selected: source() === volume.path }}
                          aria-pressed={source() === volume.path}
                          onClick={() => void identify(volume)}
                          disabled={!!busy()}
                        >
                          <span class="source-tile-icon">
                            <Icon name={volume.removable ? 'card' : 'folder'} size={20} />
                          </span>
                          <span class="source-tile-text">
                            <strong>{volume.name || volume.path}</strong>
                            <small>
                              {volume.available_bytes != null
                                ? `${bytes(volume.available_bytes)} 可用`
                                : volume.removable
                                  ? '可移动卷'
                                  : volume.kind}
                            </small>
                          </span>
                          <Show when={source() === volume.path}>
                            <Icon name="check" size={16} class="source-tile-check" />
                          </Show>
                        </button>
                      )}
                    </For>
                    <button
                      type="button"
                      class="source-tile other"
                      classList={{ selected: !!source() && !selectedVolume() }}
                      onClick={chooseSource}
                      disabled={!!busy() || !desktop}
                    >
                      <span class="source-tile-icon">
                        <Icon name="plus" size={20} />
                      </span>
                      <span class="source-tile-text">
                        <strong>其他文件夹…</strong>
                        <small>DCIM、读卡器或任意目录</small>
                      </span>
                    </button>
                  </div>
                  <Show when={!shownVolumes().length && desktop}>
                    <p class="field-note">未检测到存储卡。插卡后点刷新，或选择其他文件夹。</p>
                  </Show>
                  <label class="import-path">
                    <span>来源路径</span>
                    <input
                      value={source()}
                      onInput={(e) => {
                        setSource(e.currentTarget.value);
                        setIdentified(undefined);
                      }}
                      placeholder="/Volumes/NIKON 或 E:\"
                      required
                      disabled={!!busy()}
                    />
                  </label>
                  <Show when={identified()}>
                    <div class="card-identity" classList={{ known: !!knownCard() }} role="status">
                      <Show
                        when={knownCard()}
                        fallback={
                          <>
                            <div class="card-identity-head">
                              <Icon name="card" size={18} />
                              <div>
                                <strong>未登记的存储卡</strong>
                                <p>
                                  登记后会在卡根目录写入一个很小的识别文件
                                  .nebulume/volume.json，用来记住名称和默认方案。照片不会被改动。
                                </p>
                              </div>
                            </div>
                            <div class="card-identity-row">
                              <label>
                                <span>卡名称</span>
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
                              <div class="card-identity-row">
                                <label>
                                  <span>
                                    {candidates().length
                                      ? '可能是已登记的卡（格式化会丢失识别文件）'
                                      : '或绑定到已有记录'}
                                  </span>
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
                                          {candidates().some((item) => item.id === card.id)
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
                          <div class="card-identity-head">
                            <Icon name="card" size={18} />
                            <div>
                              <strong>{card().name}</strong>
                              <p>
                                {card().last_import_at
                                  ? `上次导入 ${displayDate(card().last_import_at!)}`
                                  : '尚未从这张卡导入'}
                                <Show when={card().default_preset_id}>
                                  {' · 默认方案 '}
                                  {presets().find((item) => item.id === card().default_preset_id)
                                    ?.name || ''}
                                </Show>
                              </p>
                            </div>
                          </div>
                        )}
                      </Show>
                    </div>
                  </Show>
                </section>
                <div class="import-route-arrow" aria-hidden="true">
                  <Icon name="right" size={20} />
                </div>
                <section class="import-card" aria-labelledby="import-target-title">
                  <header class="import-card-head">
                    <span class="import-card-index">2</span>
                    <h2 id="import-target-title">导入到</h2>
                  </header>
                  <label class="import-field">
                    <span>目标图片库</span>
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
                  <Show
                    when={selectedTarget()}
                    fallback={
                      <div class="target-empty">
                        <p>还没有可导入的图片库。</p>
                        <button class="button" type="button" onClick={props.onCreateLibrary}>
                          建立图片库
                        </button>
                      </div>
                    }
                  >
                    {(library) => (
                      <div class="target-summary">
                        <span class="target-summary-icon">
                          <Icon name={isRemoteLibrary(library()) ? 'cloud' : 'folder'} size={22} />
                        </span>
                        <div class="target-summary-text">
                          <strong>{library().name}</strong>
                          <small title={libraryLocation(library())}>
                            {libraryLocation(library())}
                          </small>
                          <div class="target-badges">
                            <span class="import-badge">{sourceKind(library().source_kind)}</span>
                            <span
                              class="import-badge"
                              classList={{
                                good: library().availability === 'online',
                                bad: !availabilityPresentation(library()).usable,
                              }}
                            >
                              {availabilityPresentation(library()).label}
                            </span>
                            <Show when={isRemoteLibrary(library())}>
                              <span
                                class="import-badge"
                                classList={{
                                  good: locationOf(library())?.write_capability === 'verified',
                                  bad: locationOf(library())?.write_capability === 'unsupported',
                                  warn:
                                    !locationOf(library())?.write_capability ||
                                    locationOf(library())?.write_capability === 'unverified',
                                }}
                              >
                                {locationOf(library())?.write_capability === 'verified'
                                  ? '可写入'
                                  : locationOf(library())?.write_capability === 'unsupported'
                                    ? '不可写入'
                                    : '需测试写入'}
                              </span>
                            </Show>
                          </div>
                        </div>
                      </div>
                    )}
                  </Show>
                  <Show
                    when={
                      isRemoteLibrary(selectedTarget()) &&
                      locationOf(selectedTarget())?.write_capability !== 'verified' &&
                      props.onOpenLocations
                    }
                  >
                    <p class="field-note target-hint">
                      导入到网络位置前，需要先在“位置”中测试写入。
                      <button type="button" class="link-button" onClick={props.onOpenLocations}>
                        去测试写入
                      </button>
                    </p>
                  </Show>
                  <label class="import-switch">
                    <input
                      type="checkbox"
                      checked={deduplicate()}
                      onChange={(e) => setDeduplicate(e.currentTarget.checked)}
                      disabled={!!busy()}
                    />
                    <span>
                      跳过图片库里已有的照片
                      <small>按文件内容判断，同名不同内容会另存</small>
                    </span>
                  </label>
                </section>
              </div>
              <section class="import-card organize" aria-labelledby="import-organize-title">
                <header class="import-card-head">
                  <span class="import-card-index">3</span>
                  <h2 id="import-organize-title">怎么整理</h2>
                  <div class="import-card-tools preset-tools">
                    <label class="import-inline-field">
                      <span>导入方案</span>
                      <select
                        value={presetId()}
                        onChange={(e) =>
                          e.currentTarget.value
                            ? applyPreset(e.currentTarget.value)
                            : setPresetId('')
                        }
                        disabled={!!busy()}
                      >
                        <option value="">手动设置</option>
                        <For each={presets()}>
                          {(preset) => <option value={preset.id}>{preset.name}</option>}
                        </For>
                      </select>
                    </label>
                    <Show when={knownCard()}>
                      <button
                        class="button small"
                        type="button"
                        disabled={
                          !!busy() || knownCard()!.default_preset_id === (presetId() || null)
                        }
                        onClick={() => void setCardDefault()}
                      >
                        {presetId() ? '设为这张卡的默认方案' : '清除这张卡的默认方案'}
                      </button>
                    </Show>
                  </div>
                </header>
                <div class="organize-preview">
                  <span>导入后的位置示例</span>
                  <code class="organize-example">
                    <For each={organizeExample(rules()).split('/')}>
                      {(part, index) => (
                        <>
                          <Show when={index() > 0}>
                            <i>/</i>
                          </Show>
                          <b
                            classList={{
                              file: index() === organizeExample(rules()).split('/').length - 1,
                            }}
                          >
                            {part}
                          </b>
                        </>
                      )}
                    </For>
                  </code>
                  <small>
                    <Show
                      when={rules().date_basis === 'capture' && rules().unknown_date === 'folder'}
                    >
                      没有拍摄时间的文件放入 unknown-date。
                    </Show>
                    <Show when={rules().date_basis === 'import'}>导入日在生成计划时确定。</Show>
                    文件名不会改变。
                  </small>
                </div>
                <fieldset class="organize-grid" disabled={!!busy()}>
                  <div class="organize-field wide">
                    <span id="date-basis-label">分类依据</span>
                    <div class="segmented" role="radiogroup" aria-labelledby="date-basis-label">
                      <For each={['capture', 'import', 'preserve', 'none'] as const}>
                        {(basis) => (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={rules().date_basis === basis}
                            classList={{ active: rules().date_basis === basis }}
                            onClick={() => updateRules({ date_basis: basis })}
                          >
                            {basisName(basis)}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                  <Show when={rules().date_basis === 'capture' || rules().date_basis === 'import'}>
                    <label class="organize-field">
                      <span>日期层级</span>
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
                  <label class="organize-field">
                    <span>子目录（可选）</span>
                    <input
                      value={rules().subfolder}
                      onInput={(e) => updateRules({ subfolder: e.currentTarget.value.trim() })}
                      placeholder="例如 Camera/Z8"
                      aria-invalid={!!subfolderError(rules().subfolder)}
                    />
                  </label>
                  <label class="import-switch">
                    <input
                      type="checkbox"
                      checked={rules().type_split === 'by_kind'}
                      onChange={(e) =>
                        updateRules({ type_split: e.currentTarget.checked ? 'by_kind' : 'none' })
                      }
                    />
                    <span>
                      按类型分目录
                      <small>RAW / JPG / TIFF / OTHER，XMP 跟随 RAW</small>
                    </span>
                  </label>
                  <Show when={rules().date_basis === 'capture'}>
                    <label class="import-switch">
                      <input
                        type="checkbox"
                        checked={rules().unknown_date === 'modified_time'}
                        onChange={(e) =>
                          updateRules({
                            unknown_date: e.currentTarget.checked ? 'modified_time' : 'folder',
                          })
                        }
                      />
                      <span>
                        无拍摄时间时用修改日期
                        <small>计划中逐项标注，默认关闭</small>
                      </span>
                    </label>
                  </Show>
                </fieldset>
                <Show when={subfolderError(rules().subfolder)}>
                  <p class="form-error">{subfolderError(rules().subfolder)}</p>
                </Show>
                <details class="preset-save">
                  <summary>保存为导入方案…</summary>
                  <div class="card-identity-row">
                    <label>
                      <span>方案名称</span>
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
                  <p class="field-note">方案记住目标图片库、整理方式和去重选项；同名会覆盖。</p>
                </details>
              </section>
              <footer class="import-actionbar">
                <div class="import-actionbar-summary">
                  <Show
                    when={busy()}
                    fallback={
                      <>
                        <strong>{sourceLabel() || '选择来源'}</strong>
                        <Icon name="right" size={14} />
                        <strong>{selectedTarget()?.name || '选择图片库'}</strong>
                        <span>· {basisName(rules().date_basis)}</span>
                      </>
                    }
                  >
                    <span class="import-busy" role="status">
                      {busy()}
                    </span>
                  </Show>
                </div>
                <button
                  class="button primary"
                  disabled={
                    !!busy() || !desktop || !targetId() || !!subfolderError(rules().subfolder)
                  }
                >
                  生成导入计划
                </button>
              </footer>
            </form>
          </Show>
          <Show when={plan() && !result()}>
            <section class="import-review" aria-label="导入计划">
              <div class="review-route">
                <div>
                  <span>来源</span>
                  <strong>{sourceLabel() || plan()!.source}</strong>
                  <small title={plan()!.source}>{plan()!.source}</small>
                </div>
                <Icon name="right" size={18} />
                <div>
                  <span>目标</span>
                  <strong>{plannedTarget()?.name}</strong>
                  <small>{plannedTarget() ? libraryLocation(plannedTarget()!) : ''}</small>
                </div>
              </div>
              <div class="review-stats">
                <div class="review-stat primary">
                  <strong>{counts().pending}</strong>
                  <span>待导入 · {bytes(plan()!.total_bytes)}</span>
                </div>
                <div class="review-stat">
                  <strong>{counts().existing}</strong>
                  <span>已在库中，跳过</span>
                </div>
                <Show when={counts().likely}>
                  <div class="review-stat warn">
                    <strong>{counts().likely}</strong>
                    <span>疑似重复 · 未校验</span>
                  </div>
                </Show>
                <div class="review-stat">
                  <strong>{counts().all}</strong>
                  <span>卡上照片</span>
                </div>
              </div>
              <Show when={writeBlocked()}>
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
              <For each={plan()!.warnings || []}>
                {(warning) => <p class="review-warning">{warning}</p>}
              </For>
              <Show when={counts().likely}>
                <label class="import-switch likely">
                  <input
                    type="checkbox"
                    checked={includeLikely()}
                    onChange={(e) => setIncludeLikely(e.currentTarget.checked)}
                    disabled={!!busy()}
                  />
                  <span>
                    仍然导入疑似重复项
                    <small>
                      文件名、大小与拍摄日期相同，但内容未经校验。可在图片库中建立内容指纹以严格判重。
                    </small>
                  </span>
                </label>
              </Show>
              <Show when={folders().length}>
                <div class="review-folders">
                  <span>新文件将放入</span>
                  <For each={folders().slice(0, 6)}>
                    {([folder, count]) => (
                      <code>
                        {folder}
                        <b>{count}</b>
                      </code>
                    )}
                  </For>
                  <Show when={folders().length > 6}>
                    <small>等 {folders().length} 个文件夹</small>
                  </Show>
                </div>
              </Show>
              <div class="review-files">
                <div class="review-tabs" role="tablist" aria-label="按状态筛选">
                  <For each={tabs()}>
                    {([value, label]) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={filter() === value}
                        classList={{ active: filter() === value }}
                        onClick={() => setFilter(value)}
                      >
                        {label}
                      </button>
                    )}
                  </For>
                </div>
                <div class="review-list">
                  <For
                    each={visibleItems().slice(0, 200)}
                    fallback={<p class="review-empty">没有符合条件的文件。</p>}
                  >
                    {(item) => (
                      <div class={`review-row status-${item.status}`}>
                        <span class="review-path" title={item.source}>
                          <small>{splitPath(item.relative_path)[0]}</small>
                          {splitPath(item.relative_path)[1]}
                          <Show
                            when={
                              item.date_source === 'modified_time' || item.date_source === 'unknown'
                            }
                          >
                            <em class={`date-source ${item.date_source}`}>
                              {dateSourceName(item.date_source)}
                            </em>
                          </Show>
                        </span>
                        <span class="review-size">{bytes(item.size)}</span>
                        <span class={`review-pill ${item.status}`}>{statusName(item.status)}</span>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={visibleItems().length > 200}>
                  <p class="field-note">显示前 200 项，共 {visibleItems().length} 项。</p>
                </Show>
              </div>
              <footer class="import-actionbar">
                <label class="import-mini-check confirm">
                  <input
                    type="checkbox"
                    checked={reviewed()}
                    onChange={(e) => setReviewed(e.currentTarget.checked)}
                    disabled={!!busy()}
                  />
                  我已核对来源、目标和导入计划
                </label>
                <Show when={busy()}>
                  <span class="import-busy" role="status">
                    {busy()}
                  </span>
                </Show>
                <div class="import-actionbar-buttons">
                  <button class="button" onClick={reset} disabled={!!busy()}>
                    返回修改
                  </button>
                  <button
                    class="button primary"
                    onClick={run}
                    disabled={
                      !!busy() ||
                      !reviewed() ||
                      (!counts().pending && !(includeLikely() && counts().likely)) ||
                      writeBlocked()
                    }
                  >
                    开始导入
                  </button>
                </div>
              </footer>
            </section>
          </Show>
          <Show when={result()}>
            <section
              class="import-result"
              classList={{ 'has-issues': result()!.status !== 'completed' }}
              aria-label="导入结果"
            >
              <div class="import-result-hero">
                <span class="import-result-icon">
                  <Icon name={result()!.failed ? 'info' : 'check'} size={28} />
                </span>
                <div>
                  <h2>{statusName(result()!.status)}</h2>
                  <p>
                    已导入 {result()!.copied} 个文件到 {plannedTarget()?.name}
                    {result()!.duplicates ? `，跳过 ${result()!.duplicates} 个已有文件` : ''}
                    {result()!.failed ? `，${result()!.failed} 个失败` : ''}。卡上原片已保留。
                  </p>
                  <Show when={scanMessage()}>
                    <p class="import-result-note" role="status">
                      {scanMessage()}
                    </p>
                  </Show>
                </div>
              </div>
              <div class="review-stats">
                <div class="review-stat primary">
                  <strong>{result()!.copied}</strong>
                  <span>已导入</span>
                </div>
                <div class="review-stat">
                  <strong>{result()!.duplicates}</strong>
                  <span>已跳过</span>
                </div>
                <div class="review-stat" classList={{ bad: !!result()!.failed }}>
                  <strong>{result()!.failed}</strong>
                  <span>失败</span>
                </div>
              </div>
              <Show when={result()!.items.some((item) => item.status === 'failed')}>
                <div class="review-list failures">
                  <For each={result()!.items.filter((item) => item.status === 'failed')}>
                    {(item) => (
                      <div class="review-row status-failed">
                        <span class="review-path">
                          {item.destination}
                          <small class="result-file-error">{item.error}</small>
                        </span>
                        <span class="review-size">{bytes(item.size)}</span>
                        <span class="review-pill failed">{statusName(item.status)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <footer class="import-actionbar">
                <div class="import-actionbar-summary" />
                <div class="import-actionbar-buttons">
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
                      <Icon name="star" size={15} />
                      开始选图（{result()!.batch!.asset_count} 张）
                    </button>
                  </Show>
                </div>
              </footer>
            </section>
          </Show>
        </div>
        <aside class="import-history" aria-label="导入历史">
          <header>
            <h2>导入历史</h2>
            <Show when={historyJobs().length > 0}>
              <span>{historyJobs().length}</span>
            </Show>
          </header>
          <For
            each={historyJobs()}
            fallback={
              <div class="import-history-empty">
                <Icon name="clock" size={22} />
                <p>{result() ? '暂无其他导入记录' : '暂无导入记录'}</p>
              </div>
            }
          >
            {(job) => (
              <details class={`import-history-item ${job.status}`}>
                <summary>
                  <i aria-hidden="true" />
                  <span>
                    <strong>{statusName(job.status)}</strong>
                    <small>{displayDate(job.started_at)}</small>
                  </span>
                  <em>
                    {job.copied}
                    <small> 张</small>
                  </em>
                </summary>
                <p>
                  复制 {job.copied} · 重复 {job.duplicates} · 失败 {job.failed}
                </p>
                <p class="history-destination">{job.destination}</p>
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
