import { expect, it } from 'vitest';
import { createConcurrencyLimit } from '../src/concurrency';

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
