import { validCrop, type Crop, type FocusInfo, type FocusRegion, type Preview } from './model';

export interface FocusPresentation {
  regions: FocusRegion[];
  message: string;
}
const validRect = (rect: Crop) =>
  validCrop({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });

/** Focus coordinates are already oriented; use only the renderer's quantized crop. */
export function focusPresentation(
  info: FocusInfo,
  mapping?: Preview['coordinate_mapping'],
): FocusPresentation {
  const empty = (message: string): FocusPresentation => ({ regions: [], message });
  const reason = info.reason?.replace('；不会由点位编号推测位置。', '。');
  if (info.status === 'missing') return empty(reason || '相机未记录可显示的对焦信息。');
  if (info.status !== 'available') return empty(reason || '暂不支持此文件的对焦信息。');
  if (!mapping) return empty('无法确认对焦坐标与当前预览的对应关系，暂不显示。');
  if (
    info.coordinate_space !== 'oriented_full_image' ||
    !Number.isInteger(info.orientation) ||
    info.orientation < 1 ||
    info.orientation > 8 ||
    info.orientation !== mapping.orientation
  )
    return empty('对焦信息与当前预览的方向不匹配，暂不显示。');
  const sizes = [info.image_width, info.image_height, mapping.full_width, mapping.full_height];
  if (sizes.some((size) => !Number.isFinite(size) || !size || size <= 0))
    return empty('缺少有效的对焦参考尺寸，暂不显示。');
  const focusRatio = info.image_width! / info.image_height!;
  const previewRatio = mapping.full_width / mapping.full_height;
  if (Math.abs(focusRatio / previewRatio - 1) > 0.01)
    return empty('对焦参考画幅与当前预览不匹配，暂不显示。');
  if (!validCrop(mapping.crop)) return empty('当前预览的裁剪坐标无效，暂不显示。');
  const valid = info.regions.filter(
    (region) => validRect(region) && (region.kind === 'selected' || region.kind === 'active'),
  );
  if (!valid.length) return empty('相机未提供有效的对焦区域，暂不显示。');
  const regions = valid.flatMap((region) => {
    const projected = cropFocusRegion(region, mapping.crop);
    return projected ? [{ ...projected, kind: region.kind }] : [];
  });
  return {
    regions,
    message: regions.length
      ? `相机记录的对焦区域 · ${regions.length} 处${regions.some((region) => region.kind === 'selected') ? ' · 实线为选定区域' : ''}${regions.some((region) => region.kind === 'active') ? ' · 虚线为活动区域' : ''}`
      : '已记录的对焦区域位于当前裁剪范围之外。',
  };
}

export function cropFocusRegion(region: Crop, crop: Crop): Crop | null {
  if (!validRect(region) || !validRect(crop)) return null;
  const left = Math.max(region.x, crop.x),
    top = Math.max(region.y, crop.y);
  const right = Math.min(region.x + region.width, crop.x + crop.width);
  const bottom = Math.min(region.y + region.height, crop.y + crop.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: (left - crop.x) / crop.width,
    y: (top - crop.y) / crop.height,
    width: (right - left) / crop.width,
    height: (bottom - top) / crop.height,
  };
}
