//! Verify a release package with the same public-key signature check as Tauri's
//! updater, without starting the application or opening any user data.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{error::Error, fs, path::Path};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn verify_bytes(bytes: &[u8], public_key: &str, signature: &str) -> Result<()> {
    let public_key_text = String::from_utf8(STANDARD.decode(public_key)?)?;
    let signature_text = String::from_utf8(STANDARD.decode(signature.trim())?)?;
    let public_key = PublicKey::decode(&public_key_text)?;
    let signature = Signature::decode(&signature_text)?;
    // Matches tauri-plugin-updater's verify_signature: permit legacy signatures
    // and verify the global signature protecting the trusted comment as well.
    public_key.verify(bytes, &signature, true)?;
    Ok(())
}

fn verify_files(installer: &Path, signature: &Path, config: &Path) -> Result<()> {
    let config: serde_json::Value = serde_json::from_slice(&fs::read(config)?)?;
    let public_key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .filter(|key| !key.is_empty())
        .ok_or("Configuration is missing plugins.updater.pubkey")?;
    verify_bytes(
        &fs::read(installer)?,
        public_key,
        &fs::read_to_string(signature)?,
    )
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err("Usage: verify_update <installer> <installer.sig> <tauri.conf.json>".into());
    }
    verify_files(
        Path::new(&args[0]),
        Path::new(&args[1]),
        Path::new(&args[2]),
    )?;
    println!("Installer signature matches the configured updater public key");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public test vector from minisign-verify 0.3.0; no private signing key.
    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    #[test]
    fn verifies_public_prehashed_fixture_and_rejects_changed_installer() {
        let public_key = STANDARD.encode(PUBLIC_KEY);
        let signature = STANDARD.encode(SIGNATURE);
        verify_bytes(b"test", &public_key, &signature).unwrap();
        assert!(verify_bytes(b"Test", &public_key, &signature).is_err());
    }

    #[test]
    fn rejects_wrong_public_key_and_changed_trusted_comment() {
        let mut wrong_key = STANDARD
            .decode("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")
            .unwrap();
        // Keep the algorithm and key ID; alter the actual Ed25519 public key.
        wrong_key[10] ^= 1;
        let wrong_key_text = format!(
            "untrusted comment: wrong public key\n{}",
            STANDARD.encode(wrong_key)
        );
        assert!(verify_bytes(
            b"test",
            &STANDARD.encode(wrong_key_text),
            &STANDARD.encode(SIGNATURE)
        )
        .is_err());
        assert!(verify_bytes(
            b"test",
            &STANDARD.encode(PUBLIC_KEY),
            &STANDARD.encode(SIGNATURE.replace("file:test", "file:other"))
        )
        .is_err());
    }

    #[test]
    fn rejects_malformed_outer_base64_and_inner_signature() {
        let public_key = STANDARD.encode(PUBLIC_KEY);
        let signature = STANDARD.encode(SIGNATURE);
        assert!(verify_bytes(b"test", "not base64!", &signature).is_err());
        assert!(verify_bytes(b"test", &public_key, "not base64!").is_err());
        assert!(verify_bytes(b"test", &public_key, &STANDARD.encode("not minisign")).is_err());
    }

    #[test]
    fn reads_public_config_and_detached_signature_files() {
        let directory = tempfile::tempdir().unwrap();
        let installer = directory.path().join("installer.exe");
        let signature = directory.path().join("installer.exe.sig");
        let config = directory.path().join("tauri.conf.json");
        fs::write(&installer, b"test").unwrap();
        fs::write(&signature, format!("{}\n", STANDARD.encode(SIGNATURE))).unwrap();
        fs::write(
            &config,
            serde_json::to_vec(&serde_json::json!({
                "plugins": {"updater": {"pubkey": STANDARD.encode(PUBLIC_KEY)}}
            }))
            .unwrap(),
        )
        .unwrap();
        verify_files(&installer, &signature, &config).unwrap();
        fs::write(&config, b"{}").unwrap();
        assert!(verify_files(&installer, &signature, &config).is_err());
    }
}
