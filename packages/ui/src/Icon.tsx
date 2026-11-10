import { icons, type IconName } from './icons';

export type { IconName };

/** Tabler outline icon, bundled with the app. Decorative: always hidden from assistive tech. */
export default function Icon(props: { name: IconName; size?: number; class?: string }) {
  return (
    <svg
      class={props.class}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      innerHTML={icons[props.name] ?? icons.photo}
    />
  );
}
