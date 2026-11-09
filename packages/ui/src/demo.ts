import {
  histogramFromPixels,
  validCrop,
  type Asset,
  type Crop,
  type Library,
  TIER_PIXELS,
  type Preview,
  type PreviewTier,
  type AssetListOptions,
  type Flag,
} from './model';
import { browserAssetFacets, browserAssetList } from './workspace';

const files = new Map<string, File>();
const assets = new Map<string, Asset>();
const previewCache = new Map<string, Promise<{ url: string; width: number; height: number }>>();
const browserLibrary: Library = {
  id: 'browser',
  name: '临时图片库',
  root: '浏览器内存 · 关闭页面后清除',
  created_at: new Date().toISOString(),
  pair_raw_jpeg: false,
};
let libraryVisible = true;

async function canvasFor(id: string): Promise<HTMLCanvasElement> {
  const file = files.get(id);
  if (!file) throw new Error('此图片已不在浏览器会话中，请重新选择文件。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法创建画布。');
    context.drawImage(image, 0, 0);
    return canvas;
  } catch {
    throw new Error('浏览器无法解码此文件。RAW、TIFF 等格式请使用桌面版并查看编解码能力。');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function applyCrop(original: HTMLCanvasElement, crop?: Crop | null): HTMLCanvasElement {
  if (!crop) return original;
  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(crop.width * original.width));
  output.height = Math.max(1, Math.round(crop.height * original.height));
  output
    .getContext('2d')!
    .drawImage(
      original,
      crop.x * original.width,
      crop.y * original.height,
      crop.width * original.width,
      crop.height * original.height,
      0,
      0,
      output.width,
      output.height,
    );
  return output;
}

export async function addBrowserFiles(
  selected: File[],
): Promise<{ added: number; added_ids: string[]; errors: string[] }> {
  const errors: string[] = [];
  let added = 0;
  const addedIds: string[] = [];
  libraryVisible = true;
  for (const file of selected) {
    const id = crypto.randomUUID();
    files.set(id, file);
    try {
      const canvas = await canvasFor(id);
      assets.set(id, {
        id,
        library_id: 'browser',
        path: file.name,
        filename: file.name,
        extension: file.name.split('.').pop()?.toLowerCase() || '',
        kind: 'raster',
        size: file.size,
        created_at: '',
        // Browser files carry no readable EXIF here; the file time stands in so the demo groups by day.
        captured_at: localStamp(file.lastModified),
        capture_status: 'available',
        modified_at: new Date(file.lastModified).toISOString(),
        width: canvas.width,
        height: canvas.height,
        rating: 0,
        flag: 'none',
        metadata: {},
        availability: 'available',
      });
      added++;
      addedIds.push(id);
    } catch (error) {
      files.delete(id);
      errors.push(`${file.name}：${(error as Error).message}`);
    }
  }
  return { added, added_ids: addedIds, errors };
}

