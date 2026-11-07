import { createSignal, Match, onCleanup, Show, Switch } from 'solid-js';
import { desktop } from './api';
import type { UnsupportedReason, UpdateState } from './update-controller';
import { updates } from './updates';
import './update.css';

const UNSUPPORTED_COPY: Record<UnsupportedReason, string> = {
  portable: '独立程序不支持自动更新，请从 Release 页面下载新版本。',
  development: '开发构建不检查更新。',
  unsupported_platform: '当前平台暂未提供安装包更新。',
  browser: '浏览器演示不检查更新。',
};

function useUpdateState() {
  const [state, setState] = createSignal<UpdateState>(updates.state());
  onCleanup(updates.subscribe(setState));
  return state;
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function readAutoPreference(): boolean {
  try {
    return localStorage.getItem('nebulume.update.auto') !== 'false';
  } catch {
    return true;
  }
}

export function AboutPanel(props: { system?: Record<string, unknown> }) {
  const state = useUpdateState();
  const [auto, setAuto] = createSignal(readAutoPreference());
  const [lastResult, setLastResult] = createSignal<UpdateState | null>(null);
  onCleanup(
    updates.subscribe((next) => {
      if (next.kind === 'up-to-date' || next.kind === 'failed') setLastResult(next);
    }),
  );
  const unsupported = () => {
    const current = state();
    return current.kind === 'unsupported' ? current.reason : null;
  };
  const checking = () => state().kind === 'checking';
  const result = () => {
    const current = state();
    return current.kind === 'up-to-date' || current.kind === 'failed' ? current : lastResult();
  };
  return (
    <section class="settings-panel" aria-labelledby="about-heading">
      <h2 id="about-heading">关于与诊断</h2>
      <p>
        Nebulume {__APP_VERSION__} · {desktop ? '桌面应用' : '浏览器演示'}
      </p>
      <Show
        when={!unsupported()}
        fallback={<p class="update-note">{UNSUPPORTED_COPY[unsupported()!]}</p>}
      >
        <div class="settings-row update-row">
          <div class="update-actions">
            <button
              class="button small"
              disabled={checking()}
              onClick={() => void updates.checkNow()}
            >
              {checking() ? '正在检查…' : '检查更新'}
            </button>
            <Show when={result()}>
              {(current) => (
                <Switch>
                  <Match when={current().kind === 'up-to-date' && current()}>
                    {(done) => (
                      <span class="update-note" role="status">
                        已是最新版本 · 检查于{' '}
                        {new Date((done() as { checkedAt: number }).checkedAt).toLocaleString()}
                      </span>
                    )}
                  </Match>
                  <Match when={current().kind === 'failed' && current()}>
                    {(failed) => (
                      <span class="update-note error" role="status">
                        上次检查失败：{(failed() as { message: string }).message}
                      </span>
                    )}
                  </Match>
                </Switch>
              )}
            </Show>
          </div>
          <label class="update-auto">
            <input
              type="checkbox"
              checked={auto()}
              onChange={(event) => {
                const value = event.currentTarget.checked;
                setAuto(value);
                updates.setAuto(value);
              }}
            />
            自动检查更新
          </label>
        </div>
      </Show>
      <details>
        <summary>运行时能力与限制</summary>
        <pre>{JSON.stringify(props.system || { status: '运行信息暂不可用' }, null, 2)}</pre>
      </details>
    </section>
  );
}

export function UpdatePrompt() {
  const state = useUpdateState();
  const visible = () => {
    const kind = state().kind;
    return kind === 'available' || kind === 'downloading' || kind === 'installing';
  };
  const version = () => {
    const current = state();
    return 'version' in current ? current.version : '';
  };
  return (
    <Show when={visible()}>
      <section class="update-prompt" aria-labelledby="update-prompt-title" role="region">
        <h2 id="update-prompt-title">Nebulume {version()} 可用</h2>
        <Switch>
          <Match when={state().kind === 'available' && state()}>
            {(current) => {
              const available = current() as Extract<UpdateState, { kind: 'available' }>;
              return (
                <>
                  <Show when={available.notes}>
                    <div class="update-notes">{available.notes}</div>
                  </Show>
                  <Show when={available.error}>
                    <p class="update-note error" role="alert">
                      下载失败：{available.error}，可重试。
                    </p>
                  </Show>
                  <div class="update-actions">
                    <button class="button primary small" onClick={() => void updates.install()}>
                      立即重启安装
                    </button>
                    <button class="button small" onClick={() => updates.dismiss()}>
                      稍后
                    </button>
                  </div>
                </>
              );
            }}
          </Match>
          <Match when={state().kind === 'downloading' && state()}>
            {(current) => {
              const downloading = () => current() as Extract<UpdateState, { kind: 'downloading' }>;
              return (
                <div class="update-progress" role="status">
                  <Show
                    when={downloading().total}
                    fallback={<progress aria-label="更新下载进度" />}
                  >
                    {(total) => (
                      <progress
                        max={total()}
                        value={Math.min(downloading().received, total())}
                        aria-label="更新下载进度"
                      />
                    )}
                  </Show>
                  <span>
                    正在下载 {megabytes(downloading().received)}
                    <Show when={downloading().total}>/{megabytes(downloading().total!)}</Show> MB
                  </span>
                </div>
              );
            }}
          </Match>
          <Match when={state().kind === 'installing'}>
            <p class="update-note" role="status">
              正在准备安装，应用将自动重启
            </p>
          </Match>
        </Switch>
      </section>
    </Show>
  );
}
