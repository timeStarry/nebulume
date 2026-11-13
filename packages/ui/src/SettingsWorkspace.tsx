import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import {
  desktop,
  execute,
  readPregenerate,
  writePregenerate,
  readWatchLibraries,
  watchLibraries,
  writeWatchLibraries,
} from './api';
import type { XmpPolicy } from './model';
import {
  DataTable,
  Group,
  Kbd,
  ListRow,
  PageHeader,
  Segmented,
  Select,
  SinglePage,
  Switch,
} from './ui';
import { readAutoAdvance, writeAutoAdvance } from './culling';
import { readOverlayFades, writeOverlayFades } from './overlay-layout';
import { setThemePreference, themeNotice, themePreference, type ThemePreference } from './theme';
import { motionPreference, setMotionPreference, type MotionPreference } from './motion';
import CacheSettings from './CacheSettings';
import { AboutPanel } from './UpdatePanel';
import { SHORTCUT_GROUPS } from './keymap';
import type { WorkspaceSection } from './workspace';

function CullingSettings() {
  const [auto, setAuto] = createSignal(readAutoAdvance());
  const [pregenerate, setPregenerate] = createSignal(readPregenerate());
  const [watching, setWatching] = createSignal(readWatchLibraries());
  const [fades, setFades] = createSignal(readOverlayFades(localStorage));
  const [xmpAutoWrite, setXmpAutoWrite] = createSignal(false);
  onMount(() => {
    void execute<XmpPolicy>('xmp.policy.get')
      .then((res) => setXmpAutoWrite(!!res?.auto_write))
      .catch(() => undefined);
  });
  return (
    <Group title="浏览与选片">
      <ListRow
        title="打标后自动下一张"
        description="选片时打星或打旗后，确认动效结束即前进。查看器顶栏可随时切换。"
        control={
          <Switch
            label="打标后自动下一张"
            checked={auto()}
            onChange={(value) => {
              setAuto(value);
              writeAutoAdvance(value);
            }}
          />
        }
      />
      <ListRow
        title="叠加信息随工具栏淡出"
        description="关闭时四角信息一直显示，按 D 隐藏或显示。"
        control={
          <Switch
            label="叠加信息随工具栏淡出"
            checked={fades()}
            onChange={(value) => {
              setFades(value);
              writeOverlayFades(localStorage, value);
            }}
          />
        }
      />
      <ListRow
        title="自动同步 .xmp 伴随文件"
        description="修改本地照片的星级、旗标或裁剪时自动无损更新同名 .xmp（完整保留 Lightroom / Camera Raw 原有显影参数，绝不改动原片）。"
        control={
          <Switch
            label="自动同步 .xmp 伴随文件"
            checked={xmpAutoWrite()}
            onChange={(value) => {
              setXmpAutoWrite(value);
              void execute('xmp.policy.set', { auto_write: value }).catch(() =>
                setXmpAutoWrite(!value),
              );
            }}
          />
        }
      />
      <Show when={desktop}>
        <ListRow
          title="扫描后预生成缩略图"
          description="扫描本地图片库后在后台按当前网格尺寸渲染缩略图，首次浏览更快。不下载远端照片，空间计入缓存上限。"
          control={
            <Switch
              label="扫描后预生成缩略图"
              checked={pregenerate()}
              onChange={(value) => {
                setPregenerate(value);
                writePregenerate(value);
              }}
            />
          }
        />
        <ListRow
          title="自动更新本地图片库"
          description="文件新增、删除、移动或改名后约 3 秒重新索引，评级与裁剪随照片保留。网络存储不受影响。"
          control={
            <Switch
              label="自动更新本地图片库"
              checked={watching()}
              onChange={(value) => {
                setWatching(value);
                writeWatchLibraries(value);
                void watchLibraries(value).catch(() => undefined);
              }}
            />
          }
        />
      </Show>
    </Group>
  );
}
const SETTINGS_SECTIONS = [
  { id: 'settings-appearance', label: '外观与浏览' },
  { id: 'settings-cache', label: '缓存与离线' },
  { id: 'settings-shortcuts', label: '快捷键' },
  { id: 'settings-about', label: '关于' },
] as const;
/** Settings holds only app-wide preferences and this machine's resources.
 *  Everything owned by a location, library, card or preset is edited where it lives. */
