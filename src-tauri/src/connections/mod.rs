//! Connection persistence.
//!
//! A saved connection is split in two so the secret never touches disk in
//! plain form:
//!
//! - **metadata** (name, host, port, database, user) → a JSON file under
//!   the app config directory;
//! - **password** → the OS keyring (Keychain / Credential Manager /
//!   Secret Service), keyed by the connection id.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::db::DatabaseKind;
use crate::error::{AppError, AppResult};

/// Keyring service namespace — matches the app's bundle identifier.
const KEYRING_SERVICE: &str = "com.alissonpelizaro.postgly";

/// File name of the metadata store inside the app config directory.
const STORE_FILE: &str = "connections.json";

/// Non-secret metadata for a saved connection. This is exactly what the
/// frontend connection list renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionMeta {
    pub id: String,
    pub name: String,
    pub kind: DatabaseKind,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
}

/// Resolve the metadata file path, creating the config directory if needed.
fn store_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(format!("cannot resolve config dir: {e}")))?;
    fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(dir.join(STORE_FILE))
}

/// Load every saved connection. Returns an empty list on first run.
pub fn load_all(app: &tauri::AppHandle) -> AppResult<Vec<ConnectionMeta>> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| AppError::Other(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| AppError::Other(format!("corrupt store: {e}")))
}

/// Persist the full connection list, overwriting the store file.
pub fn save_all(app: &tauri::AppHandle, items: &[ConnectionMeta]) -> AppResult<()> {
    let path = store_path(app)?;
    let raw = serde_json::to_string_pretty(items).map_err(|e| AppError::Other(e.to_string()))?;
    fs::write(&path, raw).map_err(|e| AppError::Other(e.to_string()))
}

/// Build a keyring entry for a connection id.
fn keyring_entry(id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| AppError::Other(format!("keyring: {e}")))
}

/// Store (or replace) the password for a connection.
pub fn set_password(id: &str, password: &str) -> AppResult<()> {
    keyring_entry(id)?
        .set_password(password)
        .map_err(|e| AppError::Other(format!("keyring: {e}")))
}

/// Retrieve the stored password for a connection.
pub fn get_password(id: &str) -> AppResult<String> {
    keyring_entry(id)?
        .get_password()
        .map_err(|e| AppError::Other(format!("keyring: {e}")))
}

/// Remove the stored password. A missing entry is treated as success so
/// deleting a connection is idempotent.
pub fn delete_password(id: &str) -> AppResult<()> {
    match keyring_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Other(format!("keyring: {e}"))),
    }
}
