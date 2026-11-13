import { Show, createEffect, createSignal, createUniqueId, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { IconName } from './Icon';
import { MenuList, type MenuEntry } from './ui/Menu';
import IconButton from './ui/IconButton';

export type { OverflowItem } from './ui/Menu';

/**
 * A "更多" disclosure menu for secondary actions. Rendered via a body Portal with
 * viewport clamping so narrow scroll containers (such as the library sidebar) never
 * clip the menu on Windows or horizontally scroll the layout on macOS.
 */
export default function OverflowMenu(props: {
  label: string;
  items: MenuEntry[];
  size?: 'xs' | 'sm' | 'md';
  icon?: IconName;
}) {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let menuEl: HTMLDivElement | undefined;
  const id = createUniqueId();
  const enabled = () =>
    menuEl
      ? Array.from(menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
      : [];

  function positionMenu() {
    if (!menuEl || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const rect = menuEl.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const preferStart = anchor.right < vw * 0.5;
    const rawX = preferStart ? anchor.left : anchor.right - rect.width;
    const x = Math.max(8, Math.min(rawX, vw - rect.width - 8));
    let y = anchor.bottom + 4;
    if (rect.height > 0 && y + rect.height > vh - 8 && anchor.top - 4 - rect.height >= 8) {
      y = anchor.top - 4 - rect.height;
    } else {
      y = Math.max(8, Math.min(y, vh - rect.height - 8));
    }
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
  }

  function close(refocus = true) {
    if (!open()) return;
    setOpen(false);
    if (refocus) trigger.focus();
  }
  function show(focus: 'first' | 'last' = 'first') {
    setOpen(true);
    positionMenu();
    queueMicrotask(() => {
      positionMenu();
      const list = enabled();
      (focus === 'first' ? list[0] : list.at(-1))?.focus();
    });
  }

  createEffect(() => {
    if (!open()) return;
    const onDocument = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !root.contains(target) && !menuEl?.contains(target)) close(false);
    };
    const onScroll = (event: Event) => {
      if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return;
      close(false);
    };
    const dismiss = () => close(false);
    document.addEventListener('pointerdown', onDocument, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onDocument, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    });
  });

  return (
    <div class="nl-menu-anchor" ref={root}>
      <IconButton
        ref={trigger}
        icon={props.icon ?? 'more'}
        size={props.size ?? 'md'}
        label={props.label}
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
      />
      <Show when={open()}>
        <Portal>
          <MenuList
            id={id}
            ref={(el) => {
              menuEl = el;
              positionMenu();
            }}
            class="nl-menu--floating"
            label={props.label}
            items={props.items}
            onClose={(refocus) => close(refocus)}
          />
        </Portal>
      </Show>
    </div>
  );
}
