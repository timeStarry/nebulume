export type UnsupportedReason = 'portable' | 'development' | 'unsupported_platform' | 'browser';

export type UpdateState =
  | { kind: 'unsupported'; reason: UnsupportedReason }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available'; version: string; notes: string; date?: string; error?: string }
  | { kind: 'downloading'; version: string; received: number; total?: number }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; checkedAt: number; message: string };

export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export interface AvailableUpdate {
  version: string;
  body?: string;
  date?: string;
  download(onEvent: (e: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
}

export interface UpdateEffects {
  support(): Promise<{ supported: boolean; kind: string }>;
  check(): Promise<AvailableUpdate | null>;
  prepare(): Promise<unknown>;
  relaunch(): Promise<void>;
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  readAuto(): boolean;
  writeAuto(value: boolean): void;
}

export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 86_400_000;

const UNSUPPORTED_REASONS: readonly UnsupportedReason[] = ['portable', 'development', 'unsupported_platform', 'browser'];

function unsupportedReason(kind: string): UnsupportedReason {
  return (UNSUPPORTED_REASONS as readonly string[]).includes(kind) ? (kind as UnsupportedReason) : 'unsupported_platform';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function isBusy(state: UpdateState): boolean {
  return state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'installing';
}

export function createUpdateController(effects: UpdateEffects) {
  let current: UpdateState = { kind: 'idle' };
  let supported = false;
  let disposed = false;
  let lastCheckedAt: number | null = null;
  let pending: AvailableUpdate | null = null;
  let cancelTimer: (() => void) | null = null;
  const listeners = new Set<(state: UpdateState) => void>();

  function set(next: UpdateState) {
    current = next;
    for (const listener of [...listeners]) listener(next);
  }

  function clearTimer() {
    const cancel = cancelTimer;
    cancelTimer = null;
    cancel?.();
  }

  function schedule(ms: number) {
    clearTimer();
    if (disposed || !supported) return;
    cancelTimer = effects.setTimer(() => {
      cancelTimer = null;
      void automaticCheck();
    }, ms);
  }

  async function runCheck() {
    if (disposed || !supported || isBusy(current)) return;
    set({ kind: 'checking' });
    try {
      const update = await effects.check();
      if (disposed) return;
      lastCheckedAt = effects.now();
      pending = update;
      if (update) {
        set({ kind: 'available', version: update.version, notes: update.body ?? '', date: update.date });
      } else {
        set({ kind: 'up-to-date', checkedAt: lastCheckedAt });
      }
    } catch (error) {
      if (disposed) return;
      lastCheckedAt = effects.now();
      pending = null;
      set({ kind: 'failed', checkedAt: lastCheckedAt, message: errorMessage(error) });
    }
  }

  async function automaticCheck() {
    await runCheck();
    if (!disposed && effects.readAuto()) schedule(CHECK_INTERVAL_MS);
  }

  return {
    state(): UpdateState {
      return current;
    },
    subscribe(listener: (state: UpdateState) => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(): Promise<void> {
      if (disposed) return;
      let result: { supported: boolean; kind: string };
      try {
        result = await effects.support();
      } catch {
        // Unknown support means the updater cannot be trusted here; never throw out of start.
        result = { supported: false, kind: 'unsupported_platform' };
      }
      if (disposed) return;
      supported = result.supported;
      if (!supported) {
        clearTimer();
        set({ kind: 'unsupported', reason: unsupportedReason(result.kind) });
        return;
      }
      if (effects.readAuto()) schedule(FIRST_CHECK_DELAY_MS);
    },
    checkNow(): Promise<void> {
      return runCheck();
    },
    async install(): Promise<void> {
      if (disposed || current.kind !== 'available' || !pending) return;
      const update = pending;
      const version = update.version;
      const notes = current.notes;
      const date = current.date;
      let received = 0;
      let total: number | undefined;
      set({ kind: 'downloading', version, received, total });
      try {
        await update.download((e) => {
          if (disposed) return;
          if (e.event === 'Started') total = e.data.contentLength;
          else if (e.event === 'Progress') received += e.data.chunkLength;
          set({ kind: 'downloading', version, received, total });
        });
      } catch (error) {
        if (!disposed) set({ kind: 'available', version, notes, date, error: errorMessage(error) });
        return;
      }
      if (disposed) return;
      try {
        // Must run before install(): on Windows the plugin exits the process inside install.
        // Quiesce is best effort: a failure or timed_out report must not block the install.
        await effects.prepare();
      } catch {
        // ignored on purpose
      }
      if (disposed) return;
      set({ kind: 'installing', version });
      try {
        await update.install();
      } catch (error) {
        if (!disposed) set({ kind: 'available', version, notes, date, error: errorMessage(error) });
        return;
      }
      if (disposed) return;
      try {
        // Only reached on macOS/Linux; on Windows the process has already exited.
        await effects.relaunch();
      } catch (error) {
        if (!disposed) set({ kind: 'available', version, notes, date, error: errorMessage(error) });
      }
    },
    dismiss(): void {
      if (current.kind === 'available') set({ kind: 'idle' });
    },
    setAuto(value: boolean): void {
      effects.writeAuto(value);
      if (!value) {
        clearTimer();
        return;
      }
      // Never checked yet: behave like a fresh start. Otherwise wait a full interval
      // so toggling the preference does not trigger an immediate network request.
      schedule(lastCheckedAt === null ? FIRST_CHECK_DELAY_MS : CHECK_INTERVAL_MS);
    },
    dispose(): void {
      disposed = true;
      clearTimer();
      listeners.clear();
    },
  };
}
