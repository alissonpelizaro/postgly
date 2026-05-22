//! Tauri command handlers — the IPC surface exposed to the frontend.
//!
//! Phase 0 ships only `app_info`. Connection and database commands land
//! in Phases 1–3, each delegating to a `dyn DatabaseDriver`.

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
