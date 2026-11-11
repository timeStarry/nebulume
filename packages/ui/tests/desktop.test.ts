import { describe, expect, it } from 'vitest';
import { shouldSuppressNativeMenu } from '../src/desktop';

const element = (tagName: string, isContentEditable = false) =>
  ({ tagName, isContentEditable }) as unknown as EventTarget;

describe('native context menu', () => {
  it('is suppressed on ordinary interface elements', () => {
    expect(shouldSuppressNativeMenu(element('DIV'), '', false)).toBe(true);
    expect(shouldSuppressNativeMenu(element('BUTTON'), '', false)).toBe(true);
  });
  it('stays available in text fields and over selected text', () => {
    expect(shouldSuppressNativeMenu(element('INPUT'), '', false)).toBe(false);
    expect(shouldSuppressNativeMenu(element('DIV', true), '', false)).toBe(false);
    expect(shouldSuppressNativeMenu(element('DIV'), '/Volumes/SD/DCIM', false)).toBe(false);
  });
  it('a development override lets the inspector through', () => {
    expect(shouldSuppressNativeMenu(element('DIV'), '', true)).toBe(false);
  });
});
