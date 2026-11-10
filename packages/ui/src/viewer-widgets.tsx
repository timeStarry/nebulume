import { Show, type JSX } from 'solid-js';
import { fieldValue, formatCaptured } from './inspector-fields';
import { histogramPath, type Asset, type Histogram } from './model';
import './ui/Widget.css';

export interface WidgetContext {
  /** 1-based position in the current set, and its size. */
  index: number;
  total: number;
  folder?: string;
  histogram?: Histogram;
}

export type WidgetGroup = '文件' | '曝光' | '器材' | '评价' | '其他';

export interface WidgetDef {
  id: string;
  name: string;
  group: WidgetGroup;
  needsHistogram?: boolean;
  /** Returns null when this photo has nothing to show, so the corner leaves no gap. */
  render: (asset: Asset, context: WidgetContext) => JSX.Element | null;
}

const value = (key: string) => (asset: Asset) => asset.metadata?.[key]?.trim() || null;
const line = (text: string | null) => (text ? <span>{text}</span> : null);
const formatBytes = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : bytes >= 1e6
      ? `${(bytes / 1e6).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

function exposurePart(id: 'aperture' | 'shutter' | 'iso', asset: Asset) {
  const parts = (fieldValue('exposure', asset) ?? '').split(' · ');
  const metadata = asset.metadata ?? ({} as Record<string, string>);
  if (id === 'aperture') return metadata.Aperture?.trim() || null;
  if (id === 'shutter') return metadata.Exposure?.trim() || null;
  return parts.find((part) => part.startsWith('ISO')) ?? null;
}

function HistogramMark(props: { histogram: Histogram }) {
  const ceiling = () =>
    Math.max(...props.histogram.red, ...props.histogram.green, ...props.histogram.blue, 1);
  return (
    <svg
      class="nl-widget-hist"
      viewBox="0 0 255 80"
      preserveAspectRatio="none"
      role="img"
      aria-label="RGB 直方图"
    >
      <path class="hist-red" d={histogramPath(props.histogram.red, ceiling())} />
      <path class="hist-green" d={histogramPath(props.histogram.green, ceiling())} />
      <path class="hist-blue" d={histogramPath(props.histogram.blue, ceiling())} />
    </svg>
  );
}

/** Every widget the overlay can show. Adding a feature to the overlay means adding an entry here. */
export const WIDGETS: readonly WidgetDef[] = [
  { id: 'filename', name: '文件名', group: '文件', render: (asset) => <b>{asset.filename}</b> },
  {
    id: 'position',
    name: '序号',
    group: '文件',
    render: (_asset, context) =>
      context.total > 1 ? <span>{`${context.index} / ${context.total}`}</span> : null,
  },
  {
    id: 'folder',
    name: '文件夹',
    group: '文件',
    render: (_asset, context) => line(context.folder ?? null),
  },
  {
    id: 'captured',
    name: '拍摄时间',
    group: '文件',
    render: (asset) =>
      formatCaptured(asset.captured_at) ? <b>{formatCaptured(asset.captured_at)}</b> : null,
  },
  {
    id: 'rating',
    name: '星级',
    group: '评价',
    render: (asset) =>
      asset.rating > 0 ? (
        <span class="nl-widget-stars" aria-label={`${asset.rating} 星`}>
          {'★'.repeat(asset.rating)}
          <span class="nl-widget-stars-off">{'★'.repeat(5 - asset.rating)}</span>
        </span>
      ) : null,
  },
  {
    id: 'flag',
    name: '旗标',
    group: '评价',
    render: (asset) =>
      asset.flag === 'pick' ? (
        <span class="nl-widget-pick">留用</span>
      ) : asset.flag === 'reject' ? (
        <span class="nl-widget-reject">淘汰</span>
      ) : null,
  },
  {
    id: 'exposure',
    name: '曝光组合',
    group: '曝光',
    render: (asset) => {
      const parts = [
        exposurePart('aperture', asset),
        exposurePart('shutter', asset),
        exposurePart('iso', asset),
        fieldValue('focal', asset),
      ].filter(Boolean) as string[];
      return parts.length ? (
        <span class="nl-widget-exposure">
          {parts.map((part) => (
            <b>{part}</b>
          ))}
        </span>
      ) : null;
    },
  },
  {
    id: 'aperture',
    name: '光圈',
    group: '曝光',
    render: (asset) => line(exposurePart('aperture', asset)),
  },
  {
    id: 'shutter',
    name: '快门',
    group: '曝光',
    render: (asset) => line(exposurePart('shutter', asset)),
  },
  { id: 'iso', name: 'ISO', group: '曝光', render: (asset) => line(exposurePart('iso', asset)) },
  { id: 'focal', name: '焦距', group: '曝光', render: (asset) => line(fieldValue('focal', asset)) },
  {
    id: 'exposure-bias',
    name: '曝光补偿',
    group: '曝光',
    render: (asset) => line(value('Exposure Bias')(asset)),
  },
  {
    id: 'metering',
    name: '测光模式',
    group: '曝光',
    render: (asset) => line(value('Metering')(asset)),
  },
  {
    id: 'white-balance',
    name: '白平衡',
    group: '曝光',
    render: (asset) => line(value('White Balance')(asset)),
  },
  { id: 'body', name: '相机', group: '器材', render: (asset) => line(fieldValue('body', asset)) },
  { id: 'lens', name: '镜头', group: '器材', render: (asset) => line(fieldValue('lens', asset)) },
  {
    id: 'body-lens',
    name: '相机与镜头',
    group: '器材',
    render: (asset) => {
      const parts = [fieldValue('body', asset), fieldValue('lens', asset)].filter(Boolean);
      return parts.length ? <span class="nl-widget-muted">{parts.join(' · ')}</span> : null;
    },
  },
  {
    id: 'histogram',
    name: '直方图',
    group: '其他',
    needsHistogram: true,
    render: (_asset, context) => (
      <Show when={context.histogram} fallback={null}>
        {(histogram) => <HistogramMark histogram={histogram()} />}
      </Show>
    ),
  },
  {
    id: 'dimensions',
    name: '尺寸',
    group: '其他',
    render: (asset) => line(fieldValue('dimensions', asset)),
  },
  {
    id: 'file-size',
    name: '文件大小',
    group: '其他',
    render: (asset) => line(asset.size ? formatBytes(asset.size) : null),
  },
  {
    id: 'format',
    name: '格式',
    group: '其他',
    render: (asset) => line(asset.extension ? asset.extension.toUpperCase() : null),
  },
  { id: 'gps', name: 'GPS', group: '其他', render: (asset) => line(value('GPS')(asset)) },
];

export const WIDGET_IDS = new Set(WIDGETS.map((widget) => widget.id));
export const widgetById = (id: string) => WIDGETS.find((widget) => widget.id === id);
