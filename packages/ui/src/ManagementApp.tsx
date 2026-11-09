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
  readPregenerate,
  writePregenerate,
  readWatchLibraries,
  watchLibraries,
  writeWatchLibraries,
} from './api';
import { addBrowserFiles } from './demo';
import { ConfirmDialog, LibraryDialog, StorageDialog } from './Dialogs';
import AssetInspector from './AssetInspector';
import LibrarySidebar, { type FolderAction } from './LibrarySidebar';
import LibraryOverview from './LibraryOverview';
import {
  exportPhotos,
  exportSummary,
  restorePhotos,
  trashPhotos,
  trashSummary,
} from './photo-actions';
import { Thumbnail } from './PhotoView';
import { gridTier, previewUrl, watchDevicePixelRatio } from './preview-url';
import StorageWorkspace from './StorageWorkspace';
import ImportWorkspace from './ImportWorkspace';
import Viewer, { type CullQueue, type ViewerMode } from './Viewer';
import { readAutoAdvance, writeAutoAdvance } from './culling';
import Icon from './Icon';
import BrandMark from './BrandMark';
import ThemeControl from './ThemeControl';
import CacheSettings from './CacheSettings';
import CaptureIndexControl from './CaptureIndexControl';
import OverflowMenu from './OverflowMenu';
import ContextMenu, { type ContextMenuState } from './ContextMenu';
import JustifiedGrid, { type JustifiedGridApi } from './JustifiedGrid';
import { fitRect, fly } from './zoom-transition';
import { AboutPanel, UpdatePrompt } from './UpdatePanel';
import { updates } from './updates';
import {
  errorMessage,
  isTextEntry,
  type Asset,
  type AssetFacets,
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
  sourceKind,
  variantViewerIds,
  type WorkspaceSection,
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
  const [selectedId, setSelectedId] = createSignal<string>();
  // Extra photos chosen with Ctrl/Cmd or Shift. The focused photo (selectedId)
  // always counts as selected, so single selection keeps working unchanged.
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  let selectionAnchor: string | undefined;
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
  const [undoable, setUndoable] = createSignal<{ text: string; run: () => Promise<void> }>();
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
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [syncError, setSyncError] = createSignal('');
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
      if (!next.some((item) => item.id === selectedId())) setSelectedId(next[0]?.id);
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
  // Success notices close themselves; errors stay until dismissed or replaced.
  createEffect(() => {
    if (!notice()) return;
    const timeout = setTimeout(() => setNotice(''), NOTICE_DISMISS_MS);
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
    if (next === 'libraries') {
      request++;
      setLibraryId(undefined);
      setAssets([]);
      setInfo(false);
      setLoading(false);
    }
  }
  function enterLibrary(library: Library) {
    closeNavigation();
    request++;
    setAssets([]);
    setTotal(0);
    setSelectedId(undefined);
    setPicked(new Set<string>());
    selectionAnchor = undefined;
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
  async function action(label: string, operation: () => Promise<void>) {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  /** Renders every selected photo with its crop to a chosen folder, one at a time. */
  async function exportSelection(ids = selectedIds()) {
    if (!ids.length || busy()) return;
    const directory = desktop ? await chooseDirectory('选择导出文件夹') : '';
    if (desktop && !directory) return;
    setError('');
    setNotice('');
    try {
      const result = await exportPhotos(
        ids,
        directory ?? '',
        new Map(assets().map((item) => [item.id, item])),
        (done, total) => setBusy(`正在导出 ${done} / ${total}…`),
      );
      const summary = exportSummary(result, directory ?? '', desktop);
      if (summary.error) setError(summary.error);
      else setNotice(summary.notice!);
    } finally {
      setBusy('');
    }
  }
  /** Moves the selected photos to the system Trash; the toast offers to put them back. */
  async function trashSelection(ids = selectedIds()) {
    if (!ids.length || busy()) return;
    const order = assets().map((item) => item.id);
    const position = Math.max(0, order.indexOf(ids[0]));
    setError('');
    setNotice('');
    setUndoable(undefined);
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
      offerUndo(`已把 ${ids.length} 张照片移到废纸篓。`, async () => {
        const restored = await restorePhotos(result.trashed);
        if (restored.failed.length)
          setError(`${restored.failed.length} 张未能放回：${restored.failed[0].message}`);
        else setNotice(`已放回 ${restored.restored.length} 个文件。`);
      });
      await loadAssets(false, true);
    }
  }
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  function offerUndo(text: string, run: () => Promise<void>) {
    clearTimeout(undoTimer);
    setUndoable({ text, run });
    undoTimer = setTimeout(() => setUndoable(undefined), 10_000);
  }
  async function runUndo() {
    const pending = undoable();
    if (!pending) return;
    clearTimeout(undoTimer);
    setUndoable(undefined);
    await action('正在放回原处…', async () => {
      await pending.run();
      await loadAssets(false, true);
      await refreshFolders();
    });
  }
  async function scan(library: Library) {
    await action(`正在扫描 ${library.name}…`, async () => {
      const result = await execute<ScanResult>('library.scan', {
        library_id: library.id,
      }).finally(() => void refreshLibraries());
      if (library.id === libraryId()) await loadAssets();
      await refreshLibraries();
      // Render the grid's tier for new photos in the background; on-demand loading covers failures.
      void pregeneratePreviews(library.id, gridTier(thumbSize(), devicePixelRatio())).catch(
        () => undefined,
      );
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
    });
  }
  async function scanReboundLibrary(library: Library) {
    const token = ++request;
    setAssets([]);
    setTotal(0);
    setFileTotal(undefined);
    setSelectedId(undefined);
    setPicked(new Set<string>());
    selectionAnchor = undefined;
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
  const selectedIds = createMemo(() => {
    const ids = new Set(picked());
    if (selectedId()) ids.add(selectedId()!);
    return assets()
      .filter((asset) => ids.has(asset.id))
      .map((asset) => asset.id);
  });
  function clearPicked() {
    if (picked().size) setPicked(new Set<string>());
  }
  function selectAsset(
    id: string,
    event?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  ) {
    const items = assets();
    if (event?.shiftKey && (selectionAnchor ?? selectedId())) {
      const anchor = selectionAnchor ?? selectedId()!;
      const from = items.findIndex((asset) => asset.id === anchor);
      const to = items.findIndex((asset) => asset.id === id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setPicked(new Set(items.slice(start, end + 1).map((asset) => asset.id)));
        setSelectedId(id);
        return;
      }
    }
    if (event?.ctrlKey || event?.metaKey) {
      const next = new Set(selectedIds());
      if (next.has(id) && next.size > 1) {
        next.delete(id);
        setPicked(next);
        if (selectedId() === id) setSelectedId([...next].at(-1));
      } else {
        next.add(id);
        setPicked(next);
        setSelectedId(id);
      }
      selectionAnchor = id;
      return;
    }
    clearPicked();
    selectionAnchor = id;
    setSelectedId(id);
  }
  async function markSelection(mark: { rating?: number; flag?: Flag }) {
    const ids = selectedIds();
    if (!ids.length || busy()) return;
    if (ids.length === 1) {
      const id = ids[0];
      await action(mark.flag !== undefined ? '保存旗标…' : '保存评级…', async () => {
        await acceptAsset(
          mark.flag !== undefined
            ? await execute<Asset>('asset.flag', { id, flag: mark.flag })
            : await execute<Asset>('asset.rate', { id, rating: mark.rating }),
          mark.flag !== undefined ? 'flag' : 'rating',
        );
      });
      return;
    }
    await action(`正在标记 ${ids.length} 张照片…`, async () => {
      for (let start = 0; start < ids.length; start += 1000) {
        await execute('asset.mark_batch', { ids: ids.slice(start, start + 1000), ...mark });
      }
      setAssets((items) =>
        items.map((item) => (ids.includes(item.id) ? { ...item, ...mark } : item)),
      );
      if (libraryId()) dirtyLibraries.add(libraryId()!);
      await loadAssets(false, true);
      setNotice(`已标记 ${ids.length} 张照片。`);
    });
  }
  async function rate(value: number) {
    if (!selected() || busy()) return;
    const id = selected()!.id;
    await action('保存评级…', async () => {
      await acceptAsset(await execute<Asset>('asset.rate', { id, rating: value }), 'rating');
    });
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
      event.key.toLowerCase() === 'a' &&
      section() === 'libraries' &&
      libraryId() &&
      assets().length
    ) {
      event.preventDefault();
      setPicked(new Set(assets().map((asset) => asset.id)));
      if (!selectedId()) setSelectedId(assets()[0].id);
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
      event.key === 'Enter' &&
      selected() &&
      !(event.target as HTMLElement).closest('button')
    )
      void openAsset(selected()!);
    else if (event.key.toLowerCase() === 'i') setInfo((value) => !value);
    else if (/^[0-5]$/.test(event.key)) void markSelection({ rating: Number(event.key) });
    else if (event.key.toLowerCase() === 'p' && !event.shiftKey)
      void markSelection({ flag: 'pick' });
    else if (event.key.toLowerCase() === 'x') void markSelection({ flag: 'reject' });
    else if (event.key.toLowerCase() === 'u') void markSelection({ flag: 'none' });
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
      disabled: !!busy(),
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
          disabled: !!busy(),
          onSelect: () => void startCulling(),
        },
        'separator',
        ...rateItems,
        'separator',
        { label: '留用', disabled: !!busy(), onSelect: () => void markSelection({ flag: 'pick' }) },
        {
          label: '淘汰',
          disabled: !!busy(),
          onSelect: () => void markSelection({ flag: 'reject' }),
        },
        {
          label: '清除旗标',
          disabled: !!busy(),
          onSelect: () => void markSelection({ flag: 'none' }),
        },
        'separator',
        {
          label: '显示详情',
          onSelect: () => setInfo(true),
        },
        {
          label: count > 1 ? `导出所选 ${count} 张为 JPEG…` : '导出为 JPEG…',
          disabled: !!busy(),
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
  async function folderAction(kind: FolderAction, path: string) {
    const library = currentLibrary();
    if (!library) return;
    setFolder(path);
    if (kind === 'cull') return setCullWhenLoaded(true);
    if (kind === 'scan') return void scan(library);
    if (kind === 'overview') return setView('overview');
    // Every pick in the folder, not only the loaded page.
    const ids: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await execute<AssetListResult>('asset.list', {
        library_id: library.id,
        folder: path,
        flag: 'pick',
        limit: 1000,
        offset,
      }).catch((e) => {
        setError(errorMessage(e));
        return undefined;
      });
      if (!page) return;
      ids.push(...page.items.map((item) => item.id));
      if (ids.length >= page.total || !page.items.length) break;
    }
    if (!ids.length) return setNotice('这个文件夹里还没有留用的照片。');
    await exportSelection(ids);
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
    <div class="workspace-app" classList={{ 'nav-open': navigationOpen() }}>
      <input
        ref={fileInput}
        class="visually-hidden"
        type="file"
        accept="image/*,.dng,.cr2,.nef,.arw,.raf,.orf,.rw2"
        multiple
        aria-label="选择浏览器演示图片"
        onChange={importBrowser}
      />
      <header class="manager-titlebar">
        <button
          ref={navigationButton}
          class="icon-button navigation-toggle"
          aria-label={navigationOpen() ? '关闭主导航' : '打开主导航'}
          aria-controls="manager-navigation"
          aria-expanded={navigationOpen()}
          onClick={() => {
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
        >
          <Icon name={navigationOpen() ? 'close' : 'menu'} />
        </button>
        <div class="manager-brand">
          <BrandMark size={32} />
          <strong>Nebulume</strong>
        </div>
        <div>
          <button class="button small" onClick={openFile} disabled={!!busy()}>
            <Icon name="photo" size={15} />
            打开文件…
          </button>
        </div>
      </header>
      <Show when={navigationOpen()}>
        <button
          class="navigation-scrim"
          aria-label="关闭主导航遮罩"
          tabindex="-1"
          onClick={() => {
            closeNavigation();
          }}
        />
      </Show>
      <nav
        id="manager-navigation"
        ref={navigationElement}
        class="manager-navigation"
        aria-label="主导航"
      >
        <For
          each={
            [
              { id: 'libraries', label: '图片库', icon: 'grid' },
              { id: 'sources', label: '位置', icon: 'cloud' },
              { id: 'cards', label: '导入', icon: 'card' },
              { id: 'settings', label: '设置', icon: 'settings' },
            ] as const
          }
        >
          {(item) => (
            <>
              <button
                class={`workspace-nav-item ${section() === item.id && !(item.id === 'libraries' && libraryId()) ? 'active' : ''}`}
                aria-label={item.id === 'libraries' ? item.label : undefined}
                aria-current={
                  section() === item.id && !(item.id === 'libraries' && libraryId())
                    ? 'page'
                    : undefined
                }
                onClick={() => navigate(item.id)}
              >
                <Icon name={item.icon} size={19} />
                <span class="rail-label">{item.label}</span>
              </button>
            </>
          )}
        </For>
        <button
          class="workspace-nav-item rail-open"
          aria-label="打开文件…"
          onClick={openFile}
          disabled={!!busy()}
        >
          <Icon name="photo" size={19} />
          <span class="rail-label">打开文件…</span>
        </button>
      </nav>
      <LibrarySidebar
        libraries={visibleLibraries()}
        currentId={section() === 'libraries' ? libraryId() : undefined}
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
      <main class="manager-workspace" aria-label="影像管理工作区">
        <UpdatePrompt />
        <Show when={section() === 'libraries'}>
          <Show
            when={currentLibrary()}
            fallback={
              <section class="workspace-page" aria-label="图片库管理">
                <header class="workspace-heading">
                  <div>
                    <h1>图片库</h1>
                  </div>
                  <div class="workspace-heading-actions">
                    <button
                      class="button primary"
                      onClick={() => {
                        if (desktop) newLibrary();
                        else {
                          openAfterImport = false;
                          fileInput.click();
                        }
                      }}
                    >
                      <Icon name="plus" size={15} />
                      {desktop ? '建立图片库' : '选择本地图片'}
                    </button>
                  </div>
                </header>
                <div class="library-manager-toolbar">
                  <span>{visibleLibraries().length} 个图片库</span>
                  <button class="icon-button" aria-label="刷新图片库" onClick={refreshLibraries}>
                    <Icon name="refresh" size={16} />
                  </button>
                </div>
                <div class="library-card-grid">
                  <For
                    each={visibleLibraries()}
                    fallback={
                      <div class="workspace-empty">
                        <Icon name="folder" size={34} />
                        <h2>建立你的第一个图片库</h2>
                        <p>从本地文件夹或已连接的网络位置选择目录。</p>
                      </div>
                    }
                  >
                    {(library) => (
                      <article
                        class={`library-card-container ${availabilityPresentation(library).usable ? '' : 'unavailable'}`}
                      >
                        <button
                          class="library-card"
                          onClick={() => enterLibrary(library)}
                          aria-label={`打开图片库 ${library.name}，${availabilityPresentation(library).label}`}
                        >
                          <LibraryCovers library={library} />
                          <div class="library-card-top">
                            <Icon name="folder" size={26} />
                            <span>{sourceKind(library.source_kind)}</span>
                            <span
                              class={`availability-badge ${library.availability || 'unchecked'}`}
                              title={availabilityPresentation(library).detail}
                            >
                              {availabilityPresentation(library).label}
                            </span>
                            <Icon name="right" size={17} />
                          </div>
                          <h2>{library.name}</h2>
                          <p class="library-card-stats">
                            {library.asset_count
                              ? `${library.asset_count.toLocaleString()} 张照片`
                              : '尚无照片'}
                            <Show when={library.latest_capture}>
                              {(day) => <span> · 最近拍摄 {day()}</span>}
                            </Show>
                          </p>
                          <p class="library-card-location" title={libraryLocation(library)}>
                            {libraryLocation(library)}
                          </p>
                          <Show
                            when={
                              (library.source_name && library.source_name !== library.name) ||
                              library.pair_raw_jpeg
                            }
                          >
                            <div class="library-card-footer">
                              <Show
                                when={library.source_name && library.source_name !== library.name}
                              >
                                <span>{library.source_name}</span>
                              </Show>
                              <Show when={library.pair_raw_jpeg}>
                                <small>RAW + JPEG 合并</small>
                              </Show>
                            </div>
                          </Show>
                        </button>
                        <div class="library-card-actions">
                          <OverflowMenu
                            label={`${library.name} 更多操作`}
                            items={[
                              {
                                label: '图片库设置…',
                                ariaLabel: `${library.name} 图片库设置`,
                                disabled: !!busy(),
                                onSelect: () => editLibrary(library),
                              },
                              {
                                label: '移除图片库…',
                                ariaLabel: `移除图片库 ${library.name}`,
                                disabled: !!busy(),
                                danger: true,
                                onSelect: () => setRemoving({ kind: 'library', item: library }),
                              },
                            ]}
                          />
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </section>
            }
          >
            {(library) => (
              <section class="library-collection" aria-label={`${library().name} 照片`}>
                <header class="collection-heading">
                  <div>
                    <button class="breadcrumb-button" onClick={() => navigate('libraries')}>
                      <Icon name="left" size={15} />
                      图片库
                    </button>
                    <span>/</span>
                    <h1>{library().name}</h1>
                    <Show when={folder()}>
                      <span class="heading-folder">{folder().replaceAll('/', ' / ')}</span>
                    </Show>
                  </div>
                  <div class="view-switch" role="tablist" aria-label="视图">
                    <button
                      role="tab"
                      aria-selected={view() === 'photos'}
                      aria-keyshortcuts="Meta+1"
                      onClick={() => setView('photos')}
                    >
                      <Icon name="grid" size={15} />
                      照片
                    </button>
                    <button
                      role="tab"
                      aria-selected={false}
                      aria-keyshortcuts="Meta+2"
                      disabled={!assets().length || !!busy()}
                      onClick={() => void startCulling()}
                    >
                      <Icon name="star" size={15} />
                      选片
                    </button>
                    <button
                      role="tab"
                      aria-selected={view() === 'overview'}
                      aria-keyshortcuts="Meta+3"
                      onClick={() => setView('overview')}
                    >
                      <Icon name="info" size={15} />
                      概览
                    </button>
                  </div>
                  <div class="collection-actions">
                    <button
                      class="button primary"
                      disabled={
                        !!busy() ||
                        (desktop &&
                          !availabilityPresentation(library()).usable &&
                          library().availability !== 'error')
                      }
                      title={
                        desktop && !availabilityPresentation(library()).usable
                          ? `无法扫描：${availabilityPresentation(library()).detail}`
                          : undefined
                      }
                      onClick={() => (desktop ? scan(library()) : fileInput.click())}
                    >
                      <Icon name={desktop ? 'refresh' : 'plus'} size={15} />
                      {desktop ? '扫描更新' : '载入图片'}
                    </button>
                    <button
                      class="button"
                      disabled={!assets().length || !!busy()}
                      onClick={() => void startCulling()}
                      aria-keyshortcuts="Shift+C"
                      title="以当前筛选结果逐张选图（Shift+C）"
                    >
                      <Icon name="star" size={15} />
                      选图
                    </button>
                    <button
                      class={`button ${info() ? 'active' : ''}`}
                      disabled={!selected()}
                      onClick={() => setInfo((value) => !value)}
                      aria-label="影像详情（I）"
                      aria-pressed={info()}
                    >
                      <Icon name="info" size={15} />
                      详情
                    </button>
                    <OverflowMenu
                      label={`${library().name} 更多操作`}
                      items={[
                        {
                          label: '图片库设置…',
                          ariaLabel: `${library().name} 图片库设置`,
                          disabled: !!busy(),
                          onSelect: () => editLibrary(library()),
                        },
                        {
                          label: '移除图片库…',
                          ariaLabel: `移除图片库 ${library().name}`,
                          disabled: !!busy(),
                          danger: true,
                          onSelect: () => setRemoving({ kind: 'library', item: library() }),
                        },
                      ]}
                    />
                  </div>
                </header>
                <Show when={!availabilityPresentation(library()).usable}>
                  <div
                    class={`availability-banner ${library().availability || 'unchecked'}`}
                    role="status"
                  >
                    <strong>{availabilityPresentation(library()).label}</strong>
                    <span>{availabilityPresentation(library()).detail}</span>
                    <Show when={availabilityPresentation(library()).action}>
                      {(fix) => (
                        <button class="button small" onClick={() => navigate(fix().section)}>
                          {fix().label}
                        </button>
                      )}
                    </Show>
                    <Show when={desktop}>
                      <button
                        class="button small"
                        disabled={!!busy()}
                        onClick={() => void refreshLibraries()}
                      >
                        重试
                      </button>
                    </Show>
                  </div>
                </Show>
                <div class="collection-controls">
                  <div class="search-field">
                    <Icon name="search" size={16} />
                    <input
                      ref={searchInput}
                      value={query()}
                      onInput={(event) => setQuery(event.currentTarget.value)}
                      placeholder="搜索文件名或元数据…"
                      aria-label="搜索照片"
                      maxLength={256}
                    />
                    <Show when={query()}>
                      <button
                        class="icon-button"
                        aria-label="清除搜索"
                        onClick={() => setQuery('')}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </Show>
                  </div>
                  <button
                    class={`button small filter-toggle ${filtersOpen() ? 'active' : ''}`}
                    aria-expanded={filtersOpen()}
                    aria-controls="collection-filters"
                    onClick={() => toggleFilters()}
                  >
                    <Icon name="filter" size={14} />
                    筛选
                    <Show when={activeFilters().length}>
                      <span class="filter-count">{activeFilters().length}</span>
                    </Show>
                  </button>
                  <div class="filter-chips" aria-label="当前筛选">
                    <For each={activeFilters()}>
                      {(chip) => (
                        <span class="filter-chip">
                          {chip.label}
                          <button
                            class="filter-chip-remove"
                            aria-label={`移除筛选：${chip.label}`}
                            onClick={chip.clear}
                          >
                            <Icon name="close" size={11} />
                          </button>
                        </span>
                      )}
                    </For>
                  </div>
                  <div class="collection-controls-spacer" />
                  <div class="sort-control">
                    <select
                      value={sort()}
                      title={
                        sort() === 'captured_at'
                          ? '按相机当地记录的拍摄时间排序；待索引或无有效时间的照片置后。'
                          : sort() === 'created_at'
                            ? '源文件创建时间；未提供时间的照片置后。旧远端库可扫描更新以补充。'
                            : undefined
                      }
                      onChange={(event) =>
                        setSort(
                          event.currentTarget.value as NonNullable<AssetListOptions['sort_by']>,
                        )
                      }
                      aria-label="排序字段"
                    >
                      <option value="captured_at">拍摄时间</option>
                      <option value="created_at">文件创建时间</option>
                      <option value="modified_at">文件修改时间</option>
                      <option value="filename">文件名</option>
                      <option value="rating">评级</option>
                    </select>
                    <button
                      class="icon-button sort-direction"
                      aria-label={
                        direction() === 'desc'
                          ? '排序方向：降序，切换为升序'
                          : '排序方向：升序，切换为降序'
                      }
                      title={direction() === 'desc' ? '降序' : '升序'}
                      onClick={() => setDirection(direction() === 'desc' ? 'asc' : 'desc')}
                    >
                      <Icon name={direction() === 'desc' ? 'sort-desc' : 'sort-asc'} size={16} />
                    </button>
                  </div>
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
                  <label class="collection-thumbnail-size">
                    <span>缩略图</span>
                    <input
                      type="range"
                      min="150"
                      max="320"
                      step="10"
                      value={thumbSize()}
                      onInput={(event) => {
                        const value = Number(event.currentTarget.value);
                        setThumbSize(value);
                        saveThumbSize(value);
                      }}
                      aria-label="缩略图大小"
                    />
                  </label>
                </div>
                <Show when={filtersOpen()}>
                  <div
                    class="filter-panel"
                    id="collection-filters"
                    role="group"
                    aria-label="筛选条件"
                  >
                    <label class="filter-field">
                      <span>评级</span>
                      <select
                        value={rating()}
                        onChange={(event) => setRating(Number(event.currentTarget.value))}
                        aria-label="最低评级筛选"
                      >
                        <option value="0">所有评级</option>
                        <For each={[1, 2, 3, 4, 5]}>
                          {(value) => (
                            <option value={value}>
                              {'★'.repeat(value)}
                              {value < 5 ? ' 及以上' : ''}
                            </option>
                          )}
                        </For>
                      </select>
                    </label>
                    <label class="filter-field">
                      <span>旗标</span>
                      <select
                        value={flag()}
                        onChange={(event) => setFlag(event.currentTarget.value as FlagFilter)}
                        aria-label="旗标筛选"
                      >
                        <option value="any">所有旗标</option>
                        <option value="pick">留用</option>
                        <option value="none">未标记</option>
                        <option value="reject">淘汰</option>
                        <option value="not_reject">隐藏淘汰</option>
                      </select>
                    </label>
                    <label class="filter-field">
                      <span>格式</span>
                      <select
                        value={format()}
                        onChange={(event) =>
                          setFormat(
                            event.currentTarget.value as NonNullable<AssetListOptions['format']>,
                          )
                        }
                        aria-label="文件格式筛选"
                      >
                        <option value="all">所有格式</option>
                        <option value="raw">RAW</option>
                        <option value="jpeg">JPEG</option>
                      </select>
                    </label>
                    <label class="filter-field">
                      <span>机身</span>
                      <Show when={facets()?.cameras.length}>
                        <select
                          value={camera()}
                          onChange={(event) => setCamera(event.currentTarget.value)}
                          aria-label="机身筛选"
                        >
                          <option value="">所有机身</option>
                          <For each={facets()!.cameras}>
                            {(item) => (
                              <option value={item.value}>
                                {item.value}（{item.count}）
                              </option>
                            )}
                          </For>
                        </select>
                      </Show>
                    </label>
                    <label class="filter-field">
                      <span>镜头</span>
                      <Show when={facets()?.lenses.length}>
                        <select
                          value={lens()}
                          onChange={(event) => setLens(event.currentTarget.value)}
                          aria-label="镜头筛选"
                        >
                          <option value="">所有镜头</option>
                          <For each={facets()!.lenses}>
                            {(item) => (
                              <option value={item.value}>
                                {item.value}（{item.count}）
                              </option>
                            )}
                          </For>
                        </select>
                      </Show>
                    </label>
                    <div class="filter-field">
                      <span>拍摄日期</span>
                      <div class="date-range" role="group" aria-label="拍摄日期范围">
                        <input
                          type="date"
                          value={capturedFrom()}
                          min={facets()?.captured.first ?? undefined}
                          max={capturedTo() || facets()?.captured.last || undefined}
                          onChange={(event) => setCapturedFrom(event.currentTarget.value)}
                          aria-label="拍摄日期起"
                        />
                        <span aria-hidden="true">–</span>
                        <input
                          type="date"
                          value={capturedTo()}
                          min={capturedFrom() || facets()?.captured.first || undefined}
                          max={facets()?.captured.last ?? undefined}
                          onChange={(event) => setCapturedTo(event.currentTarget.value)}
                          aria-label="拍摄日期止"
                        />
                      </div>
                    </div>
                    <label class="filter-field">
                      <span>导入批次</span>
                      <Show when={batches().length}>
                        <select
                          value={batchId()}
                          onChange={(event) => setBatchId(event.currentTarget.value)}
                          aria-label="导入批次"
                        >
                          <option value="" selected={!batchId()}>
                            所有导入
                          </option>
                          <For each={batches()}>
                            {(batch) => (
                              // Options are rebuilt when the batch list reloads; mark selection
                              // per option so the chosen batch survives that refresh.
                              <option value={batch.id} selected={batch.id === batchId()}>
                                {batch.started_at.slice(0, 16).replace('T', ' ')} ·{' '}
                                {batch.asset_count} 张
                              </option>
                            )}
                          </For>
                        </select>
                      </Show>
                    </label>
                    <Show when={activeFilters().length}>
                      <button class="button small filter-clear" onClick={clearAllFilters}>
                        清除全部
                      </button>
                    </Show>
                  </div>
                </Show>
                <Show when={selectedIds().length > 1}>
                  <div class="selection-bar" role="toolbar" aria-label="批量操作">
                    <strong>已选 {selectedIds().length} 张</strong>
                    <div class="selection-bar-group" aria-label="批量评级">
                      <For each={[1, 2, 3, 4, 5]}>
                        {(value) => (
                          <button
                            class="button small"
                            disabled={!!busy()}
                            aria-label={`将所选照片评为 ${value} 星`}
                            onClick={() => void markSelection({ rating: value })}
                          >
                            {value}
                          </button>
                        )}
                      </For>
                      <button
                        class="button small"
                        disabled={!!busy()}
                        aria-label="清除所选照片评级"
                        onClick={() => void markSelection({ rating: 0 })}
                      >
                        0
                      </button>
                    </div>
                    <div class="selection-bar-group" aria-label="批量旗标">
                      <button
                        class="button small"
                        disabled={!!busy()}
                        onClick={() => void markSelection({ flag: 'pick' })}
                      >
                        留用
                      </button>
                      <button
                        class="button small"
                        disabled={!!busy()}
                        onClick={() => void markSelection({ flag: 'reject' })}
                      >
                        淘汰
                      </button>
                      <button
                        class="button small"
                        disabled={!!busy()}
                        onClick={() => void markSelection({ flag: 'none' })}
                      >
                        清除旗标
                      </button>
                    </div>
                    <span class="collection-controls-spacer" />
                    <button
                      class="button small"
                      disabled={!!busy()}
                      onClick={() => void exportSelection()}
                    >
                      <Icon name="export" size={14} />
                      导出 JPEG…
                    </button>
                    <button class="button small" onClick={clearPicked}>
                      取消选择
                    </button>
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
                          <div class="workspace-empty">
                            <Icon name="photo" size={32} />
                            <h2>
                              {loading()
                                ? '正在读取图片…'
                                : filtered()
                                  ? '没有匹配的照片'
                                  : '图片库尚无照片'}
                            </h2>
                            <p>
                              {filtered()
                                ? '调整搜索词、评级、旗标或文件格式筛选。'
                                : desktop
                                  ? '扫描此目录建立索引，照片在原位置保留。'
                                  : '选择本地图片开始体验。'}
                            </p>
                            <Show when={!loading()}>
                              <button
                                class="button"
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
                                {filtered() ? '清除筛选' : desktop ? '扫描图片库' : '选择本地图片'}
                              </button>
                            </Show>
                          </div>
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
                </div>
                <footer class="collection-status">
                  <span>
                    {loading()
                      ? '正在读取索引…'
                      : `已载入 ${assets().length} / ${total()} 项${fileTotal() !== undefined && fileTotal() !== total() ? ` · ${fileTotal()} 个匹配文件` : ''}`}
                  </span>
                </footer>
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
        <div class="toast-stack">
          <Show when={busy() || !ready()}>
            <div class="toast busy" role="status">
              <span class="spinner small" />
              <span>{busy() || '正在读取本机配置…'}</span>
            </div>
          </Show>
          <Show when={syncError()}>
            <div class="toast error" role="alert">
              <span>{syncError()}</span>
              <button class="button small" onClick={focusRefresh}>
                重试影像同步
              </button>
            </div>
          </Show>
          <Show when={error()}>
            <div class="toast error" role="alert">
              <span>{error()}</span>
              <button class="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>
                <Icon name="close" size={15} />
              </button>
            </div>
          </Show>
          <Show when={undoable()}>
            {(pending) => (
              <div class="toast success" role="status">
                <span>{pending().text}</span>
                <button class="button small" onClick={() => void runUndo()}>
                  撤销
                </button>
              </div>
            )}
          </Show>
          <Show when={notice()}>
            <div class="toast success" role="status">
              <span>{notice()}</span>
              <button class="icon-button" aria-label="关闭完成提示" onClick={() => setNotice('')}>
                <Icon name="close" size={15} />
              </button>
            </div>
          </Show>
        </div>
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
    </div>
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
const NOTICE_DISMISS_MS = 6000;
function saveThumbSize(value: number) {
  try {
    localStorage.setItem('nebulume.thumbnail-size', String(value));
  } catch {
    /* The preference remains effective for this session. */
  }
}
function CullingSettings() {
  const [auto, setAuto] = createSignal(readAutoAdvance());
  const [pregenerate, setPregenerate] = createSignal(readPregenerate());
  const [watching, setWatching] = createSignal(readWatchLibraries());
  return (
    <section class="settings-panel">
      <h2>浏览与选图</h2>
      <div class="settings-row">
        <div>
          <strong>打标后自动下一张</strong>
          <p>选图模式中打星或打旗后，确认动效结束即前进。选图工具栏可随时切换。</p>
        </div>
        <input
          type="checkbox"
          checked={auto()}
          onChange={(event) => {
            setAuto(event.currentTarget.checked);
            writeAutoAdvance(event.currentTarget.checked);
          }}
          aria-label="打标后自动下一张"
        />
      </div>
      <Show when={desktop}>
        <div class="settings-row">
          <div>
            <strong>扫描后预生成缩略图</strong>
            <p>
              扫描本地图片库后，在后台按当前网格尺寸渲染缩略图，首次浏览更快。不会下载远端照片，占用的空间计入缓存上限。
            </p>
          </div>
          <input
            type="checkbox"
            checked={pregenerate()}
            onChange={(event) => {
              setPregenerate(event.currentTarget.checked);
              writePregenerate(event.currentTarget.checked);
            }}
            aria-label="扫描后预生成缩略图"
          />
        </div>
        <div class="settings-row">
          <div>
            <strong>自动更新本地图片库</strong>
            <p>
              监视本地图片库文件夹，文件新增、删除、移动或改名后约 3
              秒自动重新索引，评级与裁剪随照片保留。网络存储不受影响。
            </p>
          </div>
          <input
            type="checkbox"
            checked={watching()}
            onChange={(event) => {
              setWatching(event.currentTarget.checked);
              writeWatchLibraries(event.currentTarget.checked);
              void watchLibraries(event.currentTarget.checked).catch(() => undefined);
            }}
            aria-label="自动更新本地图片库"
          />
        </div>
      </Show>
    </section>
  );
}
/** Up to four recent photos as a mosaic; an empty library shows its kind instead. */
function LibraryCovers(props: { library: Library }) {
  const ids = () => props.library.cover_asset_ids || [];
  return (
    <div class={`library-covers count-${Math.min(4, ids().length)}`} aria-hidden="true">
      <Show when={ids().length} fallback={<Icon name="photo" size={30} />}>
        <For each={ids()}>{(id) => <CoverImage id={id} />}</For>
      </Show>
    </div>
  );
}
function CoverImage(props: { id: string }) {
  const [src, setSrc] = createSignal<string>();
  void Promise.resolve(previewUrl({ id: props.id }, 't256')).then(setSrc, () => undefined);
  return (
    <Show when={src()}>{(url) => <img src={url()} alt="" loading="lazy" draggable={false} />}</Show>
  );
}
const SETTINGS_SECTIONS = [
  { id: 'settings-appearance', label: '外观与浏览' },
  { id: 'settings-cache', label: '缓存与离线' },
  { id: 'settings-shortcuts', label: '快捷键' },
  { id: 'settings-owners', label: '其他配置' },
  { id: 'settings-about', label: '关于与诊断' },
] as const;
/** Settings holds only app-wide preferences and this machine's resources.
 *  Everything owned by a location, library, card or preset is edited where it lives. */
function Settings(props: {
  system?: Record<string, unknown>;
  onNavigate: (section: WorkspaceSection) => void;
}) {
  const [current, setCurrent] = createSignal<string>(SETTINGS_SECTIONS[0].id);
  let content!: HTMLDivElement;
  onMount(() => {
    // Highlight the section nearest the top of the scrolled settings page.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setCurrent(visible.target.id);
      },
      { rootMargin: '0px 0px -60% 0px' },
    );
    for (const section of SETTINGS_SECTIONS) {
      const element = content.querySelector(`#${section.id}`);
      if (element) observer.observe(element);
    }
    onCleanup(() => observer.disconnect());
  });
  function jump(id: string) {
    setCurrent(id);
    content.querySelector(`#${id}`)?.scrollIntoView({ block: 'start' });
  }
  const owners: { what: string; where: string; section: WorkspaceSection }[] = [
    { what: '连接地址、凭据、证书信任、测试连接', where: '位置', section: 'sources' },
    {
      what: '图片库名称、目录、RAW + JPEG 合并、扫描',
      where: '图片库 → 库设置',
      section: 'libraries',
    },
    { what: '存储卡名称、绑定、默认导入方案', where: '导入', section: 'cards' },
    { what: '导入方案：目标图片库、目录整理、去重', where: '导入', section: 'cards' },
  ];
  return (
    <section class="workspace-page settings-workspace" aria-label="设置工作区">
      <header class="workspace-heading">
        <div>
          <h1>设置</h1>
        </div>
      </header>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分区">
          <For each={SETTINGS_SECTIONS}>
            {(section) => (
              <button
                class={`settings-nav-item ${current() === section.id ? 'active' : ''}`}
                aria-current={current() === section.id ? 'true' : undefined}
                onClick={() => jump(section.id)}
              >
                {section.label}
              </button>
            )}
          </For>
        </nav>
        <div class="settings-content" ref={content}>
          <div id="settings-appearance" class="settings-group">
            <section class="settings-panel">
              <h2>外观</h2>
              <div class="settings-row">
                <ThemeControl />
              </div>
            </section>
            <CullingSettings />
          </div>
          <div id="settings-cache" class="settings-group">
            <CacheSettings />
          </div>
          <section id="settings-shortcuts" class="settings-panel">
            <h2>快捷键</h2>
            <h3>图片库网格</h3>
            <div class="settings-shortcuts">
              <span>独立查看照片</span>
              <kbd>Enter / 双击</kbd>
              <span>移动焦点（左右 / 上下一行）</span>
              <kbd>← → ↑ ↓</kbd>
              <span>首张 / 末张 / 翻一屏</span>
              <kbd>Home / End / PgUp PgDn</kbd>
              <span>范围选择 / 增减选择 / 全选</span>
              <kbd>Shift 点击 / Ctrl ⌘ 点击 / Ctrl ⌘ A</kbd>
              <span>评级 / 清除评级（作用于所选）</span>
              <kbd>1–5 / 0</kbd>
              <span>留用 / 淘汰 / 清除旗标（作用于所选）</span>
              <kbd>P / X / U</kbd>
              <span>照片菜单</span>
              <kbd>右键 / Shift F10</kbd>
              <span>取消多选，否则关闭信息</span>
              <kbd>Esc</kbd>
              <span>显示或隐藏信息</span>
              <kbd>I</kbd>
              <span>搜索当前图片库</span>
              <kbd>Ctrl / ⌘ F</kbd>
              <span>以当前筛选开始选图</span>
              <kbd>Shift C</kbd>
            </div>
            <h3>查看窗口</h3>
            <div class="settings-shortcuts">
              <span>上一张 / 下一张</span>
              <kbd>← / →</kbd>
              <span>评级 / 清除评级</span>
              <kbd>1–5 / 0</kbd>
              <span>裁剪</span>
              <kbd>C</kbd>
              <span>显示或隐藏相机对焦点</span>
              <kbd>P</kbd>
              <span>全屏</span>
              <kbd>F</kbd>
              <span>切换到选图模式</span>
              <kbd>Shift C</kbd>
              <span>退出裁剪 / 全屏 / 关闭</span>
              <kbd>Esc</kbd>
            </div>
            <h3>选图模式</h3>
            <div class="settings-shortcuts">
              <span>打星 / 清除星级</span>
              <kbd>1–5 / 0</kbd>
              <span>留用 / 淘汰 / 清除旗标</span>
              <kbd>P / X / U</kbd>
              <span>单张 / 对比视图</span>
              <kbd>G / C</kbd>
              <span>适合窗口 ↔ 1:1</span>
              <kbd>Z</kbd>
              <span>撤销上一次标记</span>
              <kbd>Ctrl / ⌘ Z</kbd>
              <span>显示或隐藏选图信息</span>
              <kbd>Tab</kbd>
              <span>显示或隐藏相机对焦点</span>
              <kbd>Shift F</kbd>
              <span>切回普通查看</span>
              <kbd>Shift C</kbd>
            </div>
          </section>
          <section id="settings-owners" class="settings-panel">
            <h2>其他配置在哪里</h2>
            <p>以下配置属于具体的位置、图片库或存储卡，在各自页面中修改。</p>
            <ul class="settings-owners">
              <For each={owners}>
                {(owner) => (
                  <li>
                    <span>{owner.what}</span>
                    <button class="button small" onClick={() => props.onNavigate(owner.section)}>
                      {owner.where}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
          <div id="settings-about" class="settings-group">
            <AboutPanel system={props.system} />
          </div>
        </div>
      </div>
    </section>
  );
}
