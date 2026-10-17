import { describe, expect, it } from 'vitest';
import { parseThemePreference, resolveTheme } from '../src/theme';

describe('appearance preference', () => {
  it('uses the approved dark default for missing or invalid stored preferences', () => {
    for (const value of [null, '', 'auto', 'LIGHT', 'malformed']) {
      expect(parseThemePreference(value)).toBe('dark');
    }
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('system')).toBe('system');
  });

  it('only follows system changes when the user selected the system preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
  });
});
