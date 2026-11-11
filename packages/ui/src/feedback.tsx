import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { Toast, createHud } from './ui';
import { createUndoHistory, type UndoEntry } from './undo';
import { errorMessage } from './model';

export const NOTICE_DISMISS_MS = 6000;

/**
 * Everything a window says back to the user: one busy line, one error, one notice, a
 * catalog-sync failure, the undo history with its toast, and the blind-action HUD. Views
 * call the setters; `<FeedbackStack>` renders them with the shared `Toast` primitive.
 */
export function createFeedback() {
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [syncError, setSyncError] = createSignal('');
  const history = createUndoHistory();
  const hud = createHud();
  // Success notices close themselves; errors stay until dismissed or replaced.
  createEffect(() => {
    if (!notice()) return;
    const timeout = setTimeout(() => setNotice(''), NOTICE_DISMISS_MS);
    onCleanup(() => clearTimeout(timeout));
  });
  function clearMessages() {
    setError('');
    setNotice('');
  }
  /** Runs `operation` with a busy line; its error becomes the error toast. */
  async function action(label: string, operation: () => Promise<void>) {
    setBusy(label);
    clearMessages();
    try {
      await operation();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  /** Reverts `entry` (or the latest action). Reports through the HUD and error toast. */
  async function undo(entry?: UndoEntry, options: { busy?: string } = {}) {
    if (!entry && !history.size) {
      hud.show('没有可撤销的操作', 'history');
      return;
    }
    if (options.busy) setBusy(options.busy);
    try {
      const done = await history.undo(entry);
      if (done) hud.show(`已撤销：${done.label}`, 'history');
    } catch (e) {
      setError(`撤销失败：${errorMessage(e)}`);
    } finally {
      if (options.busy) setBusy('');
    }
  }
  return {
    busy,
    setBusy,
    error,
    setError,
    notice,
    setNotice,
    syncError,
    setSyncError,
    clearMessages,
    action,
    history,
    hud,
    undo,
  };
}
export type Feedback = ReturnType<typeof createFeedback>;

export function FeedbackStack(props: {
  feedback: Feedback;
  startup?: string;
  undoBusy?: string;
  onRetrySync?: () => void;
}) {
  const f = props.feedback;
  return (
    <>
      <div class="toast-stack">
        <Show when={f.busy() || props.startup}>
          <Toast tone="busy" message={f.busy() || props.startup} />
        </Show>
        <Show when={f.syncError()}>
          <Toast
            tone="error"
            message={f.syncError()}
            action={props.onRetrySync && { label: '重试影像同步', run: props.onRetrySync }}
          />
        </Show>
        <Show when={f.error()}>
          <Toast
            tone="error"
            message={f.error()}
            onClose={() => f.setError('')}
            closeLabel="关闭错误提示"
          />
        </Show>
        <Show when={f.history.offer()} keyed>
          {(entry) => (
            <Toast
              message={entry.label}
              action={{
                label: '撤销',
                run: () => void f.undo(entry, { busy: props.undoBusy }),
              }}
              shortcut="⌘Z"
            />
          )}
        </Show>
        <Show when={f.notice()}>
          <Toast message={f.notice()} onClose={() => f.setNotice('')} closeLabel="关闭完成提示" />
        </Show>
        <f.hud.Host stacked />
      </div>
    </>
  );
}
