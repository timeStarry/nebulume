import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { chooseDirectory, chooseSave, desktop, execute } from './api';
import {
  bytes,
  errorMessage,
  type ImportPlan,
  type ImportResult,
  type Library,
  type StorageConfig,
  type StorageEntry,
} from './model';
import Icon from './Icon';

export function Modal(props: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: JSX.Element;
  wide?: boolean;
  busy?: boolean;
}) {
  let dialog!: HTMLDivElement;
  let previous: HTMLElement | null;
  onMount(() => {
    previous = document.activeElement as HTMLElement;
    dialog.querySelector<HTMLElement>('input, select, button')?.focus();
  });
  onCleanup(() => previous?.focus());
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!props.busy) props.onClose();
    }
    if (event.key === 'Tab') {
      const nodes = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ].filter((el) => el.offsetParent !== null);
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
  return (
    <div
      class="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onClose();
      }}
    >
      <div
        class={`modal ${props.wide ? 'wide' : ''}`}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onKeyDown={keydown}
      >
        <header class="modal-header">
          <div>
            <h2>{props.title}</h2>
            <Show when={props.subtitle}>
              <p>{props.subtitle}</p>
            </Show>
          </div>
          <button
            class="icon-button"
            onClick={props.onClose}
            disabled={props.busy}
            aria-label="关闭对话框"
          >
            <Icon name="close" />
          </button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

