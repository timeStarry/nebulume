import { For, Show, createSignal } from 'solid-js';
import { chooseSave, desktop, execute } from './api';
import {
  bytes,
  errorMessage,
  type Library,
  type StorageCheck,
  type StorageConfig,
  type StorageEntry,
  type WriteCheck,
} from './model';
import { checkedConnection, credentialLabel, parentPrefix, sourceKind } from './workspace';
import Icon from './Icon';
import { Banner, Button, EmptyState, Group, IconButton, ListRow, PageHeader, StatusDot } from './ui';
import StorageError from './StorageError';

export default function StorageWorkspace(props: {
  sources: StorageConfig[];
  removableLibraries?: Library[];
  onRelocateLibrary?: (library: Library) => void;
  onAdd: () => void;
  onEdit: (source: StorageConfig) => void;
  onUpdated: (source: StorageConfig) => void;
  onCreateLibrary: (source: StorageConfig, prefix: string) => void;
  onRefresh: () => void;
  onRemove: (source: StorageConfig) => void;
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
  const remoteSources = () => props.sources.filter((item) => item.kind !== 'local');
  const source = () => remoteSources().find((item) => item.id === selected());
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
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      setChecks((previous) => ({ ...previous, [item.id]: { ok: false, message } }));
    } finally {
      setBusy('');
    }
  }
  /** Explicit: writes and removes one small test object on the server. */
  async function writeCheck(item: StorageConfig) {
    setErrorSourceId(item.id);
    setBusy(item.id);
    setError('');
    setNotice('');
    try {
      const result = await execute<WriteCheck>('storage.write_check', { id: item.id });
      props.onUpdated({ ...item, write_capability: result.write_capability });
      if (result.write_capability === 'verified')
        setNotice(
          `${item.name} 可以安全导入：新建文件经读回校验，已有文件不会被覆盖。${result.leftover ? `测试文件 ${result.leftover} 未能删除，可手动清理。` : ''}`,
        );
      else if (result.write_capability === 'unsupported')
        setError(`${item.name} 无法保证不覆盖已有文件，不能作为导入目标。${result.error || ''}`);
      else setError(result.error || '写入测试未完成。');
    } catch (e) {
      setError(errorMessage(e));
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
      if (token !== request || selected() !== item.id) return;
      const message = errorMessage(e);
      setError(message);
      setChecks((previous) => ({ ...previous, [item.id]: { ok: false, message } }));
      // Revoke the previous success immediately, then retrieve credential state resolved by
      // this attempt (for example a missing or locked system credential record).
      props.onUpdated({ ...item, connected: false });
      try {
        const latest = await execute<StorageConfig[]>('storage.list');
        if (token !== request || selected() !== item.id) return;
        const current = latest.find((candidate) => candidate.id === item.id);
        if (current) props.onUpdated(current);
      } catch {
        // Keep the original browse error and unverified state if status refresh also fails.
      }
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
    <section class="storage-workspace" aria-label="位置工作区">
      <PageHeader
        title="位置"
        subtitle="网络存储的连接、凭据与证书"
        actions={
          <>
            <IconButton icon="refresh" label="刷新" onClick={props.onRefresh} disabled={!!busy()} />
            <Button icon="plus" onClick={props.onAdd}>
              添加网络位置
            </Button>
          </>
        }
      />
      <div class="storage-page">
        <Show when={!desktop}>
          <Banner
            tone="info"
            role="note"
            message="浏览器演示不访问本机目录或远程设备。"
            detail="请使用桌面版管理真实位置。"
          />
        </Show>
        <Show when={error()}>
          <StorageError
            error={error()}
            disabled={!!busy()}
            onSettings={
              props.sources.some((item) => item.id === errorSourceId())
                ? () => props.onEdit(props.sources.find((item) => item.id === errorSourceId())!)
                : undefined
            }
          />
        </Show>
        <Show when={notice()}>
          <Banner tone="info" role="status" message={notice()} onClose={() => setNotice('')} />
        </Show>
        <Show when={props.removableLibraries?.length}>
          <Group title="外接移动硬盘与离线图库">
            <For each={props.removableLibraries}>
              {(lib) => {
                const offline = () => lib.availability === 'offline' || lib.connected === false;
                return (
                  <ListRow
                    leading="usb"
                    title={lib.name}
                    description={
                      lib.volume_label ? `${lib.volume_label} · ${lib.root}` : lib.root
                    }
                    control={
                      <>
                        <StatusDot
                          state={offline() ? 'off' : 'ok'}
                          label={offline() ? '未挂载' : '在线'}
                          showLabel
                        />
                        <Show when={offline() && props.onRelocateLibrary}>
                          <Button size="sm" onClick={() => props.onRelocateLibrary?.(lib)}>
                            重新定位…
                          </Button>
                        </Show>
                      </>
                    }
                  />
                );
              }}
            </For>
          </Group>
        </Show>
        <div class="source-list">
          <div class="source-list-head">
            <span>存储位置</span>
            <span>连接状态</span>
            <span>凭据</span>
            <span>操作</span>
          </div>
          <For
            each={remoteSources()}
            fallback={
              <EmptyState
                icon="server"
                title="还没有远端连接"
                description="连接 WebDAV 或 S3 后浏览远端图片。本地目录可直接建立图片库。"
                actions={
                  <Button variant="primary" onClick={props.onAdd}>
                    添加第一个网络位置
                  </Button>
                }
              />
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
                <span class={`source-status ${item.connected ? 'verified' : ''}`} role="status">
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
                  <Button size="sm" onClick={() => check(item)} disabled={!!busy()}>
                    测试连接
                  </Button>
                  <Button size="sm" onClick={() => browse(item)} disabled={!!busy()}>
                    浏览目录
                  </Button>
                  <Show when={item.kind !== 'local'}>
                    <Button
                      size="sm"
                      onClick={() => writeCheck(item)}
                      disabled={!!busy()}
                      title="写入并删除一个测试文件，确认可以安全导入到这里"
                    >
                      {item.write_capability === 'verified'
                        ? '可导入'
                        : item.write_capability === 'unsupported'
                          ? '不可导入'
                          : '测试写入'}
                    </Button>
                  </Show>
                  <IconButton
                    icon="settings"
                    size="sm"
                    label={`${item.name} 连接设置`}
                    title="连接设置 / 重连"
                    onClick={() => props.onEdit(item)}
                    disabled={!!busy()}
                  />
                  <Button
                    size="sm"
                    onClick={() => props.onRemove(item)}
                    disabled={!!busy()}
                    aria-label={`移除位置 ${item.name}`}
                  >
                    移除
                  </Button>
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
                  <Button
                    variant="primary"
                    size="sm"
                    icon="plus"
                    disabled={!!busy()}
                    onClick={() => props.onCreateLibrary(current(), prefix())}
                  >
                    从此目录建立图片库
                  </Button>
                  <IconButton
                    icon="close"
                    size="sm"
                    label="关闭目录浏览"
                    onClick={() => {
                      request++;
                      setSelected(undefined);
                      setBusy('');
                    }}
                  />
                </div>
              </div>
              <div class="directory-path">
                <Button
                  size="sm"
                  disabled={!prefix() || !!busy()}
                  onClick={() => browse(current(), parentPrefix(prefix()))}
                >
                  上一级
                </Button>
                <button
                  type="button"
                  class="path-root"
                  onClick={() => browse(current(), '')}
                  disabled={!!busy()}
                >
                  根目录
                </button>
                <Show when={prefix()}>
                  <span>/</span>
                  <code>{prefix()}</code>
                </Show>
                <IconButton
                  icon="refresh"
                  size="sm"
                  label="刷新目录"
                  disabled={!!busy()}
                  onClick={() => browse(current(), prefix())}
                />
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
                        type="button"
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
                      <Button
                        size="sm"
                        disabled={!!busy()}
                        onClick={() =>
                          entry.is_dir ? browse(current(), entry.key) : download(entry)
                        }
                      >
                        {entry.is_dir ? '打开' : '下载副本'}
                      </Button>
                    </div>
                  )}
                </For>
              </div>
              <Show when={cursor()}>
                <div class="load-more">
                  <Button
                    size="sm"
                    disabled={!!busy()}
                    onClick={() => browse(current(), prefix(), true)}
                  >
                    载入更多
                  </Button>
                </div>
              </Show>
            </section>
          )}
        </Show>
      </div>
    </section>
  );
}
