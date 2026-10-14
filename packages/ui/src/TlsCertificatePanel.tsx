import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { desktop, execute } from './api';
import { errorMessage, type TlsCertificate } from './model';
import {
  certificateEndpointIssue,
  changeTrustEndpoint,
  changeTrustMode,
  currentCertificateRequest,
  displayFingerprint,
  endpointProtocol,
  failCertificateInspection,
  initialTlsTrust,
  normalizeFingerprint,
  receiveCertificate,
  startCertificateInspection,
  trustedFingerprint,
} from './tls-trust';
import Icon from './Icon';

export default function TlsCertificatePanel(props: {
  endpoint: string;
  savedFingerprint?: string | null;
  disabled?: boolean;
  onTrustChange: (fingerprint: string | null | undefined) => void;
}) {
  const [trust, setTrust] = createSignal(initialTlsTrust(props.endpoint, !!props.savedFingerprint));
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  createEffect(
    on(
      () => props.endpoint,
      (endpoint) => setTrust((state) => changeTrustEndpoint(state, endpoint)),
    ),
  );
  createEffect(() => props.onTrustChange(trustedFingerprint(trust())));

  async function inspect() {
    if (!desktop || endpointProtocol(props.endpoint) !== 'https:' || props.disabled) return;
    const issue = certificateEndpointIssue(props.endpoint);
    if (issue) {
      setTrust((state) => ({ ...state, certificate: undefined, confirmed: false, error: issue }));
      return;
    }
    const next = startCertificateInspection(trust());
    setTrust(next);
    const request = currentCertificateRequest(next);
    try {
      const certificate = await execute<TlsCertificate>('storage.inspect_tls', {
        endpoint: request.endpoint,
      });
      if (!disposed) setTrust((state) => receiveCertificate(state, request, certificate));
    } catch (error) {
      if (!disposed)
        setTrust((state) => failCertificateInspection(state, request, errorMessage(error)));
    }
  }

  return (
    <>
      <Show when={endpointProtocol(props.endpoint) === 'http:'}>
        <div class="connection-transport http">
          <Icon name="info" size={14} />
          <strong>HTTP · 未加密</strong>
          <span>仅支持本机与局域网地址。</span>
        </div>
      </Show>
      <Show when={endpointProtocol(props.endpoint) === 'https:'}>
        <fieldset class="tls-policy" disabled={props.disabled}>
          <legend>HTTPS 证书校验</legend>
          <label class="tls-option">
            <input
              type="radio"
              name="tls-mode"
              value="standard"
              checked={trust().mode === 'standard'}
              onChange={() => setTrust((state) => changeTrustMode(state, 'standard'))}
            />
            <span>
              标准校验 <small>默认</small>
            </span>
          </label>
          <label class="tls-option">
            <input
              type="radio"
              name="tls-mode"
              value="pinned"
              checked={trust().mode === 'pinned'}
              onChange={() => setTrust((state) => changeTrustMode(state, 'pinned'))}
            />
            <span>信任此设备证书</span>
          </label>
          <Show when={trust().mode === 'pinned'}>
            <div class="certificate-review">
              <p>
                适用于局域网自签证书。以此证书的指纹识别服务器，允许自签或名称不匹配；证书变化后须重新确认。
              </p>
              <Show when={props.savedFingerprint}>
                <div class="saved-fingerprint">
                  <span>已保存的 SHA-256</span>
                  <code>{displayFingerprint(props.savedFingerprint!)}</code>
                </div>
              </Show>
              <button
                class="button small"
                type="button"
                onClick={inspect}
                disabled={trust().pending || !desktop || props.disabled}
              >
                {trust().pending
                  ? '正在读取证书…'
                  : trust().certificate
                    ? '重新读取证书'
                    : '读取设备证书'}
              </button>
              <p class="certificate-inspect-note">
                读取证书不发送用户名、密码或密钥，也不会保存信任。
              </p>
              <Show when={trust().error}>
                <p class="form-error" role="alert">
                  {trust().error}
                </p>
              </Show>
              <Show when={trust().certificate}>
                {(certificate) => (
                  <div class="certificate-details">
                    <dl>
                      <dt>连接地址</dt>
                      <dd>{certificate().endpoint}</dd>
                      <dt>证书主体</dt>
                      <dd>{certificate().subject || '未提供'}</dd>
                      <dt>签发者</dt>
                      <dd>{certificate().issuer || '未提供'}</dd>
                      <dt>适用名称</dt>
                      <dd>
                        <For each={certificate().subject_alt_names} fallback="未提供">
                          {(name) => <span class="certificate-name">{name}</span>}
                        </For>
                      </dd>
                      <dt>生效时间</dt>
                      <dd>{certificateDate(certificate().not_before)}</dd>
                      <dt>到期时间</dt>
                      <dd>{certificateDate(certificate().not_after)}</dd>
                      <dt>SHA-256</dt>
                      <dd class="certificate-fingerprint">
                        <code>{displayFingerprint(certificate().sha256)}</code>
                      </dd>
                    </dl>
                    <Show
                      when={
                        props.savedFingerprint &&
                        normalizeFingerprint(props.savedFingerprint) !== certificate().sha256
                      }
                    >
                      <p class="certificate-changed">设备证书与之前保存的指纹不同，请重新核对。</p>
                    </Show>
                    <label class="checkbox-label certificate-confirm">
                      <input
                        type="checkbox"
                        checked={trust().confirmed}
                        onChange={(event) =>
                          setTrust((state) => ({
                            ...state,
                            confirmed: event.currentTarget.checked,
                          }))
                        }
                      />
                      我已核对该设备的 SHA-256 指纹，信任此连接使用这张证书。
                    </label>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </fieldset>
      </Show>
    </>
  );
}

function certificateDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
