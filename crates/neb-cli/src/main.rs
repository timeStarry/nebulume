use clap::{Parser, Subcommand};
use neb_service::Service;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
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
}
fn main() {
    if let Err(error) = run() {
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
    let (command, params) = match cli.action {
        Action::Run { command, json } => (command, serde_json::from_str::<Value>(&json)?),
        Action::Info => ("system.info".into(), json!({})),
        Action::Stdio => unreachable!(),
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
