use neb_storage::{AddStorageRequest, CredentialStore, CredentialStoreError, StorageRegistry};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
};
use zeroize::Zeroizing;

#[derive(Default)]
struct MockVault {
    records: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
    loads: AtomicUsize,
    writes: AtomicUsize,
    fail_load: AtomicBool,
    fail_save: AtomicBool,
    fail_delete: AtomicBool,
    ignore_delete: AtomicBool,
}
impl CredentialStore for MockVault {
    fn load(&self, key: &str) -> Result<Option<Zeroizing<Vec<u8>>>, CredentialStoreError> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        if self.fail_load.load(Ordering::SeqCst) {
            return Err(CredentialStoreError::Unavailable);
        }
        Ok(self.records.lock().unwrap().get(key).cloned())
    }
    fn save(&self, key: &str, secret: &[u8]) -> Result<(), CredentialStoreError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        if self.fail_save.load(Ordering::SeqCst) {
            return Err(CredentialStoreError::Unavailable);
        }
        self.records
            .lock()
            .unwrap()
            .insert(key.into(), Zeroizing::new(secret.to_vec()));
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), CredentialStoreError> {
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err(CredentialStoreError::Unavailable);
        }
        if !self.ignore_delete.load(Ordering::SeqCst) {
            self.records.lock().unwrap().remove(key);
        }
        Ok(())
    }
}

fn request(endpoint: &str, remember: Option<bool>) -> AddStorageRequest {
    let mut value = serde_json::json!({"name":"Synthetic DAV", "kind":"webdav", "endpoint":endpoint,
        "username":"fixture-user", "password":"fixture-pass"});
    if let Some(remember) = remember {
        value["remember_credentials"] = remember.into();
    }
    serde_json::from_value(value).unwrap()
}

fn authenticated_server(statuses: Vec<u16>) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        for status in statuses {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let size = socket.read(&mut buffer).unwrap();
                if size == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..size]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("PROPFIND / HTTP/1.1"));
            assert!(
                request.contains("Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzcw=="),
                "Expected synthetic Basic credentials"
            );
            let body = if status == 207 {
                "<d:multistatus xmlns:d=\"DAV:\"/>"
            } else {
                ""
            };
            write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    (endpoint, thread)
}

#[test]
fn default_system_storage_restores_lazily_and_check_verifies_actual_authentication() {
    let (endpoint, server) = authenticated_server(vec![207, 401]);
    let data = tempfile::tempdir().unwrap();
    let vault = Arc::new(MockVault::default());
    let mut registry =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let config = registry.add(request(&endpoint, None)).unwrap();
    assert!(config.remember_credentials);
    assert_eq!(config.credential_status, "system");
    assert!(!config.connected);
    let saved = fs::read_to_string(data.path().join("storage.json")).unwrap();
    let response = serde_json::to_string(&config).unwrap();
    for secret in ["fixture-user", "fixture-pass", "password", "secret_key"] {
        assert!(!saved.contains(secret));
        assert!(!response.contains(secret));
    }
    let loads = vault.loads.load(Ordering::SeqCst);
    drop(registry);
    let reopened = StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    assert_eq!(
        vault.loads.load(Ordering::SeqCst),
        loads,
        "Opening must not touch the vault"
    );
    assert!(!reopened.list()[0].connected);
    let result = reopened.check(&config.id).unwrap();
    assert!(result.connected);
    assert_eq!(result.credential_status, "system");
    assert!(result.error.is_none());
    assert!(reopened.list()[0].connected);
    assert_eq!(vault.loads.load(Ordering::SeqCst), loads + 1);
    let failed = reopened.check(&config.id).unwrap();
    assert!(!failed.connected);
    assert!(failed.error.unwrap().contains("401"));
    assert!(!reopened.list()[0].connected);
    assert_eq!(
        vault.loads.load(Ordering::SeqCst),
        loads + 1,
        "Restored credentials are cached in memory"
    );
    server.join().unwrap();
}

