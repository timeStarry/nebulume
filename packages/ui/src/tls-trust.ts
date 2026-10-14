import type { TlsCertificate } from './model';

export type TlsMode = 'standard' | 'pinned';
export interface CertificateRequest {
  endpoint: string;
  version: number;
}
export interface TlsTrustState {
  endpoint: string;
  mode: TlsMode;
  version: number;
  pending: boolean;
  confirmed: boolean;
  certificate?: TlsCertificate;
  retainedFingerprint?: string;
  error: string;
}

export function endpointProtocol(endpoint: string): string {
  try {
    return new URL(endpoint.trim()).protocol;
  } catch {
    return '';
  }
}

export function certificateEndpointIssue(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint.trim());
    if (url.protocol !== 'https:') return '读取设备证书需要 HTTPS 地址。';
    if (url.username || url.password || url.search || url.hash)
      return '证书检查地址不能包含用户名、密码、查询参数或片段。请在下方凭据字段填写账户信息。';
  } catch {
    return '请输入完整的 HTTPS 服务端地址。';
  }
}

export function initialTlsTrust(endpoint: string, pinned: boolean | string = false): TlsTrustState {
  return {
    endpoint,
    mode: pinned ? 'pinned' : 'standard',
    version: 0,
    pending: false,
    confirmed: false,
    retainedFingerprint: typeof pinned === 'string' ? normalizeFingerprint(pinned) : undefined,
    error: '',
  };
}

export function changeTrustEndpoint(state: TlsTrustState, endpoint: string): TlsTrustState {
  return { ...initialTlsTrust(endpoint, state.mode === 'pinned'), version: state.version + 1 };
}

export function changeTrustMode(state: TlsTrustState, mode: TlsMode): TlsTrustState {
  return { ...initialTlsTrust(state.endpoint, mode === 'pinned'), version: state.version + 1 };
}

export function startCertificateInspection(state: TlsTrustState): TlsTrustState {
  return {
    ...state,
    version: state.version + 1,
    certificate: undefined,
    retainedFingerprint: undefined,
    confirmed: false,
    pending: true,
    error: '',
  };
}

export function currentCertificateRequest(state: TlsTrustState): CertificateRequest {
  return { endpoint: state.endpoint.trim(), version: state.version };
}

export function requestIsCurrent(state: TlsTrustState, request: CertificateRequest): boolean {
  return (
    state.mode === 'pinned' &&
    state.pending &&
    state.version === request.version &&
    state.endpoint.trim() === request.endpoint
  );
}

export function normalizeFingerprint(value: string): string | undefined {
  const normalized = value.replace(/:/g, '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

export function receiveCertificate(
  state: TlsTrustState,
  request: CertificateRequest,
  certificate: TlsCertificate,
): TlsTrustState {
  if (!requestIsCurrent(state, request)) return state;
  const sha256 = normalizeFingerprint(certificate.sha256);
  let sameEndpoint = false;
  try {
    sameEndpoint = new URL(certificate.endpoint).href === new URL(request.endpoint).href;
  } catch {
    /* Keep malformed responses untrusted. */
  }
  if (!sha256 || !sameEndpoint)
    return {
      ...state,
      pending: false,
      error: '证书检查结果与当前地址不一致，或指纹格式无效。请重新检查。',
    };
  return {
    ...state,
    pending: false,
    confirmed: false,
    certificate: { ...certificate, sha256 },
    error: '',
  };
}

export function failCertificateInspection(
  state: TlsTrustState,
  request: CertificateRequest,
  error: string,
): TlsTrustState {
  return requestIsCurrent(state, request)
    ? { ...state, pending: false, confirmed: false, certificate: undefined, error }
    : state;
}

// undefined blocks saving; null explicitly selects normal certificate validation.
export function trustedFingerprint(state: TlsTrustState): string | null | undefined {
  if (endpointProtocol(state.endpoint) !== 'https:' || state.mode === 'standard') return null;
  if (!state.pending && state.retainedFingerprint) return state.retainedFingerprint;
  return !state.pending && state.confirmed && state.certificate
    ? normalizeFingerprint(state.certificate.sha256)
    : undefined;
}

export function displayFingerprint(value: string): string {
  return normalizeFingerprint(value)?.toUpperCase().match(/.{2}/g)?.join(':') || value;
}
