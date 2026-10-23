import {
  createEffect,
  For,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { execute } from './api';
import { isQueueAbort } from './concurrency';
import {
  cropFromPoints,
  errorMessage,
  imageRequestKey,
  type Asset,
  type Crop,
  type Preview,
  type FocusRegion,
} from './model';
import Icon from './Icon';

function flagLabel(flag?: Asset['flag']) {
  return flag === 'pick' ? '，留用' : flag === 'reject' ? '，淘汰' : '';
}

export function Thumbnail(props: {
  asset: Asset;
  selected?: boolean;
  compact?: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  let element!: HTMLButtonElement;
  const [visible, setVisible] = createSignal(false);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  let loadedKey = '';
  let displayedKey = '';
  let disposed = false;
  let pending: { key: string; controller: AbortController } | undefined;
  function syncPreview() {
    if (disposed) return;
    const key = imageRequestKey(props.asset);
    if (displayedKey !== key) {
      displayedKey = key;
      loadedKey = '';
      setPreview(null);
    }
    if (!visible()) {
      pending?.controller.abort();
      return;
    }
    if (loadedKey === key || pending?.key === key) return;
    pending?.controller.abort();
    const current = { key, controller: new AbortController() };
    pending = current;
    setPreviewLoading(true);
    let cancelled = false;
    void execute<Preview>(
      'asset.preview',
      { id: props.asset.id, max_size: 420 },
      {
        source: props.asset.source_key ? 'remote' : 'local',
        priority: 'thumbnail',
        signal: current.controller.signal,
      },
    )
      .then((result) => {
        if (!disposed && imageRequestKey(props.asset) === key) {
          loadedKey = key;
          setPreview(result);
        }
      })
      .catch((error) => {
        cancelled = isQueueAbort(error);
      })
      .finally(() => {
        if (disposed || pending !== current) return;
        pending = undefined;
        setPreviewLoading(false);
        // An item can re-enter the viewport before cancellation has settled.
        if (cancelled && visible()) syncPreview();
      });
  }
  createEffect(syncPreview);
  onCleanup(() => {
    disposed = true;
    pending?.controller.abort();
  });
  onMount(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.target === element) setVisible(entry.isIntersecting);
      },
      { rootMargin: '200px' },
    );
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  return (
    <button
      ref={element}
      class={`thumbnail ${props.selected ? 'selected' : ''} ${props.compact ? 'compact' : ''} flag-${props.asset.flag || 'none'}`}
      onClick={props.onSelect}
      onDblClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          props.onOpen();
        }
      }}
      aria-label={`${props.asset.filename}，${props.asset.rating} 星${flagLabel(props.asset.flag)}`}
      aria-pressed={!!props.selected}
      title={props.asset.filename}
    >
      <div class="thumbnail-image">
        <Show
          when={preview()}
          fallback={
            <div class="thumbnail-fallback">
              <Icon name="photo" size={26} />
              <span>
                {previewLoading() ? '载入中' : props.asset.kind === 'raw' ? 'RAW' : '无预览'}
              </span>
            </div>
          }
        >
          {(p) => <img src={p().data_url} alt="" loading="lazy" />}
        </Show>
        <span class="filetype">{props.asset.extension.toUpperCase()}</span>
        <Show when={props.asset.crop}>
          <span class="crop-badge" title="含裁剪配方">
            <Icon name="crop" size={13} />
          </span>
        </Show>
      </div>
      <Show when={!props.compact}>
        <div class="thumbnail-caption">
          <span>{props.asset.filename}</span>
          <small>
            <Show when={props.asset.flag === 'pick'}>
              <span class="thumbnail-flag pick" aria-hidden="true">
                留用
              </span>
            </Show>
            <Show when={props.asset.flag === 'reject'}>
              <span class="thumbnail-flag reject" aria-hidden="true">
                淘汰
              </span>
            </Show>
            {props.asset.rating ? '★'.repeat(props.asset.rating) : '·'}
          </small>
        </div>
      </Show>
    </button>
  );
}

