//! Postgly — Tauri application entry point.

// The `db` and `error` modules are Phase 0 scaffolding: the driver trait
// and error type exist ahead of the commands that will exercise them in
// Phases 1–3. Suppress dead-code noise until those call sites land.
#![allow(dead_code)]

mod commands;
mod db;
mod error;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
