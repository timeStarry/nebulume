import { describe, expect, it } from 'vitest';
import {
  cacheBudgetError,
  cacheGiB,
  cacheMigrationPercent,
  cacheMigrationOverage,
  type CacheStats,
} from '../src/cache-model';

function stats(): CacheStats {
  return {
    policy: { budget_bytes: 10 * cacheGiB, max_unused_days: 30, preview_policy: 'automatic' },
    location: { path: 'C:\\Cache', state: 'online', available_bytes: null },
    usage: {
      total_bytes: 7 * cacheGiB,
      originals_bytes: 6 * cacheGiB,
      previews_bytes: cacheGiB,
      pinned_bytes: 1.4 * cacheGiB,
      in_use_bytes: 0.2 * cacheGiB,
      temporary_bytes: 0,
      reserved_bytes: 0,
      unmanaged_bytes: 0,
    },
    objects_count: 2,
    pinned: [],
    migration: null,
  };
}
describe('cache policy validation', () => {
  it('distinguishes a temporary copy from the portion exceeding the configured budget', () => {
    const plan = {
      plan_id: 'p',
      from_path: 'a',
      to_path: 'b',
      bytes: 5,
      extra_bytes: 5,
      available_bytes: 20,
      can_start: true,
    };
    expect(cacheMigrationOverage(plan)).toBe(5);
    expect(cacheMigrationOverage({ ...plan, budget_overage_bytes: 0 })).toBe(0);
    expect(cacheMigrationOverage({ ...plan, budget_overage_bytes: 2 })).toBe(2);
  });
  it('rejects invalid capacity and protects fixed content without double-counting overlapping leases', () => {
    const state = stats();
    for (const input of ['', '0', '2.5', '1025', 'NaN'])
      expect(cacheBudgetError(input, state)).not.toBe('');
    expect(cacheBudgetError('1', state)).toContain('至少需要 2 GiB');
    state.usage.in_use_bytes = 1.4 * cacheGiB;
    expect(cacheBudgetError('2', state)).toBe('');
    expect(cacheBudgetError('1024', state)).toBe('');
  });
  it('allows offline increases but rejects decreases and any change needing file reclamation', () => {
    const state = stats();
    state.location.state = 'offline';
    expect(cacheBudgetError('12', state)).toBe('');
    expect(cacheBudgetError('9', state)).toContain('降低需连接后核对');
    state.usage.total_bytes = 14 * cacheGiB;
    expect(cacheBudgetError('12', state)).toContain('离线时仅允许提高');
  });
  it('shows only reported progress and clamps malformed byte counters', () => {
    const migration = {
      id: 'm',
      status: 'running' as const,
      from_path: 'a',
      to_path: 'b',
      total_bytes: 100,
      copied_bytes: 30,
    };
    expect(cacheMigrationPercent(migration)).toBe(30);
    expect(cacheMigrationPercent({ ...migration, copied_bytes: 200 })).toBe(100);
    expect(cacheMigrationPercent({ ...migration, total_bytes: 0 })).toBe(0);
  });
});
