import { invoke, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { demoCommand } from './demo';

export const desktop = isTauri();
export function execute<T>(command: string, params: Record<string, unknown> = {}): Promise<T> {
  return desktop ? invoke<T>('execute', { command, params }) : demoCommand<T>(command, params);
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
