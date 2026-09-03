use gitgui_server::{run, ConfigError, ServerConfig, BOOTSTRAP_STDIN_ENV};
use std::io::{BufRead, Read};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "Usage: gitgui-server [--bind <ip>] [--port <port>] [--data-dir <path> | --ephemeral] [--web-dir <path>] [--repository <path>]...\n\nOptions: --data-dir <path> (override persistent environment state location)\n         --ephemeral (do not persist environment identity or repository catalog)\n         --web-dir <path> (serve the compiled SvelteKit app from this directory)\n         --repository <path> (repeatable; --repo is an alias)\nDefaults: --bind 127.0.0.1 --port 0; persistent per-user state; auto-detects ./build/index.html\nEnvironment: GITGUI_SERVER_BIND, GITGUI_SERVER_PORT, GITGUI_SERVER_DATA_DIR, GITGUI_SERVER_WEB_DIR, GITGUI_SERVER_BOOTSTRAP_TOKEN, GITGUI_SERVER_ALLOWED_ORIGINS, GITGUI_SERVER_ADDITIONAL_ORIGINS, GITGUI_SERVER_DEV_URL";

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let mut config = match ServerConfig::from_env_and_args(std::env::args()) {
        Ok(config) => config,
        Err(ConfigError::HelpRequested) => {
            println!("{USAGE}");
            return;
        }
        Err(ConfigError::VersionRequested) => {
            println!("gitgui-server {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Err(error) => {
            eprintln!("gitgui-server configuration error: {error}\n\n{USAGE}");
            std::process::exit(2);
        }
    };

    if std::env::var(BOOTSTRAP_STDIN_ENV).as_deref() == Ok("1") {
        match read_bootstrap_from_stdin() {
            Ok(token) => config.bootstrap_token = Some(token),
            Err(error) => {
                eprintln!("gitgui-server bootstrap input error: {error}");
                std::process::exit(2);
            }
        }
    }

    if let Err(error) = run(config).await {
        tracing::error!(error = %error, "GitGui server stopped with an error");
        std::process::exit(1);
    }
}

fn read_bootstrap_from_stdin() -> Result<String, String> {
    let mut token = String::new();
    std::io::stdin()
        .lock()
        .take(16 * 1024)
        .read_line(&mut token)
        .map_err(|error| format!("could not read inherited bootstrap pipe: {error}"))?;
    let token = token.trim_end_matches(['\r', '\n']);
    if token.is_empty() || token.chars().any(char::is_control) {
        return Err("inherited bootstrap credential was empty or malformed".to_string());
    }
    Ok(token.to_string())
}
