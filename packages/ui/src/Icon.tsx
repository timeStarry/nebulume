import type { JSX } from 'solid-js';
const paths: Record<string, () => JSX.Element> = {
  grid: () => (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  photo: () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m3 16 5-5 4 4 3-3 6 6" />
    </>
  ),
  folder: () => (
    <path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  ),
  cloud: () => <path d="M6 18h12a4 4 0 0 0 .4-8A6.5 6.5 0 0 0 6 9a4.5 4.5 0 0 0 0 9Z" />,
  card: () => (
    <>
      <path d="M8 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
      <path d="M10 3v6h3V3m3 0v6" />
    </>
  ),
  plus: () => <path d="M12 5v14M5 12h14" />,
  search: () => (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  left: () => <path d="m14 6-6 6 6 6" />,
  right: () => <path d="m10 6 6 6-6 6" />,
  down: () => <path d="m6 9 6 6 6-6" />,
  crop: () => (
    <>
      <path d="M6 3v15h15M3 6h15v15" />
      <path d="m21 3-3 3M3 21l3-3" />
    </>
  ),
  export: () => (
    <>
      <path d="M12 16V3m-4 4 4-4 4 4M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    </>
  ),
  refresh: () => (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 6.1A8 8 0 0 1 19.5 10M4.5 14a8 8 0 0 0 13.4 3.9" />
    </>
  ),
  star: () => <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />,
  check: () => <path d="m5 12 4 4L19 6" />,
  close: () => <path d="m6 6 12 12M6 18 18 6" />,
  info: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7v.1" />
    </>
  ),
  settings: () => (
    <>
      <path d="m10.37 2.74 3.26 0 .35 2.34 1.62.68 1.4 1.06 2.2-.86 1.63 2.83-1.84 1.47.21 1.74-.21 1.74 1.84 1.47-1.63 2.83-2.2-.86-1.4 1.06-1.62.68-.35 2.34h-3.26l-.35-2.34-1.62-.68L7 17.18l-2.2.86-1.63-2.83 1.84-1.47L4.8 12l.21-1.74-1.84-1.47L4.8 5.96l2.2.86 1.4-1.06 1.62-.68Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  expand: () => <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />,
  minus: () => <path d="M5 12h14" />,
  menu: () => <path d="M4 6h16M4 12h16M4 18h16" />,
  clock: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
};
export default function Icon(props: { name: string; size?: number; class?: string }) {
  return (
    <svg
      class={props.class}
      width={props.size || 18}
      height={props.size || 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {(paths[props.name] || paths.photo)()}
    </svg>
  );
}
