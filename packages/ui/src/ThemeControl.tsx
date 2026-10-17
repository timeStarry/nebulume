import { Show } from 'solid-js';
import { setThemePreference, themeNotice, themePreference, type ThemePreference } from './theme';

export default function ThemeControl() {
  return (
    <div class="theme-control">
      <label for="appearance-theme">外观主题</label>
      <select
        id="appearance-theme"
        value={themePreference()}
        onChange={(event) => setThemePreference(event.currentTarget.value as ThemePreference)}
      >
        <option value="dark">深色</option>
        <option value="light">浅色</option>
        <option value="system">跟随系统</option>
      </select>
      <Show when={themeNotice()}>
        <p class="theme-notice" role="status">
          {themeNotice()}
        </p>
      </Show>
    </div>
  );
}
