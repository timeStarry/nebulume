import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  chooseDirectory,
  chooseImage,
  desktop,
  execute,
  openViewerWindow,
  pregeneratePreviews,
  watchLibraries,
} from './api';
import { addBrowserFiles } from './demo';
import { ConfirmDialog, LibraryDialog, StorageDialog } from './Dialogs';
import AssetInspector from './AssetInspector';
import LibrarySidebar, {
  readSidebarCollapsed,
  writeSidebarCollapsed,
  type FolderAction,
} from './LibrarySidebar';
import AppShell from './AppShell';
import LibrariesOverview from './LibrariesOverview';
import BatchDock from './BatchDock';
import TaskPill from './TaskPill';
import { createTaskCenter } from './tasks';
import { chunkIds, createSelection } from './selection';
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  IconButton,
  PageHeader,
  Segmented,
  Select,
  Slider,
  Spacer,
  TextInput,
  Toggle,
  Toolbar,
} from './ui';
import type { MenuEntry } from './ui';
import './library/library.css';
import './library/wall.css';
import LibraryOverview from './LibraryOverview';
import {
  exportPhotos,
  exportSummary,
  restorePhotos,
  trashPhotos,
  trashSummary,
} from './photo-actions';
import { Thumbnail } from './PhotoView';
import { gridTier, watchDevicePixelRatio } from './preview-url';
import StorageWorkspace from './StorageWorkspace';
import ImportWorkspace from './ImportWorkspace';
import Viewer, { type CullQueue, type ViewerMode } from './Viewer';
import Icon from './Icon';
import Settings from './SettingsWorkspace';
import CaptureIndexControl from './CaptureIndexControl';
import OverflowMenu from './OverflowMenu';
import ContextMenu, { type ContextMenuState } from './ContextMenu';
import JustifiedGrid, { type JustifiedGridApi } from './JustifiedGrid';
import { fitRect, fly } from './zoom-transition';
import { createFeedback, FeedbackStack } from './feedback';
import { groupMarks, markHudText, type UndoEntry } from './undo';
import { UpdatePrompt } from './UpdatePanel';
import { updates } from './updates';
import {
  errorMessage,
  isTextEntry,
  type Asset,
  type AssetFacets,
  type AssetIdsResult,
  type AssetListOptions,
  type AssetListResult,
  type Flag,
  type FlagFilter,
  type ImportBatch,
  type Library,
  type LibraryFolders,
  type ScanResult,
  type StorageConfig,
  type TrashResult,
} from './model';
import {
  availabilityPresentation,
  libraryLocation,
  variantViewerIds,
  type WorkspaceSection,
  LAST_LIBRARY_KEY,
  pickInitialLibrary,
} from './workspace';
import {
  changedAssetFields,
  mergePendingUpdate,
  needsCatalogReconcile,
  type AssetUpdated,
  type AssetChange,
} from './management-sync';

