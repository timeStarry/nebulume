import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { listen } from '@tauri-apps/api/event';
import { chooseImage, desktop, execute, openViewerWindow } from './api';
import { addBrowserFiles } from './demo';
import { ConfirmDialog, LibraryDialog, StorageDialog } from './Dialogs';
import AssetInspector from './AssetInspector';
import { Thumbnail } from './PhotoView';
import StorageWorkspace from './StorageWorkspace';
import ImportWorkspace from './ImportWorkspace';
import Viewer, { type CullQueue, type ViewerMode } from './Viewer';
import { readAutoAdvance, writeAutoAdvance } from './culling';
import Icon from './Icon';
import BrandMark from './BrandMark';
import ThemeControl from './ThemeControl';
import CacheSettings from './CacheSettings';
import CaptureIndexControl from './CaptureIndexControl';
import {
  errorMessage,
  isTextEntry,
  type Asset,
  type AssetListOptions,
  type AssetListResult,
  type FlagFilter,
  type Library,
  type ScanResult,
  type StorageConfig,
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
  const [query, setQuery] = createSignal('');
  const [rating, setRating] = createSignal(0);
  const [format, setFormat] = createSignal<NonNullable<AssetListOptions['format']>>('all');
  const [flag, setFlag] = createSignal<FlagFilter>('any');
  const [sort, setSort] = createSignal<NonNullable<AssetListOptions['sort_by']>>('captured_at');
  const [direction, setDirection] =
    createSignal<NonNullable<AssetListOptions['sort_direction']>>('desc');
  const [thumbSize, setThumbSize] = createSignal(readThumbSize());
  const [info, setInfo] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
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
  const [overlay, setOverlay] = createSignal<{
    id: string;
    ids: string[];
    mode?: ViewerMode;
    queue?: CullQueue;
  }>();
  let fileInput!: HTMLInputElement;
  let searchInput: HTMLInputElement | undefined;
  let navigationButton: HTMLButtonElement | undefined;
  let navigationElement: HTMLElement | undefined;
  let collectionScroll: HTMLDivElement | undefined;
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
  const filtered = () => !!(query() || rating() || format() !== 'all' || flag() !== 'any');
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
    sort();
    direction();
    const initialized = ready();
    if (active !== 'libraries' || !libraryId() || !initialized) return;
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
    setQuery('');
    setRating(0);
    setFormat('all');
    setFlag('any');
    setInfo(false);
    setLibraryId(library.id);
    setSection('libraries');
    setError('');
    setNotice('');
  }
  function newLibrary(source?: StorageConfig, prefix = '') {
    setEditingLibrary(undefined);
    setLibrarySource(source);
    setLibraryPrefix(prefix);
    setDialog('library');
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
  async function scan(library: Library) {
    await action(`正在扫描 ${library.name}…`, async () => {
      const result = await execute<ScanResult>('library.scan', {
        library_id: library.id,
      }).finally(() => void refreshLibraries());
      if (library.id === libraryId()) await loadAssets();
      await refreshLibraries();
      setNotice(
        `扫描完成：索引 ${result.indexed} 项，跳过 ${result.skipped} 项${result.errors.length ? `，${result.errors.length} 项异常` : ''}。`,
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
  async function openAsset(asset: Pick<Asset, 'id'>, ids = assets().map((item) => item.id)) {
    if (desktop)
      await action('正在打开查看窗口…', async () => {
        await openViewerWindow(asset.id, ids);
      });
    else setOverlay({ id: asset.id, ids });
  }
  async function startCulling() {
    const start = selected() || assets()[0];
    const id = libraryId();
    if (!start || !id) return;
    // The viewer snapshots the whole filtered result, not just the loaded page.
    const queue = { library_id: id, options: { ...listOptions(), library_id: id } };
    const loaded = assets().map((item) => item.id);
    if (desktop)
      await action('正在打开选图…', async () => {
        await openViewerWindow(start.id, loaded, { mode: 'cull', queue });
      });
    else setOverlay({ id: start.id, ids: loaded, mode: 'cull', queue });
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
      await openViewerWindow(asset.id, [asset.id]);
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
      const buttons = Array.from(
        navigationElement?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
      );
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
    if (event.ctrlKey || event.metaKey || event.altKey || section() !== 'libraries' || !libraryId())
      return;
    const index = assets().findIndex((asset) => asset.id === selectedId());
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = assets()[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (next) setSelectedId(next.id);
    } else if (
      event.key === 'Enter' &&
      selected() &&
      !(event.target as HTMLElement).closest('button')
    )
      void openAsset(selected()!);
    else if (event.key.toLowerCase() === 'i') setInfo((value) => !value);
    else if (/^[0-5]$/.test(event.key)) void rate(Number(event.key));
    else if (event.key === 'Escape') setInfo(false);
    else if (event.shiftKey && event.key.toLowerCase() === 'c' && assets().length) {
      event.preventDefault();
      void startCulling();
    }
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
    const navigationMedia = window.matchMedia('(max-width: 959px)');
    const updateNavigationMode = () => {
      setCompactNavigation(navigationMedia.matches);
      if (!navigationMedia.matches) setNavigationOpen(false);
    };
    updateNavigationMode();
    navigationMedia.addEventListener('change', updateNavigationMode);
    void boot();
    window.addEventListener('keydown', keyboard);
    window.addEventListener('focus', focusRefresh);
    void registerAssetListener();
    onCleanup(() => {
      disposed = true;
      unlisten?.();
      window.removeEventListener('keydown', keyboard);
      window.removeEventListener('focus', focusRefresh);
      navigationMedia.removeEventListener('change', updateNavigationMode);
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
          <Show when={!desktop}>
            <span class="demo-label">浏览器演示</span>
          </Show>
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
              { id: 'sources', label: '存储源', icon: 'cloud' },
              { id: 'cards', label: '存储卡', icon: 'card' },
              { id: 'settings', label: '设置', icon: 'settings' },
            ] as const
          }
        >
          {(item) => (
            <button
              class={`workspace-nav-item ${section() === item.id ? 'active' : ''}`}
              aria-label={item.id === 'libraries' ? item.label : undefined}
              aria-current={section() === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
            </button>
          )}
        </For>
      </nav>
      <main class="manager-workspace" aria-label="影像管理工作区">
        <Show when={syncError()}>
          <div class="workspace-message error app-message" role="alert">
            <span>{syncError()}</span>
            <button class="button small" onClick={focusRefresh}>
              重试影像同步
            </button>
          </div>
        </Show>
        <Show when={error()}>
          <div class="workspace-message error app-message" role="alert">
            <span>{error()}</span>
            <button class="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
        <Show when={notice()}>
          <div class="workspace-message success app-message" role="status">
            <span>{notice()}</span>
            <button class="icon-button" aria-label="关闭完成提示" onClick={() => setNotice('')}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
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
                        <p>从本地文件夹或已经连接的存储源选择目录。</p>
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
                          <p title={libraryLocation(library)}>{libraryLocation(library)}</p>
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
                          <button
                            class="button small"
                            aria-label={`${library.name} 图片库设置`}
                            disabled={!!busy()}
                            onClick={() => editLibrary(library)}
                          >
                            <Icon name="settings" size={14} />
                            设置
                          </button>
                          <button
                            class="button small"
                            aria-label={`移除图片库 ${library.name}`}
                            disabled={!!busy()}
                            onClick={() => setRemoving({ kind: 'library', item: library })}
                          >
                            移除
                          </button>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
                <Show when={!desktop}>
                  <div class="workspace-note">关闭页面后，当前会话的图片与编辑记录会清除。</div>
                </Show>
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
                  </div>
                  <div>
                    <button
                      class="button"
                      aria-label={`${library().name} 图片库设置`}
                      disabled={!!busy()}
                      onClick={() => editLibrary(library())}
                    >
                      <Icon name="settings" size={15} />
                      设置
                    </button>
                    <button
                      class="button"
                      aria-label={`移除图片库 ${library().name}`}
                      disabled={!!busy()}
                      onClick={() => setRemoving({ kind: 'library', item: library() })}
                    >
                      移除
                    </button>
                    <button
                      class="button"
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
                      setSort(event.currentTarget.value as NonNullable<AssetListOptions['sort_by']>)
                    }
                    aria-label="排序字段"
                  >
                    <option value="captured_at">拍摄时间</option>
                    <option value="created_at">文件创建时间</option>
                    <option value="modified_at">文件修改时间</option>
                    <option value="filename">文件名</option>
                    <option value="rating">评级</option>
                  </select>
                  <select
                    value={direction()}
                    onChange={(event) => setDirection(event.currentTarget.value as 'asc' | 'desc')}
                    aria-label="排序方向"
                  >
                    <option value="desc">降序 ↓</option>
                    <option value="asc">升序 ↑</option>
                  </select>
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
                  <div class="collection-controls-spacer" />
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
                <div class="collection-body">
                  <div class="collection-scroll" ref={collectionScroll}>
                    <Show
                      when={assets().length}
                      fallback={
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
                                  ? (setQuery(''), setRating(0), setFormat('all'), setFlag('any'))
                                  : desktop
                                    ? scan(library())
                                    : fileInput.click()
                              }
                            >
                              {filtered() ? '清除筛选' : desktop ? '扫描图片库' : '选择本地图片'}
                            </button>
                          </Show>
                        </div>
                      }
                    >
                      <div class="photo-grid" style={{ '--thumbnail-size': `${thumbSize()}px` }}>
                        <For each={assets()}>
                          {(asset) => (
                            <div class="asset-card">
                              <Thumbnail
                                asset={asset}
                                selected={selectedId() === asset.id}
                                onSelect={() => setSelectedId(asset.id)}
                                onOpen={() => openAsset(asset)}
                              />
                              <Show when={asset.variants?.length}>
                                <div
                                  class="asset-variants"
                                  aria-label={`${asset.filename} 配对文件`}
                                >
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
                        </For>
                      </div>
                      <Show when={assets().length < total()}>
                        <div class="load-more">
                          <button
                            class="button"
                            aria-label={`载入更多（${assets().length} / ${total()}）`}
                            disabled={loading()}
                            onClick={() => loadAssets(true)}
                          >
                            载入更多
                          </button>
                        </div>
                      </Show>
                    </Show>
                  </div>
                  <Show when={info() && selected()}>
                    <Show
                      when={!detail.loading}
                      fallback={
                        <aside class="asset-inspector">
                          <div class="inspector-heading">
                            正在读取影像详情…
                            <button
                              class="icon-button"
                              aria-label="关闭影像详情"
                              onClick={() => setInfo(false)}
                            >
                              <Icon name="close" size={15} />
                            </button>
                          </div>
                          <div class="compact-empty">
                            <span class="spinner" />
                          </div>
                        </aside>
                      }
                    >
                      <Show when={detail()?.error}>
                        <div class="detail-error" role="alert">
                          {detail()!.error}
                          <button class="button small" onClick={() => refetchDetail()}>
                            重试
                          </button>
                        </div>
                      </Show>
                      <AssetInspector
                        asset={detail()?.asset || selected()!}
                        management
                        busy={!!busy()}
                        onClose={() => setInfo(false)}
                        onRate={rate}
                        onResetCrop={resetCrop}
                        onCrop={() => openAsset(selected()!)}
                        onExport={() => openAsset(selected()!)}
                        onRefresh={desktop ? refreshOriginal : undefined}
                      />
                    </Show>
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
            onImported={() => {
              void refreshLibraries();
              if (libraryId()) void loadAssets();
            }}
          />
        </div>
        <Show when={section() === 'settings'}>
          <Settings
            system={system()}
            thumbSize={thumbSize()}
            onSizeChange={(value) => {
              setThumbSize(value);
              saveThumbSize(value);
            }}
          />
        </Show>
      </main>
      <Show when={busy() || !ready()}>
        <footer class="manager-status" role="status">
          <span>
            <span class="spinner small" />
            {busy() || '正在读取本机配置…'}
          </span>
        </footer>
      </Show>
      <Show when={dialog() === 'library'}>
        <LibraryDialog
          sources={sources()}
          initialSource={librarySource()}
          initialPrefix={libraryPrefix()}
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
            onClose={() => {
              setOverlay(undefined);
              document.title = 'Nebulume — 影像管理';
            }}
            onAssetChanged={(asset) => void acceptAsset(asset)}
          />
        )}
      </Show>
    </div>
  );
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
function CullingSettings() {
  const [auto, setAuto] = createSignal(readAutoAdvance());
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
    </section>
  );
}
function Settings(props: {
  system?: Record<string, unknown>;
  thumbSize: number;
  onSizeChange: (value: number) => void;
}) {
  return (
    <section class="workspace-page settings-workspace" aria-label="设置工作区">
      <header class="workspace-heading">
        <div>
          <h1>设置</h1>
        </div>
      </header>
      <section class="settings-panel">
        <h2>浏览显示</h2>
        <div class="settings-row">
          <ThemeControl />
        </div>
        <div class="settings-row">
          <div>
            <strong>缩略图大小</strong>
            <p>应用于所有图片库。</p>
          </div>
          <input
            type="range"
            min="150"
            max="320"
            step="10"
            value={props.thumbSize}
            onInput={(e) => props.onSizeChange(Number(e.currentTarget.value))}
            aria-label="默认缩略图大小"
          />
        </div>
      </section>
      <CullingSettings />
      <CacheSettings />
      <section class="settings-panel">
        <h2>快捷键</h2>
        <div class="settings-shortcuts">
          <span>独立查看照片</span>
          <kbd>Enter / 双击</kbd>
          <span>上一张 / 下一张</span>
          <kbd>← / →</kbd>
          <span>显示或隐藏信息</span>
          <kbd>I</kbd>
          <span>评级 / 清除评级</span>
          <kbd>1–5 / 0</kbd>
          <span>查看器中裁剪</span>
          <kbd>C</kbd>
          <span>显示或隐藏相机对焦点</span>
          <kbd>P</kbd>
          <span>查看器全屏</span>
          <kbd>F</kbd>
          <span>退出裁剪 / 全屏 / 查看器</span>
          <kbd>Esc</kbd>
          <span>搜索当前图片库</span>
          <kbd>Ctrl / ⌘ F</kbd>
          <span>以当前筛选开始选图 / 切换查看与选图</span>
          <kbd>Shift C</kbd>
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
        </div>
      </section>
      <section class="settings-panel">
        <h2>运行环境</h2>
        <p>Nebulume 0.1 Alpha · {desktop ? '桌面应用' : '浏览器演示'}</p>
        <details>
          <summary>运行时能力与限制</summary>
          <pre>{JSON.stringify(props.system || { status: '运行信息暂不可用' }, null, 2)}</pre>
        </details>
      </section>
    </section>
  );
}
