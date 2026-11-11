import { describe, expect, it } from 'vitest';
import { parseMotionPreference, resolveMotion } from '../src/motion';

describe('motion preference', () => {
  it('defaults to following the system', () => {
    for (const value of [null, '', 'none', 'FULL'])
      expect(parseMotionPreference(value)).toBe('system');
    expect(parseMotionPreference('standard')).toBe('standard');
  });
  it('the system setting gives full motion unless the OS asks for less', () => {
    expect(resolveMotion('system', false)).toBe('full');
    expect(resolveMotion('system', true)).toBe('reduced');
  });
  it('an explicit choice overrides the OS in both directions', () => {
    expect(resolveMotion('full', true)).toBe('full');
    expect(resolveMotion('reduced', false)).toBe('reduced');
    expect(resolveMotion('standard', true)).toBe('standard');
  });
});
