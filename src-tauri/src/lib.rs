//! Postgly — Tauri application entry point.

// The driver trait carries a `QueryResult` DTO and an `execute` method
// that the SQL-runner commands only start calling in Phase 3. Suppress
// dead-code noise for that scaffolding until those call sites land.
#![allow(dead_code)]

mod commands;
mod connections;
mod db;
mod error;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::test_connection,
            commands::explorer::open_connection,
            commands::explorer::close_connection,
            commands::explorer::list_schemas,
            commands::explorer::list_tables,
            commands::explorer::describe_table,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
