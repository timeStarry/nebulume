export interface QueueOptions {
  signal?: AbortSignal;
}
export interface PreviewRequestOptions extends QueueOptions {
  source?: 'local' | 'remote';
  priority?: 'thumbnail' | 'viewer';
}
export function isQueueAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
function abortError(): Error {
  const error = new Error('Preview request cancelled before dispatch');
  error.name = 'AbortError';
  return error;
}
// Cancellation removes only waiting work. Once started, an IPC operation owns its
// slot until it settles; AbortSignal cannot interrupt an already issued Tauri call.
export function createConcurrencyLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency limit must be positive');
  let active = 0;
  const waiting = new Set<{ start: () => void }>();
  function release() {
    active--;
    while (active < limit && waiting.size) {
      const next = waiting.values().next().value!;
      waiting.delete(next);
      next.start();
    }
  }
  return function limited<T>(operation: () => Promise<T>, options: QueueOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const { signal } = options;
      let pending = true;
      const entry = { start };
      function cancel() {
        if (!pending) return;
        pending = false;
        waiting.delete(entry);
        signal?.removeEventListener('abort', cancel);
        reject(abortError());
      }
      function start() {
        if (!pending) return;
        if (signal?.aborted) {
          cancel();
          return;
        }
        pending = false;
        signal?.removeEventListener('abort', cancel);
        active++;
        try {
          Promise.resolve(operation()).then(
            (value) => {
              release();
              resolve(value);
            },
            (error) => {
              release();
              reject(error);
            },
          );
        } catch (error) {
          release();
          reject(error);
        }
      }
      if (signal?.aborted) {
        cancel();
        return;
      }
      if (active < limit) start();
      else {
        waiting.add(entry);
        signal?.addEventListener('abort', cancel, { once: true });
      }
    });
  };
}
export function createPreviewScheduler(limits: { thumbnail?: number; viewer?: number } = {}) {
  const channels = {
    local: {
      thumbnail: createConcurrencyLimit(limits.thumbnail ?? 4),
      viewer: createConcurrencyLimit(limits.viewer ?? 2),
    },
    remote: {
      thumbnail: createConcurrencyLimit(limits.thumbnail ?? 4),
      viewer: createConcurrencyLimit(limits.viewer ?? 2),
    },
  };
  return <T>(operation: () => Promise<T>, options: PreviewRequestOptions = {}): Promise<T> =>
    channels[options.source ?? 'local'][options.priority ?? 'thumbnail'](operation, options);
}
