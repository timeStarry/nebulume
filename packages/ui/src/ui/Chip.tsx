import { Show, type JSX } from 'solid-js';
import Icon, { type IconName } from '../Icon';
import './Chip.css';

/** A removable filter tag. */
export function Chip(props: { label: string; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span class="nl-chip">
      <span>{props.label}</span>
      <Show when={props.onRemove}>
        <button
          type="button"
          aria-label={props.removeLabel ?? `移除筛选：${props.label}`}
          onClick={() => props.onRemove?.()}
        >
          <Icon name="x" size={12} />
        </button>
      </Show>
    </span>
  );
}

/** A pill-shaped on/off button, such as 隐藏淘汰. */
export function Toggle(props: {
  pressed: boolean;
  onChange: (value: boolean) => void;
  icon?: IconName;
  children: JSX.Element;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      class="nl-toggle"
      aria-pressed={props.pressed}
      disabled={props.disabled}
      title={props.title}
      onClick={() => props.onChange(!props.pressed)}
    >
      <Show when={props.icon}>{(name) => <Icon name={name()} size={14} />}</Show>
      {props.children}
    </button>
  );
}

export type Tone = 'neutral' | 'pick' | 'reject' | 'warn' | 'info';

export function Badge(props: {
  tone?: Tone;
  icon?: IconName;
  children: JSX.Element;
  title?: string;
}) {
  return (
    <span class={`nl-badge nl-badge--${props.tone ?? 'neutral'}`} title={props.title}>
      <Show when={props.icon}>{(name) => <Icon name={name()} size={12} />}</Show>
      {props.children}
    </span>
  );
}

/** A small availability dot; its label is always present for assistive tech. */
export function StatusDot(props: {
  state: 'ok' | 'off' | 'warn' | 'bad';
  label: string;
  showLabel?: boolean;
  title?: string;
}) {
  return (
    <span class="nl-status" title={props.title ?? props.label}>
      <span class={`nl-dot nl-dot--${props.state}`} aria-hidden="true" />
      <span class={props.showLabel ? undefined : 'visually-hidden'}>{props.label}</span>
    </span>
  );
}
