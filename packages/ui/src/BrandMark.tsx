import colorMark from './assets/brand-mark.svg';
import inkMark from './assets/brand-mark-ink.svg';
import { resolvedTheme } from './theme';

export default function BrandMark(props: { class?: string; size?: number }) {
  return (
    <img
      class={`brand-mark${props.class ? ` ${props.class}` : ''}`}
      src={resolvedTheme() === 'light' ? inkMark : colorMark}
      width={props.size ?? 36}
      height={props.size ?? 36}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
