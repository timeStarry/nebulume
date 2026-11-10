import type { JSX } from 'solid-js';
import './Switch.css';

export default function Radio(props: {
  checked: boolean;
  onChange: () => void;
  name: string;
  value?: string;
  children: JSX.Element;
  disabled?: boolean;
}) {
  return (
    <label class="nl-check">
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        onChange={() => props.onChange()}
      />
      <span>{props.children}</span>
    </label>
  );
}