export async function demoCommand<T>(command: string, params: Record<string, unknown>): Promise<T> {
  const asset = assets.get(String(params.id));
  let result: unknown;
  switch (command) {
    case 'system.info':
      result = {
        version: '0.1.1',
        mode: 'browser',
        limits: ['浏览器演示：临时文件会话，EXIF / RAW / 远程存储 / SD 卡导入需桌面端。'],
      };
      break;
    case 'library.list':
      result = libraryVisible
        ? [
            {
              ...browserLibrary,
              asset_count: [...assets.values()].length,
              latest_capture: null,
              cover_asset_ids: [...assets.values()].slice(0, 4).map((asset) => asset.id),
            },
          ]
        : [];
      break;
    case 'library.update':
      if (params.id !== browserLibrary.id || !libraryVisible) throw new Error('图片库不存在。');
      if (params.storage_id !== undefined || params.source_prefix !== undefined)
        throw new Error('更改实际存储位置需要桌面版。');
      if (params.name !== undefined) {
        if (!String(params.name).trim()) throw new Error('请输入图片库名称。');
        browserLibrary.name = String(params.name).trim();
      }
      if (params.pair_raw_jpeg !== undefined) browserLibrary.pair_raw_jpeg = !!params.pair_raw_jpeg;
      result = { ...browserLibrary };
      break;
    case 'library.remove':
      if (params.id !== browserLibrary.id || !libraryVisible) throw new Error('图片库不存在。');
      assets.clear();
      files.clear();
      clearDemoPreviews();
      libraryVisible = false;
      result = { id: browserLibrary.id };
      break;
    case 'storage.list':
      result = [];
      break;
    case 'asset.stats': {
      const listed = browserAssetList(
        [...assets.values()],
        { ...(params as AssetListOptions), limit: 100000, offset: 0 },
        browserLibrary.pair_raw_jpeg,
      ).items;
      result = browserStats(listed);
      break;
    }
    case 'library.folders':
      // Browser files have no folders.
      result = { library_id: String(params.library_id), total: assets.size, folders: [] };
      break;
    case 'asset.facets':
      result = browserAssetFacets([...assets.values()], String(params.library_id));
      break;
    case 'asset.list': {
      result = browserAssetList(
        [...assets.values()],
        params as AssetListOptions,
        browserLibrary.pair_raw_jpeg,
      );
      break;
    }
    case 'asset.get':
      if (!asset) throw new Error('图片不存在。');
      result = asset;
      break;
    case 'asset.focus':
      if (!asset) throw new Error('图片不存在。');
      result = {
        status: 'unsupported',
        reason: '浏览器模式无法读取相机厂商的对焦记录，请使用桌面版。',
        source: null,
        coordinate_space: 'oriented_full_image',
        orientation: 1,
        regions: [],
      };
      break;
    case 'asset.rate':
      if (!asset) throw new Error('图片不存在。');
      if (
        !Number.isInteger(params.rating) ||
        Number(params.rating) < 0 ||
        Number(params.rating) > 5
      )
        throw new Error('评级必须是 0 至 5 的整数。');
      asset.rating = Number(params.rating);
      result = { ...asset };
      break;
    case 'asset.flag':
      if (!asset) throw new Error('图片不存在。');
      if (!['none', 'pick', 'reject'].includes(String(params.flag)))
        throw new Error('旗标必须是 none、pick 或 reject。');
      asset.flag = params.flag as Flag;
      result = { ...asset };
      break;
    case 'asset.mark_batch': {
      const ids = Array.isArray(params.ids) ? (params.ids as string[]) : [];
      const targets = ids.map((id) => assets.get(id));
      if (!ids.length || targets.some((target) => !target)) throw new Error('图片不存在。');
      for (const target of targets) {
        if (params.rating !== undefined) target!.rating = Number(params.rating);
        if (params.flag !== undefined) target!.flag = params.flag as Flag;
      }
      result = { updated: ids.length };
      break;
    }
    case 'asset.trash': {
      // Browser files cannot be deleted; the demo only takes them out of its catalog.
      const ids = Array.isArray(params.ids) ? (params.ids as string[]) : [];
      const trashed: string[] = [];
      for (const id of ids) {
        const target = assets.get(id);
        if (!target) continue;
        browserTrash.set(id, target);
        assets.delete(id);
        trashed.push(id);
      }
      result = { trashed, failed: [] };
      break;
    }
    case 'asset.restore': {
      const ids = Array.isArray(params.ids) ? (params.ids as string[]) : [];
      const restored: string[] = [];
      for (const id of ids) {
        const target = browserTrash.get(id);
        if (!target) continue;
        assets.set(id, target);
        browserTrash.delete(id);
        restored.push(id);
      }
      result = { restored, failed: [] };
      break;
    }
    case 'asset.crop': {
      if (!asset) throw new Error('图片不存在。');
      const crop = {
        x: Number(params.x),
        y: Number(params.y),
        width: Number(params.width),
        height: Number(params.height),
      };
      if (!validCrop(crop)) throw new Error('裁剪区域超出图像。');
      asset.crop = crop;
      result = { ...asset };
      break;
    }
    case 'asset.reset_crop':
      if (!asset) throw new Error('图片不存在。');
      asset.crop = null;
      result = { ...asset };
      break;
    case 'asset.preview': {
      const tier = demoTier(params);
      if (!asset || !files.has(asset.id))
        throw new Error('此图片已不在浏览器会话中，请重新选择文件。');
      const rendered = demoPreviewSize(asset, tier, !!params.uncropped);
      const crop = params.uncropped ? null : asset?.crop;
      result = {
        width: rendered.width,
        height: rendered.height,
        tier,
        source: crop ? '浏览器真实文件 · 已应用裁剪' : '浏览器真实文件解码',
      } satisfies Preview;
      break;
    }
    case 'asset.histogram': {
      const canvas = applyCrop(await canvasFor(String(params.id)), asset?.crop);
      result = {
        ...histogramFromPixels(
          canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
        ),
        source: asset?.crop ? '浏览器真实裁剪 · 显示 RGB' : '浏览器解码原图 · 显示 RGB',
      };
      break;
    }
    case 'asset.export': {
      if (!asset) throw new Error('图片不存在。');
      const output = applyCrop(await canvasFor(asset.id), asset.crop);
      const blob = await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('JPEG 编码失败'))),
          'image/jpeg',
          0.95,
        ),
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = asset.filename.replace(/\.[^.]+$/, '') + '-edited.jpg';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      result = { path: link.download };
      break;
    }
    default:
      throw new Error('此功能需要 Nebulume 桌面版。浏览器演示不会模拟文件系统或远程操作成功。');
  }
  return result as T;
}

