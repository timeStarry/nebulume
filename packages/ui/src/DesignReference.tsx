import { For, createSignal, type JSX } from 'solid-js';
import { resolvedTheme, setThemePreference } from './theme';
import { DEFAULT_OVERLAY, CORNER_LABELS, CORNERS } from './overlay-layout';
import { widgetById, type WidgetContext } from './viewer-widgets';
import type { Asset } from './model';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Chip,
  DataTable,
  EmptyState,
  Field,
  FloatingDock,
  Group,
  IconButton,
  Kbd,
  ListRow,
  MenuList,
  PageHeader,
  Progress,
  Radio,
  Segmented,
  Select,
  Slider,
  Spinner,
  SplitPage,
  StatusDot,
  Steps,
  Switch,
  TextInput,
  Toast,
  Toggle,
  Toolbar,
} from './ui';
import './DesignReference.css';

const sampleAsset = {
  id: 'sample',
  filename: 'DSC_0412.NEF',
  extension: 'nef',
  size: 24_600_000,
  rating: 4,
  flag: 'pick',
  width: 6240,
  height: 4160,
  captured_at: '2026-10-18T16:42:05',
  metadata: {
    Aperture: 'f/2.8',
    Exposure: '1/500 s',
    ISO: '200',
    'Focal Length': '35 mm',
    Camera: 'X-T5',
    Lens: 'XF 23mm F1.4',
  },
} as unknown as Asset;
const sampleHistogram = (() => {
  const curve = (shift: number) =>
    Array.from({ length: 256 }, (_, i) =>
      Math.round(
        400 * Math.exp(-(((i - 120 - shift) / 50) ** 2)) + 40 * Math.exp(-(((i - 40) / 20) ** 2)),
      ),
    );
  return {
    red: curve(18),
    green: curve(0),
    blue: curve(-22),
    luminance: curve(0),
    pixels: 1,
    source: 'sample',
  };
})();

function Section(props: { id: string; title: string; lead?: string; children: JSX.Element }) {
  return (
    <section class="ds-section" id={props.id}>
      <h2>{props.title}</h2>
      {props.lead && <p class="ds-lead">{props.lead}</p>}
      {props.children}
    </section>
  );
}
const Swatch = (props: { token: string; name: string }) => (
  <div class="ds-swatch">
    <span style={{ background: `var(${props.token})` }} />
    <b>{props.name}</b>
    <code>{props.token}</code>
  </div>
);

