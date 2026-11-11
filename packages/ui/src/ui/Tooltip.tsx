import type { JSX } from 'solid-js';
import './Tooltip.css';

/** Hover and focus tip for any element; appears after 500ms. */
export default function Tooltip(props: {
  label: string;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: JSX.Element;
}) {
  return (
    <span
      class="nl-tip-host"
      data-tooltip={props.label}
      data-kbd={props.shortcut}
      data-tip-side={props.side ?? 'bottom'}
    >
      {props.children}
    </span>
  );
}
