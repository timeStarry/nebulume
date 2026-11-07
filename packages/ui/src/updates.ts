import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { desktop } from './api';
import { createUpdateController, type AvailableUpdate } from './update-controller';

const AUTO_KEY = 'nebulume.update.auto';
const CHECK_TIMEOUT_MS = 30_000;

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeAuto(value: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, String(value));
  } catch {
    /* The preference remains effective for this session. */
  }
}

async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update = await check({ timeout: CHECK_TIMEOUT_MS });
  if (!update) return null;
  return {
    version: update.version,
    body: update.body,
    date: update.date,
    download: (onEvent) => update.download(onEvent),
    install: () => update.install(),
  };
}

export const updates = createUpdateController({
  support: () =>
    desktop
      ? invoke<{ supported: boolean; kind: string }>('update_support')
      : Promise.resolve({ supported: false, kind: 'browser' }),
  check: checkForUpdate,
  prepare: () => invoke('prepare_for_update'),
  relaunch: () => relaunch(),
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const id = window.setTimeout(fn, ms);
    return () => window.clearTimeout(id);
  },
  readAuto,
  writeAuto,
});
