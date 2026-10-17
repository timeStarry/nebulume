import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { chooseDirectory, desktop, execute } from './api';
import { ConfirmDialog, Modal } from './Dialogs';
import { bytes, errorMessage } from './model';
import {
  cacheBudgetError,
  cacheGiB,
  cacheMigrationActive,
  cacheMigrationOverage,
  cacheMigrationPercent,
  type CacheLocationCheck,
  type CacheMigration,
  type CacheMigrationPlan,
  type CachePolicy,
  type CachePruneOptions,
  type CachePruneResult,
  type CacheStats,
} from './cache-model';
import './cache-settings.css';

export default function CacheSettings() {
  const [stats, setStats] = createSignal<CacheStats>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [budget, setBudget] = createSignal('');
  const [days, setDays] = createSignal(30);
  const [preview, setPreview] = createSignal<CachePolicy['preview_policy']>('automatic');
  const [confirmPolicy, setConfirmPolicy] = createSignal(false);
  const [cleanOpen, setCleanOpen] = createSignal(false);
  const [cleanBusy, setCleanBusy] = createSignal(false);
  const [cleanError, setCleanError] = createSignal('');
  const [cleanResult, setCleanResult] = createSignal<CachePruneResult>();
  const [cleanOptions, setCleanOptions] = createSignal<CachePruneOptions>({
    originals: true,
    previews: false,
    temporary: true,
  });
  const [unpin, setUnpin] = createSignal<CacheStats['pinned'][number]>();
  const [locationOpen, setLocationOpen] = createSignal(false);
  const [locationCheck, setLocationCheck] = createSignal<CacheLocationCheck>();
  const [locationError, setLocationError] = createSignal('');
  const [planning, setPlanning] = createSignal(false);
  const [mode, setMode] = createSignal<'all' | 'pinned'>('all');
  const [plan, setPlan] = createSignal<CacheMigrationPlan>();
  const [authorized, setAuthorized] = createSignal(false);
  const [cancelOpen, setCancelOpen] = createSignal(false);
  const [pollError, setPollError] = createSignal('');
  let disposed = false;
  let statsRequest = 0;
  let planRequest = 0;
  let cleanRequest = 0;
  const migration = () => stats()?.migration;
  const migrating = () => cacheMigrationActive(migration());
  const cacheUnavailable = () => stats()?.location.state !== 'online';
  const locked = () => busy() || migrating();
  const budgetError = createMemo(() => (stats() ? cacheBudgetError(budget(), stats()!) : ''));
  const policyChanged = createMemo(() => {
    const current = stats()?.policy;
    return (
      !!current &&
      (Number(budget()) * cacheGiB !== current.budget_bytes ||
        days() !== (current.max_unused_days || 0) ||
        preview() !== current.preview_policy)
    );
  });
  const activeMigrationId = createMemo(() => (migrating() ? migration()!.id : null));
  function adopt(next: CacheStats, policy = true) {
    setStats(next);
    if (policy) {
      setBudget(String(next.policy.budget_bytes / cacheGiB));
      setDays(next.policy.max_unused_days || 0);
      setPreview(next.policy.preview_policy);
    }
  }
  async function refresh(policy = true) {
    if (!desktop) return;
    const request = ++statsRequest;
    setLoading(true);
    try {
      const next = await execute<CacheStats>('cache.stats');
      if (disposed || request !== statsRequest) return;
      adopt(next, policy);
      setError('');
    } catch (cause) {
      if (!disposed && request === statsRequest) setError(errorMessage(cause));
    } finally {
      if (!disposed && request === statsRequest) setLoading(false);
    }
  }
  onMount(() => void refresh());
  onCleanup(() => {
    disposed = true;
    statsRequest++;
    planRequest++;
    cleanRequest++;
  });
  createEffect(() => {
    const id = activeMigrationId();
    if (!id || !desktop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await execute<CacheMigration>('cache.migration.get', { id });
        if (cancelled || disposed || migration()?.id !== id) return;
        setPollError('');
        setStats((current) => (current ? { ...current, migration: next } : current));
        if (!cacheMigrationActive(next)) {
          await refresh();
          return;
        }
      } catch (cause) {
        if (cancelled || disposed) return;
        setPollError(errorMessage(cause));
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1200);
    }
    timer = setTimeout(() => void poll(), 600);
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
  });
  async function savePolicy() {
    const current = stats();
    if (!current || locked() || budgetError() || !policyChanged()) return;
    setBusy(true);
    setError('');
    try {
      await execute('cache.policy.set', {
        budget_bytes: Number(budget()) * cacheGiB,
        max_unused_days: days(),
        preview_policy: preview(),
      });
      await refresh();
      setNotice('缓存策略已保存。');
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  async function previewCleanup(options = cleanOptions()) {
    const request = ++cleanRequest;
    setCleanOptions(options);
    setCleanBusy(true);
    setCleanError('');
    setCleanResult(undefined);
    try {
      const result = await execute<CachePruneResult>('cache.prune', { ...options, dry_run: true });
      if (!disposed && request === cleanRequest) setCleanResult(result);
    } catch (cause) {
      if (!disposed && request === cleanRequest) setCleanError(errorMessage(cause));
    } finally {
      if (!disposed && request === cleanRequest) setCleanBusy(false);
    }
  }
  async function clean() {
    if (!cleanResult() || cleanBusy()) return;
    const result = await execute<CachePruneResult>('cache.prune', {
      ...cleanOptions(),
      dry_run: false,
    });
    await refresh();
    setNotice(
      `已清理 ${bytes(result.freed_bytes)}${result.skipped_bytes ? `，保留 ${bytes(result.skipped_bytes)} 受保护内容` : ''}。`,
    );
  }
  async function prepareLocation(path: string) {
    const request = ++planRequest;
    setLocationOpen(true);
    setPlanning(true);
    setLocationCheck(undefined);
    setLocationError('');
    setPlan(undefined);
    setAuthorized(false);
    try {
      const check = await execute<CacheLocationCheck>('cache.location.check', { path });
      if (disposed || request !== planRequest) return;
      setLocationCheck(check);
      if (check.valid) {
        const next = await execute<CacheMigrationPlan>('cache.migration.plan', {
          path: check.path,
          mode: mode(),
          allow_overage: false,
        });
        if (!disposed && request === planRequest) setPlan(next);
      }
    } catch (cause) {
      if (!disposed && request === planRequest) setLocationError(errorMessage(cause));
    } finally {
      if (!disposed && request === planRequest) setPlanning(false);
    }
  }
  async function chooseLocation() {
    if (!desktop || locked()) return;
    try {
      const path = await chooseDirectory('选择专用缓存文件夹');
      if (path && !disposed) {
        setMode('all');
        await prepareLocation(path);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function changeMigrationMode(next: 'all' | 'pinned') {
    const path = locationCheck()?.path;
    if (!path) return;
    setMode(next);
    await prepareLocation(path);
    if (!disposed && locationOpen())
      document
        .querySelector<HTMLInputElement>(`input[name="cache-migration-mode"][value="${next}"]`)
        ?.focus();
  }
  function closeLocation() {
    if (busy()) return;
    planRequest++;
    setLocationOpen(false);
    setPlanning(false);
  }
  async function startMigration() {
    const current = plan();
    if (
      !current?.can_start ||
      planning() ||
      busy() ||
      (cacheMigrationOverage(current) > 0 && !authorized())
    )
      return;
    setBusy(true);
    setLocationError('');
    try {
      const result = await execute<CacheMigration>('cache.migration.start', {
        plan_id: current.plan_id,
        allow_overage: true,
      });
      if (disposed) return;
      setStats((previous) => (previous ? { ...previous, migration: result } : previous));
      setLocationOpen(false);
      setNotice('缓存迁移已开始，可继续浏览图片库。');
      await refresh(false);
    } catch (cause) {
      if (!disposed) setLocationError(errorMessage(cause));
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  const knownSpace = (value: number | null | undefined) =>
    value == null ? '暂不可用' : bytes(value);
  return (
    <section class="cache-settings" aria-label="缓存设置">
      <div class="cache-section-heading">
        <h2>远端浏览与缓存</h2>
        <Show when={desktop}>
          <button class="button" onClick={() => void refresh()} disabled={loading() || busy()}>
            刷新缓存状态
          </button>
        </Show>
      </div>
      <Show
        when={desktop}
        fallback={<p class="cache-callout">缓存位置、容量和离线保留需在桌面应用中设置。</p>}
      >
        <Show when={loading() && !stats()}>
          <p role="status">正在读取缓存状态…</p>
        </Show>
        <Show when={error()}>
          <div class="form-error" role="alert">
            {error()}
            <button class="button" disabled={loading()} onClick={() => void refresh()}>
              重试
            </button>
          </div>
        </Show>
        <Show when={notice()}>
          <p class="cache-notice" role="status">
            {notice()}
          </p>
        </Show>
        <Show when={stats()}>
          {(current) => (
            <>
              <Show when={cacheUnavailable()}>
                <p class="cache-callout warning" role="status">
                  缓存盘离线，新下载已暂停。可继续查看已有索引；缓存位置保持不变。
                </p>
              </Show>
              <div class="cache-settings-grid">
                <div>
                  <section class="settings-panel cache-panel">
                    <h3>缓存总上限</h3>
                    <div class="cache-usage-number">
                      <strong>{bytes(current().usage.total_bytes)}</strong>
                      <span>/ {bytes(current().policy.budget_bytes)}</span>
                    </div>
                    <progress
                      aria-label="缓存使用量"
                      max={current().policy.budget_bytes}
                      value={Math.min(current().usage.total_bytes, current().policy.budget_bytes)}
                    />
                    <p class="cache-description">
                      所有缓存与离线固定共享此上限；空间不足时暂停新下载。
                    </p>
                    <div class="cache-capacity-control">
                      <label for="cache-budget">最大容量</label>
                      <div>
                        <input
                          id="cache-budget"
                          aria-label="缓存总上限，GiB"
                          aria-describedby="cache-budget-help"
                          aria-invalid={!!budgetError()}
                          type="number"
                          min="1"
                          max="1024"
                          step="1"
                          value={budget()}
                          onInput={(event) => setBudget(event.currentTarget.value)}
                          disabled={locked()}
                        />
                        <span>GiB</span>
                      </div>
                    </div>
                    <p
                      id="cache-budget-help"
                      classList={{ 'cache-field-error': !!budgetError() }}
                      role={budgetError() ? 'alert' : undefined}
                    >
                      {budgetError() ||
                        (migrating()
                          ? '迁移中暂不更改策略。'
                          : cacheUnavailable()
                            ? '离线时仅允许提高上限，降低需连接后核对。'
                            : '降低上限前将确认回收；离线固定与在用内容受保护。')}
                    </p>
                    <dl class="cache-breakdown">
                      <div>
                        <dt>原图（含离线固定）</dt>
                        <dd>{bytes(current().usage.originals_bytes)}</dd>
                      </div>
                      <div>
                        <dt>预览与缩略图</dt>
                        <dd>{bytes(current().usage.previews_bytes)}</dd>
                      </div>
                      <div>
                        <dt>临时下载</dt>
                        <dd>{bytes(current().usage.temporary_bytes)}</dd>
                      </div>
                      <div>
                        <dt>其中离线固定</dt>
                        <dd>{bytes(current().usage.pinned_bytes)}</dd>
                      </div>
                      <div>
                        <dt>下载预约</dt>
                        <dd>{bytes(current().usage.reserved_bytes)}</dd>
                      </div>
                      <Show when={current().usage.unmanaged_bytes > 0}>
                        <div>
                          <dt>待核对文件</dt>
                          <dd>{bytes(current().usage.unmanaged_bytes)}</dd>
                        </div>
                      </Show>
                    </dl>
                    <p class="cache-description">
                      在用 {bytes(current().usage.in_use_bytes)}，暂不清理。
                    </p>
                    <button
                      class="button"
                      disabled={locked() || cacheUnavailable()}
                      onClick={() => {
                        setCleanOpen(true);
                        void previewCleanup();
                      }}
                    >
                      清理缓存…
                    </button>
                  </section>
                  <section class="settings-panel cache-panel">
                    <div class="cache-section-heading">
                      <h3>缓存位置</h3>
                      <button
                        class="button"
                        disabled={locked()}
                        onClick={() => void chooseLocation()}
                      >
                        更改缓存位置…
                      </button>
                    </div>
                    <code class="cache-path">{current().location.path}</code>
                    <p class="cache-description">
                      {cacheUnavailable() ? '离线' : '可用'} · 可用空间{' '}
                      {knownSpace(current().location.available_bytes)}
                    </p>
                    <p class="cache-description">专用缓存目录，不与图片库或导入目标混用。</p>
                  </section>
                  <Show when={migration()}>
                    {(item) => (
                      <section class="settings-panel cache-panel" aria-label="缓存迁移状态">
                        <h3>
                          {
                            {
                              running: '正在迁移缓存',
                              completed: '缓存迁移完成',
                              cancelled: '缓存迁移已取消',
                              failed: '缓存迁移失败',
                              cleanup_pending: '旧缓存清理待完成',
                            }[item().status]
                          }
                        </h3>
                        <p class="cache-description">
                          <code>{item().from_path}</code> → <code>{item().to_path}</code>
                        </p>
                        <Show when={migrating()}>
                          <progress
                            aria-label="缓存迁移进度"
                            max="100"
                            value={cacheMigrationPercent(item())}
                          />
                          <p role="status">
                            {bytes(item().copied_bytes)} / {bytes(item().total_bytes)}
                          </p>
                        </Show>
                        <Show when={item().status === 'running'}>
                          <button
                            class="button"
                            disabled={busy()}
                            onClick={() => setCancelOpen(true)}
                          >
                            取消迁移…
                          </button>
                        </Show>
                        <Show when={item().status === 'failed' || item().status === 'cancelled'}>
                          <p class="cache-description">旧位置与配置保留。</p>
                        </Show>
                        <Show when={item().status === 'cleanup_pending'}>
                          <p class="cache-callout warning">
                            新位置已启用，旧缓存仍占空间，正在等待清理。
                          </p>
                        </Show>
                        <Show when={item().error}>
                          <p class="form-error" role="alert">
                            {item().error}
                          </p>
                        </Show>
                        <Show when={pollError()}>
                          <p class="form-error" role="alert">
                            状态读取失败：{pollError()}。将继续重试。
                          </p>
                        </Show>
                        <Show when={item().status === 'failed'}>
                          <button
                            class="button"
                            disabled={locked()}
                            onClick={() => void prepareLocation(item().to_path)}
                          >
                            重新检查并重试…
                          </button>
                        </Show>
                      </section>
                    )}
                  </Show>
                </div>
                <div>
                  <section class="settings-panel cache-panel">
                    <h3>浏览策略</h3>
                    <label class="cache-field">
                      <span>远端预览</span>
                      <select
                        value={preview()}
                        onChange={(event) =>
                          setPreview(event.currentTarget.value as CachePolicy['preview_policy'])
                        }
                        disabled={locked() || cacheUnavailable()}
                      >
                        <option value="automatic">智能按需（默认）</option>
                        <option value="manual">完整文件手动获取</option>
                      </select>
                    </label>
                    <label class="cache-field">
                      <span>普通原图自动回收</span>
                      <select
                        value={days()}
                        onChange={(event) => setDays(Number(event.currentTarget.value))}
                        disabled={locked() || cacheUnavailable()}
                      >
                        <option value="0">仅按容量上限</option>
                        <option value="30">30 天未使用</option>
                        <option value="60">60 天未使用</option>
                        <option value="90">90 天未使用</option>
                        <Show when={![0, 30, 60, 90].includes(days())}>
                          <option value={days()}>{days()} 天未使用</option>
                        </Show>
                      </select>
                    </label>
                    <details>
                      <summary>何时需要完整文件？</summary>
                      <p>
                        {preview() === 'manual'
                          ? '使用已有缓存浏览；需要完整文件时，由你手动获取。'
                          : '优先使用已有缩略图与远端预览。不支持 Range、没有可用预览或解码需要完整文件时，按需获取完整文件。'}
                        下载内容计入总上限。
                      </p>
                    </details>
                    <button
                      class="button primary"
                      disabled={locked() || !policyChanged() || !!budgetError()}
                      onClick={() => {
                        if (Number(budget()) * cacheGiB < current().policy.budget_bytes)
                          setConfirmPolicy(true);
                        else void savePolicy().catch(() => {});
                      }}
                    >
                      保存缓存策略
                    </button>
                  </section>
                  <section class="settings-panel cache-panel">
                    <h3>离线保留</h3>
                    <p class="cache-description">
                      计入总上限，不自动回收。移除图片库或存储源不会解除固定。
                    </p>
                    <Show
                      when={current().pinned.length}
                      fallback={<p class="cache-description">尚无离线固定的原图。</p>}
                    >
                      <ul class="cache-pinned-list">
                        <For each={current().pinned}>
                          {(item) => (
                            <li>
                              <div>
                                <strong>{item.name}</strong>
                                <span>{bytes(item.size)}</span>
                              </div>
                              <button
                                class="button"
                                disabled={locked() || cacheUnavailable()}
                                onClick={() => setUnpin(item)}
                                aria-label={`解除 ${item.name} 的离线保留`}
                              >
                                解除固定…
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </section>
                </div>
              </div>
            </>
          )}
        </Show>
      </Show>
      <Show when={confirmPolicy()}>
        <ConfirmDialog
          title="降低缓存总上限？"
          confirmLabel="应用上限"
          busyLabel="正在应用…"
          onClose={() => setConfirmPolicy(false)}
          onConfirm={savePolicy}
        >
          <p>
            将上限从 {bytes(stats()!.policy.budget_bytes)} 调整为{' '}
            {bytes(Number(budget()) * cacheGiB)}
            。空间不足时按最近使用时间回收普通缓存；离线固定与在用内容保留。
          </p>
          <p>远端原件、图片库登记、评级与配方不受影响。</p>
        </ConfirmDialog>
      </Show>
      <Show when={cleanOpen()}>
        <ConfirmDialog
          title="清理缓存"
          confirmLabel="清理所选缓存"
          busyLabel="正在清理…"
          blocked={cleanBusy() || !cleanResult() || !cleanResult()!.reclaimable_bytes}
          onClose={() => {
            setCleanOpen(false);
            cleanRequest++;
          }}
          onConfirm={clean}
        >
          <div class="cache-clean-options">
            <For
              each={
                [
                  ['originals', '可回收原图'],
                  ['previews', '预览与缩略图'],
                  ['temporary', '空闲临时下载'],
                ] as const
              }
            >
              {([key, label]) => (
                <label class="cache-checkbox">
                  <input
                    type="checkbox"
                    checked={cleanOptions()[key]}
                    disabled={cleanBusy()}
                    onChange={(event) =>
                      void previewCleanup({ ...cleanOptions(), [key]: event.currentTarget.checked })
                    }
                  />
                  <span>{label}</span>
                </label>
              )}
            </For>
          </div>
          <Show when={cleanBusy()}>
            <p role="status">正在核对可回收内容…</p>
          </Show>
          <Show when={cleanResult()}>
            {(result) => (
              <p>
                预计释放 <strong>{bytes(result().reclaimable_bytes)}</strong>；跳过{' '}
                {bytes(result().skipped_bytes)} 受保护内容。
              </p>
            )}
          </Show>
          <Show when={cleanError()}>
            <p class="form-error" role="alert">
              {cleanError()}
            </p>
            <button class="button" onClick={() => void previewCleanup()}>
              重新核对
            </button>
          </Show>
          <p>仅清理本机缓存；离线固定、在用文件与远端原件保留。</p>
        </ConfirmDialog>
      </Show>
      <Show when={unpin()}>
        {(item) => (
          <ConfirmDialog
            title="解除离线保留？"
            confirmLabel="解除固定"
            busyLabel="正在解除…"
            onClose={() => setUnpin(undefined)}
            onConfirm={async () => {
              await execute('asset.offline.set', { id: item().asset_id, pinned: false });
              await refresh();
              setNotice('已解除固定，文件可按缓存策略回收。');
            }}
          >
            <p>{item().name} 将进入可回收缓存。远端原件与图片库记录保留。</p>
          </ConfirmDialog>
        )}
      </Show>
      <Show when={cancelOpen()}>
        <ConfirmDialog
          title="取消缓存迁移？"
          confirmLabel="取消迁移"
          busyLabel="正在取消…"
          onClose={() => setCancelOpen(false)}
          onConfirm={async () => {
            const result = await execute<CacheMigration>('cache.migration.cancel', {
              id: migration()!.id,
            });
            setStats((current) => (current ? { ...current, migration: result } : current));
            await refresh();
          }}
        >
          <p>保留旧缓存位置与配置，释放本次迁移的临时空间。</p>
        </ConfirmDialog>
      </Show>
      <Show when={locationOpen()}>
        <Modal title="更改缓存位置" onClose={closeLocation} busy={busy()} wide>
          <div class="dialog-form cache-migration-review">
            <Show when={planning()}>
              <p role="status">正在检查目录与迁移空间…</p>
            </Show>
            <Show when={locationCheck()}>
              {(check) => (
                <>
                  <code class="cache-path">{check().path}</code>
                  <Show when={!check().valid}>
                    <p class="form-error" role="alert">
                      {check().reason || '此位置不能用于缓存。'}
                    </p>
                  </Show>
                </>
              )}
            </Show>
            <Show when={locationCheck()?.valid}>
              <fieldset disabled={planning() || busy()}>
                <legend>迁移内容</legend>
                <label class="cache-checkbox">
                  <input
                    type="radio"
                    name="cache-migration-mode"
                    value="all"
                    checked={mode() === 'all'}
                    onChange={() => {
                      void changeMigrationMode('all');
                    }}
                  />
                  <span>迁移全部缓存</span>
                </label>
                <label class="cache-checkbox">
                  <input
                    type="radio"
                    name="cache-migration-mode"
                    value="pinned"
                    checked={mode() === 'pinned'}
                    onChange={() => {
                      void changeMigrationMode('pinned');
                    }}
                  />
                  <span>仅保留离线内容，其余重建</span>
                </label>
              </fieldset>
            </Show>
            <Show when={plan()}>
              {(current) => (
                <>
                  <dl class="cache-migration-facts">
                    <div>
                      <dt>旧位置</dt>
                      <dd>{current().from_path}</dd>
                    </div>
                    <div>
                      <dt>新位置</dt>
                      <dd>{current().to_path}</dd>
                    </div>
                    <div>
                      <dt>需迁移</dt>
                      <dd>{bytes(current().bytes)}</dd>
                    </div>
                    <div>
                      <dt>临时额外空间</dt>
                      <dd>{bytes(current().extra_bytes)}</dd>
                    </div>
                    <div>
                      <dt>临时占用上界（含预约）</dt>
                      <dd>{bytes((stats()?.usage.total_bytes || 0) + current().extra_bytes)}</dd>
                    </div>
                    <div>
                      <dt>新位置可用</dt>
                      <dd>{knownSpace(current().available_bytes)}</dd>
                    </div>
                  </dl>
                  <Show when={!current().can_start}>
                    <p class="form-error" role="alert">
                      {current().reason || '目前无法开始迁移。'}
                    </p>
                  </Show>
                  <Show when={cacheMigrationOverage(current()) > 0}>
                    <label class="cache-authorization cache-checkbox">
                      <input
                        type="checkbox"
                        checked={authorized()}
                        disabled={busy()}
                        onChange={(event) => setAuthorized(event.currentTarget.checked)}
                      />
                      <span>
                        允许本次迁移临时超过总上限 {bytes(cacheMigrationOverage(current()))}
                        。双份仅在迁移期间保留，完成或取消后释放。
                      </span>
                    </label>
                  </Show>
                  <p class="cache-description">
                    校验完成才切换位置。失败保留旧配置；图片库登记、评级、配方与凭据不变。
                  </p>
                </>
              )}
            </Show>
            <Show when={locationError()}>
              <p class="form-error" role="alert">
                {locationError()}
              </p>
            </Show>
            <footer class="modal-footer">
              <button class="button" disabled={busy()} onClick={closeLocation}>
                取消
              </button>
              <button
                class="button"
                disabled={busy() || planning()}
                onClick={() => void chooseLocation()}
              >
                重新选择…
              </button>
              <button
                class="button primary"
                disabled={
                  busy() ||
                  planning() ||
                  !plan()?.can_start ||
                  (!!plan() && cacheMigrationOverage(plan()!) > 0 && !authorized())
                }
                onClick={() => void startMigration()}
              >
                开始迁移
              </button>
            </footer>
          </div>
        </Modal>
      </Show>
    </section>
  );
}
