import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { chooseDirectory, desktop, execute } from './api';
import { errorMessage, type Library, type StorageConfig } from './model';
import Icon from './Icon';
import TlsCertificatePanel from './TlsCertificatePanel';
import StorageError from './StorageError';

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

export function LibraryDialog(props: {
  sources: StorageConfig[];
  initialSource?: StorageConfig;
  initialPrefix?: string;
  onSourceAdded: (source: StorageConfig) => void;
  onClose: () => void;
  onAdded: (library: Library) => void;
}) {
  const [name, setName] = createSignal(
    props.initialPrefix?.replace(/\/$/, '').split('/').pop() || props.initialSource?.name || '',
  );
  const [sourceId, setSourceId] = createSignal(
    props.initialSource?.id || props.sources[0]?.id || '',
  );
  const [prefix, setPrefix] = createSignal(props.initialPrefix || '');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  async function browseLocal() {
    try {
      const path = await chooseDirectory('选择图片库文件夹');
      if (!path) return;
      setBusy(true);
      const source = await execute<StorageConfig>('storage.add', {
        kind: 'local',
        endpoint: path,
        name: path.split(/[\\/]/).filter(Boolean).pop() || '本地文件夹',
      });
      props.onSourceAdded(source);
      setSourceId(source.id);
      setPrefix('');
      if (!name()) setName(source.name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!sourceId()) return;
    setBusy(true);
    setError('');
    try {
      props.onAdded(
        await execute<Library>('library.add', {
          name: name().trim(),
          storage_id: sourceId(),
          prefix: prefix().trim(),
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="建立图片库"
      subtitle="选择一个存储位置并建立索引，保留文件原有目录结构。"
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
          />
        </label>
        <label>
          存储源
          <select
            value={sourceId()}
            onChange={(e) => {
              setSourceId(e.currentTarget.value);
              setPrefix('');
            }}
            required
          >
            <option value="" disabled>
              选择已连接的存储位置
            </option>
            <For each={props.sources}>
              {(source) => <option value={source.id}>{source.name}</option>}
            </For>
          </select>
        </label>
        <button class="button" type="button" onClick={browseLocal} disabled={busy() || !desktop}>
          <Icon name="folder" size={16} />
          选择本地文件夹…
        </button>
        <label class="library-prefix-field">
          源内目录（可选）
          <input
            value={prefix()}
            onInput={(e) => setPrefix(e.currentTarget.value)}
            placeholder="留空使用此存储源的根目录"
          />
        </label>
        <div class="note">
          <Icon name="info" />
          <p>扫描建立影像索引。远程图片在查看时按需缓存，不会先下载整个图片库。</p>
        </div>
        <Show when={error()}>
          <div class="form-error" role="alert">
            <StorageError error={error()} />
          </div>
        </Show>
        <footer class="modal-footer">
          <button class="button" type="button" onClick={props.onClose} disabled={busy()}>
            取消
          </button>
          <button class="button primary" disabled={busy() || !desktop || !sourceId()}>
            {busy() ? '正在建立…' : '建立并扫描'}
          </button>
        </footer>
      </form>
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
      title={props.existing ? '连接设置 / 重连' : '添加存储源'}
      subtitle={
        props.existing
          ? '调整连接与证书策略。密码或密钥留空可保留现有凭据。'
          : '按需浏览和下载，在本地图库中管理影像。'
      }
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
            classList={{ active: kind() === 'local' }}
            onClick={() => setKind('local')}
            type="button"
            disabled={busy()}
          >
            本地文件夹
          </button>
          <button
            classList={{ active: kind() === 'webdav' }}
            onClick={() => setKind('webdav')}
            type="button"
            disabled={busy()}
          >
            WebDAV
          </button>
          <button
            classList={{ active: kind() === 's3' }}
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
          <p class="credential-explanation">
            {remember()
              ? '密码与密钥保存在操作系统安全存储中，连接配置不包含秘密。'
              : '仅在当前会话保留凭据；关闭应用后需重新输入。'}
            {props.existing && !remember() ? ' 此连接此前保存的系统凭据将被移除。' : ''}
            {props.existing ? ' 密码或密钥留空将保留已有凭据。' : ''}
          </p>
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
          <p>保存连接后可测试访问并浏览目录。仅在实际连接成功后显示已验证状态。</p>
        </div>
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
