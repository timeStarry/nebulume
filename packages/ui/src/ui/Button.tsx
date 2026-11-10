import { Show, splitProps, type JSX } from 'solid-js';
import Icon, { type IconName } from '../Icon';
import Spinner from './Spinner';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export default function Button(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: IconName;
    busy?: boolean;
  },
) {
  const [own, rest] = splitProps(props, [
    'variant',
    'size',
    'icon',
    'busy',
    'class',
    'children',
    'disabled',
    'type',
  ]);
  return (
    <button
      {...rest}
      type={own.type ?? 'button'}
      disabled={own.disabled || own.busy}
      aria-busy={own.busy || undefined}
      class={`nl-btn nl-btn--${own.variant ?? 'secondary'} nl-btn--${own.size ?? 'md'}${own.class ? ` ${own.class}` : ''}`}
    >
      <Show
        when={own.busy}
        fallback={<Show when={own.icon}>{(name) => <Icon name={name()} />}</Show>}
      >
        <Spinner size="sm" />
      </Show>
      {own.children}
    </button>
  );
}