type Dialog = 'library' | 'storage' | null;
export default function ManagementApp() {
  const [section, setSection] = createSignal<WorkspaceSection>('libraries');
  const [navigationOpen, setNavigationOpen] = createSignal(false);
  const [compactNavigation, setCompactNavigation] = createSignal(false);
  const [libraries, setLibraries] = createSignal<Library[]>([]);
  const [sources, setSources] = createSignal<StorageConfig[]>([]);
  const [system, setSystem] = createSignal<Record<string, unknown>>();
  const [libraryId, setLibraryId] = createSignal<string>();
  const [assetStore, setAssetStore] = createStore<{ items: Asset[] }>({ items: [] });
  const assets = () => assetStore.items;
  function setAssets(next: Asset[] | ((previous: Asset[]) => Asset[])) {
    setAssetStore(
      'items',
      reconcile(typeof next === 'function' ? next(assets()) : next, { key: 'id' }),
    );
  }
  const [total, setTotal] = createSignal(0);
  const [fileTotal, setFileTotal] = createSignal<number>();
  const selection = createSelection(() => assets().map((asset) => asset.id));
  const {
    selectedId,
    setSelectedId,
    picked,
    setPicked,
    selectedIds,
    clearPicked,
    select: selectAsset,
  } = selection;
  const tasks = createTaskCenter();
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(readSidebarCollapsed());
  function toggleSidebar() {
    const next = !sidebarCollapsed();
    setSidebarCollapsed(next);
    writeSidebarCollapsed(next);
  }
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState>();
  const [query, setQuery] = createSignal('');
  const [rating, setRating] = createSignal(0);
  const [format, setFormat] = createSignal<NonNullable<AssetListOptions['format']>>('all');
  const [flag, setFlag] = createSignal<FlagFilter>('any');
  const [batchId, setBatchId] = createSignal('');
  const [camera, setCamera] = createSignal('');
  const [lens, setLens] = createSignal('');
  const [capturedFrom, setCapturedFrom] = createSignal('');
  const [capturedTo, setCapturedTo] = createSignal('');
  // Library-relative folder chosen in the sidebar tree; '' is the whole library.
  const [folder, setFolder] = createSignal('');
  // A filter picked from an overview chart, shown as one removable chip.
  const [extra, setExtra] = createSignal<{ label: string; options: Partial<AssetListOptions> }>();
  const [folders, setFolders] = createSignal<LibraryFolders>();
  // 照片 shows the grid, 概览 the statistics for the same filter; 选片 opens culling.
  const [view, setView] = createSignal<'photos' | 'overview'>('photos');
  // 全部图片库: a card overview of every library, opened from the foot of the sidebar.
  const [allLibraries, setAllLibraries] = createSignal(false);
  // Culling started from a folder waits for that folder's first page.
  const [cullWhenLoaded, setCullWhenLoaded] = createSignal(false);
  const [facets, setFacets] = createSignal<AssetFacets>();
  const [filtersOpen, setFiltersOpen] = createSignal(readFiltersOpen());
  const [batches, setBatches] = createSignal<ImportBatch[]>([]);
  const [sort, setSort] = createSignal<NonNullable<AssetListOptions['sort_by']>>('captured_at');
  const [direction, setDirection] =
    createSignal<NonNullable<AssetListOptions['sort_direction']>>('desc');
  const [thumbSize, setThumbSize] = createSignal(readThumbSize());
  const [devicePixelRatio, setDevicePixelRatio] = createSignal(window.devicePixelRatio || 1);
  const [info, setInfo] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  // Stops automatic paging after a failure so a scroll cannot retry in a loop.
  const [autoPagingFailed, setAutoPagingFailed] = createSignal(false);
  // The sentinel near the grid's end is in range. Kept as state, not a one-shot callback, so a
  // page that finishes while the user is already at the end immediately loads the next one.
  const [nearEnd, setNearEnd] = createSignal(false);
  // Intersection reports are asynchronous: a value from before a page landed is stale. Clear it
  // when a load starts and ask the observer for a fresh report when it ends.
  let rearmPaging: (() => void) | undefined;
  createEffect(
    on(loading, (busy) => {
      setNearEnd(false);
      if (!busy) rearmPaging?.();
    }),
  );
  createEffect(() => {
    if (nearEnd() && !loading() && !autoPagingFailed() && assets().length < total())
      void untrack(() => loadAssets(true));
  });
  const feedback = createFeedback();
  const { busy, setBusy, setError, setNotice, setSyncError, action } = feedback;
  const [dialog, setDialog] = createSignal<Dialog>(null);
  const [editingSource, setEditingSource] = createSignal<StorageConfig>();
  const [editingLibrary, setEditingLibrary] = createSignal<Library>();
  const [removing, setRemoving] = createSignal<
    { kind: 'library'; item: Library } | { kind: 'source'; item: StorageConfig }
  >();
  const removalReferences = createMemo(() =>
    removing()?.kind === 'source'
      ? libraries().filter((library) => library.storage_id === removing()?.item.id)
      : [],
  );
  const [librarySource, setLibrarySource] = createSignal<StorageConfig>();
  const [libraryPrefix, setLibraryPrefix] = createSignal('');
  const [libraryRoot, setLibraryRoot] = createSignal<string>();
  const [dropActive, setDropActive] = createSignal(false);
  const [overlay, setOverlay] = createSignal<{
    id: string;
    ids: string[];
    mode?: ViewerMode;
    queue?: CullQueue;
  }>();
  // The photo the in-window viewer shows, so closing zooms back to its tile.
  let viewerCurrent: string | undefined;
  let fileInput!: HTMLInputElement;
  let searchInput: HTMLInputElement | undefined;
  let navigationButton: HTMLButtonElement | undefined;
  let navigationElement: HTMLElement | undefined;
  let collectionScroll: HTMLDivElement | undefined;
  let photoGrid: JustifiedGridApi | undefined;
  let request = 0;
  const revisions = new Map<string, number>();
  const recentUpdates = new Map<string, { sequence: number; asset: Asset }>();
  let updateSequence = 0;
  const pendingUpdates = new Map<string, AssetUpdated>();
  const dirtyLibraries = new Set<string>();
  const completedCaptureJobs = new Set<string>();
  let drainingUpdates = false;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let registeringListener = false;
  let openAfterImport = false;
  const visibleLibraries = createMemo(() => libraries().filter((library) => !library.hidden));
  const currentLibrary = createMemo(() =>
    libraries().find((library) => library.id === libraryId()),
  );
  const selected = createMemo(() => assets().find((asset) => asset.id === selectedId()));
  const filtered = () =>
    !!(
      query() ||
      rating() ||
      format() !== 'all' ||
      flag() !== 'any' ||
      batchId() ||
      camera() ||
      lens() ||
      capturedFrom() ||
      capturedTo()
    );
  const [detail, { mutate: mutateDetail, refetch: refetchDetail }] = createResource(
    () => info() && section() === 'libraries' && selected()?.id,
    async (id): Promise<{ asset: Asset | null; error: string }> => {
      const started = updateSequence;
      try {
        const fetched = await execute<Asset>('asset.get', { id });
        const update = recentUpdates.get(id);
        return {
          asset: {
            ...(update && update.sequence > started ? update.asset : fetched),
            preview_revision: revisions.get(id),
          },
          error: '',
        };
      } catch (e) {
        return { asset: null, error: errorMessage(e) };
      }
    },
  );
  async function refreshLibraries() {
    try {
      setLibraries(await execute<Library[]>('library.list'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function refreshSources() {
    try {
      setSources(await execute<StorageConfig[]>('storage.list'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function updateSource(source: StorageConfig) {
    setSources((previous) => [...previous.filter((item) => item.id !== source.id), source]);
  }
  createEffect(
    on(visibleLibraries, () => {
      if (section() === 'libraries' && ready()) untrack(openInitialLibrary);
    }),
  );
  async function boot() {
    await refreshLibraries();
    const results = await Promise.allSettled([
      execute<StorageConfig[]>('storage.list'),
      execute<Record<string, unknown>>('system.info'),
    ]);
    if (results[0].status === 'fulfilled') setSources(results[0].value);
    else setError(errorMessage(results[0].reason));
    if (results[1].status === 'fulfilled') setSystem(results[1].value);
    setReady(true);
    if (section() === 'libraries') openInitialLibrary();
  }
  function listOptions(): AssetListOptions {
    return {
      library_id: libraryId(),
      query: query().trim() || undefined,
      rating: rating() || undefined,
      format: format(),
      flag: flag() === 'any' ? undefined : flag(),
      import_batch_id: batchId() || undefined,
      camera: camera() || undefined,
      lens: lens() || undefined,
      captured_from: capturedFrom() || undefined,
      captured_to: capturedTo() || undefined,
      folder: folder() || undefined,
      ...extra()?.options,
      sort_by: sort(),
      sort_direction: direction(),
    };
  }
  async function loadAssets(append = false, preserveLoaded = false) {
    const id = libraryId();
    if (!id) return;
    const token = ++request;
    const started = updateSequence;
    const options = listOptions();
    const wanted = preserveLoaded ? Math.max(200, assets().length) : 200;
    if (!preserveLoaded) setLoading(true);
    try {
      let result: AssetListResult = { items: [], total: 0 };
      const items: Asset[] = [];
      do {
        result = await execute<AssetListResult>('asset.list', {
          ...options,
          limit: Math.min(1000, wanted - items.length),
          offset: append ? assets().length : items.length,
        });
        if (token !== request || id !== libraryId() || disposed) return;
        items.push(...result.items);
      } while (
        preserveLoaded &&
        items.length < Math.min(wanted, result.total) &&
        result.items.length
      );
      if (token !== request || id !== libraryId()) return;
      const revised = items.map((item) => ({
        ...item,
        ...(recentUpdates.get(item.id)?.sequence! > started
          ? recentUpdates.get(item.id)?.asset
          : {}),
        variants: item.variants,
        preview_revision: revisions.get(item.id),
      }));
      const next = append ? [...assets(), ...revised] : revised;
      const scrollElement = collectionScroll;
      const scrollTop = scrollElement?.scrollTop;
      setAssets(next);
      setTotal(result.total);
      setFileTotal(result.file_total);
      dirtyLibraries.delete(id);
      if (!append && !preserveLoaded) clearPicked();
      else if (preserveLoaded && !selection.hasFullOrder()) {
        selection.pruneTo(new Set(next.map((item) => item.id)));
      }
      if (!selection.hasFullOrder() && !next.some((item) => item.id === selectedId()))
        setSelectedId(next[0]?.id);
      if (preserveLoaded && selection.hasFullOrder() && result.total < selectedIds().length) {
        void execute<AssetIdsResult>('asset.ids', { ...options })
          .then((fresh) => {
            if (token === request && id === libraryId() && fresh?.ids) {
              selection.pruneTo(new Set(fresh.ids));
            }
          })
          .catch(() => undefined);
      }
      if (preserveLoaded && scrollElement && scrollTop !== undefined)
        queueMicrotask(() => {
          if (token === request && scrollElement.isConnected) scrollElement.scrollTop = scrollTop;
        });
    } catch (e) {
      if (token === request && append) setAutoPagingFailed(true);
      if (token === request && !preserveLoaded) setError(errorMessage(e));
      if (preserveLoaded && token === request) throw e;
    } finally {
      if (token === request) setLoading(false);
    }
  }
  createEffect(() => {
    const active = section();
    libraryId();
    query();
    rating();
    format();
    flag();
    batchId();
    camera();
    lens();
    capturedFrom();
    capturedTo();
    folder();
    extra();
    sort();
    direction();
    const initialized = ready();
    if (active !== 'libraries' || !libraryId() || !initialized) return;
    setAutoPagingFailed(false);
    request++;
    setLoading(true);
    const timeout = setTimeout(() => void loadAssets(), 120);
    onCleanup(() => clearTimeout(timeout));
  });
  function closeNavigation() {
    const wasOpen = navigationOpen();
    setNavigationOpen(false);
    if (wasOpen && compactNavigation()) navigationButton?.focus();
  }
  function navigate(next: WorkspaceSection) {
    setSection(next);
    closeNavigation();
    setError('');
    setNotice('');
    setAllLibraries(false);
    if (next === 'libraries') openInitialLibrary();
  }
  function openInitialLibrary() {
    const list = visibleLibraries();
    if (libraryId() && list.some((library) => library.id === libraryId())) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_LIBRARY_KEY);
    } catch {
      /* No saved choice. */
    }
    const pick = pickInitialLibrary(list, last);
    if (pick) enterLibrary(pick);
    else {
      request++;
      setLibraryId(undefined);
      setAssets([]);
      setInfo(false);
      setLoading(false);
    }
  }
  function enterLibrary(library: Library) {
    closeNavigation();
    setAllLibraries(false);
    try {
      localStorage.setItem(LAST_LIBRARY_KEY, library.id);
    } catch {
      /* Only affects which library opens next time. */
    }
    request++;
    setAssets([]);
    setTotal(0);
    selection.reset(undefined);
    setQuery('');
    setRating(0);
    setFormat('all');
    setFlag('any');
    setBatchId('');
    setBatches([]);
    setFolder('');
    setExtra(undefined);
    setView('photos');
    clearMetadataFilters();
    setFacets(undefined);
    void loadFacets(library.id);
    setInfo(false);
    setLibraryId(library.id);
    if (desktop)
      void execute<ImportBatch[]>('import.batches', { library_id: library.id })
        .then((items) => libraryId() === library.id && setBatches(items))
        .catch(() => undefined);
    setSection('libraries');
    setError('');
    setNotice('');
  }
  function toggleFilters() {
    const next = !filtersOpen();
    setFiltersOpen(next);
    try {
      localStorage.setItem(FILTERS_OPEN_KEY, String(next));
    } catch {
      // The choice still applies for this session.
    }
  }
  const FLAG_LABELS: Record<string, string> = {
    pick: '留用',
    none: '未标记',
    reject: '淘汰',
    not_reject: '隐藏淘汰',
  };
  /** Active filters as removable chips, so a closed panel never hides what is applied. */
  const activeFilters = createMemo(() => {
    const chips: { label: string; clear: () => void }[] = [];
    if (rating())
      chips.push({ label: `${'★'.repeat(rating())} 及以上`, clear: () => setRating(0) });
    if (flag() !== 'any')
      chips.push({ label: FLAG_LABELS[flag()] || flag(), clear: () => setFlag('any') });
    if (format() !== 'all')
      chips.push({ label: format().toUpperCase(), clear: () => setFormat('all') });
    if (camera()) chips.push({ label: camera(), clear: () => setCamera('') });
    if (lens()) chips.push({ label: lens(), clear: () => setLens('') });
    if (capturedFrom() || capturedTo())
      chips.push({
        label: `${capturedFrom() || '…'} – ${capturedTo() || '…'}`,
        clear: () => {
          setCapturedFrom('');
          setCapturedTo('');
        },
      });
    if (batchId()) chips.push({ label: '本次导入', clear: () => setBatchId('') });
    const picked = extra();
    if (picked) chips.push({ label: picked.label, clear: () => setExtra(undefined) });
    return chips;
  });
  function clearAllFilters() {
    setRating(0);
    setFlag('any');
    setFormat('all');
    setBatchId('');
    setExtra(undefined);
    clearMetadataFilters();
  }
  function clearMetadataFilters() {
    setCamera('');
    setLens('');
    setCapturedFrom('');
    setCapturedTo('');
  }
  async function loadFacets(id: string) {
    try {
      const result = await execute<AssetFacets>('asset.facets', { library_id: id });
      if (libraryId() === id) setFacets(result);
    } catch {
      // Filters stay usable without suggestions; the date inputs still work.
    }
  }
  function newLibrary(source?: StorageConfig, prefix = '', root?: string) {
    setEditingLibrary(undefined);
    setLibrarySource(source);
    setLibraryPrefix(prefix);
    setLibraryRoot(root);
    setDialog('library');
  }
  /** A folder dropped on the window becomes a library; image files open in the viewer. */
  async function acceptDrop(paths: string[]) {
    if (!paths.length || dialog() || removing() || busy()) return;
    const dropped = await invoke<{ folders: string[]; images: string[]; ignored: number }>(
      'classify_dropped',
      { paths },
    );
    const folder = dropped.folders[0];
    if (folder) {
      const existing = libraries().find(
        (library) => !library.storage_id && library.root === folder && !library.hidden,
      );
      if (existing) enterLibrary(existing);
      else newLibrary(undefined, '', folder);
      if (dropped.folders.length > 1) setNotice(`一次只建立一个图片库，已使用 ${folder}。`);
      return;
    }
    if (dropped.images.length) {
      await action('正在打开影像…', async () => {
        const ids: string[] = [];
        for (const path of dropped.images.slice(0, 100))
          ids.push((await execute<Asset>('file.open', { path })).id);
        await openViewerWindow(ids[0], ids);
      });
      return;
    }
    setError('拖入的内容不是文件夹或支持的影像文件。');
  }
  function editLibrary(library: Library) {
    setEditingLibrary(library);
    setLibrarySource(undefined);
    setLibraryPrefix('');
    setDialog('library');
  }
  async function removeItem() {
    const target = removing();
    if (!target) return;
    await execute(target.kind === 'library' ? 'library.remove' : 'storage.remove', {
      id: target.item.id,
    });
    if (target.kind === 'library') {
      setLibraries((items) => items.filter((item) => item.id !== target.item.id));
      if (libraryId() === target.item.id) navigate('libraries');
    } else setSources((items) => items.filter((item) => item.id !== target.item.id));
    setNotice(`已移除 ${target.item.name}，原始文件保持不变。`);
  }
  function editSource(source?: StorageConfig) {
    setEditingSource(source);
    setDialog('storage');
  }
  /** Renders every selected photo with its crop to a chosen folder in the background. */
  async function exportSelection(ids = selectedIds()) {
    if (!ids.length || tasks.isRunning('export')) return;
    const directory = desktop ? await chooseDirectory('选择导出文件夹') : '';
    if (desktop && !directory) return;
    setError('');
    setNotice('');
    try {
      const result = await tasks.run(
        {
          kind: 'export',
          title: `导出 ${ids.length} 张照片`,
          processed: 0,
          total: ids.length,
        },
        ({ progress }) =>
          exportPhotos(
            ids,
            directory ?? '',
            new Map(assets().map((item) => [item.id, item])),
            (done, count) => progress({ processed: done, total: count, detail: `${done} / ${count}` }),
          ),
        (res) =>
          `已导出 ${res.exported} 张${res.failures.length ? `，${res.failures.length} 张失败` : ''}`,
      );
      const summary = exportSummary(result, directory ?? '', desktop);
      if (summary.error) setError(summary.error);
      else setNotice(summary.notice!);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  /** Moves the selected photos to the system Trash; the toast offers to put them back. */
  async function trashSelection(ids = selectedIds()) {
    if (!ids.length || busy()) return;
    const order = assets().map((item) => item.id);
    const position = Math.max(0, order.indexOf(ids[0]));
    feedback.clearMessages();
    feedback.history.dismiss();
    let result: TrashResult;
    setBusy(`正在移到废纸篓：${ids.length} 张…`);
    try {
      result = await trashPhotos(ids);
    } catch (e) {
      setError(errorMessage(e));
      return;
    } finally {
      setBusy('');
    }
    const summary = trashSummary(result);
    if (summary.error) setError(summary.error);
    if (result.trashed.length) {
      const gone = new Set(result.trashed);
      const remaining = assets().filter((item) => !gone.has(item.id));
      clearPicked();
      const next = remaining[Math.min(position, remaining.length - 1)];
      if (next) {
        setSelectedId(next.id);
        queueMicrotask(() => focusThumbnail(next.id));
      }
      feedback.history.forget(gone);
      const trashed = result.trashed;
      feedback.history.push({
        label: `已把 ${ids.length} 张照片移到废纸篓。`,
        toast: true,
        ids: trashed,
        revert: async () => {
          const restored = await restorePhotos(trashed);
          if (restored.failed.length)
            setError(`${restored.failed.length} 张未能放回：${restored.failed[0].message}`);
          else setNotice(`已放回 ${restored.restored.length} 个文件。`);
          await loadAssets(false, true);
          await refreshFolders();
        },
      });
      await loadAssets(false, true);
    }
  }
  function runPregenerate(library: Library) {
    if (tasks.isRunning('pregenerate', library.id)) return;
    void tasks
      .run(
        {
          kind: 'pregenerate',
          libraryId: library.id,
          title: `生成缩略图 · ${library.name}`,
        },
        () => pregeneratePreviews(library.id, gridTier(thumbSize(), devicePixelRatio())),
        () => '缩略图已就绪',
      )
      .catch(() => undefined);
  }
  async function scan(library: Library) {
    if (tasks.isRunning('scan', library.id)) return;
    setError('');
    try {
      const result = await tasks.run(
        {
          kind: 'scan',
          libraryId: library.id,
          title: `扫描 ${library.name}`,
        },
        () =>
          execute<ScanResult>('library.scan', {
            library_id: library.id,
          }).finally(() => void refreshLibraries()),
        (res) => `索引 ${res.indexed} 项，跳过 ${res.skipped} 项`,
      );
      if (library.id === libraryId()) await loadAssets();
      await refreshLibraries();
      // Render the grid's tier for new photos in the background; on-demand loading covers failures.
      runPregenerate(library);
      setNotice(
        `扫描完成：索引 ${result.indexed} 项，跳过 ${result.skipped} 项${result.moved ? `，识别 ${result.moved} 张移动或改名的照片并保留标记` : ''}${result.errors.length ? `，${result.errors.length} 项异常` : ''}。`,
      );
      if (result.errors.length)
        setError(
          result.errors
            .slice(0, 3)
            .map((item) => `${item.path}：${item.message}`)
            .join('\n'),
        );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function scanReboundLibrary(library: Library) {
    const token = ++request;
    setAssets([]);
    setTotal(0);
    setFileTotal(undefined);
    selection.reset(undefined);
    setInfo(false);
    mutateDetail({ asset: null, error: '' });
    setLoading(true);
    try {
      await scan(library);
    } finally {
      if (token === request && libraryId() === library.id) setLoading(false);
    }
  }
  function replaceAsset(asset: Asset, change?: AssetChange) {
    const previous =
      assets().find((item) => item.id === asset.id) ||
      (detail()?.asset?.id === asset.id ? detail()?.asset || undefined : undefined);
    change ||= changedAssetFields(previous, asset) || (!previous ? 'refresh' : undefined);
    if (change === 'crop' || change === 'refresh')
      revisions.set(asset.id, asset.preview_revision || Date.now());
    asset = { ...asset, preview_revision: revisions.get(asset.id) };
    const reconcileList = needsCatalogReconcile(listOptions(), change, previous, asset);
    recentUpdates.set(asset.id, { sequence: ++updateSequence, asset });
    setAssets((items) =>
      items.map((item) => (item.id === asset.id ? { ...asset, variants: item.variants } : item)),
    );
    if (asset.id === selectedId()) mutateDetail({ asset, error: '' });
    return reconcileList;
  }
  async function acceptAsset(asset: Asset, change?: AssetChange) {
    if (replaceAsset(asset, change) && libraryId()) dirtyLibraries.add(libraryId()!);
    // Keep a failed membership/order reconciliation pending even after the
    // asset fields themselves have already been patched successfully.
    if (libraryId() && dirtyLibraries.has(libraryId()!)) await loadAssets(false, true);
  }
  /**
   * Rates or flags the selection. The grid updates at once; the catalog write follows and a
   * failure restores the previous marks. Every mark is one undo step (Ctrl/⌘+Z) when all items
   * are loaded, and unloaded IDs from full-filter `⌘A` are written in 1,000-asset chunks.
   */
  async function markSelection(mark: { rating?: number; flag?: Flag }, fromKeyboard = false) {
    const ids = selectedIds();
    if (!ids.length) return;
    const byId = new Map(assets().map((item) => [item.id, item]));
    const unloadedIds = ids.filter((id) => !byId.has(id));
    const previous = ids
      .map((id) => byId.get(id))
      .filter((item): item is Asset => !!item)
      .map((item) => ({ id: item.id, rating: item.rating, flag: item.flag || 'none' }));
    const changes = previous.filter(
      (item) =>
        (mark.rating !== undefined && item.rating !== mark.rating) ||
        (mark.flag !== undefined && item.flag !== mark.flag),
    );
    const writeIds = [...changes.map((item) => item.id), ...unloadedIds];
    if (fromKeyboard) feedback.hud.show(markHudText(mark), mark.flag ? 'flag' : 'star');
    if (!writeIds.length) return;
    const patch = (marks: { id: string; rating?: number; flag?: Flag | string }[]) => {
      if (!marks.length) return;
      const values = new Map(marks.map((item) => [item.id, item]));
      setAssets((items) =>
        items.map((item) => {
          const next = values.get(item.id);
          if (!next) return item;
          return {
            ...item,
            ...(next.rating !== undefined ? { rating: next.rating } : {}),
            ...(next.flag !== undefined ? { flag: next.flag as Flag } : {}),
          };
        }),
      );
      const current = detail()?.asset;
      const own = current && values.get(current.id);
      if (current && own)
        mutateDetail({
          asset: {
            ...current,
            ...(own.rating !== undefined ? { rating: own.rating } : {}),
            ...(own.flag !== undefined ? { flag: own.flag as Flag } : {}),
          },
          error: '',
        });
    };
    const write = async (groups: { ids: string[]; rating?: number; flag?: string }[]) => {
      let batched = false;
      for (const group of groups) {
        if (group.ids.length === 1 && (group.rating === undefined) !== (group.flag === undefined)) {
          const id = group.ids[0];
          await acceptAsset(
            group.flag !== undefined
              ? await execute<Asset>('asset.flag', { id, flag: group.flag })
              : await execute<Asset>('asset.rate', { id, rating: group.rating }),
            group.flag !== undefined ? 'flag' : 'rating',
          );
        } else {
          for (const chunk of chunkIds(group.ids))
            await execute('asset.mark_batch', {
              ids: chunk,
              ...(group.rating !== undefined ? { rating: group.rating } : {}),
              ...(group.flag !== undefined ? { flag: group.flag } : {}),
            });
          batched = true;
          if (libraryId()) dirtyLibraries.add(libraryId()!);
        }
      }
      // Single writes reconcile through acceptAsset; batches re-read the loaded range.
      if (batched) await loadAssets(false, true);
    };
    patch(changes.map((item) => ({ id: item.id, ...mark })));
    // Undo is available at once when previous marks are known; reverting waits for this write.
    const forward = write([{ ids: writeIds, ...mark }]);
    const entry: UndoEntry | undefined =
      unloadedIds.length === 0
        ? {
            label: ids.length > 1 ? `标记 ${changes.length} 张照片` : markHudText(mark),
            ids: changes.map((item) => item.id),
            revert: async () => {
              await forward;
              patch(changes);
              try {
                await write(groupMarks(changes));
              } catch (e) {
                patch(changes.map((item) => ({ id: item.id, ...mark })));
                throw e;
              }
            },
          }
        : undefined;
    if (entry) feedback.history.push(entry);
    try {
      await forward;
    } catch (e) {
      if (entry) feedback.history.remove(entry);
      patch(changes);
      setError(`标记未保存：${errorMessage(e)}`);
      return;
    }
    if (ids.length > 1) setNotice(`已标记 ${ids.length} 张照片。`);
  }
  async function rate(value: number) {
    const target = selected();
    if (!target) return;
    try {
      await acceptAsset(await execute<Asset>('asset.rate', { id: target.id, rating: value }), 'rating');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function resetCrop() {
    if (!selected()) return;
    const id = selected()!.id;
    await action('重置裁剪…', async () =>
      acceptAsset(await execute<Asset>('asset.reset_crop', { id }), 'crop'),
    );
  }
  async function refreshOriginal() {
    const id = selected()?.id;
    if (!id || !desktop || busy()) return;
    await action('正在重新读取原图…', async () => {
      await acceptAsset(
        {
          ...(await execute<Asset>('asset.refresh', { id })),
          preview_revision: Date.now(),
        },
        'refresh',
      );
      setNotice('已重新读取原图，评级与裁剪配方已保留。');
    });
  }
  function tileImage(id: string) {
    return collectionScroll?.querySelector<HTMLImageElement>(
      `[data-asset-id="${CSS.escape(id)}"] img:not([style*="hidden"])`,
    );
  }
  /** Opens a photo inside this window, growing it out of its tile. */
  function openAsset(asset: Pick<Asset, 'id'>, ids = assets().map((item) => item.id)) {
    const image = tileImage(asset.id);
    viewerCurrent = asset.id;
    setOverlay({ id: asset.id, ids });
    if (image)
      fly(image, image.getBoundingClientRect(), () => {
        const stage = document
          .querySelector('.viewer-overlay .photo-stage')
          ?.getBoundingClientRect();
        return stage && fitRect(stage, image.naturalWidth / Math.max(1, image.naturalHeight));
      });
  }
  /** A separate viewer window, for a second screen or side-by-side work. */
  async function openAssetWindow(asset: Pick<Asset, 'id'>, ids = assets().map((item) => item.id)) {
    if (!desktop) return openAsset(asset, ids);
    await action('正在打开查看窗口…', async () => {
      await openViewerWindow(asset.id, ids);
    });
  }
  function closeOverlay() {
    const id = viewerCurrent;
    const photo = document.querySelector<HTMLImageElement>('.viewer-overlay .main-photo');
    const from = photo?.getBoundingClientRect();
    setOverlay(undefined);
    document.title = 'Nebulume — 影像管理';
    if (!id) return;
    // Come back to the photo the viewer ended on. The viewer hands focus back to
    // the tile it opened from as it unmounts, so move selection and focus after it.
    queueMicrotask(() => {
      if (!assets().some((item) => item.id === id)) return;
      setSelectedId(id);
      focusThumbnail(id);
    });
    if (photo && from) fly(photo, from, () => tileImage(id)?.getBoundingClientRect());
  }
  /** Import → selection: filter the library to the new batch, then open culling. */
  async function cullBatch(library: Library, batch: ImportBatch) {
    enterLibrary(library);
    setBatches((items) => [batch, ...items.filter((item) => item.id !== batch.id)]);
    setBatchId(batch.id);
    const options = { ...listOptions(), import_batch_id: batch.id, library_id: library.id };
    try {
      const first = await execute<AssetListResult>('asset.list', { ...options, limit: 1 });
      const start = first.items[0];
      if (!start) return;
      const queue = { library_id: library.id, options };
      if (desktop) await openViewerWindow(start.id, [start.id], { mode: 'cull', queue });
      else setOverlay({ id: start.id, ids: [start.id], mode: 'cull', queue });
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function startCulling() {
    const start = selected() || assets()[0];
    const id = libraryId();
    if (!start || !id) return;
    // The viewer snapshots the whole filtered result, not just the loaded page.
    const queue = { library_id: id, options: { ...listOptions(), library_id: id } };
    const loaded = assets().map((item) => item.id);
    viewerCurrent = start.id;
    setOverlay({ id: start.id, ids: loaded, mode: 'cull', queue });
  }
  async function openFile() {
    if (!desktop) {
      openAfterImport = true;
      fileInput.click();
      return;
    }
    await action('正在打开影像…', async () => {
      const path = await chooseImage();
      if (!path) return;
      const asset = await execute<Asset>('file.open', { path });
      await openViewerWindow(asset.id, [asset.id], { fromFile: true });
    });
  }
  async function importBrowser(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const shouldOpen = openAfterImport;
    openAfterImport = false;
    await action('读取所选图片…', async () => {
      const result = await addBrowserFiles(files);
      const libs = await execute<Library[]>('library.list');
      setLibraries(libs);
      const library = libs[0];
      if (library) enterLibrary(library);
      const listing = await execute<{ items: Asset[]; total: number }>('asset.list', {
        library_id: library?.id,
        limit: 200,
      });
      setAssets(listing.items);
      setTotal(listing.total);
      const asset = result.added_ids[0]
        ? await execute<Asset>('asset.get', { id: result.added_ids[0] })
        : undefined;
      setSelectedId(asset?.id || listing.items[0]?.id);
      setNotice(`已载入 ${result.added} 张图片；本次浏览器会话关闭后清除。`);
      if (result.errors.length) setError(result.errors.join('\n'));
      if (shouldOpen && asset)
        setOverlay({ id: asset.id, ids: listing.items.map((item) => item.id) });
    });
    input.value = '';
  }
  function keyboard(event: KeyboardEvent) {
    if (navigationOpen() && event.key === 'Escape') {
      event.preventDefault();
      closeNavigation();
      return;
    }
    if (navigationOpen() && compactNavigation() && event.key === 'Tab') {
      // Only buttons that are actually shown: the rail's open-file item is hidden in the drawer.
      const buttons = Array.from(
        navigationElement?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
      ).filter((button) => button.offsetParent !== null);
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!navigationElement?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (dialog() || removing() || overlay() || isTextEntry(event.target) || event.defaultPrevented)
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && libraryId()) {
      event.preventDefault();
      searchInput?.focus();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'b' &&
      section() === 'libraries'
    ) {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'a' &&
      section() === 'libraries' &&
      libraryId() &&
      assets().length
    ) {
      event.preventDefault();
      const targetLib = libraryId();
      const opts = listOptions();
      // Optimistically select loaded items at once, then upgrade to full-filter `asset.ids`.
      selection.selectAll(assets().map((asset) => asset.id));
      void execute<AssetIdsResult>('asset.ids', { ...opts })
        .then((res) => {
          if (libraryId() === targetLib && res?.ids?.length) {
            selection.selectAll(res.ids);
            feedback.hud.show(`已全选 ${res.ids.length.toLocaleString()} 张`, 'checks');
          }
        })
        .catch(() => undefined);
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      ['1', '2', '3'].includes(event.key) &&
      section() === 'libraries' &&
      libraryId()
    ) {
      event.preventDefault();
      if (event.key === '1') setView('photos');
      else if (event.key === '2') void startCulling();
      else setView('overview');
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'z' &&
      section() === 'libraries'
    ) {
      event.preventDefault();
      if (!busy()) void feedback.undo(undefined, { busy: '正在撤销…' });
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      (event.key === 'Backspace' || event.key === 'Delete') &&
      section() === 'libraries' &&
      view() === 'photos' &&
      selectedIds().length
    ) {
      event.preventDefault();
      void trashSelection();
      return;
    }
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      section() !== 'libraries' ||
      !libraryId() ||
      view() === 'overview'
    )
      return;
    const index = assets().findIndex((asset) => asset.id === selectedId());
    const step = gridStep(event.key, index);
    if (step !== undefined) {
      event.preventDefault();
      const next = assets()[step];
      if (next && next.id !== selectedId()) {
        selectAsset(next.id, event.shiftKey ? { shiftKey: true } : undefined);
        focusThumbnail(next.id);
      }
    } else if (
      (event.key === 'Enter' || event.key === ' ') &&
      !event.repeat &&
      selected() &&
      !(event.target as HTMLElement).closest('button, select, a')
    ) {
      event.preventDefault();
      void openAsset(selected()!);
    }
    else if (event.key.toLowerCase() === 'i') setInfo((value) => !value);
    else if (/^[0-5]$/.test(event.key)) void markSelection({ rating: Number(event.key) }, true);
    else if (event.key.toLowerCase() === 'p' && !event.shiftKey)
      void markSelection({ flag: 'pick' }, true);
    else if (event.key.toLowerCase() === 'x') void markSelection({ flag: 'reject' }, true);
    else if (event.key.toLowerCase() === 'u') void markSelection({ flag: 'none' }, true);
    else if (event.key === 'Escape') {
      if (picked().size) clearPicked();
      else setInfo(false);
    } else if (event.shiftKey && event.key.toLowerCase() === 'c' && assets().length) {
      event.preventDefault();
      void startCulling();
    }
  }
  function openAssetMenu(asset: Asset, point: { x: number; y: number }) {
    // Right-clicking outside the selection acts on that photo alone, like file managers.
    if (!selectedIds().includes(asset.id)) selectAsset(asset.id);
    else setSelectedId(asset.id);
    const count = selectedIds().length;
    const subject = count > 1 ? `所选 ${count} 张照片` : asset.filename;
    const rateItems = [5, 4, 3, 2, 1, 0].map((value) => ({
      label: value ? `评为 ${'★'.repeat(value)}` : '清除评级',
      ariaLabel: value ? `将${subject}评为 ${value} 星` : `清除${subject}的评级`,
      onSelect: () => void markSelection({ rating: value }),
    }));
    setContextMenu({
      x: point.x,
      y: point.y,
      label: `${subject} 操作`,
      returnFocus: document.activeElement as HTMLElement | null,
      items: [
        {
          label: count > 1 ? '在查看器中打开（所选照片）' : '在查看器中打开',
          onSelect: () =>
            void openAsset(asset, count > 1 ? selectedIds() : assets().map((item) => item.id)),
        },
        ...(desktop
          ? [
              {
                label: '在新窗口中打开',
                onSelect: () =>
                  void openAssetWindow(
                    asset,
                    count > 1 ? selectedIds() : assets().map((item) => item.id),
                  ),
              },
            ]
          : []),
        {
          label: '从此照片开始选图',
          onSelect: () => void startCulling(),
        },
        'separator',
        ...rateItems,
        'separator',
        { label: '留用', onSelect: () => void markSelection({ flag: 'pick' }) },
        {
          label: '淘汰',
          onSelect: () => void markSelection({ flag: 'reject' }),
        },
        {
          label: '清除旗标',
          onSelect: () => void markSelection({ flag: 'none' }),
        },
        'separator',
        {
          label: '显示详情',
          onSelect: () => setInfo(true),
        },
        {
          label: count > 1 ? `导出所选 ${count} 张为 JPEG…` : '导出为 JPEG…',
          disabled: tasks.isRunning('export'),
          onSelect: () => void exportSelection(),
        },
        ...(currentLibrary()?.source_kind === 'local'
          ? [
              {
                label: count > 1 ? `将所选 ${count} 张移到废纸篓` : '移到废纸篓',
                disabled: !!busy(),
                onSelect: () => void trashSelection(),
              },
            ]
          : []),
        {
          label: '复制文件路径',
          disabled: count > 1 || !asset.path,
          onSelect: () =>
            void navigator.clipboard
              .writeText(asset.path)
              .then(() => setNotice('已复制文件路径。'))
              .catch(() => setError('无法写入剪贴板。')),
        },
        ...(desktop
          ? [
              {
                label: '重新读取原图',
                disabled: count > 1 || !!busy(),
                onSelect: () => void refreshOriginal(),
              },
            ]
          : []),
      ],
    });
  }
  /** What a tile shows: the oriented, cropped frame, grouped by day when sorted by a date. */
  function tileShape(asset: Asset) {
    const crop = asset.crop;
    const ratio =
      asset.width && asset.height
        ? (asset.width * (crop?.width ?? 1)) / (asset.height * (crop?.height ?? 1))
        : 1.5;
    const field = sort();
    const stamp =
      field === 'captured_at'
        ? asset.captured_at
        : field === 'created_at'
          ? asset.created_at
          : field === 'modified_at'
            ? asset.modified_at
            : undefined;
    return {
      ratio,
      group:
        field === 'filename' || field === 'rating' ? undefined : stamp?.slice(0, 10) || 'undated',
    };
  }
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function daySection(key: string, items: Asset[]) {
    const count = `${items.length} 张`;
    if (key === 'undated') return { label: '没有拍摄时间', detail: count };
    const day = new Date(`${key}T00:00:00`);
    if (Number.isNaN(day.getTime())) return undefined;
    const year = day.getFullYear() === new Date().getFullYear() ? '' : `${day.getFullYear()}年`;
    return {
      label: `${year}${day.getMonth() + 1}月${day.getDate()}日 ${WEEKDAYS[day.getDay()]}`,
      detail: count,
    };
  }
  /** Columns in the rendered grid, read from layout so it follows the size slider. */
  function gridColumns() {
    return photoGrid?.columns() ?? 1;
  }
  function gridStep(key: string, index: number): number | undefined {
    if (!assets().length) return undefined;
    return photoGrid?.step(index, key);
  }
  function focusThumbnail(id: string) {
    // Move DOM focus only when the grid already owns it (or lost it because the
    // focused cell scrolled out and unmounted), so toolbar shortcuts keep focus.
    const owned =
      collectionScroll?.contains(document.activeElement) ||
      document.activeElement === document.body;
    photoGrid?.scrollToIndex(assets().findIndex((asset) => asset.id === id));
    // The target row may only mount after the scroll is measured.
    requestAnimationFrame(() => {
      const element = collectionScroll?.querySelector<HTMLElement>(
        `[data-asset-id="${CSS.escape(id)}"]`,
      );
      if (element && owned) element.focus({ preventScroll: true });
    });
  }
  function queueAssetUpdate(update: AssetUpdated) {
    if (!update.id) return;
    pendingUpdates.set(update.id, mergePendingUpdate(pendingUpdates.get(update.id), update));
    void drainAssetUpdates();
  }
  async function drainAssetUpdates() {
    if (drainingUpdates || disposed) return;
    drainingUpdates = true;
    try {
      while (pendingUpdates.size && !disposed) {
        const [id, update] = pendingUpdates.entries().next().value!;
        pendingUpdates.delete(id);
        try {
          const asset =
            update.asset?.id === id ? update.asset : await execute<Asset>('asset.get', { id });
          if (disposed) return;
          await acceptAsset(
            {
              ...asset,
              preview_revision: update.revision ?? asset.preview_revision ?? revisions.get(id),
            },
            update.change,
          );
          setSyncError('');
        } catch (e) {
          if (!pendingUpdates.has(id)) pendingUpdates.set(id, update);
          setSyncError(`影像变更尚未同步：${errorMessage(e)}`);
          break;
        }
      }
    } finally {
      drainingUpdates = false;
    }
  }
  // Local library folders are watched; the backend scans after changes settle and
  // reports here, so the open grid refreshes in place without a manual scan.
  async function refreshFolders() {
    const id = libraryId();
    if (!id) return setFolders(undefined);
    await execute<LibraryFolders>('library.folders', { library_id: id })
      .then((tree) => libraryId() === id && setFolders(tree))
      .catch(() => setFolders(undefined));
  }
  createEffect(on([libraryId, libraries], () => void refreshFolders()));
  createEffect(() => {
    if (!cullWhenLoaded() || loading() || !assets().length) return;
    setCullWhenLoaded(false);
    void untrack(startCulling);
  });
  /** Scanning needs the location reachable; an access error may clear on retry. */
  function scanBlocked(library: Library) {
    return desktop && !availabilityPresentation(library).usable && library.availability !== 'error';
  }
  function scanReason(library: Library) {
    return `无法扫描：${availabilityPresentation(library).detail}`;
  }
  function libraryMenu(library: Library): MenuEntry[] {
    const blocked = scanBlocked(library);
    const reason = blocked ? scanReason(library) : undefined;
    const scanningThis = tasks.isRunning('scan', library.id);
    const open = (then: () => void) => () => {
      if (libraryId() !== library.id) enterLibrary(library);
      then();
    };
    return [
      {
        label: '图片库设置…',
        ariaLabel: `${library.name} 图片库设置`,
        icon: 'settings',
        disabled: scanningThis || !!busy(),
        onSelect: () => editLibrary(library),
      },
      ...(desktop
        ? ([
            {
              label: '扫描更新',
              icon: 'refresh',
              disabled: scanningThis || blocked,
              title: reason,
              onSelect: () => void scan(library),
            },
            {
              label: '预生成缩略图',
              icon: 'photo',
              disabled: tasks.isRunning('pregenerate', library.id) || blocked,
              title: reason,
              onSelect: () => {
                runPregenerate(library);
                setNotice(`正在后台为 ${library.name} 生成缩略图。`);
              },
            },
            {
              label: '补全拍摄时间…',
              icon: 'clock',
              onSelect: open(() => setSort('captured_at')),
            },
            {
              label: '内容指纹…',
              icon: 'shield-check',
              disabled: scanningThis || !!busy(),
              onSelect: () => editLibrary(library),
            },
          ] as MenuEntry[])
        : []),
      'separator',
      {
        label: '移除图片库…',
        ariaLabel: `移除图片库 ${library.name}`,
        icon: 'trash',
        danger: true,
        disabled: scanningThis || !!busy(),
        onSelect: () => setRemoving({ kind: 'library', item: library }),
      },
    ];
  }
  async function folderAction(kind: FolderAction, path: string) {
    const library = currentLibrary();
    if (!library) return;
    setFolder(path);
    if (kind === 'cull') return setCullWhenLoaded(true);
    if (kind === 'scan') return void scan(library);
    if (kind === 'overview') return setView('overview');
    // Every pick in the folder via `asset.ids` in one lightweight call.
    const matched = await execute<AssetIdsResult>('asset.ids', {
      library_id: library.id,
      folder: path,
      flag: 'pick',
    }).catch((e) => {
      setError(errorMessage(e));
      return undefined;
    });
    if (!matched?.ids) return;
    if (!matched.ids.length) return setNotice('这个文件夹里还没有留用的照片。');
    await exportSelection(matched.ids);
  }
  const watchKey = createMemo(() =>
    libraries()
      .filter((library) => library.source_kind === 'local' && library.availability === 'online')
      .map((library) => `${library.id}:${library.root}`)
      .sort()
      .join('|'),
  );
  createEffect(
    on(watchKey, (key, previous) => {
      // Nothing to watch and nothing watched before: no native call.
      if (desktop && (key || previous)) void watchLibraries().catch(() => undefined);
    }),
  );
  let stopLibraryWatch: (() => void) | undefined;
  async function registerLibraryWatch() {
    if (!desktop) return;
    const stop = await listen<{ library_id: string }>('library-changed', (event) => {
      void refreshLibraries();
      if (event.payload.library_id === libraryId() && !loading()) void loadAssets(false, true);
    }).catch(() => undefined);
    if (!stop) return;
    if (disposed) stop();
    else stopLibraryWatch = stop;
  }
  async function registerAssetListener() {
    if (!desktop || disposed || unlisten || registeringListener) return;
    registeringListener = true;
    try {
      const stop = await listen<AssetUpdated>('asset-updated', (event) =>
        queueAssetUpdate(event.payload),
      );
      if (disposed) stop();
      else {
        unlisten = stop;
        setSyncError('');
      }
    } catch (e) {
      setSyncError(
        `无法监听查看器变更：${errorMessage(e)}。可重试连接；此时请手动扫描确认外部变更。`,
      );
    } finally {
      registeringListener = false;
    }
  }
  function focusRefresh() {
    // Focus itself is not a catalog mutation. Only retry a known failed event
    // or listener; never re-read unchanged assets, detail or image resources.
    void registerAssetListener();
    void drainAssetUpdates();
  }
  onMount(() => {
    void updates.start();
    void registerLibraryWatch();
    if (desktop) {
      let stopDrop: (() => void) | undefined;
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'enter' || payload.type === 'over') setDropActive(true);
          else if (payload.type === 'leave') setDropActive(false);
          else {
            setDropActive(false);
            void acceptDrop(payload.paths).catch((e) => setError(errorMessage(e)));
          }
        })
        .then((stop) => {
          if (disposed) stop();
          else stopDrop = stop;
        })
        .catch(() => undefined);
      onCleanup(() => stopDrop?.());
    }
    const navigationMedia = window.matchMedia('(max-width: 959px)');
    const updateNavigationMode = () => {
      setCompactNavigation(navigationMedia.matches);
      if (!navigationMedia.matches) setNavigationOpen(false);
    };
    updateNavigationMode();
    navigationMedia.addEventListener('change', updateNavigationMode);
    const stopWatchingRatio = watchDevicePixelRatio(setDevicePixelRatio);
    void boot();
    window.addEventListener('keydown', keyboard);
    window.addEventListener('focus', focusRefresh);
    void registerAssetListener();
    onCleanup(() => {
      disposed = true;
      unlisten?.();
      stopLibraryWatch?.();
      window.removeEventListener('keydown', keyboard);
      window.removeEventListener('focus', focusRefresh);
      navigationMedia.removeEventListener('change', updateNavigationMode);
      stopWatchingRatio();
    });
  });
  return (
    <AppShell
      section={section()}
      current={section()}
      onSection={(next) => navigate(next)}
      onOpenFile={() => void openFile()}
      openFileDisabled={!!busy()}
      drawerOpen={navigationOpen()}
      onToggleDrawer={() => {
        const opening = !navigationOpen();
        setNavigationOpen(opening);
        if (opening)
          requestAnimationFrame(() => {
            // Wait until the drawer is visible before moving keyboard focus.
            if (navigationOpen() && document.activeElement === navigationButton)
              navigationElement
                ?.querySelector<HTMLButtonElement>('button')
                ?.focus({ preventScroll: true });
          });
      }}
      onCloseDrawer={() => closeNavigation()}
      drawerButtonRef={(el) => (navigationButton = el)}
      railRef={(el) => (navigationElement = el)}
      sidebar={
        section() === 'libraries' && !sidebarCollapsed() ? (
          <LibrarySidebar
            libraries={visibleLibraries()}
            currentId={section() === 'libraries' && !allLibraries() ? libraryId() : undefined}
            overviewOpen={allLibraries()}
            onOverview={() => {
              closeNavigation();
              setAllLibraries(true);
            }}
            folder={folder()}
            folders={folders()}
            usable={(library) => availabilityPresentation(library).usable}
            unavailableLabel={(library) => availabilityPresentation(library).label}
            location={libraryLocation}
            demoLabel={!desktop}
            onLibrary={(library) => enterLibrary(library)}
            onFolder={(path) => {
              closeNavigation();
              setFolder(path);
            }}
            onFolderAction={(kind, path) => void folderAction(kind, path)}
            onAddLibrary={() => newLibrary()}
            onCollapse={toggleSidebar}
            libraryMenu={libraryMenu}
          />
        ) : undefined
      }
    >
      <input
        ref={fileInput}
        class="visually-hidden"
        type="file"
        accept="image/*,.dng,.cr2,.nef,.arw,.raf,.orf,.rw2"
        multiple
        aria-label="选择浏览器演示图片"
        onChange={importBrowser}
      />

      <Show when={dropActive()}>
        <div class="drop-overlay" aria-hidden="true">
          <div class="drop-overlay-card">
            <Icon name="folder" size={28} />
            <strong>松开以添加</strong>
            <span>文件夹建立图片库，影像文件直接打开</span>
          </div>
        </div>
      </Show>
      <Show when={contextMenu()}>
        {(menu) => <ContextMenu menu={menu()} onClose={() => setContextMenu(undefined)} />}
      </Show>
      <main
        class={`manager-workspace${selectedIds().length > 1 ? ' has-batch-dock' : ''}`}
        aria-label="影像管理工作区"
      >
        <UpdatePrompt />
        <Show when={section() === 'libraries' && allLibraries()}>
          <LibrariesOverview
            libraries={visibleLibraries()}
            desktop={desktop}
            leading={
              sidebarCollapsed() ? (
                <IconButton
                  size="sm"
                  icon="layout-sidebar-right"
                  label="展开图片库侧栏（⌘B）"
                  shortcut="Meta+B Control+B"
                  onClick={toggleSidebar}
                />
              ) : undefined
            }
            extraActions={<TaskPill tasks={tasks} />}
            onOpen={(library) => enterLibrary(library)}
            onCreate={() => {
              if (desktop) newLibrary();
              else {
                openAfterImport = false;
                fileInput.click();
              }
            }}
            libraryMenu={libraryMenu}
          />
        </Show>
        <Show when={section() === 'libraries' && !allLibraries()}>
          <Show
            when={currentLibrary()}
            fallback={
              <Show when={ready() && !visibleLibraries().length}>
                <section class="library-empty" aria-label="图片库管理">
                  <EmptyState
                    icon="photo-plus"
                    title="还没有图片库"
                    description={
                      desktop
                        ? '选一个照片文件夹建立图片库，或从存储卡导入。照片留在原处。'
                        : '选择几张本地照片，体验浏览、选片与导出。'
                    }
                    actions={
                      <>
                        <Button
                          variant="primary"
                          icon={desktop ? 'folder-plus' : 'photo-plus'}
                          onClick={() => {
                            if (desktop) newLibrary();
                            else {
                              openAfterImport = false;
                              fileInput.click();
                            }
                          }}
                        >
                          {desktop ? '新建图片库' : '选择照片'}
                        </Button>
                        <Show when={desktop}>
                          <Button icon="card" onClick={() => navigate('cards')}>
                            从存储卡导入
                          </Button>
                        </Show>
                      </>
                    }
                  />
                </section>
              </Show>
            }
          >
            {(library) => (
              <section class="library-collection" aria-label={`${library().name} 照片`}>
                <PageHeader
                  leading={
                    sidebarCollapsed() ? (
                      <IconButton
                        size="sm"
                        icon="layout-sidebar-right"
                        label="展开图片库侧栏（⌘B）"
                        shortcut="Meta+B Control+B"
                        onClick={toggleSidebar}
                      />
                    ) : undefined
                  }
                  title={library().name}
                  subtitle={
                    folder()
                      ? folder().replaceAll('/', ' / ')
                      : library().asset_count !== undefined
                        ? `${library().asset_count!.toLocaleString()} 张`
                        : undefined
                  }
                  center={(narrow) => (
                    <Segmented
                      label="视图"
                      compact={narrow}
                      value={view()}
                      onChange={(next) => (next === 'cull' ? void startCulling() : setView(next))}
                      options={[
                        { value: 'photos', label: '照片', icon: 'grid', shortcut: 'Meta+1' },
                        {
                          value: 'cull',
                          label: '选片',
                          icon: 'flag',
                          shortcut: 'Meta+2',
                          action: true,
                          disabled: !assets().length,
                        },
                        { value: 'overview', label: '概览', icon: 'chart-bar', shortcut: 'Meta+3' },
                      ]}
                    />
                  )}
                  actions={
                    <>
                      <TaskPill tasks={tasks} />
                      <Button
                        icon={desktop ? 'refresh' : 'plus'}
                        disabled={tasks.isRunning('scan', library().id) || scanBlocked(library())}
                        title={scanBlocked(library()) ? scanReason(library()) : undefined}
                        onClick={() => (desktop ? scan(library()) : fileInput.click())}
                      >
                        {desktop ? '扫描更新' : '载入图片'}
                      </Button>
                      <OverflowMenu label="更多" items={libraryMenu(library())} />
                    </>
                  }
                />
                <Show when={!availabilityPresentation(library()).usable}>
                  <div class="library-banner">
                    <Banner
                      class="availability-banner"
                      tone="warn"
                      message={availabilityPresentation(library()).label}
                      detail={availabilityPresentation(library()).detail}
                      action={
                        <>
                          <Show when={availabilityPresentation(library()).action}>
                            {(fix) => (
                              <Button size="sm" onClick={() => navigate(fix().section)}>
                                {fix().label}
                              </Button>
                            )}
                          </Show>
                          <Show when={desktop}>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void refreshLibraries()}
                            >
                              重试
                            </Button>
                          </Show>
                        </>
                      }
                    />
                  </div>
                </Show>
                <Toolbar label="照片工具栏" class="library-toolbar">
                  <TextInput
                    ref={(el) => (searchInput = el)}
                    size="sm"
                    icon="search"
                    wrapClass="library-search"
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                    placeholder="搜索文件名或元数据…"
                    aria-label="搜索照片"
                    maxLength={256}
                  />
                  <Show when={query()}>
                    <IconButton
                      size="xs"
                      icon="close"
                      label="清除搜索"
                      onClick={() => setQuery('')}
                    />
                  </Show>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="filter"
                    class="filter-toggle"
                    aria-expanded={filtersOpen()}
                    aria-controls="collection-filters"
                    onClick={() => toggleFilters()}
                  >
                    筛选
                    <Show when={activeFilters().length}>
                      <span class="library-filter-count">{activeFilters().length}</span>
                    </Show>
                  </Button>
                  <span class="library-chips" role="group" aria-label="当前筛选">
                    <For each={activeFilters()}>
                      {(chip) => <Chip label={chip.label} onRemove={chip.clear} />}
                    </For>
                  </span>
                  <Spacer />
                  <span
                    class="collection-status library-count"
                    aria-live="polite"
                    data-loaded={loading() ? undefined : assets().length}
                    title={
                      loading()
                        ? undefined
                        : `已载入 ${assets().length} / ${total()} 项${fileTotal() !== undefined && fileTotal() !== total() ? ` · ${fileTotal()} 个匹配文件` : ''}`
                    }
                  >
                    {loading()
                      ? '正在读取索引…'
                      : `${total().toLocaleString()} 张${fileTotal() !== undefined && fileTotal() !== total() ? ` · ${fileTotal()!.toLocaleString()} 文件` : ''}`}
                  </span>
                  <Toggle
                    pressed={flag() === 'not_reject' || flag() === 'pick' || flag() === 'none'}
                    disabled={flag() === 'pick' || flag() === 'none'}
                    title={
                      flag() === 'pick' || flag() === 'none'
                        ? '当前旗标筛选已排除淘汰照片'
                        : '隐藏已标记为淘汰的照片'
                    }
                    onChange={(on) => setFlag(on ? 'not_reject' : 'any')}
                    icon="eye-off"
                  >
                    隐藏淘汰
                  </Toggle>
                  <Select
                    size="sm"
                    aria-label="排序字段"
                    value={sort()}
                    title={
                      sort() === 'captured_at'
                        ? '按相机当地记录的拍摄时间排序；待索引或无有效时间的照片置后。'
                        : sort() === 'created_at'
                          ? '源文件创建时间；未提供时间的照片置后。旧远端库可扫描更新以补充。'
                          : undefined
                    }
                    onChange={(value) => setSort(value as NonNullable<AssetListOptions['sort_by']>)}
                    options={[
                      { value: 'captured_at', label: '拍摄时间' },
                      { value: 'created_at', label: '文件创建时间' },
                      { value: 'modified_at', label: '文件修改时间' },
                      { value: 'filename', label: '文件名' },
                      { value: 'rating', label: '评级' },
                    ]}
                  />
                  <IconButton
                    size="sm"
                    icon={direction() === 'desc' ? 'sort-desc' : 'sort-asc'}
                    label={
                      direction() === 'desc'
                        ? '排序方向：降序，切换为升序'
                        : '排序方向：升序，切换为降序'
                    }
                    onClick={() => setDirection(direction() === 'desc' ? 'asc' : 'desc')}
                  />
                  <Show when={desktop && sort() === 'captured_at'}>
                    <CaptureIndexControl
                      libraryId={library().id}
                      onSettled={async (status) => {
                        const job = status.job;
                        if (!job || completedCaptureJobs.has(job.id)) return;
                        completedCaptureJobs.add(job.id);
                        if (libraryId() === status.library_id) {
                          await loadAssets(false, true);
                          if (info()) await refetchDetail();
                        } else dirtyLibraries.add(status.library_id);
                      }}
                    />
                  </Show>
                  <Slider
                    label="缩略图大小"
                    min={150}
                    max={320}
                    step={10}
                    value={thumbSize()}
                    onInput={(value) => {
                      setThumbSize(value);
                      saveThumbSize(value);
                    }}
                  />
                  <IconButton
                    size="sm"
                    icon="info"
                    label="影像详情（I）"
                    shortcut="I"
                    pressed={info()}
                    disabled={!selected()}
                    onClick={() => setInfo((value) => !value)}
                  />
                </Toolbar>
                <Show when={filtersOpen()}>
                  <div
                    class="filter-panel library-filters"
                    id="collection-filters"
                    role="group"
                    aria-label="筛选条件"
                  >
                    <Select
                      size="sm"
                      aria-label="最低评级筛选"
                      value={String(rating())}
                      onChange={(value) => setRating(Number(value))}
                      options={[
                        { value: '0', label: '所有评级' },
                        ...[1, 2, 3, 4, 5].map((value) => ({
                          value: String(value),
                          label: `${'★'.repeat(value)}${value < 5 ? ' 及以上' : ''}`,
                        })),
                      ]}
                    />
                    <Select
                      size="sm"
                      aria-label="旗标筛选"
                      value={flag()}
                      onChange={(value) => setFlag(value as FlagFilter)}
                      options={[
                        { value: 'any', label: '所有旗标' },
                        { value: 'pick', label: '留用' },
                        { value: 'none', label: '未标记' },
                        { value: 'reject', label: '淘汰' },
                        { value: 'not_reject', label: '隐藏淘汰' },
                      ]}
                    />
                    <Select
                      size="sm"
                      aria-label="文件格式筛选"
                      value={format()}
                      onChange={(value) =>
                        setFormat(value as NonNullable<AssetListOptions['format']>)
                      }
                      options={[
                        { value: 'all', label: '所有格式' },
                        { value: 'raw', label: 'RAW' },
                        { value: 'jpeg', label: 'JPEG' },
                      ]}
                    />
                    <Show when={facets()?.cameras.length}>
                      <Select
                        size="sm"
                        aria-label="机身筛选"
                        value={camera()}
                        onChange={setCamera}
                        options={[
                          { value: '', label: '所有机身' },
                          ...facets()!.cameras.map((item) => ({
                            value: item.value,
                            label: `${item.value}（${item.count}）`,
                          })),
                        ]}
                      />
                    </Show>
                    <Show when={facets()?.lenses.length}>
                      <Select
                        size="sm"
                        aria-label="镜头筛选"
                        value={lens()}
                        onChange={setLens}
                        options={[
                          { value: '', label: '所有镜头' },
                          ...facets()!.lenses.map((item) => ({
                            value: item.value,
                            label: `${item.value}（${item.count}）`,
                          })),
                        ]}
                      />
                    </Show>
                    <span class="library-dates" role="group" aria-label="拍摄日期范围">
                      <TextInput
                        size="sm"
                        type="date"
                        value={capturedFrom()}
                        min={facets()?.captured.first ?? undefined}
                        max={capturedTo() || facets()?.captured.last || undefined}
                        onChange={(event) => setCapturedFrom(event.currentTarget.value)}
                        aria-label="拍摄日期起"
                      />
                      <span aria-hidden="true">–</span>
                      <TextInput
                        size="sm"
                        type="date"
                        value={capturedTo()}
                        min={capturedFrom() || facets()?.captured.first || undefined}
                        max={facets()?.captured.last ?? undefined}
                        onChange={(event) => setCapturedTo(event.currentTarget.value)}
                        aria-label="拍摄日期止"
                      />
                    </span>
                    <Show when={batches().length}>
                      <Select
                        size="sm"
                        aria-label="导入批次"
                        value={batchId()}
                        onChange={setBatchId}
                        options={[
                          { value: '', label: '所有导入' },
                          ...batches().map((batch) => ({
                            value: batch.id,
                            label: `${batch.started_at.slice(0, 16).replace('T', ' ')} · ${batch.asset_count} 张`,
                          })),
                        ]}
                      />
                    </Show>
                    <Show when={activeFilters().length}>
                      <Button
                        size="sm"
                        variant="ghost"
                        class="filter-clear"
                        onClick={clearAllFilters}
                      >
                        清除全部
                      </Button>
                    </Show>
                  </div>
                </Show>
                <div class="collection-body">
                  <Show when={view() === 'overview'}>
                    <div class="overview-layer">
                      <LibraryOverview
                        options={{ ...listOptions(), limit: undefined, offset: undefined }}
                        onPick={(pick) => {
                          setExtra(pick);
                          setView('photos');
                        }}
                        onCull={() => {
                          setView('photos');
                          void startCulling();
                        }}
                      />
                    </div>
                  </Show>
                  <div class="collection-scroll" ref={collectionScroll}>
                    <Show
                      when={assets().length}
                      fallback={
                        <Show
                          when={!loading()}
                          fallback={
                            <div
                              class="photo-grid skeleton-grid"
                              style={{ '--thumbnail-size': `${thumbSize()}px` }}
                              role="status"
                              aria-label="正在读取图片…"
                            >
                              <For each={Array.from({ length: 12 }, (_, index) => index)}>
                                {() => <div class="skeleton-card" aria-hidden="true" />}
                              </For>
                            </div>
                          }
                        >
                          <EmptyState
                            icon="photo"
                            title={
                              loading()
                                ? '正在读取图片…'
                                : filtered()
                                  ? '没有匹配的照片'
                                  : '图片库尚无照片'
                            }
                            description={
                              filtered()
                                ? '调整搜索词、评级、旗标或文件格式筛选。'
                                : desktop
                                  ? '扫描此目录建立索引，照片在原位置保留。'
                                  : '选择本地图片开始体验。'
                            }
                            actions={
                              <Show when={!loading()}>
                                <Button
                                  onClick={() =>
                                    filtered()
                                      ? (setQuery(''),
                                        setRating(0),
                                        setFormat('all'),
                                        setFlag('any'),
                                        setBatchId(''),
                                        clearMetadataFilters())
                                      : desktop
                                        ? scan(library())
                                        : fileInput.click()
                                  }
                                >
                                  {filtered()
                                    ? '清除筛选'
                                    : desktop
                                      ? '扫描图片库'
                                      : '选择本地图片'}
                                </Button>
                              </Show>
                            }
                          />
                        </Show>
                      }
                    >
                      <JustifiedGrid
                        items={assets()}
                        measure={tileShape}
                        section={daySection}
                        rowHeight={thumbSize()}
                        scroller={() => collectionScroll}
                        ref={(api) => (photoGrid = api)}
                      >
                        {(asset, size) => (
                          <div class="asset-card tile-card">
                            <Thumbnail
                              tile
                              asset={asset}
                              tier={gridTier(Math.max(size.width, size.height), devicePixelRatio())}
                              selected={selectedIds().includes(asset.id)}
                              focused={selectedId() === asset.id}
                              tabbable={
                                selectedId() === asset.id ||
                                (!selectedIds().length && asset.id === assets()[0]?.id)
                              }
                              onSelect={(event) => selectAsset(asset.id, event)}
                              onOpen={() => openAsset(asset)}
                              onMenu={(point) => openAssetMenu(asset, point)}
                            />
                            <Show when={asset.variants?.length}>
                              <div class="asset-variants" aria-label={`${asset.filename} 配对文件`}>
                                <For each={asset.variants}>
                                  {(variant) => (
                                    <button
                                      class="button small"
                                      aria-label={`打开 ${variant.filename} ${variant.kind === 'raw' ? 'RAW' : 'JPEG'}`}
                                      title={variant.filename}
                                      onClick={() =>
                                        openAsset(
                                          variant,
                                          variantViewerIds(assets(), asset.id, variant.id),
                                        )
                                      }
                                    >
                                      {variant.kind === 'raw' ? 'RAW' : 'JPEG'}
                                    </button>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        )}
                      </JustifiedGrid>
                      <Show when={assets().length < total()}>
                        <div
                          class="load-more"
                          ref={(element) => {
                            const observer = new IntersectionObserver(
                              (entries) =>
                                setNearEnd(entries.some((entry) => entry.isIntersecting)),
                              { root: collectionScroll, rootMargin: '800px 0px' },
                            );
                            observer.observe(element);
                            rearmPaging = () => {
                              observer.unobserve(element);
                              observer.observe(element);
                            };
                            onCleanup(() => {
                              observer.disconnect();
                              rearmPaging = undefined;
                              setNearEnd(false);
                            });
                          }}
                        >
                          <span class="load-more-status" aria-live="polite">
                            {loading()
                              ? '正在载入更多照片…'
                              : `已载入 ${assets().length} / ${total()}`}
                          </span>
                          <button
                            class="button small"
                            aria-label={`载入更多（${assets().length} / ${total()}）`}
                            disabled={loading()}
                            onClick={() => {
                              setAutoPagingFailed(false);
                              void loadAssets(true);
                            }}
                          >
                            载入更多
                          </button>
                        </div>
                      </Show>
                    </Show>
                  </div>
                  <Show when={info() && selected()}>
                    <>
                      <Show when={!detail.loading && detail()?.error}>
                        <div class="detail-error" role="alert">
                          {detail()!.error}
                          <button class="button small" onClick={() => refetchDetail()}>
                            重试
                          </button>
                        </div>
                      </Show>
                      <AssetInspector
                        asset={
                          detail()?.asset?.id === selected()!.id ? detail()!.asset! : selected()!
                        }
                        loading={detail.loading}
                        management
                        busy={!!busy()}
                        onClose={() => setInfo(false)}
                        onRate={rate}
                        onResetCrop={resetCrop}
                        onCrop={() => openAsset(selected()!)}
                        onExport={() => openAsset(selected()!)}
                        onRefresh={desktop ? refreshOriginal : undefined}
                      />
                    </>
                  </Show>
                  <BatchDock
                    count={selectedIds().length}
                    canTrash={library().source_kind === 'local' || !library().source_kind}
                    exportBusy={tasks.isRunning('export')}
                    trashBusy={!!busy()}
                    onMark={(mark) => void markSelection(mark)}
                    onExport={() => void exportSelection()}
                    onTrash={() => void trashSelection()}
                    onClear={clearPicked}
                  />
                </div>
              </section>
            )}
          </Show>
        </Show>
        <div class="persistent-workspace" hidden={section() !== 'sources'}>
          <StorageWorkspace
            sources={sources()}
            onAdd={() => editSource()}
            onEdit={editSource}
            onUpdated={updateSource}
            onCreateLibrary={newLibrary}
            onRefresh={refreshSources}
            onRemove={(source) => setRemoving({ kind: 'source', item: source })}
          />
        </div>
        <div class="persistent-workspace" hidden={section() !== 'cards'}>
          <ImportWorkspace
            active={section() === 'cards'}
            libraries={libraries()}
            onCreateLibrary={() => newLibrary()}
            onOpenLibrary={enterLibrary}
            onCull={(library, batch) => void cullBatch(library, batch)}
            onOpenLocations={() => navigate('sources')}
            sources={sources()}
            onImported={() => {
              void refreshLibraries();
              if (libraryId()) void loadAssets();
            }}
          />
        </div>
        <Show when={section() === 'settings'}>
          <Settings system={system()} onNavigate={navigate} />
        </Show>
        <FeedbackStack
          feedback={feedback}
          startup={ready() ? undefined : '正在读取本机配置…'}
          undoBusy="正在放回原处…"
          onRetrySync={focusRefresh}
        />
      </main>
      <Show when={dialog() === 'library'}>
        <LibraryDialog
          sources={sources()}
          initialSource={librarySource()}
          initialPrefix={libraryPrefix()}
          initialRoot={libraryRoot()}
          existing={editingLibrary()}
          onClose={() => setDialog(null)}
          onAdded={(library, bindingChanged) => {
            const wasEditing = !!editingLibrary();
            setLibraries((items) => [...items.filter((item) => item.id !== library.id), library]);
            setDialog(null);
            if (!wasEditing) enterLibrary(library);
            if (bindingChanged && library.id === libraryId()) void scanReboundLibrary(library);
            else if (!wasEditing || bindingChanged) void scan(library);
            else {
              if (library.id === libraryId()) void loadAssets();
              setNotice(`已保存 ${library.name} 的图片库设置。`);
            }
          }}
        />
      </Show>
      <Show when={removing()}>
        {(target) => (
          <ConfirmDialog
            title={target().kind === 'library' ? '移除图片库' : '移除存储源'}
            onClose={() => setRemoving(undefined)}
            onConfirm={removeItem}
            blocked={removalReferences().length > 0}
          >
            <p>确认移除“{target().item.name}”？</p>
            <p>
              {target().kind === 'library'
                ? '仅删除此图片库的索引、评级与裁剪配方。原始照片及目录不会删除，存储源连接保持不变。'
                : '仅删除连接配置与保存的登录凭据，不删除存储位置中的任何文件。如有图片库正在引用此来源，须先移除这些图片库。'}
            </p>
            <Show when={removalReferences().length}>
              <p>以下图片库正在使用此来源，请先在设置中更改存储位置或移除图片库：</p>
              <ul>
                <For each={removalReferences()}>{(library) => <li>{library.name}</li>}</For>
              </ul>
              <button
                class="button"
                onClick={() => {
                  setRemoving(undefined);
                  navigate('libraries');
                }}
              >
                管理关联图片库
              </button>
            </Show>
          </ConfirmDialog>
        )}
      </Show>
      <Show when={dialog() === 'storage'}>
        <StorageDialog
          existing={editingSource()}
          onClose={() => setDialog(null)}
          onAdded={(source) => {
            updateSource(source);
            setDialog(null);
            setSection('sources');
            setNotice(`已保存 ${source.name}。请测试连接或浏览目录验证访问。`);
          }}
        />
      </Show>
      <Show when={overlay()}>
        {(context) => (
          <Viewer
            initialAssetId={context().id}
            initialAssetIds={context().ids}
            initialMode={context().mode}
            initialQueue={context().queue}
            onClose={closeOverlay}
            onCurrent={(id) => (viewerCurrent = id)}
            onAssetChanged={(asset) => void acceptAsset(asset)}
            onTrashed={() => {
              void loadAssets(false, true);
              void refreshFolders();
            }}
          />
        )}
      </Show>
    </AppShell>
  );
}

const FILTERS_OPEN_KEY = 'nebulume.filters-open';
function readFiltersOpen() {
  try {
    return localStorage.getItem(FILTERS_OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}
function readThumbSize() {
  try {
    const value = Number(localStorage.getItem('nebulume.thumbnail-size'));
    return value >= 150 && value <= 320 ? value : 210;
  } catch {
    return 210;
  }
}
function saveThumbSize(value: number) {
  try {
    localStorage.setItem('nebulume.thumbnail-size', String(value));
  } catch {
    /* The preference remains effective for this session. */
  }
}