export default function PhotoView(props: {
  asset: Asset;
  cropMode: boolean;
  crop: Crop;
  setCrop: (crop: Crop) => void;
  onPrevious: () => void;
  onNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  focusEnabled?: boolean;
  focusRegions?: FocusRegion[];
  /** Each change toggles between fit-to-window and preview-pixel 1:1. */
  zoomToggle?: number;
  onPreviewStateChange?: (state: {
    key: string;
    loading: boolean;
    failed: boolean;
    mapping?: Preview['coordinate_mapping'];
    asset?: Asset;
  }) => void;
}) {
  let stage!: HTMLDivElement;
  let wrap!: HTMLDivElement;
  const [size, setSize] = createSignal({ width: 1, height: 1 });
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  const [fetching, setFetching] = createSignal(false);
  const [fetchError, setFetchError] = createSignal('');
  let disposed = false;
  let previewController: AbortController | undefined;
  onCleanup(() => {
    disposed = true;
    previewController?.abort();
  });
  let drag: { x: number; y: number; px: number; py: number; crop: boolean } | undefined;
  const [preview, { refetch }] = createResource(
    () => imageRequestKey(props.asset, props.cropMode),
    async (key) => {
      const { id, uncropped } = JSON.parse(key);
      previewController?.abort();
      previewController = new AbortController();
      try {
        return {
          data: await execute<Preview>(
            'asset.preview',
            { id, max_size: 2400, uncropped },
            {
              source: props.asset.source_key ? 'remote' : 'local',
              priority: 'viewer',
              signal: previewController.signal,
            },
          ),
          error: '',
        };
      } catch (error) {
        return { data: null, error: isQueueAbort(error) ? '' : errorMessage(error) };
      }
    },
  );
  createEffect(() =>
    props.onPreviewStateChange?.({
      key: imageRequestKey(props.asset, props.cropMode),
      loading: preview.loading,
      failed: !!preview()?.error,
      mapping: preview()?.data?.coordinate_mapping,
      asset: preview()?.data?.asset,
    }),
  );
  async function fetchOriginal() {
    const id = props.asset.id;
    setFetching(true);
    setFetchError('');
    try {
      await execute('asset.fetch_original', { id });
      if (!disposed && id === props.asset.id) await refetch();
    } catch (error) {
      if (!disposed && id === props.asset.id) setFetchError(errorMessage(error));
    } finally {
      setFetching(false);
    }
  }
  const fitScale = createMemo(() => {
    const p = preview()?.data;
    if (!p) return 1;
    return Math.max(
      0.01,
      Math.min((size().width - 96) / p.width, (size().height - 72) / p.height, 1),
    );
  });
  const imageSize = createMemo(() => ({
    width: (preview()?.data?.width || 0) * fitScale() * zoom(),
    height: (preview()?.data?.height || 0) * fitScale() * zoom(),
  }));
  function fit() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }
  createEffect(() => {
    props.asset.id;
    fit();
  });
  createEffect(() => {
    if (props.cropMode) fit();
  });
  createEffect(
    on(
      () => props.zoomToggle,
      () => {
        if (props.cropMode) return;
        if (Math.abs(zoom() - 1) < 0.001) {
          setZoom(1 / fitScale());
          setPan({ x: 0, y: 0 });
        } else fit();
      },
      { defer: true },
    ),
  );
  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(stage);
    onCleanup(() => observer.disconnect());
  });
  const point = (event: PointerEvent) => {
    const rect = wrap.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 || !preview()?.data) return;
    if ((event.target as HTMLElement).closest('button')) return;
    if (props.cropMode) {
      const p = point(event);
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
      drag = { x: p.x, y: p.y, px: 0, py: 0, crop: true };
    } else drag = { x: event.clientX, y: event.clientY, px: pan().x, py: pan().y, crop: false };
    stage.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  }
  function pointerMove(event: PointerEvent) {
    if (!drag) return;
    if (drag.crop) props.setCrop(cropFromPoints(drag, point(event)));
    else setPan({ x: drag.px + event.clientX - drag.x, y: drag.py + event.clientY - drag.y });
  }
  function pointerUp() {
    drag = undefined;
    setDragging(false);
  }
  return (
    <div class="viewer">
      <div
        class={`photo-stage ${props.cropMode ? 'cropping' : ''} ${dragging() ? 'dragging' : ''}`}
        ref={stage}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onWheel={(event) => {
          if (props.cropMode) return;
          event.preventDefault();
          setZoom((z) => Math.min(8, Math.max(0.2, z * (event.deltaY < 0 ? 1.12 : 1 / 1.12))));
        }}
      >
        <Show
          when={!preview.loading}
          fallback={
            <div class="viewer-message" role="status" aria-live="polite">
              <span class="spinner" />
              正在解析影像…
            </div>
          }
        >
          <Show
            when={preview()?.data}
            fallback={
              <div class="viewer-message error" role="status">
                <Icon name="photo" size={36} />
                <strong>暂时无法预览</strong>
                <p>{preview()?.error}</p>
                <Show when={preview()?.error?.includes('E_DOWNLOAD_REQUIRED')}>
                  <button class="button primary" disabled={fetching()} onClick={fetchOriginal}>
                    {fetching() ? '正在下载…' : '下载原图并预览'}
                  </button>
                  <Show when={fetchError()}>
                    <p role="alert">{fetchError()}</p>
                  </Show>
                </Show>
              </div>
            }
          >
            {(data) => (
              <div
                ref={wrap}
                class="photo-wrap"
                style={{
                  width: `${imageSize().width}px`,
                  height: `${imageSize().height}px`,
                  transform: `translate(${pan().x}px, ${pan().y}px)`,
                }}
              >
                <img
                  class="main-photo"
                  src={data().data_url}
                  alt={props.asset.filename}
                  draggable={false}
                />
                <Show when={props.cropMode}>
                  <div
                    class="crop-overlay editable"
                    style={{
                      left: `${props.crop.x * 100}%`,
                      top: `${props.crop.y * 100}%`,
                      width: `${props.crop.width * 100}%`,
                      height: `${props.crop.height * 100}%`,
                    }}
                  >
                    <i />
                    <i />
                    <i />
                    <i />
                    <span class="crop-corner top-left" />
                    <span class="crop-corner top-right" />
                    <span class="crop-corner bottom-left" />
                    <span class="crop-corner bottom-right" />
                  </div>
                </Show>
                <Show
                  when={
                    props.focusEnabled &&
                    !props.cropMode &&
                    !preview.loading &&
                    props.focusRegions?.length
                  }
                >
                  <div
                    class="focus-overlay"
                    role="img"
                    aria-label={`相机记录的 ${props.focusRegions!.length} 处对焦区域`}
                  >
                    <For each={props.focusRegions}>
                      {(region) => (
                        <div
                          class={`focus-region ${region.kind}`}
                          style={{
                            left: `${region.x * 100}%`,
                            top: `${region.y * 100}%`,
                            width: `${region.width * 100}%`,
                            height: `${region.height * 100}%`,
                          }}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </Show>
        <Show when={!props.cropMode}>
          <button
            class="viewer-nav previous icon-button"
            disabled={!props.hasPrevious}
            onClick={props.onPrevious}
            aria-label="上一张（←）"
          >
            <Icon name="left" size={22} />
          </button>
          <button
            class="viewer-nav next icon-button"
            disabled={!props.hasNext}
            onClick={props.onNext}
            aria-label="下一张（→）"
          >
            <Icon name="right" size={22} />
          </button>
        </Show>
      </div>
      <div class="viewer-controls">
        <div class="zoom-controls">
          <button onClick={fit} title="适合窗口 · 滚轮缩放，拖动平移">
            适合窗口
          </button>
          <button
            title="预览像素 1:1（大图预览最长边 2400 px）"
            onClick={() => {
              setZoom(1 / fitScale());
              setPan({ x: 0, y: 0 });
            }}
            disabled={props.cropMode}
          >
            1:1
          </button>
          <span class="divider" />
          <button
            class="icon-button"
            onClick={() => setZoom((z) => Math.max(0.2, z / 1.25))}
            disabled={props.cropMode}
            aria-label="缩小"
          >
            <Icon name="minus" size={15} />
          </button>
          <span>{Math.round(fitScale() * zoom() * 100)}%</span>
          <button
            class="icon-button"
            onClick={() => setZoom((z) => Math.min(8, z * 1.25))}
            disabled={props.cropMode}
            aria-label="放大"
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
