import {
  batch,
  createEffect,
  For,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { execute, schedulePreview } from './api';
import { isQueueAbort, untilAborted } from './concurrency';
import { loadImage, previewUrl, type PreviewTier } from './preview-url';
import ClippingOverlay from './ClippingOverlay';
import { needsFullTier } from './compare-sync';
import { cropFromPointsWithAspect } from './crop-aspect';
import {
  errorMessage,
  imageRequestKey,
  type Asset,
  type Crop,
  type Preview,
  type FocusRegion,
} from './model';
import Icon from './Icon';
import {
  acquireViewerImage,
  getViewerFrame,
  rememberViewerFrame,
  viewerFrameKey,
} from './viewer-frame-cache';

interface DecodedPreviewEntry {
  url: string;
  width?: number;
  height?: number;
}

/**
 * URLs and intrinsic aspect ratios of previews this window has already decoded (grid thumbnails,
 * prefetched viewer tiers), by asset and revision.
 */
const decodedThumbnails = new Map<string, DecodedPreviewEntry>();
const thumbnailKey = (asset: Pick<Asset, 'id' | 'preview_revision'>) =>
  `${asset.id}:${asset.preview_revision || 0}`;
export function rememberDecodedPreview(
  asset: Pick<Asset, 'id' | 'preview_revision'>,
  url: string,
  width?: number,
  height?: number,
) {
  const key = thumbnailKey(asset);
  const previous = decodedThumbnails.get(key);
  decodedThumbnails.delete(key);
  decodedThumbnails.set(key, {
    url,
    width: width && width > 0 ? width : previous?.width,
    height: height && height > 0 ? height : previous?.height,
  });
  if (decodedThumbnails.size > 1000)
    decodedThumbnails.delete(decodedThumbnails.keys().next().value!);
}
export function decodedThumbnail(
  asset: Pick<Asset, 'id' | 'preview_revision'>,
): string | undefined {
  return decodedThumbnails.get(thumbnailKey(asset))?.url;
}
export function decodedThumbnailDims(
  asset: Pick<Asset, 'id' | 'preview_revision'>,
): { width: number; height: number } | undefined {
  const entry = decodedThumbnails.get(thumbnailKey(asset));
  return entry?.width && entry?.height ? { width: entry.width, height: entry.height } : undefined;
}
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
function colorLabelText(color?: Asset['color_label']) {
  if (!color || color === 'none') return '';
  const map: Record<string, string> = {
    red: '，红色标',
    yellow: '，黄色标',
    green: '，绿色标',
    blue: '，蓝色标',
  };
  return map[color] || '';
}

export function Thumbnail(props: {
  asset: Asset;
  tier: PreviewTier;
  selected?: boolean;
  /** The photo that keyboard actions and the detail panel follow. */
  focused?: boolean;
  /** Grid roving focus: only one thumbnail is in the Tab order. Omitted means tabbable. */
  tabbable?: boolean;
  compact?: boolean;
  /** Fills a justified-grid tile; name and stars show on hover instead of below. */
  tile?: boolean;
  onSelect: (event: MouseEvent) => void;
  onOpen: () => void;
  /** Right-click, Shift+F10 or the Menu key; receives the anchor point. */
  onMenu?: (point: { x: number; y: number }) => void;
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
  function startLayer(
    key: string,
    url: string,
    asset: Pick<Asset, 'id' | 'preview_revision'>,
  ): Promise<HTMLImageElement> {
    const image = document.createElement('img');
    image.alt = '';
    image.style.visibility = 'hidden';
    const layer: Layer = { key, image };
    setLayers((list) => [...list, layer]);
    const request = loadImage(url, image);
    request.then(
      (decoded) => rememberDecodedPreview(asset, url, decoded.naturalWidth, decoded.naturalHeight),
      () => undefined,
    );
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
      : schedulePreview(async () => startLayer(key, await previewUrl(asset, tier), asset), {
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
        // First reveal of this photo fades in; a sharper tier replacing it does not.
        if (!shown()) image.classList.add('nl-reveal');
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
      class={`thumbnail ${props.selected ? 'selected' : ''} ${props.focused ? 'focused' : ''} ${props.compact ? 'compact' : ''} ${props.tile ? 'tile' : ''} flag-${props.asset.flag || 'none'}`}
      data-asset-id={props.asset.id}
      tabIndex={props.tabbable === false ? -1 : 0}
      onClick={(event) => props.onSelect(event)}
      onDblClick={props.onOpen}
      onContextMenu={(event) => {
        if (!props.onMenu) return;
        event.preventDefault();
        props.onMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (
          props.onMenu &&
          (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
        ) {
          event.preventDefault();
          event.stopPropagation();
          const rect = element.getBoundingClientRect();
          props.onMenu({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          return;
        }
        if (
          event.key === 'Enter' ||
          (event.key === ' ' &&
            !event.repeat &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey)
        ) {
          event.preventDefault();
          event.stopPropagation();
          props.onOpen();
        }
      }}
      aria-label={`${props.asset.filename}，${props.asset.rating} 星${flagLabel(props.asset.flag)}${colorLabelText(props.asset.color_label)}`}
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
        <Show when={!props.tile}>
          <span class="filetype">{props.asset.extension.toUpperCase()}</span>
        </Show>
        <Show when={props.asset.color_label && props.asset.color_label !== 'none'}>
          <span class="tile-color-dot" data-color={props.asset.color_label} aria-hidden="true" />
        </Show>
        <Show when={props.tile}>
          <Show when={props.asset.flag === 'pick' || props.asset.flag === 'reject'}>
            <span class={`tile-flag ${props.asset.flag}`} aria-hidden="true">
              <Icon name={props.asset.flag === 'pick' ? 'check' : 'close'} size={13} />
            </span>
          </Show>
          <span class="tile-meta" aria-hidden="true">
            <span>{props.asset.filename}</span>
            <span class="tile-stars">{'★'.repeat(props.asset.rating)}</span>
          </span>
        </Show>
        <Show when={props.asset.crop}>
          <span class="crop-badge" title="含裁剪配方">
            <Icon name="crop" size={13} />
          </span>
        </Show>
      </div>
      <Show when={!props.compact && !props.tile}>
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
  /** Each change toggles between fit-to-window and native 1:1. */
  zoomToggle?: number;
  /** Fill the window edge to edge (standalone viewer); chrome floats over the photo. */
  fill?: boolean;
  preferRaw?: boolean;
  onTogglePreferRaw?: () => void;
  clippingEnabled?: boolean;
  onToggleClipping?: () => void;
  cropAspect?: number | null;
  onPreviewStateChange?: (state: {
    key: string;
    loading: boolean;
    failed: boolean;
    mapping?: Preview['coordinate_mapping'];
    asset?: Asset;
    source?: string;
  }) => void;
}) {
  interface DisplayedFrame {
    requestKey: string;
    asset: Asset;
    cropMode: boolean;
    data: Preview;
    image: HTMLImageElement;
  }

  let stage!: HTMLDivElement;
  let wrap!: HTMLDivElement;
  const [size, setSize] = createSignal({ width: 1, height: 1 });
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  const [fetching, setFetching] = createSignal(false);
  const [fetchError, setFetchError] = createSignal('');
  const [displayed, setDisplayed] = createSignal<DisplayedFrame | null>(null);
  const [pendingLoading, setPendingLoading] = createSignal(true);
  const [pastHold, setPastHold] = createSignal(true);
  const [pastSpinnerDelay, setPastSpinnerDelay] = createSignal(false);
  const [previewError, setPreviewError] = createSignal('');
  const [reloadTick, setReloadTick] = createSignal(0);
  const [fullLayer, setFullLayer] = createSignal<{ key: string; image: HTMLImageElement } | null>(
    null,
  );
  const [fullLoading, setFullLoading] = createSignal(false);
  let disposed = false;
  let previewController: AbortController | undefined;
  let fullController: AbortController | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let spinnerTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    clearTimeout(holdTimer);
    clearTimeout(spinnerTimer);
    holdTimer = undefined;
    spinnerTimer = undefined;
  };
  onCleanup(() => {
    disposed = true;
    clearTimers();
    previewController?.abort();
    fullController?.abort();
  });
  let drag: { x: number; y: number; px: number; py: number; crop: boolean } | undefined;
  const effectivePreferRaw = () => !props.cropMode && !!props.preferRaw && props.asset.kind === 'raw';
  const requestKey = createMemo(() =>
    imageRequestKey(props.asset, props.cropMode, effectivePreferRaw()),
  );
  // While p2560 decodes on a cold photo, an already decoded thumbnail can sit inside the exact
  // same locked-aspect-ratio `.photo-wrap` box instead of stretching edge-to-edge.
  const placeholder = () => (props.cropMode ? undefined : decodedThumbnail(props.asset));

  const frameCacheKey = createMemo(() => viewerFrameKey(requestKey(), props.asset));

  createEffect(
    on([requestKey, frameCacheKey, reloadTick], ([key, fKey]) => {
      const assetSnap = props.asset;

      clearTimers();
      previewController?.abort();
      fullController?.abort();
      setFullLoading(false);

      const warm = getViewerFrame(fKey, assetSnap.filename);
      if (warm) {
        batch(() => {
          setDisplayed({
            requestKey: key,
            asset: assetSnap,
            cropMode: props.cropMode,
            data: warm.data,
            image: warm.image,
          });
          setPendingLoading(false);
          setPastHold(false);
          setPastSpinnerDelay(false);
          setPreviewError('');
        });
        props.onPreviewStateChange?.({
          key,
          loading: false,
          failed: false,
          mapping: warm.data.coordinate_mapping,
          asset: warm.data.asset,
          source: warm.data.source,
        });
        return;
      }

      const hasPreviousFrame = displayed() !== null;
      batch(() => {
        setPreviewError('');
        setPendingLoading(true);
        setPastHold(!hasPreviousFrame);
        setPastSpinnerDelay(!hasPreviousFrame && !placeholder());
      });
      props.onPreviewStateChange?.({ key, loading: true, failed: false });

      if (hasPreviousFrame) {
        holdTimer = setTimeout(() => setPastHold(true), 60);
      }
      spinnerTimer = setTimeout(() => setPastSpinnerDelay(true), 240);

      const { id, uncropped, revision, preferRaw } = JSON.parse(key) as {
        id: string;
        uncropped: boolean;
        revision: number;
        preferRaw?: boolean;
      };
      const controller = (previewController = new AbortController());
      const lane = {
        source: assetSnap.source_key ? ('remote' as const) : ('local' as const),
        priority: 'viewer' as const,
        signal: controller.signal,
      };

      void (async () => {
        try {
          // IPC carries metadata and errors (E_DOWNLOAD_REQUIRED); pixels come from the protocol.
          const data = await execute<Preview>(
            'asset.preview',
            { id, tier: 'p2560', uncropped, ...(preferRaw ? { prefer_raw: true } : {}) },
            lane,
          );
          const url = await previewUrl(
            { id, preview_revision: revision },
            data.tier || 'p2560',
            uncropped,
            !!preferRaw,
          );
          const image = await acquireViewerImage(url, assetSnap.filename, lane);
          if (disposed || controller.signal.aborted || requestKey() !== key) return;
          clearTimers();
          if (!uncropped && !preferRaw) {
            rememberDecodedPreview(
              { id, preview_revision: revision },
              url,
              image.naturalWidth,
              image.naturalHeight,
            );
          }
          rememberViewerFrame(viewerFrameKey(key, props.asset), data, image);
          batch(() => {
            setDisplayed({
              requestKey: key,
              asset: props.asset,
              cropMode: uncropped,
              data,
              image,
            });
            setPendingLoading(false);
            setPastHold(false);
            setPastSpinnerDelay(false);
            setPreviewError('');
          });
          props.onPreviewStateChange?.({
            key,
            loading: false,
            failed: false,
            mapping: data.coordinate_mapping,
            asset: data.asset,
            source: data.source,
          });
        } catch (error) {
          if (disposed || controller.signal.aborted || isQueueAbort(error) || requestKey() !== key)
            return;
          clearTimers();
          const message = errorMessage(error);
          batch(() => {
            setPreviewError(message);
            setPendingLoading(false);
            setPastHold(true);
            setPastSpinnerDelay(false);
          });
          props.onPreviewStateChange?.({
            key,
            loading: false,
            failed: true,
          });
        }
      })();
    }),
  );

  createEffect(() => {
    const frame = displayed();
    if (frame?.asset.id === props.asset.id) frame.image.alt = props.asset.filename;
    const hi = fullLayer()?.image;
    if (hi) hi.alt = props.asset.filename;
  });

  async function fetchOriginal() {
    const id = props.asset.id;
    setFetching(true);
    setFetchError('');
    try {
      await execute('asset.fetch_original', { id });
      if (!disposed && id === props.asset.id) setReloadTick((n) => n + 1);
    } catch (error) {
      if (!disposed && id === props.asset.id) setFetchError(errorMessage(error));
    } finally {
      setFetching(false);
    }
  }

  function dimsFromPreview(p: Preview, asset: Asset, cropMode: boolean) {
    const m = p.coordinate_mapping;
    if (m) {
      const cw = cropMode ? 1 : m.crop.width;
      const ch = cropMode ? 1 : m.crop.height;
      return {
        width: Math.max(p.width, Math.round(m.full_width * cw)),
        height: Math.max(p.height, Math.round(m.full_height * ch)),
      };
    }
    if (!cropMode && asset.crop) return { width: p.width, height: p.height };
    return {
      width: Math.max(p.width, asset.width || p.width),
      height: Math.max(p.height, asset.height || p.height),
    };
  }

  function estimatedDimsFromAsset(asset: Asset, cropMode: boolean) {
    if (asset.width && asset.height) {
      const cw = !cropMode && asset.crop ? asset.crop.width : 1;
      const ch = !cropMode && asset.crop ? asset.crop.height : 1;
      return {
        width: Math.max(1, Math.round(asset.width * cw)),
        height: Math.max(1, Math.round(asset.height * ch)),
      };
    }
    const thumbDims = decodedThumbnailDims(asset);
    if (thumbDims) {
      const scale = Math.max(1, 2560 / Math.max(thumbDims.width, thumbDims.height));
      return {
        width: Math.max(1, Math.round(thumbDims.width * scale)),
        height: Math.max(1, Math.round(thumbDims.height * scale)),
      };
    }
    return { width: 2560, height: 1707 };
  }

  const showingCurrentFrame = createMemo(
    () => displayed()?.requestKey === requestKey() && !previewError(),
  );
  const useTargetPlaceholder = createMemo(
    () => !showingCurrentFrame() && !previewError() && pastHold() && !!placeholder(),
  );
  const holdingDisplayedFrame = createMemo(
    () => !showingCurrentFrame() && !previewError() && !useTargetPlaceholder() && !!displayed(),
  );

  const sourceDims = createMemo(() => {
    const frame = displayed();
    if (showingCurrentFrame() && frame) {
      return dimsFromPreview(frame.data, props.asset, props.cropMode);
    }
    if (holdingDisplayedFrame() && frame) {
      return dimsFromPreview(frame.data, frame.asset, frame.cropMode);
    }
    return estimatedDimsFromAsset(props.asset, props.cropMode);
  });

  const fitScale = createMemo(() => {
    const src = sourceDims();
    const padX = props.fill ? 0 : 48;
    const padY = props.fill ? 0 : 32;
    return Math.max(
      0.01,
      Math.min(
        Math.max(1, size().width - padX) / src.width,
        Math.max(1, size().height - padY) / src.height,
        1,
      ),
    );
  });
  const imageSize = createMemo(() => ({
    width: sourceDims().width * fitScale() * zoom(),
    height: sourceDims().height * fitScale() * zoom(),
  }));
  // Seamless background upgrade to `full` native pixel tier when zoomed past p2560.
  createEffect(() => {
    const key = requestKey();
    const src = sourceDims();
    const wantFull =
      !props.cropMode &&
      showingCurrentFrame() &&
      !pendingLoading() &&
      needsFullTier(
        imageSize().width,
        imageSize().height,
        window.devicePixelRatio || 1,
        src.width,
        src.height,
      );
    if (!wantFull) {
      fullController?.abort();
      setFullLoading(false);
      if (fullLayer() && fullLayer()!.key !== key) setFullLayer(null);
      return;
    }
    if (fullLayer()?.key === key) return;
    fullController?.abort();
    const controller = (fullController = new AbortController());
    const preferRaw = effectivePreferRaw();
    const revision = props.asset.preview_revision || 0;
    const lane = {
      source: props.asset.source_key ? ('remote' as const) : ('local' as const),
      priority: 'viewer' as const,
      signal: controller.signal,
    };
    setFullLoading(true);
    void (async () => {
      try {
        await execute<Preview>(
          'asset.preview',
          {
            id: props.asset.id,
            tier: 'full',
            uncropped: false,
            ...(preferRaw ? { prefer_raw: true } : {}),
          },
          lane,
        );
        const url = await previewUrl(
          { id: props.asset.id, preview_revision: revision },
          'full',
          false,
          preferRaw,
        );
        const image = document.createElement('img');
        image.className = 'main-photo';
        image.alt = props.asset.filename;
        image.draggable = false;
        await schedulePreview(() => loadImage(url, image), {
          ...lane,
          rejectInFlightOnAbort: true,
        });
        if (!disposed && !controller.signal.aborted && requestKey() === key) {
          setFullLayer({ key, image });
        }
      } catch {
        /* Keep sharp p2560 preview on screen if full tier is cancelled or unsupported. */
      } finally {
        if (fullController === controller) setFullLoading(false);
      }
    })();
  });
  const activeImage = createMemo(() => {
    const key = requestKey();
    if (showingCurrentFrame()) {
      if (!props.cropMode && fullLayer()?.key === key) return fullLayer()!.image;
      return displayed()?.image ?? null;
    }
    if (holdingDisplayedFrame()) return displayed()?.image ?? null;
    return null;
  });
  function fit() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }
  /** Zooms so the image point under the cursor stays under it. */
  function zoomAt(next: number, clientX?: number, clientY?: number) {
    const target = Math.min(8 / fitScale(), Math.max(0.2, next));
    const factor = target / zoom();
    const rect = stage.getBoundingClientRect();
    const cx = clientX === undefined ? 0 : clientX - (rect.left + rect.width / 2);
    const cy = clientY === undefined ? 0 : clientY - (rect.top + rect.height / 2);
    const current = pan();
    setZoom(target);
    if (Math.abs(target - 1) < 0.001) return setPan({ x: 0, y: 0 });
    setPan({ x: cx - (cx - current.x) * factor, y: cy - (cy - current.y) * factor });
  }
  /** Fit ⇄ 100 %, centred on the cursor when there is one. */
  function toggleActual(clientX?: number, clientY?: number) {
    if (props.cropMode) return;
    if (Math.abs(zoom() - 1) < 0.001) zoomAt(1 / fitScale(), clientX, clientY);
    else fit();
  }
  const activeVisualAssetId = createMemo(() =>
    holdingDisplayedFrame() ? displayed()?.asset.id : props.asset.id,
  );
  createEffect(() => {
    activeVisualAssetId();
    fit();
  });
  createEffect(() => {
    if (props.cropMode) fit();
  });
  createEffect(
    on(
      () => props.zoomToggle,
      () => toggleActual(),
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
    if (event.button !== 0 || !showingCurrentFrame()) return;
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
    if (drag.crop)
      props.setCrop(
        cropFromPointsWithAspect(
          drag,
          point(event),
          props.cropAspect ?? null,
          sourceDims().width,
          sourceDims().height,
        ),
      );
    else setPan({ x: drag.px + event.clientX - drag.x, y: drag.py + event.clientY - drag.y });
  }
  function pointerUp() {
    drag = undefined;
    setDragging(false);
  }
  const hasStageFrame = () =>
    !previewError() && (showingCurrentFrame() || holdingDisplayedFrame() || useTargetPlaceholder());

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
          // Trackpad pinches arrive as small ctrl-wheel deltas; mouse wheels as large steps.
          const step = event.ctrlKey
            ? Math.exp(-event.deltaY / 100)
            : event.deltaY < 0
              ? 1.12
              : 1 / 1.12;
          zoomAt(zoom() * step, event.clientX, event.clientY);
        }}
        onDblClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          toggleActual(event.clientX, event.clientY);
        }}
      >
        <Show when={previewError() && !pendingLoading()}>
          <div class="viewer-message error" role="status">
            <Icon name="photo" size={36} />
            <strong>暂时无法预览</strong>
            <p>{previewError()}</p>
            <Show when={previewError().includes('E_DOWNLOAD_REQUIRED')}>
              <button class="button primary" disabled={fetching()} onClick={fetchOriginal}>
                {fetching() ? '正在下载…' : '下载原图并预览'}
              </button>
              <Show when={fetchError()}>
                <p role="alert">{fetchError()}</p>
              </Show>
            </Show>
          </div>
        </Show>
        <Show when={hasStageFrame()}>
          <div
            ref={wrap}
            class="photo-wrap"
            classList={{ 'holding-previous': holdingDisplayedFrame() && pastSpinnerDelay() }}
            style={{
              width: `${imageSize().width}px`,
              height: `${imageSize().height}px`,
              transform: `translate(${pan().x}px, ${pan().y}px)`,
            }}
          >
            <Show
              when={!useTargetPlaceholder()}
              fallback={
                <img class="photo-placeholder" src={placeholder()!} alt="" aria-hidden="true" />
              }
            >
              {activeImage()}
            </Show>
            <ClippingOverlay
              image={showingCurrentFrame() ? activeImage() : null}
              enabled={!!props.clippingEnabled && !props.cropMode && showingCurrentFrame()}
            />
            <Show when={props.cropMode && showingCurrentFrame()}>
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
                showingCurrentFrame() &&
                !pendingLoading() &&
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
          <Show when={pendingLoading() && pastSpinnerDelay()}>
            <div class="viewer-message over-placeholder" role="status" aria-live="polite">
              <span class="spinner" />
              正在解析影像…
            </div>
          </Show>
        </Show>
        <Show when={!previewError() && !hasStageFrame()}>
          <div class="viewer-message" role="status" aria-live="polite">
            <span class="spinner" />
            正在解析影像…
          </div>
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
            class={Math.abs(fitScale() * zoom() - 1) < 0.02 && zoom() > 1.02 ? 'active' : ''}
            title="原生像素 1:1 查焦（Z）· 自动升级高清原生预览"
            onClick={() => toggleActual()}
            disabled={props.cropMode}
          >
            {fullLoading() ? '1:1…' : fullLayer()?.key === requestKey() ? '1:1 原生' : '1:1'}
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
            onClick={() => setZoom((z) => Math.min(8 / fitScale(), z * 1.25))}
            disabled={props.cropMode}
            aria-label="放大"
          >
            <Icon name="plus" size={15} />
          </button>
          <Show when={props.onToggleClipping && !props.cropMode}>
            <span class="divider" />
            <button
              class={props.clippingEnabled ? 'active' : ''}
              aria-pressed={!!props.clippingEnabled}
              aria-keyshortcuts="J"
              onClick={props.onToggleClipping}
              title="高光/暗部溢出警告（J）· 红色高光过曝，蓝色暗部死黑"
            >
              溢出警告
            </button>
          </Show>
          <Show when={props.asset.kind === 'raw' && props.onTogglePreferRaw && !props.cropMode}>
            <button
              class={props.preferRaw ? 'active' : ''}
              aria-pressed={!!props.preferRaw}
              aria-keyshortcuts="R"
              onClick={props.onTogglePreferRaw}
              title="切换相机内嵌预览与 RAW 传感器显影（R）"
            >
              {props.preferRaw ? 'RAW 显影' : '相机预览'}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
