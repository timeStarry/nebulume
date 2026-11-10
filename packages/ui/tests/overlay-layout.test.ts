import { describe, expect, test } from 'vitest';
import {
  DEFAULT_OVERLAY,
  addWidget,
  moveWidget,
  readOverlay,
  readOverlayFades,
  removeWidget,
  shiftWidget,
  widgetsNotIn,
  writeOverlay,
} from '../src/overlay-layout';

const store = (value: string | null) => ({ getItem: () => value });
const known = new Set([
  'captured',
  'rating',
  'flag',
  'body-lens',
  'exposure',
  'histogram',
  'iso',
  'gps',
]);

describe('overlay layout', () => {
  test('missing or corrupt storage gives the default', () => {
    expect(readOverlay(store(null), known)).toEqual(DEFAULT_OVERLAY);
    expect(readOverlay(store('{oops'), known)).toEqual(DEFAULT_OVERLAY);
    expect(readOverlay(store('[1,2]'), known)).toEqual(DEFAULT_OVERLAY);
    expect(readOverlay(store('{"tl":"captured"}'), known)).toEqual(DEFAULT_OVERLAY);
  });
  test('unknown ids and duplicates are dropped, missing corners are empty', () => {
    expect(
      readOverlay(
        store(JSON.stringify({ tl: ['iso', 'nope'], tr: ['iso', 'flag'], bl: [] })),
        known,
      ),
    ).toEqual({ tl: ['iso'], tr: ['flag'], bl: [], br: [] });
  });
  test('an emptied layout stays empty', () => {
    expect(readOverlay(store(JSON.stringify({ tl: [], tr: [], bl: [], br: [] })), known)).toEqual({
      tl: [],
      tr: [],
      bl: [],
      br: [],
    });
  });
  test('the layout round-trips through storage', () => {
    let saved: string | null = null;
    writeOverlay(
      { setItem: (_key: string, value: string) => (saved = value) },
      { ...DEFAULT_OVERLAY, br: ['gps'] },
    );
    expect(readOverlay(store(saved), known).br).toEqual(['gps']);
  });
  test('moving keeps one copy and appends with -1', () => {
    const layout = moveWidget(DEFAULT_OVERLAY, 'rating', 'bl', -1);
    expect(layout.tr).toEqual(['flag']);
    expect(layout.bl).toEqual(['body-lens', 'exposure', 'rating']);
    expect(moveWidget(DEFAULT_OVERLAY, 'flag', 'tr', 0).tr).toEqual(['flag', 'rating']);
  });
  test('shift clamps at the ends', () => {
    expect(shiftWidget(DEFAULT_OVERLAY, 'body-lens', -1).bl).toEqual(['body-lens', 'exposure']);
    expect(shiftWidget(DEFAULT_OVERLAY, 'body-lens', 1).bl).toEqual(['exposure', 'body-lens']);
  });
  test('add, remove and what is left for the tray', () => {
    const added = addWidget(DEFAULT_OVERLAY, 'iso', 'tl');
    expect(added.tl).toEqual(['captured', 'iso']);
    expect(removeWidget(added, 'iso').tl).toEqual(['captured']);
    expect(widgetsNotIn(added, ['iso', 'gps', 'captured'])).toEqual(['gps']);
  });
  test('the default is never mutated', () => {
    moveWidget(DEFAULT_OVERLAY, 'rating', 'bl', -1);
    expect(DEFAULT_OVERLAY.tr).toEqual(['rating', 'flag']);
  });
  test('fades default to off', () => {
    expect(readOverlayFades(store(null))).toBe(false);
    expect(readOverlayFades(store('true'))).toBe(true);
  });
});

describe('widget registry', async () => {
  const { WIDGETS, WIDGET_IDS } = await import('../src/viewer-widgets');
  test('every default widget exists and ids are unique', () => {
    for (const id of Object.values(DEFAULT_OVERLAY).flat()) expect(WIDGET_IDS.has(id)).toBe(true);
    expect(WIDGET_IDS.size).toBe(WIDGETS.length);
  });
  test('a photo without EXIF renders no widget content', () => {
    const bare = { id: 'a', filename: 'a.png', metadata: {}, rating: 0, flag: 'none' } as never;
    const empty = WIDGETS.filter((widget) => !['filename', 'format'].includes(widget.id)).map(
      (widget) => widget.render(bare, { index: 1, total: 1 }),
    );
    for (const result of empty) expect(result).toBeNull();
  });
});
