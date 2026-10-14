import type { Library, StorageConfig, StorageCheck } from './model';
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
