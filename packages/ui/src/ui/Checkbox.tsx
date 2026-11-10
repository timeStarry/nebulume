import { Show, type JSX } from 'solid-js';
import './Switch.css';

export default function Checkbox(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: JSX.Element;
  help?: string;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <label class="nl-check">
      <input
        type="checkbox"
        name={props.name}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>
        {props.children}
        <Show when={props.help}>
          <span class="nl-check-help">{props.help}</span>
        </Show>
      </span>
    </label>
  );
}
