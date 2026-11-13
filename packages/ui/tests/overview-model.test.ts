import { describe, expect, it } from 'vitest';
import {
  buildTimelineBuckets,
  cullFunnelSegments,
  formatCaptureSpan,
  formatSharePercent,
  formatStorageBytes,
  granularityLabel,
  librarySourceBadge,
  pickRatePercent,
  statsBinItems,
  summarizeLibraries,
} from '../src/overview-model';
import type { Library, LibraryStats } from '../src/model';

const sumCounts = (items: { count: number }[]) =>
  items.reduce((acc, item) => acc + item.count, 0);

describe('overview-model timeline bucketing', () => {
  it('returns an empty day bucket list when there are no capture dates', () => {
    const result = buildTimelineBuckets([]);
    expect(result).toEqual({ granularity: 'day', buckets: [] });
    expect(formatCaptureSpan([])).toBe('');
  });

  it('renders a single-day shoot with exact count and matching YYYY-MM-DD bounds', () => {
    const input = [{ day: '2026-11-12', count: 48 }];
    const result = buildTimelineBuckets(input);
    expect(result.granularity).toBe('day');
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toEqual({
      key: '2026-11-12',
      tick: '11月12日',
      count: 48,
      title: '11月12日 周四',
      from: '2026-11-12',
      to: '2026-11-12',
    });
    expect(sumCounts(result.buckets)).toBe(48);
    expect(formatCaptureSpan(input)).toBe('2026-11-12 至 2026-11-12');
  });

  it('renders a 30-day trip as continuous daily buckets with rest-day gaps and sparse ticks', () => {
    const input = [
      { day: '2026-05-01', count: 120 },
      { day: '2026-05-04', count: 85 },
      { day: '2026-05-15', count: 210 },
      { day: '2026-05-30', count: 64 },
    ];
    const result = buildTimelineBuckets(input);
    expect(result.granularity).toBe('day');
    expect(granularityLabel(result.granularity)).toBe('按日');
    expect(result.buckets).toHaveLength(30);
    expect(sumCounts(result.buckets)).toBe(sumCounts(input));
    expect(result.buckets[0].from).toBe('2026-05-01');
    expect(result.buckets[0].to).toBe('2026-05-01');
    expect(result.buckets.at(-1)?.from).toBe('2026-05-30');
    expect(result.buckets.at(-1)?.to).toBe('2026-05-30');
    // Rest days are preserved as zero-count buckets.
    expect(result.buckets[1]).toMatchObject({
      key: '2026-05-02',
      count: 0,
      from: '2026-05-02',
      to: '2026-05-02',
    });

    const ticks = result.buckets.filter((b) => b.tick !== '');
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeLessThanOrEqual(9);
  });

  it('buckets a 200-day archive into ISO Monday–Sunday weeks with month ticks and exact total', () => {
    const input = [
      { day: '2026-03-04', count: 35 }, // Wednesday -> week 2026-03-02 .. 2026-03-08
      { day: '2026-05-04', count: 110 }, // Monday
      { day: '2026-05-10', count: 40 }, // Sunday of same week -> sums to 150
      { day: '2026-07-19', count: 92 },
      { day: '2026-09-19', count: 73 }, // Span: 200 calendar days (Mar 4 .. Sep 19)
    ];
    const result = buildTimelineBuckets(input);
    expect(result.granularity).toBe('week');
    expect(granularityLabel(result.granularity)).toBe('按周');
    expect(sumCounts(result.buckets)).toBe(sumCounts(input));

    // First week covers 2026-03-04 (Monday 2026-03-02 to Sunday 2026-03-08)
    expect(result.buckets[0].from).toBe('2026-03-02');
    expect(result.buckets[0].to).toBe('2026-03-08');
    // Last week covers 2026-09-19 (Monday 2026-09-14 to Sunday 2026-09-20)
    expect(result.buckets.at(-1)?.from).toBe('2026-09-14');
    expect(result.buckets.at(-1)?.to).toBe('2026-09-20');

    const mayWeek = result.buckets.find((b) => b.from === '2026-05-04');
    expect(mayWeek).toMatchObject({
      count: 150,
      title: '2026年5月4日 – 5月10日',
      from: '2026-05-04',
      to: '2026-05-10',
    });

    const ticks = result.buckets.filter((b) => b.tick !== '');
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(9);
  });

  it('buckets a 3-year archive into continuous YYYY-MM months with leap-year bounds and sparse ticks', () => {
    const input = [
      { day: '2023-10-18', count: 310 },
      { day: '2024-02-29', count: 95 }, // Leap day
      { day: '2025-10-03', count: 140 },
      { day: '2025-10-28', count: 60 },
      { day: '2026-10-05', count: 420 },
    ];
    const result = buildTimelineBuckets(input);
    expect(result.granularity).toBe('month');
    expect(granularityLabel(result.granularity)).toBe('按月');
    expect(result.buckets).toHaveLength(37); // 2023-10 through 2026-10 inclusive
    expect(sumCounts(result.buckets)).toBe(sumCounts(input));

    expect(result.buckets[0]).toMatchObject({
      key: '2023-10',
      title: '2023年10月',
      from: '2023-10-01',
      to: '2023-10-31',
      count: 310,
    });
    const leapFeb = result.buckets.find((b) => b.key === '2024-02');
    expect(leapFeb).toMatchObject({
      from: '2024-02-01',
      to: '2024-02-29',
      count: 95,
    });
    const oct2025 = result.buckets.find((b) => b.key === '2025-10');
    expect(oct2025).toMatchObject({
      title: '2025年10月',
      from: '2025-10-01',
      to: '2025-10-31',
      count: 200,
    });
    expect(result.buckets.at(-1)).toMatchObject({
      key: '2026-10',
      from: '2026-10-01',
      to: '2026-10-31',
      count: 420,
    });

    const ticks = result.buckets.filter((b) => b.tick !== '');
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(9);
  });
});

