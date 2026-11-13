import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { execute } from '../api';
import { ConfirmDialog, Modal } from '../Dialogs';
import { bytes, errorMessage } from '../model';
import {
  cacheGiB,
  cacheMigrationOverage,
  type CacheLocationCheck,
  type CacheMigrationPlan,
  type CachePruneOptions,
  type CachePruneResult,
  type CacheStats,
} from '../cache-model';
import { Button } from '../ui';

const CLEAN_CHOICES: readonly [keyof CachePruneOptions, string][] = [
  ['originals', '可回收原图'],
  ['previews', '预览与缩略图'],
  ['temporary', '空闲临时下载'],
];
const knownSpace = (v: number | null | undefined) => (v == null ? '暂不可用' : bytes(v));

export interface CacheLocationDialogProps {
  open: boolean;
  planning: boolean;
  check: CacheLocationCheck | undefined;
  error: string;
  mode: 'all' | 'pinned';
  plan: CacheMigrationPlan | undefined;
  authorized: boolean;
  onAuthorizedChange: (value: boolean) => void;
  onChangeMode: (mode: 'all' | 'pinned') => void;
  onChoose: () => void;
  onClose: () => void;
  onStart: () => void;
}

export default function CacheDialogs(props: {
  stats: CacheStats | undefined;
  budget: string;
  busy: boolean;
  confirmPolicy: boolean;
  onCloseConfirmPolicy: () => void;
  onSavePolicy: () => Promise<void>;
  cleanOpen: boolean;
  onCloseClean: () => void;
  onCleaned: (result: CachePruneResult) => Promise<void>;
  unpin: CacheStats['pinned'][number] | undefined;
  onCloseUnpin: () => void;
  onConfirmUnpin: (item: CacheStats['pinned'][number]) => Promise<void>;
  cancelOpen: boolean;
  onCloseCancel: () => void;
  onConfirmCancel: () => Promise<void>;
  location: CacheLocationDialogProps;
}) {
  const [cleanBusy, setCleanBusy] = createSignal(false);
  const [cleanError, setCleanError] = createSignal('');
  const [cleanResult, setCleanResult] = createSignal<CachePruneResult>();
  const [cleanOptions, setCleanOptions] = createSignal<CachePruneOptions>({
    originals: true,
    previews: false,
    temporary: true,
  });
  let disposed = false,
    cleanReq = 0;
  onCleanup(() => {
    disposed = true;
    cleanReq++;
  });

  async function previewCleanup(options = cleanOptions()) {
    const req = ++cleanReq;
    setCleanOptions(options);
    setCleanBusy(true);
    setCleanError('');
    setCleanResult(undefined);
    try {
      const res = await execute<CachePruneResult>('cache.prune', { ...options, dry_run: true });
      if (!disposed && req === cleanReq) setCleanResult(res);
    } catch (cause) {
      if (!disposed && req === cleanReq) setCleanError(errorMessage(cause));
    } finally {
      if (!disposed && req === cleanReq) setCleanBusy(false);
    }
  }

  createEffect(
    on(
      () => props.cleanOpen,
      (open) => (open ? void previewCleanup(cleanOptions()) : void cleanReq++),
    ),
  );

  const facts = (cur: CacheMigrationPlan): [string, string][] => [
    ['旧位置', cur.from_path],
    ['新位置', cur.to_path],
    ['需迁移', bytes(cur.bytes)],
    ['临时额外空间', bytes(cur.extra_bytes)],
    ['临时占用上界（含预约）', bytes((props.stats?.usage.total_bytes || 0) + cur.extra_bytes)],
    ['新位置可用', knownSpace(cur.available_bytes)],
  ];

  return (
    <>
      <Show when={props.confirmPolicy && props.stats}>
        <ConfirmDialog
          title="降低缓存总上限？" confirmLabel="应用上限" busyLabel="正在应用…"
          onClose={props.onCloseConfirmPolicy} onConfirm={props.onSavePolicy}
        >
          <p>
            将上限从 {bytes(props.stats!.policy.budget_bytes)} 调整为 {bytes(Number(props.budget) * cacheGiB)}
            。空间不足时按最近使用时间回收普通缓存；离线固定与在用内容保留。
          </p>
          <p>远端原件、图片库登记、评级与配方不受影响。</p>
        </ConfirmDialog>
      </Show>

      <Show when={props.cleanOpen}>
        <ConfirmDialog
          title="清理缓存" confirmLabel="清理所选缓存" busyLabel="正在清理…"
          blocked={cleanBusy() || !cleanResult()?.reclaimable_bytes}
          onClose={props.onCloseClean}
          onConfirm={async () => {
            if (!cleanResult() || cleanBusy()) return;
            const res = await execute<CachePruneResult>('cache.prune', { ...cleanOptions(), dry_run: false });
            await props.onCleaned(res);
          }}
        >
          <div class="cache-clean-options">
            <For each={CLEAN_CHOICES}>
              {([key, label]) => (
                <label class="cache-checkbox">
                  <input
                    type="checkbox" checked={cleanOptions()[key]} disabled={cleanBusy()}
                    onChange={(e) => void previewCleanup({ ...cleanOptions(), [key]: e.currentTarget.checked })}
                  />
                  <span>{label}</span>
                </label>
              )}
            </For>
          </div>
          <Show when={cleanBusy()}><p role="status">正在核对可回收内容…</p></Show>
          <Show when={cleanResult()}>
            {(res) => (
              <p>预计释放 <strong>{bytes(res().reclaimable_bytes)}</strong>；跳过 {bytes(res().skipped_bytes)} 受保护内容。</p>
            )}
          </Show>
          <Show when={cleanError()}>
            <p class="form-error" role="alert">{cleanError()}</p>
            <Button size="sm" onClick={() => void previewCleanup()}>重新核对</Button>
          </Show>
          <p>仅清理本机缓存；离线固定、在用文件与远端原件保留。</p>
        </ConfirmDialog>
      </Show>

      <Show when={props.unpin}>
        {(item) => (
          <ConfirmDialog
            title="解除离线保留？" confirmLabel="解除固定" busyLabel="正在解除…"
            onClose={props.onCloseUnpin} onConfirm={() => props.onConfirmUnpin(item())}
          >
            <p>{item().name} 将进入可回收缓存。远端原件与图片库记录保留。</p>
          </ConfirmDialog>
        )}
      </Show>

      <Show when={props.cancelOpen}>
        <ConfirmDialog
          title="取消缓存迁移？" confirmLabel="取消迁移" busyLabel="正在取消…"
          onClose={props.onCloseCancel} onConfirm={props.onConfirmCancel}
        >
          <p>保留旧缓存位置与配置，释放本次迁移的临时空间。</p>
        </ConfirmDialog>
      </Show>

      <Show when={props.location.open}>
        <Modal title="更改缓存位置" onClose={props.location.onClose} busy={props.busy} wide>
          <div class="dialog-form cache-migration-review">
            <Show when={props.location.planning}><p role="status">正在检查目录与迁移空间…</p></Show>
            <Show when={props.location.check}>
              {(check) => (
                <>
                  <code class="cache-path">{check().path}</code>
                  <Show when={!check().valid}>
                    <p class="form-error" role="alert">{check().reason || '此位置不能用于缓存。'}</p>
                  </Show>
                </>
              )}
            </Show>
            <Show when={props.location.check?.valid}>
              <fieldset disabled={props.location.planning || props.busy}>
                <legend>迁移内容</legend>
                <For each={[['all', '迁移全部缓存'], ['pinned', '仅保留离线内容，其余重建']] as const}>
                  {([val, label]) => (
                    <label class="cache-checkbox">
                      <input
                        type="radio" name="cache-migration-mode" value={val}
                        checked={props.location.mode === val} onChange={() => props.location.onChangeMode(val)}
                      />
                      <span>{label}</span>
                    </label>
                  )}
                </For>
              </fieldset>
            </Show>
            <Show when={props.location.plan}>
              {(cur) => (
                <>
                  <dl class="cache-migration-facts">
                    <For each={facts(cur())}>{([k, v]) => <div><dt>{k}</dt><dd>{v}</dd></div>}</For>
                  </dl>
                  <Show when={!cur().can_start}>
                    <p class="form-error" role="alert">{cur().reason || '目前无法开始迁移。'}</p>
                  </Show>
                  <Show when={cacheMigrationOverage(cur()) > 0}>
                    <label class="cache-authorization cache-checkbox">
                      <input
                        type="checkbox" checked={props.location.authorized} disabled={props.busy}
                        onChange={(e) => props.location.onAuthorizedChange(e.currentTarget.checked)}
                      />
                      <span>
                        允许本次迁移临时超过总上限 {bytes(cacheMigrationOverage(cur()))}
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
            <Show when={props.location.error}><p class="form-error" role="alert">{props.location.error}</p></Show>
            <footer class="modal-footer">
              <Button disabled={props.busy} onClick={props.location.onClose}>取消</Button>
              <Button disabled={props.busy || props.location.planning} onClick={props.location.onChoose}>重新选择…</Button>
              <Button
                variant="primary"
                disabled={
                  props.busy || props.location.planning || !props.location.plan?.can_start ||
                  (!!props.location.plan && cacheMigrationOverage(props.location.plan) > 0 && !props.location.authorized)
                }
                onClick={props.location.onStart}
              >
                开始迁移
              </Button>
            </footer>
          </div>
        </Modal>
      </Show>
    </>
  );
}
