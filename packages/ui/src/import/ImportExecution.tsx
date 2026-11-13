import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { desktop, ejectVolume, execute } from '../api';
import {
  bytes,
  errorMessage,
  type ImportProgress,
  type ImportResult,
  type ImportStatus,
} from '../model';
import { Banner, Button, Progress } from '../ui';

export function ImportLiveProgress(props: { running: boolean; label: string }) {
  const [progress, setProgress] = createSignal<ImportProgress>();
  const [cancelling, setCancelling] = createSignal(false);
  createEffect(() => {
    if (!props.running) {
      setProgress(undefined);
      setCancelling(false);
      return;
    }
    let stopped = false;
    const poll = async () => {
      try {
        const status = await execute<ImportStatus>('import.status');
        if (!stopped && status.active && status.progress) setProgress(status.progress);
      } catch {
        /* Fallback to indeterminate busy indicator when status is unavailable. */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 200);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  });
  const ratio = () => {
    const p = progress();
    if (!p) return undefined;
    if (p.total_bytes > 0) return Math.min(1, p.copied_bytes / p.total_bytes);
    if (p.total_items > 0) return Math.min(1, p.done_items / p.total_items);
    return undefined;
  };
  return (
    <Show when={props.running}>
      <div class="import-live-progress" role="status">
        <Progress value={ratio()} label={props.label} />
        <Show when={progress()} fallback={<span class="import-foot-note">{props.label}</span>}>
          {(p) => (
            <div class="import-live-meta">
              <span>
                {p().done_items} / {p().total_items} 项 · {bytes(p().copied_bytes)} /{' '}
                {bytes(p().total_bytes)}
                <Show when={(p().backup_copied ?? 0) > 0}> · 副盘 {p().backup_copied} 项</Show>
              </span>
              <Show when={p().current_file}>
                <code>{p().current_file}</code>
              </Show>
            </div>
          )}
        </Show>
        <Button
          size="sm"
          variant="ghost"
          disabled={cancelling()}
          onClick={() => {
            setCancelling(true);
            void execute('import.cancel').catch(() => setCancelling(false));
          }}
        >
          {cancelling() ? '正在安全停止当前组…' : '取消导入'}
        </Button>
      </div>
    </Show>
  );
}

export function ImportPostActions(props: {
  result: ImportResult;
  removableSource?: string;
  onEjected?: () => void;
}) {
  const [ejectBusy, setEjectBusy] = createSignal(false);
  const [ejected, setEjected] = createSignal(false);
  const [ejectErr, setEjectErr] = createSignal('');
  async function eject() {
    if (!props.removableSource || ejectBusy()) return;
    setEjectBusy(true);
    setEjectErr('');
    try {
      await ejectVolume(props.removableSource);
      setEjected(true);
      props.onEjected?.();
    } catch (e) {
      setEjectErr(errorMessage(e));
    } finally {
      setEjectBusy(false);
    }
  }
  return (
    <div class="import-post-actions">
      <Show when={props.result.backup_destination}>
        <Banner
          tone={props.result.backup_failed ? 'warn' : 'info'}
          message={
            props.result.backup_failed
              ? `副盘备份完成 ${props.result.backup_copied ?? 0} 项，${props.result.backup_failed} 项未写入`
              : `已同步校验写入副盘备份 ${props.result.backup_copied ?? 0} 个文件`
          }
          detail={props.result.backup_destination}
        />
      </Show>
      <Show when={ejectErr()}>
        <Banner
          tone="error"
          message={`未能推出存储卡：${ejectErr()}`}
          onClose={() => setEjectErr('')}
        />
      </Show>
      <Show when={ejected()}>
        <Banner tone="info" message="存储卡已安全推出，可以拔出读卡器。" />
      </Show>
      <Show when={desktop && props.removableSource && !ejected()}>
        <Button icon="sd" disabled={ejectBusy()} busy={ejectBusy()} onClick={() => void eject()}>
          安全推出存储卡
        </Button>
      </Show>
    </div>
  );
}
