use clap::{Parser, Subcommand};
use neb_core::PreviewTier;
use neb_service::{CommandError, Service};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(
    name = "neb",
    version,
    about = "Nebulume headless photo catalog and verified import commands"
)]
struct Cli {
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[command(subcommand)]
    action: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Run a version 1 command (see docs/API.md).
    Run {
        command: String,
        #[arg(long, default_value = "{}")]
        json: String,
    },
    /// Report runtime capabilities.
    Info,
    /// Keep one local command session over newline-delimited JSON stdin/stdout.
    /// Each input is {"id":...,"command":"...","params":{...}}. No network listener.
    Stdio,
    /// Write one preview tier (t256, t512, t1024, p2560) as JPEG, the same
    /// bytes the desktop `neb` protocol serves.
    Preview {
        #[arg(long)]
        id: String,
        #[arg(long)]
        tier: String,
        #[arg(long)]
        uncropped: bool,
        #[arg(long)]
        out: PathBuf,
    },
}

/// Renders (or reads from cache) one preview tier and writes its JPEG bytes.
fn write_preview(
    service: &Service,
    id: &str,
    tier: &str,
    uncropped: bool,
    out: &Path,
) -> Result<(), CommandError> {
    let tier = PreviewTier::parse(tier).ok_or_else(|| CommandError {
        code: "E_INVALID",
        message: format!("E_INVALID: Unknown preview tier {tier}"),
    })?;
    let image = service.preview_image(id, tier, uncropped)?;
    fs::write(out, &image.jpeg).map_err(|error| CommandError {
        code: "E_OPERATION",
        message: format!("Cannot write {}: {error}", out.display()),
    })
}
fn main() {
    // Image decoders can exceed the Windows executable's default stack in debug
    // builds. Give the command session an explicit, platform-independent budget.
    let result = std::thread::Builder::new()
        .name("neb-command-session".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(run)
        .map_err(anyhow::Error::from)
        .and_then(|thread| {
            thread
                .join()
                .map_err(|_| anyhow::anyhow!("Command session terminated unexpectedly"))?
        });
    if let Err(error) = result {
        eprintln!(
            "{}",
            json!({"code":"E_CLI", "message":format!("{error:#}")})
        );
        std::process::exit(1);
    }
}
fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let data_dir = cli
        .data_dir
        .or_else(|| dirs::data_local_dir().map(|d| d.join("app.nebulume.desktop")))
        .ok_or_else(|| anyhow::anyhow!("No application data directory; provide --data-dir"))?;
    let service = Service::open(data_dir)?;
    if matches!(cli.action, Action::Stdio) {
        let stdin = io::stdin();
        let mut stdout = io::stdout().lock();
        for line in stdin.lock().lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let response = match serde_json::from_str::<Value>(&line) {
                Ok(request) => {
                    let id = request.get("id").cloned().unwrap_or(Value::Null);
                    match request.get("command").and_then(Value::as_str) {
                        Some(command) => match service.execute(
                            command,
                            request.get("params").cloned().unwrap_or_else(|| json!({})),
                        ) {
                            Ok(result) => json!({"id":id,"result":result}),
                            Err(error) => json!({"id":id,"error":error}),
                        },
                        None => {
                            json!({"id":id,"error":{"code":"E_INVALID_PARAMS","message":"command is required"}})
                        }
                    }
                }
                Err(_) => {
                    json!({"id":null,"error":{"code":"E_INVALID_JSON","message":"Input must be one JSON object per line"}})
                }
            };
            writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
            stdout.flush()?;
        }
        return Ok(());
    }
    if let Action::Preview {
        id,
        tier,
        uncropped,
        out,
    } = &cli.action
    {
        if let Err(error) = write_preview(&service, id, tier, *uncropped, out) {
            eprintln!("{}", serde_json::to_string(&error)?);
            std::process::exit(1);
        }
        return Ok(());
    }
    let (command, params) = match cli.action {
        Action::Run { command, json } => (command, serde_json::from_str::<Value>(&json)?),
        Action::Info => ("system.info".into(), json!({})),
        Action::Stdio | Action::Preview { .. } => unreachable!(),
    };
    match service.execute(&command, params) {
        Ok(result) => println!("{}", serde_json::to_string_pretty(&result)?),
        Err(error) => {
            eprintln!("{}", serde_json::to_string(&error)?);
            std::process::exit(1);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ppm(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = format!("P6\n{width} {height}\n255\n").into_bytes();
        for y in 0..height {
            for x in 0..width {
                bytes.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 90]);
            }
        }
        bytes
    }

    #[test]
    fn preview_writes_jpeg_from_a_local_library() {
        let data = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let photos = tempfile::tempdir().unwrap();
        let service = Service::open(data.path()).unwrap();
        // A real JPEG, produced by the service from a synthetic PPM.
        let source = scratch.path().join("source.ppm");
        fs::write(&source, ppm(600, 300)).unwrap();
        let opened = service
            .execute("file.open", json!({"path":source}))
            .unwrap();
        let jpeg = service
            .preview_image(opened["id"].as_str().unwrap(), PreviewTier::T1024, false)
            .unwrap()
            .jpeg
            .clone();
        fs::write(photos.path().join("photo.jpg"), jpeg).unwrap();
        let library = service
            .execute("library.add", json!({"name":"Local","root":photos.path()}))
            .unwrap();
        service
            .execute("library.scan", json!({"library_id":library["id"]}))
            .unwrap();
        let assets = service
            .execute("asset.list", json!({"library_id":library["id"]}))
            .unwrap();
        let id = assets["items"][0]["id"].as_str().unwrap();

        let out = scratch.path().join("out.jpg");
        write_preview(&service, id, "t512", false, &out).unwrap();
        let bytes = fs::read(&out).unwrap();
        assert!(bytes.starts_with(&[0xFF, 0xD8]));

        let invalid = write_preview(&service, id, "t9999", false, &out).unwrap_err();
        assert_eq!(invalid.code, "E_INVALID");
        let missing = write_preview(&service, "0000-missing", "t512", false, &out).unwrap_err();
        assert_eq!(missing.code, "E_NOT_FOUND");
    }
}
