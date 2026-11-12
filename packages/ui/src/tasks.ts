import { createSignal } from 'solid-js';
import { errorMessage } from './model';

export type TaskKind = 'scan' | 'pregenerate' | 'capture_index' | 'fingerprint' | 'export' | 'pin';
export type TaskStatus = 'running' | 'completed' | 'failed';

export interface BackgroundTask {
  id: string;
  kind: TaskKind;
  libraryId?: string;
  title: string;
  detail?: string;
  processed?: number;
  total?: number;
  status: TaskStatus;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface TaskStartInput {
  kind: TaskKind;
  libraryId?: string;
  title: string;
  detail?: string;
  processed?: number;
  total?: number;
}

export interface TaskProgressPatch {
  title?: string;
  detail?: string;
  processed?: number;
  total?: number;
}

export interface TaskCenter {
  tasks: () => readonly BackgroundTask[];
  running: () => readonly BackgroundTask[];
  failedCount: () => number;
  isRunning: (kind?: TaskKind, libraryId?: string) => boolean;
  start: (input: TaskStartInput) => string;
  progress: (id: string, patch: TaskProgressPatch) => void;
  complete: (id: string, detail?: string) => void;
  fail: (id: string, error: string) => void;
  dismiss: (id: string) => void;
  clearFinished: () => void;
  run: <T>(
    input: TaskStartInput,
    work: (controls: { id: string; progress: (patch: TaskProgressPatch) => void }) => Promise<T>,
    onDoneDetail?: (value: T) => string | undefined,
  ) => Promise<T>;
}

const DEFAULT_SETTLE_MS = 4500;
const MAX_HISTORY = 12;

/**
 * Non-blocking background task coordinator. Long-running scans, preview pre-generation,
 * and batch exports report progress here instead of locking the entire workspace UI.
 */
export function createTaskCenter(options?: { settleMs?: number }): TaskCenter {
  const settleMs = options?.settleMs ?? DEFAULT_SETTLE_MS;
  const [list, setList] = createSignal<BackgroundTask[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let seq = 0;

  function clearTimer(id: string) {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function dismiss(id: string) {
    clearTimer(id);
    setList((prev) => prev.filter((item) => item.id !== id));
  }

  function trimHistory(items: BackgroundTask[]): BackgroundTask[] {
    if (items.length <= MAX_HISTORY) return items;
    const active = items.filter((item) => item.status === 'running');
    const finished = items.filter((item) => item.status !== 'running');
    const keepFinished = Math.max(0, MAX_HISTORY - active.length);
    return [...active, ...finished.slice(-keepFinished)];
  }

  function start(input: TaskStartInput): string {
    const id = `task-${++seq}`;
    const entry: BackgroundTask = {
      id,
      kind: input.kind,
      libraryId: input.libraryId,
      title: input.title,
      detail: input.detail,
      processed: input.processed,
      total: input.total,
      status: 'running',
      startedAt: Date.now(),
    };
    setList((prev) => trimHistory([...prev, entry]));
    return id;
  }

  function progress(id: string, patch: TaskProgressPatch) {
    setList((prev) =>
      prev.map((item) =>
        item.id === id && item.status === 'running'
          ? {
              ...item,
              ...(patch.title !== undefined ? { title: patch.title } : {}),
              ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
              ...(patch.processed !== undefined ? { processed: patch.processed } : {}),
              ...(patch.total !== undefined ? { total: patch.total } : {}),
            }
          : item,
      ),
    );
  }

  function complete(id: string, detail?: string) {
    clearTimer(id);
    const finishedAt = Date.now();
    setList((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'completed',
              ...(detail !== undefined ? { detail } : {}),
              ...(item.total !== undefined ? { processed: item.total } : {}),
              finishedAt,
            }
          : item,
      ),
    );
    if (settleMs > 0) {
      timers.set(
        id,
        setTimeout(() => dismiss(id), settleMs),
      );
    }
  }

  function fail(id: string, error: string) {
    clearTimer(id);
    const finishedAt = Date.now();
    setList((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'failed',
              error,
              finishedAt,
            }
          : item,
      ),
    );
  }

  function clearFinished() {
    for (const item of list()) {
      if (item.status !== 'running') clearTimer(item.id);
    }
    setList((prev) => prev.filter((item) => item.status === 'running'));
  }

  const tasks = () => {
    const all = list();
    const active = all.filter((item) => item.status === 'running');
    const rest = all.filter((item) => item.status !== 'running').reverse();
    return [...active, ...rest];
  };

  const running = () => list().filter((item) => item.status === 'running');
  const failedCount = () => list().filter((item) => item.status === 'failed').length;

  function isRunning(kind?: TaskKind, libraryId?: string): boolean {
    return running().some(
      (item) =>
        (kind === undefined || item.kind === kind) &&
        (libraryId === undefined || item.libraryId === libraryId),
    );
  }

  async function run<T>(
    input: TaskStartInput,
    work: (controls: { id: string; progress: (patch: TaskProgressPatch) => void }) => Promise<T>,
    onDoneDetail?: (value: T) => string | undefined,
  ): Promise<T> {
    const id = start(input);
    try {
      const value = await work({
        id,
        progress: (patch) => progress(id, patch),
      });
      complete(id, onDoneDetail?.(value));
      return value;
    } catch (err) {
      fail(id, errorMessage(err));
      throw err;
    }
  }

  return {
    tasks,
    running,
    failedCount,
    isRunning,
    start,
    progress,
    complete,
    fail,
    dismiss,
    clearFinished,
    run,
  };
}
