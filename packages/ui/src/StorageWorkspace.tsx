import { For, Show, createSignal } from 'solid-js';
import { chooseSave, desktop, execute } from './api';
import {
  bytes,
  errorMessage,
  type StorageCheck,
  type StorageConfig,
  type StorageEntry,
} from './model';
import { checkedConnection, credentialLabel, parentPrefix, sourceKind } from './workspace';
import Icon from './Icon';
import StorageError from './StorageError';

export default function StorageWorkspace(props: {
  sources: StorageConfig[];
  onAdd: () => void;
  onEdit: (source: StorageConfig) => void;
  onUpdated: (source: StorageConfig) => void;
  onCreateLibrary: (source: StorageConfig, prefix: string) => void;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = createSignal<string>();
  const [prefix, setPrefix] = createSignal('');
  const [entries, setEntries] = createSignal<StorageEntry[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [errorSourceId, setErrorSourceId] = createSignal<string>();
  const [notice, setNotice] = createSignal('');
  const [checks, setChecks] = createSignal<Record<string, { ok: boolean; message: string }>>({});
  let request = 0;
  const source = () => props.sources.find((item) => item.id === selected());
  async function check(item: StorageConfig) {
    setErrorSourceId(item.id);
    setBusy(item.id);
    setError('');
    setNotice('');
    try {
      const result = await execute<StorageCheck>('storage.check', { id: item.id });
      const status = checkedConnection(result);
      setChecks((previous) => ({ ...previous, [item.id]: status }));
      props.onUpdated({
        ...item,
        connected: result.connected,
        credential_status: result.credential_status,
      });
      if (!status.ok) setError(status.message);
      else setNotice(`${item.name}：${status.message}`);
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      setChecks((previous) => ({ ...previous, [item.id]: { ok: false, message } }));
    } finally {
      setBusy('');
    }
  }
  async function browse(item: StorageConfig, nextPrefix = '', append = false) {
    setErrorSourceId(item.id);
    const token = ++request;
    setSelected(item.id);
    setBusy('browse');
    setError('');
    setNotice('');
    if (!append) {
      setEntries([]);
      setCursor(null);
      setPrefix(nextPrefix);
    }
    try {
      const result = await execute<{ entries: StorageEntry[]; next_cursor: string | null }>(
        'storage.browse',
        { id: item.id, prefix: nextPrefix, limit: 200, cursor: append ? cursor() : undefined },
      );
      if (token !== request) return;
      setEntries((previous) => (append ? [...previous, ...result.entries] : result.entries));
      setCursor(result.next_cursor);
      props.onUpdated({ ...item, connected: true });
    } catch (e) {
      if (token === request) setError(errorMessage(e));
    } finally {
      if (token === request) setBusy('');
    }
  }
  async function download(entry: StorageEntry) {
    if (!source()) return;
    setErrorSourceId(source()!.id);
    setError('');
    setNotice('');
    try {
      const destination = await chooseSave(entry.key.split('/').pop() || 'image');
      if (!destination) return;
      setBusy('download');
      const result = await execute<{ path: string }>('storage.fetch', {
        id: source()!.id,
        key: entry.key,
        destination,
      });
      setNotice(`已下载至 ${result.path}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <section class="workspace-page storage-workspace" aria-label="存储源工作区">
      <header class="workspace-heading">
        <div>
          <h1>存储源</h1>
          <p>管理连接、验证访问，并从目录建立图片库。</p>
        </div>
        <div class="workspace-heading-actions">
          <button class="button" onClick={props.onRefresh} disabled={!!busy()}>
            <Icon name="refresh" size={15} />
            刷新
          </button>
          <button class="button primary" onClick={props.onAdd}>
            <Icon name="plus" size={15} />
            添加存储源
          </button>
        </div>
      </header>
      <Show when={!desktop}>
        <div class="workspace-note">
          浏览器演示不访问本机目录或远程设备；请使用桌面版管理真实存储源。
        </div>
      </Show>
      <Show when={error()}>
        <div class="workspace-message error" role="alert">
          <StorageError
            error={error()}
            disabled={!!busy()}
            onSettings={
              props.sources.some((item) => item.id === errorSourceId())
                ? () => props.onEdit(props.sources.find((item) => item.id === errorSourceId())!)
                : undefined
            }
          />
        </div>
      </Show>
      <Show when={notice()}>
        <div class="workspace-message success" role="status">
          {notice()}
        </div>
      </Show>
      <div class="source-list">
        <div class="source-list-head">
          <span>存储位置</span>
          <span>连接状态</span>
          <span>凭据</span>
          <span>操作</span>
        </div>
        <For
          each={props.sources}
          fallback={
            <div class="workspace-empty">
              <Icon name="cloud" size={30} />
              <h2>还没有存储源</h2>
              <p>添加本地文件夹、WebDAV 或 S3，再选择需要管理的图片目录。</p>
              <button class="button" onClick={props.onAdd}>
                添加第一个存储源
              </button>
            </div>
          }
        >
          {(item) => (
            <article class={`source-row ${selected() === item.id ? 'selected' : ''}`}>
              <div class="source-description">
                <Icon name={item.kind === 'local' ? 'folder' : 'cloud'} size={22} />
                <div>
                  <strong>
                    {item.name}
                    <small>{sourceKind(item.kind)}</small>
                  </strong>
                  <p title={item.endpoint}>
                    {item.endpoint}
                    {item.root ? ` / ${item.root}` : ''}
                  </p>
                </div>
              </div>
              <span class={`source-status ${item.connected ? 'verified' : ''}`}>
                {busy() === item.id
                  ? '正在验证…'
                  : item.connected
                    ? '已验证'
                    : checks()[item.id]?.ok === false
                      ? '连接失败'
                      : '未验证'}
              </span>
              <span class="credential-status">{credentialLabel(item.credential_status)}</span>
              <div class="source-row-actions">
                <button class="button small" onClick={() => check(item)} disabled={!!busy()}>
                  测试连接
                </button>
                <button class="button small" onClick={() => browse(item)} disabled={!!busy()}>
                  浏览目录
                </button>
                <button
                  class="icon-button"
                  onClick={() => props.onEdit(item)}
                  disabled={!!busy()}
                  aria-label={`${item.name} 连接设置`}
                  title="连接设置 / 重连"
                >
                  <Icon name="settings" size={16} />
                </button>
              </div>
            </article>
          )}
        </For>
      </div>
      <Show when={source()}>
        {(current) => (
          <section class="source-directory">
            <div class="directory-heading">
              <div>
                <h2>{current().name}</h2>
                <span>
                  {current().kind === 'local'
                    ? '本地目录'
                    : current().endpoint.startsWith('http:')
                      ? 'HTTP · 未加密'
                      : current().tls_certificate_sha256
                        ? 'HTTPS · 已信任设备证书'
                        : 'HTTPS · 标准校验'}
                </span>
              </div>
              <div>
                <button
                  class="button small"
                  onClick={() => props.onEdit(current())}
                  disabled={!!busy()}
                >
                  连接设置 / 重连
                </button>
                <button
                  class="button primary small"
                  disabled={!!busy()}
                  onClick={() => props.onCreateLibrary(current(), prefix())}
                >
                  <Icon name="plus" size={14} />
                  从此目录建立图片库
                </button>
                <button
                  class="icon-button"
                  onClick={() => {
                    request++;
                    setSelected(undefined);
                    setBusy('');
                  }}
                  aria-label="关闭目录浏览"
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            </div>
            <div class="directory-path">
              <button
                class="button small"
                disabled={!prefix() || !!busy()}
                onClick={() => browse(current(), parentPrefix(prefix()))}
              >
                上一级
              </button>
              <button class="path-root" onClick={() => browse(current(), '')} disabled={!!busy()}>
                {current().name}
              </button>
              <span>/</span>
              <code>{prefix() || '根目录'}</code>
              <button
                class="icon-button"
                aria-label="刷新目录"
                disabled={!!busy()}
                onClick={() => browse(current(), prefix())}
              >
                <Icon name="refresh" size={16} />
              </button>
            </div>
            <div class="directory-table">
              <div class="directory-table-head">
                <span>名称</span>
                <span>大小</span>
                <span>操作</span>
              </div>
              <For
                each={entries()}
                fallback={
                  <div class="table-empty">
                    {busy() === 'browse'
                      ? '正在读取目录…'
                      : error()
                        ? '目录读取未完成，请重试或调整连接设置。'
                        : '此目录为空。'}
                  </div>
                }
              >
                {(entry) => (
                  <div class="directory-entry">
                    <button
                      class="directory-entry-name"
                      disabled={!entry.is_dir || !!busy()}
                      onClick={() => browse(current(), entry.key)}
                    >
                      <Icon name={entry.is_dir ? 'folder' : 'photo'} size={17} />
                      <span title={entry.key}>
                        {entry.key.replace(/\/$/, '').split('/').pop() || entry.key}
                      </span>
                    </button>
                    <span>
                      {entry.is_dir ? '文件夹' : entry.size ? bytes(entry.size) : '大小未知'}
                    </span>
                    <button
                      class="button small"
                      disabled={!!busy()}
                      onClick={() =>
                        entry.is_dir ? browse(current(), entry.key) : download(entry)
                      }
                    >
                      {entry.is_dir ? '打开' : '下载副本'}
                    </button>
                  </div>
                )}
              </For>
            </div>
            <Show when={cursor()}>
              <div class="load-more">
                <button
                  class="button"
                  disabled={!!busy()}
                  onClick={() => browse(current(), prefix(), true)}
                >
                  载入更多
                </button>
              </div>
            </Show>
          </section>
        )}
      </Show>
    </section>
  );
}