describe('overview-model formatting & funnel helpers', () => {
  it('formats storage sizes cleanly from 0 B through TB', () => {
    expect(formatStorageBytes(0)).toBe('0 B');
    expect(formatStorageBytes(512)).toBe('512 B');
    expect(formatStorageBytes(42_000)).toBe('42 KB');
    expect(formatStorageBytes(18_400_000)).toBe('18.4 MB');
    expect(formatStorageBytes(64_250_000_000)).toBe('64.3 GB');
    expect(formatStorageBytes(2_400_000_000_000)).toBe('2.4 TB');
  });

  it('computes funnel segments, pick rate, and boundary share labels', () => {
    const stats: LibraryStats = {
      photos: 12,
      files: 16,
      bytes: 480_000_000,
      picks: 2,
      rejects: 1,
      rated: 1,
      unprocessed: 8,
      undated: 0,
      days: [],
      cameras: [],
      lenses: [],
      focal: [{ label: '35–50', min: 35, max: 50, count: 5 }],
      iso: [{ label: '800+', min: 800, max: null, count: 3 }],
    };
    expect(pickRatePercent(stats)).toBe(17);
    const segments = cullFunnelSegments(stats);
    expect(segments.map((s) => [s.label, s.count, s.shareLabel])).toEqual([
      ['留用', 2, '17%'],
      ['已评星', 1, '8%'],
      ['未处理', 8, '67%'],
      ['淘汰', 1, '8%'],
    ]);
    expect(segments[2].pick).toEqual({
      label: '未处理',
      options: { flag: 'none', rating_max: 0 },
    });
    expect(formatSharePercent(1, 500)).toBe('<1%');
    expect(formatSharePercent(499, 500)).toBe('99%');
    expect(formatSharePercent(500, 500)).toBe('100%');

    const focalItems = statsBinItems(stats.focal, 'focal');
    expect(focalItems[0].pick).toEqual({
      label: '焦距 35–50 mm',
      options: { focal_min: 35, focal_max: 50 },
    });
    const isoItems = statsBinItems(stats.iso, 'iso');
    expect(isoItems[0].pick).toEqual({
      label: 'ISO 800+',
      options: { iso_min: 800, iso_max: undefined },
    });
  });

  it('summarizes library sources and online/offline counts', () => {
    const libs: Library[] = [
      {
        id: 'a',
        name: '本机',
        root: '/photos',
        created_at: '2026-01-01',
        source_kind: 'local',
        availability: 'online',
        asset_count: 1200,
      },
      {
        id: 'b',
        name: '移动盘',
        root: '/Volumes/SSD/RAW',
        created_at: '2026-01-02',
        source_kind: 'local',
        removable: true,
        availability: 'offline',
        relocatable_path: '/Volumes/SSD-1/RAW',
        asset_count: 3400,
      },
      {
        id: 'c',
        name: 'NAS',
        root: '/cache',
        created_at: '2026-01-03',
        source_kind: 'webdav',
        availability: 'online',
        asset_count: 800,
      },
    ];
    expect(librarySourceBadge(libs[0]).label).toBe('本机目录');
    expect(librarySourceBadge(libs[1]).label).toBe('外接盘');
    expect(librarySourceBadge(libs[2]).label).toBe('WebDAV');
    expect(summarizeLibraries(libs)).toEqual({
      total: 3,
      online: 2,
      offline: 1,
      removable: 1,
      remote: 1,
      totalPhotos: 5400,
    });
  });
});
