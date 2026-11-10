import { For, Show, createSignal } from 'solid-js';
import Icon from './Icon';
import OverflowMenu from './OverflowMenu';
import { IconButton, StatusDot } from './ui';
import type { MenuEntry } from './ui';
import type { FolderNode, Library, LibraryFolders } from './model';

export type FolderAction = 'cull' | 'overview' | 'export-picks' | 'scan';

/** Libraries, and the open library's folders as a tree. Choosing a folder scopes every view. */
export default function LibrarySidebar(props: {
  libraries: Library[];
  currentId?: string;
  folder: string;
  folders?: LibraryFolders;
  usable: (library: Library) => boolean;
  unavailableLabel: (library: Library) => string;
  location: (library: Library) => string;
  demoLabel?: boolean;
  onLibrary: (library: Library) => void;
  onFolder: (path: string) => void;
  onFolderAction: (action: FolderAction, path: string) => void;
  onAddLibrary: () => void;
  /** Actions for one library (settings, scan, previews, capture time, fingerprint, remove). */
  libraryMenu: (library: Library) => MenuEntry[];
  /** The all-libraries overview is open. */
  overviewOpen?: boolean;
  onOverview: () => void;
}) {
  // Folders the user collapsed; everything starts expanded one level down.
  const [closed, setClosed] = createSignal<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = createSignal<{ path: string; x: number; y: number }>();
  const toggle = (path: string) =>
    setClosed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const isOpen = (node: FolderNode, depth: number) =>
    node.children.length > 0 &&
    (depth === 0 ? !closed().has(node.path) : closed().has('+' + node.path));
  const toggleNode = (node: FolderNode, depth: number) =>
    toggle(depth === 0 ? node.path : '+' + node.path);
  function openMenu(event: MouseEvent, path: string) {
    event.stopPropagation();
    const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ path, x: anchor.right + 4, y: anchor.top - 4 });
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>('.folder-menu button')?.focus(),
    );
  }
  const Node = (nodeProps: { node: FolderNode; depth: number }) => {
    const node = () => nodeProps.node;
    const open = () => isOpen(node(), nodeProps.depth);
    return (
      <li
        role="treeitem"
        aria-expanded={node().children.length ? open() : undefined}
        aria-selected={props.folder === node().path}
      >
        <div
          class="tree-row"
          classList={{ current: props.folder === node().path }}
          style={{ '--depth': nodeProps.depth + 1 }}
        >
          <button
            class="tree-chevron"
            classList={{ open: open(), none: !node().children.length }}
            tabindex="-1"
            aria-hidden="true"
            onClick={() => toggleNode(node(), nodeProps.depth)}
          >
            <Icon name="right" size={13} />
          </button>
          <button
            class="tree-label"
            onClick={() => props.onFolder(props.folder === node().path ? '' : node().path)}
          >
            <Icon name="folder" size={15} />
            <span class="tree-name">{node().name}</span>
            <span class="tree-count">{node().count}</span>
          </button>
          <button
            class="tree-more"
            aria-label={`${node().name} 的操作`}
            onClick={(event) => openMenu(event, node().path)}
          >
            <Icon name="more" size={15} />
          </button>
        </div>
        <Show when={open()}>
          <ul role="group">
            <For each={node().children}>
              {(child) => <Node node={child} depth={nodeProps.depth + 1} />}
            </For>
          </ul>
        </Show>
      </li>
    );
  };
  const act = (action: FolderAction) => {
    const target = menu();
    setMenu(undefined);
    if (target) props.onFolderAction(action, target.path);
  };
  return (
    <aside class="library-sidebar" aria-label="图片库与文件夹">
      <SidebarResizer />
      <div class="library-sidebar-head">
        <span>图片库</span>
        <Show when={props.demoLabel}>
          <span class="demo-label">浏览器演示</span>
        </Show>
        <IconButton size="xs" icon="plus" label="添加图片库" onClick={() => props.onAddLibrary()} />
      </div>
      <ul class="nav-library-list" aria-label="图片库列表">
        <For each={props.libraries}>
          {(library) => (
            <li>
              <div class={`nav-library-row ${props.currentId === library.id ? 'active' : ''}`}>
                <button
                  class={`nav-library-item ${props.currentId === library.id ? 'active' : ''}`}
                  aria-current={props.currentId === library.id ? 'page' : undefined}
                  aria-label={`打开图片库 ${library.name}，${props.unavailableLabel(library)}`}
                  title={props.location(library)}
                  onClick={() =>
                    props.currentId === library.id ? props.onFolder('') : props.onLibrary(library)
                  }
                >
                  <Icon
                    name={
                      library.source_kind && library.source_kind !== 'local'
                        ? 'server'
                        : 'device-laptop'
                    }
                    size={16}
                  />
                  <span class="nav-library-name">{library.name}</span>
                  <StatusDot
                    state={
                      props.usable(library)
                        ? library.availability === 'online'
                          ? 'ok'
                          : 'off'
                        : 'bad'
                    }
                    label={props.unavailableLabel(library)}
                  />
                </button>
                <span class="nav-library-more">
                  <OverflowMenu
                    size="xs"
                    label={`${library.name} 更多操作`}
                    items={props.libraryMenu(library)}
                  />
                </span>
              </div>
              <Show
                when={
                  props.currentId === library.id &&
                  props.folders?.library_id === library.id &&
                  props.folders.folders.length
                }
              >
                <ul class="folder-tree" role="tree" aria-label={`${library.name} 的文件夹`}>
                  <For each={props.folders!.folders}>
                    {(node) => <Node node={node} depth={0} />}
                  </For>
                </ul>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <div class="nav-library-all">
        <button
          type="button"
          class="nav-library-item"
          aria-current={props.overviewOpen ? 'page' : undefined}
          onClick={() => props.onOverview()}
        >
          <Icon name="layout-grid" size={16} />
          <span class="nav-library-name">全部图片库</span>
          <span class="tree-count">{props.libraries.length}</span>
        </button>
      </div>
      <Show when={menu()}>
        {(open) => (
          <>
            <button
              class="menu-scrim"
              aria-label="关闭文件夹操作"
              tabindex="-1"
              onClick={() => setMenu(undefined)}
            />
            <div
              class="folder-menu"
              role="menu"
              style={{ left: `${open().x}px`, top: `${open().y}px` }}
              onKeyDown={(event) => event.key === 'Escape' && setMenu(undefined)}
            >
              <button role="menuitem" onClick={() => act('cull')}>
                <Icon name="check" size={15} />
                从这里开始选片
              </button>
              <button role="menuitem" onClick={() => act('overview')}>
                <Icon name="grid" size={15} />
                查看概览
              </button>
              <button role="menuitem" onClick={() => act('export-picks')}>
                <Icon name="export" size={15} />
                导出这里的留用…
              </button>
              <button role="menuitem" onClick={() => act('scan')}>
                <Icon name="refresh" size={15} />
                扫描更新
              </button>
            </div>
          </>
        )}
      </Show>
    </aside>
  );
}

const SIDEBAR_KEY = 'nebulume.sidebar-width';
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const clampWidth = (value: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)));

