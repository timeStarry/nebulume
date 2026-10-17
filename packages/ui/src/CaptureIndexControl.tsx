import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { execute } from './api';
import { errorMessage, type CaptureIndexStatus } from './model';
import Icon from './Icon';
import './capture-index.css';

export default function CaptureIndexControl(props: {
  libraryId: string;
  onSettled: (status: CaptureIndexStatus) => void | Promise<void>;
}) {
  const [state, setState] = createSignal<CaptureIndexStatus>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  let request = 0;
  let disposed = false;
  let watchedJobId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => ['running', 'stopping'].includes(state()?.job?.status || '');
  const summary = () => {
    const value = state();
    if (!value) return '';
    const job = value.job;
    return `已知 ${value.known} · 未获得 ${value.missing} · 待索引 ${value.pending}${job?.failed ? ` · 本次失败 ${job.failed}` : ''}。未获得：未记录、格式暂不支持或记录无效。`;
  };
  function clearPoll() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function poll() {
    clearPoll();
    if (!disposed && active()) timer = setTimeout(() => void read(), 1000);
  }
  async function adopt(value: CaptureIndexStatus, notify = false) {
    if (!value || value.library_id !== props.libraryId)
      throw new Error('未返回当前图片库的拍摄时间索引状态。');
    setState(value);
    const job = value.job;
    if (job && ['running', 'stopping'].includes(job.status)) watchedJobId = job.id;
    if (job && !['running', 'stopping'].includes(job.status)) {
      if (job.status === 'failed') setError(job.error || '拍摄时间索引未完成，可重试剩余照片。');
      else if (job.status === 'cancelled') setNotice('已停止，已读取的结果已保留。');
      else setNotice(`拍摄时间索引完成${job.failed ? `，${job.failed} 项待重试` : ''}。`);
      // On entry, the parent is already querying the selected sort/library.
      // Only a task observed here needs another query when it finishes.
      if (notify || watchedJobId === job.id) await props.onSettled(value);
    }
  }
  async function read() {
    const token = ++request;
    const libraryId = props.libraryId;
    try {
      const value = await execute<CaptureIndexStatus>('library.capture_index.status', {
        library_id: libraryId,
      });
      if (disposed || token !== request || libraryId !== props.libraryId) return;
      setError('');
      await adopt(value);
    } catch (e) {
      if (!disposed && token === request) setError(errorMessage(e));
    } finally {
      if (!disposed && token === request) poll();
    }
  }
  async function operate(operation: 'start' | 'cancel') {
    const token = ++request;
    const libraryId = props.libraryId;
    clearPoll();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await execute<CaptureIndexStatus>(`library.capture_index.${operation}`, {
        library_id: libraryId,
        ...(operation === 'cancel' ? { job_id: state()?.job?.id } : {}),
      });
      if (disposed || token !== request || libraryId !== props.libraryId) return;
      await adopt(value, true);
    } catch (e) {
      if (!disposed && token === request) setError(errorMessage(e));
    } finally {
      if (!disposed && token === request) {
        setBusy(false);
        poll();
      }
    }
  }
  createEffect(() => {
    props.libraryId;
    ++request;
    clearPoll();
    setState(undefined);
    setNotice('');
    setError('');
    setBusy(false);
    watchedJobId = undefined;
    void read();
  });
  onCleanup(() => {
    disposed = true;
    ++request;
    clearPoll();
  });
  return (
    <div class="capture-index-control" aria-label="拍摄时间索引">
      <Show
        when={active()}
        fallback={
          <Show when={state()?.pending}>
            <button
              class="button small"
              disabled={busy()}
              onClick={() => void operate('start')}
              title={`按需读取拍摄信息，不增加原图缓存。${summary()}`}
            >
              <Icon name="refresh" size={14} />
              {state()?.job?.failed || state()?.job?.status === 'failed'
                ? '重试拍摄时间索引'
                : '索引拍摄时间'}
            </button>
          </Show>
        }
      >
        <span class="capture-index-progress" role="status" title={summary()}>
          {state()?.job?.status === 'stopping' ? '正在停止' : '读取'} {state()?.job?.processed} /{' '}
          {state()?.job?.total}
          <progress
            aria-label="拍摄时间索引进度"
            max={Math.max(1, state()?.job?.total || 0)}
            value={state()?.job?.processed || 0}
          />
        </span>
        <button
          class="icon-button"
          aria-label="停止拍摄时间索引"
          title="停止后保留已读取的结果"
          disabled={busy() || state()?.job?.status === 'stopping'}
          onClick={() => void operate('cancel')}
        >
          <Icon name="close" size={14} />
        </button>
      </Show>
      <Show when={error()}>
        <span class="capture-index-error" role="alert">
          {error()}
        </span>
        <button class="button small" disabled={busy()} onClick={() => void read()}>
          重试读取状态
        </button>
      </Show>
      <Show when={notice()}>
        <span class="capture-index-notice" role="status" title={summary()}>
          {notice()}
        </span>
        <button class="icon-button" aria-label="关闭索引提示" onClick={() => setNotice('')}>
          <Icon name="close" size={13} />
        </button>
      </Show>
    </div>
  );
}
