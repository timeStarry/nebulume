import './Switch.css';

/** An on/off control. `label` is its accessible name (the visible text lives in the row). */
export default function Switch(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
  describedBy?: string;
}) {
  return (
    <span class="nl-switch">
      <input
        type="checkbox"
        role="switch"
        id={props.id}
        aria-label={props.label}
        aria-describedby={props.describedBy}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span aria-hidden="true" />
    </span>
  );
}
