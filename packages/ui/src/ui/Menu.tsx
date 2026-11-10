import { For, Show, onCleanup, onMount } from 'solid-js';
import Icon, { type IconName } from '../Icon';
import './Menu.css';

export interface OverflowItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Destructive: shown in the reject colour. */
  danger?: boolean;
  /** Accessible name when the visible label is not specific enough. */
  ariaLabel?: string;
  icon?: IconName;
  shortcut?: string;
  /** Small group heading drawn above this item. */
  heading?: string;
  /** Hover text, for example why the item is disabled. */
  title?: string;
}

export type MenuEntry = OverflowItem | 'separator';

export interface ContextMenuState {
  x: number;
  y: number;
  label: string;
  items: MenuEntry[];
  /** Element that receives focus again when the menu closes. */
  returnFocus?: HTMLElement | null;
}

/** The menu list: arrow keys move, Home/End jump, Escape and Tab close. */
export function MenuList(props: {
  label: string;
  items: MenuEntry[];
  id?: string;
  ref?: (el: HTMLDivElement) => void;
  class?: string;
  style?: Record<string, string>;
  onClose: (refocus: boolean) => void;
}) {
  let list!: HTMLDivElement;
  const enabled = () =>
    Array.from(list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
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
      props.onClose(true);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      props.onClose(true);
    } else if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
  }
  return (
    <div
      ref={(el) => {
        list = el;
        props.ref?.(el);
      }}
      id={props.id}
      class={`nl-menu${props.class ? ` ${props.class}` : ''}`}
      style={props.style}
      role="menu"
      aria-label={props.label}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <For each={props.items}>
        {(item) =>
          item === 'separator' ? (
            <div class="nl-menu-separator" role="separator" />
          ) : (
            <>
              <Show when={item.heading}>
                <div class="nl-menu-heading" role="presentation">
                  {item.heading}
                </div>
              </Show>
              <button
                type="button"
                role="menuitem"
                class={`nl-menu-item${item.danger ? ' nl-menu-item--danger' : ''}`}
                aria-label={item.ariaLabel}
                aria-keyshortcuts={item.shortcut}
                title={item.title}
                disabled={item.disabled}
                onClick={(event) => {
                  const menu = event.currentTarget.closest('[role="menu"]');
                  item.onSelect();
                  // Return focus to the opener unless the action moved it somewhere else.
                  const active = document.activeElement;
                  props.onClose(!active || active === document.body || !!menu?.contains(active));
                }}
              >
                <Show when={item.icon} fallback={<span class="nl-menu-icon" />}>
                  {(name) => <Icon name={name()} class="nl-menu-icon" />}
                </Show>
                <span class="nl-menu-label">{item.label}</span>
                <Show when={item.shortcut}>
                  <span class="nl-menu-shortcut">{item.shortcut}</span>
                </Show>
              </button>
            </>
          )
        }
      </For>
    </div>
  );
}

/**
 * A menu opened at the pointer (or at a focused element for Shift+F10).
 * Focus returns to the opener when it closes.
 */
export default function ContextMenu(props: { menu: ContextMenuState; onClose: () => void }) {
  let list!: HTMLDivElement;
  function close(refocus = true) {
    // Read props before onClose: closing unmounts this menu.
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
    list.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
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
  return (
    <MenuList
      ref={(el) => (list = el)}
      class="nl-menu--floating context-menu"
      label={props.menu.label}
      items={props.menu.items}
      onClose={(refocus) => close(refocus)}
    />
  );
}