export default function Settings(props: {
  system?: Record<string, unknown>;
  onNavigate?: (section: WorkspaceSection) => void;
}) {
  const fromHash = () =>
    SETTINGS_SECTIONS.find((section) => location.hash === `#${section.id}`)?.id ??
    SETTINGS_SECTIONS[0].id;
  const [current, setCurrent] = createSignal<string>(fromHash());
  onMount(() => {
    const syncHash = () => setCurrent(fromHash());
    window.addEventListener('hashchange', syncHash);
    onCleanup(() => window.removeEventListener('hashchange', syncHash));
  });
  function choose(id: string) {
    setCurrent(id);
    history.replaceState(null, '', `#${id}`);
  }
  return (
    <section class="settings-workspace" aria-label="设置工作区">
      <PageHeader
        title="设置"
        center={(narrow) => (
          <Segmented
            size="sm"
            label="设置分组"
            compact={false}
            class={narrow ? 'settings-tabs--narrow' : undefined}
            value={current()}
            onChange={choose}
            options={SETTINGS_SECTIONS.map((section) => ({
              value: section.id,
              label: section.label,
            }))}
          />
        )}
      />
      <SinglePage class="settings-page">
        <Show when={current() === 'settings-appearance'}>
          <div id="settings-appearance" class="settings-group">
            <Group title="外观">
              <ListRow
                title="外观主题"
                labelFor="appearance-theme"
                description={themeNotice() || undefined}
                control={
                  <Select
                    id="appearance-theme"
                    size="sm"
                    value={themePreference()}
                    onChange={(value) => setThemePreference(value as ThemePreference)}
                    options={[
                      { value: 'dark', label: '深色' },
                      { value: 'light', label: '浅色' },
                      { value: 'system', label: '跟随系统' },
                    ]}
                  />
                }
              />
              <ListRow
                title="界面动效"
                labelFor="appearance-motion"
                description="完整包含弹簧回弹与照片放大转场；标准只保留淡入与滑动；减少则全部即时切换。动效只作用于少量元素，不影响网格滚动。"
                control={
                  <Select
                    id="appearance-motion"
                    size="sm"
                    value={motionPreference()}
                    onChange={(value) => setMotionPreference(value as MotionPreference)}
                    options={[
                      { value: 'system', label: '跟随系统' },
                      { value: 'full', label: '完整' },
                      { value: 'standard', label: '标准' },
                      { value: 'reduced', label: '减少' },
                    ]}
                  />
                }
              />
            </Group>
            <CullingSettings />
          </div>
        </Show>
        <Show when={current() === 'settings-cache'}>
          <div id="settings-cache" class="settings-group">
            <CacheSettings />
          </div>
        </Show>
        <Show when={current() === 'settings-shortcuts'}>
          <div id="settings-shortcuts" class="settings-group">
            <For each={SHORTCUT_GROUPS}>
              {(group) => (
                <Group title={group.title} plain>
                  <DataTable
                    label={group.title}
                    columns={[
                      { key: 'what', label: '操作', render: (row: [string, string]) => row[0] },
                      {
                        key: 'keys',
                        label: '按键',
                        align: 'end',
                        render: (row: [string, string]) => <Kbd>{row[1]}</Kbd>,
                      },
                    ]}
                    rows={group.rows}
                  />
                </Group>
              )}
            </For>
          </div>
        </Show>
        <Show when={current() === 'settings-about'}>
          <div id="settings-about" class="settings-group">
            <AboutPanel system={props.system} />
          </div>
        </Show>
      </SinglePage>
    </section>
  );
}
