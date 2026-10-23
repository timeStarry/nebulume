//! Memory-card identity and import presets. The only write this module makes to
//! removable media is the small identity file, and only on explicit registration
//! or binding; photos on the card are never modified.
use anyhow::{bail, ensure, Context, Result};
use neb_core::{CardIdentity, Core};
use neb_storage::atomic_json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub const IDENTITY_DIR: &str = ".nebulume";
pub const IDENTITY_FILE: &str = "volume.json";
const IDENTITY_LIMIT: u64 = 4096;

#[derive(Serialize, Deserialize)]
struct IdentityFile {
    /// Format marker so foreign files with the same name are not trusted.
    nebulume_volume: u32,
    id: String,
}

/// Read a card's identity file. Missing, oversized or foreign files mean "unknown".
pub fn read_identity(mount: &Path) -> Option<String> {
    let path = mount.join(IDENTITY_DIR).join(IDENTITY_FILE);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > IDENTITY_LIMIT {
        return None;
    }
    let parsed: IdentityFile = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (parsed.nebulume_volume == 1 && uuid_like(&parsed.id)).then_some(parsed.id)
}

fn write_identity(mount: &Path, id: &str) -> Result<()> {
    let dir = mount.join(IDENTITY_DIR);
    if let Ok(metadata) = fs::symlink_metadata(&dir) {
        ensure!(
            metadata.is_dir(),
            "E_CONFLICT: The card has a non-folder .nebulume entry; identity was not written"
        );
    }
    atomic_json(
        &dir.join(IDENTITY_FILE),
        &IdentityFile {
            nebulume_volume: 1,
            id: id.to_owned(),
        },
    )
    .context("E_IO: Cannot write the card identity file; the card may be write-protected")?;
    // Read back so a silently read-only card is reported, not trusted.
    ensure!(
        read_identity(mount).as_deref() == Some(id),
        "E_IO: The card did not keep its identity file"
    );
    Ok(())
}

fn uuid_like(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            matches!(i, 8 | 13 | 18 | 23) == (c == '-') && (c == '-' || c.is_ascii_hexdigit())
        })
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn mount_dir(identity: &CardIdentity) -> Result<&Path> {
    let path = Path::new(&identity.mount_path);
    ensure!(
        path.is_absolute() && path.is_dir(),
        "E_OFFLINE: The card is not mounted at this path"
    );
    Ok(path)
}

fn identity_of(params: &Value) -> Result<CardIdentity> {
    serde_json::from_value(params.clone()).context("E_INVALID: Missing card mount information")
}

/// `card.identify {mount_path, volume_label?, volume_serial?, capacity_bytes?}`:
/// read-only; reports a known card, or hints for binding an unidentified one.
pub fn identify(core: &Core, params: &Value) -> Result<Value> {
    let identity = identity_of(params)?;
    let mount = mount_dir(&identity)?;
    if let Some(id) = read_identity(mount) {
        if let Ok(card) = core.card_seen(&id, &identity) {
            return Ok(json!({"status":"known","card":card}));
        }
        // An identity from another catalog (or a removed record): offer binding.
        return Ok(
            json!({"status":"foreign","identity_id":id,"candidates":core.card_candidates(&identity)?}),
        );
    }
    Ok(json!({"status":"unknown","candidates":core.card_candidates(&identity)?}))
}

/// `card.register {mount_path, name, ...}` writes a new identity and creates the record.
pub fn register(core: &Core, params: &Value) -> Result<Value> {
    let identity = identity_of(params)?;
    let mount = mount_dir(&identity)?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .context("E_INVALID: Card name is required")?;
    if let Some(existing) = read_identity(mount) {
        if core.card(&existing).is_ok() {
            bail!("E_CONFLICT: This card is already registered");
        }
    }
    let id = new_id();
    write_identity(mount, &id)?;
    Ok(serde_json::to_value(
        core.register_card(&id, name, &identity)?,
    )?)
}

/// `card.bind {mount_path, card_id, ...}` makes this volume an existing card, e.g.
/// after formatting. The user chose the record; nothing is bound automatically.
pub fn bind(core: &Core, params: &Value) -> Result<Value> {
    let identity = identity_of(params)?;
    let mount = mount_dir(&identity)?;
    let card_id = params
        .get("card_id")
        .and_then(Value::as_str)
        .context("E_INVALID: card_id is required")?;
    core.card(card_id)?;
    write_identity(mount, card_id)?;
    Ok(serde_json::to_value(core.card_seen(card_id, &identity)?)?)
}

pub fn update(core: &Core, params: &Value) -> Result<Value> {
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .context("E_INVALID: Card id is required")?;
    let preset = match params.get("default_preset_id") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value.as_str())),
        Some(_) => bail!("E_INVALID: default_preset_id must be a string or null"),
    };
    Ok(serde_json::to_value(core.update_card(
        id,
        params.get("name").and_then(Value::as_str),
        preset,
    )?)?)
}

/// `preset.save {id?, name, library_id, rules, deduplicate?}`; rules are validated
/// by neb-ingest so a stored preset can always produce a plan.
pub fn save_preset(core: &Core, params: &Value) -> Result<Value> {
    let rules = params.get("rules").cloned().unwrap_or(Value::Null);
    let parsed: neb_ingest::OrganizeRules = serde_json::from_value(rules.clone())
        .context("E_INVALID: Invalid import organization rules")?;
    parsed
        .validate()
        .map_err(|error| anyhow::anyhow!("E_INVALID: {error}"))?;
    let library = params
        .get("library_id")
        .and_then(Value::as_str)
        .context("E_INVALID: library_id is required")?;
    Ok(serde_json::to_value(
        core.save_import_preset(
            params.get("id").and_then(Value::as_str),
            params.get("name").and_then(Value::as_str).unwrap_or(""),
            library,
            &serde_json::to_value(parsed)?,
            params
                .get("deduplicate")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        )?,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_ids_are_uuid_shaped_and_foreign_files_are_ignored() {
        let id = new_id();
        assert!(uuid_like(&id), "{id}");
        assert_ne!(new_id(), id);
        let card = tempfile::tempdir().unwrap();
        assert!(read_identity(card.path()).is_none());
        fs::create_dir(card.path().join(IDENTITY_DIR)).unwrap();
        fs::write(
            card.path().join(IDENTITY_DIR).join(IDENTITY_FILE),
            br#"{"id":"not-ours"}"#,
        )
        .unwrap();
        assert!(read_identity(card.path()).is_none());
        write_identity(card.path(), &id).unwrap();
        assert_eq!(read_identity(card.path()).as_deref(), Some(id.as_str()));
    }
}
