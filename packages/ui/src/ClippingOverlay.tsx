import { Show, createEffect, onCleanup } from 'solid-js';
import { computeClippingMask, type ClippingStats } from './clipping';

const MAX_SAMPLE_SIDE = 960;

async function samplePixels(
  image: HTMLImageElement,
  width: number,
  height: number,
): Promise<Uint8ClampedArray | null> {
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(image, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  } catch {
    // Cross-origin custom protocol (`neb://` / `http://neb.localhost`) without `crossOrigin` on
    // the display `<img>`: decode an anonymous CORS copy once when clipping overlay is enabled.
    const src = image.currentSrc || image.src;
    if (!src) return null;
    const cors = new Image();
    cors.crossOrigin = 'anonymous';
    cors.decoding = 'async';
    cors.src = src;
    try {
      await cors.decode();
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(cors, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height).data;
    } catch {
      return null;
    }
  }
}

export default function ClippingOverlay(props: {
  image: HTMLImageElement | null | undefined;
  enabled: boolean;
  onStats?: (stats: ClippingStats | null) => void;
}) {
  let canvas: HTMLCanvasElement | undefined;
  let runId = 0;

  createEffect(() => {
    const img = props.image;
    const active = props.enabled;
    const token = ++runId;
    if (!active || !img || !img.naturalWidth || !img.naturalHeight) {
      props.onStats?.(null);
      return;
    }
    const ratio = Math.min(1, MAX_SAMPLE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * ratio));
    const height = Math.max(1, Math.round(img.naturalHeight * ratio));

    void samplePixels(img, width, height).then((rgba) => {
      if (token !== runId || !rgba || !canvas) return;
      canvas.width = width;
      canvas.height = height;
      const targetCtx = canvas.getContext('2d');
      if (!targetCtx) return;
      const out = targetCtx.createImageData(width, height);
      const stats = computeClippingMask(rgba, out.data);
      targetCtx.putImageData(out, 0, 0);
      props.onStats?.(stats);
    });
  });

  onCleanup(() => {
    runId++;
  });

  return (
    <Show when={props.enabled && props.image}>
      <canvas
        ref={canvas}
        class="clipping-overlay"
        role="img"
        aria-label="高光与暗部溢出警告叠加层"
      />
    </Show>
  );
}
