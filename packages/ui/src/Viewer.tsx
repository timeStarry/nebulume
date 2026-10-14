import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { chooseSave, desktop, execute, viewerContext } from './api';
import AssetInspector from './AssetInspector';
import PhotoView from './PhotoView';
import Icon from './Icon';
import { errorMessage, fullCrop, isTextEntry, validCrop, type Asset, type Crop } from './model';
import { viewerIds } from './workspace';

export default function Viewer(props: {
  initialAssetId?: string;
  initialAssetIds?: string[];
  onClose?: () => void;
  onAssetChanged?: (asset: Asset) => void;
}) {
  const [ids, setIds] = createSignal<string[]>(props.initialAssetIds || []);
  const [id, setId] = createSignal(props.initialAssetId);
  const [asset, setAsset] = createSignal<Asset>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [busy, setBusy] = createSignal('');
  const [info, setInfo] = createSignal(false);
  const [cropMode, setCropMode] = createSignal(false);
  const [crop, setCrop] = createSignal<Crop>({ ...fullCrop });
  const [controls, setControls] = createSignal(true);
  let container!: HTMLDivElement;
  let timer: ReturnType<typeof setTimeout>;
  let request = 0;
  const revisions = new Map<string, number>();
  const index = createMemo(() => ids().indexOf(id() || ''));
  const showControls = () => controls() || cropMode() || !!busy() || !!error();
  function activity() {
    setControls(true);
    clearTimeout(timer);
    timer = setTimeout(() => setControls(false), 2400);
  }
  async function loadAsset(nextId: string) {
    const token = ++request;
    setLoading(true);
    setError('');
    setNotice('');
    setAsset(undefined);
    setCropMode(false);
    try {
      const next = await execute<Asset>('asset.get', { id: nextId });
      if (token === request) {
        setAsset({ ...next, preview_revision: revisions.get(next.id) });
        setCrop({ ...(next.crop || fullCrop) });
        document.title = `${next.filename} — Nebulume`;
      }
    } catch (e) {
      if (token === request) setError(errorMessage(e));
    } finally {
      if (token === request) setLoading(false);
    }
  }
  createEffect(
    on(id, (next) => {
      if (next) void loadAsset(next);
    }),
  );
  onMount(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousTitle = document.title;
    if (props.onClose) container.focus();
    if (props.initialAssetId) {
      setIds(viewerIds(props.initialAssetId, props.initialAssetIds || []));
    } else if (desktop)
      void viewerContext()
        .then((context) => {
          setIds(viewerIds(context.asset_id, context.asset_ids));
          setId(context.asset_id);
        })
        .catch((e) => {
          setError(errorMessage(e));
          setLoading(false);
        });
    else {
      setLoading(false);
      setError('此查看窗口没有影像上下文，请从图片库打开照片。');
    }
    activity();
    window.addEventListener('keydown', keyboard);
    onCleanup(() => {
      clearTimeout(timer);
      window.removeEventListener('keydown', keyboard);
      request++;
      if (props.onClose) previousFocus?.focus();
      if (props.onClose) document.title = previousTitle;
    });
  });
  function move(direction: number) {
    if (cropMode() || busy() || loading()) return;
    const next = ids()[index() + direction];
    if (next) setId(next);
    activity();
  }
  async function close() {
    try {
      if (props.onClose) props.onClose();
      else if (desktop) await getCurrentWindow().close();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function manager() {
    if (props.onClose) props.onClose();
    else
      try {
        await invoke('show_manager');
      } catch (e) {
        setError(errorMessage(e));
      }
  }
  async function fullscreen() {
    try {
      if (desktop) {
        const win = getCurrentWindow();
        await win.setFullscreen(!(await win.isFullscreen()));
      } else if (document.fullscreenElement) await document.exitFullscreen();
      else await container.requestFullscreen();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function escape() {
    if (cropMode()) {
      setCropMode(false);
      return;
    }
    try {
      if (desktop && (await getCurrentWindow().isFullscreen())) {
        await getCurrentWindow().setFullscreen(false);
        return;
      }
      if (!desktop && document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await close();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function keyboard(event: KeyboardEvent) {
    if (props.onClose && event.key === 'Tab') {
      const nodes = [
        ...container.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      ].filter((node) => node.offsetParent !== null);
      const first = nodes[0],
        last = nodes.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === container)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === container)
      ) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (
      isTextEntry(event.target) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.defaultPrevented
    )
      return;
    activity();
    const key = event.key.toLowerCase();
    if (key === 'arrowright') {
      event.preventDefault();
      move(1);
    } else if (key === 'arrowleft') {
      event.preventDefault();
      move(-1);
    } else if (key === 'i') setInfo((value) => !value);
    else if (key === 'c') beginCrop();
    else if (key === 'f') void fullscreen();
    else if (key === 'escape') {
      event.preventDefault();
      void escape();
    } else if (/^[0-5]$/.test(key)) void rate(Number(key));
  }
  async function action(label: string, run: () => Promise<void>) {
    if (busy()) return;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await run();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
      activity();
    }
  }
  async function changed(updated: Asset) {
    const revision = updated.preview_revision || revisions.get(updated.id);
    updated = { ...updated, preview_revision: revision };
    if (revision) revisions.set(updated.id, revision);
    if (updated.id === id()) setAsset(updated);
    props.onAssetChanged?.(updated);
    if (desktop)
      try {
        await emit('asset-updated', { id: updated.id, revision });
      } catch {
        /* The edit already succeeded; focus refresh also updates the manager. */
      }
  }
  async function rate(rating: number) {
    const target = asset();
    if (!target) return;
    await action('保存评级…', async () =>
      changed(await execute<Asset>('asset.rate', { id: target.id, rating })),
    );
  }
  function beginCrop() {
    if (!asset() || busy()) return;
    setCrop({ ...(asset()!.crop || fullCrop) });
    setCropMode(true);
    setInfo(true);
    activity();
  }
  async function saveCrop() {
    if (!asset() || !validCrop(crop())) return;
    await action('保存裁剪…', async () => {
      await changed(await execute<Asset>('asset.crop', { id: asset()!.id, ...crop() }));
      setCropMode(false);
      setNotice('裁剪已保存，原片保持不变。');
    });
  }
  async function resetCrop() {
    const target = asset();
    if (!target) return;
    await action('重置裁剪…', async () => {
      await changed(await execute<Asset>('asset.reset_crop', { id: target.id }));
      setCrop({ ...fullCrop });
      setCropMode(false);
    });
  }
  async function exportImage() {
    const target = asset();
    if (!target) return;
    await action('导出 JPEG…', async () => {
      const destination = await chooseSave(target.filename.replace(/\.[^.]+$/, '') + '-edited.jpg');
      if (!destination) return;
      const result = await execute<{ path: string }>('asset.export', {
        id: target.id,
        destination,
      });
      setNotice(desktop ? `已导出：${result.path}` : `已生成 ${result.path}，并交给浏览器下载。`);
    });
  }
  async function refreshOriginal() {
    const target = asset();
    if (!target || !desktop) return;
    await action('正在重新读取原图…', async () => {
      const refreshed = await execute<Asset>('asset.refresh', { id: target.id });
      await changed({ ...refreshed, preview_revision: Date.now() });
      setNotice('已重新读取原图，评级与裁剪配方已保留。');
    });
  }
  return (
    <div
      ref={container}
      tabIndex={-1}
      class={`immersive-viewer ${props.onClose ? 'viewer-overlay' : ''} ${showControls() ? '' : 'controls-hidden'} ${info() ? 'with-info' : ''}`}
      onPointerMove={activity}
      onPointerDown={activity}
      role={props.onClose ? 'dialog' : undefined}
      aria-modal={props.onClose ? true : undefined}
      aria-label="沉浸影像查看器"
    >
      <div class="viewer-image-area">
        <header class="immersive-toolbar viewer-chrome">
          <button class="icon-button" aria-label="返回图片库" title="返回图片库" onClick={manager}>
            <Icon name="grid" />
          </button>
          <div class="viewer-filename">
            <strong>{asset()?.filename || '影像查看器'}</strong>
            <span>
              {Math.max(0, index() + 1)} / {ids().length}
            </span>
          </div>
          <div class="viewer-toolbar-actions">
            <Show when={desktop}>
              <button
                class="icon-button"
                onClick={refreshOriginal}
                disabled={!asset() || !!busy() || cropMode()}
                aria-label="重新读取原图"
                title="重新读取原图"
              >
                <Icon name="refresh" />
              </button>
            </Show>
            <button
              class={`icon-button ${cropMode() ? 'active' : ''}`}
              onClick={() => (cropMode() ? setCropMode(false) : beginCrop())}
              disabled={!asset() || !!busy()}
              aria-label={cropMode() ? '退出裁剪' : '裁剪（C）'}
              title="裁剪（C）"
            >
              <Icon name="crop" />
            </button>
            <button
              class={`icon-button ${info() ? 'active' : ''}`}
              onClick={() => setInfo((value) => !value)}
              aria-label="影像信息（I）"
              aria-pressed={info()}
              title="影像信息（I）"
            >
              <Icon name="info" />
            </button>
            <button
              class="icon-button"
              onClick={exportImage}
              disabled={!asset() || !!busy() || cropMode()}
              aria-label="导出 JPEG"
              title="导出 JPEG"
            >
              <Icon name="export" />
            </button>
            <button
              class="icon-button"
              onClick={fullscreen}
              aria-label="切换全屏（F）"
              title="切换全屏（F）"
            >
              <Icon name="expand" />
            </button>
            <button
              class="icon-button"
              onClick={close}
              aria-label="关闭查看器（Esc）"
              title="关闭（Esc）"
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        <Show when={error()}>
          <div class="viewer-alert error" role="alert">
            <span>{error()}</span>
            <button class="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
        <Show when={notice()}>
          <div class="viewer-alert success" role="status">
            <span>{notice()}</span>
            <button class="icon-button" aria-label="关闭完成提示" onClick={() => setNotice('')}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
        <Show
          when={asset()}
          fallback={
            <div class="viewer-loading">
              {loading() ? (
                <>
                  <span class="spinner" />
                  <span>正在读取影像…</span>
                </>
              ) : (
                <>
                  <Icon name="photo" size={36} />
                  <span>暂时无法读取此影像</span>
                  <button class="button" onClick={() => id() && loadAsset(id()!)}>
                    重试
                  </button>
                </>
              )}
            </div>
          }
        >
          {(current) => (
            <PhotoView
              asset={current()}
              cropMode={cropMode()}
              crop={crop()}
              setCrop={setCrop}
              onPrevious={() => move(-1)}
              onNext={() => move(1)}
              hasPrevious={!busy() && !cropMode() && index() > 0}
              hasNext={!busy() && !cropMode() && index() < ids().length - 1}
            />
          )}
        </Show>
        <div class="viewer-bottom-status viewer-chrome">
          <span>{busy() || '← → 切换 · 滚轮缩放 · 拖动平移'}</span>
          <span>
            <kbd>I</kbd> 信息 <kbd>C</kbd> 裁剪 <kbd>F</kbd> 全屏
          </span>
        </div>
      </div>
      <Show when={info() && asset()}>
        <AssetInspector
          asset={asset()!}
          busy={!!busy()}
          cropMode={cropMode()}
          crop={crop()}
          setCrop={setCrop}
          onSaveCrop={saveCrop}
          onResetCrop={resetCrop}
          onRate={rate}
          onCrop={beginCrop}
          onExport={exportImage}
          onRefresh={desktop ? refreshOriginal : undefined}
          onClose={() => {
            setInfo(false);
            setCropMode(false);
          }}
        />
      </Show>
    </div>
  );
}
