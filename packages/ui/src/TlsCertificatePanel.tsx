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
import { FieldHint } from './ui';
import StorageError from './StorageError';

export default function TlsCertificatePanel(props: {
  endpoint: string;
  savedFingerprint?: string | null;
  savedEndpoint?: string;
  disabled?: boolean;
  onTrustChange: (fingerprint: string | null | undefined) => void;
}) {
  const [trust, setTrust] = createSignal(
    initialTlsTrust(
      props.endpoint,
      props.savedFingerprint && props.endpoint === props.savedEndpoint
        ? props.savedFingerprint
        : !!props.savedFingerprint,
    ),
  );
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  createEffect(
    on(
      () => props.endpoint,
      (endpoint) => setTrust((state) => changeTrustEndpoint(state, endpoint)),
      { defer: true },
    ),
  );
  createEffect(() => props.onTrustChange(trustedFingerprint(trust())));

  async function inspect() {
    if (!desktop || endpointProtocol(props.endpoint) !== 'https:' || props.disabled) return;
    const issue = certificateEndpointIssue(props.endpoint);
    if (issue) {
      setTrust((state) => ({ ...startCertificateInspection(state), pending: false, error: issue }));
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
        <FieldHint tone="warn">
          <strong>HTTP · 未加密</strong>，仅支持本机、局域网与组网内网（100.64.x.x）。
        </FieldHint>
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
              <p>允许自签或名称不匹配，仅信任当前证书；证书更换后需重新确认。</p>
              <Show when={props.savedFingerprint}>
                <div class="saved-fingerprint">
                  <span>
                    {trust().retainedFingerprint ? '已信任的 SHA-256' : '上次保存的 SHA-256'}
                  </span>
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
              <Show when={trust().error}>
                <StorageError error={trust().error} />
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
                      <FieldHint tone="warn">设备证书与之前保存的指纹不同，请重新核对。</FieldHint>
                    </Show>
                    <Show when={isExpiredCertificate(certificate().not_after)}>
                      <FieldHint tone="warn">
                        该设备自签证书已过期，确认核对指纹并信任后仍可连接。
                      </FieldHint>
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

function isExpiredCertificate(value: string): boolean {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time < Date.now();
}
