import type { Collection, ColorLabelFilter, FolderNode, Library } from './model';

export type CommandCategory = 'action' | 'library' | 'collection' | 'folder' | 'filter';

export type CommandAction =
  | { type: 'all-libraries' }
  | { type: 'select-library'; libraryId: string }
  | { type: 'library-overview' }
  | { type: 'open-import' }
  | { type: 'open-storage' }
  | { type: 'open-settings'; section: 'general' | 'cache' | 'shortcuts' | 'about' }
  | { type: 'select-collection'; collectionId: string }
  | { type: 'create-collection'; kind: 'manual' | 'smart' }
  | { type: 'select-folder'; path: string }
  | { type: 'filter-flag'; flag: 'any' | 'pick' | 'none' | 'reject' }
  | { type: 'filter-rating'; rating: number | null }
  | { type: 'filter-color'; colorLabel: ColorLabelFilter }
  | { type: 'clear-filters' }
  | { type: 'toggle-burst-stacks' };

export interface CommandItem {
  id: string;
  category: CommandCategory;
  categoryLabel: string;
  title: string;
  subtitle?: string;
  shortcut?: string;
  keywords: string[];
  action: CommandAction;
}

export interface CommandPaletteSource {
  libraries: readonly Library[];
  activeLibrary: Library | null;
  collections: readonly Collection[];
  folders: readonly FolderNode[];
  burstStacksEnabled: boolean;
}

function flattenFolders(nodes: readonly FolderNode[], out: FolderNode[] = []): FolderNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.children?.length) flattenFolders(node.children, out);
  }
  return out;
}

