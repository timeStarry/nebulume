/**
 * Pure preset and naming logic for photographer delivery exports.
 * Keeps color space, long-edge sizing, JPEG quality, and filename templates
 * independent from SolidJS components.
 */

export type ExportColorSpace = 'preserve' | 'srgb' | 'display_p3' | 'adobe_rgb';
export type ExportNamingMode = 'edited' | 'original' | 'date_stem' | 'prefix_seq';

export interface ExportRecipe {
  /** Maximum pixel length of the longer edge, or `null` for original cropped size. */
  maxEdge: number | null;
  /** JPEG encoding quality (`30..=100`). */
  quality: number;
  /** Output ICC gamut conversion / embedding policy. */
  colorSpace: ExportColorSpace;
  /** Destination filename rule. */
  naming: ExportNamingMode;
  /** Custom prefix used when `naming === 'prefix_seq'`. */
  customPrefix: string;
}

export interface ExportPreset {
  id: string;
  name: string;
  description: string;
  builtin?: boolean;
  recipe: ExportRecipe;
}

export const BUILTIN_EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: 'master',
    name: '原尺寸母版',
    description: '原尺寸 · 95% 品质 · 保留原色彩配置',
    builtin: true,
    recipe: {
      maxEdge: null,
      quality: 95,
      colorSpace: 'preserve',
      naming: 'edited',
      customPrefix: 'Export',
    },
  },
  {
    id: 'review_4k',
    name: '客户审片 4K',
    description: '长边 3840 px · 90% 品质 · sRGB 标准色域',
    builtin: true,
    recipe: {
      maxEdge: 3840,
      quality: 90,
      colorSpace: 'srgb',
      naming: 'date_stem',
      customPrefix: 'Review',
    },
  },
  {
    id: 'social_2k',
    name: '社媒与网页 2K',
    description: '长边 2048 px · 85% 品质 · sRGB 标准色域',
    builtin: true,
    recipe: {
      maxEdge: 2048,
      quality: 85,
      colorSpace: 'srgb',
      naming: 'edited',
      customPrefix: 'Social',
    },
  },
  {
    id: 'print_adobe',
    name: '商业印刷母版',
    description: '原尺寸 · 100% 品质 · Adobe RGB (1998)',
    builtin: true,
    recipe: {
      maxEdge: null,
      quality: 100,
      colorSpace: 'adobe_rgb',
      naming: 'original',
      customPrefix: 'Print',
    },
  },
  {
    id: 'apple_p3',
    name: '广色域展示 P3',
    description: '原尺寸 · 92% 品质 · Display P3',
    builtin: true,
    recipe: {
      maxEdge: null,
      quality: 92,
      colorSpace: 'display_p3',
      naming: 'edited',
      customPrefix: 'Display',
    },
  },
];

export const DEFAULT_EXPORT_RECIPE: ExportRecipe = { ...BUILTIN_EXPORT_PRESETS[0].recipe };

const PRESETS_KEY = 'nebulume.export-presets.v1';
const LAST_EXPORT_KEY = 'nebulume.export-last.v1';

