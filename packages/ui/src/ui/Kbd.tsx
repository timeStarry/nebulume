import type { JSX } from 'solid-js';
import './Kbd.css';

export default function Kbd(props: { children: JSX.Element }) {
  return <kbd class="nl-kbd">{props.children}</kbd>;
}
