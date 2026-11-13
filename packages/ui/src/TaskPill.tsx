import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import Icon from './Icon';
import { Button, IconButton, Progress, Spinner } from './ui';
import type { TaskCenter } from './tasks';
import './TaskPill.css';

const VIEWPORT_GAP = 8;
const POPOVER_WIDTH = 300;
const POPOVER_MAX_HEIGHT = 360;

/**
 * Compact header status pill and popover for non-blocking background jobs
 * (scans, preview pre-generation, exports) so users can keep culling uninterrupted.
 */
export default function TaskPill(props: { tasks: TaskCenter }) {
  let trigger!: HTMLButtonElement;
  let popoverEl: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [coords, setCoords] = createSignal({ left: VIEWPORT_GAP, top: VIEWPORT_GAP });
  const all = () => props.tasks.tasks();
  const active = () => props.tasks.running();
  const failed = () => props.tasks.failedCount();

  function updateCoords() {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 768;
    const width = popoverEl?.offsetWidth || POPOVER_WIDTH;
    const height = Math.min(popoverEl?.offsetHeight || 220, POPOVER_MAX_HEIGHT);
    const left = Math.max(VIEWPORT_GAP, Math.min(rect.right - width, vw - width - VIEWPORT_GAP));
    const below = rect.bottom + VIEWPORT_GAP;
    const top =
      below + height <= vh - VIEWPORT_GAP
        ? below
        : Math.max(VIEWPORT_GAP, rect.top - height - VIEWPORT_GAP);
    setCoords({ left: Math.round(left), top: Math.round(top) });
  }

  createEffect(() => {
    if (!open()) return;
    updateCoords();
    requestAnimationFrame(() => updateCoords());
    const onResize = () => updateCoords();
    const onScroll = (event: Event) => {
      if (popoverEl && event.target instanceof Node && popoverEl.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    onCleanup(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    });
  });

  createEffect(() => {
    if (!all().length && open()) setOpen(false);
  });

  const summary = () => {
    const running = active();
    if (running.length === 1) {
      const current = running[0];
      if (current.total && current.total > 0) {
        return `${current.title} ${current.processed ?? 0}/${current.total}`;
      }
      return current.title;
    }
    if (running.length > 1) return `${running.length} 项后台任务`;
    if (failed() > 0) return `${failed()} 项任务失败`;
    return '后台任务已完成';
  };

  const pillRatio = () => {
    const running = active();
    if (running.length === 1 && running[0].total && running[0].total > 0) {
      return Math.max(0, Math.min(1, (running[0].processed ?? 0) / running[0].total));
    }
    return undefined;
  };

  return (
    <Show when={all().length > 0}>
      <div class="task-pill-anchor">
        <button
          ref={trigger}
          type="button"
          class={`task-pill-trigger${failed() > 0 && active().length === 0 ? ' is-failed' : ''}`}
          aria-label={`后台任务：${summary()}`}
          aria-expanded={open()}
          aria-haspopup="dialog"
          onClick={() => {
            const next = !open();
            if (next) updateCoords();
            setOpen(next);
          }}
        >
          <Show
            when={active().length > 0}
            fallback={
              <Icon
                name={failed() > 0 ? 'alert-circle' : 'circle-check'}
                size={14}
              />
            }
          >
            <Spinner size="sm" />
          </Show>
          <span class="task-pill-label">{summary()}</span>
          <Show when={pillRatio() !== undefined}>
            <span class="task-pill-bar" aria-hidden="true">
              <span style={{ transform: `scaleX(${pillRatio()!})` }} />
            </span>
          </Show>
        </button>

        <Show when={open()}>
          <Portal>
            <button
              type="button"
              class="task-pill-scrim"
              tabIndex={-1}
              aria-label="关闭后台任务列表"
              onClick={() => setOpen(false)}
            />
            <div
              ref={popoverEl}
              class="task-pill-popover"
              role="dialog"
              aria-label="后台任务列表"
              style={{ left: `${coords().left}px`, top: `${coords().top}px` }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setOpen(false);
                  trigger?.focus();
                }
              }}
            >
              <div class="task-pill-head">
                <strong>后台任务</strong>
                <Show when={all().some((t) => t.status !== 'running')}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => props.tasks.clearFinished()}
                  >
                    清除已结束
                  </Button>
                </Show>
              </div>
              <ul class="task-pill-list">
                <For each={all()}>
                  {(task) => (
                    <li class={`task-pill-row is-${task.status}`}>
                      <div class="task-pill-row-top">
                        <span class="task-pill-row-icon">
                          <Show
                            when={task.status === 'running'}
                            fallback={
                              <Icon
                                name={task.status === 'failed' ? 'alert-circle' : 'circle-check'}
                                size={14}
                              />
                            }
                          >
                            <Spinner size="sm" />
                          </Show>
                        </span>
                        <span class="task-pill-row-title">{task.title}</span>
                        <Show when={task.status !== 'running'}>
                          <IconButton
                            size="xs"
                            icon="close"
                            tipAlign="end"
                            label={`移除 ${task.title}`}
                            onClick={() => props.tasks.dismiss(task.id)}
                          />
                        </Show>
                      </div>
                      <Show when={task.status === 'running'}>
                        <Progress
                          value={
                            task.total && task.total > 0
                              ? (task.processed ?? 0) / Math.max(1, task.total)
                              : undefined
                          }
                          label={task.title}
                        />
                      </Show>
                      <Show when={task.error || task.detail}>
                        <p class="task-pill-row-detail">{task.error || task.detail}</p>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Portal>
        </Show>
      </div>
    </Show>
  );
}
