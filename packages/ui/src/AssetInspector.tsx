import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
} from 'solid-js';
import { desktop, execute } from './api';
import type { CacheStats } from './cache-model';
import {
  bytes,
  errorMessage,
  histogramPath,
  imageRequestKey,
  renderSourceLabel,
  validCrop,
  type Asset,
  type Crop,
  type Histogram,
} from './model';
import { displayDate } from './workspace';
import Icon from './Icon';
import {
  diagnosticLabels,
  exposureParameters,
  inspectorMetadataGroups,
} from './inspector-metadata';
import './inspector.css';

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
  const cropErrorId = createUniqueId();
  const [offlineBusy, setOfflineBusy] = createSignal(false);
  const [offlineError, setOfflineError] = createSignal('');
  createEffect(() => {
    props.asset.id;
    setOfflineError('');
  });
  const [offline, { mutate: updateOffline }] = createResource(
    () =>
      desktop && props.asset.source_key
        ? { id: props.asset.id, pinned: props.asset.cache_pinned }
        : false,
    async (asset) => {
      if (typeof asset.pinned === 'boolean')
        return { id: asset.id, pinned: asset.pinned, error: '' };
      try {
        const current = await execute<CacheStats>('cache.stats');
        return {
          id: asset.id,
          pinned: current.pinned.some((item) => item.asset_id === asset.id),
          error: '',
        };
      } catch (cause) {
        return { id: asset.id, pinned: false, error: errorMessage(cause) };
      }
    },
  );
  async function toggleOffline() {
    const current = offline();
    if (
      !desktop ||
      offlineBusy() ||
      offline.loading ||
      !current ||
      current.id !== props.asset.id ||
      current.error
    )
      return;
    const id = props.asset.id;
    setOfflineBusy(true);
    setOfflineError('');
    try {
      const result = await execute<{ pinned: boolean }>('asset.offline.set', {
        id,
        pinned: !current.pinned,
      });
      if (props.asset.id === id) updateOffline({ id, pinned: result.pinned, error: '' });
    } catch (cause) {
      if (props.asset.id === id) setOfflineError(errorMessage(cause));
    } finally {
      setOfflineBusy(false);
    }
  }
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
  const inspectedAsset = createMemo(() => {
    const inspected = !histogram.loading && histogram()?.data?.asset;
    return inspected && inspected.id === props.asset.id
      ? {
          ...props.asset,
          width: inspected.width,
          height: inspected.height,
          metadata: inspected.metadata,
          size: inspected.size,
          availability: inspected.availability,
          cache_pinned: inspected.cache_pinned ?? props.asset.cache_pinned,
          cache_update_available:
            inspected.cache_update_available ?? props.asset.cache_update_available,
        }
      : props.asset;
  });
  const offlineUpdateAvailable = createMemo(
    () =>
      !!props.asset.source_key &&
      !!(offline()?.id === props.asset.id ? offline()?.pinned : inspectedAsset().cache_pinned) &&
      !!inspectedAsset().cache_update_available,
  );
  const ceiling = createMemo(() => {
    const h = histogram()?.data;
    return h ? Math.max(...h.red, ...h.green, ...h.blue, 1) : 1;
  });
  const exposure = createMemo(() => exposureParameters(inspectedAsset().metadata));
  const histogramError = () => (!histogram.loading && histogram()?.error) || '';
  const previewSource = createMemo(
    () =>
      (!histogram.loading && histogram()?.data?.source) ||
      inspectedAsset().metadata['Preview Source'],
  );
  const embeddedPreview = () => ['embedded_jpeg', 'remote_embedded_jpeg'].includes(previewSource());
  const sourceRestriction = createMemo(() =>
    embeddedPreview() ? renderSourceLabel(previewSource()) : '',
  );
  const diagnostics = createMemo(() => {
    const entries = Object.entries(inspectedAsset().metadata).filter(
      ([key]) => diagnosticLabels[key],
    );
    const source = !histogram.loading && histogram()?.data?.source;
    if (source) {
      const existing = entries.findIndex(([key]) => key === 'Preview Source');
      if (existing >= 0) entries[existing] = ['Preview Source', source];
      else entries.push(['Preview Source', source]);
    }
    return entries;
  });
  const previewSourceLabel = (source: string) =>
    ({
      embedded_jpeg: '相机内嵌预览',
      remote_embedded_jpeg: '相机内嵌预览',
      raw_demosaic: 'RAW 基础显影',
      raster: '原图解码',
    })[source] || source.replace(' · 显示 RGB', '');
  const metadataGroups = createMemo(() => inspectorMetadataGroups(inspectedAsset().metadata));
  const hasExif = createMemo(
    () =>
      metadataGroups().length > 0 ||
      exposure().some((field) => field.value !== null) ||
      Object.keys(inspectedAsset().metadata).some((key) => key.startsWith('EXIF ')),
  );
  return (
    <aside
      class="asset-inspector"
      classList={{ 'management-inspector': props.management }}
      aria-label="影像详情"
    >
      <div class="inspector-heading">
        <span>影像信息</span>
        <button class="icon-button" aria-label="关闭影像详情" onClick={props.onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div class="inspector-file">
        <span class="inspector-filetype">{props.asset.extension.toUpperCase()}</span>
        <h2 title={props.asset.filename}>{props.asset.filename}</h2>
        <p>
          {inspectedAsset().width && inspectedAsset().height
            ? `${embeddedPreview() ? '预览尺寸 ' : ''}${inspectedAsset().width} × ${inspectedAsset().height} px`
            : '尺寸待解析'}
          <span>·</span>
          {bytes(inspectedAsset().size)}
        </p>
        <div class="rating-stars" role="group" aria-label="照片评级">
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
          </div>
          <p class="muted">拖动选区或输入百分比，保存为配方，原图不变。</p>
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
                      disabled={props.busy}
                      aria-invalid={!validCrop(props.crop!)}
                      aria-describedby={!validCrop(props.crop!) ? cropErrorId : undefined}
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
            <p id={cropErrorId} class="form-error" role="alert">
              选区须位于图像范围内，宽高须大于 0。
            </p>
          </Show>
          <div class="crop-actions">
            <button
              class="button"
              disabled={props.busy}
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
          <span>RGB</span>
        </div>
        <div class="histogram" aria-busy={histogram.loading}>
          <Show
            when={histogram()?.data && !histogram.loading}
            fallback={
              <div class="histogram-empty" role="status">
                {histogram.loading ? '正在计算像素分布…' : '直方图不可用'}
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
        <dl class="exposure-summary" aria-label="曝光参数">
          <For each={exposure()}>
            {(field) => (
              <div classList={{ 'is-missing': field.value === null }}>
                <dt>{field.label}</dt>
                <dd
                  title={field.value || '未记录'}
                  aria-label={field.value === null ? `${field.label}未记录` : undefined}
                >
                  {field.value || '—'}
                </dd>
              </div>
            )}
          </For>
        </dl>
        <Show when={sourceRestriction() || histogramError()}>
          <p class="histogram-source" classList={{ 'is-error': !!histogramError() }}>
            {histogramError() || sourceRestriction()}
          </p>
        </Show>
      </section>
      <section class="inspector-section">
        <div class="section-title">
          <h3>拍摄信息</h3>
        </div>
        <Show when={!hasExif()}>
          <p class="metadata-empty">此文件未提供可读取的 EXIF 信息。</p>
        </Show>
        <div class="shooting-parameters">
          <For each={metadataGroups()}>
            {(group) => (
              <section class="inspector-metadata-group" aria-label={group.title}>
                <h4>{group.title}</h4>
                <dl class="metadata">
                  <For each={group.parameters}>
                    {(field) => (
                      <>
                        <dt>{field.label}</dt>
                        <dd>{field.value}</dd>
                      </>
                    )}
                  </For>
                </dl>
              </section>
            )}
          </For>
        </div>
        <Show when={Object.keys(inspectedAsset().metadata).some((key) => key.startsWith('EXIF '))}>
          <details class="exif-details exif-fields">
            <summary>全部有效 EXIF 字段</summary>
            <dl class="metadata">
              <For
                each={Object.entries(inspectedAsset().metadata).filter(([key]) =>
                  key.startsWith('EXIF '),
                )}
              >
                {([key, value]) => (
                  <>
                    <dt>{key.slice(5)}</dt>
                    <dd>{value}</dd>
                  </>
                )}
              </For>
            </dl>
          </details>
        </Show>
        <Show when={diagnostics().length}>
          <details class="exif-details decode-diagnostics">
            <summary>解码诊断</summary>
            <dl class="metadata">
              <For each={diagnostics()}>
                {([key, value]) => (
                  <>
                    <dt>{diagnosticLabels[key]}</dt>
                    <dd>{key === 'Preview Source' ? previewSourceLabel(value) : value}</dd>
                  </>
                )}
              </For>
            </dl>
          </details>
        </Show>
      </section>
      <section class="inspector-section">
        <div class="section-title">
          <h3>文件详情</h3>
          <Show when={props.management && props.onRefresh}>
            <button
              class={offlineUpdateAvailable() ? 'button small' : 'icon-button'}
              aria-label={offlineUpdateAvailable() ? '更新离线版本' : '重新读取原图'}
              title={
                offlineUpdateAvailable()
                  ? '远端有更新；更新此离线版本，评级与裁剪配方保留'
                  : '重新读取原图'
              }
              onClick={props.onRefresh}
              disabled={props.busy || props.cropMode}
            >
              <Icon name="refresh" size={15} />
              <Show when={offlineUpdateAvailable()}>更新离线版本</Show>
            </button>
          </Show>
        </div>
        <dl class="metadata">
          <Show when={props.asset.created_at}>
            {(createdAt) => (
              <>
                <dt>创建时间</dt>
                <dd>{displayDate(createdAt())}</dd>
              </>
            )}
          </Show>
          <dt>修改时间</dt>
          <dd>{displayDate(props.asset.modified_at)}</dd>
          <dt>状态</dt>
          <dd>
            <span
              class="file-availability"
              classList={{
                'is-unavailable': ['missing', 'unsupported'].includes(
                  inspectedAsset().availability,
                ),
              }}
            >
              <Icon
                name={
                  inspectedAsset().availability === 'available'
                    ? 'check'
                    : inspectedAsset().availability === 'remote'
                      ? 'cloud'
                      : 'info'
                }
                size={15}
              />
              {{
                available: '可访问',
                remote: '远端文件',
                missing: '文件不可访问',
                unsupported: '暂不支持此格式',
              }[inspectedAsset().availability] || inspectedAsset().availability}
            </span>
          </dd>
          <dt>{props.asset.source_key ? '远端对象键' : '文件路径'}</dt>
          <dd class="path-value">{props.asset.source_key || props.asset.path}</dd>
        </dl>
        <Show when={offlineUpdateAvailable()}>
          <p
            class="histogram-source offline-update"
            title="远端内容已变化，当前仍使用已固定的离线版本。"
          >
            <strong>有更新</strong>
            <Show when={!props.management}>
              {props.onRefresh ? ' · 用顶部刷新更新离线版本。' : ' · 在图片库中更新离线版本。'}
            </Show>
          </p>
        </Show>
        <Show when={props.asset.source_key}>
          <div class="saved-crop">
            <Icon name="cloud" size={15} />
            <span>
              {offlineBusy() ? '正在更新离线保留…' : offline()?.pinned ? '已离线保留' : '按需缓存'}
            </span>
            <button
              class="button"
              onClick={() => void toggleOffline()}
              aria-pressed={!!offline()?.pinned}
              disabled={
                !desktop || offlineBusy() || offline.loading || !!offline()?.error || !offline()
              }
              title={!desktop ? '离线保留需在桌面应用中设置' : offline()?.error || undefined}
            >
              {offline()?.pinned ? '解除离线保留' : '离线保留'}
            </button>
          </div>
          <Show when={offlineError() || offline()?.error}>
            <p class="form-error" role="alert">
              {offlineError() || offline()?.error}
            </p>
          </Show>
        </Show>
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
      <Show when={props.management}>
        <div class="inspector-actions">
          <button class="button" onClick={props.onCrop} disabled={props.busy}>
            <Icon name="expand" size={15} />
            打开查看器
          </button>
        </div>
      </Show>
    </aside>
  );
}
