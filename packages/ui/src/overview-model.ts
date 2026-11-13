import type { AssetListOptions, Library, LibraryStats, StatsBin } from './model';
import { availabilityPresentation, isRemoteLibrary } from './workspace';

export type OverviewPick = {
  label: string;
  options: Partial<AssetListOptions>;
};

export type TimelineGranularity = 'day' | 'week' | 'month';

export interface TimelineBucket {
  key: string;
  tick: string;
  count: number;
  title: string;
  from: string;
  to: string;
}

export type FunnelTone = 'pick' | 'rated' | 'unseen' | 'reject';

export interface FunnelSegment {
  key: 'pick' | 'rated' | 'unprocessed' | 'reject';
  tone: FunnelTone;
  label: string;
  count: number;
  widthPercent: number;
  shareLabel: string;
  pick: OverviewPick;
}

export interface LibrarySourceBadge {
  label: '外接盘' | 'WebDAV' | 'S3' | '本机目录';
  tone: 'neutral' | 'info' | 'warn';
  icon: 'usb' | 'cloud' | 'folder';
}

export interface LibrariesSummary {
  total: number;
  online: number;
  offline: number;
  removable: number;
  remote: number;
  totalPhotos: number;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

function parseYmd(ymd: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return utc;
}

function formatYmd(utc: number): string {
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function mondayOfUtc(utc: number): number {
  const dow = new Date(utc).getUTCDay();
  const offset = (dow + 6) % 7;
  return utc - offset * DAY_MS;
}

function normalizeDays(days: { day: string; count: number }[]) {
  const byUtc = new Map<number, number>();
  for (const entry of days) {
    const utc = parseYmd(entry.day);
    if (utc === null || !Number.isFinite(entry.count) || entry.count < 0) continue;
    byUtc.set(utc, (byUtc.get(utc) ?? 0) + entry.count);
  }
  const sortedUtcs = [...byUtc.keys()].sort((a, b) => a - b);
  return { byUtc, sortedUtcs };
}

function buildDayBuckets(
  byUtc: Map<number, number>,
  firstUtc: number,
  lastUtc: number,
): TimelineBucket[] {
  const spansYears = new Date(firstUtc).getUTCFullYear() !== new Date(lastUtc).getUTCFullYear();
  const buckets: TimelineBucket[] = [];
  for (let utc = firstUtc; utc <= lastUtc; utc += DAY_MS) {
    const ymd = formatYmd(utc);
    const d = new Date(utc);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const date = d.getUTCDate();
    const dow = WEEKDAYS[d.getUTCDay()];
    buckets.push({
      key: ymd,
      tick: '',
      count: byUtc.get(utc) ?? 0,
      title: spansYears ? `${year}年${month}月${date}日 ${dow}` : `${month}月${date}日 ${dow}`,
      from: ymd,
      to: ymd,
    });
  }

  const n = buckets.length;
  const tickIndices: number[] = [];
  if (n <= 7) {
    for (let i = 0; i < n; i++) tickIndices.push(i);
  } else {
    const maxTicks = 8;
    const step = Math.ceil((n - 1) / (maxTicks - 1));
    for (let i = 0; i < n; i += step) tickIndices.push(i);
    const lastMarked = tickIndices[tickIndices.length - 1];
    if (lastMarked !== n - 1) {
      if (n - 1 - lastMarked >= Math.ceil(step * 0.6)) {
        tickIndices.push(n - 1);
      } else {
        tickIndices[tickIndices.length - 1] = n - 1;
      }
    }
  }

  let prevTickYear: number | null = null;
  for (const idx of tickIndices) {
    const utc = firstUtc + idx * DAY_MS;
    const d = new Date(utc);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const date = d.getUTCDate();
    const showYear = spansYears && (prevTickYear === null || prevTickYear !== year);
    buckets[idx].tick = showYear ? `${year}年${month}月${date}日` : `${month}月${date}日`;
    prevTickYear = year;
  }

  return buckets;
}

function buildWeekBuckets(
  byUtc: Map<number, number>,
  firstUtc: number,
  lastUtc: number,
): TimelineBucket[] {
  const startMonday = mondayOfUtc(firstUtc);
  const endMonday = mondayOfUtc(lastUtc);
  const weekCounts = new Map<number, number>();
  for (const [utc, count] of byUtc) {
    const mon = mondayOfUtc(utc);
    weekCounts.set(mon, (weekCounts.get(mon) ?? 0) + count);
  }

  const buckets: TimelineBucket[] = [];
  const monthBoundaries: { index: number; year: number; month: number }[] = [];

  for (let mon = startMonday, index = 0; mon <= endMonday; mon += 7 * DAY_MS, index++) {
    const sun = mon + 6 * DAY_MS;
    const d1 = new Date(mon);
    const d2 = new Date(sun);
    const y1 = d1.getUTCFullYear();
    const m1 = d1.getUTCMonth() + 1;
    const day1 = d1.getUTCDate();
    const y2 = d2.getUTCFullYear();
    const m2 = d2.getUTCMonth() + 1;
    const day2 = d2.getUTCDate();
    const from = formatYmd(mon);
    const to = formatYmd(sun);

    if (day1 === 1) {
      monthBoundaries.push({ index, year: y1, month: m1 });
    } else if (m1 !== m2) {
      monthBoundaries.push({ index, year: y2, month: m2 });
    }

    buckets.push({
      key: from,
      tick: '',
      count: weekCounts.get(mon) ?? 0,
      title:
        y1 === y2
          ? `${y1}年${m1}月${day1}日 – ${m2}月${day2}日`
          : `${y1}年${m1}月${day1}日 – ${y2}年${m2}月${day2}日`,
      from,
      to,
    });
  }

  const n = buckets.length;
  const spansYears =
    new Date(startMonday).getUTCFullYear() !== new Date(endMonday + 6 * DAY_MS).getUTCFullYear();
  const minGap = Math.max(2, Math.floor(n / 10));
  const stride = Math.max(1, Math.ceil(monthBoundaries.length / 8));
  const sampled = monthBoundaries.filter((_, idx) => idx % stride === 0);

  const chosen: { index: number; year: number; month: number }[] = [];
  const dStart = new Date(startMonday);
  if (!sampled.length || sampled[0].index >= Math.max(3, minGap)) {
    chosen.push({
      index: 0,
      year: dStart.getUTCFullYear(),
      month: dStart.getUTCMonth() + 1,
    });
  }
  for (const item of sampled) {
    const prev = chosen[chosen.length - 1];
    if (!prev || item.index - prev.index >= minGap) {
      if (chosen.length < 9) chosen.push(item);
    }
  }

  let prevYear: number | null = null;
  for (const item of chosen) {
    const includeYear = spansYears && (prevYear === null || prevYear !== item.year);
    buckets[item.index].tick = includeYear ? `${item.year}年${item.month}月` : `${item.month}月`;
    prevYear = item.year;
  }

  return buckets;
}

function buildMonthBuckets(
  byUtc: Map<number, number>,
  firstUtc: number,
  lastUtc: number,
): TimelineBucket[] {
  const monthCounts = new Map<string, number>();
  for (const [utc, count] of byUtc) {
    const ym = formatYmd(utc).slice(0, 7);
    monthCounts.set(ym, (monthCounts.get(ym) ?? 0) + count);
  }

  const dFirst = new Date(firstUtc);
  const dLast = new Date(lastUtc);
  const startY = dFirst.getUTCFullYear();
  const startM = dFirst.getUTCMonth() + 1;
  const endY = dLast.getUTCFullYear();
  const endM = dLast.getUTCMonth() + 1;

  const buckets: TimelineBucket[] = [];
  const meta: { index: number; year: number; month: number }[] = [];

  let y = startY;
  let m = startM;
  let index = 0;
  while (y < endY || (y === endY && m <= endM)) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    buckets.push({
      key: ym,
      tick: '',
      count: monthCounts.get(ym) ?? 0,
      title: `${y}年${m}月`,
      from: `${ym}-01`,
      to: `${ym}-${String(lastDay).padStart(2, '0')}`,
    });
    meta.push({ index, year: y, month: m });
    index++;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  const quarters = meta.filter(
    (entry) => entry.month === 1 || entry.month === 4 || entry.month === 7 || entry.month === 10,
  );
  const halves = meta.filter((entry) => entry.month === 1 || entry.month === 7);
  const years = meta.filter((entry) => entry.month === 1);

  let selected: { index: number; year: number; month: number }[];
  if (quarters.length <= 9) {
    selected = quarters;
  } else if (halves.length <= 9) {
    selected = halves;
  } else if (years.length <= 9) {
    selected = years;
  } else {
    const stride = Math.ceil(years.length / 8);
    selected = years.filter((_, idx) => idx % stride === 0);
  }

  if (!selected.length && meta.length) {
    selected = [meta[0]];
  }

  let prevYear: number | null = null;
  for (const item of selected) {
    const showYear = item.month === 1 || prevYear === null || prevYear !== item.year;
    buckets[item.index].tick =
      item.month === 1
        ? `${item.year}年`
        : showYear
          ? `${item.year}年${item.month}月`
          : `${item.month}月`;
    prevYear = item.year;
  }

  return buckets;
}

/**
 * Adaptive capture timeline bucketing:
 * - <= 60 calendar days: daily buckets
 * - 61..=540 calendar days: ISO Monday–Sunday weekly buckets
 * - > 540 calendar days: continuous monthly buckets
 */
export function buildTimelineBuckets(days: { day: string; count: number }[]): {
  granularity: TimelineGranularity;
  buckets: TimelineBucket[];
} {
  const { byUtc, sortedUtcs } = normalizeDays(days);
  if (!sortedUtcs.length) {
    return { granularity: 'day', buckets: [] };
  }
  const firstUtc = sortedUtcs[0];
  const lastUtc = sortedUtcs[sortedUtcs.length - 1];
  const spanDays = Math.round((lastUtc - firstUtc) / DAY_MS) + 1;

  if (spanDays <= 60) {
    return { granularity: 'day', buckets: buildDayBuckets(byUtc, firstUtc, lastUtc) };
  }
  if (spanDays <= 540) {
    return { granularity: 'week', buckets: buildWeekBuckets(byUtc, firstUtc, lastUtc) };
  }
  return { granularity: 'month', buckets: buildMonthBuckets(byUtc, firstUtc, lastUtc) };
}

export function granularityLabel(granularity: TimelineGranularity): string {
  if (granularity === 'week') return '按周';
  if (granularity === 'month') return '按月';
  return '按日';
}

export function formatCaptureSpan(days: { day: string; count: number }[]): string {
  const { sortedUtcs } = normalizeDays(days);
  if (!sortedUtcs.length) return '';
  const first = formatYmd(sortedUtcs[0]);
  const last = formatYmd(sortedUtcs[sortedUtcs.length - 1]);
  return `${first} 至 ${last}`;
}

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatSharePercent(count: number, total: number): string {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0 || count <= 0) return '0%';
  if (count >= total) return '100%';
  const raw = (count / total) * 100;
  if (raw < 1) return '<1%';
  if (raw > 99) return '99%';
  return `${Math.round(raw)}%`;
}

export function pickRatePercent(stats: Pick<LibraryStats, 'photos' | 'picks'>): number {
  if (!stats.photos || stats.photos <= 0 || stats.picks <= 0) return 0;
  return Math.min(100, Math.round((stats.picks / stats.photos) * 100));
}

export function cullFunnelSegments(stats: LibraryStats): FunnelSegment[] {
  const sum =
    Math.max(0, stats.picks) +
    Math.max(0, stats.rated) +
    Math.max(0, stats.unprocessed) +
    Math.max(0, stats.rejects);
  const denom = Math.max(stats.photos, sum);
  const width = (count: number) => (denom > 0 && count > 0 ? (count / denom) * 100 : 0);

  return [
    {
      key: 'pick',
      tone: 'pick',
      label: '留用',
      count: stats.picks,
      widthPercent: width(stats.picks),
      shareLabel: formatSharePercent(stats.picks, stats.photos),
      pick: { label: '留用', options: { flag: 'pick' } },
    },
    {
      key: 'rated',
      tone: 'rated',
      label: '已评星',
      count: stats.rated,
      widthPercent: width(stats.rated),
      shareLabel: formatSharePercent(stats.rated, stats.photos),
      pick: { label: '已评星，未打旗', options: { flag: 'none', rating: 1 } },
    },
    {
      key: 'unprocessed',
      tone: 'unseen',
      label: '未处理',
      count: stats.unprocessed,
      widthPercent: width(stats.unprocessed),
      shareLabel: formatSharePercent(stats.unprocessed, stats.photos),
      pick: { label: '未处理', options: { flag: 'none', rating_max: 0 } },
    },
    {
      key: 'reject',
      tone: 'reject',
      label: '淘汰',
      count: stats.rejects,
      widthPercent: width(stats.rejects),
      shareLabel: formatSharePercent(stats.rejects, stats.photos),
      pick: { label: '淘汰', options: { flag: 'reject' } },
    },
  ];
}

export function statsBinItems(
  bins: StatsBin[],
  kind: 'focal' | 'iso',
): { key: string; tick: string; count: number; title: string; pick: OverviewPick }[] {
  const unit = kind === 'focal' ? ' mm' : '';
  const prefix = kind === 'focal' ? '焦距' : 'ISO';
  const minKey = kind === 'focal' ? 'focal_min' : 'iso_min';
  const maxKey = kind === 'focal' ? 'focal_max' : 'iso_max';
  return bins.map((bin) => ({
    key: bin.label,
    tick: bin.label,
    count: bin.count,
    title: `${bin.label}${unit}`,
    pick: {
      label: `${prefix} ${bin.label}${unit}`,
      options: { [minKey]: bin.min, [maxKey]: bin.max ?? undefined },
    },
  }));
}

export function librarySourceBadge(
  library: Pick<Library, 'source_kind' | 'removable'>,
): LibrarySourceBadge {
  if (library.source_kind === 'webdav') return { label: 'WebDAV', tone: 'info', icon: 'cloud' };
  if (library.source_kind === 's3') return { label: 'S3', tone: 'info', icon: 'cloud' };
  if (library.removable) return { label: '外接盘', tone: 'warn', icon: 'usb' };
  return { label: '本机目录', tone: 'neutral', icon: 'folder' };
}

export function summarizeLibraries(libraries: Library[]): LibrariesSummary {
  let online = 0;
  let offline = 0;
  let removable = 0;
  let remote = 0;
  let totalPhotos = 0;
  for (const library of libraries) {
    if (availabilityPresentation(library).usable) online++;
    else offline++;
    if (library.removable) removable++;
    if (isRemoteLibrary(library)) remote++;
    totalPhotos += library.asset_count ?? 0;
  }
  return {
    total: libraries.length,
    online,
    offline,
    removable,
    remote,
    totalPhotos,
  };
}
