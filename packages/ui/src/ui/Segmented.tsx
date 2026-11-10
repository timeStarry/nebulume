import { For, Show } from 'solid-js';
import Icon, { type IconName } from '../Icon';
import './Segmented.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
}

/**
 * A row of mutually exclusive choices: view switches (`tablist`) or option groups
 * (`radiogroup`). Arrow keys move between options. `compact` shows icons only.
 */
export default function Segmented<T extends string>(props: {
  value: T | undefined;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
  role?: 'tablist' | 'radiogroup';
  compact?: boolean;
  class?: string;
}) {
  const role = () => props.role ?? 'tablist';
  const itemRole = () => (role() === 'tablist' ? 'tab' : 'radio');
  function key(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const enabled = props.options.filter((option) => !option.disabled);
    const at = enabled.findIndex((option) => option.value === props.value);
    const next =
      event.key === 'Home'
        ? enabled[0]
        : event.key === 'End'
          ? enabled.at(-1)
          : enabled[(at + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    if (!next) return;
    event.preventDefault();
    props.onChange(next.value);
    queueMicrotask(() =>
      (event.currentTarget as HTMLElement | null)
        ?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)
        ?.focus(),
    );
  }
  return (
    <div
      class={`nl-seg nl-seg--${props.size ?? 'md'}${props.compact ? ' nl-seg--compact' : ''}${props.class ? ` ${props.class}` : ''}`}
      role={role()}
      aria-label={props.label}
      onKeyDown={key}
    >
      <For each={props.options}>
        {(option) => {
          const selected = () => option.value === props.value;
          return (
            <button
              type="button"
              role={itemRole()}
              data-value={option.value}
              aria-selected={itemRole() === 'tab' ? selected() : undefined}
              aria-checked={itemRole() === 'radio' ? selected() : undefined}
              aria-label={props.compact ? option.label : undefined}
              aria-keyshortcuts={option.shortcut}
              tabIndex={
                selected() || (props.value === undefined && option === props.options[0]) ? 0 : -1
              }
              disabled={option.disabled}
              data-tooltip={props.compact ? option.label : undefined}
              onClick={() => props.onChange(option.value)}
            >
              <Show when={option.icon}>{(name) => <Icon name={name()} />}</Show>
              <Show when={!props.compact}>
                <span>{option.label}</span>
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}
