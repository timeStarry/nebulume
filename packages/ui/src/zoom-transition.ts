import { allowsFlourish } from './motion';

/**
 * The zoom between a grid tile and the in-window viewer. A copy of the tile's
 * decoded image flies between the two rectangles while the real views swap
 * underneath, so the photo appears to grow out of (and shrink back into) its
 * place. Runs only at the full motion level (src/motion.ts).
 */
const DURATION = 280;
const reducedMotion = () => !allowsFlourish();

/** Where a photo of `ratio` (width / height) sits when fitted inside `box`. */
export function fitRect(box: DOMRect, ratio: number): DOMRect {
  const width = Math.min(box.width, box.height * ratio);
  const height = width / ratio;
  return new DOMRect(
    box.left + (box.width - width) / 2,
    box.top + (box.height - height) / 2,
    width,
    height,
  );
}

export function fly(source: HTMLImageElement, from: DOMRect, to: () => DOMRect | undefined) {
  if (reducedMotion() || !source.currentSrc || from.width < 2 || from.height < 2) return;
  const ghost = document.createElement('img');
  ghost.src = source.currentSrc;
  ghost.alt = '';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.className = 'zoom-ghost';
  Object.assign(ghost.style, {
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
  });
  document.body.append(ghost);
  // Measure the destination once the next view has laid out.
  requestAnimationFrame(() => {
    const target = to();
    if (!target || target.width < 2) return ghost.remove();
    ghost.style.transition = `transform ${DURATION}ms cubic-bezier(.2, 0, 0, 1), opacity 120ms linear ${DURATION - 40}ms`;
    ghost.style.transform = `translate(${target.left - from.left}px, ${target.top - from.top}px) scale(${target.width / from.width}, ${target.height / from.height})`;
    ghost.style.opacity = '0';
    window.setTimeout(() => ghost.remove(), DURATION + 140);
  });
}
