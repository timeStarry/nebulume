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
import { listen } from '@tauri-apps/api/event';
import { chooseImage, desktop, execute, openViewerWindow } from './api';
import { addBrowserFiles } from './demo';
import { LibraryDialog, StorageDialog } from './Dialogs';
import AssetInspector from './AssetInspector';
import { Thumbnail } from './PhotoView';
import StorageWorkspace from './StorageWorkspace';
import ImportWorkspace from './ImportWorkspace';
import Viewer from './Viewer';
import Icon from './Icon';
import {
  errorMessage,
  isTextEntry,
  type Asset,
  type Library,
  type ScanResult,
  type StorageConfig,
} from './model';
import { libraryLocation, sourceKind, type WorkspaceSection } from './workspace';

type Dialog = 'library' | 'storage' | null;
export default function ManagementApp() {
  const [section, setSection] = createSignal<WorkspaceSection>('libraries');
  const [libraries, setLibraries] = createSignal<Library[]>([]);
  const [sources, setSources] = createSignal<StorageConfig[]>([]);
  const [system, setSystem] = createSignal<Record<string, unknown>>();
  const [libraryId, setLibraryId] = createSignal<string>();
  const [assets, setAssets] = createSignal<Asset[]>([]);
  const [total, setTotal] = createSignal(0);
  const [selectedId, setSelectedId] = createSignal<string>();
  const [query, setQuery] = createSignal('');
  const [rating, setRating] = createSignal(0);
  const [sort, setSort] = createSignal('newest');
  const [thumbSize, setThumbSize] = createSignal(readThumbSize());
  const [info, setInfo] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [dialog, setDialog] = createSignal<Dialog>(null);
  const [editingSource, setEditingSource] = createSignal<StorageConfig>();
  const [librarySource, setLibrarySource] = createSignal<StorageConfig>();
  const [libraryPrefix, setLibraryPrefix] = createSignal('');
  const [overlay, setOverlay] = createSignal<{ id: string; ids: string[] }>();
  let fileInput!: HTMLInputElement;
  let searchInput: HTMLInputElement | undefined;
  let request = 0;
  const revisions = new Map<string, number>();
  let openAfterImport = false;
  const visibleLibraries = createMemo(() => libraries().filter((library) => !library.hidden));
  const currentLibrary = createMemo(() =>
    libraries().find((library) => library.id === libraryId()),
  );
  const sortedAssets = createMemo(() =>
    [...assets()].sort((a, b) =>
      sort() === 'name'
        ? a.filename.localeCompare(b.filename)
        : sort() === 'rating'
          ? b.rating - a.rating || a.filename.localeCompare(b.filename)
          : String(b.modified_at).localeCompare(String(a.modified_at)),
    ),
  );
  const selected = createMemo(() => assets().find((asset) => asset.id === selectedId()));
  const [detail, { mutate: mutateDetail, refetch: refetchDetail }] = createResource(
    () => info() && section() === 'libraries' && selected()?.id,
    async (id): Promise<{ asset: Asset | null; error: string }> => {
      try {
        return {
          asset: {
            ...(await execute<Asset>('asset.get', { id })),
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
  async function loadAssets(append = false) {
    const id = libraryId();
    if (!id) return;
    const token = ++request;
    setLoading(true);
    try {
      const result = await execute<{ items: Asset[]; total: number }>('asset.list', {
        library_id: id,
        query: query().trim() || undefined,
        rating: rating() || undefined,
        limit: 200,
        offset: append ? assets().length : 0,
      });
      if (token !== request || id !== libraryId()) return;
      const revised = result.items.map((item) => ({
        ...item,
        preview_revision: revisions.get(item.id),
      }));
      const next = append ? [...assets(), ...revised] : revised;
      setAssets(next);
      setTotal(result.total);
      if (!next.some((item) => item.id === selectedId())) setSelectedId(next[0]?.id);
    } catch (e) {
      if (token === request) setError(errorMessage(e));
    } finally {
      if (token === request) setLoading(false);
    }
  }
  createEffect(() => {
    const active = section();
    libraryId();
    query();
    rating();
    const initialized = ready();
    if (active !== 'libraries' || !libraryId() || !initialized) return;
    const timeout = setTimeout(() => void loadAssets(), 120);
    onCleanup(() => clearTimeout(timeout));
  });
  function navigate(next: WorkspaceSection) {
    setSection(next);
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
    request++;
    setAssets([]);
    setTotal(0);
    setSelectedId(undefined);
    setQuery('');
    setRating(0);
    setInfo(false);
    setLibraryId(library.id);
    setSection('libraries');
    setError('');
    setNotice('');
  }
  function newLibrary(source?: StorageConfig, prefix = '') {
    setLibrarySource(source);
    setLibraryPrefix(prefix);
    setDialog('library');
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
      const result = await execute<ScanResult>('library.scan', { library_id: library.id });
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
  function replaceAsset(asset: Asset) {
    if (asset.preview_revision) revisions.set(asset.id, asset.preview_revision);
    asset = { ...asset, preview_revision: revisions.get(asset.id) };
    setAssets((items) => items.map((item) => (item.id === asset.id ? asset : item)));
    if (asset.id === selectedId()) mutateDetail({ asset, error: '' });
  }
  async function rate(value: number) {
    if (!selected() || busy()) return;
    const id = selected()!.id;
    await action('保存评级…', async () => {
      replaceAsset(await execute<Asset>('asset.rate', { id, rating: value }));
      if (rating() > value) await loadAssets();
    });
  }
  async function resetCrop() {
    if (!selected()) return;
    const id = selected()!.id;
    await action('重置裁剪…', async () =>
      replaceAsset(await execute<Asset>('asset.reset_crop', { id })),
    );
  }
  async function refreshOriginal() {
    const id = selected()?.id;
    if (!id || !desktop || busy()) return;
    await action('正在重新读取原图…', async () => {
      replaceAsset({
        ...(await execute<Asset>('asset.refresh', { id })),
        preview_revision: Date.now(),
      });
      setNotice('已重新读取原图，评级与裁剪配方已保留。');
    });
  }
  async function openAsset(asset: Asset, ids = sortedAssets().map((item) => item.id)) {
    if (desktop)
      await action('正在打开查看窗口…', async () => {
        await openViewerWindow(asset.id, ids);
      });
    else setOverlay({ id: asset.id, ids });
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
      const asset =
        result.added > 0
          ? listing.items.at(-Math.min(result.added, listing.items.length))
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
    if (dialog() || overlay() || isTextEntry(event.target) || event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && libraryId()) {
      event.preventDefault();
      searchInput?.focus();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || section() !== 'libraries' || !libraryId())
      return;
    const index = sortedAssets().findIndex((asset) => asset.id === selectedId());
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = sortedAssets()[index + (event.key === 'ArrowRight' ? 1 : -1)];
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
  }
  function focusRefresh() {
    if (ready() && section() === 'libraries' && libraryId() && !overlay()) {
      void loadAssets();
      if (info()) void refetchDetail();
    }
  }
  onMount(() => {
    void boot();
    window.addEventListener('keydown', keyboard);
    window.addEventListener('focus', focusRefresh);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (desktop)
      void listen<{ id: string; revision?: number }>('asset-updated', (event) => {
        if (event.payload.revision) revisions.set(event.payload.id, event.payload.revision);
        focusRefresh();
      })
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => {});
    onCleanup(() => {
      disposed = true;
      unlisten?.();
      window.removeEventListener('keydown', keyboard);
      window.removeEventListener('focus', focusRefresh);
    });
  });
  return (
    <div class="workspace-app">
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
        <div class="manager-brand">
          <span class="brand-symbol">
            <i />
            <i />
            <i />
          </span>
          <strong>nebulume</strong>
        </div>
        <span class="manager-window-title">影像管理</span>
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
      <nav class="manager-navigation" aria-label="主导航">
        <div class="navigation-group-title">工作区</div>
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
              aria-current={section() === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
              <Show when={item.id === 'libraries'}>
                <small>{visibleLibraries().length}</small>
              </Show>
            </button>
          )}
        </For>
        <div class="navigation-footer">
          <span class="status-dot" />
          <span>{desktop ? '本地优先 · 原片保留' : '临时文件体验'}</span>
          <small>0.1 ALPHA</small>
        </div>
      </nav>
      <main class="manager-workspace">
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
                    <p>按项目或目录组织影像。选择图片库开始浏览。</p>
                  </div>
                  <div class="workspace-heading-actions">
                    <Show when={!desktop}>
                      <button
                        class="button"
                        onClick={() => {
                          openAfterImport = false;
                          fileInput.click();
                        }}
                      >
                        载入图片
                      </button>
                    </Show>
                    <button
                      class="button primary"
                      onClick={() => (desktop ? newLibrary() : fileInput.click())}
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
                        <button class="button" onClick={() => newLibrary()}>
                          建立图片库
                        </button>
                      </div>
                    }
                  >
                    {(library) => (
                      <button
                        class="library-card"
                        onClick={() => enterLibrary(library)}
                        aria-label={`打开图片库 ${library.name}`}
                      >
                        <div class="library-card-top">
                          <Icon name="folder" size={26} />
                          <span>{sourceKind(library.source_kind)}</span>
                          <Icon name="right" size={17} />
                        </div>
                        <h2>{library.name}</h2>
                        <p title={libraryLocation(library)}>{libraryLocation(library)}</p>
                        <div class="library-card-footer">
                          <span>{library.source_name || '本地图片库'}</span>
                          <small>
                            {library.source_kind && library.source_kind !== 'local'
                              ? '远程按需读取'
                              : '原位管理'}
                          </small>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
                <Show when={!desktop}>
                  <div class="workspace-note">
                    浏览器只保留当前会话的真实图片，可体验查看、评级、直方图与裁剪导出。远程存储和存储卡导入需要桌面版。
                  </div>
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
                    <small>{total()} 张</small>
                  </div>
                  <div>
                    <button
                      class="button"
                      onClick={() => (desktop ? scan(library()) : fileInput.click())}
                      disabled={!!busy()}
                    >
                      <Icon name={desktop ? 'refresh' : 'plus'} size={15} />
                      {desktop ? '扫描更新' : '载入图片'}
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
                    value={sort()}
                    onChange={(event) => setSort(event.currentTarget.value)}
                    aria-label="已载入照片排序"
                  >
                    <option value="newest">修改时间 ↓</option>
                    <option value="name">文件名 A—Z</option>
                    <option value="rating">评级优先</option>
                  </select>
                  <div class="collection-controls-spacer" />
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
                </div>
                <div class="collection-body">
                  <div class="collection-scroll">
                    <Show
                      when={assets().length}
                      fallback={
                        <div class="workspace-empty">
                          <Icon name="photo" size={32} />
                          <h2>
                            {loading()
                              ? '正在读取图片…'
                              : query() || rating()
                                ? '没有匹配的照片'
                                : '图片库尚无照片'}
                          </h2>
                          <p>
                            {query() || rating()
                              ? '更换搜索词或降低评级筛选。'
                              : desktop
                                ? '扫描此目录建立索引，照片在原位置保留。'
                                : '选择本地图片开始体验。'}
                          </p>
                          <Show when={!loading()}>
                            <button
                              class="button"
                              onClick={() =>
                                query() || rating()
                                  ? (setQuery(''), setRating(0))
                                  : desktop
                                    ? scan(library())
                                    : fileInput.click()
                              }
                            >
                              {query() || rating()
                                ? '清除筛选'
                                : desktop
                                  ? '扫描图片库'
                                  : '选择本地图片'}
                            </button>
                          </Show>
                        </div>
                      }
                    >
                      <div class="photo-grid" style={{ '--thumbnail-size': `${thumbSize()}px` }}>
                        <For each={sortedAssets()}>
                          {(asset) => (
                            <Thumbnail
                              asset={asset}
                              selected={selectedId() === asset.id}
                              onSelect={() => setSelectedId(asset.id)}
                              onOpen={() => openAsset(asset)}
                            />
                          )}
                        </For>
                      </div>
                      <Show when={assets().length < total()}>
                        <div class="load-more">
                          <button
                            class="button"
                            disabled={loading()}
                            onClick={() => loadAssets(true)}
                          >
                            载入更多（{assets().length} / {total()}）
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
                            <p>远程照片将按需缓存。</p>
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
                    {loading() ? '正在读取索引…' : `已载入 ${assets().length} / ${total()} 张`}
                  </span>
                  <span>双击或 Enter 独立查看 · I 详情 · 0–5 评级</span>
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
      <footer class="manager-status">
        <span>
          <Show when={busy()} fallback={<span class="status-dot" />}>
            <span class="spinner small" />
          </Show>
          {busy() || (!ready() ? '正在读取本机配置…' : '就绪')}
        </span>
        <span>{desktop ? '原片保持不变' : '浏览器演示 · 临时会话'}</span>
      </footer>
      <Show when={dialog() === 'library'}>
        <LibraryDialog
          sources={sources()}
          initialSource={librarySource()}
          initialPrefix={libraryPrefix()}
          onSourceAdded={updateSource}
          onClose={() => setDialog(null)}
          onAdded={(library) => {
            setLibraries((items) => [...items.filter((item) => item.id !== library.id), library]);
            setDialog(null);
            enterLibrary(library);
            void scan(library);
          }}
        />
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
            onClose={() => {
              setOverlay(undefined);
              document.title = 'Nebulume — 影像管理';
            }}
            onAssetChanged={replaceAsset}
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
          <p>显示偏好、运行能力与键盘操作。</p>
        </div>
      </header>
      <section class="settings-panel">
        <h2>浏览显示</h2>
        <div class="settings-row">
          <div>
            <strong>缩略图大小</strong>
            <p>应用于所有图片库，偏好保存在本机。</p>
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
        <div class="settings-row">
          <div>
            <strong>沉浸查看</strong>
            <p>双击照片或按 Enter 打开独立窗口；信息面板默认关闭。</p>
          </div>
          <Icon name="expand" />
        </div>
      </section>
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
          <span>查看器全屏</span>
          <kbd>F</kbd>
          <span>退出裁剪 / 全屏 / 查看器</span>
          <kbd>Esc</kbd>
          <span>搜索当前图片库</span>
          <kbd>Ctrl / ⌘ F</kbd>
        </div>
      </section>
      <section class="settings-panel">
        <h2>运行环境</h2>
        <p>
          Nebulume 0.1 Alpha · {desktop ? '桌面应用' : '浏览器演示'}
          。图库记录评级与裁剪，原始文件保持不变。RAW 解码能力以当前运行时为准。
        </p>
        <details>
          <summary>查看运行时能力与限制</summary>
          <pre>{JSON.stringify(props.system || { status: '运行信息暂不可用' }, null, 2)}</pre>
        </details>
      </section>
    </section>
  );
}
