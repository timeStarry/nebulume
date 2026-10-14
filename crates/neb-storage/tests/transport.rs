use neb_storage::{inspect_tls, AddStorageRequest, StorageRegistry};
use rcgen::{date_time_ymd, CertificateParams, DistinguishedName, DnType, KeyPair};
use rustls::{
    pki_types::PrivatePkcs8KeyDer,
    server::{ClientHello, ResolvesServerCert},
    sign::CertifiedKey,
    ServerConfig, ServerConnection, StreamOwned,
};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Debug)]
struct FixedCertificate(Arc<CertifiedKey>);
impl ResolvesServerCert for FixedCertificate {
    fn resolve(&self, _: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }
}

struct TlsServer {
    endpoint: String,
    pin: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    address: SocketAddr,
    handle: Option<JoinHandle<()>>,
}

impl TlsServer {
    fn new(validity: &str, tls12: bool, wrong_signature_key: bool) -> Self {
        let mut params =
            CertificateParams::new(vec!["different-host.example.invalid".into()]).unwrap();
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, "Nebulume synthetic TLS fixture");
        params.distinguished_name = name;
        params.not_before = date_time_ymd(if validity == "future" { 2090 } else { 2020 }, 1, 1);
        params.not_after = date_time_ymd(if validity == "expired" { 2021 } else { 2099 }, 1, 1);
        let key = KeyPair::generate().unwrap();
        let cert = params.self_signed(&key).unwrap();
        let pin = hex::encode(Sha256::digest(cert.der()));
        let signing_key = if wrong_signature_key {
            KeyPair::generate().unwrap()
        } else {
            key
        };
        let private_key = PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into();
        // Direct resolver permits intentionally mismatched keys to test CertificateVerify rejection.
        let signing_key = rustls::crypto::ring::sign::any_supported_type(&private_key).unwrap();
        let certified = CertifiedKey::new(vec![cert.der().clone()], signing_key);
        let version = if tls12 {
            &rustls::version::TLS12
        } else {
            &rustls::version::TLS13
        };
        let config =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_protocol_versions(&[version])
                .unwrap()
                .with_no_client_auth()
                .with_cert_resolver(Arc::new(FixedCertificate(Arc::new(certified))));
        let config = Arc::new(config);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let thread_stop = stop.clone();
        let thread_requests = requests.clone();
        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                let (socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                };
                if thread_stop.load(Ordering::Relaxed) {
                    break;
                }
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut stream =
                    StreamOwned::new(ServerConnection::new(config.clone()).unwrap(), socket);
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                loop {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(size) => request.extend_from_slice(&buffer[..size]),
                    }
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        thread_requests
                            .lock()
                            .unwrap()
                            .push(String::from_utf8_lossy(&request).into_owned());
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nphoto");
                        break;
                    }
                    if request.len() > 8192 {
                        break;
                    }
                }
            }
        });
        Self {
            endpoint: format!("https://{address}"),
            pin,
            requests,
            stop,
            address,
            handle: Some(handle),
        }
    }
}

impl Drop for TlsServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_secs(1));
        self.handle.take().unwrap().join().unwrap();
    }
}

fn request(endpoint: &str, root: &str, pin: Option<&str>) -> AddStorageRequest {
    serde_json::from_value(serde_json::json!({
        "name":"TLS fixture", "kind":"webdav", "endpoint":endpoint, "root":root,
        "username":"synthetic-user", "password":"synthetic-secret", "tls_certificate_sha256":pin, "remember_credentials":false
    }))
    .unwrap()
}

fn read_photo(registry: &StorageRegistry, id: &str) -> anyhow::Result<String> {
    let mut value = String::new();
    registry
        .reader(id, "photo.jpg")?
        .read_to_string(&mut value)?;
    Ok(value)
}

