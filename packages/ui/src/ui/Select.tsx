import { For, splitProps, type JSX } from 'solid-js';
import Icon from '../Icon';
import './Field.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export default function Select(
  props: Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> & {
    value: string;
    options: SelectOption[];
    onChange: (value: string) => void;
    size?: 'sm' | 'md';
    wrapClass?: string;
    ref?: HTMLSelectElement | ((el: HTMLSelectElement) => void);
  },
) {
  const [own, rest] = splitProps(props, [
    'value',
    'options',
    'onChange',
    'size',
    'wrapClass',
    'ref',
  ]);
  return (
    <span
      class={`nl-select nl-select--${own.size ?? 'md'}${rest.disabled ? ' nl-select--disabled' : ''}${own.wrapClass ? ` ${own.wrapClass}` : ''}`}
    >
      <select
        {...rest}
        ref={own.ref as never}
        value={own.value}
        onChange={(event) => own.onChange(event.currentTarget.value)}
      >
        <For each={own.options}>
          {(option) => (
            <option
              value={option.value}
              disabled={option.disabled}
              selected={option.value === own.value}
            >
              {option.label}
            </option>
          )}
        </For>
      </select>
      <Icon name="chevron-down" size={14} />
    </span>
  );
}
