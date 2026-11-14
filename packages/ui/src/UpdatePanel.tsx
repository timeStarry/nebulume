import {
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch as SolidSwitch,
} from 'solid-js';
import { desktop, openDataDirectory, openProjectUrl } from './api';
import BrandMark from './BrandMark';
import {
  parseInlineRuns,
  parseReleaseNotes,
  type InlineRun,
  type ReleaseNoteBlock,
} from './release-notes';
import { Button, Dialog, Group, ListRow, Progress, Spinner, Switch } from './ui';
import type { UnsupportedReason, UpdateState } from './update-controller';
import { updates } from './updates';
import './update.css';

export { parseInlineRuns, parseReleaseNotes, type InlineRun, type ReleaseNoteBlock };

const GITHUB_URL = 'https://github.com/timeStarry/lumen';

const UNSUPPORTED_COPY: Record<UnsupportedReason, string> = {
  portable: '独立程序不支持自动更新，请从 Release 页面下载新版本。',
  development: '开发构建不检查更新。',
  unsupported_platform: '当前平台暂未提供安装包更新。',
  browser: '浏览器演示不检查更新。',
};

function InlineRunsView(props: { runs: InlineRun[] }) {
  return (
    <For each={props.runs}>
      {(run) => (
        <SolidSwitch>
          <Match when={run.kind === 'code'}>
            <code class="update-inline-code">{run.text}</code>
          </Match>
          <Match when={run.kind === 'strong'}>
            <strong>{run.text}</strong>
          </Match>
          <Match when={run.kind === 'text'}>{run.text}</Match>
        </SolidSwitch>
      )}
    </For>
  );
}

const [aboutMountedCount, setAboutMountedCount] = createSignal(0);
const [notesDialogOpen, setNotesDialogOpen] = createSignal(false);

function useUpdateState() {
  const [state, setState] = createSignal<UpdateState>(updates.state());
  onCleanup(updates.subscribe(setState));
  return state;
}

