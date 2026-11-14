import { splitProps, type JSX } from 'solid-js';
import Icon, { type IconName } from '../Icon';
import './IconButton.css';
import './Tooltip';

export type IconButtonSize = 'xs' | 'sm' | 'md';
const ICON_SIZE: Record<IconButtonSize, number> = { xs: 14, sm: 16, md: 18 };

/**
 * An icon-only button. `label` is its accessible name and hover tip; `title`, when given
 * (for example the reason it is disabled), replaces the tip with the native title.
 */
export default function IconButton(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: IconName;
    label: string;
    size?: IconButtonSize;
    shortcut?: string;
    pressed?: boolean;
    tipSide?: 'top' | 'bottom' | 'left' | 'right';
    tipAlign?: 'center' | 'start' | 'end';
  },
) {
  const [own, rest] = splitProps(props, [
    'icon',
    'label',
    'size',
    'shortcut',
    'pressed',
    'class',
    'title',
    'type',
    'tipSide',
    'tipAlign',
  ]);
  const size = () => own.size ?? 'md';
  return (
    <button
      {...rest}
      type={own.type ?? 'button'}
      class={`nl-icon-btn nl-icon-btn--${size()}${own.class ? ` ${own.class}` : ''}`}
      aria-label={own.label}
      aria-pressed={own.pressed === undefined ? undefined : own.pressed}
      aria-keyshortcuts={own.shortcut}
      title={own.title}
      data-tooltip={own.title ? undefined : own.label}
      data-kbd={own.title ? undefined : own.shortcut}
      data-tip-side={own.tipSide ?? 'bottom'}
      data-tip-align={own.tipAlign && own.tipAlign !== 'center' ? own.tipAlign : undefined}
    >
      <Icon name={own.icon} size={ICON_SIZE[size()]} />
    </button>
  );
}
