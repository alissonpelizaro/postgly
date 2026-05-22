//! Tauri command handlers — the IPC surface exposed to the frontend.
//!
//! - `app_info` — basic identity / IPC sanity check.
//! - `connections` — saved-connection management (CRUD, test).
//! - `explorer` — opening a connection and browsing its structure.

pub mod connections;
pub mod explorer;

use serde::Serialize;

/// Basic identity info, handy for an About dialog and for verifying that
/// the IPC bridge is wired up.
#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Postgly".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}
