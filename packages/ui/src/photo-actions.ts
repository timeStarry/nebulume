import { execute } from './api';
import {
  DEFAULT_EXPORT_RECIPE,
  clampExportRecipe,
  formatExportFilename,
  type ExportRecipe,
} from './export-presets';
import { errorMessage, type Asset, type TrashResult } from './model';

/** Exports one photo according to `recipe`, numbering the name until it is free. */
export async function exportUnique(
  id: string,
  directory: string,
  stemOrFilename: string,
  recipe: ExportRecipe = DEFAULT_EXPORT_RECIPE,
  seq = 1,
  capturedAt?: string,
) {
  const clean = clampExportRecipe(recipe);
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  const filename = /\.[a-z0-9]+$/i.test(stemOrFilename) ? stemOrFilename : `${stemOrFilename}.jpg`;
  for (let attempt = 1; attempt <= 50; attempt++) {
    const name = formatExportFilename(clean, { filename, captured_at: capturedAt }, seq, attempt);
    const destination = directory ? `${directory.replace(/[\\/]+$/, '')}${separator}${name}` : name;
    try {
      return await execute<{ path: string }>('asset.export', {
        id,
        destination,
        quality: clean.quality,
        color_space: clean.colorSpace,
        ...(clean.maxEdge ? { max_edge: clean.maxEdge } : {}),
      });
    } catch (e) {
      // Export never overwrites: a taken name is reported as E_EXISTS, so try the next one.
      if (!errorMessage(e).includes('E_EXISTS')) throw e;
    }
  }
  throw new Error('E_EXISTS: 同名导出文件过多');
}

/** Renders photos with their crops and export recipe to a folder one at a time; failures do not stop the rest. */
export async function exportPhotos(
  ids: string[],
  directory: string,
  known: Map<string, Pick<Asset, 'filename'> & { captured_at?: string }>,
  progress: (done: number, total: number) => void,
  recipe: ExportRecipe = DEFAULT_EXPORT_RECIPE,
) {
  const failures: string[] = [];
  let exported = 0;
  for (const [index, id] of ids.entries()) {
    progress(index + 1, ids.length);
    const cached = known.get(id);
    let filename = cached?.filename;
    let capturedAt = cached?.captured_at;
    try {
      if (!filename) {
        const loaded = await execute<Asset>('asset.get', { id });
        filename = loaded.filename;
        capturedAt = loaded.captured_at;
      }
      await exportUnique(id, directory, filename, recipe, index + 1, capturedAt);
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
