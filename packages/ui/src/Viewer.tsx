import {
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
import {
  chooseDirectory,
  chooseExternalApp,
  chooseSave,
  desktop,
  execute,
  openExternal,
  revealInFolder,
  viewerContext,
} from './api';
import ExportDialog from './ExportDialog';
import type { ExportRecipe } from './export-presets';
import { previewUrl } from './preview-url';
import AssetInspector from './AssetInspector';
import CompareStage from './CompareStage';
import { fitCropToAspect, resolveAspectRatio, type AspectPreset } from './crop-aspect';
import PhotoView, { decodedThumbnail, rememberDecodedPreview } from './PhotoView';
import { prefetchViewerImage } from './viewer-frame-cache';
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
  type ColorLabel,
  type Crop,
  type Flag,
  type FocusInfo,
  type Preview,
  type XmpSyncReport,
} from './model';
import { viewerIds } from './workspace';
import { focusPresentation } from './viewer-focus';
import {
  CULL_MARK_ANIMATION_MS,
  compareWindow,
  cullKeyAction,
  markOf,
  nextAfterMark,
  readAutoAdvance,
  snapshotQueue,
  writeAutoAdvance,
  type Mark,
} from './culling';
import CullPanel, { CullStatus } from './CullPanel';
import { IconButton, Segmented, Toggle, createHud } from './ui';
import { createUndoHistory, keyToColorLabel, markHudText, type UndoEntry } from './undo';
import ViewerOverlay from './ViewerOverlay';
import { readOverlayFades, readToolbarAutoHide } from './overlay-layout';
import CullStrip from './CullStrip';
import CullReview from './CullReview';
import {
  exportPhotos,
  exportSummary,
  restorePhotos,
  trashPhotos,
  trashSummary,
} from './photo-actions';
import { FolderBrowser, listFolder } from './folder-browser';
import ContextMenu, { type ContextMenuState } from './ContextMenu';
import type { Library } from './model';
import './viewer-focus.css';
import './viewer-chrome.css';
import './cull.css';

export type ViewerMode = 'view' | 'cull';
export interface CullQueue {
  library_id: string;
  options: AssetListOptions;
}

