import { Show, createSignal, createUniqueId, onCleanup } from 'solid-js';
import { MenuList, type MenuEntry } from './ui/Menu';
import IconButton from './ui/IconButton';

export type { OverflowItem } from './ui/Menu';

/**
 * A "更多" disclosure menu for secondary actions. Arrow keys move between items,
 * Escape closes and returns focus to the trigger.
 */
export default function OverflowMenu(props: {
  label: string;
  items: MenuEntry[];
  size?: 'xs' | 'sm' | 'md';
}) {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const id = createUniqueId();
  const enabled = () =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
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
  return (
    <div class="nl-menu-anchor" ref={root}>
      <IconButton
        ref={trigger}
        icon="more"
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
        <MenuList
          id={id}
          class="nl-menu--anchored"
          label={props.label}
          items={props.items}
          onClose={(refocus) => close(refocus)}
        />
      </Show>
    </div>
  );
}