/** Development only: every design-system part in one place, so drift is visible. */
export default function DesignReference() {
  const [view, setView] = createSignal<'photos' | 'cull' | 'overview'>('photos');
  const [size, setSize] = createSignal(60);
  const [hide, setHide] = createSignal(true);
  const [on, setOn] = createSignal(true);
  const [check, setCheck] = createSignal(true);
  const [radio, setRadio] = createSignal('copy');
  const [layout, setLayout] = createSignal('date');
  const [name, setName] = createSignal('2026 旅行');
  const context: WidgetContext = {
    index: 12,
    total: 64,
    folder: 'Kyoto',
    histogram: sampleHistogram,
  };
  return (
    <div class="ds">
      <nav class="ds-nav" aria-label="目录">
        <b>Lumen 设计系统</b>
        <For
          each={[
            ['color', '颜色'],
            ['type', '文字'],
            ['controls', '按钮'],
            ['inputs', '输入与选择'],
            ['tags', '标签与状态'],
            ['lists', '分组列表'],
            ['overlays', '菜单与提示'],
            ['feedback', '进度与空状态'],
            ['layout', '页面结构'],
            ['widgets', '叠加部件'],
          ]}
        >
          {([id, label]) => <a href={`#${id}`}>{label}</a>}
        </For>
        <Segmented
          size="sm"
          label="主题"
          value={resolvedTheme()}
          onChange={(value) => setThemePreference(value)}
          options={[
            { value: 'dark', label: '深色' },
            { value: 'light', label: '浅色' },
          ]}
        />
      </nav>
      <main class="ds-main">
        <Section
          id="color"
          title="颜色"
          lead="表面从暗到亮四级，文字三级；状态色总与图标或文字同时出现。"
        >
          <div class="ds-swatches">
            <For
              each={[
                ['--nl-stage', '舞台'],
                ['--nl-rail', '图标栏'],
                ['--nl-side', '侧栏、分组'],
                ['--nl-canvas', '窗口'],
                ['--nl-raised', '浮起'],
                ['--nl-line', '分隔线'],
                ['--nl-text', '主要文字'],
                ['--nl-text-2', '次要文字'],
                ['--nl-text-3', '提示文字'],
                ['--nl-pick', '留用'],
                ['--nl-reject', '淘汰'],
                ['--nl-warn', '警告'],
                ['--nl-star', '星级'],
                ['--nl-info', '信息'],
              ]}
            >
              {([token, label]) => <Swatch token={token} name={label} />}
            </For>
          </div>
        </Section>
        <Section id="type" title="文字" lead="七级字号，只用 400 与 500。">
          <div class="ds-type">
            <For
              each={
                [
                  [22, 500, '图片库概览'],
                  [18, 500, '2026 旅行'],
                  [16, 500, '怎么整理'],
                  [14, 500, '缓存位置'],
                  [14, 400, '导入前会逐项核对。'],
                  [13, 400, 'DSC_0412.NEF · 24.6 MB'],
                  [12, 400, '已载入 64 / 1284 张'],
                  [11, 400, 'RAW · ⌘K'],
                ] as const
              }
            >
              {([px, weight, text]) => (
                <div>
                  <code>{`${px} / ${weight}`}</code>
                  <span style={{ 'font-size': `var(--nl-t-${px})`, 'font-weight': weight }}>
                    {text}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Section>
        <Section id="controls" title="按钮" lead="四种外观、三种尺寸；纯图标按钮有名称与悬停提示。">
          <div class="ds-row">
            <Button variant="primary" icon="download">
              开始导入
            </Button>
            <Button icon="refresh">扫描更新</Button>
            <Button variant="ghost">取消</Button>
            <Button variant="danger" icon="trash">
              移到废纸篓
            </Button>
            <Button variant="primary" disabled>
              不可用
            </Button>
            <Button busy>正在扫描</Button>
          </div>
          <div class="ds-row">
            <Button size="sm" variant="primary">
              小号主按钮
            </Button>
            <Button size="sm" icon="filter">
              筛选
            </Button>
            <Button size="lg" variant="primary">
              选择文件夹
            </Button>
            <IconButton icon="search" label="搜索" />
            <IconButton icon="info" label="信息" shortcut="I" pressed />
            <IconButton icon="more" label="更多" />
            <IconButton icon="plus" label="添加" size="sm" />
            <IconButton icon="close" label="关闭" size="xs" />
            <Kbd>⌘K</Kbd>
          </div>
        </Section>
        <Section id="inputs" title="输入与选择">
          <div class="ds-grid">
            <Field label="图片库名称" help="只用于显示，不改动文件夹。">
              {(id, describedBy) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              )}
            </Field>
            <Field label="搜索">
              {(id) => (
                <TextInput id={id} icon="search" placeholder="文件名、相机、镜头" shortcut="⌘F" />
              )}
            </Field>
            <Field label="缓存上限" error="至少 1 GB。">
              {(id) => <TextInput id={id} value="0" suffix="GB" invalid />}
            </Field>
            <Field label="文件夹">
              {(id) => (
                <Select
                  id={id}
                  value={layout()}
                  onChange={setLayout}
                  options={[
                    { value: 'date', label: '年 / 年-月-日' },
                    { value: 'month', label: '年 / 月' },
                    { value: 'keep', label: '保持原样' },
                  ]}
                />
              )}
            </Field>
            <div class="ds-col">
              <Segmented
                label="视图"
                value={view()}
                onChange={setView}
                options={[
                  { value: 'photos', label: '照片', icon: 'grid' },
                  { value: 'cull', label: '选片', icon: 'flag' },
                  { value: 'overview', label: '概览', icon: 'chart-bar' },
                ]}
              />
              <Segmented
                label="视图（紧凑）"
                compact
                size="sm"
                value={view()}
                onChange={setView}
                options={[
                  { value: 'photos', label: '照片', icon: 'grid' },
                  { value: 'cull', label: '选片', icon: 'flag' },
                  { value: 'overview', label: '概览', icon: 'chart-bar' },
                ]}
              />
            </div>
            <div class="ds-col">
              <Slider label="缩略图大小" min={0} max={100} value={size()} onInput={setSize} />
              <span class="ds-row-tight">
                <Switch label="自动监视文件夹" checked={on()} onChange={setOn} />
                自动监视文件夹
              </span>
            </div>
            <div class="ds-col">
              <Checkbox checked={check()} onChange={setCheck} help="RAW 与同目录同名 JPEG 合为一张">
                合并同名 RAW 与 JPEG
              </Checkbox>
              <Radio name="ds-mode" checked={radio() === 'copy'} onChange={() => setRadio('copy')}>
                复制到图片库
              </Radio>
              <Radio
                name="ds-mode"
                checked={radio() === 'place'}
                onChange={() => setRadio('place')}
              >
                原地建库
              </Radio>
            </div>
          </div>
        </Section>
        <Section id="tags" title="标签与状态">
          <div class="ds-row">
            <Chip label="相机：X-T5" onRemove={() => undefined} />
            <Chip label="10月18日" onRemove={() => undefined} />
            <Toggle pressed={hide()} onChange={setHide} icon="eye-off">
              隐藏淘汰
            </Toggle>
            <Badge>RAW</Badge>
            <Badge tone="pick" icon="check">
              留用
            </Badge>
            <Badge tone="reject" icon="close">
              淘汰
            </Badge>
            <Badge tone="warn">疑似重复</Badge>
            <Badge tone="info">网络存储</Badge>
            <StatusDot state="ok" label="在线" showLabel />
            <StatusDot state="off" label="未连接" showLabel />
            <StatusDot state="warn" label="需要登录" showLabel />
            <StatusDot state="bad" label="错误" showLabel />
          </div>
        </Section>
        <Section id="lists" title="分组列表" lead="设置、导入选项、位置与详情共用一种分组。">
          <div class="ds-grid ds-grid--2">
            <Group title="浏览与选片">
              <ListRow
                title="打标后自动下一张"
                description="留用、淘汰或打星后前进"
                control={<Switch label="打标后自动下一张" checked={on()} onChange={setOn} />}
              />
              <ListRow
                title="主题"
                control={
                  <Segmented
                    size="sm"
                    label="主题"
                    role="radiogroup"
                    value="dark"
                    onChange={() => undefined}
                    options={[
                      { value: 'light', label: '浅色' },
                      { value: 'dark', label: '深色' },
                      { value: 'system', label: '跟随系统' },
                    ]}
                  />
                }
              />
            </Group>
            <Group title="位置" meta="2 个">
              <ListRow
                nav
                leading="device-laptop"
                title="本机"
                description="/Users/me/Pictures"
                control={<StatusDot state="ok" label="在线" />}
              />
              <ListRow
                nav
                leading="server"
                title="家里的 NAS"
                description="WebDAV · 192.168.1.20"
                control={<Badge tone="warn">需要登录</Badge>}
              />
            </Group>
          </div>
        </Section>
        <Section id="overlays" title="菜单与提示">
          <div class="ds-grid">
            <MenuList
              label="示例菜单"
              onClose={() => undefined}
              items={[
                { label: '打开', icon: 'expand', shortcut: '↵', onSelect: () => undefined },
                { label: '在新窗口中打开', icon: 'app-window', onSelect: () => undefined },
                'separator',
                {
                  heading: '旗标',
                  label: '留用',
                  icon: 'check',
                  shortcut: 'P',
                  onSelect: () => undefined,
                },
                { label: '淘汰', icon: 'close', shortcut: 'X', onSelect: () => undefined },
                'separator',
                {
                  label: '移到废纸篓',
                  icon: 'trash',
                  shortcut: '⌘⌫',
                  danger: true,
                  onSelect: () => undefined,
                },
              ]}
            />
            <div class="ds-col">
              <Toast
                message="已把 3 张照片移到废纸篓"
                action={{ label: '撤销', run: () => undefined }}
              />
              <Toast tone="error" message="无法连接 NAS" onClose={() => undefined} />
              <Banner
                tone="warn"
                message="“Trip”不在图片库中。"
                detail="评级和旗标只保存在本机。"
                action={<Button size="sm">加入图片库</Button>}
              />
              <Banner
                tone="info"
                message="有 412 张新照片。"
                action={<Button size="sm">导入</Button>}
                onClose={() => undefined}
              />
            </div>
          </div>
        </Section>
        <Section id="feedback" title="进度与空状态">
          <div class="ds-grid">
            <div class="ds-col">
              <Steps label="导入步骤" steps={['设置', '核对', '完成']} current={1} />
              <Progress label="正在复制" value={0.52} />
              <Progress label="正在复制并校验…" />
              <span class="ds-row-tight">
                <Spinner />
                正在读取存储卡…
              </span>
            </div>
            <EmptyState
              icon="photo-plus"
              title="还没有图片库"
              description="选一个照片文件夹，或从存储卡导入。"
              actions={
                <>
                  <Button variant="primary">新建图片库</Button>
                  <Button>从存储卡导入</Button>
                </>
              }
            />
            <DataTable
              label="示例表格"
              columns={[
                { key: 'file', label: '文件' },
                { key: 'to', label: '去向' },
                { key: 'size', label: '大小', align: 'end' },
              ]}
              rows={[
                { file: 'DSC_0412.NEF', to: '2026/10-18', size: '24.6 MB' },
                { file: 'DSC_0413.NEF', to: '2026/10-18', size: '24.4 MB' },
              ]}
            />
          </div>
        </Section>
        <Section
          id="layout"
          title="页面结构"
          lead="56px 页头，44px 工具栏，内容为单栏或主栏加 300px 侧栏。"
        >
          <div class="ds-frame">
            <PageHeader
              title="2026 旅行"
              subtitle="1284 张"
              center={(narrow) => (
                <Segmented
                  compact={narrow}
                  label="视图"
                  value={view()}
                  onChange={setView}
                  options={[
                    { value: 'photos', label: '照片', icon: 'grid' },
                    { value: 'cull', label: '选片', icon: 'flag' },
                    { value: 'overview', label: '概览', icon: 'chart-bar' },
                  ]}
                />
              )}
              actions={
                <>
                  <Button icon="refresh">扫描更新</Button>
                  <IconButton icon="more" label="更多" />
                </>
              }
            />
            <Toolbar label="示例工具栏">
              <TextInput
                size="sm"
                icon="search"
                placeholder="搜索"
                shortcut="⌘F"
                wrapClass="ds-search"
              />
              <Button size="sm" variant="ghost" icon="filter">
                筛选
              </Button>
              <Chip label="相机：X-T5" onRemove={() => undefined} />
            </Toolbar>
            <FloatingDock inline label="批量操作示例">
              <span>已选 12 项</span>
              <Button size="sm" variant="ghost">
                留用
              </Button>
              <Button size="sm">导出…</Button>
            </FloatingDock>
            <SplitPage
              main={
                <Group title="主栏">
                  <ListRow title="内容" />
                </Group>
              }
              aside={<b>侧栏</b>}
              asideFooter={
                <Button variant="primary" size="lg">
                  主操作
                </Button>
              }
            />
          </div>
        </Section>
        <Section id="widgets" title="叠加部件" lead="默认布局，取自部件注册表。">
          <div class="ds-viewer">
            <For each={CORNERS}>
              {(corner) => (
                <div
                  class={`ds-corner ds-corner--${corner}`}
                  role="group"
                  aria-label={CORNER_LABELS[corner]}
                >
                  <For each={DEFAULT_OVERLAY[corner]}>
                    {(id) => {
                      const content = widgetById(id)?.render(sampleAsset, context);
                      return content ? (
                        <div class="nl-widget" data-widget={id}>
                          {content}
                        </div>
                      ) : null;
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Section>
      </main>
    </div>
  );
}
