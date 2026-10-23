import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { execute } from './api';
import { bytes, errorMessage, type FingerprintStatus } from './model';

/** Explicit content-fingerprint task for one library, shown in library settings. */
export default function FingerprintControl(props: { libraryId: string }) {
  const [state, setState] = createSignal<FingerprintStatus>();
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const running = () => ['running', 'stopping'].includes(state()?.job?.status || '');
  async function read() {
    try {
      const value = await execute<FingerprintStatus>('library.fingerprint.status', {
        library_id: props.libraryId,
      });
      if (disposed) return;
      setState(value);
      if (value.job?.status === 'failed') setError(value.job.error || '内容指纹任务未完成。');
    } catch (e) {
      if (!disposed) setError(errorMessage(e));
    }
    if (!disposed && running()) timer = setTimeout(() => void read(), 1000);
  }
  async function operate(command: 'start' | 'cancel') {
    clearTimeout(timer);
    setBusy(true);
    setError('');
    setConfirm(false);
    try {
      setState(
        await execute<FingerprintStatus>(`library.fingerprint.${command}`, {
          library_id: props.libraryId,
          ...(command === 'cancel' ? { job_id: state()?.job?.id } : {}),
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
    void read();
  }
  function start() {
    // Remote libraries download every unhashed original in full: confirm first.
    if (state()?.remote && !confirm()) setConfirm(true);
    else void operate('start');
  }
  onMount(() => void read());
  onCleanup(() => {
    disposed = true;
    clearTimeout(timer);
  });
  return (
    <section class="fingerprint-control" aria-label="内容指纹">
      <div class="fingerprint-head">
        <div>
          <strong>内容指纹</strong>
          <p>
            为照片计算 SHA-256，导入时就能按内容严格判重，不再依赖文件名。只读取原片，不改动文件。
          </p>
        </div>
        <Show
          when={running()}
          fallback={
            <button
              class="button small"
              type="button"
              onClick={start}
              disabled={busy() || !state()?.pending}
            >
              {state()?.pending ? '建立内容指纹' : '已全部建立'}
            </button>
          }
        >
          <button
            class="button small"
            type="button"
            onClick={() => void operate('cancel')}
            disabled={busy() || state()?.job?.status === 'stopping'}
          >
            {state()?.job?.status === 'stopping' ? '正在停止…' : '停止'}
          </button>
        </Show>
      </div>
      <Show when={state()}>
        {(value) => (
          <p class="fingerprint-summary">
            已建立 {value().known} / {value().total}
            <Show when={value().pending}>
              {' · '}待处理 {value().pending}（{bytes(value().pending_bytes)}）
            </Show>
          </p>
        )}
      </Show>
      <Show when={running() && state()?.job}>
        {(job) => (
          <div class="fingerprint-progress" role="status">
            <progress value={job().processed} max={Math.max(1, job().total)} />
            <span>
              {job().processed} / {job().total} · 已读取 {bytes(job().bytes_read)}
            </span>
          </div>
        )}
      </Show>
      <Show when={confirm()}>
        <div class="workspace-message" role="alert">
          <span>
            这是网络图片库，需要完整下载 {state()?.pending} 个文件（约{' '}
            {bytes(state()?.pending_bytes || 0)}
            ）来计算指纹。下载内容不进入缓存，可随时停止，已完成的结果会保留。
          </span>
          <button class="button small primary" type="button" onClick={() => void operate('start')}>
            开始下载并建立
          </button>
          <button class="button small" type="button" onClick={() => setConfirm(false)}>
            取消
          </button>
        </div>
      </Show>
      <Show when={state()?.job?.status === 'cancelled'}>
        <p class="field-note">已停止，已完成的指纹已保留。</p>
      </Show>
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
    </section>
  );
}