function applyWidth(value: number) {
  document.documentElement.style.setProperty('--nl-sidebar-live', `${value}px`);
}
function savedWidth() {
  try {
    const value = Number(localStorage.getItem(SIDEBAR_KEY));
    return Number.isFinite(value) && value > 0 ? clampWidth(value) : undefined;
  } catch {
    return undefined;
  }
}
const initial = savedWidth();
if (initial) applyWidth(initial);

/** The sidebar's right edge: drag (or use ← →) to resize; double-click resets. */
function SidebarResizer() {
  let handle!: HTMLDivElement;
  const current = () => (handle.parentElement as HTMLElement).getBoundingClientRect().width;
  const set = (value: number) => {
    const next = clampWidth(value);
    applyWidth(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, String(next));
    } catch {
      /* Width applies to this window only. */
    }
    handle.setAttribute('aria-valuenow', String(next));
  };
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = current();
    handle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('nl-resizing');
    const move = (next: PointerEvent) => set(startWidth + next.clientX - startX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('nl-resizing');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  return (
    <div
      ref={handle}
      class="library-sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整侧栏"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={initial ?? 220}
      tabIndex={0}
      onPointerDown={pointerDown}
      onDblClick={() => {
        document.documentElement.style.removeProperty('--nl-sidebar-live');
        try {
          localStorage.removeItem(SIDEBAR_KEY);
        } catch {
          /* Nothing saved. */
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        set(current() + (event.key === 'ArrowRight' ? 16 : -16));
      }}
    />
  );
}
