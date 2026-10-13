import { describe, expect, it } from 'vitest';
import {
  bytes,
  cropFromPoints,
  errorMessage,
  histogramFromPixels,
  imageRequestKey,
  isTextEntry,
  validCrop,
} from '../src/model';
import { demoCommand } from '../src/demo';

describe('non-destructive crop coordinates', () => {
  it('normalizes a reverse drag and clamps outside coordinates', () => {
    expect(cropFromPoints({ x: 0.8, y: 0.7 }, { x: -0.2, y: 0.1 })).toEqual({
      x: 0,
      y: 0.1,
      width: 0.8,
      height: 0.6,
    });
    expect(validCrop(cropFromPoints({ x: 0.2, y: 0.2 }, { x: 3, y: 3 }))).toBe(true);
  });
  it('keeps a click at the extreme edge inside the original image', () => {
    expect(validCrop(cropFromPoints({ x: 1, y: 1 }, { x: 1, y: 1 }))).toBe(true);
  });
  it('rejects empty, non-finite and overflowing crops', () => {
    for (const crop of [
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0.9, y: 0, width: 0.3, height: 1 },
      { x: -0.1, y: 0, width: 1, height: 1 },
      { x: NaN, y: 0, width: 1, height: 1 },
    ])
      expect(validCrop(crop)).toBe(false);
  });
  it('invalidates preview and histogram after crop/reset, while uncropped edits share a source', () => {
    const original = { id: 'one', crop: null };
    const edited = { id: 'one', crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } };
    expect(imageRequestKey(original)).not.toBe(imageRequestKey(edited));
    expect(imageRequestKey(original, true)).toBe(imageRequestKey(edited, true));
    expect(imageRequestKey(edited)).toBe(imageRequestKey({ ...edited }));
  });
});

describe('real pixel histogram', () => {
  it('counts RGB and luminance bins while excluding fully transparent pixels', () => {
    const histogram = histogramFromPixels(
      new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 25, 25, 25, 0]),
    );
    expect(histogram.pixels).toBe(3);
    expect(histogram.red[255]).toBe(1);
    expect(histogram.red[0]).toBe(2);
    expect(histogram.green[255]).toBe(1);
    expect(histogram.blue[255]).toBe(1);
    expect(histogram.luminance[54]).toBe(1);
    expect(histogram.luminance[182]).toBe(1);
    expect(histogram.luminance[18]).toBe(1);
    expect(histogram.luminance.reduce((sum, n) => sum + n, 0)).toBe(3);
  });
});

describe('keyboard and honest browser capability boundaries', () => {
  it('does not capture typing in inputs, selects or editable content', () => {
    expect(isTextEntry({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTextEntry({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(
      true,
    );
    expect(
      isTextEntry({ tagName: 'DIV', isContentEditable: false } as unknown as EventTarget),
    ).toBe(false);
  });
  it('rejects native import and network operations instead of returning fake success', async () => {
    await expect(demoCommand('import.execute', { plan_id: 'not-real' })).rejects.toThrow('桌面版');
    await expect(demoCommand('storage.fetch', { id: 'not-real' })).rejects.toThrow('桌面版');
  });
  it('preserves service errors including JSON-encoded Tauri rejections', () => {
    expect(errorMessage({ code: 'no_permission', message: '无法访问文件夹' })).toBe(
      '无法访问文件夹',
    );
    expect(errorMessage('{"code":"codec","message":"unsupported RAW"}')).toBe('unsupported RAW');
  });
  it('handles unknown sizes without pretending they are empty files', () => {
    expect(bytes(1024)).toBe('1 KB');
    expect(bytes(NaN)).toBe('—');
    expect(bytes(0)).toBe('0 B');
  });
});
