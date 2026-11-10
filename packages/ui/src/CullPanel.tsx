import { For, Show, createMemo, createResource } from 'solid-js';
import { execute } from './api';
import Icon from './Icon';
import { Button } from './ui';
import { exposureParameters } from './inspector-metadata';
import { histogramPath, imageRequestKey, type Asset, type Flag, type Histogram } from './model';

/**
 * Culling side panel: what decides keep or reject at a glance (histogram, exposure,
 * camera) and the marks themselves, with progress through the frozen queue.
 */
export default function CullPanel(props: {
  asset: Asset;
  total: number;
  seen: number;
  picks: number;
  rejects: number;
  busy: boolean;
  onFlag: (flag: Flag) => void;
  onRate: (rating: number) => void;
  onFinish: () => void;
  /** The last mark's kind while its confirmation plays. */
  pulse?: 'rate' | 'flag';
  /** 1-based position in the queue; undefined while the queue loads. */
  position?: number;
}) {
  // The service answers from its histogram memory for photos already seen.
  const [histogram] = createResource(
    () => imageRequestKey(props.asset),
    (key) =>
      execute<Histogram>('asset.histogram', { id: JSON.parse(key).id }).catch(() => undefined),
  );
  const ceiling = createMemo(() => {
    const h = histogram();
    return h ? Math.max(...h.red, ...h.green, ...h.blue, 1) : 1;
  });
  const exposure = createMemo(() => exposureParameters(props.asset.metadata));
  const details = createMemo(() =>
    [
      ['相机', props.asset.metadata.Camera || props.asset.metadata.Model],
      ['镜头', props.asset.metadata.Lens],
      ['拍摄', props.asset.captured_at?.replace('T', ' ').slice(0, 16)],
      [
        '尺寸',
        props.asset.width && props.asset.height
          ? `${props.asset.width} × ${props.asset.height}`
          : '',
      ],
    ].filter((row): row is [string, string] => !!row[1]),
  );
  const seenShare = () => (props.total ? (props.seen / props.total) * 100 : 0);
  return (
    <aside
      class={`cull-panel${props.pulse ? ` pulse pulse-${props.pulse}` : ''}`}
      aria-label="选片面板"
    >
      <div class="cull-status" role="status" aria-live="polite">
        <CullStatus asset={props.asset} position={props.position} total={props.total} />
      </div>
      <div class="cull-progress">
        <div class="cull-progress-line">
          <span>
            已看 {props.seen} / {props.total}
          </span>
          <span class="cull-progress-track" aria-hidden="true">
            <span style={{ width: `${seenShare()}%` }} />
          </span>
        </div>
        <div class="cull-counts">
          <span class="count-pick">
            <Icon name="check" size={14} />
            {props.picks} 留用
          </span>
          <span class="count-reject">
            <Icon name="close" size={14} />
            {props.rejects} 淘汰
          </span>
          <Button size="sm" variant="primary" icon="checks" onClick={() => props.onFinish()}>
            完成选片
          </Button>
        </div>
      </div>
      <div class="cull-panel-name">
        <strong title={props.asset.filename}>{props.asset.filename}</strong>
        <span>{props.asset.extension.toUpperCase()}</span>
      </div>
      <div class="cull-panel-scroll">
        <div class="cull-histogram" aria-busy={histogram.loading}>
          <Show
            when={histogram()}
            fallback={<span>{histogram.loading ? '正在计算直方图…' : '直方图不可用'}</span>}
          >
            {(h) => (
              <svg
                viewBox="0 0 255 80"
                preserveAspectRatio="none"
                role="img"
                aria-label="RGB 直方图"
              >
                <path class="hist-red" d={histogramPath(h().red, ceiling())} />
                <path class="hist-green" d={histogramPath(h().green, ceiling())} />
                <path class="hist-blue" d={histogramPath(h().blue, ceiling())} />
              </svg>
            )}
          </Show>
        </div>
        <dl class="cull-exposure" aria-label="曝光参数">
          <For each={exposure()}>
            {(field) => (
              <div>
                <dt>{field.label}</dt>
                <dd>{field.value || '—'}</dd>
              </div>
            )}
          </For>
        </dl>
        <dl class="cull-details">
          <For each={details()}>
            {([label, value]) => (
              <>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </>
            )}
          </For>
        </dl>
      </div>
      <div class="cull-keys">
        <div class="cull-flag-keys">
          <button
            class={`cull-key pick ${props.asset.flag === 'pick' ? 'on' : ''}`}
            aria-pressed={props.asset.flag === 'pick'}
            disabled={props.busy}
            onClick={() => props.onFlag(props.asset.flag === 'pick' ? 'none' : 'pick')}
          >
            留用<kbd>P</kbd>
          </button>
          <button
            class={`cull-key reject ${props.asset.flag === 'reject' ? 'on' : ''}`}
            aria-pressed={props.asset.flag === 'reject'}
            disabled={props.busy}
            onClick={() => props.onFlag(props.asset.flag === 'reject' ? 'none' : 'reject')}
          >
            淘汰<kbd>X</kbd>
          </button>
        </div>
        <div class="cull-stars" role="group" aria-label="评级">
          <For each={[1, 2, 3, 4, 5]}>
            {(value) => (
              <button
                class={value <= props.asset.rating ? 'on' : ''}
                aria-label={`评为 ${value} 星`}
                aria-pressed={value === props.asset.rating}
                disabled={props.busy}
                onClick={() => props.onRate(value === props.asset.rating ? 0 : value)}
              >
                ★
              </button>
            )}
          </For>
        </div>
      </div>
    </aside>
  );
}

/** Position, stars and flag of the photo on screen: the confirmation that a mark landed. */
export function CullStatus(props: { asset: Asset; position?: number; total: number }) {
  return (
    <>
      <span class="cull-status-position">
        {props.position === undefined ? '队列载入中…' : `${props.position} / ${props.total}`}
      </span>
      <span class="cull-status-stars" aria-label={`${props.asset.rating} 星`}>
        <For each={[1, 2, 3, 4, 5]}>
          {(value) => <i class={value <= props.asset.rating ? 'on' : ''}>★</i>}
        </For>
      </span>
      <span class={`cull-status-flag ${props.asset.flag || 'none'}`}>
        {props.asset.flag === 'pick' ? '留用' : props.asset.flag === 'reject' ? '淘汰' : '未标记'}
      </span>
    </>
  );
}
