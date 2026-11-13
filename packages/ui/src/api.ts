import { invoke, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { demoCommand } from './demo';
import type { AssetListOptions, Volume } from './model';
import { createPreviewScheduler, type PreviewRequestOptions } from './concurrency';

export const desktop = isTauri();
/** Shared lanes for preview metadata IPC and `neb` image loads. */
export const schedulePreview = createPreviewScheduler();
/** Preview options stay client-side. Signals cancel queued work, never in-flight native IPC. */
export function execute<T>(
  command: string,
  params: Record<string, unknown> = {},
  options: PreviewRequestOptions = {},
): Promise<T> {
  const run = () =>
    desktop ? invoke<T>('execute', { command, params }) : demoCommand<T>(command, params);
  return command === 'asset.preview' ? schedulePreview(run, options) : run();
}
export async function chooseDirectory(title: string): Promise<string | null> {
  if (!desktop) return null;
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === 'string' ? selected : null;
}
export async function chooseSave(defaultPath: string): Promise<string | null> {
  if (!desktop) return defaultPath;
  return save({ title: '导出为新文件', defaultPath });
}
export async function chooseImage(): Promise<string | null> {
  if (!desktop) return null;
  const selected = await open({
    title: '打开影像文件',
    multiple: false,
    filters: [
      {
        name: '影像',
        extensions: [
          'jpg',
          'jpeg',
          'png',
          'webp',
          'tif',
          'tiff',
          'bmp',
          'gif',
          'dng',
          'cr2',
          'ico',
          'pnm',
          'pgm',
          'ppm',
          'nef',
          'arw',
          'raf',
          'orf',
          'rw2',
          'pef',
          'srw',
        ],
      },
    ],
  });
  return typeof selected === 'string' ? selected : null;
}
export interface ViewerQueueContext {
  library_id: string;
  options: AssetListOptions;
}
export function openViewerWindow(
  assetId: string,
  assetIds: string[],
  extra: { mode?: 'view' | 'cull'; queue?: ViewerQueueContext; fromFile?: boolean } = {},
): Promise<string> {
  // Ordinary viewing keeps its original payload; culling adds mode and queue.
  return invoke<string>('open_viewer', {
    assetId,
    assetIds,
    ...(extra.mode ? { mode: extra.mode } : {}),
    ...(extra.queue ? { queue: extra.queue } : {}),
    ...(extra.fromFile ? { fromFile: true } : {}),
  });
}
export function viewerContext(): Promise<{
  asset_id: string;
  asset_ids: string[];
  mode?: 'view' | 'cull';
  queue?: ViewerQueueContext | null;
  /** Opened from a file: a single photo browses the images in its folder. */
  from_file?: boolean;
}> {
  return invoke('viewer_context');
}
export function listVolumes(): Promise<Volume[]> {
  return desktop ? invoke('list_volumes') : Promise.resolve([]);
}
export function revealInFolder(path: string): Promise<void> {
  if (!desktop) return Promise.reject(new Error('此功能需要 Lumen 桌面版。'));
  return invoke('reveal_in_folder', { path });
}
export function openDataDirectory(): Promise<void> {
  if (!desktop) return Promise.reject(new Error('此功能需要 Lumen 桌面版。'));
  return invoke('open_data_dir');
}
export function openProjectUrl(url: string): Promise<void> {
  if (!desktop) {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  }
  return invoke('open_url', { url });
}
export function openExternal(options: {
  id?: string;
  path: string;
  appPath?: string;
}): Promise<void> {
  if (!desktop) return Promise.reject(new Error('此功能需要 Lumen 桌面版。'));
  return invoke('open_external', {
    id: options.id ?? null,
    path: options.path,
    appPath: options.appPath ?? null,
  });
}
export async function chooseExternalApp(): Promise<string | null> {
  if (!desktop) return null;
  const selected = await open({
    title: '选择外部精修软件',
    multiple: false,
  });
  return typeof selected === 'string' ? selected : null;
}
export function ejectVolume(
  path: string,
): Promise<{ path: string; name: string; ejected: boolean }> {
  if (!desktop) return Promise.reject(new Error('此功能需要 Lumen 桌面版。'));
  return invoke('eject_volume', { path });
}
const PREGENERATE_KEY = 'nebulume.pregenerate-previews';
/** Background grid-preview rendering after a scan; on unless the user turned it off. */
export function readPregenerate(): boolean {
  try {
    return localStorage.getItem(PREGENERATE_KEY) !== 'false';
  } catch {
    return true;
  }
}
export function writePregenerate(value: boolean) {
  try {
    localStorage.setItem(PREGENERATE_KEY, String(value));
  } catch {
    /* The preference remains effective for this session. */
  }
}
/** Starts (or restarts) background rendering of one grid tier for a library's local photos. */
export function pregeneratePreviews(libraryId: string, tier: string): Promise<void> {
  if (!desktop || !readPregenerate()) return Promise.resolve();
  return invoke('pregenerate_previews', { libraryId, tier });
}
const WATCH_KEY = 'nebulume.watch-libraries';
/** Automatic re-indexing when local library folders change; on unless turned off. */
export function readWatchLibraries(): boolean {
  try {
    return localStorage.getItem(WATCH_KEY) !== 'false';
  } catch {
    return true;
  }
}
export function writeWatchLibraries(value: boolean) {
  try {
    localStorage.setItem(WATCH_KEY, String(value));
  } catch {
    /* The preference remains effective for this session. */
  }
}
/** (Re)starts watching every online local library; returns the watched ids. */
export function watchLibraries(enabled = readWatchLibraries()): Promise<string[]> {
  if (!desktop) return Promise.resolve([]);
  return invoke('watch_libraries', { enabled });
}
