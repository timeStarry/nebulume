import {
  histogramFromPixels,
  validCrop,
  type Asset,
  type Crop,
  type Library,
  type Preview,
} from './model';

const files = new Map<string, File>();
const assets = new Map<string, Asset>();
const previewCache = new Map<string, Preview>();
const browserLibrary: Library = {
  id: 'browser',
  name: '临时图片库',
  root: '浏览器内存 · 关闭页面后清除',
  created_at: new Date().toISOString(),
};

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
): Promise<{ added: number; errors: string[] }> {
  const errors: string[] = [];
  let added = 0;
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
        modified_at: new Date(file.lastModified).toISOString(),
        width: canvas.width,
        height: canvas.height,
        rating: 0,
        metadata: {},
        availability: 'available',
      });
      added++;
    } catch (error) {
      files.delete(id);
      errors.push(`${file.name}：${(error as Error).message}`);
    }
  }
  return { added, errors };
}

export async function demoCommand<T>(command: string, params: Record<string, unknown>): Promise<T> {
  const asset = assets.get(String(params.id));
  let result: unknown;
  switch (command) {
    case 'system.info':
      result = {
        version: '0.1.0-alpha.1',
        mode: 'browser',
        limits: ['浏览器演示：临时文件会话，EXIF / RAW / 远程存储 / SD 卡导入需桌面端。'],
      };
      break;
    case 'library.list':
      result = [browserLibrary];
      break;
    case 'storage.list':
      result = [];
      break;
    case 'asset.list': {
      const query = String(params.query || '').toLowerCase();
      const list = [...assets.values()].filter(
        (a) =>
          (!query || a.filename.toLowerCase().includes(query)) &&
          (!params.rating || a.rating >= Number(params.rating)),
      );
      result = {
        items: list.slice(
          Number(params.offset || 0),
          Number(params.offset || 0) + Number(params.limit || 500),
        ),
        total: list.length,
      };
      break;
    }
    case 'asset.get':
      if (!asset) throw new Error('图片不存在。');
      result = asset;
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
      const id = String(params.id);
      const max = Number(params.max_size || 1800);
      const crop = params.uncropped ? null : asset?.crop;
      const key = `${id}:${max}:${JSON.stringify(crop)}`;
      if (!previewCache.has(key)) {
        const original = applyCrop(await canvasFor(id), crop);
        const ratio = Math.min(1, max / Math.max(original.width, original.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(original.width * ratio));
        canvas.height = Math.max(1, Math.round(original.height * ratio));
        canvas.getContext('2d')!.drawImage(original, 0, 0, canvas.width, canvas.height);
        previewCache.set(key, {
          data_url: canvas.toDataURL('image/jpeg', 0.88),
          width: canvas.width,
          height: canvas.height,
          source: crop ? '浏览器真实文件 · 已应用裁剪' : '浏览器真实文件解码',
        });
        if (previewCache.size > 200) previewCache.delete(previewCache.keys().next().value!);
      }
      result = previewCache.get(key);
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
