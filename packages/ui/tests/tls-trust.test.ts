import { describe, expect, it } from 'vitest';
import type { TlsCertificate } from '../src/model';
import {
  certificateEndpointIssue,
  changeTrustEndpoint,
  changeTrustMode,
  currentCertificateRequest,
  failCertificateInspection,
  initialTlsTrust,
  normalizeFingerprint,
  receiveCertificate,
  startCertificateInspection,
  trustedFingerprint,
} from '../src/tls-trust';

const endpoint = 'https://nas.local:5006/dav/';
const certificate: TlsCertificate = {
  endpoint,
  sha256: 'a1'.repeat(32),
  subject: 'CN=Family NAS',
  issuer: 'CN=Family NAS',
  not_before: '2026-01-01T00:00:00Z',
  not_after: '2027-01-01T00:00:00Z',
  subject_alt_names: ['nas.local'],
};
function inspected() {
  const pending = startCertificateInspection(initialTlsTrust(endpoint, true));
  return receiveCertificate(pending, currentCertificateRequest(pending), certificate);
}

describe('certificate-bound, explicit device trust', () => {
  it('selects standard validation by default and does not require a confirmation', () => {
    expect(trustedFingerprint(initialTlsTrust(endpoint))).toBeNull();
    expect(trustedFingerprint(initialTlsTrust('http://192.168.1.2:5005/dav/', true))).toBeNull();
  });
  it('never trusts discovery or a saved-pin mode without a fresh explicit confirmation', () => {
    expect(trustedFingerprint(initialTlsTrust(endpoint, true))).toBeUndefined();
    const result = inspected();
    expect(result.confirmed).toBe(false);
    expect(trustedFingerprint(result)).toBeUndefined();
    expect(trustedFingerprint({ ...result, confirmed: true })).toBe(certificate.sha256);
  });
  it('revokes confirmation when the address, mode or inspection changes', () => {
    const trusted = { ...inspected(), confirmed: true };
    const edited = changeTrustEndpoint(trusted, 'https://other-nas.local/dav/');
    expect(edited.certificate).toBeUndefined();
    expect(trustedFingerprint(edited)).toBeUndefined();
    expect(trustedFingerprint(changeTrustMode(trusted, 'standard'))).toBeNull();
    expect(trustedFingerprint(startCertificateInspection(trusted))).toBeUndefined();
  });
  it('ignores a delayed response even if the user changed away and back to the same address', () => {
    const pending = startCertificateInspection(initialTlsTrust(endpoint, true));
    const request = currentCertificateRequest(pending);
    const changed = changeTrustEndpoint(
      changeTrustEndpoint(pending, 'https://new.local/'),
      endpoint,
    );
    expect(receiveCertificate(changed, request, certificate)).toBe(changed);
    expect(failCertificateInspection(changed, request, 'stale failure')).toBe(changed);
  });
  it('does not let an older inspection replace a newly confirmed fingerprint', () => {
    const first = startCertificateInspection(initialTlsTrust(endpoint, true));
    const second = startCertificateInspection(first);
    const current = {
      ...receiveCertificate(second, currentCertificateRequest(second), {
        ...certificate,
        sha256: 'b2'.repeat(32),
      }),
      confirmed: true,
    };
    expect(receiveCertificate(current, currentCertificateRequest(first), certificate)).toBe(
      current,
    );
    expect(trustedFingerprint(current)).toBe('b2'.repeat(32));
  });
  it('rejects malformed fingerprints or certificates returned for another address', () => {
    const pending = startCertificateInspection(initialTlsTrust(endpoint, true));
    const request = currentCertificateRequest(pending);
    for (const invalid of [
      { ...certificate, sha256: 'anything' },
      { ...certificate, endpoint: 'https://other.local/' },
    ]) {
      const result = receiveCertificate(pending, request, invalid);
      expect(result.error).toContain('不一致');
      expect(result.certificate).toBeUndefined();
    }
    expect(normalizeFingerprint('AA:'.repeat(31) + 'AA')).toBe('aa'.repeat(32));
  });
  it('does not send credentials embedded in an inspection URL', () => {
    expect(certificateEndpointIssue('https://user:secret@nas.local/')).toContain('用户名');
    expect(certificateEndpointIssue('https://nas.local/?token=secret')).toContain('查询参数');
    expect(certificateEndpointIssue(endpoint)).toBeUndefined();
  });
});
