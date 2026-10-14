//! Shared application commands for the native desktop and headless CLI.
use anyhow::{anyhow, Context, Result};
use neb_core::Core;
use neb_ingest::IngestService;
use neb_storage::{AddStorageRequest, StorageRegistry};
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};

pub struct Service {
    core: Core,
    storage: Mutex<StorageRegistry>,
    ingest: Mutex<IngestService>,
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<anyhow::Error> for CommandError {
    fn from(error: anyhow::Error) -> Self {
        let message = format!("{error:#}");
        let code = [
            "E_INVALID",
            "E_OFFLINE",
            "E_LIMIT",
            "E_UNSUPPORTED_CODEC",
            "E_NOT_FOUND",
            "E_CONFLICT",
        ]
        .into_iter()
        .find(|code| message.starts_with(code))
        .unwrap_or("E_OPERATION");
        Self { code, message }
    }
}

fn string<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| anyhow!("Missing or invalid parameter: {name}"))
}

impl Service {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        let data_dir = data_dir.as_ref();
        std::fs::create_dir_all(data_dir).context("Create application data directory")?;
        Ok(Self {
            core: Core::open(data_dir.join("catalog"))?,
            storage: Mutex::new(StorageRegistry::open(data_dir.join("storage"))?),
            ingest: Mutex::new(IngestService::open(data_dir.join("ingest"))?),
        })
    }

    pub fn execute(&self, command: &str, params: Value) -> Result<Value, CommandError> {
        if !params.is_object() {
            return Err(CommandError {
                code: "E_INVALID_PARAMS",
                message: "params must be a JSON object".into(),
            });
        }
        self.dispatch(command, params).map_err(Into::into)
    }

    fn dispatch(&self, command: &str, params: Value) -> Result<Value> {
        if command.starts_with("library.") || command.starts_with("asset.") {
            return self.core.dispatch(command, params);
        }
        match command {
            "system.info" => Ok(json!({
                "name": "Nebulume", "version": env!("CARGO_PKG_VERSION"), "api_version": 1,
                "platform": std::env::consts::OS,
                "storage": ["local", "webdav", "s3"],
                "storage_transport": {"lan_http": true, "tls": ["public_ca", "lan_certificate_sha256"]},
                "originals_read_only": true,
                "credentials": "session_only",
                "imaging": neb_core::capabilities(),
                "limits": ["Alpha: remote sources browse/download into local libraries", "No source deletion", "Basic RAW rendering; not a color-managed developing suite"]
            })),
            "storage.list" => {
                let storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                Ok(serde_json::to_value(storage.list())?)
            }
            "storage.add" => {
                let request: AddStorageRequest =
                    serde_json::from_value(params).context("Invalid storage configuration")?;
                let mut storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                Ok(serde_json::to_value(storage.add(request)?)?)
            }
            "storage.inspect_tls" => Ok(serde_json::to_value(neb_storage::inspect_tls(string(
                &params, "endpoint",
            )?)?)?),
            "storage.browse" => {
                let storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(200)
                    .clamp(1, 1000) as usize;
                Ok(serde_json::to_value(storage.browse(
                    string(&params, "id")?,
                    params.get("prefix").and_then(Value::as_str).unwrap_or(""),
                    limit,
                    params.get("cursor").and_then(Value::as_str),
                )?)?)
            }
            "storage.fetch" => {
                let storage = self
                    .storage
                    .lock()
                    .map_err(|_| anyhow!("Storage state unavailable"))?;
                Ok(serde_json::to_value(storage.fetch(
                    string(&params, "id")?,
                    string(&params, "key")?,
                    string(&params, "destination")?,
                )?)?)
            }
            "import.plan" => {
                let mut ingest = self
                    .ingest
                    .lock()
                    .map_err(|_| anyhow!("Import state unavailable"))?;
                Ok(serde_json::to_value(
                    ingest.plan(
                        string(&params, "source")?,
                        string(&params, "destination")?,
                        params
                            .get("layout")
                            .and_then(Value::as_str)
                            .unwrap_or("preserve"),
                        params
                            .get("deduplicate")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                    )?,
                )?)
            }
            "import.execute" => {
                let mut ingest = self
                    .ingest
                    .lock()
                    .map_err(|_| anyhow!("Import state unavailable"))?;
                Ok(serde_json::to_value(
                    ingest.execute(string(&params, "plan_id")?)?,
                )?)
            }
            "import.history" => {
                let ingest = self
                    .ingest
                    .lock()
                    .map_err(|_| anyhow!("Import state unavailable"))?;
                Ok(serde_json::to_value(ingest.history()?)?)
            }
            _ => Err(anyhow!("Unknown command: {command}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_service_rejects_invalid_and_unknown_commands() {
        let dir = tempfile::tempdir().unwrap();
        let svc = Service::open(dir.path()).unwrap();
        assert_eq!(
            svc.execute("system.info", json!([])).unwrap_err().code,
            "E_INVALID_PARAMS"
        );
        assert!(svc.execute("secret.delete_everything", json!({})).is_err());
        assert!(svc.execute("import.plan", json!({"source": ""})).is_err());
        assert!(svc
            .execute("storage.inspect_tls", json!({"endpoint": ""}))
            .is_err());
        assert!(svc
            .execute(
                "storage.inspect_tls",
                json!({"endpoint": "http://127.0.0.1"})
            )
            .is_err());
        assert_eq!(
            svc.execute("system.info", json!({})).unwrap()["api_version"],
            1
        );
    }
    #[test]
    fn library_survives_shared_service_restart() {
        let dir = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let id;
        {
            let svc = Service::open(dir.path()).unwrap();
            id = svc
                .execute(
                    "library.add",
                    json!({"name":"测试图库", "root":source.path()}),
                )
                .unwrap()["id"]
                .clone();
        }
        let svc = Service::open(dir.path()).unwrap();
        let libraries = svc.execute("library.list", json!({})).unwrap();
        assert_eq!(libraries[0]["id"], id);
    }
}
