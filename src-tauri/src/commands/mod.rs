//! Tauri command handlers — the IPC surface exposed to the frontend.
//!
//! `app_info` is the Phase 0 sanity command; `connections` holds the
//! Phase 1 connection-management commands. Database explorer commands
//! land in Phases 2–3.

pub mod connections;

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
