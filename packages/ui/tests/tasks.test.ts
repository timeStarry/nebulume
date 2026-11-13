import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskCenter } from '../src/tasks';

describe('background task center', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scopes concurrency checks by task kind and library id without global blocking', () => {
    const center = createTaskCenter();
    const scanA = center.start({ kind: 'scan', libraryId: 'lib-a', title: '扫描 京都行' });

    expect(center.isRunning()).toBe(true);
    expect(center.isRunning('scan', 'lib-a')).toBe(true);
    expect(center.isRunning('scan', 'lib-b')).toBe(false);
    expect(center.isRunning('export')).toBe(false);

    const exportId = center.start({ kind: 'export', title: '导出 42 张照片', total: 42, processed: 0 });
    expect(center.running()).toHaveLength(2);
    expect(center.isRunning('export')).toBe(true);

    center.complete(scanA, '已索引 120 项');
    expect(center.isRunning('scan', 'lib-a')).toBe(false);
    expect(center.isRunning('export')).toBe(true);
    // Running tasks stay ahead of finished ones.
    expect(center.tasks().map((t) => t.id)).toEqual([exportId, scanA]);
  });

  it('auto-clears completed tasks after settle window while retaining failed tasks', () => {
    const center = createTaskCenter({ settleMs: 2000 });
    const okId = center.start({ kind: 'pregenerate', libraryId: 'lib-1', title: '生成预览', total: 10 });
    const badId = center.start({ kind: 'scan', libraryId: 'lib-2', title: '扫描 工作室' });

    center.progress(okId, { processed: 6, detail: '6 / 10' });
    expect(center.tasks().find((t) => t.id === okId)?.processed).toBe(6);

    center.complete(okId, '已完成 10 项');
    center.fail(badId, '存储路径不可读');

    expect(center.tasks().find((t) => t.id === okId)?.processed).toBe(10);
    expect(center.failedCount()).toBe(1);

    vi.advanceTimersByTime(1999);
    expect(center.tasks()).toHaveLength(2);

    vi.advanceTimersByTime(1);
    expect(center.tasks().map((t) => t.id)).toEqual([badId]);
    expect(center.failedCount()).toBe(1);

    center.dismiss(badId);
    expect(center.tasks()).toHaveLength(0);
    expect(center.failedCount()).toBe(0);
  });

  it('wraps async jobs with progress updates and failure capture via run()', async () => {
    const center = createTaskCenter({ settleMs: 0 });
    const result = await center.run(
      { kind: 'export', title: '导出留用', total: 3, processed: 0 },
      async ({ progress }) => {
        progress({ processed: 2, detail: '2 / 3' });
        return { count: 3 };
      },
      (res) => `已导出 ${res.count} 张`,
    );
    expect(result).toEqual({ count: 3 });
    expect(center.tasks()[0]).toMatchObject({
      status: 'completed',
      processed: 3,
      detail: '已导出 3 张',
    });

    await expect(
      center.run({ kind: 'scan', libraryId: 'lib-x', title: '扫描' }, async () => {
        throw new Error('E_IO: 磁盘离线');
      }),
    ).rejects.toThrow();

    expect(center.failedCount()).toBe(1);
    expect(center.tasks()[0]).toMatchObject({
      status: 'failed',
      error: 'E_IO: 磁盘离线',
    });

    center.clearFinished();
    expect(center.tasks()).toHaveLength(0);
  });
});
