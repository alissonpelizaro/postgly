//! Connection persistence.
//!
//! A saved connection is split in two:
//!
//! - **metadata** (name, host, port, database, user) → a JSON file under
//!   the app config directory;
//! - **password** → encrypted `vault.json`, keyed by the connection id.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::db::DatabaseKind;
use crate::error::{AppError, AppResult};
use crate::vault;

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
fn store_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(format!("cannot resolve config dir: {e}")))?;
    fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(dir.join(STORE_FILE))
}

/// Load every saved connection from an explicit store file. Returns an
/// empty list when the file doesn't exist. Pure: no AppHandle required.
pub fn load_all_from(path: &Path) -> AppResult<Vec<ConnectionMeta>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| AppError::Other(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| AppError::Other(format!("corrupt store: {e}")))
}

/// Persist the full connection list to an explicit file. Pure: no
/// AppHandle required.
pub fn save_all_to(path: &Path, items: &[ConnectionMeta]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Other(e.to_string()))?;
    }
    let raw = serde_json::to_string_pretty(items).map_err(|e| AppError::Other(e.to_string()))?;
    fs::write(path, raw).map_err(|e| AppError::Other(e.to_string()))
}

/// Load every saved connection. Returns an empty list on first run.
pub fn load_all<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppResult<Vec<ConnectionMeta>> {
    load_all_from(&store_path(app)?)
}

/// Persist the full connection list, overwriting the store file.
pub fn save_all<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    items: &[ConnectionMeta],
) -> AppResult<()> {
    save_all_to(&store_path(app)?, items)
}

/// Store (or replace) the password for a connection.
pub fn set_password<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    password: &str,
) -> AppResult<()> {
    vault::set_connection_password(app, id, password)
}

/// Retrieve the stored password for a connection.
pub fn get_password<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) -> AppResult<String> {
    vault::get_connection_password(app, id)
}

/// Remove the stored password. A missing entry is treated as success so
/// deleting a connection is idempotent.
pub fn delete_password<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) -> AppResult<()> {
    vault::delete_connection_password(app, id)
}

#[cfg(feature = "mock-keyring")]
#[allow(unused_imports)]
pub use crate::vault::reset_mock_connection_store as reset_mock_keyring;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connections::test_utils::EnvSandbox;
    use tempfile::tempdir;

    fn sample() -> ConnectionMeta {
        ConnectionMeta {
            id: "abc".into(),
            name: "Local".into(),
            kind: DatabaseKind::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: "db".into(),
            user: "u".into(),
        }
    }

    #[test]
    fn load_all_from_returns_empty_when_file_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let items = load_all_from(&path).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn save_then_load_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("connections.json");
        save_all_to(&path, &[sample()]).unwrap();

        let loaded = load_all_from(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "abc");
        assert_eq!(loaded[0].name, "Local");
        assert_eq!(loaded[0].kind, DatabaseKind::Postgres);
    }

    #[test]
    fn load_all_from_rejects_corrupt_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("connections.json");
        fs::write(&path, "{ not json").unwrap();

        let err = load_all_from(&path).unwrap_err();
        assert!(err.to_string().contains("corrupt store"));
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn password_round_trip_with_mock_keyring() {
        let _sandbox = EnvSandbox::new();
        reset_mock_keyring();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        set_password(app.handle(), "id-1", "secret").unwrap();
        assert_eq!(get_password(app.handle(), "id-1").unwrap(), "secret");
        delete_password(app.handle(), "id-1").unwrap();
        assert!(get_password(app.handle(), "id-1").is_err());
        // Deleting twice is idempotent.
        delete_password(app.handle(), "id-1").unwrap();
    }
}