function demoTier(params: Record<string, unknown>): PreviewTier {
  if (typeof params.tier === 'string' && params.tier in TIER_PIXELS)
    return params.tier as PreviewTier;
  const max = Number(params.max_size || 2560);
  return (Object.keys(TIER_PIXELS) as PreviewTier[]).find((t) => TIER_PIXELS[t] >= max) ?? 'p2560';
}
function demoPreviewSize(asset: Asset, tier: PreviewTier, uncropped: boolean) {
  const crop = uncropped ? null : asset.crop;
  const width = Math.max(1, Math.round((asset.width || 1) * (crop?.width ?? 1)));
  const height = Math.max(1, Math.round((asset.height || 1) * (crop?.height ?? 1)));
  const ratio = Math.min(1, TIER_PIXELS[tier] / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}
/** Blob URLs may still be on their way into an <img>; revoke them only after a grace period. */
const REVOKE_GRACE_MS = 30_000;
function retireDemoPreview(entry: Promise<{ url: string }>) {
  void entry
    .then(({ url }) => setTimeout(() => URL.revokeObjectURL(url), REVOKE_GRACE_MS))
    .catch(() => {});
}
function clearDemoPreviews() {
  for (const entry of previewCache.values()) retireDemoPreview(entry);
  previewCache.clear();
}
function renderDemoPreview(id: string, tier: PreviewTier, uncropped: boolean, revision: number) {
  const crop = uncropped ? null : assets.get(id)?.crop;
  const key = JSON.stringify([id, tier, uncropped, revision, crop || null]);
  let entry = previewCache.get(key);
  if (entry) {
    // Least-recently handed out goes first.
    previewCache.delete(key);
    previewCache.set(key, entry);
  } else {
    entry = (async () => {
      const original = applyCrop(await canvasFor(id), crop);
      const ratio = Math.min(1, TIER_PIXELS[tier] / Math.max(original.width, original.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(original.width * ratio));
      canvas.height = Math.max(1, Math.round(original.height * ratio));
      canvas.getContext('2d')!.drawImage(original, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('JPEG 编码失败'))),
          'image/jpeg',
          0.88,
        ),
      );
      return { url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
    })();
    const created = entry;
    created.catch(() => {
      if (previewCache.get(key) === created) previewCache.delete(key);
    });
    previewCache.set(key, entry);
    if (previewCache.size > 200) {
      const oldest = previewCache.keys().next().value!;
      retireDemoPreview(previewCache.get(oldest)!);
      previewCache.delete(oldest);
    }
  }
  return entry;
}
/** Browser demo counterpart of the desktop `neb` protocol URL. */
export async function demoPreviewUrl(
  id: string,
  tier: PreviewTier,
  uncropped = false,
  revision = 0,
): Promise<string> {
  return (await renderDemoPreview(id, tier, uncropped, revision)).url;
}

/** Camera-style local wall time, `YYYY-MM-DDTHH:mm:ss`, as the catalog stores it. */
function localStamp(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Overview numbers for the demo, from the same list the grid shows. */
function browserStats(items: Asset[]) {
  const days = new Map<string, number>();
  const cameras = new Map<string, number>();
  const lenses = new Map<string, number>();
  let picks = 0;
  let rejects = 0;
  let rated = 0;
  let undated = 0;
  for (const item of items) {
    if (item.flag === 'pick') picks++;
    else if (item.flag === 'reject') rejects++;
    else if (item.rating > 0) rated++;
    const day = item.captured_at?.slice(0, 10);
    if (day) days.set(day, (days.get(day) ?? 0) + 1);
    else undated++;
    const camera = item.metadata?.Camera;
    if (camera) cameras.set(camera, (cameras.get(camera) ?? 0) + 1);
    const lens = item.metadata?.Lens;
    if (lens) lenses.set(lens, (lenses.get(lens) ?? 0) + 1);
  }
  const ranked = (map: Map<string, number>) =>
    [...map]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([name, count]) => ({ name, count }));
  return {
    photos: items.length,
    files: items.length,
    bytes: items.reduce((sum, item) => sum + item.size, 0),
    picks,
    rejects,
    rated,
    unprocessed: items.length - picks - rejects - rated,
    undated,
    days: [...days]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, count]) => ({ day, count })),
    cameras: ranked(cameras),
    lenses: ranked(lenses),
    focal: [],
    iso: [],
  };
}

const browserTrash = new Map<string, Asset>();
