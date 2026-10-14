import { For, Show, createMemo, createResource } from 'solid-js';
import { execute } from './api';
import {
  bytes,
  errorMessage,
  histogramPath,
  imageRequestKey,
  validCrop,
  type Asset,
  type Crop,
  type Histogram,
} from './model';
import { displayDate } from './workspace';
import Icon from './Icon';

export default function AssetInspector(props: {
  asset: Asset;
  management?: boolean;
  busy?: boolean;
  cropMode?: boolean;
  crop?: Crop;
  setCrop?: (crop: Crop) => void;
  onSaveCrop?: () => void;
  onResetCrop: () => void;
  onRate: (rating: number) => void;
  onCrop: () => void;
  onExport: () => void;
  onRefresh?: () => void;
  onClose: () => void;
}) {
  const [histogram] = createResource(
    () => imageRequestKey(props.asset),
    async (key) => {
      try {
        return {
          data: await execute<Histogram>('asset.histogram', { id: JSON.parse(key).id }),
          error: '',
        };
      } catch (error) {
        return { data: null, error: errorMessage(error) };
      }
    },
  );
  const ceiling = createMemo(() => {
    const h = histogram()?.data;
    return h ? Math.max(...h.red, ...h.green, ...h.blue, 1) : 1;
  });
  return (
    <aside class="asset-inspector" aria-label="影像详情">
      <div class="inspector-heading">
        <span>{props.cropMode ? '裁剪与影像信息' : '影像信息'}</span>
        <button class="icon-button" aria-label="关闭影像详情" onClick={props.onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div class="inspector-file">
        <span class="inspector-filetype">{props.asset.extension.toUpperCase()}</span>
        <h2 title={props.asset.filename}>{props.asset.filename}</h2>
        <p>
          {props.asset.width && props.asset.height
            ? `${props.asset.width} × ${props.asset.height} px`
            : '尺寸待解析'}
          <span>·</span>
          {bytes(props.asset.size)}
        </p>
        <div class="rating-stars" aria-label="照片评级">
          <For each={[1, 2, 3, 4, 5]}>
            {(value) => (
              <button
                classList={{ filled: props.asset.rating >= value }}
                onClick={() => props.onRate(value)}
                disabled={props.busy}
                aria-label={`评为 ${value} 星`}
                aria-pressed={props.asset.rating === value}
              >
                <Icon name="star" size={19} />
              </button>
            )}
          </For>
          <button
            class="clear-rating"
            onClick={() => props.onRate(0)}
            disabled={!props.asset.rating || props.busy}
          >
            清除
          </button>
        </div>
      </div>
      <Show when={props.cropMode && props.crop}>
        <section class="inspector-section crop-panel">
          <div class="section-title">
            <h3>裁剪选区</h3>
            <span>原片保持不变</span>
          </div>
          <p class="muted">拖动图像选区，或输入百分比。</p>
          <div class="crop-inputs">
            <For each={['x', 'y', 'width', 'height'] as const}>
              {(key) => (
                <label>
                  {{ x: '左侧', y: '顶部', width: '宽度', height: '高度' }[key]}
                  <div>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={Number((props.crop![key] * 100).toFixed(1))}
                      onInput={(event) =>
                        props.setCrop?.({
                          ...props.crop!,
                          [key]: Number(event.currentTarget.value) / 100,
                        })
                      }
                    />
                    <span>%</span>
                  </div>
                </label>
              )}
            </For>
          </div>
          <Show when={!validCrop(props.crop!)}>
            <p class="form-error">选区须位于图像范围内，宽高须大于 0。</p>
          </Show>
          <div class="crop-actions">
            <button
              class="button"
              onClick={() => props.setCrop?.({ x: 0, y: 0, width: 1, height: 1 })}
            >
              全图
            </button>
            <button
              class="button primary"
              disabled={props.busy || !validCrop(props.crop!)}
              onClick={props.onSaveCrop}
            >
              保存裁剪
            </button>
          </div>
        </section>
      </Show>
      <section class="inspector-section">
        <div class="section-title">
          <h3>直方图</h3>
          <span>显示 RGB</span>
        </div>
        <div class="histogram">
          <Show
            when={histogram()?.data && !histogram.loading}
            fallback={
              <div class="histogram-empty">
                {histogram.loading ? '正在计算像素分布…' : '暂不支持此影像'}
              </div>
            }
          >
            <svg
              viewBox="0 0 255 80"
              preserveAspectRatio="none"
              role="img"
              aria-label="当前图片 RGB 直方图"
            >
              <path class="hist-red" d={histogramPath(histogram()!.data!.red, ceiling())} />
              <path class="hist-green" d={histogramPath(histogram()!.data!.green, ceiling())} />
              <path class="hist-blue" d={histogramPath(histogram()!.data!.blue, ceiling())} />
            </svg>
          </Show>
        </div>
        <div class="histogram-axis">
          <span>0</span>
          <i />
          <span>255</span>
        </div>
        <p class="histogram-source">{histogram()?.data?.source || histogram()?.error}</p>
      </section>
      <section class="inspector-section">
        <div class="section-title">
          <h3>拍摄参数</h3>
          <span>EXIF</span>
        </div>
        <Show
          when={Object.keys(props.asset.metadata).length}
          fallback={<p class="metadata-empty">此文件未提供可读取的 EXIF 信息。</p>}
        >
          <dl class="metadata">
            <For each={Object.entries(props.asset.metadata)}>
              {([key, value]) => (
                <>
                  <dt>
                    {(
                      {
                        Camera: '相机',
                        Make: '品牌',
                        Model: '型号',
                        Lens: '镜头',
                        ISO: 'ISO',
                        Aperture: '光圈',
                        ExposureTime: '快门',
                        FocalLength: '焦距',
                        DateTimeOriginal: '拍摄时间',
                        Orientation: '方向',
                        ColorSpace: '色彩空间',
                      } as Record<string, string>
                    )[key] || key}
                  </dt>
                  <dd>{value}</dd>
                </>
              )}
            </For>
          </dl>
        </Show>
      </section>
      <section class="inspector-section">
        <div class="section-title">
          <h3>文件详情</h3>
          <Show when={props.onRefresh}>
            <button
              class="icon-button"
              aria-label="重新读取原图"
              title="重新读取原图"
              onClick={props.onRefresh}
              disabled={props.busy || props.cropMode}
            >
              <Icon name="refresh" size={15} />
            </button>
          </Show>
        </div>
        <dl class="metadata">
          <dt>修改时间</dt>
          <dd>{displayDate(props.asset.modified_at)}</dd>
          <dt>状态</dt>
          <dd>{props.asset.availability === 'available' ? '可访问' : props.asset.availability}</dd>
          <dt>{props.asset.source_key ? '来源对象' : '文件路径'}</dt>
          <dd class="path-value">{props.asset.source_key || props.asset.path}</dd>
        </dl>
        <Show when={props.asset.crop}>
          <div class="saved-crop">
            <Icon name="crop" size={15} />
            <span>已保存裁剪配方</span>
            <button onClick={props.onResetCrop} disabled={props.busy}>
              重置
            </button>
          </div>
        </Show>
      </section>
      <div class="inspector-actions">
        <button class="button" onClick={props.onCrop} disabled={props.busy}>
          <Icon name="crop" size={15} />
          {props.management ? '打开查看器' : '裁剪'}
        </button>
        <Show when={!props.management}>
          <button class="button" onClick={props.onExport} disabled={props.busy || props.cropMode}>
            <Icon name="export" size={15} />
            导出 JPEG
          </button>
        </Show>
      </div>
    </aside>
  );
}
