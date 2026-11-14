export const TOOLTIP_GAP = 6;
export const TOOLTIP_MARGIN = 8;

export function computeTooltipPosition(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
  tipSize: { width: number; height: number },
  viewport: { width: number; height: number },
  side: 'top' | 'bottom' | 'left' | 'right' = 'bottom',
  align: 'center' | 'start' | 'end' = 'center',
): { x: number; y: number } {
  const { width: tw, height: th } = tipSize;
  const { width: vw, height: vh } = viewport;

  let effectiveSide = side;
  if (
    side === 'bottom' &&
    rect.bottom + TOOLTIP_GAP + th > vh - TOOLTIP_MARGIN &&
    rect.top - TOOLTIP_GAP - th >= TOOLTIP_MARGIN
  ) {
    effectiveSide = 'top';
  } else if (
    side === 'top' &&
    rect.top - TOOLTIP_GAP - th < TOOLTIP_MARGIN &&
    rect.bottom + TOOLTIP_GAP + th <= vh - TOOLTIP_MARGIN
  ) {
    effectiveSide = 'bottom';
  } else if (
    side === 'right' &&
    rect.right + TOOLTIP_GAP + tw > vw - TOOLTIP_MARGIN &&
    rect.left - TOOLTIP_GAP - tw >= TOOLTIP_MARGIN
  ) {
    effectiveSide = 'left';
  } else if (
    side === 'left' &&
    rect.left - TOOLTIP_GAP - tw < TOOLTIP_MARGIN &&
    rect.right + TOOLTIP_GAP + tw <= vw - TOOLTIP_MARGIN
  ) {
    effectiveSide = 'right';
  }

  let x = 0;
  let y = 0;

  if (effectiveSide === 'top' || effectiveSide === 'bottom') {
    y = effectiveSide === 'bottom' ? rect.bottom + TOOLTIP_GAP : rect.top - TOOLTIP_GAP - th;
    if (align === 'start') x = rect.left;
    else if (align === 'end') x = rect.right - tw;
    else x = rect.left + (rect.width - tw) / 2;
  } else {
    x = effectiveSide === 'right' ? rect.right + TOOLTIP_GAP : rect.left - TOOLTIP_GAP - tw;
    if (align === 'start') y = rect.top;
    else if (align === 'end') y = rect.bottom - th;
    else y = rect.top + (rect.height - th) / 2;
  }

  x = Math.max(TOOLTIP_MARGIN, Math.min(x, Math.max(TOOLTIP_MARGIN, vw - tw - TOOLTIP_MARGIN)));
  y = Math.max(TOOLTIP_MARGIN, Math.min(y, Math.max(TOOLTIP_MARGIN, vh - th - TOOLTIP_MARGIN)));
  return { x: Math.round(x), y: Math.round(y) };
}
