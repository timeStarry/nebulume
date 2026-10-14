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
} from 'solid-js';
import { chooseSave, desktop, execute } from './api';
import { addBrowserFiles } from './demo';
import { ImportDialog, LibraryDialog, Modal, StorageBrowser, StorageDialog } from './Dialogs';
import Icon from './Icon';
import PhotoView, { Thumbnail } from './PhotoView';
import {
  bytes,
  errorMessage,
  fullCrop,
  histogramPath,
  imageRequestKey,
  isTextEntry,
  validCrop,
  type Asset,
  type Crop,
  type Histogram,
  type Library,
  type StorageConfig,
} from './model';

type View = 'grid' | 'viewer';
type Dialog = 'library' | 'storage' | 'import' | 'about' | 'history' | null;
export default function App() {
  const [libraries, setLibraries] = createSignal<Library[]>([]);
  const [storages, setStorages] = createSignal<StorageConfig[]>([]);
  const [libraryId, setLibraryId] = createSignal<string>();
  const [assets, setAssets] = createSignal<Asset[]>([]);
  const [total, setTotal] = createSignal(0);
  const [selectedId, setSelectedId] = createSignal<string>();
  const [view, setView] = createSignal<View>('grid');
  const [query, setQuery] = createSignal('');
  const [rating, setRating] = createSignal(0);
  const [sort, setSort] = createSignal('newest');
  const [thumbSize, setThumbSize] = createSignal(210);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal('');
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [dialog, setDialog] = createSignal<Dialog>(null);
  const [remote, setRemote] = createSignal<StorageConfig>();
  const [editingStorage, setEditingStorage] = createSignal<StorageConfig>();
  const [cropMode, setCropMode] = createSignal(false);
  const [crop, setCrop] = createSignal<Crop>({ ...fullCrop });
  const [system, setSystem] = createSignal<Record<string, unknown>>();
  const [history, setHistory] = createSignal<Record<string, unknown>[]>([]);
  function openStorageSettings(storage?: StorageConfig) {
    setEditingStorage(storage);
    setRemote(undefined);
    setDialog('storage');
  }
  let fileInput!: HTMLInputElement;
  let searchInput!: HTMLInputElement;
  let request = 0;
  const currentLibrary = createMemo(() => libraries().find((lib) => lib.id === libraryId()));
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
  const selectedIndex = createMemo(() =>
    sortedAssets().findIndex((asset) => asset.id === selectedId()),
  );
  const title = createMemo(() => currentLibrary()?.name || (rating() ? '精选影像' : '全部照片'));
  const [histogram] = createResource(
    () => selected() && imageRequestKey(selected()!),
    async (key) => {
      const { id } = JSON.parse(key);
      try {
        return { data: await execute<Histogram>('asset.histogram', { id }), error: '' };
      } catch (e) {
        return { data: null, error: errorMessage(e) };
      }
    },
  );
  const ceiling = createMemo(() => {
    const h = histogram()?.data;
    return h ? Math.max(...h.red, ...h.green, ...h.blue, 1) : 1;
  });

  async function loadAssets(append = false) {
    const token = ++request;
    setLoading(true);
    try {
      const result = await execute<{ items: Asset[]; total: number }>('asset.list', {
        library_id: libraryId(),
        query: query().trim() || undefined,
        rating: rating() || undefined,
        limit: 200,
        offset: append ? assets().length : 0,
      });
      if (token !== request) return;
      const next = append ? [...assets(), ...result.items] : result.items;
      setAssets(next);
      setTotal(result.total);
      if (!next.some((a) => a.id === selectedId())) setSelectedId(next[0]?.id);
      if (!next.length) {
        setView('grid');
        setCropMode(false);
      }
    } catch (e) {
      if (token === request) setError(errorMessage(e));
    } finally {
      if (token === request) setLoading(false);
    }
  }
  async function boot() {
    try {
      const results = await Promise.allSettled([
        execute<Library[]>('library.list'),
        execute<StorageConfig[]>('storage.list'),
        execute<Record<string, unknown>>('system.info'),
      ]);
      if (results[0].status === 'fulfilled') setLibraries(results[0].value);
      else setError(errorMessage(results[0].reason));
      if (results[1].status === 'fulfilled') setStorages(results[1].value);
      else setError(errorMessage(results[1].reason));
      if (results[2].status === 'fulfilled') setSystem(results[2].value);
    } finally {
      setReady(true);
    }
  }
  createEffect(() => {
    const start = ready();
    query();
    rating();
    libraryId();
    if (!start) return;
    const timeout = setTimeout(() => void loadAssets(), 160);
    onCleanup(() => clearTimeout(timeout));
  });
  createEffect(
    on(selectedId, () => {
      setCropMode(false);
      setCrop({ ...(selected()?.crop || fullCrop) });
    }),
  );
  onMount(() => {
    void boot();
    window.addEventListener('keydown', keyboard);
    onCleanup(() => window.removeEventListener('keydown', keyboard));
  });
  function keyboard(event: KeyboardEvent) {
    if (dialog() || remote() || isTextEntry(event.target) || event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInput.focus();
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' && (event.target as HTMLElement)?.closest('button, a, summary'))
      return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Escape') {
      if (cropMode()) setCropMode(false);
      else setView('grid');
    } else if (event.key.toLowerCase() === 'g') setView('grid');
    else if (event.key.toLowerCase() === 'e' || event.key === 'Enter') {
      if (selected()) setView('viewer');
    } else if (event.key.toLowerCase() === 'c') beginCrop();
    else if (/^[0-5]$/.test(event.key) && selected()) void rate(Number(event.key));
  }
  function move(direction: number) {
    if (cropMode()) return;
    const next = sortedAssets()[selectedIndex() + direction];
    if (next) setSelectedId(next.id);
  }
  function select(asset: Asset, open = false) {
    setSelectedId(asset.id);
    if (open) setView('viewer');
  }
  function replaceAsset(asset: Asset) {
    setAssets((items) => items.map((item) => (item.id === asset.id ? asset : item)));
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
  async function scan(library?: Library) {
    const targets = library ? [library] : currentLibrary() ? [currentLibrary()!] : libraries();
    if (!targets.length) {
      setDialog('library');
      return;
    }
    await action('正在索引图片库…', async () => {
      let indexed = 0;
      let skipped = 0;
      const errors: { path: string; message: string }[] = [];
      for (const item of targets) {
        const result = await execute<{
          indexed: number;
          skipped: number;
          errors: { path: string; message: string }[];
        }>('library.scan', { library_id: item.id });
        indexed += result.indexed;
        skipped += result.skipped;
        errors.push(...result.errors);
      }
      await loadAssets();
      setNotice(
        `扫描完成：索引 ${indexed} 项，跳过 ${skipped} 项${errors.length ? `，${errors.length} 项失败` : ''}。`,
      );
      if (errors.length)
        setError(
          errors
            .slice(0, 3)
            .map((e) => `${e.path}：${e.message}`)
            .join('\n'),
        );
    });
  }
  async function importBrowser(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    await action('正在解码所选文件…', async () => {
      const result = await addBrowserFiles(files);
      setQuery('');
      setRating(0);
      await loadAssets();
      setNotice(`已载入 ${result.added} 张真实图片。浏览器会话关闭后清除，原始文件未修改。`);
      if (result.errors.length) setError(result.errors.join('\n'));
    });
    input.value = '';
  }
  async function rate(value: number) {
    const asset = selected();
    if (!asset || busy()) return;
    await action('正在保存评级…', async () => {
      replaceAsset(await execute<Asset>('asset.rate', { id: asset.id, rating: value }));
      if (rating() > value) await loadAssets();
    });
  }
  function beginCrop() {
    if (!selected() || busy()) return;
    setCrop({ ...(selected()!.crop || fullCrop) });
    setView('viewer');
    setCropMode(true);
  }
  async function saveCrop() {
    if (!selected() || !validCrop(crop())) return;
    const id = selected()!.id;
    const next = { ...crop() };
    await action('正在保存裁剪配方…', async () => {
      replaceAsset(await execute<Asset>('asset.crop', { id, ...next }));
      setCropMode(false);
      setNotice('裁剪配方已保存。导出时应用裁剪，原片保持不变。');
    });
  }
  async function resetCrop() {
    if (!selected()) return;
    const id = selected()!.id;
    await action('正在重置裁剪…', async () => {
      replaceAsset(await execute<Asset>('asset.reset_crop', { id }));
      setCrop({ ...fullCrop });
      setCropMode(false);
    });
  }
  async function exportImage() {
    if (!selected()) return;
    const asset = selected()!;
    await action('正在导出 JPEG…', async () => {
      const destination = await chooseSave(asset.filename.replace(/\.[^.]+$/, '') + '-edited.jpg');
      if (!destination) return;
      const result = await execute<{ path: string }>('asset.export', { id: asset.id, destination });
      setNotice(desktop ? `已导出：${result.path}` : `已生成 ${result.path}，并交给浏览器下载。`);
    });
  }
  async function openHistory() {
    await action('正在读取导入记录…', async () => {
      setHistory(await execute<Record<string, unknown>[]>('import.history'));
      setDialog('history');
    });
  }

  return (
    <div class="app-shell">
      <input
        type="file"
        accept="image/*,.dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2"
        multiple
        ref={fileInput}
        class="visually-hidden"
        onChange={importBrowser}
        aria-label="选择浏览器演示图片"
      />
      <header class="app-header">
        <div class="brand">
          <span class="brand-symbol">
            <i />
            <i />
            <i />
          </span>
          <span>
            nebulume<small>影像工作台</small>
          </span>
        </div>
        <div class="header-breadcrumb">
          <span>图片库</span>
          <Icon name="right" size={12} />
          <strong>{title()}</strong>
        </div>
        <div class="header-actions">
          <Show when={!desktop}>
            <span class="demo-label">浏览器演示</span>
          </Show>
          <span class="alpha-label">ALPHA 01</span>
          <button
            class="icon-button"
            onClick={() => setDialog('about')}
            aria-label="关于、能力与快捷键"
          >
            <Icon name="info" size={18} />
          </button>
        </div>
      </header>
      <aside class="sidebar">
        <div class="workspace-label">
          你的影像空间 <span>LOCAL FIRST</span>
        </div>
        <nav aria-label="图库导航">
          <button
            class={`nav-item ${!libraryId() && !rating() ? 'active' : ''}`}
            onClick={() => {
              setLibraryId(undefined);
              setRating(0);
              setQuery('');
            }}
          >
            <Icon name="grid" />
            <span>全部照片</span>
            <Show when={!libraryId() && !query() && !rating()}>
              <small>{total()}</small>
            </Show>
          </button>
          <button
            class={`nav-item ${!libraryId() && rating() > 0 ? 'active' : ''}`}
            onClick={() => {
              setLibraryId(undefined);
              setRating(1);
            }}
          >
            <Icon name="star" />
            <span>精选影像</span>
          </button>
          <button
            class="nav-item"
            onClick={openHistory}
            disabled={!desktop || !!busy()}
            title={!desktop ? '桌面版支持持久导入记录' : '查看导入历史'}
          >
            <Icon name="clock" />
            <span>导入记录</span>
          </button>
        </nav>
        <div class="sidebar-section-label">
          本地图片库
          <button
            class="icon-button"
            aria-label="添加本地图片库"
            onClick={() => (desktop ? setDialog('library') : fileInput.click())}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        <nav aria-label="本地图片库">
          <For each={libraries()} fallback={<p class="sidebar-empty">从一个文件夹开始。</p>}>
            {(library) => (
              <button
                class={`nav-item library-item ${libraryId() === library.id ? 'active' : ''}`}
                title={library.root}
                onClick={() => {
                  setLibraryId(library.id);
                  setRating(0);
                }}
              >
                <Icon name="folder" />
                <span>{library.name}</span>
                <span class="online-dot" />
              </button>
            )}
          </For>
        </nav>
        <div class="sidebar-section-label">
          远程存储
          <button
            class="icon-button"
            aria-label="连接远程存储"
            onClick={() => openStorageSettings()}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        <nav aria-label="远程存储">
          <For
            each={storages()}
            fallback={
              <button class="storage-empty" onClick={() => openStorageSettings()}>
                <Icon name="cloud" size={23} />
                <span>
                  连接你的存储<small>WebDAV / S3</small>
                </span>
                <Icon name="plus" size={14} />
              </button>
            }
          >
            {(storage) => (
              <div class="storage-nav-row">
                <button class="nav-item" onClick={() => setRemote(storage)}>
                  <Icon name="cloud" />
                  <span>{storage.name}</span>
                  <small>{storage.kind === 's3' ? 'S3' : 'DAV'}</small>
                </button>
                <button
                  class="icon-button"
                  aria-label={`${storage.name} 连接设置`}
                  title="连接设置 / 重连"
                  onClick={() => openStorageSettings(storage)}
                >
                  <Icon name="settings" size={14} />
                </button>
              </div>
            )}
          </For>
        </nav>
        <div class="sidebar-bottom">
          <div class="import-card">
            <span class="import-card-icon">
              <Icon name="card" size={23} />
            </span>
            <strong>让每一次拍摄，妥善归档</strong>
            <p>预览计划 · 内容去重 · 保留原片</p>
            <button
              class="button"
              onClick={() => (desktop ? setDialog('import') : fileInput.click())}
            >
              <Icon name="plus" size={15} />
              {desktop ? '导入照片' : '选择本地图片'}
            </button>
          </div>
          <button class="sidebar-help" onClick={() => setDialog('about')}>
            <span class="status-dot" />
            {desktop ? '本地目录与原片由你掌控' : '临时会话 · 无文件系统权限'}
            <Icon name="right" size={12} />
          </button>
        </div>
      </aside>
      <main class="main-panel">
        <div class="library-heading">
          <div>
            <div class="eyebrow">LIBRARY / {view() === 'grid' ? 'COLLECTION' : 'LOUPE'}</div>
            <h1>
              {title()}
              <span>{total().toLocaleString()}</span>
            </h1>
          </div>
          <div class="heading-actions">
            <button
              class="button"
              onClick={() => (desktop ? scan() : fileInput.click())}
              disabled={!!busy()}
            >
              <Icon name={desktop ? 'refresh' : 'plus'} size={16} />
              {desktop ? '扫描' : '载入图片'}
            </button>
            <button
              class="button primary"
              onClick={() => (desktop ? setDialog('import') : fileInput.click())}
              disabled={!!busy()}
            >
              <Icon name="card" size={16} />
              导入
            </button>
          </div>
        </div>
        <div class="library-toolbar">
          <div class="search-field">
            <Icon name="search" size={16} />
            <input
              ref={searchInput}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索文件名或元数据…"
              aria-label="搜索照片"
            />
            <Show when={query()}>
              <button class="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}>
                <Icon name="close" size={13} />
              </button>
            </Show>
          </div>
          <select
            class="rating-filter"
            value={rating()}
            onChange={(event) => setRating(Number(event.currentTarget.value))}
            aria-label="最低评级筛选"
          >
            <option value="0">所有评级</option>
            <option value="1">★ 及以上</option>
            <option value="2">★★ 及以上</option>
            <option value="3">★★★ 及以上</option>
            <option value="4">★★★★ 及以上</option>
            <option value="5">★★★★★</option>
          </select>
          <div class="toolbar-spacer" />
          <div class="segmented view-toggle">
            <button
              classList={{ active: view() === 'grid' }}
              aria-label="网格视图（G）"
              aria-pressed={view() === 'grid'}
              onClick={() => setView('grid')}
            >
              <Icon name="grid" size={16} />
            </button>
            <button
              classList={{ active: view() === 'viewer' }}
              aria-label="单图视图（E）"
              aria-pressed={view() === 'viewer'}
              onClick={() => setView('viewer')}
              disabled={!selected()}
            >
              <Icon name="photo" size={16} />
            </button>
          </div>
        </div>
        <Show when={error()}>
          <div class="banner error" role="alert">
            <Icon name="info" size={17} />
            <span>{error()}</span>
            <button class="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
        <Show when={notice()}>
          <div class="banner success" role="status">
            <Icon name="check" size={17} />
            <span>{notice()}</span>
            <button class="icon-button" aria-label="关闭完成提示" onClick={() => setNotice('')}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
        <Show when={!desktop && !assets().length && !query()}>
          <div class="demo-note">
            <span class="status-dot" />
            当前为浏览器体验：选择本地图片，可体验查看、评级、真实直方图与裁剪导出。
          </div>
        </Show>
        <Show
          when={assets().length > 0}
          fallback={
            <div class="empty-state">
              <div class="empty-art">
                <span class="empty-frame back" />
                <span class="empty-frame front">
                  <Icon name="photo" size={46} />
                  <i />
                </span>
                <span class="empty-orbit" />
              </div>
              <Show
                when={!loading()}
                fallback={
                  <>
                    <span class="spinner" />
                    <h2>正在打开你的图片库</h2>
                  </>
                }
              >
                <h2>{query() || rating() ? '没有找到匹配的影像' : '留住光影，从这里开始'}</h2>
                <p>
                  {query() || rating()
                    ? '尝试其他文件名，或降低评级筛选。'
                    : '将照片留在熟悉的位置，让索引、细节和每一次创作井然有序。'}
                </p>
                <Show
                  when={!query() && !rating()}
                  fallback={
                    <button
                      class="button"
                      onClick={() => {
                        setQuery('');
                        setRating(0);
                      }}
                    >
                      清除筛选
                    </button>
                  }
                >
                  <button
                    class="button primary"
                    onClick={() => (desktop ? setDialog('library') : fileInput.click())}
                  >
                    <Icon name="plus" size={17} />
                    {desktop ? '添加第一个图片库' : '选择本地图片'}
                  </button>
                  <div class="empty-features">
                    <span>
                      <Icon name="folder" size={15} />
                      本地优先
                    </span>
                    <span>
                      <Icon name="photo" size={15} />
                      RAW 与常见影像
                    </span>
                    <span>
                      <Icon name="crop" size={15} />
                      无损裁剪配方
                    </span>
                  </div>
                </Show>
              </Show>
            </div>
          }
        >
          <Show
            when={view() === 'grid'}
            fallback={
              <Show when={selected()}>
                {(asset) => (
                  <div class="loupe-layout">
                    <div class="loupe-toolbar">
                      <div>
                        <strong>{asset().filename}</strong>
                        <small>
                          {asset().kind === 'raw'
                            ? 'RAW 原始影像'
                            : asset().extension.toUpperCase()}
                          <Show when={asset().crop}> · 已裁剪</Show>
                        </small>
                      </div>
                      <div>
                        <button
                          class={`button small ${cropMode() ? 'active' : ''}`}
                          onClick={() => (cropMode() ? setCropMode(false) : beginCrop())}
                          disabled={!!busy()}
                        >
                          <Icon name="crop" size={15} />
                          {cropMode() ? '退出裁剪' : '裁剪'}
                        </button>
                        <button
                          class="button small"
                          onClick={exportImage}
                          disabled={!!busy() || cropMode()}
                        >
                          <Icon name="export" size={15} />
                          导出
                        </button>
                      </div>
                    </div>
                    <PhotoView
                      asset={asset()}
                      cropMode={cropMode()}
                      crop={crop()}
                      setCrop={setCrop}
                      onPrevious={() => move(-1)}
                      onNext={() => move(1)}
                      hasPrevious={selectedIndex() > 0}
                      hasNext={selectedIndex() < sortedAssets().length - 1}
                    />
                    <div class="filmstrip" aria-label="照片胶片条">
                      <For each={sortedAssets()}>
                        {(item) => (
                          <Thumbnail
                            asset={item}
                            selected={item.id === selectedId()}
                            compact
                            onSelect={() => {
                              if (!cropMode()) select(item);
                            }}
                            onOpen={() => {
                              if (!cropMode()) select(item, true);
                            }}
                          />
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </Show>
            }
          >
            <div class="collection-subtoolbar">
              <span>
                {loading() ? '正在更新索引…' : `${assets().length.toLocaleString()} 张已载入`}
              </span>
              <div>
                <select
                  value={sort()}
                  onChange={(e) => setSort(e.currentTarget.value)}
                  aria-label="已载入照片排序"
                >
                  <option value="newest">修改时间 ↓</option>
                  <option value="name">文件名 A—Z</option>
                  <option value="rating">评级优先</option>
                </select>
                <Icon name="grid" size={13} />
                <input
                  type="range"
                  min="150"
                  max="320"
                  step="10"
                  value={thumbSize()}
                  onInput={(e) => setThumbSize(Number(e.currentTarget.value))}
                  aria-label="缩略图大小"
                />
              </div>
            </div>
            <div class="collection-scroll">
              <div class="photo-grid" style={{ '--thumbnail-size': `${thumbSize()}px` }}>
                <For each={sortedAssets()}>
                  {(asset) => (
                    <Thumbnail
                      asset={asset}
                      selected={selectedId() === asset.id}
                      onSelect={() => select(asset)}
                      onOpen={() => select(asset, true)}
                    />
                  )}
                </For>
              </div>
              <Show when={assets().length < total()}>
                <div class="load-more">
                  <button class="button" onClick={() => loadAssets(true)} disabled={loading()}>
                    载入更多（{assets().length} / {total()}）
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
        <footer class="main-status">
          <span>
            <Show when={busy() || loading()} fallback={<span class="status-dot" />}>
              <span class="spinner small" />
            </Show>
            {busy() || (loading() ? '正在读取图片…' : '就绪')}
          </span>
          <span>
            {selected()
              ? `${selectedIndex() + 1} / ${assets().length} · ${bytes(selected()!.size)}`
              : '原始文件保持不变'}
            <kbd>G</kbd> 网格 <kbd>E</kbd> 单图
          </span>
        </footer>
      </main>
      <aside class="inspector">
        <div class="inspector-heading">
          <span>影像信息</span>
          <Icon name="settings" size={16} />
        </div>
        <Show
          when={selected()}
          fallback={
            <div class="inspector-empty">
              <Icon name="info" size={27} />
              <p>
                选择照片后，在这里查看
                <br />
                参数、EXIF 与直方图。
              </p>
              <span>每一束光，都有迹可循。</span>
            </div>
          }
        >
          {(asset) => (
            <>
              <div class="inspector-file">
                <span class="inspector-filetype">
                  {asset().kind === 'raw' ? 'RAW' : asset().extension.toUpperCase()}
                </span>
                <h2 title={asset().filename}>{asset().filename}</h2>
                <p>
                  {asset().width && asset().height
                    ? `${asset().width} × ${asset().height} px`
                    : '尺寸待解析'}
                  <span>·</span>
                  {bytes(asset().size)}
                </p>
                <div class="rating-stars" aria-label="照片评级">
                  <For each={[1, 2, 3, 4, 5]}>
                    {(value) => (
                      <button
                        classList={{ filled: asset().rating >= value }}
                        onClick={() => rate(value)}
                        disabled={!!busy()}
                        aria-label={`评为 ${value} 星`}
                        aria-pressed={asset().rating === value}
                      >
                        <Icon name="star" size={19} />
                      </button>
                    )}
                  </For>
                  <button
                    class="clear-rating"
                    onClick={() => rate(0)}
                    disabled={!asset().rating || !!busy()}
                    aria-label="清除评级"
                  >
                    清除
                  </button>
                </div>
              </div>
              <section class="inspector-section histogram-section">
                <div class="section-title">
                  <h3>直方图</h3>
                  <span>RGB</span>
                </div>
                <div class="histogram">
                  <Show
                    when={histogram()?.data && !histogram.loading}
                    fallback={
                      <div class="histogram-empty">
                        {histogram.loading ? '正在计算像素分布…' : '该影像暂不支持直方图'}
                      </div>
                    }
                  >
                    <svg
                      viewBox="0 0 255 80"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label="当前图片 RGB 直方图"
                    >
                      <path class="hist-red" d={histogramPath(histogram()!.data!.red, ceiling())} />
                      <path
                        class="hist-green"
                        d={histogramPath(histogram()!.data!.green, ceiling())}
                      />
                      <path
                        class="hist-blue"
                        d={histogramPath(histogram()!.data!.blue, ceiling())}
                      />
                    </svg>
                  </Show>
                </div>
                <div class="histogram-axis">
                  <span>0</span>
                  <i />
                  <span>255</span>
                </div>
                <p class="histogram-source" title={histogram()?.error || ''}>
                  {histogram()?.data?.source ||
                    histogram()?.error ||
                    '显示渲染值，非传感器原始数据'}
                </p>
              </section>
              <Show when={cropMode()}>
                <section class="inspector-section crop-panel">
                  <div class="section-title">
                    <h3>裁剪</h3>
                    <span>非破坏编辑</span>
                  </div>
                  <p class="muted">拖动画面选区，或输入百分比。</p>
                  <div class="crop-inputs">
                    <For each={['x', 'y', 'width', 'height'] as const}>
                      {(key) => (
                        <label>
                          {{ x: '左侧', y: '顶部', width: '宽度', height: '高度' }[key]}
                          <div>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.1"
                              value={Number((crop()[key] * 100).toFixed(1))}
                              onInput={(e) =>
                                setCrop((value) => ({
                                  ...value,
                                  [key]: Number(e.currentTarget.value) / 100,
                                }))
                              }
                            />
                            <span>%</span>
                          </div>
                        </label>
                      )}
                    </For>
                  </div>
                  <Show when={!validCrop(crop())}>
                    <p class="form-error">区域必须位于图像内，宽高大于 0。</p>
                  </Show>
                  <div class="crop-actions">
                    <button class="button" onClick={() => setCrop({ ...fullCrop })}>
                      全图
                    </button>
                    <button
                      class="button primary"
                      onClick={saveCrop}
                      disabled={!validCrop(crop()) || !!busy()}
                    >
                      保存裁剪
                    </button>
                  </div>
                </section>
              </Show>
              <section class="inspector-section">
                <div class="section-title">
                  <h3>拍摄参数</h3>
                  <span>EXIF</span>
                </div>
                <Show
                  when={Object.keys(asset().metadata).length > 0}
                  fallback={
                    <p class="metadata-empty">
                      未读取到 EXIF 信息。
                      {!desktop
                        ? '浏览器演示不解析 EXIF，桌面端读取文件元数据。'
                        : '文件可能不含可用元数据，或此格式暂不支持解析。'}
                    </p>
                  }
                >
                  <dl class="metadata">
                    <For each={Object.entries(asset().metadata)}>
                      {([key, value]) => (
                        <>
                          <dt>
                            {(
                              {
                                Camera: '相机',
                                Make: '品牌',
                                Model: '型号',
                                Lens: '镜头',
                                ISO: 'ISO',
                                Aperture: '光圈',
                                ExposureTime: '快门',
                                Shutter: '快门',
                                FocalLength: '焦距',
                                DateTimeOriginal: '拍摄时间',
                                DateTime: '时间',
                                Orientation: '方向',
                                ColorSpace: '色彩空间',
                                Software: '软件',
                              } as Record<string, string>
                            )[key] || key}
                          </dt>
                          <dd>{value}</dd>
                        </>
                      )}
                    </For>
                  </dl>
                </Show>
              </section>
              <section class="inspector-section">
                <div class="section-title">
                  <h3>文件详情</h3>
                </div>
                <dl class="metadata">
                  <dt>格式</dt>
                  <dd>{asset().extension.toUpperCase()}</dd>
                  <dt>修改时间</dt>
                  <dd>{formatDate(asset().modified_at)}</dd>
                  <dt>可用状态</dt>
                  <dd>{asset().availability === 'available' ? '可访问' : asset().availability}</dd>
                  <dt>文件路径</dt>
                  <dd class="path-value" title={asset().path}>
                    {asset().path}
                  </dd>
                </dl>
                <Show when={asset().crop}>
                  <div class="saved-crop">
                    <Icon name="crop" size={15} />
                    <span>已保存裁剪配方</span>
                    <button onClick={resetCrop} disabled={!!busy()}>
                      重置
                    </button>
                  </div>
                </Show>
              </section>
              <div class="inspector-actions">
                <button class="button" onClick={beginCrop} disabled={!!busy()}>
                  <Icon name="crop" size={16} />
                  裁剪
                </button>
                <button class="button" onClick={exportImage} disabled={!!busy() || cropMode()}>
                  <Icon name="export" size={16} />
                  导出 JPEG
                </button>
              </div>
            </>
          )}
        </Show>
      </aside>
      <Show when={dialog() === 'library'}>
        <LibraryDialog
          onClose={() => setDialog(null)}
          onAdded={(library) => {
            setLibraries((items) => [...items, library]);
            setLibraryId(library.id);
            setDialog(null);
            void scan(library);
          }}
        />
      </Show>
      <Show when={dialog() === 'storage'}>
        <StorageDialog
          existing={editingStorage()}
          onClose={() => setDialog(null)}
          onAdded={(storage) => {
            setStorages((items) => [...items.filter((s) => s.id !== storage.id), storage]);
            setDialog(null);
            setRemote(storage);
          }}
        />
      </Show>
      <Show when={remote()}>
        {(storage) => (
          <StorageBrowser
            storage={storage()}
            onClose={() => setRemote(undefined)}
            onEdit={() => openStorageSettings(storage())}
          />
        )}
      </Show>
      <Show when={dialog() === 'import'}>
        <ImportDialog
          onClose={() => setDialog(null)}
          onImported={() => setNotice('导入任务已完成处理。请查看逐文件结果，并扫描目标图片库。')}
        />
      </Show>
      <Show when={dialog() === 'about'}>
        <Modal
          title="Nebulume"
          subtitle="为光影留一处井然有序的空间。"
          onClose={() => setDialog(null)}
        >
          <div class="about-content">
            <span class="version-pill">0.1.0 Alpha · {desktop ? '桌面模式' : '浏览器演示'}</span>
            <p>本地优先的跨平台影像管理工作台。原片与文件夹由你管理，图库索引记录评级与裁剪。</p>
            <h3>当前能力</h3>
            <p>
              {desktop
                ? '本地图库、影像索引、EXIF、显示直方图、裁剪导出、SD 卡文件夹导入与 WebDAV / S3 按需下载。RAW 支持取决于文件格式与当前解码器，无法解码时会明确报错。'
                : '浏览器通过你选择的真实图片提供查看、评级、直方图、裁剪与 JPEG 下载。数据只保留在当前会话。EXIF、RAW、持久图库与存储连接需要桌面版。'}
            </p>
            <Show when={system()}>
              <details>
                <summary>运行时能力详情</summary>
                <pre>{JSON.stringify(system(), null, 2)}</pre>
              </details>
            </Show>
            <h3>快捷键</h3>
            <div class="keyboard-list">
              <span>网格 / 单图</span>
              <span>
                <kbd>G</kbd> / <kbd>E</kbd>
              </span>
              <span>上一张 / 下一张</span>
              <span>
                <kbd>←</kbd> / <kbd>→</kbd>
              </span>
              <span>评级 / 清除评级</span>
              <span>
                <kbd>1—5</kbd> / <kbd>0</kbd>
              </span>
              <span>进入裁剪 / 退出</span>
              <span>
                <kbd>C</kbd> / <kbd>Esc</kbd>
              </span>
              <span>搜索</span>
              <span>
                <kbd>Ctrl / ⌘ F</kbd>
              </span>
            </div>
          </div>
          <footer class="modal-footer">
            <button class="button primary" onClick={() => setDialog(null)}>
              返回影像
            </button>
          </footer>
        </Modal>
      </Show>
      <Show when={dialog() === 'history'}>
        <Modal
          title="导入记录"
          subtitle="在本机保存的导入任务结果。"
          onClose={() => setDialog(null)}
          wide
        >
          <div class="history-list">
            <For
              each={history()}
              fallback={
                <div class="table-empty">
                  还没有导入记录。从 SD 卡或文件夹导入后，记录会显示在这里。
                </div>
              }
            >
              {(item) => (
                <article>
                  <div>
                    <Icon name="card" />
                    <strong>{String(item.destination || item.id || '导入任务')}</strong>
                    <span>{String(item.status || '')}</span>
                  </div>
                  <p>
                    {formatDate(String(item.started_at || item.created_at || ''))} · 已复制{' '}
                    {String(item.copied ?? 0)} · 失败 {String(item.failed ?? 0)}
                  </p>
                </article>
              )}
            </For>
          </div>
          <footer class="modal-footer">
            <button class="button" onClick={() => setDialog(null)}>
              关闭
            </button>
          </footer>
        </Modal>
      </Show>
    </div>
  );
}

function formatDate(value: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { hour12: false });
}
