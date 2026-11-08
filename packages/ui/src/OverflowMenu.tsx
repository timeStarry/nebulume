import { createSignal, For, onCleanup, Show } from 'solid-js';
import Icon from './Icon';

export interface OverflowItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Accessible name when the visible label is not specific enough. */
  ariaLabel?: string;
}

/**
 * A disclosure menu for secondary actions. Arrow keys move between items,
 * Escape closes and returns focus to the trigger.
 */
export default function OverflowMenu(props: { label: string; items: OverflowItem[] }) {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const id = `overflow-${Math.random().toString(36).slice(2, 9)}`;
  const items = () => Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const enabled = () => items().filter((item) => !item.disabled);
  function close(refocus = true) {
    if (!open()) return;
    setOpen(false);
    if (refocus) trigger.focus();
  }
  function show(focus: 'first' | 'last' = 'first') {
    setOpen(true);
    queueMicrotask(() => {
      const list = enabled();
      (focus === 'first' ? list[0] : list.at(-1))?.focus();
    });
  }
  const onDocument = (event: PointerEvent) => {
    if (open() && !root.contains(event.target as Node)) close(false);
  };
  document.addEventListener('pointerdown', onDocument);
  onCleanup(() => document.removeEventListener('pointerdown', onDocument));
  function onKeyDown(event: KeyboardEvent) {
    if (!open()) return;
    const list = enabled();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      list.at(-1)?.focus();
    } else if (event.key === 'Tab') close(false);
  }
  return (
    <div class="overflow-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        class="icon-button"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={id}
        onClick={() => (open() ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open()) {
            event.preventDefault();
            show('first');
          } else if (event.key === 'ArrowUp' && !open()) {
            event.preventDefault();
            show('last');
          }
        }}
      >
        <Icon name="more" size={17} />
      </button>
      <Show when={open()}>
        <div class="overflow-menu-list" role="menu" id={id} aria-label={props.label}>
          <For each={props.items}>
            {(item) => (
              <button
                role="menuitem"
                class={`overflow-menu-item ${item.danger ? 'danger' : ''}`}
                aria-label={item.ariaLabel}
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect();
                  close();
                }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
