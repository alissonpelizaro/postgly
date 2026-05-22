//! Shared application state held by Tauri.
//!
//! An *open connection* is a connected [`DatabaseDriver`] kept alive in
//! the `sessions` map and addressed by a session id. Drivers hold a
//! cheaply-cloneable pool, so query commands lock the map only long
//! enough to clone the `Arc` — never across an `await`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use crate::db::DatabaseDriver;

/// A live, connected driver shared across query commands.
pub type Session = Arc<dyn DatabaseDriver>;

/// Tauri-managed application state.
#[derive(Default)]
pub struct AppState {
    /// Open connections, keyed by session id.
    pub sessions: Mutex<HashMap<String, Session>>,
}
