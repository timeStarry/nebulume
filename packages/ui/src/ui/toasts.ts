import { createSignal } from 'solid-js';

export interface ToastInput {
  message: string;
  tone?: 'neutral' | 'error';
  action?: { label: string; run: () => void };
}

const [current, setCurrent] = createSignal<ToastInput & { key: number }>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Single slot: a new toast replaces the old one. Errors stay until closed. */
export const toasts = {
  current,
  show(toast: ToastInput) {
    clearTimeout(timer);
    const next = { ...toast, key: Date.now() };
    setCurrent(next);
    if (toast.tone === 'error') return;
    timer = setTimeout(
      () => {
        if (current()?.key === next.key) setCurrent(undefined);
      },
      toast.action ? 10_000 : 6_000,
    );
  },
  dismiss() {
    clearTimeout(timer);
    setCurrent(undefined);
  },
};