export function useHasPendingUpdate() {
  const state = useUpdateState();
  return () => {
    const kind = state().kind;
    return kind === 'available' || kind === 'downloading' || kind === 'installing';
  };
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function downloadFraction(state: Extract<UpdateState, { kind: 'downloading' }>): number | undefined {
  if (!state.total || state.total <= 0) return undefined;
  return Math.min(1, state.received / state.total);
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

  onMount(() => {
    setAboutMountedCount((n) => n + 1);
    onCleanup(() => setAboutMountedCount((n) => Math.max(0, n - 1)));
  });

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
  const activeUpdate = () => {
    const current = state();
    return current.kind === 'available' ||
      current.kind === 'downloading' ||
      current.kind === 'installing'
      ? current
      : null;
  };
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
        <div class="about-hero-actions">
          <Button
            size="sm"
            icon="external-link"
            onClick={() => void openProjectUrl(GITHUB_URL).catch(() => {})}
          >
            GitHub
          </Button>
        </div>
      </div>

      <Group title="软件更新">
        <Show
          when={!unsupported()}
          fallback={<ListRow title="更新通道" description={UNSUPPORTED_COPY[unsupported()!]} />}
        >
          <Show
            when={activeUpdate()}
            fallback={
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
            }
          >
            {(current) => (
              <div
                class="update-about-region"
                role="region"
                aria-label={`Lumen ${current().version} 可用`}
              >
                <SolidSwitch>
                  <Match when={current().kind === 'available' && current()}>
                    {(availSignal) => {
                      const available = () =>
                        availSignal() as Extract<UpdateState, { kind: 'available' }>;
                      const parsed = createMemo(() => parseReleaseNotes(available().notes));
                      return (
                        <ListRow
                          title={
                            <span class="update-title-badge">
                              <span class="update-dot" aria-hidden="true" />
                              Lumen {available().version} 可用
                            </span>
                          }
                          description={
                            <div class="update-about-desc">
                              <span>
                                {parsed().headline || '新版本已准备就绪，安装前会自动保存并暂停后台任务。'}
                              </span>
                              <Show when={available().error}>
                                <span class="update-note error" role="alert">
                                  下载失败：{available().error}，可重试。
                                </span>
                              </Show>
                            </div>
                          }
                          control={
                            <div class="update-actions">
                              <Show when={available().notes.trim().length > 0}>
                                <Button size="sm" onClick={() => setNotesDialogOpen(true)}>
                                  更新内容
                                </Button>
                              </Show>
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => void updates.install()}
                              >
                                立即重启安装
                              </Button>
                            </div>
                          }
                        />
                      );
                    }}
                  </Match>
                  <Match when={current().kind === 'downloading' && current()}>
                    {(dlSignal) => {
                      const downloading = () =>
                        dlSignal() as Extract<UpdateState, { kind: 'downloading' }>;
                      return (
                        <ListRow
                          title={`正在下载 Lumen ${downloading().version}`}
                          description={
                            <div class="update-progress" role="status">
                              <Progress
                                value={downloadFraction(downloading())}
                                label="更新下载进度"
                                class="update-progress-track"
                              />
                              <span class="update-progress-meta">
                                正在下载 {megabytes(downloading().received)}
                                <Show when={downloading().total}>
                                  /{megabytes(downloading().total!)}
                                </Show>{' '}
                                MB
                              </span>
                            </div>
                          }
                        />
                      );
                    }}
                  </Match>
                  <Match when={current().kind === 'installing'}>
                    <ListRow
                      title={`正在安装 Lumen ${current().version}`}
                      description={
                        <span class="update-installing" role="status">
                          <Spinner size="sm" />
                          <span>正在准备安装，应用将自动重启…</span>
                        </span>
                      }
                    />
                  </Match>
                </SolidSwitch>
              </div>
            )}
          </Show>
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
  let cachedNotes = '';
  let cachedVersion = '';

  const bannerVisible = () => {
    if (aboutMountedCount() > 0) return false;
    const current = state();
    if (current.kind === 'downloading' || current.kind === 'installing') return true;
    if (current.kind === 'available') return !current.dismissed;
    return false;
  };

  const version = () => {
    const current = state();
    if ('version' in current) {
      cachedVersion = current.version;
      if (current.kind === 'available' && current.notes) cachedNotes = current.notes;
      return current.version;
    }
    return cachedVersion;
  };

  const notes = () => {
    const current = state();
    if (current.kind === 'available') {
      cachedNotes = current.notes;
      return current.notes;
    }
    return cachedNotes;
  };

  const dialogVisible = () => {
    const kind = state().kind;
    return notesDialogOpen() && (kind === 'available' || kind === 'downloading' || kind === 'installing');
  };

  const parsedNotes = createMemo(() => parseReleaseNotes(notes()));

  return (
    <>
      <Show when={bannerVisible()}>
        <section
          class="update-bar"
          aria-label={`Lumen ${version()} 可用`}
          role="region"
        >
          <SolidSwitch>
            <Match when={state().kind === 'available' && state()}>
              {(current) => {
                const available = () => current() as Extract<UpdateState, { kind: 'available' }>;
                return (
                  <>
                    <div class="update-bar-lead">
                      <span class="update-dot" aria-hidden="true" />
                      <strong class="update-bar-title">Lumen {available().version} 可用</strong>
                      <Show
                        when={!available().error}
                        fallback={
                          <span class="update-bar-summary error" role="alert">
                            下载失败：{available().error}，可重试。
                          </span>
                        }
                      >
                        <Show when={parsedNotes().headline}>
                          <span class="update-bar-summary">{parsedNotes().headline}</span>
                        </Show>
                      </Show>
                    </div>
                    <div class="update-bar-actions">
                      <Show when={available().notes.trim().length > 0}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setNotesDialogOpen(true)}
                        >
                          更新内容
                        </Button>
                      </Show>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void updates.install()}
                      >
                        立即重启安装
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => updates.dismiss()}
                      >
                        稍后
                      </Button>
                    </div>
                  </>
                );
              }}
            </Match>
            <Match when={state().kind === 'downloading' && state()}>
              {(current) => {
                const downloading = () =>
                  current() as Extract<UpdateState, { kind: 'downloading' }>;
                return (
                  <div class="update-bar-progress-row" role="status">
                    <span class="update-dot" aria-hidden="true" />
                    <strong class="update-bar-title">正在更新 Lumen {downloading().version}</strong>
                    <Progress
                      value={downloadFraction(downloading())}
                      label="更新下载进度"
                      class="update-bar-track"
                    />
                    <span class="update-progress-meta">
                      正在下载 {megabytes(downloading().received)}
                      <Show when={downloading().total}>/{megabytes(downloading().total!)}</Show> MB
                    </span>
                  </div>
                );
              }}
            </Match>
            <Match when={state().kind === 'installing'}>
              <div class="update-bar-progress-row" role="status">
                <Spinner size="sm" />
                <span class="update-bar-summary">正在准备安装，应用将自动重启…</span>
              </div>
            </Match>
          </SolidSwitch>
        </section>
      </Show>

      <Show when={dialogVisible()}>
        <Dialog
          title={`Lumen ${version()} 更新内容`}
          subtitle={`当前版本 v${__APP_VERSION__} → v${version()}`}
          width={520}
          busy={state().kind === 'installing'}
          onClose={() => setNotesDialogOpen(false)}
          footer={
            <SolidSwitch>
              <Match when={state().kind === 'available'}>
                <>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      updates.dismiss();
                      setNotesDialogOpen(false);
                    }}
                  >
                    稍后
                  </Button>
                  <Button variant="primary" onClick={() => void updates.install()}>
                    立即重启安装
                  </Button>
                </>
              </Match>
              <Match when={state().kind === 'downloading' && state()}>
                {(current) => {
                  const downloading = () =>
                    current() as Extract<UpdateState, { kind: 'downloading' }>;
                  return (
                    <div class="update-dialog-progress" role="status">
                      <Progress
                        value={downloadFraction(downloading())}
                        label="更新下载进度"
                        class="update-progress-track"
                      />
                      <span class="update-progress-meta">
                        正在下载 {megabytes(downloading().received)}
                        <Show when={downloading().total}>/{megabytes(downloading().total!)}</Show>{' '}
                        MB
                      </span>
                    </div>
                  );
                }}
              </Match>
              <Match when={state().kind === 'installing'}>
                <span class="update-installing" role="status">
                  <Spinner size="sm" />
                  <span>正在准备安装，应用将自动重启…</span>
                </span>
              </Match>
            </SolidSwitch>
          }
        >
          <div class="update-notes-sheet">
            <Show
              when={parsedNotes().blocks.length > 0}
              fallback={<p class="update-notes-para">包含常规性能优化与稳定性修复。</p>}
            >
              <For each={parsedNotes().blocks}>
                {(block) => (
                  <SolidSwitch>
                    <Match when={block.kind === 'heading' && block}>
                      {(h) => (
                        <h4 class="update-notes-heading">
                          {(h() as Extract<ReleaseNoteBlock, { kind: 'heading' }>).text}
                        </h4>
                      )}
                    </Match>
                    <Match when={block.kind === 'paragraph' && block}>
                      {(p) => (
                        <p class="update-notes-para">
                          <InlineRunsView
                            runs={(p() as Extract<ReleaseNoteBlock, { kind: 'paragraph' }>).runs}
                          />
                        </p>
                      )}
                    </Match>
                    <Match when={block.kind === 'list' && block}>
                      {(l) => (
                        <ul class="update-notes-list">
                          <For each={(l() as Extract<ReleaseNoteBlock, { kind: 'list' }>).items}>
                            {(item) => (
                              <li>
                                <InlineRunsView runs={item} />
                              </li>
                            )}
                          </For>
                        </ul>
                      )}
                    </Match>
                  </SolidSwitch>
                )}
              </For>
            </Show>
          </div>
        </Dialog>
      </Show>
    </>
  );
}
