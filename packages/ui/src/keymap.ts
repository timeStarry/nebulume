/**
 * The single list of keyboard shortcuts. The settings page renders it; Tooltips and
 * `aria-keyshortcuts` should read their keys from `KEYS` so the two never drift.
 * Shown with ⌘; on Windows and Linux the same keys use Ctrl.
 */
export type ShortcutGroup = { title: string; rows: [string, string][] };

export const KEYS = {
  info: 'I',
  overlay: 'D',
  crop: 'C',
  focus: 'Shift+F',
  zoom: 'Z',
  clipping: 'J',
  rawMode: 'R',
  sidebar: '⌘B',
  quickPreview: 'Space',
  close: 'Esc',
  undo: '⌘Z',
  trash: '⌘⌫',
  search: '⌘F',
} as const;

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '图片库网格',
    rows: [
      ['快速预览 / 打开照片', 'Space / Enter / 双击'],
      ['移动焦点（左右 / 上下一行）', '← → ↑ ↓'],
      ['首张 / 末张 / 翻一屏', 'Home / End / PgUp PgDn'],
      ['范围选择 / 增减选择 / 全选当前筛选', 'Shift 点击 / ⌘ 点击 / ⌘ A'],
      ['评级 / 清除评级（作用于所选）', '1–5 / 0'],
      ['留用 / 淘汰 / 清除旗标（作用于所选）', 'P / X / U'],
      ['移到废纸篓', '⌘ ⌫'],
      ['撤销上一次标记或移到废纸篓', '⌘ Z'],
      ['照片菜单', '右键 / Shift F10'],
      ['取消多选，否则关闭详情', 'Esc'],
      ['显示或隐藏详情', 'I'],
      ['显示或隐藏图片库侧栏', '⌘ B'],
      ['搜索当前图片库', '⌘ F'],
      ['照片 / 选片 / 概览', '⌘ 1 / 2 / 3'],
      ['按预设导出所选照片', '⌘ ⇧ E'],
      ['以当前筛选开始选片', 'Shift C'],
    ],
  },
  {
    title: '查看窗口',
    rows: [
      ['上一张 / 下一张', '← / →'],
      ['评级 / 清除评级', '1–5 / 0'],
      ['留用 / 淘汰 / 清除旗标', 'P / X / U'],
      ['显示或隐藏叠加信息', 'D'],
      ['影像信息', 'I'],
      ['裁剪', 'C'],
      ['显示或隐藏相机对焦点', 'Shift F'],
      ['适合窗口 ↔ 1:1 原生查焦', 'Z / 双击'],
      ['高光 / 暗部溢出警告', 'J'],
      ['相机内嵌预览 ↔ RAW 显影', 'R'],
      ['全屏', 'F'],
      ['移到废纸篓', '⌘ ⌫'],
      ['撤销上一次标记或移到废纸篓', '⌘ Z'],
      ['切换到选片', 'Shift C'],
      ['退出裁剪 / 全屏 / 返回网格', 'Esc / Space'],
    ],
  },
  {
    title: '选图模式',
    rows: [
      ['打星 / 清除星级', '1–5 / 0'],
      ['留用 / 淘汰 / 清除旗标', 'P / X / U'],
      ['单张 / 2·4 图同步对比', 'G / C'],
      ['适合窗口 ↔ 1:1 原生查焦', 'Z'],
      ['高光 / 暗部溢出警告', 'J'],
      ['相机内嵌预览 ↔ RAW 显影', 'R'],
      ['撤销上一次标记', '⌘ Z'],
      ['显示或隐藏叠加信息', 'Tab / D'],
      ['显示或隐藏相机对焦点', 'Shift F'],
      ['切回普通查看', 'Shift C'],
      ['退出选片或返回网格', 'Esc / Space'],
    ],
  },
];
