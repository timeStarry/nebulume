import type {
  Availability,
  Asset,
  AssetListOptions,
  AssetListResult,
  Flag,
  FlagFilter,
  Library,
  OrganizeRules,
  StorageConfig,
  StorageCheck,
} from './model';
export type WorkspaceSection = 'libraries' | 'sources' | 'cards' | 'settings';
export function localLibraries(libraries: Library[]): Library[] {
  return libraries.filter(
    (library) => !library.hidden && (!library.source_kind || library.source_kind === 'local'),
  );
}
/** Libraries an import can write into: local folders and WebDAV/S3 libraries. */
export function importTargets(libraries: Library[]): Library[] {
  return libraries.filter((library) => !library.hidden);
}
export const isRemoteLibrary = (library?: Pick<Library, 'source_kind'>) =>
  !!library?.source_kind && library.source_kind !== 'local';
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

export function matchesFlag(flag: Flag, filter: FlagFilter = 'any'): boolean {
  return filter === 'any' || (filter === 'not_reject' ? flag !== 'reject' : flag === filter);
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
    matchesFlag(item.flag || 'none', options.flag) &&
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
  const field = options.sort_by || 'captured_at';
  const direction = options.sort_direction === 'asc' ? 1 : -1;
  listed.sort((a, b) => {
    if (field === 'created_at' || field === 'captured_at') {
      const aKnown = !!a[field],
        bKnown = !!b[field];
      // An unavailable source timestamp belongs last in either direction.
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
    }
    const x = a[field] ?? '',
      y = b[field] ?? '';
    return (x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * direction;
  });
  const offset = options.offset || 0;
  return {
    items: listed.slice(offset, offset + (options.limit || 500)),
    total: listed.length,
    file_total: eligible.length,
  };
}

export interface AvailabilityPresentation {
  /** Library is usable for browsing; false greys the card but it stays enterable. */
  usable: boolean;
  label: string;
  detail: string;
  /** Section that resolves the problem, when one exists. */
  action?: { label: string; section: WorkspaceSection };
}
/** One source of truth for location state across cards, grid and dialogs. */
export function availabilityPresentation(
  library: Pick<Library, 'availability' | 'connected' | 'source_kind' | 'source_name' | 'name'>,
): AvailabilityPresentation {
  const state: Availability = library.availability || (library.connected ? 'online' : 'unchecked');
  const where = library.source_name || library.name;
  const local = !library.source_kind || library.source_kind === 'local';
  switch (state) {
    case 'online':
      return { usable: true, label: '在线', detail: '' };
    case 'unchecked':
      return {
        usable: true,
        label: '未连接',
        detail: '本次启动尚未访问此位置，首次读取时连接。',
      };
    case 'offline':
      return {
        usable: false,
        label: local ? '未挂载' : '不可达',
        detail: local
          ? `${where} 当前不可用，可能是外接盘未插入。评级与旗标仍可修改，有缓存的照片仍可查看。`
          : `${where} 当前无法连接。评级与旗标仍可修改，已缓存或固定离线的照片仍可查看。`,
        action: local ? undefined : { label: '检查连接', section: 'sources' },
      };
    case 'auth_required':
      return {
        usable: false,
        label: '需要登录',
        detail: `${where} 的登录信息缺失或已失效。`,
        action: { label: '重新登录', section: 'sources' },
      };
    case 'trust_required':
      return {
        usable: false,
        label: '证书待确认',
        detail: `${where} 的设备证书已变化、过期或尚未信任。`,
        action: { label: '检查证书', section: 'sources' },
      };
    default:
      return {
        usable: false,
        label: '访问出错',
        detail: `${where} 上次访问失败，请在连接设置中查看详情。`,
        action: { label: '查看连接', section: 'sources' },
      };
  }
}

export const defaultOrganizeRules = (): OrganizeRules => ({
  date_basis: 'capture',
  date_layout: 'Y-M-D',
  type_split: 'none',
  unknown_date: 'folder',
  subfolder: '',
});
/** Mirrors neb-ingest's subfolder validation so the form can explain problems early. */
export function subfolderError(value: string): string {
  if (!value) return '';
  if (value.length > 120) return '子目录最多 120 个字符。';
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  for (const part of value.split('/'))
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[.\s]$/.test(part) ||
      reserved.test(part.split('.')[0]) ||
      /[\\:*?"<>|\u0000-\u001f]/.test(part)
    )
      return '子目录只能是用 / 分隔的普通文件夹名，不能包含 .. 或特殊字符。';
  return '';
}
/** A representative destination path, matching neb-ingest's target layout. */
export function organizeExample(rules: OrganizeRules, day = '2026-10-22'): string {
  const [y, m, d] = day.split('-');
  const parts: string[] = [];
  if (rules.subfolder) parts.push(rules.subfolder);
  if (rules.date_basis === 'preserve') parts.push('DCIM/100NIKON');
  else if (rules.date_basis !== 'none')
    parts.push(
      rules.date_layout === 'Y/Y-M-D'
        ? `${y}/${day}`
        : rules.date_layout === 'Y/M/Y-M-D'
          ? `${y}/${m}/${day}`
          : rules.date_layout === 'Y/M/D'
            ? `${y}/${m}/${d}`
            : day,
    );
  if (rules.type_split === 'by_kind') parts.push('RAW');
  parts.push('DSC_0001.NEF');
  return parts.join('/');
}
export function dateSourceName(source?: string): string {
  return (
    (
      {
        exif: '拍摄时间',
        paired_exif: '同组拍摄时间',
        import_date: '导入日',
        modified_time: '文件修改时间',
        unknown: '未知日期',
        preserved: '保留目录',
      } as Record<string, string>
    )[source || ''] || ''
  );
}
