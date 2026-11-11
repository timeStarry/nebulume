import { createSignal } from 'solid-js';

/**
 * How much interface motion the user wants. `system` follows `prefers-reduced-motion`
 * (reduce → `reduced`, otherwise `full`). `full` keeps every transition, spring and glass;
 * `standard` keeps fades and slides but drops springs and the grid-to-viewer zoom;
 * `reduced` makes every transition instant. Only transform/opacity animate in any mode.
 */
export type MotionPreference = 'system' | 'full' | 'standard' | 'reduced';
export type ResolvedMotion = 'full' | 'standard' | 'reduced';
export const MOTION_STORAGE_KEY = 'nebulume.motion';

export function parseMotionPreference(value: string | null): MotionPreference {
  return value === 'full' || value === 'standard' || value === 'reduced' ? value : 'system';
}

export function resolveMotion(preference: MotionPreference, systemReduce: boolean): ResolvedMotion {
  if (preference !== 'system') return preference;
  return systemReduce ? 'reduced' : 'full';
}

function saved(): MotionPreference {
  try {
    return parseMotionPreference(localStorage.getItem(MOTION_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

const [motionPreference, updatePreference] = createSignal<MotionPreference>(saved());
const [resolvedMotion, updateResolved] = createSignal<ResolvedMotion>('full');
export { motionPreference, resolvedMotion };
let media: MediaQueryList | undefined;
let initialized = false;

function apply() {
  const motion = resolveMotion(motionPreference(), media?.matches ?? false);
  updateResolved(motion);
  document.documentElement.dataset.motion = motion;
}

export function initializeMotion() {
  if (initialized) return;
  initialized = true;
  media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  apply();
  media?.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key !== MOTION_STORAGE_KEY && event.key !== null) return;
    updatePreference(parseMotionPreference(event.key === null ? null : event.newValue));
    apply();
  });
}

export function setMotionPreference(preference: MotionPreference) {
  updatePreference(preference);
  try {
    localStorage.setItem(MOTION_STORAGE_KEY, preference);
  } catch {
    /* The choice still applies to this window. */
  }
  apply();
}

/** Spring and zoom flourishes run only in `full`. */
export const allowsFlourish = () => resolvedMotion() === 'full';
/** Any transition at all. */
export const allowsMotion = () => resolvedMotion() !== 'reduced';