#[test]
fn self_signed_requires_explicit_source_pin_and_hostname_mismatch_is_permitted_only_there() {
    let server = TlsServer::new("valid", false, false);
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let strict = registry
        .add(request(&server.endpoint, "strict", None))
        .unwrap();
    assert!(read_photo(&registry, &strict.id).is_err());
    let trusted = registry
        .add(request(&server.endpoint, "trusted", Some(&server.pin)))
        .unwrap();
    assert_eq!(read_photo(&registry, &trusted.id).unwrap(), "photo");
    // Another source sharing the host still uses normal CA/name validation.
    assert!(read_photo(&registry, &strict.id).is_err());
    let cleared = registry
        .add(request(&server.endpoint, "trusted", None))
        .unwrap();
    assert_eq!(cleared.id, trusted.id);
    assert!(cleared.tls_certificate_sha256.is_none());
    assert!(read_photo(&registry, &trusted.id).is_err());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn changed_certificate_fingerprint_is_rejected_before_credentials_are_sent() {
    let original = TlsServer::new("valid", false, false);
    let replacement = TlsServer::new("valid", false, false);
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let config = registry
        .add(request(&replacement.endpoint, "", Some(&original.pin)))
        .unwrap();
    assert!(read_photo(&registry, &config.id).is_err());
    assert!(replacement.requests.lock().unwrap().is_empty());
}

#[test]
fn expired_and_not_yet_valid_pinned_certificates_are_rejected() {
    for validity in ["expired", "future"] {
        let server = TlsServer::new(validity, false, false);
        let data = tempfile::tempdir().unwrap();
        let mut registry = StorageRegistry::open(data.path()).unwrap();
        let config = registry
            .add(request(&server.endpoint, "", Some(&server.pin)))
            .unwrap();
        assert!(read_photo(&registry, &config.id).is_err(), "{validity}");
        assert!(inspect_tls(&server.endpoint).is_err(), "{validity}");
        assert!(server.requests.lock().unwrap().is_empty());
    }
}

#[test]
fn pinned_tls12_and_tls13_verify_real_handshake_signatures() {
    for tls12 in [true, false] {
        for wrong_key in [false, true] {
            let server = TlsServer::new("valid", tls12, wrong_key);
            let data = tempfile::tempdir().unwrap();
            let mut registry = StorageRegistry::open(data.path()).unwrap();
            let config = registry
                .add(request(&server.endpoint, "", Some(&server.pin)))
                .unwrap();
            let result = read_photo(&registry, &config.id);
            assert_eq!(
                result.is_err(),
                wrong_key,
                "TLS12={tls12} wrong_key={wrong_key}"
            );
            if wrong_key {
                assert!(server.requests.lock().unwrap().is_empty());
            }
        }
    }
}

#[test]
fn inspection_returns_metadata_without_http_credentials_or_persisted_trust() {
    let server = TlsServer::new("valid", false, false);
    let info = inspect_tls(&server.endpoint).unwrap();
    assert_eq!(info.sha256, server.pin);
    assert_eq!(info.endpoint, format!("{}/", server.endpoint));
    assert!(info.subject.contains("Nebulume synthetic TLS fixture"));
    assert_eq!(info.subject, info.issuer);
    assert!(info.not_before.starts_with("2020-01-01T"));
    assert!(info.not_after.starts_with("2099-01-01T"));
    assert_eq!(info.subject_alt_names, ["different-host.example.invalid"]);
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let config = registry.add(request(&server.endpoint, "", None)).unwrap();
    assert!(read_photo(&registry, &config.id).is_err());
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn saved_pin_survives_reopen_but_credentials_do_not() {
    let server = TlsServer::new("valid", false, false);
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    let pin_with_colons = server
        .pin
        .as_bytes()
        .chunks(2)
        .map(|bytes| std::str::from_utf8(bytes).unwrap())
        .collect::<Vec<_>>()
        .join(":")
        .to_uppercase();
    let config = registry
        .add(request(&server.endpoint, "", Some(&pin_with_colons)))
        .unwrap();
    assert_eq!(
        config.tls_certificate_sha256.as_deref(),
        Some(server.pin.as_str())
    );
    let saved = std::fs::read_to_string(data.path().join("storage.json")).unwrap();
    assert!(saved.contains(&server.pin));
    assert!(!saved.contains("synthetic-secret"));
    let mut reopened = StorageRegistry::open(data.path()).unwrap();
    assert_eq!(
        reopened.list()[0].tls_certificate_sha256,
        config.tls_certificate_sha256
    );
    assert!(!reopened.list()[0].connected);
    assert!(read_photo(&reopened, &config.id).is_err());
    let reconnected = reopened
        .add(request(&server.endpoint, "", Some(&server.pin)))
        .unwrap();
    assert_eq!(reconnected.id, config.id);
    assert_eq!(read_photo(&reopened, &config.id).unwrap(), "photo");
}

#[test]
fn old_configuration_defaults_to_public_ca_validation() {
    let server = TlsServer::new("valid", false, false);
    let data = tempfile::tempdir().unwrap();
    std::fs::write(
        data.path().join("storage.json"),
        serde_json::to_vec(&serde_json::json!([{
            "id":"legacy", "name":"Legacy", "kind":"webdav", "endpoint":server.endpoint,
            "root":"", "bucket":null, "region":null
        }]))
        .unwrap(),
    )
    .unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    assert!(registry.list()[0].tls_certificate_sha256.is_none());
    let config = registry.add(request(&server.endpoint, "", None)).unwrap();
    assert_eq!(config.id, "legacy");
    assert!(read_photo(&registry, &config.id).is_err());
}

#[test]
fn public_http_and_public_pins_are_rejected_without_connecting() {
    let data = tempfile::tempdir().unwrap();
    let mut registry = StorageRegistry::open(data.path()).unwrap();
    for endpoint in [
        "http://8.8.8.8",
        "http://[2001:db8::1]",
        "http://0.0.0.0",
        "http://[::]",
    ] {
        assert!(
            registry.add(request(endpoint, "", None)).is_err(),
            "{endpoint}"
        );
    }
    assert!(registry
        .add(request("https://8.8.8.8", "", Some(&"0".repeat(64))))
        .is_err());
    assert!(registry
        .add(request("http://127.0.0.1", "", Some(&"0".repeat(64))))
        .is_err());
    assert!(registry
        .add(request("https://127.0.0.1", "", Some("not-a-pin")))
        .is_err());
    assert!(inspect_tls("https://8.8.8.8").is_err());
    assert!(inspect_tls("http://127.0.0.1").is_err());
    assert!(inspect_tls("https://user:secret@127.0.0.1").is_err());
    // Configuration alone performs no TCP request to these synthetic private addresses.
    for endpoint in [
        "http://10.0.0.1",
        "http://172.16.0.1",
        "http://192.168.0.1",
        "http://169.254.1.1",
        "http://[fd12::1]",
        "http://[fe80::1]",
    ] {
        assert!(
            registry.add(request(endpoint, "", None)).is_ok(),
            "{endpoint}"
        );
    }
}

#[test]
fn offline_saved_lan_sources_do_not_block_startup_even_with_environment_credentials() {
    let data = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::write(data.path().join("storage.json"), serde_json::to_vec(&serde_json::json!([{
        "id":id, "name":"Offline LAN", "kind":"webdav", "endpoint":"http://offline-nebulume.invalid",
        "root":"", "bucket":null, "region":null
    }])).unwrap()).unwrap();
    let variable = format!(
        "NEBULUME_STORAGE_{}_ANONYMOUS",
        id.replace('-', "_").to_ascii_uppercase()
    );
    std::env::set_var(&variable, "1");
    let result = StorageRegistry::open(data.path());
    std::env::remove_var(&variable);
    let registry = result.unwrap();
    assert_eq!(
        registry.list()[0].endpoint,
        "http://offline-nebulume.invalid"
    );
    assert!(!registry.list()[0].connected);
    assert_eq!(registry.list()[0].credential_status, "session");
    // Actual operations retain the resolution failure instead of hiding or weakening the policy.
    assert!(read_photo(&registry, &id).is_err());
}

#[test]
fn lan_http_domain_and_ipv6_connections_work_without_following_redirects() {
    for bind in ["127.0.0.1:0", "[::1]:0"] {
        let listener = TcpListener::bind(bind).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buffer = [0u8; 4096];
            let size = stream.read(&mut buffer).unwrap();
            assert!(String::from_utf8_lossy(&buffer[..size]).starts_with("GET /photo.jpg HTTP/1.1"));
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://8.8.8.8/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let endpoint = if address.is_ipv4() {
            format!("http://localhost:{}", address.port())
        } else {
            format!("http://{address}")
        };
        let data = tempfile::tempdir().unwrap();
        let mut registry = StorageRegistry::open(data.path()).unwrap();
        let config = registry.add(request(&endpoint, "", None)).unwrap();
        let error = read_photo(&registry, &config.id).unwrap_err();
        assert!(format!("{error:#}").contains("HTTP 302"));
        server.join().unwrap();
    }
}
