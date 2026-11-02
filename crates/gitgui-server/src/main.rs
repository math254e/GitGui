use gitgui_server::{
    local_control, run, run_with_control, ConfigError, ServerConfig, BOOTSTRAP_STDIN_ENV,
};
use std::io::BufRead;
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

    let bootstrap_stdin = std::env::var(BOOTSTRAP_STDIN_ENV).as_deref() == Ok("1");
    let desktop_control =
        bootstrap_stdin && std::env::var(local_control::DESKTOP_CONTROL_ENV).as_deref() == Ok("1");
    let mut control = None;
    if bootstrap_stdin {
        let token = if desktop_control {
            let (bootstrap_tx, bootstrap_rx) = std::sync::mpsc::sync_channel(1);
            let (control_tx, control_rx) = tokio::sync::mpsc::channel(16);
            std::thread::spawn(move || {
                // Keep this exact buffered reader for bootstrap AND commands.
                let stdin = std::io::stdin();
                let mut reader = stdin.lock();
                let token = read_bootstrap(&mut reader);
                let valid = token.is_ok();
                if bootstrap_tx.send(token).is_ok() && valid {
                    local_control::read_input(reader, control_tx);
                }
            });
            control = Some(control_rx);
            bootstrap_rx
                .recv()
                .unwrap_or_else(|_| Err("bootstrap reader stopped".into()))
        } else {
            read_bootstrap(&mut std::io::stdin().lock())
        };
        match token {
            Ok(token) => config.bootstrap_token = Some(token),
            Err(error) => {
                eprintln!("gitgui-server bootstrap input error: {error}");
                std::process::exit(2);
            }
        }
    }

    let result = match control {
        Some(input) => run_with_control(config, input).await,
        None => run(config).await,
    };
    if let Err(error) = result {
        tracing::error!(error = %error, "GitGui server stopped with an error");
        std::process::exit(1);
    }
}

fn read_bootstrap(reader: &mut impl BufRead) -> Result<String, String> {
    let line = local_control::read_line(reader, 16 * 1024)
        .map_err(|_| "could not read inherited bootstrap pipe".to_string())?
        .ok_or("inherited bootstrap credential was empty or malformed")?;
    let token = std::str::from_utf8(&line)
        .map_err(|_| "inherited bootstrap credential was malformed")?
        .trim_end_matches(['\r', '\n']);
    if token.is_empty() || token.chars().any(char::is_control) {
        return Err("inherited bootstrap credential was empty or malformed".to_string());
    }
    Ok(token.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_and_pipelined_control_share_read_ahead_and_invalid_bootstrap_is_bounded() {
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(
            b"private-bootstrap\n{\"id\":\"p\",\"command\":\"prepare-update\"}\n",
        ));
        assert_eq!(read_bootstrap(&mut reader).unwrap(), "private-bootstrap");
        assert_eq!(
            local_control::read_line(&mut reader, 4096)
                .unwrap()
                .unwrap(),
            b"{\"id\":\"p\",\"command\":\"prepare-update\"}\n"
        );
        assert!(read_bootstrap(&mut std::io::Cursor::new(vec![b'x'; 17 * 1024])).is_err());
    }
}
