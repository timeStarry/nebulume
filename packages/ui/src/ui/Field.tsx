import { Show, createUniqueId, type JSX } from 'solid-js';
import './Field.css';

/** Label above, help or error below; the child receives the id to put on its control. */
export default function Field(props: {
  label: string;
  help?: string;
  error?: string;
  children: (id: string, describedBy?: string) => JSX.Element;
}) {
  const id = createUniqueId();
  const describedBy = () => (props.error || props.help ? `${id}-help` : undefined);
  return (
    <div class="nl-field">
      <label for={id}>{props.label}</label>
      {props.children(id, describedBy())}
      <Show when={props.error || props.help}>
        <span
          id={`${id}-help`}
          class={`nl-field-help${props.error ? ' nl-field-help--error' : ''}`}
        >
          {props.error || props.help}
        </span>
      </Show>
    </div>
  );
}
