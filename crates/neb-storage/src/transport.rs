//! Connection-scoped LAN transport policy. Inspection never sends an HTTP request.
use crate::{remote::validate_endpoint, StorageConfig};
use anyhow::{bail, Context, Result};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider},
    pki_types::{CertificateDer, ServerName, UnixTime},
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, Error,
    SignatureScheme,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read, Write},
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    sync::Arc,
    time::{Duration, Instant},
};
use url::{Host, Url};
use x509_parser::{extensions::GeneralName, prelude::*};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Serialize)]
pub struct TlsCertificateInfo {
    pub endpoint: String,
    pub sha256: String,
    pub subject: String,
    pub issuer: String,
    pub not_before: String,
    pub not_after: String,
    pub subject_alt_names: Vec<String>,
}

pub(crate) fn normalize_pin(pin: Option<&str>) -> Result<Option<String>> {
    pin.map(|pin| {
        let normalized = pin.trim().replace(':', "").to_ascii_lowercase();
        if normalized.len() != 64 || !normalized.bytes().all(|c| c.is_ascii_hexdigit()) {
            bail!("Certificate SHA-256 must contain exactly 64 hexadecimal digits");
        }
        Ok(normalized)
    })
    .transpose()
}

fn is_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return is_lan(IpAddr::V4(v4));
            }
            ip.is_loopback()
                || (ip.segments()[0] & 0xfe00 == 0xfc00)
                || (ip.segments()[0] & 0xffc0 == 0xfe80)
        }
    }
}

#[derive(Debug)]
struct LanTarget {
    host: String,
    addresses: Vec<SocketAddr>,
}

impl LanTarget {
    fn checked(host: String, mut addresses: Vec<SocketAddr>) -> Result<Self> {
        if addresses.is_empty() || addresses.len() > 64 {
            bail!("LAN endpoint must resolve to between 1 and 64 addresses");
        }
        // Reject mixed public/private answers too; no fallback may leave the approved LAN.
        if addresses.iter().any(|address| !is_lan(address.ip())) {
            bail!("HTTP and certificate fingerprint trust are limited to LAN addresses (private, loopback or link-local)");
        }
        addresses.sort_unstable();
        addresses.dedup();
        Ok(Self { host, addresses })
    }

    fn resolve(url: &Url) -> Result<Self> {
        let port = url
            .port_or_known_default()
            .context("Endpoint port is required")?;
        let (host, addresses) = match url.host().context("Endpoint host is required")? {
            Host::Ipv4(ip) => (ip.to_string(), vec![SocketAddr::new(ip.into(), port)]),
            Host::Ipv6(ip) => (ip.to_string(), vec![SocketAddr::new(ip.into(), port)]),
            Host::Domain(host) => (
                host.to_string(),
                (host, port)
                    .to_socket_addrs()
                    .context("Cannot resolve the LAN endpoint")?
                    .collect(),
            ),
        };
        Self::checked(host, addresses)
    }
}

pub(crate) fn client(config: &StorageConfig) -> Result<reqwest::blocking::Client> {
    let url = validate_endpoint(&config.endpoint)?;
    let pin = normalize_pin(config.tls_certificate_sha256.as_deref())?;
    if pin.is_some() && url.scheme() != "https" {
        bail!("Certificate fingerprint trust requires a LAN HTTPS endpoint");
    }
    let lan = if url.scheme() == "http" || pin.is_some() {
        Some(LanTarget::resolve(&url)?)
    } else {
        None
    };
    build_client(pin, lan.as_ref())
}

fn build_client(pin: Option<String>, lan: Option<&LanTarget>) -> Result<reqwest::blocking::Client> {
    if pin.is_some() && lan.is_none() {
        bail!("Certificate fingerprint trust requires approved LAN addresses");
    }
    let mut builder = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(Duration::from_secs(300));
    if let Some(lan) = lan {
        // This is the same immutable answer set that passed LAN policy, not a second DNS query.
        builder = builder.resolve_to_addrs(&lan.host, &lan.addresses);
    }
    if let Some(pin) = pin {
        builder = builder.use_preconfigured_tls(pinned_tls(Some(pin))?);
    }
    Ok(builder.build()?)
}

#[derive(Debug)]
struct FingerprintVerifier {
    expected: Option<String>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, Error> {
        let (remaining, certificate) = parse_x509_certificate(end_entity.as_ref())
            .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
        if !remaining.is_empty() {
            return Err(Error::InvalidCertificate(CertificateError::BadEncoding));
        }
        let now = i64::try_from(now.as_secs())
            .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
        if now < certificate.validity().not_before.timestamp() {
            return Err(Error::InvalidCertificate(CertificateError::NotValidYet));
        }
        if now > certificate.validity().not_after.timestamp() {
            return Err(Error::InvalidCertificate(CertificateError::Expired));
        }
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| expected != &hex::encode(Sha256::digest(end_entity.as_ref())))
        {
            return Err(Error::General(
                "The server certificate SHA-256 differs from this storage's trusted fingerprint"
                    .into(),
            ));
        }
        // Identity is the explicit leaf pin (or untrusted discovery), not its CA/name.
        // TLS CertificateVerify is still verified cryptographically below.
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn pinned_tls(expected: Option<String>) -> Result<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Ok(ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(FingerprintVerifier { expected, provider }))
        .with_no_client_auth())
}

