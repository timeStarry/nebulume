import { Show, splitProps, type JSX } from 'solid-js';
import Icon, { type IconName } from '../Icon';
import Kbd from './Kbd';
import './Field.css';

export default function TextInput(
  props: JSX.InputHTMLAttributes<HTMLInputElement> & {
    icon?: IconName;
    suffix?: string;
    shortcut?: string;
    invalid?: boolean;
    size?: 'sm' | 'md';
    ref?: HTMLInputElement | ((el: HTMLInputElement) => void);
    wrapClass?: string;
  },
) {
  const [own, rest] = splitProps(props, [
    'icon',
    'suffix',
    'shortcut',
    'invalid',
    'size',
    'class',
    'wrapClass',
    'ref',
  ]);
  return (
    <span
      class={`nl-input nl-input--${own.size ?? 'md'}${own.invalid ? ' nl-input--invalid' : ''}${rest.disabled ? ' nl-input--disabled' : ''}${own.wrapClass ? ` ${own.wrapClass}` : ''}`}
    >
      <Show when={own.icon}>{(name) => <Icon name={name()} />}</Show>
      <input
        {...rest}
        ref={own.ref as never}
        class={own.class}
        type={rest.type ?? 'text'}
        aria-invalid={own.invalid || undefined}
      />
      <Show when={own.suffix}>
        <span class="nl-input-suffix">{own.suffix}</span>
      </Show>
      <Show when={own.shortcut}>
        <Kbd>{own.shortcut}</Kbd>
      </Show>
    </span>
  );
}
