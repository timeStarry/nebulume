export interface Library {
  id: string;
  name: string;
  root: string;
  created_at: string;
  storage_id?: string | null;
  source_prefix?: string;
  source_kind?: 'local' | 'webdav' | 's3';
  source_name?: string;
  source_endpoint?: string;
  connected?: boolean;
  availability?: Availability;
  hidden?: boolean;
  pair_raw_jpeg?: boolean;
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
  /** Filesystem/source creation time; empty or absent when the source cannot provide it. */
  created_at?: string;
  /** Camera local date/time, without a fabricated timezone; unavailable times are empty. */
  captured_at?: string;
  capture_status?: 'available' | 'missing' | 'pending';
  modified_at: string;
  width?: number;
  height?: number;
  rating: number;
  /** Culling mark stored in the catalog; never written to the original. */
  flag?: Flag;
  metadata: Record<string, string>;
  crop?: Crop | null;
  availability: string;
  source_key?: string | null;
  cache_pinned?: boolean;
  cache_update_available?: boolean;
  /** Client-side refresh token; never persisted to the catalog. */
  preview_revision?: number;
  variants?: Pick<Asset, 'id' | 'filename' | 'extension' | 'kind'>[];
}
export type Flag = 'none' | 'pick' | 'reject';
export type FlagFilter = 'any' | 'pick' | 'none' | 'reject' | 'not_reject';
export interface AssetListOptions {
  library_id?: string;
  flag?: FlagFilter;
  import_batch_id?: string;
  query?: string;
  rating?: number;
  format?: 'all' | 'raw' | 'jpeg';
  sort_by?: 'captured_at' | 'created_at' | 'modified_at' | 'filename' | 'rating';
  sort_direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}
export interface AssetListResult {
  items: Asset[];
  total: number;
  file_total?: number;
}
export interface CaptureIndexStatus {
  library_id: string;
  total: number;
  known: number;
  missing: number;
  pending: number;
  job: null | {
    id: string;
    library_id: string;
    status: 'running' | 'stopping' | 'completed' | 'cancelled' | 'failed';
    total: number;
    processed: number;
    found: number;
    missing: number;
    failed: number;
    error?: string;
  };
}
export interface Preview {
  asset?: Asset;
  data_url: string;
  width: number;
  height: number;
  source: string;
  coordinate_mapping?: {
    orientation: number;
    full_width: number;
    full_height: number;
    crop: Crop;
  };
}
export interface FocusRegion extends Crop {
  kind: 'selected' | 'active';
}
export interface FocusInfo {
  status: 'available' | 'missing' | 'unsupported';
  reason?: string;
  source: 'nikon_afinfo2' | null;
  coordinate_space: 'oriented_full_image';
  orientation: number;
  image_width?: number;
  image_height?: number;
  regions: FocusRegion[];
}
export interface Histogram {
  asset?: Asset;
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
  kind: 'local' | 'webdav' | 's3';
  endpoint: string;
  root?: string;
  bucket?: string;
  region?: string;
  connected?: boolean;
  tls_certificate_sha256?: string | null;
  remember_credentials?: boolean;
  credential_status?: 'system' | 'session' | 'missing' | 'unavailable' | 'not_required';
  /** Result of the explicit write test in this app session. */
  write_capability?: WriteCapability;
}
export type WriteCapability = 'unverified' | 'verified' | 'unsupported';
export interface WriteCheck {
  id: string;
  write_capability: WriteCapability;
  error?: string | null;
  leftover?: string | null;
  checked_at: string;
}
export interface Volume {
  id: string;
  name: string;
  path: string;
  kind: string;
  removable: boolean;
  available_bytes?: number | null;
}
export type Availability =
  | 'unchecked'
  | 'online'
  | 'offline'
  | 'auth_required'
  | 'trust_required'
  | 'error';
export interface StorageCheck {
  id: string;
  connected: boolean;
  availability?: Availability;
  credential_status: StorageConfig['credential_status'];
  checked_at: string;
  error: string | null;
}
export interface ScanResult {
  indexed: number;
  skipped: number;
  errors: { path: string; message: string }[];
}
export interface TlsCertificate {
  endpoint: string;
  sha256: string;
  subject: string;
  issuer: string;
  not_before: string;
  not_after: string;
  subject_alt_names: string[];
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
  /** exif, paired_exif, import_date, modified_time, unknown or preserved. */
  date_source?: string;
}
export interface OrganizeRules {
  date_basis: 'capture' | 'import' | 'none' | 'preserve';
  date_layout: 'Y-M-D' | 'Y/Y-M-D' | 'Y/M/Y-M-D' | 'Y/M/D';
  type_split: 'none' | 'by_kind';
  unknown_date: 'folder' | 'modified_time';
  subfolder: string;
}
export interface ImportPlan {
  id: string;
  source: string;
  destination: string;
  items: ImportItem[];
  total_bytes: number;
  duplicate_count: number;
  /** Same name, size and capture day as an unhashed library file; skipped unless included. */
  likely_duplicate_count?: number;
  /** Present for NAS targets: whether this location passed the write test. */
  write_capability?: WriteCapability;
  library_id?: string;
  warnings: string[];
  [key: string]: unknown;
}
export interface Card {
  id: string;
  name: string;
  location_id: string;
  volume_label?: string | null;
  volume_serial?: string | null;
  capacity_bytes?: number | null;
  last_mount_path?: string | null;
  last_seen_at?: string | null;
  default_preset_id?: string | null;
  created_at: string;
  last_import_at?: string | null;
}
export type CardIdentification =
  | { status: 'known'; card: Card }
  | { status: 'unknown' | 'foreign'; candidates: Card[]; identity_id?: string };
export interface ImportPreset {
  id: string;
  name: string;
  library_id: string;
  rules: OrganizeRules;
  deduplicate: boolean;
  created_at: string;
}
export interface ImportBatch {
  id: string;
  library_id: string;
  card_id?: string | null;
  source: string;
  started_at: string;
  finished_at?: string | null;
  status: string;
  copied: number;
  duplicates: number;
  failed: number;
  asset_count: number;
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
  library_id?: string;
  indexing?: ScanResult;
  indexing_error?: string;
  batch?: ImportBatch;
  batch_error?: string;
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
export function imageRequestKey(
  asset: Pick<Asset, 'id' | 'crop' | 'preview_revision'>,
  uncropped = false,
): string {
  return JSON.stringify({
    id: asset.id,
    crop: uncropped ? null : asset.crop || null,
    uncropped,
    revision: asset.preview_revision || 0,
  });
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
export function renderSourceLabel(source: string | undefined): string {
  if (source === 'remote_embedded_jpeg') return '相机内嵌预览';
  return source === 'embedded_jpeg'
    ? '相机内嵌预览 · RAW 原始解码不可用'
    : source === 'raw_demosaic'
      ? 'RAW 基础显影 · 显示 RGB'
      : source === 'raster'
        ? '原图解码 · 显示 RGB'
        : source || '';
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
