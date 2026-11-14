import type { JSX } from 'solid-js';
import { computeTooltipPosition } from './tooltip-layout';
import './Tooltip.css';

export { computeTooltipPosition };

const SHOW_DELAY_MS = 420;
const WARM_DELAY_MS = 80;
const WARM_WINDOW_MS = 280;

let installedDoc: Document | null = null;

function shouldSuppress(anchor: HTMLElement): boolean {
  if (!anchor.isConnected) return true;
  const text = anchor.dataset.tooltip?.trim();
  if (!text) return true;
  if (anchor.hasAttribute('title') && anchor.getAttribute('title')) return true;
  if (anchor.getAttribute('aria-expanded') === 'true') return true;
  if ((anchor as HTMLButtonElement).disabled || anchor.getAttribute('aria-disabled') === 'true') {
    return true;
  }
  if (anchor.classList.contains('nl-rail-item') && window.innerWidth <= 959) return true;
  return false;
}

/**
 * Installs a single body-portaled tooltip layer for all `[data-tooltip]` elements.
 * Rendering on `document.body` (`position: fixed`) prevents any scroll/overflow container
 * (such as `.library-sidebar`, `.dialog-body`, or `.inspector-body`) from clipping hover tips.
 */
export function installGlobalTooltips(): void {
  if (typeof document === 'undefined' || installedDoc === document) return;
  installedDoc = document;

  let tipEl: HTMLDivElement | null = null;
  let labelEl: HTMLSpanElement | null = null;
  let kbdEl: HTMLElement | null = null;
  let activeAnchor: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = false;
  let lastHiddenAt = 0;
  let observer: MutationObserver | null = null;

  function ensureLayer() {
    if (tipEl && tipEl.isConnected) return;
    if (!document.body) return;
    tipEl = document.createElement('div');
    tipEl.className = 'nl-floating-tooltip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.setAttribute('aria-hidden', 'true');
    labelEl = document.createElement('span');
    labelEl.className = 'nl-floating-tooltip__label';
    kbdEl = document.createElement('kbd');
    kbdEl.className = 'nl-floating-tooltip__kbd';
    tipEl.append(labelEl, kbdEl);
    document.body.appendChild(tipEl);
  }

  function syncAndPlace(anchor: HTMLElement) {
    ensureLayer();
    if (!tipEl || !labelEl || !kbdEl) return false;
    if (shouldSuppress(anchor)) return false;
    const rect = anchor.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    labelEl.textContent = anchor.dataset.tooltip ?? '';
    const kbd = anchor.dataset.kbd?.trim() ?? '';
    if (kbd) {
      kbdEl.textContent = kbd;
      kbdEl.hidden = false;
    } else {
      kbdEl.textContent = '';
      kbdEl.hidden = true;
    }
    tipEl.classList.toggle('nl-floating-tooltip--viewer', !!anchor.closest('.immersive-viewer'));

    const side = (anchor.dataset.tipSide as 'top' | 'bottom' | 'left' | 'right') || 'bottom';
    const align = (anchor.dataset.tipAlign as 'center' | 'start' | 'end') || 'center';
    const tipRect = tipEl.getBoundingClientRect();
    const { x, y } = computeTooltipPosition(
      rect,
      { width: tipRect.width, height: tipRect.height },
      { width: window.innerWidth || 1024, height: window.innerHeight || 768 },
      side,
      align,
    );
    tipEl.style.left = `${x}px`;
    tipEl.style.top = `${y}px`;
    return true;
  }

  function hide() {
    clearTimeout(timer);
    timer = undefined;
    observer?.disconnect();
    observer = null;
    activeAnchor = null;
    if (visible) {
      visible = false;
      lastHiddenAt = Date.now();
      if (tipEl) {
        tipEl.dataset.open = 'false';
        tipEl.setAttribute('aria-hidden', 'true');
      }
    }
  }

  function showNow(anchor: HTMLElement) {
    if (!syncAndPlace(anchor)) {
      hide();
      return;
    }
    visible = true;
    tipEl!.dataset.open = 'true';
    tipEl!.setAttribute('aria-hidden', 'false');
    observer?.disconnect();
    observer = new MutationObserver(() => {
      if (!activeAnchor || !syncAndPlace(activeAnchor)) hide();
    });
    observer.observe(anchor, {
      attributes: true,
      attributeFilter: ['data-tooltip', 'data-kbd', 'aria-expanded', 'disabled', 'aria-disabled'],
    });
  }

  function schedule(anchor: HTMLElement) {
    if (activeAnchor === anchor) return;
    clearTimeout(timer);
    observer?.disconnect();
    observer = null;
    if (shouldSuppress(anchor)) {
      hide();
      return;
    }
    activeAnchor = anchor;
    const warm = visible || Date.now() - lastHiddenAt < WARM_WINDOW_MS;
    if (visible && tipEl) {
      tipEl.dataset.open = 'false';
      visible = false;
    }
    timer = setTimeout(
      () => {
        if (activeAnchor === anchor) showNow(anchor);
      },
      warm ? WARM_DELAY_MS : SHOW_DELAY_MS,
    );
  }

  document.addEventListener(
    'pointerover',
    (event) => {
      if (event.pointerType === 'touch') return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLElement>('[data-tooltip]') ?? null;
      if (!anchor) {
        if (activeAnchor) hide();
        return;
      }
      schedule(anchor);
    },
    { passive: true },
  );

  document.addEventListener(
    'pointerout',
    (event) => {
      if (!activeAnchor) return;
      const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (related && activeAnchor.contains(related)) return;
      hide();
    },
    { passive: true },
  );

  document.addEventListener('focusin', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target || !target.matches(':focus-visible')) return;
    const anchor = target.closest<HTMLElement>('[data-tooltip]');
    if (anchor) schedule(anchor);
  });

  document.addEventListener('focusout', () => hide());
  document.addEventListener('pointerdown', () => hide(), true);
  document.addEventListener('keydown', () => hide(), true);
  window.addEventListener('scroll', () => hide(), { capture: true, passive: true });
  window.addEventListener('resize', () => hide(), { passive: true });
  window.addEventListener('blur', () => hide());
}

installGlobalTooltips();

/** Hover and focus tip for any element; rendered in a viewport-clamped top-layer portal. */
export default function Tooltip(props: {
  label: string;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'center' | 'start' | 'end';
  children: JSX.Element;
}) {
  return (
    <span
      class="nl-tip-host"
      data-tooltip={props.label}
      data-kbd={props.shortcut}
      data-tip-side={props.side ?? 'bottom'}
      data-tip-align={props.align && props.align !== 'center' ? props.align : undefined}
    >
      {props.children}
    </span>
  );
}
