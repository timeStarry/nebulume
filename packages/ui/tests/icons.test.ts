import { describe, expect, test } from 'vitest';
import { icons } from '../src/icons';

const legacy = [
  'grid',
  'photo',
  'folder',
  'cloud',
  'card',
  'plus',
  'search',
  'left',
  'right',
  'down',
  'crop',
  'export',
  'refresh',
  'star',
  'check',
  'close',
  'info',
  'settings',
  'expand',
  'minus',
  'menu',
  'clock',
  'filter',
  'more',
  'sort-desc',
  'sort-asc',
];

describe('bundled icons', () => {
  test('every legacy icon name still resolves', () => {
    for (const name of legacy)
      expect(icons[name as keyof typeof icons]).toMatch(/<(path|circle|rect|line|polyline)/);
  });
  test('no filled variants are bundled', () => {
    expect(Object.keys(icons).some((key) => key.endsWith('-filled'))).toBe(false);
  });
});
