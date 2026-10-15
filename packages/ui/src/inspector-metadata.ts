export const diagnosticLabels: Record<string, string> = {
  'Decode Status': '原始解码状态',
  Decoder: '解析方式',
  'Preview Source': '预览来源',
  'Preview Dimensions': '预览尺寸',
  Format: '文件格式',
  'Pixel Format': '像素格式',
  'Sensor Dimensions': '传感器尺寸',
  CFA: '感光阵列',
};

type Field = { label: string; aliases: readonly string[] };
type Metadata = Record<string, string>;
export type InspectorParameter = { label: string; value: string | null };

const exposureFields: readonly Field[] = [
  { label: '光圈', aliases: ['Aperture', 'FNumber', 'EXIF FNumber'] },
  { label: '快门', aliases: ['Exposure', 'ExposureTime', 'EXIF ExposureTime'] },
  {
    label: 'ISO',
    aliases: [
      'ISO',
      'PhotographicSensitivity',
      'ISOSpeedRatings',
      'EXIF PhotographicSensitivity',
      'EXIF ISOSpeedRatings',
    ],
  },
];

const groupFields: readonly { title: string; fields: readonly Field[] }[] = [
  {
    title: '设备',
    fields: [
      { label: '品牌', aliases: ['Make'] },
      { label: '相机', aliases: ['Camera', 'Model'] },
      { label: '镜头', aliases: ['Lens', 'LensModel'] },
    ],
  },
  {
    title: '拍摄',
    fields: [
      { label: '焦距', aliases: ['Focal Length', 'FocalLength'] },
      { label: '等效焦距', aliases: ['Focal Length (35 mm)'] },
      { label: '曝光补偿', aliases: ['Exposure Bias'] },
      { label: '曝光程序', aliases: ['Exposure Program'] },
      { label: '测光模式', aliases: ['Metering'] },
      { label: '白平衡', aliases: ['White Balance'] },
      { label: '闪光灯', aliases: ['Flash'] },
      { label: '拍摄时间', aliases: ['Captured', 'DateTimeOriginal'] },
      { label: '拍摄时区', aliases: ['Capture Time Zone', 'Timezone'] },
    ],
  },
  {
    title: '其他',
    fields: [
      { label: '方向', aliases: ['Orientation'] },
      { label: '色彩空间', aliases: ['Color Space', 'ColorSpace'] },
      { label: '作者', aliases: ['Artist'] },
      { label: '版权', aliases: ['Copyright'] },
      { label: '软件', aliases: ['Software'] },
    ],
  },
];

function parameter(metadata: Metadata, field: Field): InspectorParameter {
  // Values already carry the decoder's units. Preserve them; APEX ApertureValue
  // and ShutterSpeedValue are deliberately not treated as f-number/seconds.
  const value = field.aliases.map((key) => metadata[key]?.trim()).find(Boolean) || null;
  return { label: field.label, value };
}

export function exposureParameters(metadata: Metadata): InspectorParameter[] {
  return exposureFields.map((field) => parameter(metadata, field));
}

export function inspectorMetadataGroups(metadata: Metadata) {
  const knownKeys = new Set([
    ...exposureFields.flatMap((field) => field.aliases),
    ...groupFields.flatMap((group) => group.fields.flatMap((field) => field.aliases)),
  ]);
  const groups = groupFields.map((group) => ({
    title: group.title,
    parameters: group.fields
      .map((field) => parameter(metadata, field))
      .filter((field) => field.value !== null),
  }));
  const other = groups[groups.length - 1];
  for (const [key, value] of Object.entries(metadata)) {
    if (!knownKeys.has(key) && !key.startsWith('EXIF ') && !diagnosticLabels[key] && value.trim()) {
      other.parameters.push({ label: key, value: value.trim() });
    }
  }
  return groups.filter((group) => group.parameters.length > 0);
}
