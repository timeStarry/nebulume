import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { chooseDirectory, desktop, execute, listVolumes } from './api';
import {
  bytes,
  errorMessage,
  type ImportPlan,
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
  localLibraries,
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
  const [plan, setPlan] = createSignal<ImportPlan>();
  const [plannedTarget, setPlannedTarget] = createSignal<Library>();
  const [reviewed, setReviewed] = createSignal(false);
  const [result, setResult] = createSignal<ImportResult>();
  const [history, setHistory] = createSignal<ImportResult[]>([]);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [scanMessage, setScanMessage] = createSignal('');
  let initialized = false;
  const targets = () => localLibraries(props.libraries);
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
      const next = await execute<ImportPlan>('import.plan', {
        source: source().trim(),
        destination: target.root,
        rules: rules(),
        deduplicate: deduplicate(),
      });
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
      });
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
        copied: '已复制',
        failed: '失败',
        completed: '已完成',
        partial: '部分完成',
        interrupted: '已中断',
      }) as Record<string, string>
    )[status] || status;
  return (
    <section class="workspace-page import-workspace" aria-label="存储卡工作区">
      <header class="workspace-heading">
        <div>
          <h1>存储卡</h1>
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
                      onClick={() => setSource(volume.path)}
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
                    onInput={(e) => setSource(e.currentTarget.value)}
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
                    选择本地图片库
                  </option>
                  <For each={targets()}>
                    {(library) => (
                      <option value={library.id}>
                        {library.name} — {library.root}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <Show when={!targets().length}>
                <p class="field-note">导入目标须为本地图片库。</p>
                <button class="button" type="button" onClick={props.onCreateLibrary}>
                  建立本地图片库
                </button>
              </Show>
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
              </div>
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
                  disabled={!!busy() || !reviewed() || !plan()!.items.length}
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
                  class="button primary"
                  disabled={!!busy()}
                  onClick={() => plannedTarget() && props.onOpenLibrary(plannedTarget()!)}
                >
                  查看目标图片库
                </button>
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
