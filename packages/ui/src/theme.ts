import { createSignal } from 'solid-js';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'nebulume.theme';

export function parseThemePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'system' ? value : 'dark';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

function savedPreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'dark';
  }
}

const [themePreference, updatePreference] = createSignal<ThemePreference>(savedPreference());
const [resolvedTheme, updateResolved] = createSignal<ResolvedTheme>('dark');
const [themeNotice, updateNotice] = createSignal('');
export { themePreference, resolvedTheme, themeNotice };
let media: MediaQueryList | undefined;
let initialized = false;
let nativeRequest = 0;

function applyResolvedTheme(theme: ResolvedTheme) {
  updateResolved(theme);
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#242933' : '#ECEFF4');
}

async function synchronizeNativeTheme() {
  if (!isTauri()) return;
  const request = ++nativeRequest;
  try {
    const window = getCurrentWindow();
    // A native explicit theme can override WebView2's shared color-scheme media.
    // Clear that override for system mode, and use the OS window theme as truth.
    // The viewer's neutral dark canvas is maintained by CSS, not by its profile.
    const preference = themePreference();
    await window.setTheme(preference === 'system' ? null : preference);
    if (preference === 'system') {
      const theme = await window.theme();
      if (request === nativeRequest && themePreference() === 'system' && theme) {
        applyResolvedTheme(theme);
      }
    }
  } catch {
    if (request === nativeRequest) updateNotice('界面主题已更新，系统窗口边框未能同步。');
  }
}

function applyTheme() {
  applyResolvedTheme(resolveTheme(themePreference(), media?.matches ?? true));
  void synchronizeNativeTheme();
}

export function initializeTheme() {
  if (initialized) return;
  initialized = true;
  media = window.matchMedia('(prefers-color-scheme: dark)');
  if (isTauri()) {
    try {
      void getCurrentWindow()
        .onThemeChanged(({ payload }) => {
          if (themePreference() === 'system') applyResolvedTheme(payload);
        })
        .catch(() => updateNotice('系统主题变化暂时无法同步；可手动选择外观。'));
    } catch {
      updateNotice('系统主题变化暂时无法同步；可手动选择外观。');
    }
  }
  applyTheme();
  media.addEventListener('change', () => {
    if (themePreference() === 'system' && !isTauri()) {
      applyResolvedTheme(resolveTheme('system', media?.matches ?? true));
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    updatePreference(parseThemePreference(event.key === null ? null : event.newValue));
    applyTheme();
  });
}

export function setThemePreference(preference: ThemePreference) {
  updatePreference(preference);
  updateNotice('');
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    updateNotice('主题仅在当前窗口生效；本机偏好设置暂时无法保存。');
  }
  applyTheme();
}