export function exportPrefixError(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.length > 40) return '前缀最多 40 个字符。';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(value.split('.')[0]))
    return '前缀不能使用系统保留名。';
  if (value === '.' || value === '..' || /^[.]|[.]$/.test(value) || /[\\/:*?"<>|\u0000-\u001f]/.test(value))
    return '前缀不能包含路径分隔符或特殊字符。';
  return '';
}

export function sanitizeExportPrefix(raw: string): string {
  const cleaned = raw.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned.slice(0, 40) || 'Export';
}

export function clampExportRecipe(recipe: Partial<ExportRecipe>): ExportRecipe {
  const rawEdge = recipe.maxEdge;
  const maxEdge =
    typeof rawEdge === 'number' && Number.isFinite(rawEdge) && rawEdge > 0
      ? Math.min(16384, Math.max(256, Math.round(rawEdge)))
      : null;
  const rawQuality = typeof recipe.quality === 'number' ? recipe.quality : 95;
  const quality = Math.min(100, Math.max(30, Math.round(rawQuality)));
  const colorSpace: ExportColorSpace =
    recipe.colorSpace === 'srgb' ||
    recipe.colorSpace === 'display_p3' ||
    recipe.colorSpace === 'adobe_rgb' ||
    recipe.colorSpace === 'preserve'
      ? recipe.colorSpace
      : 'preserve';
  const naming: ExportNamingMode =
    recipe.naming === 'edited' ||
    recipe.naming === 'original' ||
    recipe.naming === 'date_stem' ||
    recipe.naming === 'prefix_seq'
      ? recipe.naming
      : 'edited';
  return {
    maxEdge,
    quality,
    colorSpace,
    naming,
    customPrefix: typeof recipe.customPrefix === 'string' ? recipe.customPrefix : 'Export',
  };
}

export function formatExportFilename(
  recipe: ExportRecipe,
  asset: { filename: string; captured_at?: string },
  seq = 1,
  collisionAttempt = 1,
): string {
  const stem = asset.filename.replace(/\.[^.]+$/, '') || 'photo';
  const rawDay = asset.captured_at?.slice(0, 10) || '';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay.replaceAll('-', '') : '00000000';
  let base: string;
  switch (recipe.naming) {
    case 'original':
      base = stem;
      break;
    case 'date_stem':
      base = `${day}_${stem}`;
      break;
    case 'prefix_seq':
      base = `${sanitizeExportPrefix(recipe.customPrefix)}_${String(Math.max(1, seq)).padStart(4, '0')}`;
      break;
    case 'edited':
    default:
      base = `${stem}-edited`;
      break;
  }
  const suffix = collisionAttempt > 1 ? `-${collisionAttempt}` : '';
  return `${base}${suffix}.jpg`;
}

export function exampleExportName(
  recipe: ExportRecipe,
  sample: { filename: string; captured_at?: string } = {
    filename: 'DSC_0042.NEF',
    captured_at: '2026-10-22T16:30:00',
  },
): string {
  return formatExportFilename(recipe, sample, 1, 1);
}

export function colorSpaceLabel(space: ExportColorSpace): string {
  return {
    preserve: '保留原色彩配置',
    srgb: 'sRGB IEC61966-2.1',
    display_p3: 'Display P3',
    adobe_rgb: 'Adobe RGB (1998)',
  }[space];
}

export function readUserExportPresets(storage?: Pick<Storage, 'getItem'>): ExportPreset[] {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(PRESETS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: String(item.description || ''),
        builtin: false,
        recipe: clampExportRecipe(item.recipe || {}),
      }));
  } catch {
    return [];
  }
}

export function describeRecipe(recipe: ExportRecipe): string {
  const size = recipe.maxEdge ? `长边 ${recipe.maxEdge} px` : '原尺寸';
  return `${size} · ${recipe.quality}% 品质 · ${colorSpaceLabel(recipe.colorSpace)}`;
}

export function saveUserExportPreset(
  name: string,
  recipe: ExportRecipe,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): ExportPreset {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  const trimmed = name.trim().slice(0, 40) || '自定义预设';
  const existing = readUserExportPresets(store);
  const clean = clampExportRecipe(recipe);
  const found = existing.find((item) => item.name === trimmed);
  const saved: ExportPreset = {
    id: found?.id ?? `custom_${Date.now().toString(36)}`,
    name: trimmed,
    description: describeRecipe(clean),
    builtin: false,
    recipe: clean,
  };
  const next = [...existing.filter((item) => item.id !== saved.id), saved];
  try {
    store?.setItem(PRESETS_KEY, JSON.stringify(next));
  } catch {
    /* Preset stays usable in memory. */
  }
  return saved;
}

export function removeUserExportPreset(
  id: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): ExportPreset[] {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  const next = readUserExportPresets(store).filter((item) => item.id !== id);
  try {
    store?.setItem(PRESETS_KEY, JSON.stringify(next));
  } catch {
    /* Ignore storage quota errors. */
  }
  return next;
}

export interface SavedExportState {
  presetId: string;
  recipe: ExportRecipe;
  directory: string;
}

export function readLastExportState(storage?: Pick<Storage, 'getItem'>): SavedExportState {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  try {
    const raw = JSON.parse(store?.getItem(LAST_EXPORT_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        presetId: typeof raw.presetId === 'string' ? raw.presetId : 'master',
        recipe: clampExportRecipe(raw.recipe || {}),
        directory: typeof raw.directory === 'string' ? raw.directory : '',
      };
    }
  } catch {
    /* Fall back to default master preset. */
  }
  return { presetId: 'master', recipe: { ...DEFAULT_EXPORT_RECIPE }, directory: '' };
}

export function writeLastExportState(
  state: SavedExportState,
  storage?: Pick<Storage, 'setItem'>,
) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  try {
    store?.setItem(
      LAST_EXPORT_KEY,
      JSON.stringify({
        presetId: state.presetId,
        recipe: clampExportRecipe(state.recipe),
        directory: state.directory,
      }),
    );
  } catch {
    /* Ignore storage quota errors. */
  }
}
