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
it('an aborted in-flight load rejects its caller at once but keeps the slot until it settles', async () => {
  const schedule = createPreviewScheduler({ thumbnail: 1 });
  const request = gate();
  const controller = new AbortController();
  let settled = false;
  const first = schedule(
    () =>
      request.promise.then(() => {
        settled = true;
        return 'decoded';
      }),
    { signal: controller.signal, rejectInFlightOnAbort: true },
  );
  let secondStarted = false;
  const second = schedule(async () => {
    secondStarted = true;
  });
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(secondStarted).toBe(false);
  request.resolve();
  await second;
  expect(settled).toBe(true);
  expect(secondStarted).toBe(true);
});
it('cancels queued work immediately even when in-flight aborts detach', async () => {
  const limited = createConcurrencyLimit(1);
  const held = gate();
  const active = limited(() => held.promise);
  const controller = new AbortController();
  let started = false;
  const queued = limited(
    async () => {
      started = true;
    },
    { signal: controller.signal, rejectInFlightOnAbort: true },
  );
  const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  held.resolve();
  await active;
  expect(started).toBe(false);
});

it('dispatches queued thumbnail previews in LIFO order while viewer lane stays FIFO', async () => {
  const schedule = createPreviewScheduler({ thumbnail: 1, viewer: 1 });
  const thumbHold = gate();
  const viewerHold = gate();
  const thumbOrder: string[] = [];
  const viewerOrder: string[] = [];

  const firstThumb = schedule(() => thumbHold.promise, {
    source: 'remote',
    priority: 'thumbnail',
  });
  const t1 = schedule(
    async () => {
      thumbOrder.push('T1');
    },
    { source: 'remote', priority: 'thumbnail' },
  );
  const t2 = schedule(
    async () => {
      thumbOrder.push('T2');
    },
    { source: 'remote', priority: 'thumbnail' },
  );
  const t3 = schedule(
    async () => {
      thumbOrder.push('T3');
    },
    { source: 'remote', priority: 'thumbnail' },
  );

  const firstViewer = schedule(() => viewerHold.promise, {
    source: 'remote',
    priority: 'viewer',
  });
  const v1 = schedule(
    async () => {
      viewerOrder.push('V1');
    },
    { source: 'remote', priority: 'viewer' },
  );
  const v2 = schedule(
    async () => {
      viewerOrder.push('V2');
    },
    { source: 'remote', priority: 'viewer' },
  );

  thumbHold.resolve();
  viewerHold.resolve();
  await Promise.all([firstThumb, t1, t2, t3, firstViewer, v1, v2]);

  expect(thumbOrder).toEqual(['T3', 'T2', 'T1']);
  expect(viewerOrder).toEqual(['V1', 'V2']);
});
