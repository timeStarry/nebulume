export const cacheGiB = 1024 ** 3;

export interface CachePolicy {
  budget_bytes: number;
  max_unused_days: number | null;
  preview_policy: 'automatic' | 'manual';
}
export interface CacheMigration {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'cleanup_pending';
  from_path: string;
  to_path: string;
  total_bytes: number;
  copied_bytes: number;
  error?: string | null;
}
export interface CacheStats {
  policy: CachePolicy;
  location: { path: string; state: 'online' | 'offline'; available_bytes: number | null };
  usage: {
    total_bytes: number;
    originals_bytes: number;
    previews_bytes: number;
    temporary_bytes: number;
    pinned_bytes: number;
    reserved_bytes: number;
    unmanaged_bytes: number;
    in_use_bytes: number;
  };
  objects_count: number;
  pinned: { asset_id: string; name: string; size: number; last_used: string }[];
  migration: CacheMigration | null;
}
export interface CacheLocationCheck {
  path: string;
  valid: boolean;
  reason?: string | null;
  available_bytes: number | null;
}
export interface CacheMigrationPlan {
  plan_id: string;
  from_path: string;
  to_path: string;
  bytes: number;
  extra_bytes: number;
  budget_overage_bytes?: number;
  available_bytes: number | null;
  can_start: boolean;
  reason?: string | null;
}
export interface CachePruneOptions {
  originals: boolean;
  previews: boolean;
  temporary: boolean;
}
export interface CachePruneResult {
  reclaimable_bytes: number;
  freed_bytes: number;
  skipped_bytes: number;
}

export function cacheMigrationActive(migration?: CacheMigration | null): boolean {
  return migration?.status === 'running' || migration?.status === 'cleanup_pending';
}
export function cacheBudgetError(value: string, stats: CacheStats): string {
  const gib = Number(value);
  if (!value.trim() || !Number.isInteger(gib) || gib < 1 || gib > 1024)
    return '请输入 1–1024 GiB 的整数。';
  if (
    stats.location.state === 'offline' &&
    (gib * cacheGiB < stats.policy.budget_bytes || gib * cacheGiB < stats.usage.total_bytes)
  )
    return '离线时仅允许提高上限，降低需连接后核对。';
  // These protected sets can overlap. The service validates their exact union before pruning.
  const protectedMinimum = Math.max(stats.usage.pinned_bytes, stats.usage.in_use_bytes);
  if (gib * cacheGiB < protectedMinimum)
    return `离线固定或在用内容超出此上限，至少需要 ${Math.ceil(protectedMinimum / cacheGiB)} GiB；请先解除部分固定或等待使用结束。`;
  return '';
}
export function cacheMigrationPercent(migration: CacheMigration): number {
  if (migration.status === 'completed') return 100;
  if (!migration.total_bytes) return 0;
  return Math.min(100, Math.max(0, (migration.copied_bytes / migration.total_bytes) * 100));
}
export function cacheMigrationOverage(plan: CacheMigrationPlan): number {
  return plan.budget_overage_bytes ?? plan.extra_bytes;
}
