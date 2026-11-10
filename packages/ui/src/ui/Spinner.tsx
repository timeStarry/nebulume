import './Spinner.css';

export default function Spinner(props: { size?: 'sm' | 'md'; label?: string }) {
  return (
    <span
      class={`nl-spinner nl-spinner--${props.size ?? 'md'}`}
      role={props.label ? 'status' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : 'true'}
    />
  );
}
