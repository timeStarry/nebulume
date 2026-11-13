import { Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { execute, schedulePreview } from './api';
import ClippingOverlay from './ClippingOverlay';
import {
  actualPixelZoom,
  fitDimensions,
  needsFullTier,
  panByDelta,
  zoomAroundPoint,
  type CompareTransform,
} from './compare-sync';
import { isQueueAbort } from './concurrency';
import { imageRequestKey, type Asset, type Preview } from './model';
import { decodedThumbnail, rememberDecodedPreview } from './PhotoView';
import { loadImage, previewUrl } from './preview-url';

export default function ComparePane(props: {
  asset: Asset;
  focused: boolean;
  preferRaw: boolean;
  clippingEnabled: boolean;
  transform: CompareTransform;
  onTransform: (next: CompareTransform) => void;
  onRegisterActualZoom: (compute: () => number) => void;
  onSelect: () => void;
}) {
  let paneEl!: HTMLDivElement;
  const [paneSize, setPaneSize] = createSignal({ width: 480, height: 360 });
  const [dragging, setDragging] = createSignal(false);
  const [fullImage, setFullImage] = createSignal<{ key: string; image: HTMLImageElement } | null>(
    null,
  );
  let drag: { x: number; y: number } | undefined;
  let controller: AbortController | undefined;
  let fullController: AbortController | undefined;

  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setPaneSize({ width: rect.width, height: rect.height });
    });
    observer.observe(paneEl);
    onCleanup(() => {
      observer.disconnect();
      controller?.abort();
      fullController?.abort();
    });
  });

  const effectivePreferRaw = () => props.preferRaw && props.asset.kind === 'raw';
  const requestKey = createMemo(() => imageRequestKey(props.asset, false, effectivePreferRaw()));

  const [preview] = createResource(requestKey, async (key) => {
    const { id, revision, preferRaw } = JSON.parse(key) as {
      id: string;
      revision: number;
      preferRaw?: boolean;
    };
    controller?.abort();
    const current = (controller = new AbortController());
    const lane = {
      source: props.asset.source_key ? ('remote' as const) : ('local' as const),
      priority: 'viewer' as const,
      signal: current.signal,
    };
    try {
      const data = await execute<Preview>(
        'asset.preview',
        { id, tier: 'p2560', uncropped: false, ...(preferRaw ? { prefer_raw: true } : {}) },
        lane,
      );
      const url = await previewUrl(
        { id, preview_revision: revision },
        data.tier || 'p2560',
        false,
        !!preferRaw,
      );
      const image = document.createElement('img');
      image.alt = props.asset.filename;
      image.draggable = false;
      await schedulePreview(() => loadImage(url, image), { ...lane, rejectInFlightOnAbort: true });
      if (!preferRaw) rememberDecodedPreview({ id, preview_revision: revision }, url);
      return { key, data, image };
    } catch (err) {
      if (!isQueueAbort(err)) return { key, data: null, image: null };
      return null;
    }
  });

  const sourceDims = createMemo(() => {
    const p = preview()?.data;
    const m = p?.coordinate_mapping;
    if (m) {
      return {
        width: Math.max(p?.width || 1, Math.round(m.full_width * m.crop.width)),
        height: Math.max(p?.height || 1, Math.round(m.full_height * m.crop.height)),
      };
    }
    return {
      width: Math.max(p?.width || 1, props.asset.width || 1),
      height: Math.max(p?.height || 1, props.asset.height || 1),
    };
  });

  const fitted = createMemo(() =>
    fitDimensions(paneSize().width, paneSize().height, sourceDims().width, sourceDims().height, 24),
  );

  createEffect(() => {
    if (props.focused) {
      props.onRegisterActualZoom(() =>
        actualPixelZoom(
          paneSize().width,
          paneSize().height,
          sourceDims().width,
          sourceDims().height,
          24,
        ),
      );
    }
  });

  const displayedSize = createMemo(() => ({
    width: fitted().width * props.transform.zoom,
    height: fitted().height * props.transform.zoom,
  }));

  createEffect(() => {
    const base = preview();
    const key = requestKey();
    const wantFull =
      !!base?.data &&
      needsFullTier(
        displayedSize().width,
        displayedSize().height,
        window.devicePixelRatio || 1,
        sourceDims().width,
        sourceDims().height,
      );
    if (!wantFull) {
      fullController?.abort();
      if (fullImage() && fullImage()!.key !== key) setFullImage(null);
      return;
    }
    if (fullImage()?.key === key) return;
    fullController?.abort();
    const fc = (fullController = new AbortController());
    const preferRaw = effectivePreferRaw();
    const revision = props.asset.preview_revision || 0;
    const lane = {
      source: props.asset.source_key ? ('remote' as const) : ('local' as const),
      priority: 'viewer' as const,
      signal: fc.signal,
    };
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
        const img = document.createElement('img');
        img.alt = props.asset.filename;
        img.draggable = false;
        await schedulePreview(() => loadImage(url, img), { ...lane, rejectInFlightOnAbort: true });
        if (!fc.signal.aborted && requestKey() === key) setFullImage({ key, image: img });
      } catch {
        /* Keep sharp p2560 layer on screen if full tier is aborted or unavailable. */
      }
    })();
  });

  const activeImage = createMemo(() => {
    const key = requestKey();
    if (fullImage()?.key === key) return fullImage()!.image;
    return preview()?.image ?? null;
  });

  return (
    <div
      ref={paneEl}
      class={`compare-pane ${props.focused ? 'focused' : ''} ${dragging() ? 'dragging' : ''} flag-${props.asset.flag || 'none'}`}
      role="option"
      aria-selected={props.focused}
      aria-label={props.asset.filename}
      data-asset-id={props.asset.id}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        props.onSelect();
        drag = { x: event.clientX, y: event.clientY };
        paneEl.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag = { x: event.clientX, y: event.clientY };
        if (dx || dy)
          props.onTransform(panByDelta(props.transform, dx, dy, fitted().width, fitted().height));
      }}
      onPointerUp={() => {
        drag = undefined;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag = undefined;
        setDragging(false);
      }}
      onWheel={(event) => {
        event.preventDefault();
        props.onSelect();
        const rect = paneEl.getBoundingClientRect();
        const ox = event.clientX - (rect.left + rect.width / 2);
        const oy = event.clientY - (rect.top + rect.height / 2);
        const step = event.ctrlKey
          ? Math.exp(-event.deltaY / 100)
          : event.deltaY < 0
            ? 1.15
            : 1 / 1.15;
        props.onTransform(
          zoomAroundPoint(
            props.transform,
            props.transform.zoom * step,
            ox,
            oy,
            fitted().width,
            fitted().height,
          ),
        );
      }}
      onDblClick={(event) => {
        const rect = paneEl.getBoundingClientRect();
        const ox = event.clientX - (rect.left + rect.width / 2);
        const oy = event.clientY - (rect.top + rect.height / 2);
        const target =
          props.transform.zoom > 1.02
            ? 1
            : actualPixelZoom(
                paneSize().width,
                paneSize().height,
                sourceDims().width,
                sourceDims().height,
                24,
              );
        props.onTransform(
          zoomAroundPoint(props.transform, target, ox, oy, fitted().width, fitted().height),
        );
      }}
    >
      <Show
        when={activeImage()}
        fallback={
          <Show
            when={decodedThumbnail(props.asset)}
            fallback={<span class="muted">解析中…</span>}
          >
            {(src) => <img class="photo-placeholder" src={src()} alt="" aria-hidden="true" />}
          </Show>
        }
      >
        {(img) => (
          <div
            class="compare-photo-box"
            style={{
              width: `${displayedSize().width}px`,
              height: `${displayedSize().height}px`,
              transform: `translate(${props.transform.panX * fitted().width}px, ${props.transform.panY * fitted().height}px)`,
            }}
          >
            {img()}
            <ClippingOverlay image={img()} enabled={props.clippingEnabled} />
          </div>
        )}
      </Show>
      <div class="compare-pane-badge">
        <span class="compare-pane-name">{props.asset.filename}</span>
        <Show when={fullImage()?.key === requestKey()}>
          <span class="compare-pane-tier">1:1</span>
        </Show>
        <span class="compare-pane-marks">
          <Show when={props.asset.flag === 'pick'}>
            <span class="compare-pane-flag pick">留用</span>
          </Show>
          <Show when={props.asset.flag === 'reject'}>
            <span class="compare-pane-flag reject">淘汰</span>
          </Show>
          <Show when={props.asset.rating > 0}>
            <span class="compare-pane-stars">{'★'.repeat(props.asset.rating)}</span>
          </Show>
        </span>
      </div>
    </div>
  );
}