export function LibraryDialog(props: { onClose: () => void; onAdded: (library: Library) => void }) {
  const [name, setName] = createSignal('');
  const [root, setRoot] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  async function browse() {
    try {
      const directory = await chooseDirectory('选择图片库文件夹');
      if (directory) {
        setRoot(directory);
        if (!name()) setName(directory.split(/[\\/]/).filter(Boolean).pop() || '图片库');
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const library = await execute<Library>('library.add', {
        name: name().trim(),
        root: root().trim(),
      });
      props.onAdded(library);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="添加本地图片库"
      subtitle="建立索引，保留文件原有位置与目录结构。"
      onClose={props.onClose}
      busy={busy()}
    >
      <form onSubmit={submit} class="dialog-form">
        <label>
          图片库名称
          <input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="例如：我的摄影作品"
            required
            maxLength={100}
          />
        </label>
        <label>
          所在文件夹
          <div class="path-field">
            <input
              value={root()}
              onInput={(e) => setRoot(e.currentTarget.value)}
              placeholder="选择包含照片的文件夹"
              required
            />
            <button type="button" class="button" onClick={browse}>
              浏览…
            </button>
          </div>
        </label>
        <div class="note">
          <Icon name="info" />
          <p>
            添加后将递归扫描支持的影像。原始文件不会移动、改名或修改；评级与裁剪保存在独立索引中。
          </p>
        </div>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <footer class="modal-footer">
          <button type="button" class="button" onClick={props.onClose} disabled={busy()}>
            取消
          </button>
          <button class="button primary" disabled={busy() || !desktop}>
            {busy() ? '正在建立图片库…' : '添加并扫描'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function StorageDialog(props: {
  onClose: () => void;
  onAdded: (storage: StorageConfig) => void;
}) {
  const [kind, setKind] = createSignal<'webdav' | 's3'>('webdav');
  const [name, setName] = createSignal('');
  const [endpoint, setEndpoint] = createSignal('');
  const [root, setRoot] = createSignal('');
  const [bucket, setBucket] = createSignal('');
  const [region, setRegion] = createSignal('us-east-1');
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [accessKey, setAccessKey] = createSignal('');
  const [secretKey, setSecretKey] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const storage = await execute<StorageConfig>('storage.add', {
        name: name().trim(),
        kind: kind(),
        endpoint: endpoint().trim(),
        root: root().trim(),
        bucket: bucket().trim(),
        region: region().trim(),
        username: username(),
        password: password(),
        access_key: accessKey(),
        secret_key: secretKey(),
      });
      setPassword('');
      setSecretKey('');
      props.onAdded(storage);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="连接远程存储"
      subtitle="按需浏览和下载，在本地图库中管理影像。"
      onClose={props.onClose}
      busy={busy()}
    >
      <form class="dialog-form" onSubmit={submit} autocomplete="off">
        <div class="segmented storage-type">
          <button
            classList={{ active: kind() === 'webdav' }}
            onClick={() => setKind('webdav')}
            type="button"
          >
            WebDAV
          </button>
          <button
            classList={{ active: kind() === 's3' }}
            onClick={() => setKind('s3')}
            type="button"
          >
            S3 兼容存储
          </button>
        </div>
        <label>
          显示名称
          <input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="例如：家庭 NAS"
            required
          />
        </label>
        <label>
          服务端地址
          <input
            type="url"
            value={endpoint()}
            onInput={(e) => setEndpoint(e.currentTarget.value)}
            placeholder={
              kind() === 'webdav' ? 'https://nas.example.com/dav/' : 'https://s3.example.com'
            }
            required
          />
        </label>
        <Show
          when={kind() === 'webdav'}
          fallback={
            <>
              <div class="form-row">
                <label>
                  存储桶
                  <input
                    value={bucket()}
                    onInput={(e) => setBucket(e.currentTarget.value)}
                    required
                  />
                </label>
                <label>
                  区域
                  <input
                    value={region()}
                    onInput={(e) => setRegion(e.currentTarget.value)}
                    required
                  />
                </label>
              </div>
              <label>
                Access key
                <input value={accessKey()} onInput={(e) => setAccessKey(e.currentTarget.value)} />
              </label>
              <label>
                Secret key
                <input
                  type="password"
                  value={secretKey()}
                  onInput={(e) => setSecretKey(e.currentTarget.value)}
                  autocomplete="new-password"
                />
              </label>
            </>
          }
        >
          <div class="form-row">
            <label>
              用户名
              <input
                value={username()}
                onInput={(e) => setUsername(e.currentTarget.value)}
                autocomplete="off"
              />
            </label>
            <label>
              密码
              <input
                type="password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                autocomplete="new-password"
              />
            </label>
          </div>
        </Show>
        <label>
          {kind() === 'webdav' ? '根目录' : '对象前缀'}（可选）
          <input
            value={root()}
            onInput={(e) => setRoot(e.currentTarget.value)}
            placeholder="photos/"
          />
        </label>
        <div class="note">
          <Icon name="info" />
          <p>
            Alpha 版凭据仅在当前应用会话内保留。重启后需重新连接；浏览或下载失败会显示实际错误。
          </p>
        </div>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <footer class="modal-footer">
          <button class="button" type="button" onClick={props.onClose} disabled={busy()}>
            取消
          </button>
          <button class="button primary" disabled={busy() || !desktop}>
            {busy() ? '正在添加…' : '添加连接'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function StorageBrowser(props: { storage: StorageConfig; onClose: () => void }) {
  const [prefix, setPrefix] = createSignal('');
  const [entries, setEntries] = createSignal<StorageEntry[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [message, setMessage] = createSignal('');
  async function browse(next: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await execute<{ entries: StorageEntry[] }>('storage.browse', {
        id: props.storage.id,
        prefix: next,
      });
      setEntries(response.entries);
      setPrefix(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  onMount(() => void browse(''));
  async function download(entry: StorageEntry) {
    setError('');
    setMessage('');
    try {
      const destination = await chooseSave(entry.key.split('/').pop() || 'image');
      if (!destination) return;
      setBusy(true);
      const result = await execute<{ path: string }>('storage.fetch', {
        id: props.storage.id,
        key: entry.key,
        destination,
      });
      setMessage(`已下载至 ${result.path}。将该目录添加为图库或重新扫描，即可建立索引。`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={props.storage.name}
      subtitle={`${props.storage.kind.toUpperCase()} · ${props.storage.endpoint}`}
      wide
      onClose={props.onClose}
      busy={busy()}
    >
      <div class="remote-toolbar">
        <button
          class="button small"
          disabled={busy() || !prefix()}
          onClick={() => {
            const parts = prefix().replace(/\/$/, '').split('/');
            parts.pop();
            void browse(parts.length ? `${parts.join('/')}/` : '');
          }}
        >
          上一级
        </button>
        <code>/{prefix()}</code>
        <button
          class="icon-button"
          onClick={() => browse(prefix())}
          disabled={busy()}
          aria-label="刷新远程目录"
        >
          <Icon name="refresh" />
        </button>
      </div>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={message()}>
        <p class="success-message" role="status">
          {message()}
        </p>
      </Show>
      <div class="file-table">
        <div class="file-table-header">
          <span>名称</span>
          <span>大小</span>
          <span>操作</span>
        </div>
        <Show
          when={!busy()}
          fallback={
            <div class="table-empty">
              <span class="spinner" /> 正在访问远程存储…
            </div>
          }
        >
          <For each={entries()} fallback={<div class="table-empty">此目录没有可显示的对象。</div>}>
            {(entry) => (
              <div class="file-row">
                <span>
                  <Icon name={entry.is_dir ? 'folder' : 'photo'} />
                  <span title={entry.key}>{entry.key.replace(prefix(), '') || entry.key}</span>
                </span>
                <small>{entry.is_dir ? '文件夹' : bytes(entry.size)}</small>
                <button
                  class="button small"
                  onClick={() => (entry.is_dir ? browse(entry.key) : download(entry))}
                >
                  {entry.is_dir ? '打开' : '下载'}
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
      <footer class="modal-footer">
        <small>下载为新文件，不覆盖已有文件。</small>
        <button class="button" onClick={props.onClose} disabled={busy()}>
          完成
        </button>
      </footer>
    </Modal>
  );
}

export function ImportDialog(props: { onClose: () => void; onImported: () => void }) {
  const [source, setSource] = createSignal('');
  const [destination, setDestination] = createSignal('');
  const [layout, setLayout] = createSignal('date');
  const [deduplicate, setDeduplicate] = createSignal(true);
  const [plan, setPlan] = createSignal<ImportPlan>();
  const [reviewed, setReviewed] = createSignal(false);
  const [result, setResult] = createSignal<ImportResult>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  async function browse(which: 'source' | 'destination') {
    try {
      const directory = await chooseDirectory(
        which === 'source' ? '选择 SD 卡、DCIM 或任意来源文件夹' : '选择照片导入目标文件夹',
      );
      if (directory) (which === 'source' ? setSource : setDestination)(directory);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function makePlan(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setReviewed(false);
    try {
      setPlan(
        await execute<ImportPlan>('import.plan', {
          source: source(),
          destination: destination(),
          layout: layout(),
          deduplicate: deduplicate(),
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    if (!plan() || !reviewed()) return;
    setBusy(true);
    setError('');
    try {
      setResult(await execute<ImportResult>('import.execute', { plan_id: plan()!.id }));
      props.onImported();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const statusName = (status: string) =>
    ({
      pending: '待复制',
      copy: '待复制',
      ready: '待复制',
      duplicate: '重复跳过',
      skip: '跳过',
      skipped: '跳过',
      conflict: '文件冲突',
      error: '异常',
    })[status] || status;
  return (
    <Modal
      title="从 SD 卡或文件夹导入"
      subtitle="先核对计划，再安全复制。源文件始终保留。"
      onClose={props.onClose}
      wide
      busy={busy()}
    >
      <div class="import-steps">
        <span classList={{ current: !plan() }}>
          1 <b>选择位置</b>
        </span>
        <i />
        <span classList={{ current: !!plan() && !result() }}>
          2 <b>审核计划</b>
        </span>
        <i />
        <span classList={{ current: !!result() }}>
          3 <b>导入结果</b>
        </span>
      </div>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={!plan()}>
        <form class="dialog-form" onSubmit={makePlan}>
          <label>
            来源
            <div class="path-field">
              <input
                value={source()}
                onInput={(e) => setSource(e.currentTarget.value)}
                placeholder="SD 卡 / DCIM / 文件夹"
                required
              />
              <button type="button" class="button" onClick={() => browse('source')}>
                浏览…
              </button>
            </div>
          </label>
          <label>
            目标文件夹
            <div class="path-field">
              <input
                value={destination()}
                onInput={(e) => setDestination(e.currentTarget.value)}
                placeholder="选择保存照片的位置"
                required
              />
              <button type="button" class="button" onClick={() => browse('destination')}>
                浏览…
              </button>
            </div>
          </label>
          <label>
            文件组织
            <select value={layout()} onChange={(e) => setLayout(e.currentTarget.value)}>
              <option value="date">按日期归档</option>
              <option value="preserve">保留来源目录结构</option>
            </select>
          </label>
          <label class="checkbox-label">
            <input
              type="checkbox"
              checked={deduplicate()}
              onChange={(e) => setDeduplicate(e.currentTarget.checked)}
            />
            根据文件内容检测重复
          </label>
          <div class="note">
            <Icon name="card" />
            <p>
              任何已挂载的存储卡或文件夹均可作为来源。日期归档采用 EXIF
              拍摄日期；无可用日期的文件进入 unknown-date。重名处理以逐文件计划为准。
            </p>
          </div>
          <footer class="modal-footer">
            <button class="button" type="button" onClick={props.onClose} disabled={busy()}>
              取消
            </button>
            <button class="button primary" disabled={busy() || !desktop}>
              {busy() ? '正在扫描并核对内容…' : '生成导入计划'}
            </button>
          </footer>
        </form>
      </Show>
      <Show when={plan() && !result()}>
        <For each={plan()!.warnings || []}>
          {(warning) => <p class="form-error plan-warning">{warning}</p>}
        </For>
        <div class="plan-summary">
          <div>
            <strong>{plan()!.items.length}</strong>
            <span>个文件</span>
          </div>
          <div>
            <strong>{bytes(plan()!.total_bytes)}</strong>
            <span>计划总大小</span>
          </div>
          <div class="plan-destination">
            <small>导入至</small>
            <span>{plan()!.destination}</span>
          </div>
        </div>
        <div class="file-table import-table">
          <div class="file-table-header">
            <span>目标相对路径</span>
            <span>大小</span>
            <span>状态</span>
          </div>
          <For
            each={plan()!.items.slice(0, 200)}
            fallback={<div class="table-empty">未找到可导入的影像文件。</div>}
          >
            {(item) => (
              <div class="file-row">
                <span title={item.source}>{item.relative_path}</span>
                <small>{bytes(item.size)}</small>
                <small
                  classList={{
                    'warning-text':
                      item.status !== 'copy' &&
                      item.status !== 'ready' &&
                      item.status !== 'pending',
                  }}
                >
                  {statusName(item.status)}
                </small>
              </div>
            )}
          </For>
        </div>
        <Show when={plan()!.items.length > 200}>
          <p class="muted">显示前 200 项，共 {plan()!.items.length} 项。</p>
        </Show>
        <label class="checkbox-label review-checkbox">
          <input
            type="checkbox"
            checked={reviewed()}
            onChange={(e) => setReviewed(e.currentTarget.checked)}
            disabled={busy()}
          />
          我已核对来源、目标和导入计划
        </label>
        <footer class="modal-footer">
          <button
            class="button"
            onClick={() => {
              setPlan(undefined);
              setReviewed(false);
            }}
            disabled={busy()}
          >
            返回修改
          </button>
          <button
            class="button primary"
            disabled={busy() || !reviewed() || !plan()!.items.length}
            onClick={run}
          >
            {busy() ? '正在复制并验证…' : '开始安全导入'}
          </button>
        </footer>
      </Show>
      <Show when={result()}>
        <div class="import-result">
          <span class="result-icon">
            <Icon name={result()!.failed ? 'info' : 'check'} size={26} />
          </span>
          <h3>
            {
              {
                completed: '导入完成',
                partial: '导入部分完成',
                failed: '导入失败',
                interrupted: '导入已中断',
              }[result()!.status]
            }
          </h3>
          <p>请核对下列结果。可重新扫描目标图片库查看导入影像。</p>
          <dl>
            <For
              each={Object.entries(result()!).filter(
                ([key, value]) =>
                  !['items', 'errors', 'plan_id', 'id'].includes(key) &&
                  (typeof value === 'string' || typeof value === 'number'),
              )}
            >
              {([key, value]) => (
                <>
                  <dt>
                    {{
                      copied: '已复制',
                      imported: '已导入',
                      skipped: '已跳过',
                      duplicates: '重复跳过',
                      total: '文件总数',
                      source: '来源',
                      failed: '失败',
                      verified: '已验证',
                      id: '任务 ID',
                      destination: '目标位置',
                      status: '任务状态',
                      total_bytes: '字节数',
                      started_at: '开始时间',
                      finished_at: '完成时间',
                    }[key] || key}
                  </dt>
                  <dd>{String(value)}</dd>
                </>
              )}
            </For>
          </dl>
          <div class="file-table import-table result-table">
            <div class="file-table-header">
              <span>目标路径 / 失败原因</span>
              <span>大小</span>
              <span>结果</span>
            </div>
            <For each={result()!.items}>
              {(item) => (
                <div class="file-row">
                  <span title={item.source}>
                    <span>
                      {item.destination}
                      <Show when={item.error}>
                        <small class="result-file-error">{item.error}</small>
                      </Show>
                    </span>
                  </span>
                  <small>{bytes(item.size)}</small>
                  <small classList={{ 'warning-text': item.status === 'failed' }}>
                    {{ copied: '已复制', duplicate: '重复跳过', failed: '失败' }[item.status]}
                  </small>
                </div>
              )}
            </For>
          </div>
          <Show when={result()!.items?.some((item) => item.status === 'failed')}>
            <div class="form-error">
              <For each={result()!.items.filter((item) => item.status === 'failed')}>
                {(item) => (
                  <p>
                    {item.source}：{item.error || '复制失败'}
                  </p>
                )}
              </For>
            </div>
          </Show>
        </div>
        <footer class="modal-footer">
          <button class="button primary" onClick={props.onClose}>
            完成
          </button>
        </footer>
      </Show>
    </Modal>
  );
}
