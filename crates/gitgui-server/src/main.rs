use gitgui_server::{run, ConfigError, ServerConfig};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "Usage: gitgui-server [--bind <ip>] [--port <port>] [--data-dir <path>] [--web-dir <path>] [--repository <path>]...\n\nOptions: --data-dir <path> (persist host identity and repository catalog)\n         --web-dir <path> (serve the compiled SvelteKit app from this directory)\n         --repository <path> (repeatable; --repo is an alias)\nDefaults: --bind 127.0.0.1 --port 0 (ephemeral port); auto-detects ./build/index.html\nEnvironment: GITGUI_SERVER_BIND, GITGUI_SERVER_PORT, GITGUI_SERVER_DATA_DIR, GITGUI_SERVER_WEB_DIR, GITGUI_SERVER_BOOTSTRAP_TOKEN, GITGUI_SERVER_ALLOWED_ORIGINS, GITGUI_SERVER_ADDITIONAL_ORIGINS";

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let config = match ServerConfig::from_env_and_args(std::env::args()) {
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

    if let Err(error) = run(config).await {
        tracing::error!(error = %error, "GitGui server stopped with an error");
        std::process::exit(1);
    }
}
