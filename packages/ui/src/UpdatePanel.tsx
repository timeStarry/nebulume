import { createSignal, Match, onCleanup, Show, Switch as SolidSwitch } from 'solid-js';
import { desktop, openDataDirectory } from './api';
import BrandMark from './BrandMark';
import { Button, Group, ListRow, Switch } from './ui';
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
  const [copied, setCopied] = createSignal(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(
    updates.subscribe((next) => {
      if (next.kind === 'up-to-date' || next.kind === 'failed') setLastResult(next);
    }),
  );
  onCleanup(() => clearTimeout(copyTimer));

  const unsupported = () => {
    const current = state();
    return current.kind === 'unsupported' ? current.reason : null;
  };
  const checking = () => state().kind === 'checking';
  const result = () => {
    const current = state();
    return current.kind === 'up-to-date' || current.kind === 'failed' ? current : lastResult();
  };

  async function copyDiagnostics() {
    const readOnly = props.system?.originals_read_only !== false ? '严格只读' : '标准';
    const platform =
      (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) ||
      '未知平台';
    const summary = [
      `版本：Lumen ${__APP_VERSION__}`,
      `运行模式：${desktop ? '桌面应用' : '浏览器演示'}`,
      `系统环境：${platform}`,
      `原片保护：${readOnly}`,
    ].join('\n');
    try {
      await navigator.clipboard?.writeText(summary);
      setCopied(true);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setCopied(false), 2400);
    } catch {
      /* Clipboard access may be unavailable in restricted contexts. */
    }
  }

  return (
    <div class="about-panel" role="region" aria-labelledby="about-heading">
      <div class="about-hero">
        <BrandMark size={40} />
        <div class="about-hero-copy">
          <div class="about-title-row">
            <h2 id="about-heading">Lumen</h2>
            <span class="about-version">v{__APP_VERSION__}</span>
          </div>
          <p class="about-tagline">安静、顺手的照片库与选片工具</p>
        </div>
      </div>

      <Group title="软件更新">
        <Show
          when={!unsupported()}
          fallback={<ListRow title="更新通道" description={UNSUPPORTED_COPY[unsupported()!]} />}
        >
          <ListRow
            title="版本状态"
            description={
              <Show when={result()} fallback="通过官方通道获取安全更新">
                {(current) => (
                  <SolidSwitch>
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
                  </SolidSwitch>
                )}
              </Show>
            }
            control={
              <Button size="sm" disabled={checking()} onClick={() => void updates.checkNow()}>
                {checking() ? '正在检查…' : '检查更新'}
              </Button>
            }
          />
          <ListRow
            title="自动检查更新"
            description="启动应用时在后台静默检查新版本"
            control={
              <Switch
                label="自动检查更新"
                checked={auto()}
                onChange={(value) => {
                  setAuto(value);
                  updates.setAuto(value);
                }}
              />
            }
          />
        </Show>
      </Group>

      <Group title="数据与支持">
        <Show when={desktop}>
          <ListRow
            title="本地目录与索引"
            description="在访达或资源管理器中查看目录数据库与日志位置"
            control={
              <Button
                size="sm"
                icon="folder-open"
                onClick={() => void openDataDirectory().catch(() => {})}
              >
                打开数据目录
              </Button>
            }
          />
        </Show>
        <ListRow
          title="技术支持诊断摘要"
          description={
            copied()
              ? '已复制环境摘要，可直接粘贴至反馈工单'
              : '反馈问题时复制脱敏的版本与平台环境信息（不含路径或凭据）'
          }
          control={
            <Button
              size="sm"
              icon={copied() ? 'check' : 'copy'}
              onClick={() => void copyDiagnostics()}
            >
              {copied() ? '已复制' : '复制诊断摘要'}
            </Button>
          }
        />
      </Group>
    </div>
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
        <h2 id="update-prompt-title">Lumen {version()} 可用</h2>
        <SolidSwitch>
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
                    <Button variant="primary" size="sm" onClick={() => void updates.install()}>
                      立即重启安装
                    </Button>
                    <Button size="sm" onClick={() => updates.dismiss()}>
                      稍后
                    </Button>
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
        </SolidSwitch>
      </section>
    </Show>
  );
}
