import { describe, expect, it } from 'vitest';
import { storageErrorPresentation } from '../src/storage-error';

describe('actionable storage diagnostics', () => {
  it.each([
    ['error sending request: invalid peer certificate: UnknownIssuer', '信任此设备证书'],
    [
      'Credentials are missing; reconnect this storage and choose system credential storage to restore it after restart',
      '重新输入账号与密码',
    ],
    [
      'Saved credentials were not found in the system credential store; enter them again',
      '系统安全存储',
    ],
    ['WebDAV failed: HTTP 401 Unauthorized', '账号认证失败'],
    [
      'Cannot save credentials securely: The system credential store is locked or unavailable',
      '解锁系统凭据库',
    ],
    [
      "The server certificate SHA-256 differs from this storage's trusted fingerprint",
      '重新读取证书',
    ],
    ['TLS handshake failed: connection refused', '地址与端口正确'],
  ])('turns %s into a short instruction and preserves original detail', (raw, expected) => {
    const presented = storageErrorPresentation({ code: 'NETWORK', message: raw });
    expect(presented.summary).toContain(expected);
    expect(presented.details).toBe(raw);
    expect(presented.summary).not.toContain('UnknownIssuer');
  });
  it('preserves concise Chinese validation and collapses unexpected stacks into details', () => {
    expect(storageErrorPresentation('请输入完整的 HTTPS 服务端地址。')).toEqual({
      summary: '请输入完整的 HTTPS 服务端地址。',
    });
    const raw = 'unexpected transport failure\nCaused by: connector::request\n at network.rs:123';
    expect(storageErrorPresentation(raw).details).toBe(raw);
    expect(storageErrorPresentation(raw).summary).not.toContain('network.rs');
  });
});
