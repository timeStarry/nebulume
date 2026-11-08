import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { chooseDirectory, desktop, execute } from './api';
import { errorMessage, type Library, type StorageConfig } from './model';
import Icon from './Icon';
import TlsCertificatePanel from './TlsCertificatePanel';
import StorageError from './StorageError';
import FingerprintControl from './FingerprintControl';

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
    dialog
      .querySelector<HTMLElement>(
        'input:not(:disabled), select:not(:disabled), button:not(:disabled)',
      )
      ?.focus();
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
        aria-busy={props.busy || undefined}
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

export function LibraryDialog(props: {
  sources: StorageConfig[];
  initialSource?: StorageConfig;
  initialPrefix?: string;
  existing?: Library;
  onClose: () => void;
  onAdded: (library: Library, bindingChanged?: boolean) => void;
}) {
  const [name, setName] = createSignal(
    props.existing?.name ||
      props.initialPrefix?.replace(/\/$/, '').split('/').pop() ||
      props.initialSource?.name ||
      '',
  );
  const remoteSources = () => props.sources.filter((source) => source.kind !== 'local');
  const existingSource = props.sources.find((source) => source.id === props.existing?.storage_id);
  const existingIsLocal = props.existing?.source_kind
    ? props.existing.source_kind === 'local'
    : !existingSource || existingSource.kind === 'local';
  const initialIsRemote = props.existing
    ? !existingIsLocal
    : !!props.initialSource && props.initialSource.kind !== 'local';
  const [sourceType, setSourceType] = createSignal<'local' | 'remote'>(
    initialIsRemote ? 'remote' : 'local',
  );
  const [localRoot, setLocalRoot] = createSignal(
    props.existing && existingIsLocal
      ? props.existing.root
      : props.initialSource?.kind === 'local'
        ? props.initialSource.endpoint
        : '',
  );
  const [sourceId, setSourceId] = createSignal(
    initialIsRemote
      ? props.existing?.storage_id || props.initialSource?.id || ''
      : remoteSources()[0]?.id || '',
  );
  const [prefix, setPrefix] = createSignal(
    initialIsRemote ? props.existing?.source_prefix || props.initialPrefix || '' : '',
  );
  const [pair, setPair] = createSignal(props.existing?.pair_raw_jpeg || false);
  const [confirmBinding, setConfirmBinding] = createSignal(false);
  const bindingChanged = () =>
    !!props.existing &&
    desktop &&
    (sourceType() === 'local'
      ? !existingIsLocal ||
        localRoot()
          .trim()
          .replace(/[\\/]+$/, '') !== props.existing.root.replace(/[\\/]+$/, '')
      : existingIsLocal ||
        sourceId() !== (props.existing.storage_id || '') ||
        prefix().trim() !== (props.existing.source_prefix || ''));
  const locationMissing = () => (sourceType() === 'local' ? !localRoot().trim() : !sourceId());
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  async function browseLocal() {
    try {
      const path = await chooseDirectory('选择图片库文件夹');
      if (!path) return;
      setLocalRoot(path);
      setConfirmBinding(false);
      if (!name()) setName(path.split(/[\\/]/).filter(Boolean).pop() || '本地图片库');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if ((locationMissing() && desktop) || (!desktop && !props.existing)) return;
    if (bindingChanged() && !confirmBinding()) {
      setConfirmBinding(true);
      return;
    }
    const changed = bindingChanged();
    setBusy(true);
    setError('');
    try {
      props.onAdded(
        await execute<Library>(props.existing ? 'library.update' : 'library.add', {
          ...(props.existing ? { id: props.existing.id } : {}),
          name: name().trim(),
          pair_raw_jpeg: pair(),
          ...(desktop
            ? props.existing
              ? bindingChanged()
                ? sourceType() === 'local'
                  ? { root: localRoot().trim() }
                  : { storage_id: sourceId(), source_prefix: prefix().trim() }
                : {}
              : sourceType() === 'local'
                ? { root: localRoot().trim() }
                : { storage_id: sourceId(), prefix: prefix().trim() }
            : {}),
        }),
        changed,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={props.existing ? '图片库设置' : '建立图片库'}
      onClose={props.onClose}
      busy={busy()}
    >
      <form class="dialog-form" onSubmit={submit}>
        <label>
          图片库名称
          <input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="例如：旅行摄影"
            required
            maxLength={100}
            disabled={busy()}
          />
        </label>
        <Show when={desktop}>
          <label>
            来源类型
            <select
              value={sourceType()}
              disabled={busy()}
              onChange={(event) => {
                setSourceType(event.currentTarget.value as 'local' | 'remote');
                setConfirmBinding(false);
              }}
            >
              <option value="local">本地目录</option>
              <option value="remote">远端存储源</option>
            </select>
          </label>
          <Show
            when={sourceType() === 'local'}
            fallback={
              <>
                <label>
                  存储源
                  <select
                    value={sourceId()}
                    aria-label="存储源"
                    onChange={(e) => {
                      setSourceId(e.currentTarget.value);
                      setPrefix('');
                      setConfirmBinding(false);
                    }}
                    required
                    disabled={busy()}
                  >
                    <option value="" disabled>
                      选择已连接的存储位置
                    </option>
                    <Show
                      when={
                        sourceId() && !remoteSources().some((source) => source.id === sourceId())
                      }
                    >
                      <option value={sourceId()}>
                        {props.existing?.source_name || existingSource?.name || '当前远端存储源'}
                      </option>
                    </Show>
                    <For each={remoteSources()}>
                      {(source) => <option value={source.id}>{source.name}</option>}
                    </For>
                  </select>
                </label>
                <Show when={!remoteSources().length && !sourceId()}>
                  <p class="field-help">请先在存储源中添加 WebDAV 或 S3 连接。</p>
                </Show>
                <label class="library-prefix-field">
                  源内目录（可选）
                  <input
                    value={prefix()}
                    onInput={(e) => {
                      setPrefix(e.currentTarget.value);
                      setConfirmBinding(false);
                    }}
                    placeholder="留空使用此存储源的根目录"
                    disabled={busy()}
                  />
                </label>
              </>
            }
          >
            <label>
              本地目录
              <div class="path-field">
                <input
                  aria-label="本地目录"
                  value={localRoot()}
                  readonly
                  placeholder="选择图片所在的文件夹"
                  disabled={busy()}
                />
                <button class="button" type="button" onClick={browseLocal} disabled={busy()}>
                  <Icon name="folder" size={16} />
                  选择本地文件夹…
                </button>
              </div>
            </label>
          </Show>
        </Show>
        <Show when={!desktop && !props.existing}>
          <p class="field-help">建立本地或远端图片库需要桌面应用。</p>
        </Show>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={pair()}
            disabled={busy()}
            onChange={(e) => setPair(e.currentTarget.checked)}
          />
          合并显示 RAW + JPEG
        </label>
        <p class="field-help">
          同目录内各有一份的同名 RAW 与 JPEG 合并为一项，评级与裁剪分别保存。
        </p>
        <Show when={desktop && props.existing && !bindingChanged()}>
          <FingerprintControl libraryId={props.existing!.id} />
        </Show>
        <Show when={bindingChanged()}>
          <div class="workspace-message error" role="alert">
            <span>
              更改存储位置将清空此库的旧索引、评级和裁剪配方，再扫描新目录。原始文件不会移动或删除。
            </span>
          </div>
        </Show>
        <Show when={confirmBinding() && bindingChanged()}>
          <div class="note binding-confirmation">
            <p>
              请确认将“{props.existing?.name}”改为{' '}
              {sourceType() === 'local'
                ? localRoot()
                : `${remoteSources().find((source) => source.id === sourceId())?.name || props.existing?.source_name || '远端存储源'} / ${prefix() || '根目录'}`}
              。
            </p>
          </div>
        </Show>
        <Show when={error()}>
          <div class="form-error" role="alert">
            <StorageError error={error()} />
          </div>
        </Show>
        <footer class="modal-footer">
          <button class="button" type="button" onClick={props.onClose} disabled={busy()}>
            取消
          </button>
          <button
            class={`button ${bindingChanged() && confirmBinding() ? 'danger' : 'primary'}`}
            disabled={busy() || (desktop ? locationMissing() : !props.existing)}
          >
            {busy()
              ? '正在保存…'
              : bindingChanged()
                ? confirmBinding()
                  ? '确认更改位置并清空索引'
                  : '检查位置更改'
                : props.existing
                  ? '保存设置'
                  : '建立并扫描'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ConfirmDialog(props: {
  title: string;
  children: JSX.Element;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  blocked?: boolean;
  confirmLabel?: string;
  busyLabel?: string;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await props.onConfirm();
      props.onClose();
    } catch (e) {
      const message = errorMessage(e);
      setError(
        message.includes('E_IN_USE')
          ? `存储源仍有关联图片库，请先更改这些库的存储位置或移除这些库。关联图片库：${message.replace(/^.*?E_IN_USE:\s*(?:Storage (?:source is referenced|is used) by libraries:\s*)?/i, '')}`
          : message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={props.title} onClose={props.onClose} busy={busy()}>
      <div class="dialog-form">
        <div class="confirmation-copy">{props.children}</div>
        <Show when={error()}>
          <div class="form-error" role="alert">
            {error()}
          </div>
        </Show>
        <footer class="modal-footer">
          <button class="button" disabled={busy()} onClick={props.onClose}>
            取消
          </button>
          <button class="button danger" disabled={busy() || props.blocked} onClick={confirm}>
            {busy() ? props.busyLabel || '正在移除…' : props.confirmLabel || '确认移除'}
          </button>
        </footer>
      </div>
    </Modal>
  );
}

export function StorageDialog(props: {
  onClose: () => void;
  onAdded: (storage: StorageConfig) => void;
  existing?: StorageConfig;
}) {
  const [kind, setKind] = createSignal<'local' | 'webdav' | 's3'>(props.existing?.kind || 'webdav');
  const [name, setName] = createSignal(props.existing?.name || '');
  const [endpoint, setEndpoint] = createSignal(props.existing?.endpoint || '');
  const [root, setRoot] = createSignal(props.existing?.root || '');
  const [bucket, setBucket] = createSignal(props.existing?.bucket || '');
  const [region, setRegion] = createSignal(props.existing?.region || 'us-east-1');
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [accessKey, setAccessKey] = createSignal('');
  const [secretKey, setSecretKey] = createSignal('');
  const [remember, setRemember] = createSignal(props.existing?.remember_credentials ?? true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [trustPin, setTrustPin] = createSignal<string | null | undefined>(
    props.existing?.tls_certificate_sha256 ? undefined : null,
  );
  const locationChanged = () =>
    !!props.existing &&
    (kind() !== props.existing.kind ||
      endpoint().trim() !== props.existing.endpoint ||
      root().trim() !== (props.existing.root || '') ||
      bucket().trim() !== (props.existing.bucket || ''));
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!desktop) {
      setError('连接远程存储与读取设备证书需要 Nebulume 桌面版。');
      return;
    }
    if (kind() !== 'local' && trustPin() === undefined) {
      setError('请先读取当前地址的设备证书，核对指纹并确认信任。');
      return;
    }
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
        username: username() || undefined,
        password: password() || undefined,
        access_key: accessKey() || undefined,
        secret_key: secretKey() || undefined,
        remember_credentials: remember(),
        tls_certificate_sha256: kind() === 'local' ? null : trustPin(),
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
      title={props.existing ? '连接设置 / 重连' : '添加网络位置'}
      onClose={props.onClose}
      busy={busy()}
    >
      <form class="dialog-form storage-connection-form" onSubmit={submit} autocomplete="off">
        <Show when={!desktop}>
          <p class="native-required" role="status">
            连接远程存储与读取设备证书需要 Nebulume 桌面版。浏览器演示不访问局域网设备。
          </p>
        </Show>
        <div class="segmented storage-type">
          <button
            classList={{ active: kind() === 'webdav' }}
            aria-pressed={kind() === 'webdav'}
            onClick={() => setKind('webdav')}
            type="button"
            disabled={busy()}
          >
            WebDAV
          </button>
          <button
            classList={{ active: kind() === 's3' }}
            aria-pressed={kind() === 's3'}
            onClick={() => setKind('s3')}
            type="button"
            disabled={busy()}
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
            disabled={busy()}
          />
        </label>
        <label>
          {kind() === 'local' ? '文件夹路径' : '服务端地址'}
          <input
            type={kind() === 'local' ? 'text' : 'url'}
            value={endpoint()}
            onInput={(e) => setEndpoint(e.currentTarget.value)}
            placeholder={
              kind() === 'local'
                ? '选择本机文件夹'
                : kind() === 'webdav'
                  ? 'https://nas.example.com/dav/'
                  : 'https://s3.example.com'
            }
            required
            disabled={busy()}
          />
        </label>
        <Show when={kind() === 'local'}>
          <button
            class="button local-source-picker"
            type="button"
            disabled={busy() || !desktop}
            onClick={async () => {
              try {
                const path = await chooseDirectory('选择存储源文件夹');
                if (path) setEndpoint(path);
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            选择文件夹…
          </button>
        </Show>
        <Show when={kind() !== 'local'}>
          <TlsCertificatePanel
            endpoint={endpoint()}
            savedFingerprint={props.existing?.tls_certificate_sha256}
            savedEndpoint={props.existing?.endpoint}
            disabled={busy()}
            onTrustChange={setTrustPin}
          />
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
          <label class="checkbox-label">
            <input
              type="checkbox"
              checked={remember()}
              onChange={(e) => setRemember(e.currentTarget.checked)}
            />
            将凭据保存到系统安全存储
          </label>
          <Show when={!remember() || (props.existing && !locationChanged())}>
            <p class="credential-explanation">
              {!remember() ? '关闭应用后需重新输入凭据。' : ''}
              {props.existing && !locationChanged() && !remember()
                ? ' 已保存的系统凭据将被移除。'
                : ''}
              {props.existing && !locationChanged() ? ' 密码或密钥留空将保留已有凭据。' : ''}
            </p>
          </Show>
        </Show>
        <label>
          {kind() === 'webdav' ? '根目录' : '对象前缀'}（可选）
          <input
            value={root()}
            onInput={(e) => setRoot(e.currentTarget.value)}
            placeholder="photos/"
          />
        </label>
        <Show when={locationChanged()}>
          <p class="connection-location-note">
            地址、类型、根目录或存储桶已改变，将保存为新连接；原连接仍保留。
          </p>
        </Show>
        <Show when={error()}>
          <div class="form-error" role="alert">
            <StorageError error={error()} />
          </div>
        </Show>
        <footer class="modal-footer">
          <button class="button" type="button" onClick={props.onClose} disabled={busy()}>
            取消
          </button>
          <button
            class="button primary"
            disabled={busy() || !desktop || (kind() !== 'local' && trustPin() === undefined)}
          >
            {busy()
              ? '正在保存…'
              : locationChanged()
                ? '保存为新连接'
                : props.existing
                  ? '保存并重连'
                  : '添加连接'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
