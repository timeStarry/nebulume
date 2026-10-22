import { invoke, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { demoCommand } from './demo';
import type { AssetListOptions, Volume } from './model';
import { createPreviewScheduler, type PreviewRequestOptions } from './concurrency';

export const desktop = isTauri();
const schedulePreview = createPreviewScheduler();
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
  extra: { mode?: 'view' | 'cull'; queue?: ViewerQueueContext } = {},
): Promise<string> {
  // Ordinary viewing keeps its original payload; culling adds mode and queue.
  return invoke<string>('open_viewer', {
    assetId,
    assetIds,
    ...(extra.mode ? { mode: extra.mode } : {}),
    ...(extra.queue ? { queue: extra.queue } : {}),
  });
}
export function viewerContext(): Promise<{
  asset_id: string;
  asset_ids: string[];
  mode?: 'view' | 'cull';
  queue?: ViewerQueueContext | null;
}> {
  return invoke('viewer_context');
}
export function listVolumes(): Promise<Volume[]> {
  return desktop ? invoke('list_volumes') : Promise.resolve([]);
}
