import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  onMount,
} from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { chooseSave, desktop, execute, viewerContext } from './api';
import AssetInspector from './AssetInspector';
import PhotoView, { Thumbnail } from './PhotoView';
import Icon from './Icon';
import {
  errorMessage,
  fullCrop,
  imageRequestKey,
  isTextEntry,
  validCrop,
  type Asset,
  type AssetListOptions,
  type AssetListResult,
  type Crop,
  type Flag,
  type FocusInfo,
  type Preview,
} from './model';
import { viewerIds } from './workspace';
import { focusPresentation } from './viewer-focus';
import {
  CULL_MARK_ANIMATION_MS,
  UndoStack,
  compareWindow,
  cullKeyAction,
  markOf,
  nextAfterMark,
  readAutoAdvance,
  snapshotQueue,
  writeAutoAdvance,
  type Mark,
} from './culling';
import './viewer-focus.css';
import './culling.css';

export type ViewerMode = 'view' | 'cull';
export interface CullQueue {
  library_id: string;
  options: AssetListOptions;
}

export default function Viewer(props: {
  initialAssetId?: string;
  initialAssetIds?: string[];
  initialMode?: ViewerMode;
  initialQueue?: CullQueue;
  onClose?: () => void;
  onAssetChanged?: (asset: Asset) => void;
}) {
  const focusHelpId = createUniqueId();
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
  const [controlFocus, setControlFocus] = createSignal(false);
  const [previewPending, setPreviewPending] = createSignal(true);
  const [previewFailed, setPreviewFailed] = createSignal(false);
  const [previewKey, setPreviewKey] = createSignal('');
  const [previewMapping, setPreviewMapping] = createSignal<Preview['coordinate_mapping']>();
  const [focusEnabled, setFocusEnabled] = createSignal(false);
  const [focusData, setFocusData] = createSignal<FocusInfo>();
  const [focusLoading, setFocusLoading] = createSignal(false);
  const [focusError, setFocusError] = createSignal('');
  const [refreshing, setRefreshing] = createSignal(false);
  const [mode, setMode] = createSignal<ViewerMode>(props.initialMode || 'view');
  const [cullView, setCullView] = createSignal<'single' | 'compare'>('single');
  const [compareCount] = createSignal(2);
  const [hud, setHud] = createSignal(true);
  const [autoAdvance, setAutoAdvance] = createSignal(readAutoAdvance());
  const [pulse, setPulse] = createSignal<{ kind: 'rate' | 'flag'; value: string; key: number }>();
  const [zoomToggle, setZoomToggle] = createSignal(0);
  const [compareAssets, setCompareAssets] = createSignal<Record<string, Asset>>({});
  const [queueLoading, setQueueLoading] = createSignal(false);
  const undo = new UndoStack();
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingAdvance: (() => void) | undefined;
  let container!: HTMLDivElement;
  let timer: ReturnType<typeof setTimeout>;
  let request = 0;
  let focusRequest = 0;
  const revisions = new Map<string, number>();
  const focusCache = new Map<string, Promise<FocusInfo>>();
  const index = createMemo(() => ids().indexOf(id() || ''));
  const focusKey = createMemo(() => {
    const current = asset();
    return !refreshing() && current?.id === id() && current
      ? JSON.stringify({
          id: current.id,
          path: current.path,
          size: current.size,
          modified_at: current.modified_at,
          revision: current.preview_revision || 0,
        })
      : false;
  });
  const currentPreviewKey = createMemo(() => {
    const current = asset();
    return current?.id === id() && current ? imageRequestKey(current, cropMode()) : false;
  });
  createEffect(
    on(focusKey, (key) => {
      const token = ++focusRequest;
      setFocusData(undefined);
      setFocusError('');
      setFocusLoading(!!key);
      if (!key) return;
      let pending = focusCache.get(key);
      if (!pending) {
        pending = execute<FocusInfo>('asset.focus', { id: JSON.parse(key).id });
        focusCache.set(key, pending);
      }
      void pending
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
  const focus = createMemo(() => {
    const data = focusData();
    return data ? focusPresentation(data, previewMapping()) : { regions: [], message: '' };
  });
  const focusUnavailableReason = createMemo(() => {
    if (!asset() || loading()) return '正在读取影像…';
    if (cropMode()) return '裁剪时暂不显示对焦点';
    if (refreshing() || focusLoading()) return '正在检测对焦信息…';
    if (focusError()) return `对焦信息读取失败：${focusError()}`;
    const data = focusData();
    if (!data) return '正在检测对焦信息…';
    if (data.status !== 'available') return focus().message;
    if (previewPending() || previewKey() !== currentPreviewKey()) return '正在校验预览坐标…';
    if (previewFailed()) return '预览不可用，无法校验对焦坐标';
    return focus().regions.length ? '' : focus().message;
  });
  const focusVisible = createMemo(() => focusEnabled() && !focusUnavailableReason());
  const showControls = () =>
    controls() ||
    controlFocus() ||
    cropMode() ||
    loading() ||
    previewPending() ||
    previewFailed() ||
    focusLoading() ||
    !!busy() ||
    !!error();
  function isControl(target: EventTarget | null) {
    return (
      target instanceof HTMLElement &&
      !!target.closest('.viewer-chrome, .viewer-controls, .viewer-nav, .asset-inspector')
    );
  }
  function recoverFocus(preferred?: HTMLElement | null) {
    if (!container?.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    // A button can lose focus when an async action disables or replaces it.
    // Recover only an empty document focus, never another field or control.
    const target =
      preferred?.isConnected && !preferred.matches(':disabled') ? preferred : container;
    target.focus({ preventScroll: true });
  }
  function activity() {
    setControls(true);
    clearTimeout(timer);
    timer = setTimeout(() => setControls(false), 2400);
  }
  async function loadAsset(nextId: string) {
    const token = ++request;
    setLoading(true);
    setPreviewPending(true);
    setPreviewFailed(false);
    setPreviewKey('');
    setPreviewMapping(undefined);
    setError('');
    setNotice('');
    setAsset(undefined);
    setCropMode(false);
    try {
      const loaded = await execute<Asset>('asset.get', { id: nextId });
      const pending = optimistic.get(nextId);
      const next = pending ? { ...loaded, rating: pending.rating, flag: pending.flag } : loaded;
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
  async function adoptQueue(startId: string, ids: string[], queue?: CullQueue | null) {
    setIds(viewerIds(startId, ids));
    if (!queue) return;
    // Freeze membership once: marks made in this session never remove images.
    setQueueLoading(true);
    try {
      setIds(
        await snapshotQueue(
          (command, params) => execute<AssetListResult>(command, params),
          queue.library_id,
          queue.options,
          startId,
        ),
      );
    } catch (e) {
      setError(`无法载入选图队列，仅显示已打开的照片：${errorMessage(e)}`);
    } finally {
      setQueueLoading(false);
    }
  }
  onMount(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousTitle = document.title;
    // Single-letter shortcuts are active only while focus belongs to this viewer.
    container.focus({ preventScroll: true });
    if (props.initialAssetId) {
      void adoptQueue(props.initialAssetId, props.initialAssetIds || [], props.initialQueue);
    } else if (desktop)
      void viewerContext()
        .then((context) => {
          setMode(context.mode === 'cull' ? 'cull' : 'view');
          setId(context.asset_id);
          void adoptQueue(context.asset_id, context.asset_ids, context.queue);
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
      clearTimeout(pulseTimer);
      window.removeEventListener('keydown', keyboard);
      request++;
      focusRequest++;
      if (props.onClose) previousFocus?.focus();
      if (props.onClose) document.title = previousTitle;
    });
  });
  function move(direction: number) {
    if (cropMode() || busy()) return;
    if (loading() && mode() !== 'cull') return;
    const next = ids()[index() + direction];
    if (next) setId(next);
    activity();
  }
  // Culling: optimistic marks, short confirmation, then optional auto-advance.
  function finishPulse() {
    clearTimeout(pulseTimer);
    pulseTimer = undefined;
    setPulse(undefined);
    const advance = pendingAdvance;
    pendingAdvance = undefined;
    advance?.();
  }
  // Marks not yet confirmed by the catalog; a reload of that photo must not show stale values.
  const optimistic = new Map<string, Mark>();
  async function markTarget(targetId: string): Promise<Mark | undefined> {
    const pending = optimistic.get(targetId);
    if (pending) return pending;
    const current = asset();
    if (current?.id === targetId) return markOf(current);
    const compared = compareAssets()[targetId];
    if (compared) return markOf(compared);
    // Rapid keys can arrive before the next photo has loaded; read its marks directly.
    return markOf(await execute<Asset>('asset.get', { id: targetId }));
  }
  function applyLocal(updated: Mark) {
    setAsset((previous) =>
      previous && previous.id === updated.id
        ? { ...previous, rating: updated.rating, flag: updated.flag }
        : previous,
    );
    setCompareAssets((map) =>
      map[updated.id]
        ? {
            ...map,
            [updated.id]: { ...map[updated.id], rating: updated.rating, flag: updated.flag },
          }
        : map,
    );
  }
  async function persistMark(target: Mark, next: Mark) {
    const result =
      next.flag !== target.flag && next.rating !== target.rating
        ? await execute<Asset>('asset.mark_batch', {
            ids: [next.id],
            rating: next.rating,
            flag: next.flag,
          }).then(() => execute<Asset>('asset.get', { id: next.id }))
        : next.flag !== target.flag
          ? await execute<Asset>('asset.flag', { id: next.id, flag: next.flag })
          : await execute<Asset>('asset.rate', { id: next.id, rating: next.rating });
    await changed(result, next.flag !== target.flag ? 'flag' : 'rating');
  }
  async function mark(kind: 'rate' | 'flag', value: number | Flag) {
    // A key during the confirmation finishes it (and its advance) first, so each key
    // applies to the photo the user sees next; none is dropped or applied twice.
    if (pulse()) finishPulse();
    const targetId = id();
    if (!targetId) return;
    let before: Mark | undefined;
    try {
      before = await markTarget(targetId);
    } catch (e) {
      setError(`标记未保存：${errorMessage(e)}`);
      return;
    }
    if (!before || id() !== targetId) return;
    if (pulse()) finishPulse();
    const next: Mark =
      kind === 'rate' ? { ...before, rating: value as number } : { ...before, flag: value as Flag };
    const unchanged = next.rating === before.rating && next.flag === before.flag;
    applyLocal(next);
    const position = ids().indexOf(targetId);
    const step = nextAfterMark(position, ids().length, autoAdvance());
    setPulse({ kind, value: String(value), key: Date.now() });
    let failed = false;
    if (!unchanged) {
      const previous = before;
      optimistic.set(targetId, next);
      undo.push(previous);
      void persistMark(previous, next)
        .catch((e) => {
          failed = true;
          applyLocal(previous);
          setError(`标记未保存：${errorMessage(e)}`);
          if (id() !== targetId && ids().includes(targetId)) setId(targetId);
        })
        .finally(() => {
          if (optimistic.get(targetId) === next) optimistic.delete(targetId);
        });
    }
    // Advance on the confirmation, not on the save, so fast culling keeps pace.
    pendingAdvance = () => {
      if (failed || id() !== targetId) return;
      if (step.atEnd) setNotice('已到最后一张。');
      else if (step.index !== position) setId(ids()[step.index]);
    };
    pulseTimer = setTimeout(finishPulse, CULL_MARK_ANIMATION_MS);
  }
  async function undoMark() {
    if (pulse()) finishPulse();
    const previous = undo.pop();
    if (!previous) {
      setNotice('没有可撤销的标记。');
      return;
    }
    try {
      const updated = await execute<Asset>('asset.mark_batch', {
        ids: [previous.id],
        rating: previous.rating,
        flag: previous.flag,
      }).then(() => execute<Asset>('asset.get', { id: previous.id }));
      if (id() !== previous.id && ids().includes(previous.id)) setId(previous.id);
      applyLocal(previous);
      await changed(updated, 'flag');
    } catch (e) {
      undo.push(previous);
      setError(`撤销失败：${errorMessage(e)}`);
    }
  }
  function toggleMode() {
    if (cropMode()) setCropMode(false);
    setMode((value) => (value === 'cull' ? 'view' : 'cull'));
    activity();
  }
  function toggleAutoAdvance() {
    const next = !autoAdvance();
    setAutoAdvance(next);
    writeAutoAdvance(next);
  }
  const compareIds = createMemo(() =>
    mode() === 'cull' && cullView() === 'compare'
      ? compareWindow(ids(), Math.max(0, index()), compareCount())
      : [],
  );
  createEffect(
    on(compareIds, (list) => {
      for (const compareId of list) {
        if (compareAssets()[compareId]) continue;
        void execute<Asset>('asset.get', { id: compareId })
          .then((loaded) => setCompareAssets((map) => ({ ...map, [compareId]: loaded })))
          .catch(() => undefined);
      }
    }),
  );
  function cullKeyboard(event: KeyboardEvent): boolean {
    const action = cullKeyAction(event);
    if (!action) return false;
    event.preventDefault();
    if (action.kind === 'rate' || action.kind === 'flag') {
      if (!event.repeat) void mark(action.kind, action.value);
    } else if (action.kind === 'move') move(action.delta);
    else if (action.kind === 'view') setCullView(action.value);
    else if (action.kind === 'zoom') setZoomToggle((value) => value + 1);
    else if (action.kind === 'undo') void undoMark();
    else if (action.kind === 'hud') setHud((value) => !value);
    else if (action.kind === 'mode') toggleMode();
    else if (action.kind === 'focus') toggleFocus();
    else if (action.kind === 'fullscreen') void fullscreen();
    else if (action.kind === 'escape') void escape();
    return true;
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
    recoverFocus();
    if (!container.contains(document.activeElement)) return;
    if (
      mode() === 'cull' &&
      !isTextEntry(event.target) &&
      !event.defaultPrevented &&
      !(event.key === 'Tab' && isControl(document.activeElement))
    ) {
      activity();
      if (cullKeyboard(event)) return;
    }
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
    else if (key === 'c' && !event.shiftKey) beginCrop();
    else if (key === 'p' && !event.repeat) {
      event.preventDefault();
      toggleFocus();
    } else if (key === 'f') void fullscreen();
    else if (key === 'escape') {
      event.preventDefault();
      void escape();
    } else if (/^[0-5]$/.test(key)) void rate(Number(key));
    else if (key === 'c' && event.shiftKey) toggleMode();
  }
  function toggleFocus() {
    if (focusUnavailableReason()) return;
    setFocusEnabled((enabled) => !enabled);
    activity();
  }
  async function action(label: string, run: () => Promise<void>) {
    if (busy()) return;
    const trigger = container.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
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
      queueMicrotask(() => recoverFocus(trigger));
    }
  }
  async function changed(updated: Asset, change: 'rating' | 'flag' | 'crop' | 'refresh') {
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
          ...(change === 'rating' || change === 'flag' ? {} : { revision }),
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
      setNotice('裁剪配方已保存。');
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
        setNotice('已重新读取原图。');
      } finally {
        setRefreshing(false);
      }
    });
  }
  return (
    <div
      ref={container}
      tabIndex={-1}
      class={`immersive-viewer ${mode() === 'cull' ? 'culling' : ''} ${mode() === 'cull' && asset()?.flag === 'reject' ? 'rejected' : ''} ${props.onClose ? 'viewer-overlay' : ''} ${showControls() ? '' : 'controls-hidden'} ${info() ? 'with-info' : ''}`}
      onPointerMove={activity}
      onPointerDown={(event) => {
        activity();
        if ((event.target as HTMLElement).closest('.photo-stage') && !isControl(event.target))
          container.focus({ preventScroll: true });
      }}
      onFocusIn={(event) => {
        setControlFocus(isControl(event.target));
        activity();
      }}
      onFocusOut={(event) => setControlFocus(isControl(event.relatedTarget))}
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
            <Show when={!info() || !asset()}>
              <strong title={asset()?.filename}>{asset()?.filename || '影像查看器'}</strong>
            </Show>
            <Show when={ids().length > 1}>
              <span aria-label={`第 ${Math.max(0, index() + 1)} 张，共 ${ids().length} 张`}>
                {Math.max(0, index() + 1)} / {ids().length}
              </span>
            </Show>
          </div>
          <div class="viewer-toolbar-actions">
            <div class="viewer-mode-switch" role="group" aria-label="查看模式">
              <button
                class={mode() === 'view' ? 'active' : ''}
                aria-pressed={mode() === 'view'}
                onClick={() => mode() !== 'view' && toggleMode()}
                title="普通查看（Shift+C 切换）"
              >
                查看
              </button>
              <button
                class={mode() === 'cull' ? 'active' : ''}
                aria-pressed={mode() === 'cull'}
                aria-keyshortcuts="Shift+C"
                onClick={() => mode() !== 'cull' && toggleMode()}
                title="选图（Shift+C 切换）"
              >
                选图
              </button>
            </div>
            <Show when={mode() === 'cull'}>
              <button
                class={`button compact cull-auto ${autoAdvance() ? 'active' : ''}`}
                aria-pressed={autoAdvance()}
                onClick={toggleAutoAdvance}
                title="打分或打旗后自动前进到下一张"
              >
                自动下一张
              </button>
            </Show>
            <button
              class={`icon-button focus-toggle ${focusVisible() ? 'active' : ''}`}
              onClick={toggleFocus}
              aria-disabled={!!focusUnavailableReason()}
              aria-label={mode() === 'cull' ? '显示对焦点（Shift+F）' : '显示对焦点（P）'}
              aria-pressed={focusVisible()}
              aria-keyshortcuts={mode() === 'cull' ? 'Shift+F' : 'P'}
              aria-describedby={focusHelpId}
              title={
                focusUnavailableReason() ||
                `对焦点（${mode() === 'cull' ? 'Shift+F' : 'P'}）· 实线选定，虚线活动`
              }
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
            </button>
            <span id={focusHelpId} class="visually-hidden">
              {focusUnavailableReason() ||
                '显示相机记录的对焦区域。实线为选定区域，虚线为活动区域。'}
            </span>
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
              disabled={!asset() || !!busy() || mode() === 'cull'}
              aria-label={cropMode() ? '退出裁剪' : '裁剪（C）'}
              aria-pressed={cropMode()}
              aria-keyshortcuts="C"
              title="裁剪（C）"
            >
              <Icon name="crop" />
            </button>
            <button
              class={`icon-button ${info() ? 'active' : ''}`}
              onClick={() => setInfo((value) => !value)}
              aria-label="影像信息（I）"
              aria-pressed={info()}
              aria-keyshortcuts="I"
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
              aria-keyshortcuts="F"
              title="切换全屏（F）"
            >
              <Icon name="expand" />
            </button>
            <button
              class="icon-button"
              onClick={close}
              aria-label="关闭查看器（Esc）"
              aria-keyshortcuts="Escape"
              title="关闭（Esc）"
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        <Show when={error()}>
          <div class="viewer-alert error" role="alert">
            <Icon name="info" />
            <span>{error()}</span>
            <button class="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
        <Show when={notice()}>
          <div class="viewer-alert success" role="status">
            <Icon name="check" />
            <span>{notice()}</span>
            <button class="icon-button" aria-label="关闭完成提示" onClick={() => setNotice('')}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
        <Show when={compareIds().length}>
          <div
            class={`cull-compare count-${compareIds().length}`}
            role="listbox"
            aria-label="对比视图"
          >
            <For each={compareIds()}>
              {(compareId) => (
                <Show
                  when={compareAssets()[compareId]}
                  fallback={<div class="cull-compare-placeholder">载入中…</div>}
                >
                  {(item) => (
                    <div
                      class={`cull-compare-item ${compareId === id() ? 'focused' : ''}`}
                      role="option"
                      aria-selected={compareId === id()}
                    >
                      <Thumbnail
                        asset={item()}
                        selected={compareId === id()}
                        onSelect={() => setId(compareId)}
                        onOpen={() => {
                          setId(compareId);
                          setCullView('single');
                        }}
                      />
                    </div>
                  )}
                </Show>
              )}
            </For>
          </div>
        </Show>
        <Show
          when={compareIds().length ? undefined : asset()}
          fallback={
            <div class="viewer-loading" role="status" aria-live="polite">
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
              focusEnabled={focusVisible()}
              focusRegions={focus().regions}
              zoomToggle={zoomToggle()}
              onPreviewStateChange={(state) => {
                if (current().id !== id() || state.key !== currentPreviewKey()) return;
                setPreviewKey(state.key);
                setPreviewPending(state.loading);
                setPreviewFailed(state.failed);
                setPreviewMapping(state.loading || state.failed ? undefined : state.mapping);
                if (
                  !state.loading &&
                  !state.failed &&
                  state.asset?.id === current().id &&
                  (state.asset.metadata !== current().metadata ||
                    state.asset.width !== current().width ||
                    state.asset.height !== current().height)
                ) {
                  const inspected = state.asset;
                  setAsset(
                    (previous) =>
                      previous && {
                        ...previous,
                        width: inspected.width,
                        height: inspected.height,
                        metadata: inspected.metadata,
                        availability: inspected.availability,
                        cache_pinned: inspected.cache_pinned,
                      },
                  );
                }
              }}
            />
          )}
        </Show>
        <Show when={mode() === 'cull' && hud() && asset()}>
          {(current) => (
            <div
              class={`cull-hud ${pulse() ? `pulse pulse-${pulse()!.kind}` : ''} flag-${current().flag || 'none'}`}
              role="status"
              aria-live="polite"
            >
              <span class="cull-hud-stars" aria-label={`${current().rating} 星`}>
                <For each={[1, 2, 3, 4, 5]}>
                  {(value) => <i class={value <= current().rating ? 'on' : ''}>★</i>}
                </For>
              </span>
              <span class={`cull-hud-flag ${current().flag || 'none'}`}>
                {current().flag === 'pick'
                  ? '留用'
                  : current().flag === 'reject'
                    ? '淘汰'
                    : '未标记'}
              </span>
              <span class="cull-hud-count">
                {queueLoading() ? '队列载入中…' : `${Math.max(0, index() + 1)} / ${ids().length}`}
              </span>
              <span class="cull-hud-keys" aria-hidden="true">
                1–5 星 · P 留用 · X 淘汰 · U 清除 · ⌘/Ctrl+Z 撤销
              </span>
            </div>
          )}
        </Show>
        <Show when={busy()}>
          <div class="viewer-operation-status" role="status">
            <span class="spinner small" />
            {busy()}
          </div>
        </Show>
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
