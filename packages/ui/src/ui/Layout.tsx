import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import './Layout.css';

/** 56px page header: title (and subtitle), a centre slot, actions on the right. */
export function PageHeader(props: {
  title: JSX.Element;
  subtitle?: JSX.Element;
  leading?: JSX.Element;
  /** Receives whether the header is narrow, so a segmented control can go icon-only. */
  center?: (narrow: boolean) => JSX.Element;
  actions?: JSX.Element;
  class?: string;
}) {
  let header!: HTMLElement;
  const [narrow, setNarrow] = createSignal(false);
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 760));
    observer.observe(header);
    onCleanup(() => observer.disconnect());
  });
  return (
    <header ref={header} class={`nl-page-header${props.class ? ` ${props.class}` : ''}`}>
      <div class="nl-page-title">
        {props.leading}
        <h1>{props.title}</h1>
        <Show when={props.subtitle}>
          <span class="nl-page-subtitle">{props.subtitle}</span>
        </Show>
      </div>
      <Show when={props.center}>
        <div class="nl-page-center">{props.center!(narrow())}</div>
      </Show>
      <div class="nl-page-actions">{props.actions}</div>
    </header>
  );
}

/** 44px toolbar under the header. */
export function Toolbar(props: { children: JSX.Element; label?: string; class?: string }) {
  return (
    <div
      class={`nl-toolbar${props.class ? ` ${props.class}` : ''}`}
      role="toolbar"
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

export function Spacer() {
  return <span class="nl-spacer" />;
}

/** Bottom-centred glass action dock that floats over a scroll viewport without shifting layout. */
export function FloatingDock(props: {
  label: string;
  inline?: boolean;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <div
      class={`nl-floating-dock${props.inline ? ' nl-floating-dock--inline' : ''}${props.class ? ` ${props.class}` : ''}`}
      role="toolbar"
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

/** One centred column, at most 760px wide. */
export function SinglePage(props: {
  children: JSX.Element;
  class?: string;
  ref?: (el: HTMLDivElement) => void;
}) {
  return (
    <div class={`nl-page${props.class ? ` ${props.class}` : ''}`} ref={props.ref}>
      <div class="nl-page-column">{props.children}</div>
    </div>
  );
}

/** Main column plus a 300px aside whose footer stays at the bottom. */
export function SplitPage(props: {
  main: JSX.Element;
  aside: JSX.Element;
  asideFooter?: JSX.Element;
  asideLabel?: string;
  class?: string;
}) {
  return (
    <div class={`nl-split${props.class ? ` ${props.class}` : ''}`}>
      <div class="nl-split-main">{props.main}</div>
      <aside class="nl-split-aside" aria-label={props.asideLabel}>
        <div class="nl-split-aside-body">{props.aside}</div>
        <Show when={props.asideFooter}>
          <div class="nl-split-aside-foot">{props.asideFooter}</div>
        </Show>
      </aside>
    </div>
  );
}

/** The single way a multi-step flow shows where it is. */
export function Steps(props: { steps: string[]; current: number; label: string }) {
  return (
    <ol class="nl-steps" aria-label={props.label}>
      <For each={props.steps}>
        {(step, index) => (
          <li
            class={
              index() < props.current ? 'done' : index() === props.current ? 'current' : undefined
            }
            aria-current={index() === props.current ? 'step' : undefined}
          >
            <i aria-hidden="true">{index() + 1}</i>
            {step}
          </li>
        )}
      </For>
    </ol>
  );
}

export interface DataColumn<T> {
  key: string;
  label: string;
  align?: 'end';
  width?: string;
  render?: (row: T) => JSX.Element;
}

export function DataTable<T>(props: {
  columns: DataColumn<T>[];
  rows: T[];
  empty?: string;
  label?: string;
  class?: string;
  rowClass?: (row: T) => string | undefined;
}) {
  return (
    <table class={`nl-table${props.class ? ` ${props.class}` : ''}`} aria-label={props.label}>
      <thead>
        <tr>
          <For each={props.columns}>
            {(column) => (
              <th
                class={column.align === 'end' ? 'end' : undefined}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.label}
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For
          each={props.rows}
          fallback={
            <Show when={props.empty}>
              <tr>
                <td class="nl-table-empty" colSpan={props.columns.length}>
                  {props.empty}
                </td>
              </tr>
            </Show>
          }
        >
          {(row) => (
            <tr class={props.rowClass?.(row)}>
              <For each={props.columns}>
                {(column) => (
                  <td class={column.align === 'end' ? 'end' : undefined}>
                    {column.render
                      ? column.render(row)
                      : String((row as Record<string, unknown>)[column.key] ?? '')}
                  </td>
                )}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}
