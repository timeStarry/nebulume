import { Show, splitProps, type JSX } from 'solid-js';
import Icon, { type IconName } from '../Icon';
import './Group.css';

/** A titled group of rows: settings, import options, locations and details all use it. */
export function Group(props: {
  title: string;
  meta?: JSX.Element;
  action?: JSX.Element;
  children: JSX.Element;
  id?: string;
  class?: string;
  /** Rows without the bordered list box (for free-form content). */
  plain?: boolean;
}) {
  return (
    <section
      class={`nl-group${props.class ? ` ${props.class}` : ''}`}
      id={props.id}
      aria-label={props.title}
    >
      <div class="nl-group-head">
        <h3>{props.title}</h3>
        <Show when={props.meta}>
          <span class="nl-group-meta">{props.meta}</span>
        </Show>
        <Show when={props.action}>
          <div class="nl-group-action">{props.action}</div>
        </Show>
      </div>
      <div class={props.plain ? 'nl-group-body' : 'nl-list'}>{props.children}</div>
    </section>
  );
}

/** One row: name and a one-line description on the left, a single control on the right. */
export function ListRow(
  props: {
    title: JSX.Element;
    description?: JSX.Element;
    leading?: IconName;
    control?: JSX.Element;
    /** The whole row is one button and shows a trailing chevron. */
    nav?: boolean;
    onClick?: () => void;
    class?: string;
    labelFor?: string;
    children?: JSX.Element;
  } & Pick<JSX.HTMLAttributes<HTMLElement>, 'aria-label' | 'aria-current'>,
) {
  const [own, rest] = splitProps(props, [
    'title',
    'description',
    'leading',
    'control',
    'nav',
    'onClick',
    'class',
    'labelFor',
    'children',
  ]);
  const body = () => (
    <>
      <Show when={own.leading}>
        {(name) => (
          <span class="nl-row-lead" aria-hidden="true">
            <Icon name={name()} size={18} />
          </span>
        )}
      </Show>
      <span class="nl-row-label">
        <Show when={own.labelFor} fallback={<b>{own.title}</b>}>
          <label for={own.labelFor}>{own.title}</label>
        </Show>
        <Show when={own.description}>
          <span>{own.description}</span>
        </Show>
      </span>
      <Show when={own.control}>
        <span class="nl-row-control">{own.control}</span>
      </Show>
      <Show when={own.nav}>
        <Icon name="chevron-right" class="nl-row-chevron" />
      </Show>
    </>
  );
  return (
    <Show
      when={own.nav}
      fallback={
        <div class={`nl-row${own.class ? ` ${own.class}` : ''}`} {...rest}>
          {body()}
          {own.children}
        </div>
      }
    >
      <button
        type="button"
        class={`nl-row nl-row--nav${own.class ? ` ${own.class}` : ''}`}
        onClick={() => own.onClick?.()}
        {...rest}
      >
        {body()}
      </button>
    </Show>
  );
}
