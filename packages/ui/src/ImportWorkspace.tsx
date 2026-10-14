import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { chooseDirectory, desktop, execute, listVolumes } from './api';
import {
  bytes,
  errorMessage,
  type ImportPlan,
  type ImportResult,
  type Library,
  type ScanResult,
  type Volume,
} from './model';
import { displayDate, localLibraries } from './workspace';
import Icon from './Icon';

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
  const [layout, setLayout] = createSignal('date');
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
        layout: layout(),
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
    setBusy('正在安全复制并验证…');
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
            `目标图片库已更新：索引 ${scan.indexed} 项，跳过 ${scan.skipped} 项${scan.errors.length ? `，${scan.errors.length} 项异常` : ''}。`,
          );
          if (scan.errors.length)
            setError(
              scan.errors
                .slice(0, 3)
                .map((item) => `${item.path}：${item.message}`)
                .join('\n'),
            );
        } catch (e) {
          setError(`文件导入已返回结果，但目标图片库索引未完成：${errorMessage(e)}`);
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
          <p>从存储卡或文件夹导入到本地图片库，完成后自动更新索引。</p>
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
        <section class="import-task-panel">
          <div class="work-panel-heading">
            <h2>导入照片</h2>
            <span>{busy() || '原始文件始终保留'}</span>
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
                      onClick={() => setSource(volume.path)}
                    >
                      <Icon name="card" size={20} />
                      <div>
                        <strong>{volume.name || volume.path}</strong>
                        <span>{volume.path}</span>
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
              <div class="form-row">
                <label>
                  目录组织
                  <select
                    value={layout()}
                    onChange={(e) => setLayout(e.currentTarget.value)}
                    disabled={!!busy()}
                  >
                    <option value="date">按拍摄日期归档</option>
                    <option value="preserve">保留来源目录结构</option>
                  </select>
                </label>
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
              <p class="field-note">
                日期归档使用 EXIF 拍摄日期；缺少日期的文件进入
                unknown-date。导入不会删除来源或覆盖已有文件。
              </p>
              <div class="workspace-form-actions">
                <button class="button primary" disabled={!!busy() || !desktop || !targetId()}>
                  {busy() || '生成导入计划'}
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
                      <span title={item.source}>{item.relative_path}</span>
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
                  {busy() || '开始安全导入'}
                </button>
              </div>
            </div>
          </Show>
          <Show when={result()}>
            <div class="inline-import-content">
              <div class="import-completion">
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
            <span>{history().length} 个任务</span>
          </div>
          <For
            each={history()}
            fallback={
              <div class="compact-empty">
                <Icon name="clock" size={25} />
                <p>完成一次导入后，任务与逐文件结果会保存在这里。</p>
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
