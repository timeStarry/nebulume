import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { chooseSave, desktop, execute, viewerContext } from './api';
import AssetInspector from './AssetInspector';
import PhotoView from './PhotoView';
import Icon from './Icon';
import {
  errorMessage,
  fullCrop,
  isTextEntry,
  validCrop,
  type Asset,
  type Crop,
  type FocusInfo,
} from './model';
import { viewerIds } from './workspace';
import './viewer-focus.css';

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
  const [focusEnabled, setFocusEnabled] = createSignal(false);
  const [focusData, setFocusData] = createSignal<FocusInfo>();
  const [focusLoading, setFocusLoading] = createSignal(false);
  const [focusError, setFocusError] = createSignal('');
  const [refreshing, setRefreshing] = createSignal(false);
  let container!: HTMLDivElement;
  let timer: ReturnType<typeof setTimeout>;
  let request = 0;
  let focusRequest = 0;
  const revisions = new Map<string, number>();
  const index = createMemo(() => ids().indexOf(id() || ''));
  const focusKey = createMemo(() => {
    const current = asset();
    return focusEnabled() && !cropMode() && !refreshing() && current?.id === id() && current
      ? JSON.stringify({ id: current.id, revision: current.preview_revision || 0 })
      : false;
  });
  createEffect(
    on(focusKey, (key) => {
      const token = ++focusRequest;
      setFocusData(undefined);
      setFocusError('');
      setFocusLoading(!!key);
      if (!key) return;
      void execute<FocusInfo>('asset.focus', { id: JSON.parse(key).id })
        .then((result) => {
          if (token === focusRequest && key === focusKey()) setFocusData(result);
        })
        .catch((error) => {
          if (token === focusRequest && key === focusKey()) setFocusError(errorMessage(error));
        })
        .finally(() => {
          if (token === focusRequest) setFocusLoading(false);
        });
    }),
  );
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
      if (token === request && id() === nextId) {
        setAsset({ ...next, preview_revision: revisions.get(next.id) });
        setCrop({ ...(next.crop || fullCrop) });
        document.title = `${next.filename} — Nebulume`;
        if (desktop) await getCurrentWindow().setTitle(document.title);
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
      focusRequest++;
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
    else if (key === 'p' && !event.repeat) {
      event.preventDefault();
      toggleFocus();
    } else if (key === 'f') void fullscreen();
    else if (key === 'escape') {
      event.preventDefault();
      void escape();
    } else if (/^[0-5]$/.test(key)) void rate(Number(key));
  }
  function toggleFocus() {
    if (!asset()) return;
    setFocusEnabled((enabled) => !enabled);
    activity();
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
  async function changed(updated: Asset, change: 'rating' | 'crop' | 'refresh') {
    const revision =
      change === 'crop' ? Date.now() : updated.preview_revision || revisions.get(updated.id);
    updated = { ...updated, preview_revision: revision };
    if (revision) revisions.set(updated.id, revision);
    if (updated.id === id()) setAsset(updated);
    props.onAssetChanged?.(updated);
    if (desktop)
      try {
        await emit('asset-updated', {
          id: updated.id,
          change,
          asset: updated,
          ...(change === 'rating' ? {} : { revision }),
        });
      } catch {
        setError('编辑已保存，但未能通知图库更新。请在图库使用“扫描更新”。');
      }
  }
  async function rate(rating: number) {
    const target = asset();
    if (!target) return;
    await action('保存评级…', async () =>
      changed(await execute<Asset>('asset.rate', { id: target.id, rating }), 'rating'),
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
      await changed(await execute<Asset>('asset.crop', { id: asset()!.id, ...crop() }), 'crop');
      setCropMode(false);
      setNotice('裁剪已保存，原片保持不变。');
    });
  }
  async function resetCrop() {
    const target = asset();
    if (!target) return;
    await action('重置裁剪…', async () => {
      await changed(await execute<Asset>('asset.reset_crop', { id: target.id }), 'crop');
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
      setRefreshing(true);
      try {
        const refreshed = await execute<Asset>('asset.refresh', { id: target.id });
        await changed({ ...refreshed, preview_revision: Date.now() }, 'refresh');
        setNotice('已重新读取原图，评级与裁剪配方已保留。');
      } finally {
        setRefreshing(false);
      }
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
            <button
              class={`icon-button focus-toggle ${focusEnabled() ? 'active' : ''}`}
              onClick={toggleFocus}
              disabled={!asset()}
              aria-label="显示对焦点（P）"
              aria-pressed={focusEnabled()}
              title="显示对焦点（P，裁剪时暂隐藏）"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                aria-hidden="true"
              >
                <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />
                <rect x="8" y="8" width="8" height="8" rx="1" />
              </svg>
              <span>对焦点</span>
            </button>
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
              focusEnabled={focusEnabled()}
              focusData={focusData()}
              focusLoading={focusLoading() || refreshing()}
              focusError={focusError()}
            />
          )}
        </Show>
        <div class="viewer-bottom-status viewer-chrome">
          <span>{busy() || '← → 切换 · 滚轮缩放 · 拖动平移'}</span>
          <span>
            <kbd>I</kbd> 信息 <kbd>C</kbd> 裁剪 <kbd>P</kbd> 对焦点 <kbd>F</kbd> 全屏
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
