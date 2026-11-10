import { For, Show, type JSX } from 'solid-js';
import BrandMark from './BrandMark';
import Icon, { type IconName } from './Icon';
import type { WorkspaceSection } from './workspace';
import './AppShell.css';

const SECTIONS: readonly { id: WorkspaceSection; label: string; icon: IconName }[] = [
  { id: 'libraries', label: '图片库', icon: 'photo' },
  { id: 'cards', label: '导入', icon: 'download' },
  { id: 'sources', label: '位置', icon: 'server' },
];

/**
 * The window frame: icon rail (sections on top, 打开文件… and settings at the bottom), the
 * optional library sidebar, and the workspace. Below 960px the rail becomes a drawer opened
 * from a compact title bar; the owner keeps the open state and the focus trap.
 */
export default function AppShell(props: {
  section: WorkspaceSection;
  /** The section whose rail item is marked current (none while a library is open). */
  current?: WorkspaceSection;
  onSection: (section: WorkspaceSection) => void;
  onOpenFile: () => void;
  openFileDisabled?: boolean;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onCloseDrawer: () => void;
  drawerButtonRef: (el: HTMLButtonElement) => void;
  railRef: (el: HTMLElement) => void;
  sidebar?: JSX.Element;
  children: JSX.Element;
}) {
  const item = (entry: { id: WorkspaceSection; label: string; icon: IconName }) => (
    <button
      type="button"
      class={`nl-rail-item workspace-nav-item${props.current === entry.id ? ' active' : ''}`}
      aria-label={entry.label}
      aria-current={props.current === entry.id ? 'page' : undefined}
      data-tooltip={entry.label}
      data-tip-side="right"
      onClick={() => props.onSection(entry.id)}
    >
      <Icon name={entry.icon} size={20} />
      <span class="nl-rail-label">{entry.label}</span>
    </button>
  );
  return (
    <div
      class={`nl-shell${props.drawerOpen ? ' nav-open' : ''}${props.sidebar ? '' : ' nl-shell--no-side'}`}
    >
      <header class="nl-titlebar manager-titlebar">
        <button
          ref={props.drawerButtonRef}
          type="button"
          class="nl-icon-btn nl-icon-btn--md navigation-toggle"
          aria-label={props.drawerOpen ? '关闭主导航' : '打开主导航'}
          aria-controls="manager-navigation"
          aria-expanded={props.drawerOpen}
          onClick={() => props.onToggleDrawer()}
        >
          <Icon name={props.drawerOpen ? 'close' : 'menu'} size={18} />
        </button>
        <div class="nl-brand">
          <BrandMark size={24} />
          <strong>Nebulume</strong>
        </div>
      </header>
      <Show when={props.drawerOpen}>
        <button
          class="nl-drawer-scrim-button navigation-scrim"
          aria-label="关闭主导航遮罩"
          tabindex="-1"
          onClick={() => props.onCloseDrawer()}
        />
      </Show>
      <nav
        id="manager-navigation"
        ref={props.railRef}
        class="nl-rail manager-navigation"
        aria-label="主导航"
      >
        <span class="nl-rail-mark" aria-hidden="true">
          <BrandMark size={24} />
        </span>
        <For each={SECTIONS}>{(entry) => item(entry)}</For>
        <span class="nl-rail-spacer" />
        <button
          type="button"
          class="nl-rail-item workspace-nav-item rail-open"
          aria-label="打开文件…"
          data-tooltip="打开文件…"
          data-tip-side="right"
          disabled={props.openFileDisabled}
          onClick={() => props.onOpenFile()}
        >
          <Icon name="photo-plus" size={20} />
          <span class="nl-rail-label">打开文件…</span>
        </button>
        {item({ id: 'settings', label: '设置', icon: 'settings' })}
      </nav>
      {props.sidebar}
      {props.children}
    </div>
  );
}
