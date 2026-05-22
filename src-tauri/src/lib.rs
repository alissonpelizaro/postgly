//! Postgly — Tauri application entry point.

// The driver trait carries DTOs and methods (schemas, tables, queries)
// that the explorer commands only start calling in Phases 2–3. Suppress
// dead-code noise for that scaffolding until those call sites land.
#![allow(dead_code)]

mod commands;
mod connections;
mod db;
mod error;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::test_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
