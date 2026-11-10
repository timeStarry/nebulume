import { Show, onCleanup, onMount, type JSX } from 'solid-js';
import IconButton from './IconButton';
import './Dialog.css';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

/** Traps focus while open and returns it to the opener; Escape and the scrim close it unless busy. */
export function Dialog(props: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
  width?: number;
  busy?: boolean;
  class?: string;
  closeLabel?: string;
}) {
  let dialog!: HTMLDivElement;
  let previous: HTMLElement | null;
  onMount(() => {
    previous = document.activeElement as HTMLElement;
    const body = dialog.querySelector<HTMLElement>('.nl-dialog-body');
    (
      body?.querySelector<HTMLElement>(
        'input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      ) ?? dialog.querySelector<HTMLElement>(FOCUSABLE)
    )?.focus();
  });
  onCleanup(() => previous?.focus());
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!props.busy) props.onClose();
    }
    if (event.key === 'Tab') {
      const nodes = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      const first = nodes[0];
      const last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
  return (
    <div
      class="nl-scrim modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onClose();
      }}
    >
      <div
        ref={dialog}
        class={`nl-dialog modal${props.class ? ` ${props.class}` : ''}`}
        style={{ width: `${props.width ?? 480}px` }}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        aria-busy={props.busy || undefined}
        onKeyDown={keydown}
      >
        <header class="nl-dialog-head">
          <div>
            <h2>{props.title}</h2>
            <Show when={props.subtitle}>
              <p>{props.subtitle}</p>
            </Show>
          </div>
          <IconButton
            icon="x"
            size="sm"
            label={props.closeLabel ?? '关闭对话框'}
            disabled={props.busy}
            onClick={() => props.onClose()}
          />
        </header>
        <div class="nl-dialog-body">{props.children}</div>
        <Show when={props.footer}>
          <footer class="nl-dialog-foot">{props.footer}</footer>
        </Show>
      </div>
    </div>
  );
}

/** A side sheet from the right edge, for lists that sit beside the page (import history). */
export function Drawer(props: {
  title: string;
  onClose: () => void;
  children: JSX.Element;
  width?: number;
}) {
  let panel!: HTMLDivElement;
  let previous: HTMLElement | null;
  onMount(() => {
    previous = document.activeElement as HTMLElement;
    panel.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  });
  onCleanup(() => previous?.focus());
  return (
    <div
      class="nl-drawer-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={panel}
        class="nl-drawer"
        style={{ width: `${props.width ?? 360}px` }}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            props.onClose();
          }
        }}
      >
        <header class="nl-dialog-head">
          <h2>{props.title}</h2>
          <IconButton icon="x" size="sm" label="关闭" onClick={() => props.onClose()} />
        </header>
        <div class="nl-drawer-body">{props.children}</div>
      </div>
    </div>
  );
}
