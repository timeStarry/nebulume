export interface QueueOptions {
  signal?: AbortSignal;
  /**
   * After dispatch, an abort rejects the caller at once while the operation keeps its slot
   * until it settles. For image loads whose backend work cannot be interrupted.
   */
  rejectInFlightOnAbort?: boolean;
}
export interface PreviewRequestOptions extends QueueOptions {
  source?: 'local' | 'remote';
  priority?: 'thumbnail' | 'viewer';
}
export function isQueueAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
export function abortError(message = 'Preview request cancelled before dispatch'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
// Cancellation removes only waiting work. Once started, an operation owns its slot until it
// settles; AbortSignal cannot interrupt an already issued Tauri call or protocol render.
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
        const detach = () => reject(abortError('Preview request cancelled in flight'));
        if (options.rejectInFlightOnAbort)
          signal?.addEventListener('abort', detach, { once: true });
        const settle = () => {
          signal?.removeEventListener('abort', detach);
          release();
        };
        try {
          Promise.resolve(operation()).then(
            (value) => {
              settle();
              resolve(value);
            },
            (error) => {
              settle();
              reject(error);
            },
          );
        } catch (error) {
          settle();
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
/** Rejects as soon as `signal` aborts; otherwise mirrors `promise`. */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError('Preview request cancelled in flight'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError('Preview request cancelled in flight'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
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
