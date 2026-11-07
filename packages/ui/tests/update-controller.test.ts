import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  createUpdateController,
  type AvailableUpdate,
  type UpdateEffects,
  type UpdateState,
} from '../src/update-controller';

type DownloadEvent = Parameters<Parameters<AvailableUpdate['download']>[0]>[0];

interface FakeTimer {
  fn: () => void;
  ms: number;
  cancel: ReturnType<typeof vi.fn>;
  cancelled: boolean;
}

function fakeEffects(overrides: Partial<UpdateEffects> = {}) {
  const timers: FakeTimer[] = [];
  const calls: string[] = [];
  let auto = true;
  const effects = {
    support: vi.fn(async () => ({ supported: true, kind: 'installer' })),
    check: vi.fn(async (): Promise<AvailableUpdate | null> => null),
    prepare: vi.fn(async () => {
      calls.push('prepare');
      return { cancelled_jobs: 0, pending_writes: 0, timed_out: false };
    }),
    relaunch: vi.fn(async () => {
      calls.push('relaunch');
    }),
    now: vi.fn(() => 1_700_000_000_000),
    setTimer: vi.fn((fn: () => void, ms: number) => {
      const timer: FakeTimer = { fn, ms, cancelled: false, cancel: vi.fn() };
      timer.cancel.mockImplementation(() => {
        timer.cancelled = true;
      });
      timers.push(timer);
      return timer.cancel as () => void;
    }),
    readAuto: vi.fn(() => auto),
    writeAuto: vi.fn((value: boolean) => {
      auto = value;
    }),
    ...overrides,
  } satisfies UpdateEffects;
  async function fireNext() {
    const timer = timers.find((t) => !t.cancelled && !(t as { fired?: boolean }).fired);
    if (!timer) throw new Error('no pending timer');
    (timer as { fired?: boolean }).fired = true;
    timer.fn();
    await settle();
  }
  return { effects, timers, calls, fireNext };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function update(
  download: AvailableUpdate['download'],
  install: AvailableUpdate['install'] = async () => undefined,
): AvailableUpdate {
  return {
    version: '0.2.0',
    body: '修复若干问题',
    date: '2026-11-07T00:00:00Z',
    download: vi.fn(download),
    install: vi.fn(install),
  };
}

describe('update controller', () => {
  it('does not check when unsupported', async () => {
    const { effects, timers } = fakeEffects({
      support: vi.fn(async () => ({ supported: false, kind: 'portable' })),
    });
    const controller = createUpdateController(effects);
    await controller.start();
    expect(controller.state()).toEqual({ kind: 'unsupported', reason: 'portable' });
    await controller.checkNow();
    expect(effects.check).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it('maps an unknown unsupported kind to unsupported_platform', async () => {
    const { effects } = fakeEffects({
      support: vi.fn(async () => ({ supported: false, kind: 'mystery' })),
    });
    const controller = createUpdateController(effects);
    await controller.start();
    expect(controller.state()).toEqual({ kind: 'unsupported', reason: 'unsupported_platform' });
  });

  it('schedules first automatic check after 10 s and then daily', async () => {
    const { effects, timers, fireNext } = fakeEffects();
    const controller = createUpdateController(effects);
    await controller.start();
    expect(timers.map((t) => t.ms)).toEqual([FIRST_CHECK_DELAY_MS]);
    expect(effects.check).not.toHaveBeenCalled();
    await fireNext();
    expect(effects.check).toHaveBeenCalledTimes(1);
    expect(timers.map((t) => t.ms)).toEqual([10_000, 86_400_000]);
    expect(CHECK_INTERVAL_MS).toBe(86_400_000);
  });

  it('does not schedule when auto check is off', async () => {
    const { effects, timers } = fakeEffects({ readAuto: vi.fn(() => false) });
    const controller = createUpdateController(effects);
    await controller.start();
    expect(controller.state()).toEqual({ kind: 'idle' });
    expect(timers).toHaveLength(0);
  });

  it('null check result reports up to date without prompting', async () => {
    const { effects, fireNext } = fakeEffects();
    const controller = createUpdateController(effects);
    await controller.start();
    await fireNext();
    expect(controller.state()).toEqual({ kind: 'up-to-date', checkedAt: 1_700_000_000_000 });
  });

  it('network failure is recorded, not thrown', async () => {
    const { effects, timers, fireNext } = fakeEffects({
      check: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const controller = createUpdateController(effects);
    await expect(controller.start()).resolves.toBeUndefined();
    await fireNext();
    expect(controller.state()).toEqual({
      kind: 'failed',
      checkedAt: 1_700_000_000_000,
      message: 'offline',
    });
    expect(timers.map((t) => t.ms)).toEqual([FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS]);
    await expect(controller.checkNow()).resolves.toBeUndefined();
    expect(controller.state()).toMatchObject({ kind: 'failed', message: 'offline' });
  });

  it('available update is reported with notes', async () => {
    const { effects } = fakeEffects({ check: vi.fn(async () => update(async () => undefined)) });
    const controller = createUpdateController(effects);
    await controller.start();
    await controller.checkNow();
    expect(controller.state()).toEqual({
      kind: 'available',
      version: '0.2.0',
      notes: '修复若干问题',
      date: '2026-11-07T00:00:00Z',
    });
  });

  it('install reports progress then prepares and relaunches', async () => {
    const { effects, calls } = fakeEffects({
      check: vi.fn(async () =>
        update(
          async (onEvent: (e: DownloadEvent) => void) => {
            calls.push('download');
            onEvent({ event: 'Started', data: { contentLength: 100 } });
            onEvent({ event: 'Progress', data: { chunkLength: 40 } });
            onEvent({ event: 'Progress', data: { chunkLength: 60 } });
            onEvent({ event: 'Finished' });
          },
          async () => {
            calls.push('install');
          },
        ),
      ),
    });
    const controller = createUpdateController(effects);
    const seen: UpdateState[] = [];
    controller.subscribe((state) => seen.push(state));
    await controller.start();
    await controller.checkNow();
    await controller.install();
    const downloads = seen.filter((s) => s.kind === 'downloading');
    expect(downloads).toContainEqual({
      kind: 'downloading',
      version: '0.2.0',
      received: 40,
      total: 100,
    });
    expect(downloads).toContainEqual({
      kind: 'downloading',
      version: '0.2.0',
      received: 100,
      total: 100,
    });
    expect(seen.findIndex((s) => s.kind === 'installing')).toBeGreaterThan(
      seen.findIndex((s) => s.kind === 'downloading' && s.received === 100),
    );
    expect(controller.state()).toEqual({ kind: 'installing', version: '0.2.0' });
    expect(calls).toEqual(['download', 'prepare', 'install', 'relaunch']);
  });

  it('prepare failure or timeout does not block installation', async () => {
    const { effects } = fakeEffects({
      check: vi.fn(async () => update(async () => undefined)),
      prepare: vi.fn(async () => {
        throw new Error('busy');
      }),
    });
    const controller = createUpdateController(effects);
    await controller.start();
    await controller.checkNow();
    await controller.install();
    expect(effects.relaunch).toHaveBeenCalledTimes(1);
    expect(controller.state()).toEqual({ kind: 'installing', version: '0.2.0' });
  });

  it('interrupted download returns to available with error', async () => {
    const download = vi.fn(async () => {
      throw new Error('reset');
    });
    const available = update(download);
    const { effects } = fakeEffects({ check: vi.fn(async () => available) });
    const controller = createUpdateController(effects);
    await controller.start();
    await controller.checkNow();
    await expect(controller.install()).resolves.toBeUndefined();
    expect(controller.state()).toMatchObject({
      kind: 'available',
      version: '0.2.0',
      error: 'reset',
    });
    expect(effects.relaunch).not.toHaveBeenCalled();
    expect(effects.prepare).not.toHaveBeenCalled();
    expect(available.install).not.toHaveBeenCalled();
    await controller.install();
    expect(available.download).toHaveBeenCalledTimes(2);
  });

  it('prepare runs before install', async () => {
    let prepared = false;
    let preparedBeforeInstall: boolean | null = null;
    const { effects } = fakeEffects({
      check: vi.fn(async () =>
        update(
          async () => undefined,
          async () => {
            preparedBeforeInstall = prepared;
          },
        ),
      ),
      prepare: vi.fn(async () => {
        prepared = true;
        return { cancelled_jobs: 0, pending_writes: 0, timed_out: false };
      }),
    });
    const controller = createUpdateController(effects);
    await controller.start();
    await controller.checkNow();
    await controller.install();
    expect(preparedBeforeInstall).toBe(true);
  });

  it('install failure returns to available without relaunch', async () => {
    const available = update(
      async () => undefined,
      async () => {
        throw new Error('installer failed');
      },
    );
    const { effects } = fakeEffects({ check: vi.fn(async () => available) });
    const controller = createUpdateController(effects);
    await controller.start();
    await controller.checkNow();
    await expect(controller.install()).resolves.toBeUndefined();
    expect(controller.state()).toEqual({
      kind: 'available',
      version: '0.2.0',
      notes: '修复若干问题',
      date: '2026-11-07T00:00:00Z',
      error: 'installer failed',
    });
    expect(effects.prepare).toHaveBeenCalledTimes(1);
    expect(effects.relaunch).not.toHaveBeenCalled();
    await controller.install();
    expect(available.download).toHaveBeenCalledTimes(2);
  });

  it('manual check is ignored while downloading', async () => {
    const gate = deferred();
    const { effects } = fakeEffects({ check: vi.fn(async () => update(() => gate.promise)) });
    const controller = createUpdateController(effects);
    await controller.start();
    await controller.checkNow();
    const installing = controller.install();
    expect(controller.state().kind).toBe('downloading');
    await controller.checkNow();
    expect(effects.check).toHaveBeenCalledTimes(1);
    gate.resolve();
    await installing;
  });

  it('dismiss returns to idle and the next scheduled check prompts again', async () => {
    const { effects, fireNext } = fakeEffects({
      check: vi.fn(async () => update(async () => undefined)),
    });
    const controller = createUpdateController(effects);
    await controller.start();
    await fireNext();
    expect(controller.state().kind).toBe('available');
    controller.dismiss();
    expect(controller.state()).toEqual({ kind: 'idle' });
    await fireNext();
    expect(controller.state().kind).toBe('available');
  });

  it('turning auto off cancels the pending timer and persists', async () => {
    const { effects, timers } = fakeEffects();
    const controller = createUpdateController(effects);
    await controller.start();
    controller.setAuto(false);
    expect(effects.writeAuto).toHaveBeenCalledWith(false);
    expect(timers[0].cancel).toHaveBeenCalled();
    controller.setAuto(true);
    expect(effects.writeAuto).toHaveBeenLastCalledWith(true);
    expect(timers.map((t) => t.ms)).toEqual([FIRST_CHECK_DELAY_MS, FIRST_CHECK_DELAY_MS]);
  });

  it('turning auto on after a check schedules the daily interval', async () => {
    const { effects, timers } = fakeEffects({ readAuto: vi.fn(() => false) });
    const controller = createUpdateController(effects);
    await controller.start();
    await controller.checkNow();
    controller.setAuto(true);
    expect(timers.map((t) => t.ms)).toEqual([CHECK_INTERVAL_MS]);
  });

  it('notifies subscribers until unsubscribed and dispose cancels timers', async () => {
    const { effects, timers } = fakeEffects();
    const controller = createUpdateController(effects);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.start();
    await controller.checkNow();
    expect(listener).toHaveBeenCalledWith({ kind: 'checking' });
    const count = listener.mock.calls.length;
    unsubscribe();
    await controller.checkNow();
    expect(listener).toHaveBeenCalledTimes(count);
    const other = vi.fn();
    controller.subscribe(other);
    controller.dispose();
    expect(timers.every((t) => t.cancelled)).toBe(true);
    await controller.checkNow();
    expect(other).not.toHaveBeenCalled();
  });
});
