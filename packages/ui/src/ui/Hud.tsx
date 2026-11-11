import { createSignal, onCleanup, Show } from 'solid-js';
import Icon, { type IconName } from '../Icon';
import './Hud.css';

export const HUD_MS = 1200;

/**
 * A transient glass capsule at the bottom of the viewport confirming a blind keyboard action
 * (rating, flag, undo). Each window or viewer creates its own; a new message replaces the
 * current one at once. It never takes focus.
 */
export function createHud() {
  const [message, setMessage] = createSignal<{ text: string; icon?: IconName; key: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  function show(text: string, icon?: IconName) {
    clearTimeout(timer);
    const next = { text, icon, key: Date.now() + Math.random() };
    setMessage(next);
    timer = setTimeout(() => {
      if (message() === next) setMessage(undefined);
    }, HUD_MS);
  }
  /** `stacked` sits in a toast stack's flow (above its toasts) instead of floating on its own. */
  function Host(props: { tone?: 'app' | 'viewer'; stacked?: boolean }) {
    onCleanup(() => clearTimeout(timer));
    return (
      <Show when={message()} keyed>
        {(current) => (
          <div
            class={`nl-hud-slot nl-hud-slot--${props.tone ?? 'app'}${props.stacked ? ' nl-hud-slot--stacked' : ''}`}
          >
            <span class="nl-hud" data-testid="hud" role="status" aria-live="polite">
              <Show when={current.icon}>{(name) => <Icon name={name()} size={16} />}</Show>
              <span class="nl-hud-text">{current.text}</span>
            </span>
          </div>
        )}
      </Show>
    );
  }
  return { show, message, Host };
}
export type Hud = ReturnType<typeof createHud>;
