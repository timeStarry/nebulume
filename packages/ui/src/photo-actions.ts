import { execute } from './api';
import { errorMessage, type Asset, type TrashResult } from './model';

/** Exports one photo as `<stem>-edited.jpg`, numbering the name until it is free. */
export async function exportUnique(id: string, directory: string, stem: string) {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  for (let attempt = 1; attempt <= 50; attempt++) {
    const name = `${stem}-edited${attempt > 1 ? `-${attempt}` : ''}.jpg`;
    const destination = directory ? `${directory.replace(/[\\/]+$/, '')}${separator}${name}` : name;
    try {
      return await execute<{ path: string }>('asset.export', { id, destination });
    } catch (e) {
      // Export never overwrites: a taken name is reported as E_EXISTS, so try the next one.
      if (!errorMessage(e).includes('E_EXISTS')) throw e;
    }
  }
  throw new Error('E_EXISTS: 同名导出文件过多');
}

/** Renders photos with their crops to a folder one at a time; failures do not stop the rest. */
export async function exportPhotos(
  ids: string[],
  directory: string,
  known: Map<string, Pick<Asset, 'filename'>>,
  progress: (done: number, total: number) => void,
) {
  const failures: string[] = [];
  let exported = 0;
  for (const [index, id] of ids.entries()) {
    progress(index + 1, ids.length);
    let filename = known.get(id)?.filename;
    try {
      filename ??= (await execute<Asset>('asset.get', { id })).filename;
      await exportUnique(id, directory, filename.replace(/\.[^.]+$/, ''));
      exported++;
    } catch (e) {
      failures.push(`${filename ?? id}：${errorMessage(e)}`);
    }
  }
  return { exported, failures };
}

export function exportSummary(
  result: { exported: number; failures: string[] },
  directory: string,
  desktop: boolean,
) {
  if (result.failures.length)
    return {
      error: `已导出 ${result.exported} 张，${result.failures.length} 张失败：${result.failures.slice(0, 3).join('；')}${result.failures.length > 3 ? '…' : ''}`,
    };
  return {
    notice: desktop
      ? `已导出 ${result.exported} 张到 ${directory}。`
      : `已生成 ${result.exported} 张 JPEG，并交给浏览器下载。`,
  };
}

/** Moves photos (and their paired JPEGs) to the system Trash in batches the service accepts. */
export async function trashPhotos(ids: string[]): Promise<TrashResult> {
  const result: TrashResult = { trashed: [], failed: [] };
  for (let start = 0; start < ids.length; start += 1000) {
    const part = await execute<TrashResult>('asset.trash', { ids: ids.slice(start, start + 1000) });
    result.trashed.push(...part.trashed);
    result.failed.push(...part.failed);
  }
  return result;
}

export async function restorePhotos(ids: string[]) {
  const result = { restored: [] as string[], failed: [] as { id: string; message: string }[] };
  for (let start = 0; start < ids.length; start += 1000) {
    const part = await execute<typeof result>('asset.restore', {
      ids: ids.slice(start, start + 1000),
    });
    result.restored.push(...part.restored);
    result.failed.push(...part.failed);
  }
  return result;
}

export function trashSummary(result: TrashResult) {
  const moved = result.trashed.length;
  if (!result.failed.length) return { notice: `已把 ${moved} 张照片移到废纸篓。` };
  const remote = result.failed.every((item) => item.message.includes('E_REMOTE'));
  return {
    error: remote
      ? `网络存储上的照片不能移到废纸篓${moved ? `；已移走 ${moved} 张本地照片` : ''}。`
      : `已移走 ${moved} 张，${result.failed.length} 张失败：${result.failed
          .slice(0, 3)
          .map((item) => item.message)
          .join('；')}`,
  };
}

export const formatBytes = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : bytes >= 1e6
      ? `${(bytes / 1e6).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
