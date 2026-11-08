import { For, onCleanup, onMount } from 'solid-js';
import type { OverflowItem } from './OverflowMenu';

export interface ContextMenuState {
  x: number;
  y: number;
  label: string;
  items: (OverflowItem | 'separator')[];
  /** Element that receives focus again when the menu closes. */
  returnFocus?: HTMLElement | null;
}

/**
 * A menu opened at the pointer (or at a focused element for Shift+F10).
 * Arrow keys move, Escape and Tab close, focus returns to the opener.
 */
export default function ContextMenu(props: { menu: ContextMenuState; onClose: () => void }) {
  let list!: HTMLDivElement;
  const enabled = () =>
    Array.from(list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
  function close(refocus = true) {
    // Read props before onClose: closing unmounts this menu, after which its
    // props are no longer valid.
    const target = props.menu.returnFocus;
    props.onClose();
    if (refocus) target?.focus();
  }
  onMount(() => {
    // Keep the menu on screen near the window edges.
    const rect = list.getBoundingClientRect();
    const x = Math.min(props.menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(props.menu.y, window.innerHeight - rect.height - 8);
    list.style.left = `${Math.max(8, x)}px`;
    list.style.top = `${Math.max(8, y)}px`;
    enabled()[0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!list.contains(event.target as Node)) close(false);
    };
    const dismiss = () => close(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    });
  });
  function onKeyDown(event: KeyboardEvent) {
    const items = enabled();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    // The window-level shortcut handler must not see keys typed into the menu.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
  }
  return (
    <div
      ref={list}
      class="overflow-menu-list context-menu"
      role="menu"
      aria-label={props.menu.label}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <For each={props.menu.items}>
        {(item) =>
          item === 'separator' ? (
            <div class="context-menu-separator" role="separator" />
          ) : (
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
          )
        }
      </For>
    </div>
  );
}