#[test]
fn session_only_credentials_do_not_write_the_vault_and_are_missing_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let vault = Arc::new(MockVault::default());
    vault.fail_load.store(true, Ordering::SeqCst);
    vault.fail_save.store(true, Ordering::SeqCst);
    let mut registry =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let mut incomplete = request("https://example.invalid", Some(false));
    incomplete.username = None;
    assert!(registry
        .add(incomplete)
        .unwrap_err()
        .to_string()
        .contains("username is required"));
    let config = registry
        .add(request("https://example.invalid", Some(false)))
        .unwrap();
    assert_eq!(config.credential_status, "session");
    assert!(!config.remember_credentials);
    let reopened = StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let result = reopened.check(&config.id).unwrap();
    assert!(!result.connected);
    assert_eq!(result.credential_status, "missing");
    assert!(result.error.unwrap().contains("Credentials are missing"));
    assert_eq!(vault.loads.load(Ordering::SeqCst), 0);
    assert_eq!(vault.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn empty_reconnect_fields_reuse_saved_s3_credentials_but_identity_changes_need_new_secrets() {
    let data = tempfile::tempdir().unwrap();
    let vault = Arc::new(MockVault::default());
    let mut registry =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let json = serde_json::json!({"name":"S3 fixture", "kind":"s3", "endpoint":"https://example.invalid", "bucket":"photos",
        "access_key":"synthetic-access", "secret_key":"synthetic-secret", "session_token":"synthetic-token"});
    let config = registry
        .add(serde_json::from_value(json.clone()).unwrap())
        .unwrap();
    let old_payload = vault
        .records
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    let mut reopened =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let mut reconnect = json.clone();
    reconnect["access_key"] = "".into();
    reconnect["secret_key"] = "".into();
    reconnect["session_token"] = "".into();
    let new = reopened
        .add(serde_json::from_value(reconnect.clone()).unwrap())
        .unwrap();
    assert_eq!(config.id, new.id);
    assert!(vault
        .records
        .lock()
        .unwrap()
        .values()
        .all(|payload| **payload == *old_payload));
    reconnect["access_key"] = "different-access".into();
    assert!(reopened
        .add(serde_json::from_value(reconnect.clone()).unwrap())
        .unwrap_err()
        .to_string()
        .contains("requires its secret key"));
    reconnect["endpoint"] = "https://different.invalid".into();
    assert!(reopened
        .add(serde_json::from_value(reconnect).unwrap())
        .is_err());
    assert_eq!(reopened.list().len(), 1);
    // Re-entering the same key pair with an omitted token keeps its existing STS token.
    let mut same_pair = json.clone();
    same_pair["session_token"] = "".into();
    reopened
        .add(serde_json::from_value(same_pair.clone()).unwrap())
        .unwrap();
    assert!(vault
        .records
        .lock()
        .unwrap()
        .values()
        .all(|payload| **payload == *old_payload));
    // A token from the old access key must not be combined with a replacement identity.
    same_pair["access_key"] = "replacement-access".into();
    same_pair["secret_key"] = "replacement-secret".into();
    reopened
        .add(serde_json::from_value(same_pair).unwrap())
        .unwrap();
    let records = vault.records.lock().unwrap();
    let payload: serde_json::Value =
        serde_json::from_slice(records.values().next().unwrap()).unwrap();
    assert!(payload["credentials"]["session_token"].is_null());
}

#[test]
fn unavailable_missing_or_corrupt_vault_records_do_not_block_startup_or_expose_bytes() {
    for failure in ["unavailable", "missing", "corrupt"] {
        let data = tempfile::tempdir().unwrap();
        let vault = Arc::new(MockVault::default());
        let mut registry =
            StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
        let config = registry
            .add(request("https://example.invalid", None))
            .unwrap();
        match failure {
            "unavailable" => vault.fail_load.store(true, Ordering::SeqCst),
            "missing" => vault.records.lock().unwrap().clear(),
            _ => vault
                .records
                .lock()
                .unwrap()
                .values_mut()
                .for_each(|secret| {
                    *secret =
                        Zeroizing::new(b"{\"password\": \"SECRET-MUST-NOT-LEAK\", invalid".to_vec())
                }),
        }
        let loads = vault.loads.load(Ordering::SeqCst);
        let reopened =
            StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
        assert_eq!(vault.loads.load(Ordering::SeqCst), loads);
        let result = reopened.check(&config.id).unwrap();
        assert!(!result.connected);
        assert_eq!(
            result.credential_status,
            if failure == "missing" {
                "missing"
            } else {
                "unavailable"
            }
        );
        assert!(!result.error.unwrap().contains("SECRET-MUST-NOT-LEAK"));
        assert!(!reopened.list()[0].connected);
    }
}

#[test]
fn explicit_persistence_failure_is_not_silently_saved_as_session_only() {
    let data = tempfile::tempdir().unwrap();
    let vault = Arc::new(MockVault::default());
    vault.fail_save.store(true, Ordering::SeqCst);
    let mut registry =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let error = registry
        .add(request("https://example.invalid", None))
        .unwrap_err();
    assert!(format!("{error:#}").contains("Cannot save credentials securely"));
    assert!(registry.list().is_empty());
    assert!(!data.path().join("storage.json").exists());
    assert!(vault.records.lock().unwrap().is_empty());
}

#[test]
fn failed_settings_publication_restores_the_previous_vault_record() {
    let data = tempfile::tempdir().unwrap();
    let vault = Arc::new(MockVault::default());
    let mut registry =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let config = registry
        .add(request("https://example.invalid", None))
        .unwrap();
    let previous = vault
        .records
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    fs::rename(
        data.path().join("storage.json"),
        data.path().join("previous.json"),
    )
    .unwrap();
    fs::create_dir(data.path().join("storage.json")).unwrap();
    let mut update = request("https://example.invalid", None);
    update.password = Some("synthetic-new-secret".into());
    assert!(registry.add(update).is_err());
    assert_eq!(registry.list()[0].id, config.id);
    assert!(vault
        .records
        .lock()
        .unwrap()
        .values()
        .all(|secret| **secret == *previous));
}

#[test]
fn removing_a_source_forgets_its_vault_record_and_survives_restart() {
    let data = tempfile::tempdir().unwrap();
    let vault = Arc::new(MockVault::default());
    let mut registry =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let removed = registry
        .add(request("https://removed.invalid", None))
        .unwrap();
    let retained = registry
        .add(request("https://retained.invalid", None))
        .unwrap();
    let original_records = vault.records.lock().unwrap().len();
    assert_eq!(registry.remove(&removed.id).unwrap().id, removed.id);
    assert_eq!(vault.records.lock().unwrap().len(), original_records - 1);
    assert_eq!(registry.list().len(), 1);
    assert_eq!(registry.list()[0].id, retained.id);
    assert!(registry.check(&removed.id).is_err());
    assert!(registry.remove(&removed.id).is_err());
    let reopened = StorageRegistry::open_with_credential_store(data.path(), vault).unwrap();
    assert_eq!(reopened.list().len(), 1);
    assert_eq!(reopened.list()[0].id, retained.id);
    let settings = fs::read_to_string(data.path().join("storage.json")).unwrap();
    assert!(!settings.contains(&removed.id));
    assert!(!settings.contains("fixture-pass"));
}

#[test]
fn removal_failure_keeps_source_and_restores_credentials() {
    for failure in ["load", "delete", "publish"] {
        let data = tempfile::tempdir().unwrap();
        let vault = Arc::new(MockVault::default());
        let mut registry =
            StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
        let config = registry
            .add(request("https://example.invalid", None))
            .unwrap();
        let prior = vault.records.lock().unwrap().clone();
        match failure {
            "load" => vault.fail_load.store(true, Ordering::SeqCst),
            "delete" => vault.fail_delete.store(true, Ordering::SeqCst),
            _ => {
                fs::rename(
                    data.path().join("storage.json"),
                    data.path().join("before.json"),
                )
                .unwrap();
                fs::create_dir(data.path().join("storage.json")).unwrap();
            }
        }
        assert!(registry.remove(&config.id).is_err(), "{failure}");
        assert_eq!(registry.list()[0].id, config.id);
        assert_eq!(*vault.records.lock().unwrap(), prior);
        if failure != "publish" {
            let reopened = StorageRegistry::open_with_credential_store(data.path(), vault).unwrap();
            assert_eq!(reopened.list()[0].id, config.id);
        }
    }
}

#[test]
fn removal_verifies_vault_deletion_and_reports_failed_rollback() {
    for failure in ["silent-delete", "rollback"] {
        let data = tempfile::tempdir().unwrap();
        let vault = Arc::new(MockVault::default());
        let mut registry =
            StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
        let config = registry
            .add(request("https://example.invalid", None))
            .unwrap();
        if failure == "silent-delete" {
            vault.ignore_delete.store(true, Ordering::SeqCst);
        } else {
            fs::rename(
                data.path().join("storage.json"),
                data.path().join("before.json"),
            )
            .unwrap();
            fs::create_dir(data.path().join("storage.json")).unwrap();
            vault.fail_save.store(true, Ordering::SeqCst);
        }
        let error = format!("{:#}", registry.remove(&config.id).unwrap_err());
        assert_eq!(registry.list()[0].id, config.id);
        if failure == "silent-delete" {
            assert!(error.contains("did not remove"));
            assert_eq!(vault.records.lock().unwrap().len(), 1);
        } else {
            assert!(error.contains("could not be restored; re-enter credentials"));
            assert!(vault.records.lock().unwrap().is_empty());
        }
        assert!(!error.contains("fixture-pass"));
    }
}

#[test]
fn removing_local_and_session_sources_never_contacts_vault_or_deletes_files() {
    let data = tempfile::tempdir().unwrap();
    let photos = tempfile::tempdir().unwrap();
    let original = photos.path().join("retained.jpg");
    fs::write(&original, b"immutable synthetic original").unwrap();
    let vault = Arc::new(MockVault::default());
    vault.fail_load.store(true, Ordering::SeqCst);
    vault.fail_delete.store(true, Ordering::SeqCst);
    let mut registry =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let local = registry
        .add(
            serde_json::from_value(serde_json::json!({
                "name":"Local fixture", "kind":"local", "endpoint":photos.path()
            }))
            .unwrap(),
        )
        .unwrap();
    let session = registry
        .add(request("https://session.invalid", Some(false)))
        .unwrap();
    registry.remove(&local.id).unwrap();
    registry.remove(&session.id).unwrap();
    assert!(registry.list().is_empty());
    assert_eq!(fs::read(original).unwrap(), b"immutable synthetic original");
    assert_eq!(vault.loads.load(Ordering::SeqCst), 0);
    assert_eq!(vault.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn disabling_remember_deletes_the_system_record_and_preserves_only_the_current_session() {
    let (endpoint, server) = authenticated_server(vec![207]);
    let data = tempfile::tempdir().unwrap();
    let vault = Arc::new(MockVault::default());
    let mut registry =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    registry.add(request(&endpoint, None)).unwrap();
    let mut update = request(&endpoint, Some(false));
    update.username = None;
    update.password = None;
    vault.fail_delete.store(true, Ordering::SeqCst);
    assert!(registry.add(serde_json::from_value(serde_json::json!({"name":"Fixture", "kind":"webdav", "endpoint":endpoint, "remember_credentials":false})).unwrap()).is_err());
    assert!(registry.list()[0].remember_credentials);
    vault.fail_delete.store(false, Ordering::SeqCst);
    let config = registry.add(update).unwrap();
    assert!(!config.remember_credentials);
    assert_eq!(config.credential_status, "session");
    assert!(vault.records.lock().unwrap().is_empty());
    assert!(registry.check(&config.id).unwrap().connected);
    server.join().unwrap();
    let reopened = StorageRegistry::open_with_credential_store(data.path(), vault).unwrap();
    assert_eq!(
        reopened.check(&config.id).unwrap().credential_status,
        "missing"
    );
}

#[test]
fn credential_identity_is_bound_to_profile_and_source_location() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let vault = Arc::new(MockVault::default());
    let mut registry =
        StorageRegistry::open_with_credential_store(first.path(), vault.clone()).unwrap();
    let config = registry
        .add(request("https://example.invalid", None))
        .unwrap();
    fs::copy(
        first.path().join("storage.json"),
        second.path().join("storage.json"),
    )
    .unwrap();
    let copied = StorageRegistry::open_with_credential_store(second.path(), vault.clone()).unwrap();
    assert_eq!(
        copied.check(&config.id).unwrap().credential_status,
        "missing"
    );
    let mut changed: serde_json::Value =
        serde_json::from_slice(&fs::read(first.path().join("storage.json")).unwrap()).unwrap();
    changed[0]["endpoint"] = "https://different.invalid".into();
    fs::write(
        first.path().join("storage.json"),
        serde_json::to_vec(&changed).unwrap(),
    )
    .unwrap();
    let tampered = StorageRegistry::open_with_credential_store(first.path(), vault).unwrap();
    assert_eq!(
        tampered.check(&config.id).unwrap().credential_status,
        "missing"
    );
}

#[test]
fn environment_credentials_override_a_locked_vault_without_being_saved() {
    let (endpoint, server) = authenticated_server(vec![207]);
    let data = tempfile::tempdir().unwrap();
    let vault = Arc::new(MockVault::default());
    let mut registry =
        StorageRegistry::open_with_credential_store(data.path(), vault.clone()).unwrap();
    let config = registry.add(request(&endpoint, None)).unwrap();
    vault.fail_load.store(true, Ordering::SeqCst);
    let prefix = format!(
        "NEBULUME_STORAGE_{}_",
        config.id.replace('-', "_").to_ascii_uppercase()
    );
    std::env::set_var(format!("{prefix}USERNAME"), "fixture-user");
    std::env::set_var(format!("{prefix}PASSWORD"), "fixture-pass");
    let reopened = StorageRegistry::open_with_credential_store(data.path(), vault.clone());
    std::env::remove_var(format!("{prefix}USERNAME"));
    std::env::remove_var(format!("{prefix}PASSWORD"));
    let reopened = reopened.unwrap();
    let writes = vault.writes.load(Ordering::SeqCst);
    let result = reopened.check(&config.id).unwrap();
    assert!(result.connected);
    assert_eq!(result.credential_status, "session");
    assert_eq!(vault.writes.load(Ordering::SeqCst), writes);
    server.join().unwrap();
}
