import { For, Show, createEffect, createSignal, on, type JSX } from 'solid-js';
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
  renamePrefixError,
  sourceKind,
  subfolderError,
} from './workspace';
import {
  companionGroupKey,
  DualBackupSection,
  ImportLiveProgress,
  ImportPostActions,
  ImportSelectionBar,
  isSelectableImportItem,
  RenameRuleSection,
} from './import/ImportExtras';
import Icon from './Icon';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  Group,
  IconButton,
  ListRow,
  PageHeader,
  Segmented,
  Select,
  SplitPage,
  StatusDot,
  Steps,
  Switch,
  TextInput,
} from './ui';
import './import/import.css';

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
  const [backupEnabled, setBackupEnabled] = createSignal(false);
  const [backupPath, setBackupPath] = createSignal('');
  const [selectedSources, setSelectedSources] = createSignal<Set<string>>(new Set());
  const [cards, setCards] = createSignal<Card[]>([]);
  const [presets, setPresets] = createSignal<ImportPreset[]>([]);
  const [presetId, setPresetId] = createSignal('');
  const [presetName, setPresetName] = createSignal('');
  const [savingPreset, setSavingPreset] = createSignal(false);
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
        ...(backupEnabled() && backupPath().trim()
          ? { backup_destination: backupPath().trim() }
          : {}),
        rules: rules(),
        deduplicate: deduplicate(),
      });
      setIncludeLikely(false);
      setSelectedSources(
        new Set(next.items.filter((item) => item.status === 'pending').map((item) => item.source)),
      );
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
      const selectable = (plan()!.items || []).filter((item) =>
        isSelectableImportItem(item, includeLikely()),
      );
      const subset =
        selectedSources().size < selectable.length ? [...selectedSources()] : undefined;
      const completed = await execute<ImportResult>('import.execute', {
        plan_id: plan()!.id,
        library_id: plannedTarget()!.id,
        ...(knownCard() ? { card_id: knownCard()!.id } : {}),
        ...(includeLikely() ? { include_likely_duplicates: true } : {}),
        ...(subset ? { selected_sources: subset } : {}),
      });
      if (completed.batch_error) setError(`导入批次未记录：${completed.batch_error}`);
      setResult(completed);
      if (
        completed.status === 'completed' ||
        completed.status === 'partial' ||
        (completed.status === 'cancelled' && completed.copied > 0)
      ) {
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
        skipped: '未勾选跳过',
        copied: '已复制',
        failed: '失败',
        completed: '已完成',
        partial: '部分完成',
        cancelled: '已取消',
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
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const canPlan = () =>
    !busy() &&
    desktop &&
    !!targetId() &&
    !!source().trim() &&
    !subfolderError(rules().subfolder) &&
    !renamePrefixError(rules().rename_prefix) &&
    (!backupEnabled() || !!backupPath().trim());
  const canRun = () =>
    !busy() &&
    reviewed() &&
    selectedSources().size > 0 &&
    !writeBlocked();
  function toggleSourceItem(sourcePath: string, checked: boolean) {
    const group = companionGroupKey(sourcePath);
    const next = new Set(selectedSources());
    for (const item of plan()?.items || []) {
      if (!isSelectableImportItem(item, includeLikely())) continue;
      if (companionGroupKey(item.source) !== group) continue;
      if (checked) next.add(item.source);
      else next.delete(item.source);
    }
    setSelectedSources(next);
  }
  function updateIncludeLikely(checked: boolean) {
    setIncludeLikely(checked);
    const next = new Set(selectedSources());
    for (const item of plan()?.items || []) {
      if (item.status !== 'likely_duplicate') continue;
      if (checked) next.add(item.source);
      else next.delete(item.source);
    }
    setSelectedSources(next);
  }
  const removableVolumePath = () => {
    const raw = (plan()?.source || source()).trim();
    if (!raw) return undefined;
    return volumes().find(
      (v) => v.removable && (raw === v.path || raw.startsWith(`${v.path}/`)),
    )?.path;
  };
  const writeStatus = (library?: Library) => locationOf(library)?.write_capability;
  const dateLayouts: { value: NonNullable<OrganizeRules['date_layout']>; label: string }[] = [
    { value: 'Y-M-D', label: '2026-10-22' },
    { value: 'Y/Y-M-D', label: '2026 / 2026-10-22' },
    { value: 'Y/M/Y-M-D', label: '2026 / 10 / 2026-10-22' },
    { value: 'Y/M/D', label: '2026 / 10 / 22' },
  ];
  const Example = () => (
    <code class="organize-example import-example">
      <For each={organizeExample(rules()).split('/')}>
        {(part, index) => (
          <>
            <Show when={index() > 0}>
              <i>/</i>
            </Show>
            <b classList={{ file: index() === organizeExample(rules()).split('/').length - 1 }}>
              {part}
            </b>
          </>
        )}
      </For>
    </code>
  );
  const Summary = (summaryProps: { rows: [string, JSX.Element][] }) => (
    <dl class="import-summary">
      <For each={summaryProps.rows}>
        {([label, value]) => (
          <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
  return (
    <section class="import-workspace" aria-label="导入工作区">
      <PageHeader
        title="导入"
        center={() => (
          <Steps label="导入步骤" steps={['设置', '核对', '完成']} current={step() - 1} />
        )}
        actions={
          <Button variant="ghost" icon="history" onClick={() => setHistoryOpen(true)}>
            历史
          </Button>
        }
      />
      <Show when={!desktop || error()}>
        <div class="import-banners">
          <Show when={!desktop}>
            <Banner
              tone="info"
              message="存储卡与持久导入任务需要桌面版。"
              detail="浏览器演示只支持选择单独图片进行查看。"
            />
          </Show>
          <Show when={error()}>
            <Banner tone="error" message={error()} onClose={() => setError('')} />
          </Show>
        </div>
      </Show>
      <Show when={!plan()}>
        <form class="import-form" onSubmit={makePlan} aria-busy={!!busy()}>
          <SplitPage
            asideLabel="将会导入"
            main={
              <>
                <Group
                  title="从哪里导入"
                  action={
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="folder-open"
                        onClick={chooseSource}
                        disabled={!!busy() || !desktop}
                      >
                        其他文件夹…
                      </Button>
                      <IconButton
                        size="sm"
                        icon="refresh"
                        label="刷新设备"
                        disabled={!!busy() || !desktop}
                        onClick={() => {
                          void refreshVolumes();
                          void refreshHistory();
                        }}
                      />
                    </>
                  }
                  plain
                >
                  <div class="import-sources">
                    <For each={shownVolumes()}>
                      {(volume) => (
                        <button
                          type="button"
                          class="import-source source-tile"
                          aria-pressed={source() === volume.path}
                          onClick={() => void identify(volume)}
                          disabled={!!busy()}
                        >
                          <span class="import-source-top">
                            <Icon name={volume.removable ? 'sd' : 'device-laptop'} size={20} />
                            <b>{volume.name || volume.path}</b>
                            <Show when={source() === volume.path}>
                              <Icon name="check" size={16} />
                            </Show>
                          </span>
                          <span class="import-source-meta">
                            {volume.available_bytes != null
                              ? `${bytes(volume.available_bytes)} 可用`
                              : volume.removable
                                ? '可移动卷'
                                : volume.kind}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={volumeError()}>
                    <p class="import-note">设备检测未完成：{volumeError()}。仍可手动选择文件夹。</p>
                  </Show>
                  <Show when={!shownVolumes().length && desktop}>
                    <p class="import-note">未检测到存储卡。插卡后点刷新，或选择其他文件夹。</p>
                  </Show>
                  <div class="nl-list import-source-rows">
                    <ListRow
                      title="来源路径"
                      labelFor="import-source-path"
                      control={
                        <TextInput
                          id="import-source-path"
                          size="sm"
                          wrapClass="import-path-input"
                          value={source()}
                          onInput={(e) => {
                            setSource(e.currentTarget.value);
                            setIdentified(undefined);
                          }}
                          placeholder="/Volumes/NIKON 或 E:\"
                          required
                          disabled={!!busy()}
                        />
                      }
                    />
                    <ListRow
                      title="显示所有卷"
                      description="包括内置硬盘与网络卷"
                      control={
                        <Switch label="显示所有卷" checked={showAll()} onChange={setShowAll} />
                      }
                    />
                  </div>
                  <Show when={identified()}>
                    <div
                      class="nl-list card-identity"
                      classList={{ known: !!knownCard() }}
                      role="status"
                    >
                      <Show
                        when={knownCard()}
                        fallback={
                          <>
                            <ListRow
                              leading="sd"
                              title="未登记的存储卡"
                              description="登记后会在卡根目录写入一个很小的识别文件 .nebulume/volume.json，用来记住名称和默认方案。照片不会被改动。也可以不登记，直接按本次设置导入。"
                            />
                            <ListRow
                              title="卡名称"
                              labelFor="import-card-name"
                              control={
                                <>
                                  <TextInput
                                    id="import-card-name"
                                    size="sm"
                                    value={cardName()}
                                    onInput={(e) => setCardName(e.currentTarget.value)}
                                    disabled={!!busy()}
                                  />
                                  <Button
                                    size="sm"
                                    disabled={!!busy() || !cardName().trim()}
                                    onClick={() => void registerCard(false)}
                                  >
                                    登记这张卡
                                  </Button>
                                </>
                              }
                            />
                            <Show when={cards().length}>
                              <ListRow
                                title={
                                  candidates().length ? '可能是已登记的卡' : '或绑定到已有记录'
                                }
                                description={
                                  candidates().length ? '格式化会丢失识别文件' : undefined
                                }
                                control={
                                  <>
                                    <Select
                                      size="sm"
                                      aria-label="绑定到已登记的卡"
                                      value={bindId()}
                                      onChange={setBindId}
                                      disabled={!!busy()}
                                      options={[
                                        { value: '', label: '选择已登记的卡' },
                                        ...cards().map((card) => ({
                                          value: card.id,
                                          label: `${card.name}${candidates().some((item) => item.id === card.id) ? '（可能匹配）' : ''}`,
                                        })),
                                      ]}
                                    />
                                    <Button
                                      size="sm"
                                      disabled={!!busy() || !bindId()}
                                      onClick={() => void registerCard(true)}
                                    >
                                      绑定到此记录
                                    </Button>
                                  </>
                                }
                              />
                            </Show>
                          </>
                        }
                      >
                        {(card) => (
                          <ListRow
                            leading="sd"
                            title={card().name}
                            description={
                              <>
                                {card().last_import_at
                                  ? `上次导入 ${displayDate(card().last_import_at!)}`
                                  : '尚未从这张卡导入'}
                                <Show when={card().default_preset_id}>
                                  {' · 默认方案 '}
                                  {presets().find((item) => item.id === card().default_preset_id)
                                    ?.name || ''}
                                </Show>
                              </>
                            }
                          />
                        )}
                      </Show>
                    </div>
                  </Show>
                </Group>
                <Group title="导入到">
                  <ListRow
                    title="目标图片库"
                    labelFor="import-target"
                    description={
                      selectedTarget()
                        ? libraryLocation(selectedTarget()!)
                        : '还没有可导入的图片库。'
                    }
                    control={
                      <Show
                        when={targets().length}
                        fallback={
                          <Button size="sm" onClick={props.onCreateLibrary}>
                            新建图片库
                          </Button>
                        }
                      >
                        <Select
                          id="import-target"
                          aria-label="目标图片库"
                          value={targetId()}
                          onChange={setTargetId}
                          required
                          disabled={!!busy()}
                          wrapClass="import-target-select"
                          options={[
                            { value: '', label: '选择图片库', disabled: true },
                            ...targets().map((library) => ({
                              value: library.id,
                              label: `${library.name} — ${libraryLocation(library)}`,
                            })),
                          ]}
                        />
                      </Show>
                    }
                  />
                  <Show when={selectedTarget()}>
                    {(library) => (
                      <ListRow
                        title="位置"
                        description={sourceKind(library().source_kind)}
                        control={
                          <>
                            <StatusDot
                              showLabel
                              state={
                                library().availability === 'online'
                                  ? 'ok'
                                  : availabilityPresentation(library()).usable
                                    ? 'off'
                                    : 'bad'
                              }
                              label={availabilityPresentation(library()).label}
                            />
                            <Show when={isRemoteLibrary(library())}>
                              <Badge
                                tone={
                                  writeStatus(library()) === 'verified'
                                    ? 'pick'
                                    : writeStatus(library()) === 'unsupported'
                                      ? 'reject'
                                      : 'warn'
                                }
                              >
                                {writeStatus(library()) === 'verified'
                                  ? '可写入'
                                  : writeStatus(library()) === 'unsupported'
                                    ? '不可写入'
                                    : '需测试写入'}
                              </Badge>
                            </Show>
                          </>
                        }
                      />
                    )}
                  </Show>
                  <Show
                    when={
                      isRemoteLibrary(selectedTarget()) &&
                      writeStatus(selectedTarget()) !== 'verified' &&
                      props.onOpenLocations
                    }
                  >
                    <ListRow
                      title="写入测试"
                      description="导入到网络位置前，需要先在“位置”中测试写入。"
                      control={
                        <Button size="sm" onClick={props.onOpenLocations}>
                          去测试写入
                        </Button>
                      }
                    />
                  </Show>
                  <ListRow
                    title="跳过图片库里已有的照片"
                    description="按文件内容判断，同名不同内容会另存"
                    control={
                      <Switch
                        label="跳过图片库里已有的照片"
                        checked={deduplicate()}
                        onChange={setDeduplicate}
                        disabled={!!busy()}
                      />
                    }
                  />
                  <DualBackupSection
                    enabled={backupEnabled()}
                    path={backupPath()}
                    disabled={!!busy()}
                    onToggle={setBackupEnabled}
                    onPathChange={setBackupPath}
                  />
                </Group>
                <Group
                  title="怎么整理"
                  action={
                    <Select
                      size="sm"
                      aria-label="导入方案"
                      value={presetId()}
                      disabled={!!busy()}
                      onChange={(value) => {
                        if (value === '__save') {
                          setPresetName('');
                          setSavingPreset(true);
                        } else if (value === '__card') void setCardDefault();
                        else if (value) applyPreset(value);
                        else setPresetId('');
                      }}
                      options={[
                        { value: '', label: '手动设置' },
                        ...presets().map((preset) => ({ value: preset.id, label: preset.name })),
                        { value: '__save', label: '另存为方案…' },
                        ...(knownCard() && knownCard()!.default_preset_id !== (presetId() || null)
                          ? [
                              {
                                value: '__card',
                                label: presetId() ? '设为这张卡的默认方案' : '清除这张卡的默认方案',
                              },
                            ]
                          : []),
                      ]}
                    />
                  }
                >
                  <ListRow
                    title="分类依据"
                    control={
                      <Segmented
                        size="sm"
                        role="radiogroup"
                        label="分类依据"
                        value={rules().date_basis}
                        onChange={(basis) => updateRules({ date_basis: basis })}
                        options={(['capture', 'import', 'preserve', 'none'] as const).map(
                          (basis) => ({
                            value: basis,
                            label: basisName(basis),
                          }),
                        )}
                      />
                    }
                  />
                  <Show when={rules().date_basis === 'capture' || rules().date_basis === 'import'}>
                    <ListRow
                      title="日期层级"
                      description={
                        rules().date_basis === 'import' ? '导入日在生成计划时确定。' : undefined
                      }
                      control={
                        <Select
                          size="sm"
                          aria-label="日期层级"
                          value={rules().date_layout ?? 'Y-M-D'}
                          onChange={(value) =>
                            updateRules({ date_layout: value as OrganizeRules['date_layout'] })
                          }
                          options={dateLayouts}
                        />
                      }
                    />
                  </Show>
                  <Show when={rules().date_basis === 'capture'}>
                    <ListRow
                      title="无拍摄时间时用修改日期"
                      description="默认放进 unknown-date；打开后在计划中逐项标注"
                      control={
                        <Switch
                          label="无拍摄时间时用修改日期"
                          checked={rules().unknown_date === 'modified_time'}
                          onChange={(on) =>
                            updateRules({ unknown_date: on ? 'modified_time' : 'folder' })
                          }
                        />
                      }
                    />
                  </Show>
                  <ListRow
                    title="子目录"
                    labelFor="import-subfolder"
                    description={subfolderError(rules().subfolder) || '可选，例如 Camera/Z8'}
                    control={
                      <TextInput
                        id="import-subfolder"
                        size="sm"
                        aria-label="子目录（可选）"
                        value={rules().subfolder ?? ''}
                        onInput={(e) => updateRules({ subfolder: e.currentTarget.value.trim() })}
                        placeholder="例如 Camera/Z8"
                        invalid={!!subfolderError(rules().subfolder)}
                      />
                    }
                  />
                  <ListRow
                    title="按类型分目录"
                    description="RAW / JPG / TIFF / OTHER，XMP 跟随 RAW"
                    control={
                      <Switch
                        label="按类型分目录"
                        checked={rules().type_split === 'by_kind'}
                        onChange={(on) => updateRules({ type_split: on ? 'by_kind' : 'none' })}
                      />
                    }
                  />
                  <RenameRuleSection
                    rules={rules()}
                    disabled={!!busy()}
                    onChange={updateRules}
                  />
                </Group>
              </>
            }
            aside={
              <>
                <h3 class="import-aside-title">将会导入</h3>
                <Summary
                  rows={[
                    ['来源', sourceLabel() || '尚未选择'],
                    ['目标', selectedTarget()?.name || '尚未选择'],
                    ...(backupEnabled() && backupPath().trim()
                      ? ([['副盘备份', backupPath().trim()]] as [string, JSX.Element][])
                      : []),
                    ['整理', basisName(rules().date_basis)],
                  ]}
                />
                <div class="import-preview">
                  <span>导入后的位置示例</span>
                  <Example />
                  <small>
                    {(rules().rename_mode ?? 'keep') === 'keep'
                      ? '文件名不会改变。'
                      : '同组 RAW + JPEG + XMP 自动保持同号主文件名。'}
                  </small>
                </div>
              </>
            }
            asideFooter={
              <>
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  disabled={!canPlan()}
                  busy={!!busy()}
                >
                  生成导入计划
                </Button>
                <span class="import-foot-note" role="status">
                  {busy() || '下一步逐项列出，确认后才开始复制'}
                </span>
              </>
            }
          />
        </form>
      </Show>
      <Show when={plan() && !result()}>
        <SplitPage
          class="import-review"
          asideLabel="导入计划摘要"
          main={
            <section class="import-review-main" aria-label="导入计划">
              <Segmented
                size="sm"
                label="按状态筛选"
                value={filter()}
                onChange={setFilter}
                options={tabs().map(([value, label]) => ({ value, label }))}
              />
              <ImportSelectionBar
                items={plan()!.items}
                includeLikely={includeLikely()}
                selected={selectedSources()}
                disabled={!!busy()}
                onChange={setSelectedSources}
              />
              <DataTable
                label="导入文件"
                empty="没有符合条件的文件。"
                rows={visibleItems().slice(0, 200)}
                columns={[
                  {
                    key: 'pick',
                    label: '选择',
                    render: (item) =>
                      isSelectableImportItem(item, includeLikely()) ? (
                        <Checkbox
                          checked={selectedSources().has(item.source)}
                          disabled={!!busy()}
                          onChange={(checked) => toggleSourceItem(item.source, checked)}
                        >
                          <span class="visually-hidden">{item.relative_path}</span>
                        </Checkbox>
                      ) : null,
                  },
                  {
                    key: 'file',
                    label: '文件',
                    render: (item) => (
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
                    ),
                  },
                  { key: 'size', label: '大小', align: 'end', render: (item) => bytes(item.size) },
                  {
                    key: 'status',
                    label: '状态',
                    align: 'end',
                    render: (item) => (
                      <Badge
                        tone={
                          item.status === 'pending'
                            ? 'info'
                            : item.status === 'likely_duplicate'
                              ? 'warn'
                              : item.status === 'failed'
                                ? 'reject'
                                : 'neutral'
                        }
                      >
                        {statusName(item.status)}
                      </Badge>
                    ),
                  },
                ]}
              />
              <Show when={visibleItems().length > 200}>
                <p class="import-note">显示前 200 项，共 {visibleItems().length} 项。</p>
              </Show>
            </section>
          }
          aside={
            <>
              <h3 class="import-aside-title">导入计划</h3>
              <Summary
                rows={[
                  ['来源', sourceLabel() || plan()!.source],
                  ['目标', plannedTarget()?.name ?? ''],
                  ...(plan()!.backup_destination
                    ? ([['副盘备份', plan()!.backup_destination!]] as [string, JSX.Element][])
                    : []),
                  ['待导入', `${counts().pending} 张 · ${bytes(plan()!.total_bytes)}`],
                  ['本次已勾选', `${selectedSources().size} 项`],
                  ['已在库中，跳过', `${counts().existing} 张`],
                  ...(counts().likely
                    ? ([['疑似重复', `${counts().likely} 张 · 未校验`]] as [string, JSX.Element][])
                    : []),
                  ['卡上照片', `${counts().all} 张`],
                ]}
              />
              <Show when={folders().length}>
                <div class="import-preview">
                  <span>新文件将放入</span>
                  <For each={folders().slice(0, 6)}>
                    {([folder, count]) => (
                      <code class="import-folder">
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
              <Show when={writeBlocked()}>
                <Banner
                  tone="warn"
                  message={
                    plan()!.write_capability === 'unsupported'
                      ? '这个网络位置无法保证不覆盖已有文件，Nebulume 不会向它导入。'
                      : '导入前需要先在“位置”中对这个网络位置“测试写入”，确认它能安全地新建文件且不覆盖已有内容。'
                  }
                  action={
                    <Show when={props.onOpenLocations && plan()!.write_capability === 'unverified'}>
                      <Button size="sm" onClick={props.onOpenLocations}>
                        前往位置
                      </Button>
                    </Show>
                  }
                />
              </Show>
              <For each={plan()!.warnings || []}>
                {(warning) => <Banner tone="warn" message={warning} />}
              </For>
              <Show when={counts().likely}>
                <Checkbox
                  checked={includeLikely()}
                  onChange={updateIncludeLikely}
                  disabled={!!busy()}
                  help="文件名、大小与拍摄日期相同，但内容未经校验。可在图片库中建立内容指纹以严格判重。"
                >
                  仍然导入疑似重复项
                </Checkbox>
              </Show>
            </>
          }
          asideFooter={
            <>
              <ImportLiveProgress running={!!busy()} label={busy()} />
              <Checkbox checked={reviewed()} onChange={setReviewed} disabled={!!busy()}>
                我已核对来源、目标和导入计划
              </Checkbox>
              <Button variant="primary" size="lg" onClick={run} disabled={!canRun()}>
                开始导入
              </Button>
              <Button variant="ghost" onClick={reset} disabled={!!busy()}>
                返回修改
              </Button>
            </>
          }
        />
      </Show>
      <Show when={result()}>
        <SplitPage
          class="import-result"
          asideLabel="导入结果摘要"
          main={
            <section class="import-result-main" aria-label="导入结果">
              <EmptyState
                icon={result()!.failed ? 'alert-triangle' : 'circle-check'}
                title={statusName(result()!.status)}
                description={
                  <>
                    已导入 {result()!.copied} 个文件到 {plannedTarget()?.name}
                    {result()!.duplicates ? `，跳过 ${result()!.duplicates} 个已有文件` : ''}
                    {result()!.skipped_unselected
                      ? `，未勾选跳过 ${result()!.skipped_unselected} 个`
                      : ''}
                    {result()!.failed ? `，${result()!.failed} 个失败` : ''}。卡上原片已保留。
                  </>
                }
              />
              <ImportPostActions
                result={result()!}
                removableSource={removableVolumePath()}
                onEjected={() => void refreshVolumes()}
              />
              <Show when={scanMessage()}>
                <p class="import-result-note" role="status">
                  {scanMessage()}
                </p>
              </Show>
              <Show when={result()!.items.some((item) => item.status === 'failed')}>
                <DataTable
                  label="失败的文件"
                  rows={result()!.items.filter((item) => item.status === 'failed')}
                  columns={[
                    {
                      key: 'file',
                      label: '文件',
                      render: (item) => (
                        <span class="review-path">
                          {item.destination}
                          <small class="result-file-error">{item.error}</small>
                        </span>
                      ),
                    },
                    {
                      key: 'size',
                      label: '大小',
                      align: 'end',
                      render: (item) => bytes(item.size),
                    },
                  ]}
                />
              </Show>
            </section>
          }
          aside={
            <>
              <h3 class="import-aside-title">本次导入</h3>
              <Summary
                rows={[
                  ['已导入', `${result()!.copied}`],
                  ['已跳过', `${result()!.duplicates}`],
                  ['失败', `${result()!.failed}`],
                ]}
              />
            </>
          }
          asideFooter={
            <>
              <Show
                when={result()?.batch?.asset_count && props.onCull}
                fallback={
                  <Button
                    variant="primary"
                    size="lg"
                    disabled={!!busy()}
                    onClick={() => plannedTarget() && props.onOpenLibrary(plannedTarget()!)}
                  >
                    查看目标图片库
                  </Button>
                }
              >
                <Button
                  variant="primary"
                  size="lg"
                  icon="flag"
                  disabled={!!busy()}
                  onClick={() => props.onCull!(plannedTarget()!, result()!.batch!)}
                >
                  开始选图（{result()!.batch!.asset_count} 张）
                </Button>
                <Button
                  disabled={!!busy()}
                  onClick={() => plannedTarget() && props.onOpenLibrary(plannedTarget()!)}
                >
                  查看目标图片库
                </Button>
              </Show>
              <Button variant="ghost" disabled={!!busy()} onClick={reset}>
                继续导入
              </Button>
            </>
          }
        />
      </Show>
      <Show when={savingPreset()}>
        <Dialog
          title="另存为导入方案"
          onClose={() => setSavingPreset(false)}
          busy={!!busy()}
          footer={
            <>
              <Button variant="ghost" onClick={() => setSavingPreset(false)}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={
                  !!busy() ||
                  !presetName().trim() ||
                  !targetId() ||
                  !!subfolderError(rules().subfolder)
                }
                onClick={() => void savePreset().then(() => setSavingPreset(false))}
              >
                保存方案
              </Button>
            </>
          }
        >
          <Field label="方案名称" help="方案记住目标图片库、整理方式和去重选项；同名会覆盖。">
            {(id, describedBy) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={presetName()}
                onInput={(e) => setPresetName(e.currentTarget.value)}
                placeholder="例如 NAS 归档"
              />
            )}
          </Field>
        </Dialog>
      </Show>
      <Show when={historyOpen()}>
        <Drawer title="导入历史" onClose={() => setHistoryOpen(false)}>
          <For
            each={historyJobs()}
            fallback={
              <EmptyState icon="history" title={result() ? '暂无其他导入记录' : '暂无导入记录'} />
            }
          >
            {(job) => (
              <details class={`import-history-item ${job.status}`}>
                <summary>
                  <StatusDot
                    state={
                      job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn'
                    }
                    label={statusName(job.status)}
                  />
                  <span class="import-history-text">
                    <b>{statusName(job.status)}</b>
                    <small>{displayDate(job.started_at)}</small>
                  </span>
                  <span class="import-history-count">{job.copied} 张</span>
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
        </Drawer>
      </Show>
    </section>
  );
}
