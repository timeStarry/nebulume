import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { chooseDirectory, desktop, execute } from './api';
import { bytes, errorMessage } from './model';
import {
  cacheBudgetError, cacheGiB, cacheMigrationActive, cacheMigrationOverage,
  type CacheLocationCheck, type CacheMigration, type CacheMigrationPlan,
  type CachePolicy, type CacheStats,
} from './cache-model';
import { Banner, Button } from './ui';
import CacheOverviewGroup from './settings/CacheOverviewGroup';
import CachePolicyGroup from './settings/CachePolicyGroup';
import CacheDialogs from './settings/CacheDialogs';
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
  let disposed = false, statsReq = 0, planReq = 0;

  const migration = () => stats()?.migration;
  const migrating = () => cacheMigrationActive(migration());
  const cacheUnavailable = () => stats()?.location.state !== 'online';
  const locked = () => busy() || migrating();
  const budgetError = createMemo(() => (stats() ? cacheBudgetError(budget(), stats()!) : ''));
  const policyChanged = createMemo(() => {
    const cur = stats()?.policy;
    return !!cur && (
      Number(budget()) * cacheGiB !== cur.budget_bytes ||
      days() !== (cur.max_unused_days || 0) ||
      preview() !== cur.preview_policy
    );
  });

  function adopt(next: CacheStats, policy = true) {
    setStats(next);
    if (!policy) return;
    setBudget(String(next.policy.budget_bytes / cacheGiB));
    setDays(next.policy.max_unused_days || 0);
    setPreview(next.policy.preview_policy);
  }
  async function refresh(policy = true) {
    if (!desktop) return;
    const req = ++statsReq;
    setLoading(true);
    try {
      const next = await execute<CacheStats>('cache.stats');
      if (disposed || req !== statsReq) return;
      adopt(next, policy);
      setError('');
    } catch (cause) {
      if (!disposed && req === statsReq) setError(errorMessage(cause));
    } finally {
      if (!disposed && req === statsReq) setLoading(false);
    }
  }
  onMount(() => void refresh());
  onCleanup(() => { disposed = true; statsReq++; planReq++; });

  createEffect(() => {
    const id = migrating() ? migration()!.id : null;
    if (!id || !desktop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await execute<CacheMigration>('cache.migration.get', { id });
        if (cancelled || disposed || migration()?.id !== id) return;
        setPollError('');
        setStats((cur) => (cur ? { ...cur, migration: next } : cur));
        if (!cacheMigrationActive(next)) return void (await refresh());
      } catch (cause) {
        if (!cancelled && !disposed) setPollError(errorMessage(cause));
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1200);
    };
    timer = setTimeout(() => void poll(), 600);
    onCleanup(() => { cancelled = true; clearTimeout(timer); });
  });

  async function savePolicy() {
    if (!stats() || locked() || budgetError() || !policyChanged()) return;
    setBusy(true);
    setError('');
    try {
      await execute('cache.policy.set', {
        budget_bytes: Number(budget()) * cacheGiB, max_unused_days: days(), preview_policy: preview(),
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
  async function prepareLocation(path: string, nextMode = mode()) {
    const req = ++planReq;
    setLocationOpen(true); setPlanning(true);
    setLocationCheck(undefined); setLocationError(''); setPlan(undefined); setAuthorized(false);
    try {
      const check = await execute<CacheLocationCheck>('cache.location.check', { path });
      if (disposed || req !== planReq) return;
      setLocationCheck(check);
      if (check.valid) {
        const next = await execute<CacheMigrationPlan>('cache.migration.plan', {
          path: check.path, mode: nextMode, allow_overage: false,
        });
        if (!disposed && req === planReq) setPlan(next);
      }
    } catch (cause) {
      if (!disposed && req === planReq) setLocationError(errorMessage(cause));
    } finally {
      if (!disposed && req === planReq) setPlanning(false);
    }
  }
  async function chooseLocation() {
    if (!desktop || locked()) return;
    try {
      const path = await chooseDirectory('选择专用缓存文件夹');
      if (path && !disposed) { setMode('all'); await prepareLocation(path, 'all'); }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function startMigration() {
    const cur = plan();
    if (!cur?.can_start || planning() || busy() || (cacheMigrationOverage(cur) > 0 && !authorized())) return;
    setBusy(true); setLocationError('');
    try {
      const res = await execute<CacheMigration>('cache.migration.start', { plan_id: cur.plan_id, allow_overage: true });
      if (disposed) return;
      setStats((prev) => (prev ? { ...prev, migration: res } : prev));
      setLocationOpen(false);
      setNotice('缓存迁移已开始，可继续浏览图片库。');
      await refresh(false);
    } catch (cause) {
      if (!disposed) setLocationError(errorMessage(cause));
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  return (
    <section class="cache-settings" aria-label="缓存设置">
      <Show when={desktop} fallback={<Banner tone="info" role="note" message="缓存位置、容量和离线保留需在桌面应用中设置。" />}>
        <Show when={loading() && !stats()}><p class="cache-description" role="status">正在读取缓存状态…</p></Show>
        <Show when={error()}>
          <Banner tone="error" role="alert" message={error()}
            action={<Button size="sm" disabled={loading()} onClick={() => void refresh()}>重试</Button>} />
        </Show>
        <Show when={notice()}><Banner tone="info" role="status" message={notice()} /></Show>
        <Show when={stats()}>
          {(cur) => (
            <>
              <Show when={cacheUnavailable()}>
                <Banner tone="warn" role="status" message="缓存盘离线，新下载已暂停。可继续查看已有索引；缓存位置保持不变。" />
              </Show>
              <CacheOverviewGroup
                stats={cur()} loading={loading()} busy={busy()} locked={locked()}
                cacheUnavailable={cacheUnavailable()} migrating={migrating()} pollError={pollError()}
                onRefresh={() => void refresh()} onChooseLocation={() => void chooseLocation()}
                onOpenClean={() => setCleanOpen(true)} onOpenCancel={() => setCancelOpen(true)}
                onRetryMigration={(toPath) => void prepareLocation(toPath)}
              />
              <CachePolicyGroup
                budget={budget()} days={days()} preview={preview()} pinned={cur().pinned}
                budgetError={budgetError()} policyChanged={policyChanged()} locked={locked()}
                migrating={migrating()} cacheUnavailable={cacheUnavailable()}
                onBudgetChange={setBudget} onDaysChange={setDays} onPreviewChange={setPreview}
                onReset={() => adopt(cur(), true)} onUnpin={setUnpin}
                onSave={() => Number(budget()) * cacheGiB < cur().policy.budget_bytes ? setConfirmPolicy(true) : void savePolicy().catch(() => {})}
              />
            </>
          )}
        </Show>
      </Show>
      <CacheDialogs
        stats={stats()} budget={budget()} busy={busy()}
        confirmPolicy={confirmPolicy()} onCloseConfirmPolicy={() => setConfirmPolicy(false)} onSavePolicy={savePolicy}
        cleanOpen={cleanOpen()} onCloseClean={() => setCleanOpen(false)}
        onCleaned={async (res) => {
          await refresh();
          setNotice(`已清理 ${bytes(res.freed_bytes)}${res.skipped_bytes ? `，保留 ${bytes(res.skipped_bytes)} 受保护内容` : ''}。`);
        }}
        unpin={unpin()} onCloseUnpin={() => setUnpin(undefined)}
        onConfirmUnpin={async (item) => {
          await execute('asset.offline.set', { id: item.asset_id, pinned: false });
          await refresh();
          setNotice('已解除固定，文件可按缓存策略回收。');
        }}
        cancelOpen={cancelOpen()} onCloseCancel={() => setCancelOpen(false)}
        onConfirmCancel={async () => {
          const res = await execute<CacheMigration>('cache.migration.cancel', { id: migration()!.id });
          setStats((cur) => (cur ? { ...cur, migration: res } : cur));
          await refresh();
        }}
        location={{
          open: locationOpen(), planning: planning(), check: locationCheck(), error: locationError(),
          mode: mode(), plan: plan(), authorized: authorized(), onAuthorizedChange: setAuthorized,
          onChangeMode: async (next) => {
            const path = locationCheck()?.path;
            if (!path) return;
            setMode(next);
            await prepareLocation(path, next);
            if (!disposed && locationOpen())
              document.querySelector<HTMLInputElement>(`input[name="cache-migration-mode"][value="${next}"]`)?.focus();
          },
          onChoose: () => void chooseLocation(),
          onClose: () => { if (!busy()) { planReq++; setLocationOpen(false); setPlanning(false); } },
          onStart: () => void startMigration(),
        }}
      />
    </section>
  );
}