export function buildCommandItems(source: CommandPaletteSource): CommandItem[] {
  const items: CommandItem[] = [];

  if (source.activeLibrary) {
    items.push(
      {
        id: 'act:overview',
        category: 'action',
        categoryLabel: '导航与操作',
        title: `查看「${source.activeLibrary.name}」概览仪表盘`,
        subtitle: '拍摄时间线、选片漏斗与器材统计',
        keywords: ['overview', 'dashboard', '概览', '统计', '仪表盘'],
        action: { type: 'library-overview' },
      },
      {
        id: 'act:create-manual-collection',
        category: 'action',
        categoryLabel: '导航与操作',
        title: '新建精选集…',
        subtitle: '创建跨目录虚拟选片集（不移动原片）',
        keywords: ['collection', 'album', '精选集', '相册', '新建'],
        action: { type: 'create-collection', kind: 'manual' },
      },
      {
        id: 'act:create-smart-collection',
        category: 'action',
        categoryLabel: '导航与操作',
        title: '新建智能精选集…',
        subtitle: '按星级、旗标、色标、器材或关键词自动聚合',
        keywords: ['smart', 'collection', '智能精选集', '规则', '自动'],
        action: { type: 'create-collection', kind: 'smart' },
      },
      {
        id: 'act:burst-toggle',
        category: 'action',
        categoryLabel: '导航与操作',
        title: source.burstStacksEnabled ? '展开全部连拍堆栈' : '折叠高速连拍堆栈',
        subtitle: '同机身 2 秒内连拍自动聚合并优先展示最佳帧',
        keywords: ['burst', 'stack', '连拍', '堆栈', '折叠'],
        action: { type: 'toggle-burst-stacks' },
      },
    );
  }

  items.push(
    {
      id: 'act:all-libraries',
      category: 'action',
      categoryLabel: '导航与操作',
      title: '前往全部图片库',
      subtitle: '查看所有本机、外接盘与远端图库状态',
      keywords: ['libraries', 'home', '全部图片库', '首页'],
      action: { type: 'all-libraries' },
    },
    {
      id: 'act:import',
      category: 'action',
      categoryLabel: '导航与操作',
      title: '打开导入工作台',
      subtitle: '从存储卡或目录安全拷卡、去重与双盘备份',
      keywords: ['import', 'ingest', 'card', '导入', '拷卡', '备份'],
      action: { type: 'open-import' },
    },
    {
      id: 'act:storage',
      category: 'action',
      categoryLabel: '导航与操作',
      title: '管理存储位置与外接卷',
      subtitle: 'WebDAV / S3 连接、外接盘重定位与路径检查',
      keywords: ['storage', 'nas', 's3', 'webdav', '存储位置', '外接盘', '重定位'],
      action: { type: 'open-storage' },
    },
    {
      id: 'act:settings-general',
      category: 'action',
      categoryLabel: '导航与操作',
      title: '设置 · 外观与浏览',
      subtitle: '主题色、网格密度与 XMP 伴随文件同步策略',
      shortcut: '⌘,',
      keywords: ['settings', 'theme', 'xmp', '设置', '外观', '主题'],
      action: { type: 'open-settings', section: 'general' },
    },
    {
      id: 'act:settings-cache',
      category: 'action',
      categoryLabel: '导航与操作',
      title: '设置 · 缓存与离线',
      subtitle: '管理本地预览与远端缓存配额、清理与目录迁移',
      keywords: ['cache', 'offline', 'quota', '缓存', '离线', '清理'],
      action: { type: 'open-settings', section: 'cache' },
    },
    {
      id: 'act:settings-shortcuts',
      category: 'action',
      categoryLabel: '导航与操作',
      title: '设置 · 快捷键速查',
      subtitle: '选片旗标、星级、色标与审片键盘热键',
      shortcut: '?',
      keywords: ['shortcuts', 'keymap', 'hotkeys', '快捷键', '键盘'],
      action: { type: 'open-settings', section: 'shortcuts' },
    },
    {
      id: 'act:settings-about',
      category: 'action',
      categoryLabel: '导航与操作',
      title: '设置 · 关于与版本更新',
      subtitle: '版本状态、自动更新、打开数据目录与诊断摘要',
      keywords: ['about', 'update', 'version', '关于', '更新', '诊断'],
      action: { type: 'open-settings', section: 'about' },
    },
  );

  for (const coll of source.collections) {
    items.push({
      id: `coll:${coll.id}`,
      category: 'collection',
      categoryLabel: '精选集',
      title: coll.name,
      subtitle: `${coll.kind === 'smart' ? '智能精选集' : '精选集'} · ${coll.item_count} 张`,
      keywords: [coll.name, coll.kind === 'smart' ? '智能' : '手动', 'collection', '精选集'],
      action: { type: 'select-collection', collectionId: coll.id },
    });
  }

  for (const folder of flattenFolders(source.folders)) {
    items.push({
      id: `folder:${folder.path}`,
      category: 'folder',
      categoryLabel: '文件夹',
      title: folder.name,
      subtitle: `${folder.path} · ${folder.count} 张`,
      keywords: [folder.name, folder.path, 'folder', '文件夹'],
      action: { type: 'select-folder', path: folder.path },
    });
  }

  for (const lib of source.libraries) {
    const status =
      lib.connected === false
        ? '离线'
        : lib.removable
          ? `外接卷${lib.volume_label ? ` (${lib.volume_label})` : ''}`
          : lib.source_kind === 'local' || !lib.source_kind
            ? '本机'
            : lib.source_kind.toUpperCase();
    items.push({
      id: `lib:${lib.id}`,
      category: 'library',
      categoryLabel: '图片库',
      title: lib.name,
      subtitle: `${status} · ${lib.asset_count ?? 0} 张`,
      keywords: [lib.name, lib.root, status, 'library', '图片库'],
      action: { type: 'select-library', libraryId: lib.id },
    });
  }

  if (source.activeLibrary) {
    items.push(
      {
        id: 'flt:pick',
        category: 'filter',
        categoryLabel: '快速筛选',
        title: '筛选：仅看留用照片 (Pick)',
        keywords: ['pick', '留用', '旗标', 'filter'],
        action: { type: 'filter-flag', flag: 'pick' },
      },
      {
        id: 'flt:five-star',
        category: 'filter',
        categoryLabel: '快速筛选',
        title: '筛选：五星精选 (5★)',
        keywords: ['5', 'star', '五星', '星级', 'filter'],
        action: { type: 'filter-rating', rating: 5 },
      },
      {
        id: 'flt:red',
        category: 'filter',
        categoryLabel: '快速筛选',
        title: '筛选：红色色标',
        shortcut: '6',
        keywords: ['red', 'label', '红色', '红标', '色标', '6'],
        action: { type: 'filter-color', colorLabel: 'red' },
      },
      {
        id: 'flt:yellow',
        category: 'filter',
        categoryLabel: '快速筛选',
        title: '筛选：黄色色标',
        shortcut: '7',
        keywords: ['yellow', 'label', '黄色', '黄标', '色标', '7'],
        action: { type: 'filter-color', colorLabel: 'yellow' },
      },
      {
        id: 'flt:green',
        category: 'filter',
        categoryLabel: '快速筛选',
        title: '筛选：绿色色标',
        shortcut: '8',
        keywords: ['green', 'label', '绿色', '绿标', '色标', '8'],
        action: { type: 'filter-color', colorLabel: 'green' },
      },
      {
        id: 'flt:blue',
        category: 'filter',
        categoryLabel: '快速筛选',
        title: '筛选：蓝色色标',
        shortcut: '9',
        keywords: ['blue', 'label', '蓝色', '蓝标', '色标', '9'],
        action: { type: 'filter-color', colorLabel: 'blue' },
      },
      {
        id: 'flt:clear',
        category: 'filter',
        categoryLabel: '快速筛选',
        title: '清除全部筛选条件',
        keywords: ['clear', 'reset', '清除', '重置', '全部照片'],
        action: { type: 'clear-filters' },
      },
    );
  }

  return items;
}

function scoreField(text: string, token: string): number {
  const lower = text.toLowerCase();
  if (lower === token) return 120;
  if (lower.startsWith(token)) return 90;
  const idx = lower.indexOf(token);
  if (idx >= 0) return Math.max(50, 75 - idx);
  // Subsequence fuzzy match
  let ti = 0;
  for (let i = 0; i < lower.length && ti < token.length; i += 1) {
    if (lower[i] === token[ti]) ti += 1;
  }
  return ti === token.length ? 25 : 0;
}

export function filterCommandItems(items: readonly CommandItem[], query: string): CommandItem[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return items.slice(0, 40);

  const scored: Array<{ item: CommandItem; score: number }> = [];
  for (const item of items) {
    let total = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const titleScore = scoreField(item.title, token) * 2;
      const subScore = item.subtitle ? scoreField(item.subtitle, token) : 0;
      const kwScore = item.keywords.reduce(
        (best, kw) => Math.max(best, scoreField(kw, token)),
        0,
      );
      const best = Math.max(titleScore, subScore, kwScore);
      if (best === 0) {
        matchedAll = false;
        break;
      }
      total += best;
    }
    if (matchedAll) {
      scored.push({ item, score: total });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 40).map((entry) => entry.item);
}
