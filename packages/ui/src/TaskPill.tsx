import { For, Show, createSignal } from 'solid-js';
import Icon from './Icon';
import { Button, IconButton, Progress, Spinner } from './ui';
import type { TaskCenter } from './tasks';
import './TaskPill.css';

/**
 * Compact header status pill and popover for non-blocking background jobs
 * (scans, preview pre-generation, exports) so users can keep culling uninterrupted.
 */
export default function TaskPill(props: { tasks: TaskCenter }) {
  const [open, setOpen] = createSignal(false);
  const all = () => props.tasks.tasks();
  const active = () => props.tasks.running();
  const failed = () => props.tasks.failedCount();

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
          type="button"
          class={`task-pill-trigger${failed() > 0 && active().length === 0 ? ' is-failed' : ''}`}
          aria-label={`后台任务：${summary()}`}
          aria-expanded={open()}
          aria-haspopup="dialog"
          onClick={() => setOpen((v) => !v)}
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
          <button
            type="button"
            class="task-pill-scrim"
            tabIndex={-1}
            aria-label="关闭后台任务列表"
            onClick={() => setOpen(false)}
          />
          <div
            class="task-pill-popover"
            role="dialog"
            aria-label="后台任务列表"
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
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
        </Show>
      </div>
    </Show>
  );
}