/// Inspect an untrusted LAN server without credentials, HTTP data or persisted trust.
/// The caller must obtain an explicit trust decision before storing the returned pin.
pub fn inspect_tls(endpoint: &str) -> Result<TlsCertificateInfo> {
    let url = validate_endpoint(endpoint)?;
    if url.scheme() != "https" {
        bail!("Certificate inspection requires a LAN HTTPS endpoint");
    }
    let lan = LanTarget::resolve(&url)?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut socket = None;
    for address in &lan.addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(stream) =
            TcpStream::connect_timeout(address, remaining.min(Duration::from_secs(3)))
        {
            socket = Some(stream);
            break;
        }
    }
    let mut socket = DeadlineStream {
        stream: socket.context("Cannot connect to the LAN TLS endpoint within 15 seconds")?,
        deadline,
    };
    let server_name = ServerName::try_from(lan.host.clone()).context("Invalid TLS server name")?;
    let mut connection = ClientConnection::new(Arc::new(pinned_tls(None)?), server_name)?;
    while connection.is_handshaking() {
        connection
            .complete_io(&mut socket)
            .context("Cannot inspect the LAN TLS certificate")?;
    }
    let der = connection
        .peer_certificates()
        .and_then(|chain| chain.first())
        .context("TLS server did not provide a certificate")?;
    certificate_info(url.to_string(), der)
}

struct DeadlineStream {
    stream: TcpStream,
    deadline: Instant,
}
impl DeadlineStream {
    fn remaining(&self) -> io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "TLS inspection exceeded 15 seconds",
                )
            })
    }
}
impl Read for DeadlineStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        self.stream.read(bytes)
    }
}
impl Write for DeadlineStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

fn certificate_info(endpoint: String, der: &CertificateDer<'_>) -> Result<TlsCertificateInfo> {
    let (_, cert) = parse_x509_certificate(der.as_ref()).context("Invalid TLS certificate")?;
    let format_time = |timestamp| -> Result<String> {
        Ok(chrono::DateTime::from_timestamp(timestamp, 0)
            .context("Certificate time is out of range")?
            .to_rfc3339())
    };
    let subject_alt_names = cert
        .subject_alternative_name()?
        .map(|extension| {
            extension
                .value
                .general_names
                .iter()
                .map(|name| match name {
                    GeneralName::DNSName(name) => name.to_string(),
                    GeneralName::IPAddress(bytes) if bytes.len() == 4 => {
                        std::net::Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]).to_string()
                    }
                    GeneralName::IPAddress(bytes) if bytes.len() == 16 => {
                        let mut address = [0u8; 16];
                        address.copy_from_slice(bytes);
                        std::net::Ipv6Addr::from(address).to_string()
                    }
                    _ => format!("{name:?}"),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(TlsCertificateInfo {
        endpoint,
        sha256: hex::encode(Sha256::digest(der.as_ref())),
        subject: cert.subject().to_string(),
        issuer: cert.issuer().to_string(),
        not_before: format_time(cert.validity().not_before.timestamp())?,
        not_after: format_time(cert.validity().not_after.timestamp())?,
        subject_alt_names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_address_policy_has_explicit_ipv4_ipv6_boundaries() {
        for ip in [
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "127.9.8.7",
            "169.254.1.1",
            "::1",
            "fc00::1",
            "fdff::1",
            "fe80::1",
            "febf::1",
            "::ffff:192.168.1.1",
        ] {
            assert!(is_lan(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "0.0.0.0",
            "8.8.8.8",
            "172.15.255.255",
            "172.32.0.1",
            "192.169.0.1",
            "100.64.0.1",
            "224.0.0.1",
            "::",
            "2001:db8::1",
            "fec0::1",
            "ff02::1",
            "::ffff:8.8.8.8",
        ] {
            assert!(!is_lan(ip.parse().unwrap()), "{ip}");
        }
        assert!(LanTarget::checked(
            "mixed.invalid".into(),
            vec![
                "127.0.0.1:80".parse().unwrap(),
                "8.8.8.8:80".parse().unwrap()
            ]
        )
        .is_err());
        assert!(LanTarget::checked("empty.invalid".into(), vec![]).is_err());
    }

    #[test]
    fn hostname_connections_use_the_exact_approved_addresses() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = [0u8; 2048];
            let size = stream.read(&mut bytes).unwrap();
            assert!(
                String::from_utf8_lossy(&bytes[..size]).contains("host: never-resolves.invalid:")
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        let target = LanTarget::checked("never-resolves.invalid".into(), vec![address]).unwrap();
        let client = build_client(None, Some(&target)).unwrap();
        assert_eq!(
            client
                .get(format!("http://never-resolves.invalid:{}/", address.port()))
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        server.join().unwrap();
    }
}
