mod server_manager;

use tauri::{Manager, State};

#[tauri::command]
fn get_local_server_connection(
    state: State<'_, server_manager::SharedLocalServerManager>,
) -> Result<server_manager::LocalServerConnection, String> {
    server_manager::connection_shared(state.inner())
}

#[tauri::command]
fn restart_local_server(
    state: State<'_, server_manager::SharedLocalServerManager>,
) -> Result<server_manager::LocalServerConnection, String> {
    server_manager::restart_shared(state.inner())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(server_manager::new_shared())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let manager = app.state::<server_manager::SharedLocalServerManager>();
            let app_data_dir = app.path().app_data_dir().map_err(|error| {
                std::io::Error::other(format!(
                    "failed to locate app data directory for the local server: {error}"
                ))
            })?;

            server_manager::configure_shared(manager.inner(), app_data_dir.join("server"))
                .map_err(std::io::Error::other)?;

            if let Err(error) = server_manager::start_shared(manager.inner()) {
                eprintln!("[gitgui] local server startup failed: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_local_server_connection,
            restart_local_server,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                let manager = app_handle.state::<server_manager::SharedLocalServerManager>();
                if let Err(error) = server_manager::shutdown_shared(manager.inner()) {
                    eprintln!("[gitgui] local server shutdown failed: {error}");
                }
            }
        });
}
