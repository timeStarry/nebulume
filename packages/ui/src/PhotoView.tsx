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
import { execute, schedulePreview } from './api';
import { isQueueAbort, untilAborted } from './concurrency';
import { loadImage, previewUrl, type PreviewTier } from './preview-url';
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

const visibilityTargets = new Map<Element, (visible: boolean) => void>();
let visibilityObserver: IntersectionObserver | undefined;
/**
 * One observer for every grid cell: all entries of a scroll arrive in a single callback, so
 * every cell that left the viewport cancels its queued or in-flight load before a freed lane
 * slot can be handed to another stale cell.
 */
function observeVisibility(element: Element, onChange: (visible: boolean) => void) {
  visibilityObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) visibilityTargets.get(entry.target)?.(entry.isIntersecting);
    },
    { rootMargin: '200px' },
  );
  const observer = visibilityObserver;
  visibilityTargets.set(element, onChange);
  observer.observe(element);
  return () => {
    visibilityTargets.delete(element);
    observer.unobserve(element);
  };
}

function flagLabel(flag?: Asset['flag']) {
  return flag === 'pick' ? '，留用' : flag === 'reject' ? '，淘汰' : '';
}

export function Thumbnail(props: {
  asset: Asset;
  tier: PreviewTier;
  selected?: boolean;
  /** The photo that keyboard actions and the detail panel follow. */
  focused?: boolean;
  compact?: boolean;
  onSelect: (event: MouseEvent) => void;
  onOpen: () => void;
}) {
  let element!: HTMLButtonElement;
  const [visible, setVisible] = createSignal(false);
  /**
   * Each layer's <img> is its own loader: it joins the DOM hidden (still fetching and decoding)
   * when the scheduler grants a slot and is revealed in place, so every image is requested once.
   */
  type Layer = { key: string; image: HTMLImageElement; request?: Promise<HTMLImageElement> };
  const [layers, setLayers] = createSignal<Layer[]>([]);
  const [shown, setShown] = createSignal(false);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  // Requests that were detached by an abort but have not settled yet, so re-entering the
  // viewport adopts them instead of issuing the same URL again.
  const inflight = new Map<string, Layer>();
  let loadedKey = '';
  let displayedKey = '';
  let disposed = false;
  let pending: { key: string; controller: AbortController } | undefined;
  const dropLayer = (layer: Layer) => setLayers((list) => list.filter((item) => item !== layer));
  function startLayer(key: string, url: string): Promise<HTMLImageElement> {
    const image = document.createElement('img');
    image.alt = '';
    image.style.visibility = 'hidden';
    const layer: Layer = { key, image };
    setLayers((list) => [...list, layer]);
    const request = loadImage(url, image);
    layer.request = request;
    inflight.set(key, layer);
    const settled = () => {
      if (inflight.get(key) === layer) inflight.delete(key);
      if (loadedKey !== key && pending?.key !== key) dropLayer(layer);
    };
    request.then(settled, settled);
    return request;
  }
  function syncPreview() {
    if (disposed) return;
    const assetKey = imageRequestKey(props.asset);
    // A tier change keeps the current image on screen until the sharper one has decoded.
    const key = `${assetKey}:${props.tier}`;
    if (displayedKey !== assetKey) {
      displayedKey = assetKey;
      loadedKey = '';
      inflight.clear();
      setLayers([]);
      setShown(false);
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
    const asset = props.asset;
    const tier = props.tier;
    const adopted = inflight.get(key);
    const request = adopted?.request
      ? untilAborted(adopted.request, current.controller.signal)
      : schedulePreview(async () => startLayer(key, await previewUrl(asset, tier)), {
          source: props.asset.source_key ? 'remote' : 'local',
          priority: 'thumbnail',
          signal: current.controller.signal,
          rejectInFlightOnAbort: true,
        });
    if (adopted && !layers().includes(adopted)) setLayers((list) => [...list, adopted]);
    void request
      .then((image) => {
        if (disposed || `${imageRequestKey(props.asset)}:${props.tier}` !== key) return;
        const layer = layers().find((item) => item.image === image);
        if (!layer) return;
        loadedKey = key;
        image.style.visibility = '';
        setLayers([layer]);
        setShown(true);
      })
      .catch((error) => {
        cancelled = isQueueAbort(error);
      })
      .finally(() => {
        if (disposed || pending !== current) return;
        pending = undefined;
        setPreviewLoading(false);
        // Drop a failed or detached-and-settled layer that will not be shown.
        if (loadedKey !== key)
          for (const layer of layers())
            if (layer.key === key && inflight.get(key) !== layer) dropLayer(layer);
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
    onCleanup(observeVisibility(element, setVisible));
  });
  return (
    <button
      ref={element}
      class={`thumbnail ${props.selected ? 'selected' : ''} ${props.focused ? 'focused' : ''} ${props.compact ? 'compact' : ''} flag-${props.asset.flag || 'none'}`}
      onClick={(event) => props.onSelect(event)}
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
        <Show when={!shown()}>
          <div class="thumbnail-fallback">
            <Icon name="photo" size={26} />
            <span>
              {previewLoading() ? '载入中' : props.asset.kind === 'raw' ? 'RAW' : '无预览'}
            </span>
          </div>
        </Show>
        <For each={layers()}>{(layer) => layer.image}</For>
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
      const { id, uncropped, revision } = JSON.parse(key) as {
        id: string;
        uncropped: boolean;
        revision: number;
      };
      previewController?.abort();
      const controller = (previewController = new AbortController());
      const lane = {
        source: props.asset.source_key ? ('remote' as const) : ('local' as const),
        priority: 'viewer' as const,
        signal: controller.signal,
      };
      try {
        // IPC carries metadata and errors (E_DOWNLOAD_REQUIRED); pixels come from the protocol.
        const data = await execute<Preview>(
          'asset.preview',
          { id, tier: 'p2560', uncropped },
          lane,
        );
        const url = await previewUrl(
          { id, preview_revision: revision },
          data.tier || 'p2560',
          uncropped,
        );
        // The element that decodes is the element shown: one request, one decode.
        const image = document.createElement('img');
        image.className = 'main-photo';
        image.alt = props.asset.filename;
        image.draggable = false;
        await schedulePreview(() => loadImage(url, image), {
          ...lane,
          rejectInFlightOnAbort: true,
        });
        return { data, image, error: '' };
      } catch (error) {
        return { data: null, image: null, error: isQueueAbort(error) ? '' : errorMessage(error) };
      }
    },
  );
  createEffect(() => {
    const image = preview()?.image;
    if (image) image.alt = props.asset.filename;
  });
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
                {preview()?.image}
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
            title="预览像素 1:1（大图预览最长边 2560 px）"
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
