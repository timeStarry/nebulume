import type {
  Asset,
  AssetListOptions,
  AssetListResult,
  Library,
  StorageConfig,
  StorageCheck,
} from './model';
export type WorkspaceSection = 'libraries' | 'sources' | 'cards' | 'settings';
export function localLibraries(libraries: Library[]): Library[] {
  return libraries.filter(
    (library) => !library.hidden && (!library.source_kind || library.source_kind === 'local'),
  );
}
export function libraryLocation(library: Library): string {
  if (library.source_kind && library.source_kind !== 'local') {
    return [library.source_endpoint || library.source_name || '远程存储', library.source_prefix]
      .filter(Boolean)
      .join(' / ');
  }
  return library.root;
}
export function sourceKind(kind?: string): string {
  return (
    ({ local: '本地文件夹', webdav: 'WebDAV', s3: 'S3 兼容存储' } as Record<string, string>)[
      kind || 'local'
    ] ||
    kind ||
    '本地文件夹'
  );
}
export function credentialLabel(status: StorageConfig['credential_status']): string {
  return (
    (
      {
        system: '已保存至系统安全存储',
        session: '仅当前会话',
        missing: '需要连接凭据',
        unavailable: '系统安全存储不可用',
        not_required: '无需凭据',
      } as Record<string, string>
    )[status || ''] || '尚未确认'
  );
}
export function checkedConnection(result: StorageCheck): { ok: boolean; message: string } {
  return result.connected
    ? { ok: true, message: '连接成功，目录访问正常。' }
    : { ok: false, message: result.error || '连接未成功，请检查地址与凭据。' };
}
export function parentPrefix(prefix: string): string {
  const parts = prefix.replace(/\/$/, '').split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
}
export function displayDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
export function viewerIds(selected: string, ids: string[]): string[] {
  return [...new Set([...(ids.includes(selected) ? ids : [selected, ...ids])])].filter(Boolean);
}

/** Selecting a variant replaces its representative, so the paired JPEG is not repeated. */
export function variantViewerIds(
  items: Asset[],
  representativeId: string,
  variantId: string,
): string[] {
  return [...new Set(items.map((item) => (item.id === representativeId ? variantId : item.id)))];
}

/** The browser's explicit in-memory catalog mirrors query order before pagination. */
export function browserAssetList(
  items: Asset[],
  options: AssetListOptions,
  paired = false,
): AssetListResult {
  const inLibrary = items.filter(
    (item) => !options.library_id || item.library_id === options.library_id,
  );
  const jpeg = (item: Asset) => ['jpg', 'jpeg'].includes(item.extension.toLowerCase());
  const query = options.query?.trim().toLowerCase();
  const matches = (item: Asset) =>
    (!query ||
      `${item.filename} ${Object.values(item.metadata).join(' ')}`.toLowerCase().includes(query)) &&
    item.rating >= (options.rating || 0) &&
    (options.format === 'raw'
      ? item.kind === 'raw'
      : options.format === 'jpeg'
        ? jpeg(item)
        : true);
  const eligible = inLibrary.filter(matches);
  const groups = new Map<string, Asset[]>();
  if (paired)
    for (const item of inLibrary) {
      if (item.kind !== 'raw' && !jpeg(item)) continue;
      const path = (item.source_key || item.path).replaceAll('\\', '/');
      const key = `${item.library_id}\0${path.slice(0, path.lastIndexOf('.') < 0 ? path.length : path.lastIndexOf('.'))}`;
      groups.set(key, [...(groups.get(key) || []), item]);
    }
  const byId = new Map<string, Asset[]>();
  for (const candidates of groups.values()) {
    const raw = candidates.filter((item) => item.kind === 'raw');
    const jpegs = candidates.filter(jpeg);
    if (raw.length === 1 && jpegs.length === 1 && candidates.length === 2) {
      const pair = [raw[0], jpegs[0]];
      for (const item of pair) byId.set(item.id, pair);
    }
  }
  const seen = new Set<string>();
  const listed: Asset[] = [];
  for (const item of eligible) {
    if (seen.has(item.id)) continue;
    const pair = byId.get(item.id);
    if (pair) {
      pair.forEach((variant) => seen.add(variant.id));
      const representative = [...pair].reverse().find(matches)!;
      listed.push({
        ...representative,
        variants: pair.map(({ id, filename, extension, kind }) => ({
          id,
          filename,
          extension,
          kind,
        })),
      });
    } else listed.push({ ...item, variants: undefined });
  }
  const field = options.sort_by || 'modified_at';
  const direction = options.sort_direction === 'asc' ? 1 : -1;
  listed.sort((a, b) => {
    const x = a[field],
      y = b[field];
    return (x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * direction;
  });
  const offset = options.offset || 0;
  return {
    items: listed.slice(offset, offset + (options.limit || 500)),
    total: listed.length,
    file_total: eligible.length,
  };
}
