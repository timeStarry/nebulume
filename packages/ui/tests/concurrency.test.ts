import { expect, it } from 'vitest';
import { createConcurrencyLimit, createPreviewScheduler } from '../src/concurrency';

it('caps preview downloads and releases a slot after both success and failure', async () => {
  const limited = createConcurrencyLimit(4);
  const controls: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const gates = Array.from(
    { length: 6 },
    () => new Promise<void>((resolve, reject) => controls.push({ resolve, reject })),
  );
  let active = 0,
    peak = 0,
    started = 0;
  const tasks = gates.map((gate) =>
    limited(async () => {
      active++;
      started++;
      peak = Math.max(peak, active);
      try {
        await gate;
      } finally {
        active--;
      }
    }),
  );
  expect(started).toBe(4);
  controls[0].resolve();
  await tasks[0];
  expect(started).toBe(5);
  controls[1].reject(new Error('decode failed'));
  await expect(tasks[1]).rejects.toThrow('decode failed');
  expect(started).toBe(6);
  controls.forEach((control) => control.resolve());
  await Promise.allSettled(tasks);
  expect(peak).toBe(4);
  expect(active).toBe(0);
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
it('removes cancelled waiting work and never invokes pre-aborted work', async () => {
  const limited = createConcurrencyLimit(1);
  const first = gate();
  const active = limited(() => first.promise);
  let starts = 0;
  const controller = new AbortController();
  const queued = limited(
    async () => {
      starts++;
    },
    { signal: controller.signal },
  );
  const cancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await cancelled;
  const preAborted = new AbortController();
  preAborted.abort();
  await expect(
    limited(
      async () => {
        starts++;
      },
      { signal: preAborted.signal },
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  first.resolve();
  await active;
  await limited(async () => {
    starts++;
  });
  expect(starts).toBe(1);
});
it('does not release an active IPC slot or reject its result when its signal is aborted', async () => {
  const limited = createConcurrencyLimit(1);
  const first = gate();
  const controller = new AbortController();
  const active = limited(
    async () => {
      await first.promise;
      return 'actual result';
    },
    { signal: controller.signal },
  );
  let nextStarted = false;
  const queued = limited(async () => {
    nextStarted = true;
  });
  controller.abort();
  expect(nextStarted).toBe(false);
  first.resolve();
  await expect(active).resolves.toBe('actual result');
  await queued;
  expect(nextStarted).toBe(true);
});
it('isolates source and current-viewer channels from a saturated remote thumbnail queue', async () => {
  const schedule = createPreviewScheduler();
  const held = gate();
  let remoteStarted = 0;
  const thumbnails = Array.from({ length: 6 }, () =>
    schedule(
      async () => {
        remoteStarted++;
        await held.promise;
      },
      { source: 'remote', priority: 'thumbnail' },
    ),
  );
  expect(remoteStarted).toBe(4);
  await expect(
    schedule(async () => 'local thumbnail', { source: 'local', priority: 'thumbnail' }),
  ).resolves.toBe('local thumbnail');
  await expect(
    schedule(async () => 'local viewer', { source: 'local', priority: 'viewer' }),
  ).resolves.toBe('local viewer');
  await expect(
    schedule(async () => 'remote viewer', { source: 'remote', priority: 'viewer' }),
  ).resolves.toBe('remote viewer');
  expect(remoteStarted).toBe(4);
  held.resolve();
  await Promise.all(thumbnails);
  expect(remoteStarted).toBe(6);
});
