import './Slider.css';

export default function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  onInput: (value: number) => void;
  class?: string;
}) {
  return (
    <input
      class={`nl-slider${props.class ? ` ${props.class}` : ''}`}
      type="range"
      aria-label={props.label}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      value={props.value}
      onInput={(event) => props.onInput(Number(event.currentTarget.value))}
    />
  );
}
