export interface Library {
  id: string;
  name: string;
  root: string;
  created_at: string;
}
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Asset {
  id: string;
  library_id: string;
  path: string;
  filename: string;
  extension: string;
  kind: 'raster' | 'raw';
  size: number;
  modified_at: string;
  width?: number;
  height?: number;
  rating: number;
  metadata: Record<string, string>;
  crop?: Crop | null;
  availability: string;
}
export interface Preview {
  data_url: string;
  width: number;
  height: number;
  source: string;
}
export interface Histogram {
  red: number[];
  green: number[];
  blue: number[];
  luminance: number[];
  pixels: number;
  source: string;
}
export interface StorageConfig {
  id: string;
  name: string;
  kind: 'webdav' | 's3';
  endpoint: string;
  root?: string;
  bucket?: string;
  region?: string;
  connected?: boolean;
}
export interface StorageEntry {
  key: string;
  size: number;
  is_dir: boolean;
}
export interface ImportItem {
  source: string;
  relative_path: string;
  size: number;
  status: string;
}
export interface ImportPlan {
  id: string;
  source: string;
  destination: string;
  items: ImportItem[];
  total_bytes: number;
  duplicate_count: number;
  warnings: string[];
  [key: string]: unknown;
}
export interface ImportResult {
  id: string;
  plan_id: string;
  source: string;
  destination: string;
  status: 'completed' | 'partial' | 'failed' | 'interrupted';
  started_at: string;
  finished_at?: string;
  total: number;
  copied: number;
  duplicates: number;
  failed: number;
  items: {
    source: string;
    destination: string;
    status: 'copied' | 'duplicate' | 'failed';
    size: number;
    error?: string;
  }[];
  originals_retained: boolean;
  [key: string]: unknown;
}

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** power).toFixed(power === 1 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB', 'TB'][power]}`;
}

export const fullCrop: Crop = { x: 0, y: 0, width: 1, height: 1 };
export function validCrop(crop: Crop): boolean {
  return (
    Object.values(crop).every(Number.isFinite) &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.width > 0 &&
    crop.height > 0 &&
    crop.x + crop.width <= 1.000001 &&
    crop.y + crop.height <= 1.000001
  );
}
export function cropFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
): Crop {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x = Math.min(0.995, clamp(Math.min(start.x, end.x)));
  const y = Math.min(0.995, clamp(Math.min(start.y, end.y)));
  return {
    x,
    y,
    width: Math.max(0.005, clamp(Math.max(start.x, end.x)) - x),
    height: Math.max(0.005, clamp(Math.max(start.y, end.y)) - y),
  };
}
export function imageRequestKey(asset: Pick<Asset, 'id' | 'crop'>, uncropped = false): string {
  return JSON.stringify({ id: asset.id, crop: uncropped ? null : asset.crop || null, uncropped });
}
export function histogramFromPixels(data: ArrayLike<number>): Omit<Histogram, 'source'> {
  const red = Array(256).fill(0),
    green = Array(256).fill(0),
    blue = Array(256).fill(0),
    luminance = Array(256).fill(0);
  let pixels = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    red[data[i]]++;
    green[data[i + 1]]++;
    blue[data[i + 2]]++;
    luminance[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
    pixels++;
  }
  return { red, green, blue, luminance, pixels };
}
export function histogramPath(bins: number[], ceiling: number): string {
  if (!bins.length || !ceiling) return '';
  return `M0,80 ${bins.map((n, i) => `L${i},${80 - Math.min(1, n / ceiling) * 76}`).join(' ')} L255,80 Z`;
}
export function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    !!element &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable)
  );
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) return String(error.message);
  if (typeof error === 'string') {
    try {
      return JSON.parse(error).message || error;
    } catch {
      return error;
    }
  }
  return '操作未完成，请检查连接或文件权限后重试。';
}
