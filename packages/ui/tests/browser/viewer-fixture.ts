import type { Page } from '@playwright/test';
import type { Asset, Library } from '../../src/model';
import { servePreviewImages } from './fixtures';

type Call = { command: string; params: Record<string, unknown> };
export const library: Library = {
  id: 'library-local',
  name: '本地摄影',
  root: 'D:\\Photos',
  created_at: '2026-10-01',
  source_kind: 'local',
  source_prefix: '',
};
const photo = (index: number): Asset => ({
  id: `photo-${index}`,
  library_id: library.id,
  filename: `Frame-${index}.png`,
  path: `D:\\Photos\\Frame-${index}.png`,
  extension: 'png',
  kind: 'raster',
  size: 1000,
  width: 960,
  height: 640,
  rating: 0,
  flag: 'none',
  metadata: {},
  availability: 'available',
  modified_at: '2026-10-01T10:00:00Z',
});

export async function fixture(
  page: Page,
  options: {
    failFlag?: boolean;
    fromFile?: boolean;
    metadata?: Record<string, string>;
    failHistogram?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const assets = new Map(
    [1, 2, 3].map((index) => [
      `photo-${index}`,
      { ...photo(index), metadata: index === 1 ? (options.metadata ?? {}) : {} },
    ]),
  );
  const trashed = new Map<string, Asset>();
  let added = false;
  await page.route('**/__culling_rpc', async (route) => {
    const call = route.request().postDataJSON() as Call;
    calls.push(call);
    const target = assets.get(String(call.params.id));
    let result: unknown;
    try {
      switch (call.command) {
        case 'library.list':
          result = options.fromFile && !added ? [] : [library];
          break;
        case 'file.siblings':
          result = {
            folder: '/photos/Trip',
            index: 0,
            files: [1, 2, 3].map((n) => ({
              name: `Frame-${n}.png`,
              path: `/photos/Trip/Frame-${n}.png`,
              size: 1000,
            })),
          };
          break;
        case 'file.open': {
          const n = String(call.params.path).match(/Frame-(\d)/)![1];
          result = { ...assets.get(`photo-${n}`) };
          break;
        }
        case 'library.add':
          added = true;
          result = { ...library, name: String(call.params.name), root: String(call.params.root) };
          break;
        case 'library.scan':
          result = { indexed: 3, skipped: 0, errors: [] };
          break;
        case 'storage.list':
          result = [];
          break;
        case 'system.info':
          result = { originals_read_only: true };
          break;
        case 'import.batches':
          result = [];
          break;
        case 'library.capture_index.status':
          result = {
            library_id: library.id,
            total: 3,
            known: 3,
            missing: 0,
            pending: 0,
            job: null,
          };
          break;
        case 'asset.list': {
          const filter = call.params.flag as string | undefined;
          const items = [...assets.values()].filter(
            (item) =>
              !filter ||
              filter === 'any' ||
              (filter === 'not_reject' ? item.flag !== 'reject' : item.flag === filter),
          );
          const offset = Number(call.params.offset || 0);
          result = {
            items: items.slice(offset, offset + Number(call.params.limit || 200)),
            total: items.length,
          };
          break;
        }
        case 'asset.get':
          result = { ...target };
          break;
        case 'asset.rate':
          target!.rating = Number(call.params.rating);
          result = { ...target };
          break;
        case 'asset.flag':
          if (options.failFlag) throw new Error('catalog is read-only');
          target!.flag = call.params.flag as Asset['flag'];
          result = { ...target };
          break;
        case 'asset.mark_batch':
          for (const id of call.params.ids as string[]) {
            const item = assets.get(id)!;
            if (call.params.rating !== undefined) item.rating = Number(call.params.rating);
            if (call.params.flag !== undefined) item.flag = call.params.flag as Asset['flag'];
          }
          result = { updated: (call.params.ids as string[]).length };
          break;
        case 'asset.focus':
          result = {
            status: 'missing',
            reason: '此照片未记录对焦区域',
            source: null,
            coordinate_space: 'oriented_full_image',
            orientation: 1,
            regions: [],
          };
          break;
        case 'asset.preview':
          result = { width: 1, height: 1, source: 'fixture', tier: call.params.tier || 'p2560' };
          break;
        case 'asset.histogram':
          if (options.failHistogram) throw new Error('histogram unavailable');
          result = {
            red: Array(256).fill(1),
            green: Array(256).fill(1),
            blue: Array(256).fill(1),
            luminance: Array(256).fill(1),
            pixels: 256,
            source: 'fixture',
          };
          break;
        case 'asset.trash': {
          const ids = call.params.ids as string[];
          for (const id of ids) trashed.set(id, assets.get(id)!);
          for (const id of ids) assets.delete(id);
          result = { trashed: ids, failed: [] };
          break;
        }
        case 'asset.restore': {
          const ids = call.params.ids as string[];
          for (const id of ids) assets.set(id, trashed.get(id)!);
          result = { restored: ids, failed: [] };
          break;
        }
        case '$native/open_viewer':
          result = 'viewer-test';
          break;
        case '$native/viewer_context':
          result = {
            asset_id: 'photo-1',
            asset_ids: ['photo-1'],
            mode: options.fromFile ? 'view' : 'cull',
            queue: options.fromFile ? null : { library_id: library.id, options: { flag: 'none' } },
            from_file: options.fromFile,
          };
          break;
        case '$native/plugin:window|theme':
          result = 'dark';
          break;
        case '$native/plugin:window|set_theme':
        case '$native/plugin:window|set_title':
        case '$native/plugin:window|is_fullscreen':
          result = call.command.endsWith('is_fullscreen') ? false : null;
          break;
        case '$native/plugin:window|close':
          result = null;
          break;
        default:
          throw new Error(`Unexpected culling fixture: ${call.command}`);
      }
      await route.fulfill({ json: { result } });
    } catch (error) {
      await route.fulfill({ json: { error: { code: 'FIXTURE', message: String(error) } } });
    }
  });
  await servePreviewImages(page);
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, scheme: string) =>
          'http://' + scheme + '.localhost/' + encodeURIComponent(path),
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: {
          currentWindow: { label: 'viewer-test' },
          currentWebview: { label: 'viewer-test' },
        },
        invoke: async (command: string, params: Record<string, unknown>) => {
          if (command.startsWith('plugin:event|')) return 1;
          const response = await fetch('/__culling_rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              command === 'execute'
                ? params
                : { command: '$native/' + command, params: params || {} },
            ),
          });
          const body = await response.json();
          if (body.error) throw body.error;
          return body.result;
        },
      },
    });
  });
  return { calls, assets };
}
