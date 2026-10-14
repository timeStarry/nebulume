import { errorMessage } from './model';

export interface StorageErrorPresentation {
  summary: string;
  details?: string;
}

/** Keep transport diagnostics available without making a stack trace the primary instruction. */
export function storageErrorPresentation(error: unknown): StorageErrorPresentation {
  const raw = errorMessage(error).trim();
  let summary: string;
  if (
    /certificate.*(?:fingerprint|pin).*(?:mismatch|changed)|certificate.*differs.*fingerprint|fingerprint.*(?:mismatch|match)|pinned.*(?:mismatch|match)/i.test(
      raw,
    )
  )
    summary = '设备证书与已信任的指纹不同。请在连接设置中重新读取证书，核对设备指纹后再确认。';
  else if (
    /UnknownIssuer|unknown issuer|self[- ]signed|unable to get local issuer|untrusted.*certificate/i.test(
      raw,
    )
  )
    summary =
      '无法验证设备证书。如果这是你的 NAS，请在连接设置中选择“信任此设备证书”，读取并核对指纹后保存。';
  else if (
    /certificate.*(?:expired|notvalidyet)|cert(?:ificate)?expired|not valid (?:before|after)|invalid peer certificate.*expired/i.test(
      raw,
    )
  )
    summary = '设备证书已过期或尚未生效。请检查本机时间，并更新设备证书后重试。';
  else if (/NotValidForName|hostname mismatch|certificate.*name.*mismatch/i.test(raw))
    summary =
      '连接地址与设备证书名称不匹配。请检查地址；若这是你的设备，可在连接设置中核对并信任其具体证书。';
  else if (
    /credentials?.*(?:are missing|missing|not found)|saved credentials were not found|credential record is unreadable|enter (?:the )?credentials again/i.test(
      raw,
    )
  )
    summary =
      '此连接没有可用的登录信息。请打开连接设置重新输入账号与密码或访问密钥，勾选“将凭据保存到系统安全存储”可在重启后继续使用。';
  else if (
    /\b401\b|Unauthorized|InvalidAccessKeyId|SignatureDoesNotMatch|authentication (?:failed|failure)/i.test(
      raw,
    )
  )
    summary = '账号认证失败。请在连接设置中核对用户名、密码或访问密钥，再测试连接。';
  else if (/\b403\b|Forbidden|AccessDenied/i.test(raw))
    summary = '服务器拒绝访问此目录。请检查账号的目录或存储桶权限，以及连接中的根目录设置。';
  else if (
    /(?:credential[- ]store|credential store|keyring|keychain).*(?:locked|unavailable)|cannot (?:save credentials securely|update saved credentials|remove saved credentials|verify the credential-store)/i.test(
      raw,
    )
  )
    summary =
      '系统凭据库已锁定或暂时不可用。请先解锁系统凭据库后重试；也可在连接设置中取消系统保存，仅在本次会话使用。';
  else if (/connection refused|ConnectError|actively refused|连接被拒绝/i.test(raw))
    summary =
      '无法连接到设备。请确认设备已开机、地址与端口正确，并已启用对应的 WebDAV 或 S3 服务。';
  else if (/timed? ?out|timeout|deadline has elapsed/i.test(raw))
    summary = '连接超时。请检查网络、设备地址与服务状态后重试。';
  else if (/dns error|failed to lookup|name or service not known|No such host/i.test(raw))
    summary = '无法找到设备地址。请检查域名，或使用设备在局域网中的 IP 地址。';
  else if (/hard.?links?|hard_link/i.test(raw))
    summary = '目标文件系统不支持安全保存此副本。请换用支持硬链接的本地目录；原始文件保持不变。';
  else if (/[\u3400-\u9fff]/.test(raw) && raw.length <= 220 && !raw.includes('\n'))
    return { summary: raw };
  else summary = '存储操作未完成。请检查连接设置与文件访问权限后重试；具体原因可展开错误详情查看。';
  return { summary, details: raw };
}