export default function Viewer(props: {
  initialAssetId?: string;
  initialAssetIds?: string[];
  initialAssets?: Asset[];
  initialMode?: ViewerMode;
  initialQueue?: CullQueue;
  onClose?: () => void;
  onAssetChanged?: (asset: Asset) => void;
  /** The photo on screen, so the library can return to it when the viewer closes. */
  onCurrent?: (id: string) => void;
  /** Photos left the library (moved to the Trash or put back). */
  onTrashed?: () => void;
}) {
  const focusHelpId = createUniqueId();
  const initialMap: Record<string, Asset> = {};
  if (props.initialAssets) {
    for (const each of props.initialAssets) initialMap[each.id] = each;
  }
  const initialKnown = props.initialAssetId ? initialMap[props.initialAssetId] : undefined;
  const [ids, setIds] = createSignal<string[]>(props.initialAssetIds || []);
  const [id, setId] = createSignal(props.initialAssetId);
  const [asset, setAsset] = createSignal<Asset | undefined>(initialKnown);
  // The photo shown before the current load began; its frame stays dimmed behind the
  // spinner when the next photo has no decoded thumbnail yet, so the stage never flashes empty.
  const [previousFrame, setPreviousFrame] = createSignal<string>();
  const [loading, setLoading] = createSignal(!initialKnown);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [busy, setBusy] = createSignal('');
  const [info, setInfo] = createSignal(false);
  const [cropMode, setCropMode] = createSignal(false);
  const [crop, setCrop] = createSignal<Crop>({ ...(initialKnown?.crop || fullCrop) });
  const [controls, setControls] = createSignal(true);
  const [controlFocus, setControlFocus] = createSignal(false);
  const [toolbarAutoHide, setToolbarAutoHide] = createSignal(readToolbarAutoHide(localStorage));
  const [toolbarAwake, setToolbarAwake] = createSignal(true);
  const [navDir, setNavDir] = createSignal<1 | -1>(1);
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
  const [compareCount, setCompareCount] = createSignal<2 | 4>(2);
  const [compareAnchor, setCompareAnchor] = createSignal(0);
  const [compareSync, setCompareSync] = createSignal(true);
  const [clippingEnabled, setClippingEnabled] = createSignal(false);
  const [preferRaw, setPreferRaw] = createSignal(false);
  const [cropPreset, setCropPreset] = createSignal<AspectPreset>('free');
  const [cropSwapped, setCropSwapped] = createSignal(false);
  const [overlayVisible, setOverlayVisible] = createSignal(true);
  const [editingOverlay, setEditingOverlay] = createSignal(false);
  const [autoAdvance, setAutoAdvance] = createSignal(readAutoAdvance());
  const [pulse, setPulse] = createSignal<{ kind: 'rate' | 'flag'; value: string; key: number }>();
  const [zoomToggle, setZoomToggle] = createSignal(0);
  const [compareAssets, setCompareAssets] = createSignal<Record<string, Asset>>({});
  const [queueLoading, setQueueLoading] = createSignal(false);
  // Opened from a file: browse its folder, and offer to make the folder a library.
  const [folder, setFolder] = createSignal<FolderBrowser>();
  const [outside, setOutside] = createSignal(false);
  const [menu, setMenu] = createSignal<ContextMenuState>();
  const [exportTargets, setExportTargets] = createSignal<string[] | null>(null);
  // Culling & instant navigation: known photos for the strip, counts, and zero-jump switching.
  const [items, setItems] = createSignal<Record<string, Asset>>(initialMap);
  const [seen, setSeen] = createSignal(new Set<string>());
  const [review, setReview] = createSignal(false);
  const remember = (list: Asset[]) =>
    setItems((map) => {
      const next = { ...map };
      for (const item of list) next[item.id] = item;
      return next;
    });
  const queueItems = createMemo(() => ids().flatMap((each) => items()[each] ?? []));
  const picks = createMemo(() => queueItems().filter((item) => item.flag === 'pick'));
  const rejects = createMemo(() => queueItems().filter((item) => item.flag === 'reject'));
  createEffect(
    on([id, mode], ([current, now]) => {
      if (!current || now !== 'cull' || seen().has(current)) return;
      setSeen((set) => new Set(set).add(current));
    }),
  );
  // Without a listed queue (culling started from plain viewing), read the photos near the current one.
  const requested = new Set<string>();
  createEffect(
    on([ids, () => ids().indexOf(id() || ''), mode], ([list, at, now]) => {
      if (now !== 'cull' || queueLoading()) return;
      const missing = list
        .slice(Math.max(0, at - 20), at + 21)
        .filter((each) => !items()[each] && !requested.has(each));
      for (const each of missing) {
        requested.add(each);
        void execute<Asset>('asset.get', { id: each })
          .then((loaded) => remember([loaded]))
          .catch(() => requested.delete(each));
      }
    }),
  );
  const history = createUndoHistory(200);
  const hud = createHud();
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingAdvance: (() => void) | undefined;
  let container!: HTMLDivElement;
  let timer: ReturnType<typeof setTimeout>;
  let toolbarTimer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;
  let focusRequest = 0;
  const revisions = new Map<string, number>();
  const focusCache = new Map<string, Promise<FocusInfo>>();
  const index = createMemo(() => ids().indexOf(id() || ''));
  // Between cold unindexed photos asset() may still be empty: fill the stage with a decoded thumb.
  const stagePlaceholder = () => {
    const next = id();
    return next ? decodedThumbnail({ id: next, preview_revision: revisions.get(next) }) : undefined;
  };
  // Once a local photo is on screen, pre-decode adjacent viewer-tier frames in both travel
  // directions (`+dir`, `-dir`, `+2*dir`) into the shared viewer pool so `PhotoView` swaps in 0ms.
  createEffect(
    on([asset, navDir], ([current, dir]) => {
      if (!current || current.source_key || compareIds().length) return;
      const position = ids().indexOf(current.id);
      if (position < 0) return;
      const browser = folder();
      const firstAhead = ids()[position + dir] ?? ids()[position - dir];
      if (browser && firstAhead && FolderBrowser.isPlaceholder(firstAhead)) {
        void browser
          .resolve(firstAhead)
          .then((resolved) => {
            remember([resolved]);
            setIds([...browser.ids]);
          })
          .catch(() => undefined);
        return;
      }
      const candidates = [
        ids()[position + dir],
        ids()[position - dir],
        ids()[position + dir * 2],
      ];
      const seenNeighbours = new Set<string>();
      const neighbours = candidates.filter((each): each is string => {
        if (!each || each === current.id || FolderBrowser.isPlaceholder(each) || seenNeighbours.has(each))
          return false;
        seenNeighbours.add(each);
        return true;
      });
      if (!neighbours.length) return;
      const controller = new AbortController();
      const delay = setTimeout(() => {
        for (const neighbour of neighbours) {
          const rev = revisions.get(neighbour) ?? items()[neighbour]?.preview_revision;
          void Promise.resolve(previewUrl({ id: neighbour, preview_revision: rev }, 'p2560'))
            .then((url) => prefetchViewerImage(url, controller.signal))
            .then((image) =>
              rememberDecodedPreview(
                { id: neighbour, preview_revision: rev },
                image.src,
                image.naturalWidth,
                image.naturalHeight,
              ),
            )
            .catch(() => undefined);
        }
      }, 24);
      onCleanup(() => {
        clearTimeout(delay);
        controller.abort();
      });
    }),
  );
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
    return current?.id === id() && current
      ? imageRequestKey(current, cropMode(), !cropMode() && preferRaw() && current.kind === 'raw')
      : false;
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
    if (!asset() || asset()?.id !== id() || loading()) return '正在读取影像…';
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
    editingOverlay() ||
    previewFailed() ||
    !!busy() ||
    !!error();
  const showToolbar = () =>
    !toolbarAutoHide() ||
    toolbarAwake() ||
    cropMode() ||
    editingOverlay() ||
    !!menu() ||
    !!error();
  function isControl(target: EventTarget | null) {
    return (
      target instanceof HTMLElement &&
      !!target.closest(
        '.viewer-chrome, .viewer-controls, .compare-bar, .viewer-nav, .asset-inspector',
      )
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
  function scheduleToolbarSleep() {
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(() => {
      toolbarTimer = undefined;
      setToolbarAwake(false);
    }, 1500);
  }
  function activity() {
    setControls(true);
    clearTimeout(timer);
    timer = setTimeout(() => setControls(false), 2400);
  }
  function pointerMoveActivity(event: PointerEvent) {
    activity();
    if (!toolbarAutoHide()) return;
    const inTopZone =
      event.clientY <= 64 ||
      (event.target instanceof HTMLElement && !!event.target.closest('.nl-viewer-bar'));
    if (inTopZone) {
      clearTimeout(toolbarTimer);
      toolbarTimer = undefined;
      setToolbarAwake(true);
    } else if (toolbarAwake() && !toolbarTimer) {
      scheduleToolbarSleep();
    }
  }
  async function loadAsset(nextId: string) {
    const token = ++request;
    setPreviewFailed(false);
    setError('');
    setNotice('');
    setCropMode(false);
    setCropPreset('free');
    setCropSwapped(false);

    const browser = folder();
    const known = !FolderBrowser.isPlaceholder(nextId) ? items()[nextId] : undefined;
    if (known) {
      const pending = optimistic.get(nextId);
      const immediate = pending
        ? { ...known, rating: pending.rating, flag: pending.flag }
        : known;
      const rev = revisions.get(nextId) ?? immediate.preview_revision;
      setAsset({ ...immediate, ...(rev !== undefined ? { preview_revision: rev } : {}) });
      setCrop({ ...(immediate.crop || fullCrop) });
      setLoading(false);
    } else {
      setLoading(true);
      const leaving = asset();
      if (leaving && leaving.id !== nextId) {
        setPreviousFrame(
          decodedThumbnail({ id: leaving.id, preview_revision: revisions.get(leaving.id) }),
        );
      }
    }

    try {
      if (browser && FolderBrowser.isPlaceholder(nextId)) {
        const opened = await browser.resolve(nextId);
        if (token !== request || id() !== nextId) return;
        remember([opened]);
        setIds([...browser.ids]);
        setId(opened.id);
        return;
      }
      const loaded = await execute<Asset>('asset.get', { id: nextId });
      const pending = optimistic.get(nextId);
      const next = pending ? { ...loaded, rating: pending.rating, flag: pending.flag } : loaded;
      remember([next]);
      if (token === request && id() === nextId) {
        const rev = revisions.get(next.id) ?? next.preview_revision;
        setAsset((previous) => {
          const keepEnrichedMeta =
            previous?.id === next.id &&
            Object.keys(next.metadata || {}).length === 0 &&
            Object.keys(previous.metadata || {}).length > 0;
          return {
            ...next,
            width: next.width || (previous?.id === next.id ? previous.width : undefined),
            height: next.height || (previous?.id === next.id ? previous.height : undefined),
            metadata: keepEnrichedMeta ? previous!.metadata : next.metadata,
            ...(rev !== undefined ? { preview_revision: rev } : {}),
          };
        });
        setCrop({ ...(next.crop || fullCrop) });
        document.title = `${next.filename} — Lumen`;
        // Only a viewer window names itself; inside the library window the title stays.
        if (desktop && !props.onClose) await getCurrentWindow().setTitle(document.title);
      }
    } catch (e) {
      if (token === request && id() === nextId) {
        if (!known) setAsset(undefined);
        setError(errorMessage(e));
      }
    } finally {
      if (token === request) setLoading(false);
    }
  }
  createEffect(
    on(id, (next) => {
      if (next) props.onCurrent?.(next);
      if (next) void loadAsset(next);
    }),
  );
  async function adoptFolder(startId: string) {
    try {
      const start = await execute<Asset>('asset.get', { id: startId });
      const [listing, libraries] = await Promise.all([
        listFolder(start.path),
        execute<Library[]>('library.list').catch(() => [] as Library[]),
      ]);
      // A hidden library holds files opened outside every visible one.
      setOutside(!libraries.some((library) => library.id === start.library_id));
      if (!listing || ids().length > 1) return;
      const browser = new FolderBrowser(listing, startId);
      setFolder(browser);
      setIds([...browser.ids]);
    } catch {
      /* The single photo stays viewable. */
    }
  }
  async function addFolderToLibraries() {
    const browser = folder();
    const target = asset();
    if (!target) return;
    const root = browser?.listing.folder ?? target.path.replace(/[\\/][^\\/]+$/, '');
    const name = root.split(/[\\/]/).filter(Boolean).at(-1) || root;
    await action(`正在把 ${name} 加入图片库…`, async () => {
      const library = await execute<Library>('library.add', { name, root, pair_raw_jpeg: true });
      const result = await execute<{ indexed: number }>('library.scan', { library_id: library.id });
      setOutside(false);
      setNotice(`已加入图片库“${library.name}”，索引了 ${result.indexed} 张。`);
      if (desktop) await emit('library-changed', { library_id: library.id }).catch(() => undefined);
    });
  }
  function moreMenu(event: MouseEvent) {
    const target = asset();
    const button = event.currentTarget as HTMLElement;
    const rect = button.getBoundingClientRect();
    const local = !!target && !target.source_key;
    setMenu({
      x: rect.right - 232,
      y: rect.bottom + 4,
      label: '更多',
      returnFocus: button,
      items: [
        {
          label: '导出为 JPEG…',
          icon: 'export',
          disabled: !target || !!busy() || cropMode(),
          onSelect: () => void exportImage(),
        },
        {
          label: '按预设导出…',
          icon: 'download',
          shortcut: '⌘⇧E',
          disabled: !target || !!busy() || cropMode(),
          onSelect: () => target && setExportTargets([target.id]),
        },
        ...(desktop && local
          ? [
              {
                label: '在文件夹中显示',
                icon: 'folder-open' as const,
                disabled: !target?.path,
                onSelect: () =>
                  void revealInFolder(target!.path).catch((e) => setError(errorMessage(e))),
              },
              {
                label: '用默认应用打开',
                icon: 'external-link' as const,
                disabled: !target?.path,
                onSelect: () =>
                  void openExternal({ id: target!.id, path: target!.path }).catch((e) =>
                    setError(errorMessage(e)),
                  ),
              },
              {
                label: '选择外部精修软件打开…',
                icon: 'app-window' as const,
                disabled: !target?.path,
                onSelect: () =>
                  void chooseExternalApp()
                    .then((app) => {
                      if (app) return openExternal({ id: target!.id, path: target!.path, appPath: app });
                    })
                    .catch((e) => setError(errorMessage(e))),
              },
            ]
          : []),
        ...(local
          ? [
              {
                label: '写入 .xmp 伴随文件',
                icon: 'file' as const,
                disabled: !!busy(),
                onSelect: () => void syncViewerXmp('write'),
              },
              {
                label: '从 .xmp 重新读取标记',
                icon: 'refresh' as const,
                disabled: !!busy(),
                onSelect: () => void syncViewerXmp('read'),
              },
            ]
          : []),
        ...(desktop
          ? [
              {
                label: '重新读取原图',
                icon: 'refresh' as const,
                disabled: !target || !!busy() || cropMode(),
                onSelect: () => void refreshOriginal(),
              },
            ]
          : []),
        { label: '全屏', icon: 'expand', shortcut: 'F', onSelect: () => void fullscreen() },
        {
          label: '复制文件路径',
          icon: 'copy',
          disabled: !target?.path,
          onSelect: () =>
            void navigator.clipboard
              .writeText(target!.path)
              .then(() => setNotice('已复制文件路径。'))
              .catch(() => setError('无法写入剪贴板。')),
        },
        'separator',
        {
          label: '在图片库中显示',
          icon: 'grid',
          disabled: !target || outside(),
          onSelect: () => void manager(),
        },
        ...(outside()
          ? [
              {
                label: '把此文件夹加入图片库…',
                icon: 'folder-plus' as const,
                onSelect: () => void addFolderToLibraries(),
              },
            ]
          : []),
        {
          label: '编辑叠加信息…',
          icon: 'layout-dashboard',
          onSelect: () => {
            setOverlayVisible(true);
            setEditingOverlay(true);
          },
        },
        ...(local
          ? [
              'separator' as const,
              {
                label: '移到废纸篓',
                icon: 'trash' as const,
                shortcut: '⌘⌫',
                danger: true,
                disabled: !!busy() || cropMode(),
                onSelect: () => void trash([target!.id]),
              },
            ]
          : []),
      ],
    });
  }
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
          remember,
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
          if (context.from_file && context.asset_ids.length <= 1)
            void adoptFolder(context.asset_id);
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
    if (toolbarAutoHide()) scheduleToolbarSleep();
    const syncStorage = () => {
      const nextAutoHide = readToolbarAutoHide(localStorage);
      setToolbarAutoHide(nextAutoHide);
      if (nextAutoHide) scheduleToolbarSleep();
      else setToolbarAwake(true);
    };
    window.addEventListener('storage', syncStorage);
    window.addEventListener('keydown', keyboard);
    onCleanup(() => {
      clearTimeout(timer);
      clearTimeout(toolbarTimer);
      clearTimeout(pulseTimer);
      window.removeEventListener('storage', syncStorage);
      window.removeEventListener('keydown', keyboard);
      request++;
      focusRequest++;
      if (props.onClose) previousFocus?.focus();
      if (props.onClose) document.title = previousTitle;
    });
  });
  function move(direction: number) {
    if (cropMode() || busy()) return;
    if (!asset() && loading() && mode() !== 'cull') return;
    setNavDir(direction < 0 ? -1 : 1);
    const next = ids()[index() + direction];
    if (next) setId(next);
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
    const patch = (item: Asset): Asset => ({
      ...item,
      rating: updated.rating,
      flag: updated.flag,
      ...(updated.color_label !== undefined ? { color_label: updated.color_label } : {}),
    });
    setItems((map) => (map[updated.id] ? { ...map, [updated.id]: patch(map[updated.id]) } : map));
    setAsset((previous) =>
      previous && previous.id === updated.id ? patch(previous) : previous,
    );
    setCompareAssets((map) =>
      map[updated.id] ? { ...map, [updated.id]: patch(map[updated.id]) } : map,
    );
  }
  async function persistMark(target: Mark, next: Mark) {
    const colorChanged =
      next.color_label !== undefined && next.color_label !== (target.color_label ?? 'none');
    const flagChanged = next.flag !== target.flag;
    const ratingChanged = next.rating !== target.rating;
    const changedCount = Number(colorChanged) + Number(flagChanged) + Number(ratingChanged);
    const result =
      changedCount > 1
        ? await execute<Asset>('asset.mark_batch', {
            ids: [next.id],
            rating: next.rating,
            flag: next.flag,
            ...(next.color_label !== undefined ? { color_label: next.color_label } : {}),
          }).then(() => execute<Asset>('asset.get', { id: next.id }))
        : colorChanged
          ? await execute<Asset>('asset.label', { id: next.id, color_label: next.color_label })
          : flagChanged
            ? await execute<Asset>('asset.flag', { id: next.id, flag: next.flag })
            : await execute<Asset>('asset.rate', { id: next.id, rating: next.rating });
    await changed(
      result,
      colorChanged ? 'color_label' : flagChanged ? 'flag' : 'rating',
    );
  }
  async function mark(
    kind: 'rate' | 'flag' | 'color_label',
    value: number | Flag | ColorLabel,
    fromKeyboard = false,
  ) {
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
    const nextColor =
      kind === 'color_label'
        ? ((before.color_label ?? 'none') === value ? 'none' : (value as ColorLabel))
        : before.color_label;
    const next: Mark =
      kind === 'rate'
        ? { ...before, rating: value as number }
        : kind === 'flag'
          ? { ...before, flag: value as Flag }
          : { ...before, color_label: nextColor };
    const unchanged =
      next.rating === before.rating &&
      next.flag === before.flag &&
      (next.color_label ?? 'none') === (before.color_label ?? 'none');
    applyLocal(next);
    const position = ids().indexOf(targetId);
    const step = nextAfterMark(
      position,
      ids().length,
      cullView() === 'compare' ? false : autoAdvance(),
    );
    setPulse({
      kind: kind === 'color_label' ? 'flag' : kind,
      value: String(kind === 'color_label' ? nextColor : value),
      key: Date.now(),
    });
    const hudMark =
      kind === 'rate'
        ? { rating: value as number }
        : kind === 'flag'
          ? { flag: value as Flag }
          : { color_label: nextColor };
    if (fromKeyboard) hud.show(markHudText(hudMark), kind === 'rate' ? 'star' : 'flag');
    let failed = false;
    if (!unchanged) {
      const previous = before;
      optimistic.set(targetId, next);
      history.push({
        label: markHudText(hudMark),
        ids: [targetId],
        revert: () => revertMark(previous),
      });
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
  async function revertMark(previous: Mark) {
    const updated = await execute<Asset>('asset.mark_batch', {
      ids: [previous.id],
      rating: previous.rating,
      flag: previous.flag,
      color_label: previous.color_label ?? 'none',
    }).then(() => execute<Asset>('asset.get', { id: previous.id }));
    if (id() !== previous.id && ids().includes(previous.id)) setId(previous.id);
    applyLocal(previous);
    await changed(updated, 'flag');
  }
  /** Ctrl/⌘+Z in either mode, and the toast's undo button (`entry`). */
  async function undoLatest(entry?: UndoEntry) {
    if (pulse()) finishPulse();
    if (!entry && !history.size) {
      hud.show('没有可撤销的操作', 'history');
      return;
    }
    const run = async () => {
      const done = await history.undo(entry);
      if (done) hud.show(`已撤销：${done.label}`, 'history');
    };
    if (entry?.toast || (!entry && history.peek()?.toast)) await action('正在放回原处…', run);
    else
      await run().catch((e) => {
        setError(`撤销失败：${errorMessage(e)}`);
      });
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
  createEffect(
    on(
      [mode, cullView, id, ids, compareCount],
      ([now, view, currentId, list, count]) => {
        if (now !== 'cull' || view !== 'compare' || !currentId) return;
        const currentWindow = compareWindow(list, compareAnchor(), count);
        if (!currentWindow.includes(currentId)) {
          setCompareAnchor(Math.max(0, list.indexOf(currentId)));
        }
      },
    ),
  );
  const compareIds = createMemo(() =>
    mode() === 'cull' && cullView() === 'compare'
      ? compareWindow(ids(), compareAnchor(), compareCount())
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
  function toggleClipping(fromKeyboard = false) {
    const next = !clippingEnabled();
    setClippingEnabled(next);
    if (fromKeyboard) hud.show(next ? '高光/暗部溢出警告：开启' : '高光/暗部溢出警告：关闭', 'info');
    activity();
  }
  function rawUnavailable(target: Asset | undefined) {
    return !!target?.metadata['Decode Status']?.includes('不可用');
  }
  function toggleRawMode(fromKeyboard = false) {
    const target = asset();
    if (!target || cropMode()) return;
    if (target.kind !== 'raw') {
      if (fromKeyboard) hud.show('当前为光栅图像，已使用原图解码', 'photo');
      return;
    }
    if (rawUnavailable(target)) {
      if (fromKeyboard) hud.show('此 RAW 暂不支持传感器显影，已使用相机预览', 'photo');
      return;
    }
    const next = !preferRaw();
    setPreferRaw(next);
    if (fromKeyboard) hud.show(next ? 'RAW 传感器显影' : '相机内嵌预览', 'photo');
    activity();
  }
  function cullKeyboard(event: KeyboardEvent): boolean {
    if (event.key === ' ' && (isControl(document.activeElement) || event.repeat)) return false;
    const action = cullKeyAction(event);
    if (!action) return false;
    event.preventDefault();
    if (action.kind === 'rate' || action.kind === 'flag' || action.kind === 'color_label') {
      if (!event.repeat) void mark(action.kind, action.value, true);
    } else if (action.kind === 'move') move(action.delta);
    else if (action.kind === 'view') {
      if (action.value === 'compare') setCompareAnchor(Math.max(0, index()));
      setCullView(action.value);
    } else if (action.kind === 'zoom') setZoomToggle((value) => value + 1);
    else if (action.kind === 'clipping') {
      if (!event.repeat) toggleClipping(true);
    } else if (action.kind === 'raw_mode') {
      if (!event.repeat) toggleRawMode(true);
    } else if (action.kind === 'undo') void undoLatest();
    else if (action.kind === 'overlay') setOverlayVisible((value) => !value);
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
      // Inside the library window, Escape leaves the viewer; the window keeps its own fullscreen.
      if (desktop && !props.onClose && (await getCurrentWindow().isFullscreen())) {
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
    if (exportTargets()) return;
    recoverFocus();
    if (!container.contains(document.activeElement)) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === 'e' &&
      !isTextEntry(event.target)
    ) {
      event.preventDefault();
      if (asset() && !cropMode() && !busy()) setExportTargets([asset()!.id]);
      return;
    }
    if (editingOverlay()) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        setEditingOverlay(false);
        container.focus({ preventScroll: true });
      }
      // Tab and the overlay's own Enter/Space handling still work; nothing acts on the photo.
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      (event.key === 'Backspace' || event.key === 'Delete') &&
      !isTextEntry(event.target)
    ) {
      event.preventDefault();
      if (asset() && !cropMode()) void trash([asset()!.id]);
      return;
    }
    if (review()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setReview(false);
      }
      return;
    }
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
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'z' &&
      !isTextEntry(event.target) &&
      !cropMode()
    ) {
      event.preventDefault();
      void undoLatest();
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
    else if (key === 'f' && event.shiftKey && !event.repeat) {
      event.preventDefault();
      toggleFocus();
    } else if (key === 'f' && !event.shiftKey) void fullscreen();
    else if (
      (key === 'p' || key === 'x' || key === 'u') &&
      !event.shiftKey &&
      !event.repeat &&
      !cropMode()
    ) {
      event.preventDefault();
      void flagPhoto(key === 'p' ? 'pick' : key === 'x' ? 'reject' : 'none', true);
    } else if (key === 'd') setOverlayVisible((value) => !value);
    else if (key === 'z' && !event.shiftKey && !cropMode()) {
      event.preventDefault();
      setZoomToggle((value) => value + 1);
    } else if (key === 'j' && !event.shiftKey && !cropMode() && !event.repeat) {
      event.preventDefault();
      toggleClipping(true);
    } else if (key === 'r' && !event.shiftKey && !cropMode() && !event.repeat) {
      event.preventDefault();
      toggleRawMode(true);
    } else if (
      event.key === ' ' &&
      !event.shiftKey &&
      !event.repeat &&
      !cropMode() &&
      !isControl(document.activeElement)
    ) {
      event.preventDefault();
      void escape();
    } else if (key === 'escape') {
      event.preventDefault();
      void escape();
    } else if (/^[0-5]$/.test(key)) void rate(Number(key), true);
    else if (/^[6-9]$/.test(key) && !cropMode() && !event.repeat) {
      event.preventDefault();
      const color = keyToColorLabel(key);
      if (color) void colorLabelPhoto(color, true);
    } else if (key === 'c' && event.shiftKey) toggleMode();
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
  async function changed(
    updated: Asset,
    change: 'rating' | 'flag' | 'color_label' | 'keywords' | 'crop' | 'refresh',
  ) {
    const revision =
      change === 'crop' ? Date.now() : updated.preview_revision || revisions.get(updated.id);
    updated = { ...updated, preview_revision: revision };
    if (revision) revisions.set(updated.id, revision);
    if (updated.id === id()) setAsset(updated);
    if (items()[updated.id]) remember([updated]);
    props.onAssetChanged?.(updated);
    // Inside the library window the owner already received the change directly.
    if (desktop && !props.onClose)
      try {
        await emit('asset-updated', {
          id: updated.id,
          change,
          asset: updated,
          ...(change === 'rating' ||
          change === 'flag' ||
          change === 'color_label' ||
          change === 'keywords'
            ? {}
            : { revision }),
        });
      } catch {
        setError('编辑已保存，但未能通知图库更新。请在图库使用“扫描更新”。');
      }
  }
  async function librarySynced() {
    if (props.onTrashed) props.onTrashed();
    else if (desktop && asset())
      await emit('library-changed', { library_id: asset()!.library_id }).catch(() => undefined);
  }
  /** Moves photos to the system Trash and out of this viewer; the notice can put them back. */
  async function trash(targets: string[]) {
    if (!targets.length || busy()) return;
    const before = ids();
    const position = Math.max(0, before.indexOf(id() || ''));
    let result: Awaited<ReturnType<typeof trashPhotos>> | undefined;
    await action(`正在移到废纸篓：${targets.length} 张…`, async () => {
      result = await trashPhotos(targets);
    });
    if (!result) return;
    const summary = trashSummary(result);
    if (summary.error) setError(summary.error);
    if (!result.trashed.length) return;
    const gone = new Set(result.trashed);
    const remaining = before.filter((each) => !gone.has(each));
    const browser = folder();
    if (browser)
      for (const each of gone) {
        const at = browser.ids.indexOf(each);
        if (at >= 0) browser.ids.splice(at, 1);
      }
    setIds(remaining);
    history.forget(gone);
    if (gone.has(id() || '')) {
      const next = remaining[Math.min(position, remaining.length - 1)];
      if (next) setId(next);
      else {
        setAsset(undefined);
        setId(undefined);
      }
    }
    const moved = result.trashed;
    history.push({
      label: `已把 ${targets.length} 张照片移到废纸篓。`,
      toast: true,
      ids: moved,
      revert: async () => {
        const restored = await restorePhotos(moved);
        const back = new Set(restored.restored);
        setIds((list) => before.filter((each) => back.has(each) || list.includes(each)));
        const browser = folder();
        if (browser) browser.ids.splice(0, browser.ids.length, ...ids());
        if (!id() && restored.restored[0]) setId(before.find((each) => back.has(each)));
        if (restored.failed.length)
          setError(`${restored.failed.length} 张未能放回：${restored.failed[0].message}`);
        else setNotice(`已放回 ${restored.restored.length} 个文件。`);
        await librarySynced();
      },
    });
    await librarySynced();
  }
  async function exportPicks(targets: string[]) {
    const directory = desktop ? await chooseDirectory('选择导出文件夹') : '';
    if (desktop && !directory) return;
    await action(`正在导出 ${targets.length} 张…`, async () => {
      const result = await exportPhotos(
        targets,
        directory ?? '',
        new Map(Object.entries(items())),
        (done, total) => setBusy(`正在导出 ${done} / ${total}…`),
      );
      const summary = exportSummary(result, directory ?? '', desktop);
      if (summary.error) setError(summary.error);
      else setNotice(summary.notice!);
    });
  }
  async function rate(rating: number, fromKeyboard = false) {
    const target = asset();
    if (!target) return;
    const before = target.rating;
    if (fromKeyboard) hud.show(markHudText({ rating }), 'star');
    if (before === rating) return;
    let saved = false;
    await action('保存评级…', async () => {
      await changed(await execute<Asset>('asset.rate', { id: target.id, rating }), 'rating');
      saved = true;
    });
    if (saved)
      history.push({
        label: markHudText({ rating }),
        ids: [target.id],
        revert: async () =>
          changed(await execute<Asset>('asset.rate', { id: target.id, rating: before }), 'rating'),
      });
  }
  async function flagPhoto(flag: Flag, fromKeyboard = false) {
    const target = asset();
    if (!target || cropMode()) return;
    const before: Flag = (optimistic.get(target.id)?.flag ?? target.flag ?? 'none') as Flag;
    if (fromKeyboard) hud.show(markHudText({ flag }), 'flag');
    if (before === flag) return;
    const currentColor: ColorLabel =
      (optimistic.get(target.id)?.color_label ?? target.color_label ?? 'none') as ColorLabel;
    const next: Mark = { id: target.id, rating: target.rating, flag, color_label: currentColor };
    optimistic.set(target.id, next);
    applyLocal(next);
    history.push({
      label: markHudText({ flag }),
      ids: [target.id],
      revert: async () => {
        const updated = await execute<Asset>('asset.flag', { id: target.id, flag: before });
        applyLocal({
          id: target.id,
          rating: updated.rating,
          flag: before,
          color_label: (updated.color_label ?? currentColor) as ColorLabel,
        });
        await changed(updated, 'flag');
      },
    });
    try {
      const updated = await execute<Asset>('asset.flag', { id: target.id, flag });
      if (optimistic.get(target.id) === next) await changed(updated, 'flag');
    } catch (e) {
      if (optimistic.get(target.id) === next) {
        applyLocal({ id: target.id, rating: target.rating, flag: before, color_label: currentColor });
      }
      setError(`标记未保存：${errorMessage(e)}`);
    } finally {
      if (optimistic.get(target.id) === next) optimistic.delete(target.id);
    }
  }
  async function colorLabelPhoto(color: ColorLabel, fromKeyboard = false) {
    const target = asset();
    if (!target || cropMode()) return;
    const before: ColorLabel =
      (optimistic.get(target.id)?.color_label ?? target.color_label ?? 'none') as ColorLabel;
    const desired: ColorLabel = fromKeyboard && before === color ? 'none' : color;
    if (fromKeyboard) hud.show(markHudText({ color_label: desired }), 'flag');
    if (before === desired) return;
    const next: Mark = {
      id: target.id,
      rating: target.rating,
      flag: (target.flag ?? 'none') as Flag,
      color_label: desired,
    };
    optimistic.set(target.id, next);
    applyLocal(next);
    history.push({
      label: markHudText({ color_label: desired }),
      ids: [target.id],
      revert: async () => {
        const updated = await execute<Asset>('asset.label', {
          id: target.id,
          color_label: before,
        });
        applyLocal({
          id: target.id,
          rating: updated.rating,
          flag: (updated.flag ?? 'none') as Flag,
          color_label: before,
        });
        await changed(updated, 'color_label');
      },
    });
    try {
      const updated = await execute<Asset>('asset.label', {
        id: target.id,
        color_label: desired,
      });
      if (optimistic.get(target.id) === next) await changed(updated, 'color_label');
    } catch (e) {
      if (optimistic.get(target.id) === next) {
        applyLocal({
          id: target.id,
          rating: target.rating,
          flag: (target.flag ?? 'none') as Flag,
          color_label: before,
        });
      }
      setError(`色标未保存：${errorMessage(e)}`);
    } finally {
      if (optimistic.get(target.id) === next) optimistic.delete(target.id);
    }
  }
  const cropFrameDims = () => {
    const current = asset();
    const m = previewMapping();
    return {
      width: m?.full_width || current?.width || 1,
      height: m?.full_height || current?.height || 1,
    };
  };
  const cropAspect = createMemo(() => {
    const dims = cropFrameDims();
    return resolveAspectRatio(cropPreset(), cropSwapped(), dims.width, dims.height);
  });
  function selectCropAspect(preset: AspectPreset, swapped: boolean) {
    setCropPreset(preset);
    setCropSwapped(swapped);
    if (preset === 'free') return;
    const dims = cropFrameDims();
    const ratio = resolveAspectRatio(preset, swapped, dims.width, dims.height);
    if (ratio) setCrop((prev) => fitCropToAspect(prev, ratio, dims.width, dims.height));
  }
  function beginCrop() {
    if (!asset() || busy()) return;
    setCrop({ ...(asset()!.crop || fullCrop) });
    setCropPreset('free');
    setCropSwapped(false);
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
  async function exportWithPreset(targets: string[], recipe: ExportRecipe, directory: string) {
    await action(`正在按预设导出 ${targets.length} 张…`, async () => {
      const known = new Map<string, Asset>(Object.entries(items()));
      if (asset()) known.set(asset()!.id, asset()!);
      const result = await exportPhotos(
        targets,
        directory,
        known,
        (done, count) => setBusy(`正在导出 ${done} / ${count}…`),
        recipe,
      );
      setExportTargets(null);
      const summary = exportSummary(result, directory, desktop);
      if (summary.error) setError(summary.error);
      else setNotice(summary.notice!);
    });
  }
  async function syncViewerXmp(mode: 'write' | 'read') {
    const target = asset();
    if (!target || target.source_key) return;
    await action(mode === 'write' ? '正在写入 .xmp 伴随文件…' : '正在读取 .xmp 伴随文件…', async () => {
      const report = await execute<XmpSyncReport>(
        mode === 'write' ? 'asset.xmp.write' : 'asset.xmp.read',
        { ids: [target.id] },
      );
      if (mode === 'read') {
        const refreshed = await execute<Asset>('asset.get', { id: target.id });
        await changed({ ...refreshed, preview_revision: Date.now() }, 'crop');
        setNotice(report.updated ? '已从 .xmp 同步标记与裁剪。' : '未检测到新的 .xmp 伴随变更。');
      } else {
        setNotice(`已写入 .xmp 伴随文件。`);
      }
      if (report.errors.length) setError(report.errors[0].message);
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
      class={`immersive-viewer ${mode() === 'cull' ? 'culling' : ''} ${mode() === 'cull' && asset()?.flag === 'reject' ? 'rejected' : ''} ${props.onClose ? 'viewer-overlay' : ''} ${showControls() ? '' : 'controls-hidden'} ${toolbarAutoHide() ? 'toolbar-autohide' : ''} ${showToolbar() ? '' : 'toolbar-hidden'} ${info() ? 'with-info' : ''} ${readOverlayFades(localStorage) ? 'overlay-fades' : ''}`}
      onPointerMove={pointerMoveActivity}
      onPointerDown={(event) => {
        activity();
        if (
          toolbarAutoHide() &&
          (event.clientY <= 64 ||
            (event.target instanceof HTMLElement && !!event.target.closest('.nl-viewer-bar')))
        ) {
          clearTimeout(toolbarTimer);
          toolbarTimer = undefined;
          setToolbarAwake(true);
        }
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
        <header class="nl-viewer-bar immersive-toolbar viewer-chrome">
          <IconButton
            icon="arrow-left"
            size="sm"
            tipAlign="start"
            label="返回图片库"
            onClick={manager}
          />
          <div class="viewer-filename">
            <Show when={!info() || !asset()}>
              <strong title={asset()?.path || asset()?.filename}>
                {asset()?.filename || folder()?.nameOf(id() || '') || '影像查看器'}
              </strong>
            </Show>
            <Show when={folder()}>
              <span class="viewer-folder">{folder()!.folderName}</span>
            </Show>
            <Show when={ids().length > 1}>
              <span aria-label={`第 ${Math.max(0, index() + 1)} 张，共 ${ids().length} 张`}>
                {Math.max(0, index() + 1)} / {ids().length}
              </span>
            </Show>
          </div>
          <div class="viewer-toolbar-actions">
            <Segmented
              size="sm"
              label="查看模式"
              value={mode()}
              onChange={(next) => next !== mode() && toggleMode()}
              options={[
                { value: 'view', label: '查看' },
                { value: 'cull', label: '选片', shortcut: 'Shift+C' },
              ]}
            />
            <Show when={mode() === 'cull'}>
              <Show when={ids().length > 1}>
                <Segmented
                  size="sm"
                  label="选片视图"
                  value={cullView()}
                  onChange={(next) => {
                    if (next === 'compare') setCompareAnchor(Math.max(0, index()));
                    setCullView(next as 'single' | 'compare');
                  }}
                  options={[
                    { value: 'single', label: '单张', shortcut: 'G' },
                    { value: 'compare', label: '对比', shortcut: 'C' },
                  ]}
                />
              </Show>
              <Toggle pressed={autoAdvance()} onChange={() => toggleAutoAdvance()}>
                自动下一张
              </Toggle>
            </Show>
            <IconButton
              size="sm"
              icon="layout-dashboard"
              label="叠加信息（D）"
              shortcut="D"
              pressed={overlayVisible()}
              onClick={() => setOverlayVisible((value) => !value)}
            />
            <button
              class={`nl-icon-btn nl-icon-btn--sm focus-toggle ${focusVisible() ? 'active' : ''}`}
              onClick={toggleFocus}
              aria-disabled={!!focusUnavailableReason()}
              aria-label="显示对焦点（Shift+F）"
              aria-pressed={focusVisible()}
              aria-keyshortcuts="Shift+F"
              aria-describedby={focusHelpId}
              title={
                focusUnavailableReason() ||
                '对焦点（Shift+F）· 实线选定，虚线活动'
              }
            >
              <Icon name="focus-2" size={16} />
            </button>
            <span id={focusHelpId} class="visually-hidden">
              {focusUnavailableReason() ||
                '显示相机记录的对焦区域。实线为选定区域，虚线为活动区域。'}
            </span>
            <IconButton
              size="sm"
              icon="crop"
              label={cropMode() ? '退出裁剪' : '裁剪（C）'}
              shortcut="C"
              pressed={cropMode()}
              disabled={!asset() || !!busy() || mode() === 'cull'}
              onClick={() => (cropMode() ? setCropMode(false) : beginCrop())}
            />
            <IconButton
              size="sm"
              icon="more"
              label="更多"
              aria-haspopup="menu"
              onClick={moreMenu}
            />
            <IconButton
              size="sm"
              icon="layout-sidebar-right"
              tipAlign="end"
              label="影像信息（I）"
              shortcut="I"
              pressed={info()}
              onClick={() => setInfo((value) => !value)}
            />
            <Show when={!props.onClose}>
              <IconButton
                size="sm"
                icon="close"
                tipAlign="end"
                label="关闭查看器（Esc）"
                shortcut="Esc"
                onClick={close}
              />
            </Show>
          </div>
        </header>
        <Show when={outside() && !props.onClose}>
          <div class="viewer-banner" role="note">
            <span>
              {folder() ? `“${folder()!.folderName}”不在图片库中，` : '这张照片不在图片库中，'}
              评级和旗标只保存在本机。
            </span>
            <button
              class="button small"
              disabled={!!busy()}
              onClick={() => void addFolderToLibraries()}
            >
              加入图片库
            </button>
            <button class="icon-button" aria-label="关闭提示" onClick={() => setOutside(false)}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
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
        <Show when={!compareIds().length && asset()}>
          {(current) => (
            <ViewerOverlay
              asset={current()}
              context={{
                index: Math.max(0, index() + 1),
                total: ids().length,
                folder: folder()?.folderName,
              }}
              visible={overlayVisible()}
              editing={editingOverlay()}
              onEditing={(value) => {
                setEditingOverlay(value);
                if (!value) container.focus({ preventScroll: true });
              }}
            />
          )}
        </Show>
        <Show when={history.offer()} keyed>
          {(entry) => (
            <div class="viewer-alert success" role="status">
              <Icon name="check" />
              <span>{entry.label}</span>
              <button
                class="button small"
                aria-keyshortcuts="Meta+Z Control+Z"
                onClick={() => void undoLatest(entry)}
              >
                撤销 <kbd class="nl-kbd">⌘Z</kbd>
              </button>
            </div>
          )}
        </Show>
        <hud.Host tone="viewer" />
        <Show when={compareIds().length}>
          <CompareStage
            ids={compareIds()}
            assets={compareAssets()}
            activeId={id()}
            count={compareCount()}
            onCountChange={setCompareCount}
            syncLocked={compareSync()}
            onToggleSync={() => setCompareSync((value) => !value)}
            preferRaw={preferRaw()}
            clippingEnabled={clippingEnabled()}
            onToggleClipping={() => toggleClipping(false)}
            zoomToggle={zoomToggle()}
            onSelect={(nextId) => {
              if (pulse()) finishPulse();
              setId(nextId);
              container.focus({ preventScroll: true });
            }}
            onExitCompare={() => setCullView('single')}
          />
        </Show>
        <Show when={!compareIds().length}>
          <Show
            when={asset()}
            fallback={
              <div class="viewer-loading" role="status" aria-live="polite">
                {loading() ? (
                  <>
                    <Show
                      when={stagePlaceholder()}
                      fallback={
                        <Show when={previousFrame()}>
                          {(src) => (
                            <img
                              class="photo-placeholder previous-frame"
                              src={src()}
                              alt=""
                              aria-hidden="true"
                            />
                          )}
                        </Show>
                      }
                    >
                      {(src) => (
                        <img class="photo-placeholder" src={src()} alt="" aria-hidden="true" />
                      )}
                    </Show>
                    <span class="viewer-message over-placeholder">
                      <span class="spinner" />
                      <span>正在读取影像…</span>
                    </span>
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
                fill={false}
                preferRaw={preferRaw()}
                onTogglePreferRaw={
                  rawUnavailable(current()) ? undefined : () => toggleRawMode(false)
                }
                clippingEnabled={clippingEnabled()}
                onToggleClipping={() => toggleClipping(false)}
                cropAspect={cropAspect()}
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
                    const enriched: Asset = {
                      ...current(),
                      width: inspected.width,
                      height: inspected.height,
                      metadata: inspected.metadata,
                      availability: inspected.availability,
                      cache_pinned: inspected.cache_pinned,
                    };
                    remember([enriched]);
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
        </Show>
        <Show when={mode() === 'cull' && info() && asset()}>
          {(current) => (
            <div class="cull-status cull-status--floating" role="status" aria-live="polite">
              <CullStatus
                asset={current()}
                position={queueLoading() ? undefined : Math.max(0, index() + 1)}
                total={ids().length}
              />
            </div>
          )}
        </Show>
        <Show when={mode() === 'cull' && !compareIds().length && ids().length > 1}>
          <CullStrip
            ids={ids()}
            items={items()}
            current={id()}
            seen={seen()}
            onSelect={(next) => {
              if (pulse()) finishPulse();
              setId(next);
              container.focus({ preventScroll: true });
            }}
          />
        </Show>
        <Show when={busy()}>
          <div class="viewer-operation-status" role="status">
            <span class="spinner small" />
            {busy()}
          </div>
        </Show>
      </div>
      <Show when={mode() === 'cull' && !info() && asset()}>
        {(current) => (
          <CullPanel
            asset={current()}
            total={ids().length}
            seen={ids().filter((each) => seen().has(each)).length}
            picks={picks().length}
            rejects={rejects().length}
            busy={!!busy()}
            onFlag={(flag) => void mark('flag', flag)}
            onRate={(rating) => void mark('rate', rating)}
            onFinish={() => setReview(true)}
            pulse={pulse()?.kind}
            position={queueLoading() ? undefined : Math.max(0, index() + 1)}
          />
        )}
      </Show>
      <Show when={menu()}>
        {(state) => <ContextMenu menu={state()} onClose={() => setMenu(undefined)} />}
      </Show>
      <Show when={review()}>
        <CullReview
          picks={picks()}
          rejects={rejects()}
          canTrash={!rejects().some((item) => item.source_key)}
          busy={!!busy()}
          onBack={() => {
            setReview(false);
            container.focus({ preventScroll: true });
          }}
          onExport={(targets) => void exportPicks(targets)}
          onTrash={(targets) => {
            setReview(false);
            container.focus({ preventScroll: true });
            void trash(targets);
          }}
        />
      </Show>
      <Show when={info() && asset()}>
        <AssetInspector
          asset={asset()!}
          busy={!!busy()}
          cropMode={cropMode()}
          crop={crop()}
          setCrop={setCrop}
          cropAspectPreset={cropPreset()}
          cropAspectSwapped={cropSwapped()}
          onSelectCropAspect={selectCropAspect}
          onSaveCrop={saveCrop}
          onResetCrop={resetCrop}
          onRate={rate}
          onColorLabel={(color) => void colorLabelPhoto(color, false)}
          onKeywordsUpdated={(keywords) => {
            const current = asset();
            if (current) void changed({ ...current, keywords }, 'keywords');
          }}
          onCrop={beginCrop}
          onExport={exportImage}
          onRefresh={desktop ? refreshOriginal : undefined}
          onClose={() => {
            setInfo(false);
            setCropMode(false);
          }}
        />
      </Show>
      <Show when={exportTargets()}>
        {(targets) => (
          <ExportDialog
            count={targets().length}
            sample={asset()}
            busy={!!busy()}
            onClose={() => {
              setExportTargets(null);
              container.focus({ preventScroll: true });
            }}
            onConfirm={(recipe, dir) => void exportWithPreset(targets(), recipe, dir)}
          />
        )}
      </Show>
    </div>
  );
}
