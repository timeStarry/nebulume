import { describe, expect, it } from 'vitest';
import {
  BUILTIN_EXPORT_PRESETS,
  DEFAULT_EXPORT_RECIPE,
  clampExportRecipe,
  exportPrefixError,
  formatExportFilename,
  readLastExportState,
  readUserExportPresets,
  removeUserExportPreset,
  saveUserExportPreset,
  writeLastExportState,
} from '../src/export-presets';
import {
  companionGroupKey,
  defaultOrganizeRules,
  organizeExample,
  renamePrefixError,
} from '../src/workspace';

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('export presets and photographer delivery naming', () => {
  it('provides five calibrated built-in presets covering master, review, social, print, and P3', () => {
    expect(BUILTIN_EXPORT_PRESETS.map((item) => item.id)).toEqual([
      'master',
      'review_4k',
      'social_2k',
      'print_adobe',
      'apple_p3',
    ]);
    const review = BUILTIN_EXPORT_PRESETS.find((item) => item.id === 'review_4k')!;
    expect(review.recipe).toEqual({
      maxEdge: 3840,
      quality: 90,
      colorSpace: 'srgb',
      naming: 'date_stem',
      customPrefix: 'Review',
    });
  });

  it('clamps quality, max long edge, color space, and naming safely', () => {
    expect(
      clampExportRecipe({
        maxEdge: 99,
        quality: 10,
        colorSpace: 'invalid' as never,
        naming: 'unknown' as never,
      }),
    ).toEqual({
      maxEdge: 256,
      quality: 30,
      colorSpace: 'preserve',
      naming: 'edited',
      customPrefix: 'Export',
    });
    expect(clampExportRecipe({ maxEdge: 99999, quality: 105 }).maxEdge).toBe(16384);
    expect(clampExportRecipe({ maxEdge: null, quality: 105 }).quality).toBe(100);
  });

  it('formats edited, original, date_stem, prefix_seq, and collision suffixes without overwriting', () => {
    const sample = { filename: 'DSC_0042.NEF', captured_at: '2026-10-22T18:05:11' };
    expect(formatExportFilename({ ...DEFAULT_EXPORT_RECIPE, naming: 'edited' }, sample)).toBe(
      'DSC_0042-edited.jpg',
    );
    expect(formatExportFilename({ ...DEFAULT_EXPORT_RECIPE, naming: 'original' }, sample)).toBe(
      'DSC_0042.jpg',
    );
    expect(formatExportFilename({ ...DEFAULT_EXPORT_RECIPE, naming: 'date_stem' }, sample)).toBe(
      '20261022_DSC_0042.jpg',
    );
    expect(
      formatExportFilename(
        { ...DEFAULT_EXPORT_RECIPE, naming: 'prefix_seq', customPrefix: 'Wedding' },
        sample,
        7,
      ),
    ).toBe('Wedding_0007.jpg');
    expect(
      formatExportFilename(
        { ...DEFAULT_EXPORT_RECIPE, naming: 'prefix_seq', customPrefix: 'Wedding' },
        sample,
        7,
        3,
      ),
    ).toBe('Wedding_0007-3.jpg');
  });

  it('validates custom export and ingest prefixes against path traversal and reserved names', () => {
    expect(exportPrefixError('Client_A')).toBe('');
    expect(exportPrefixError('../escape')).not.toBe('');
    expect(exportPrefixError('CON')).not.toBe('');
    expect(renamePrefixError('Editorial')).toBe('');
    expect(renamePrefixError('a/b')).not.toBe('');
    expect(renamePrefixError('NUL')).not.toBe('');
  });

  it('saves, updates, removes custom presets and remembers last export state', () => {
    const store = memoryStorage();
    const saved = saveUserExportPreset(
      '杂志选片 3000',
      {
        maxEdge: 3000,
        quality: 88,
        colorSpace: 'display_p3',
        naming: 'prefix_seq',
        customPrefix: 'Vogue',
      },
      store,
    );
    expect(readUserExportPresets(store)).toHaveLength(1);
    expect(saved.description).toContain('3000 px');
    writeLastExportState(
      { presetId: saved.id, recipe: saved.recipe, directory: '/Exports/Magazine' },
      store,
    );
    expect(readLastExportState(store)).toEqual({
      presetId: saved.id,
      recipe: saved.recipe,
      directory: '/Exports/Magazine',
    });
    expect(removeUserExportPreset(saved.id, store)).toEqual([]);
  });

  it('groups RAW + JPEG + XMP companions and previews ingest rename examples', () => {
    expect(companionGroupKey('/Volumes/CARD/DCIM/100MSDCF/_DSC1024.ARW')).toBe(
      companionGroupKey('/Volumes/CARD/DCIM/100MSDCF/_DSC1024.xmp'),
    );
    expect(companionGroupKey('/Volumes/CARD/DCIM/100MSDCF/_DSC1024.JPG')).toBe(
      companionGroupKey('/Volumes/CARD/DCIM/100MSDCF/_DSC1024.ARW'),
    );
    const seqExample = organizeExample({
      ...defaultOrganizeRules(),
      rename_mode: 'date_prefix_seq',
      rename_prefix: 'Shoot',
    });
    expect(seqExample).toBe('2026-10-22/20261022_Shoot_0001.NEF');
  });
});
