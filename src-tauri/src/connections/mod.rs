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
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::db::DatabaseKind;
use crate::error::{AppError, AppResult};

/// Keyring service namespace — matches the app's bundle identifier.
#[cfg(not(feature = "mock-keyring"))]
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

/// Build a keyring entry for a connection id.
#[cfg(not(feature = "mock-keyring"))]
fn keyring_entry(id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| AppError::Other(format!("keyring: {e}")))
}

/// Store (or replace) the password for a connection.
#[cfg(not(feature = "mock-keyring"))]
pub fn set_password(id: &str, password: &str) -> AppResult<()> {
    keyring_entry(id)?
        .set_password(password)
        .map_err(|e| AppError::Other(format!("keyring: {e}")))
}

/// Retrieve the stored password for a connection.
#[cfg(not(feature = "mock-keyring"))]
pub fn get_password(id: &str) -> AppResult<String> {
    keyring_entry(id)?
        .get_password()
        .map_err(|e| AppError::Other(format!("keyring: {e}")))
}

/// Remove the stored password. A missing entry is treated as success so
/// deleting a connection is idempotent.
#[cfg(not(feature = "mock-keyring"))]
pub fn delete_password(id: &str) -> AppResult<()> {
    match keyring_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Other(format!("keyring: {e}"))),
    }
}

/// In-memory password store used in tests (enabled by the
/// `mock-keyring` Cargo feature). Replaces the OS keyring without
/// touching production code paths or the host's real credential store.
#[cfg(feature = "mock-keyring")]
mod mock_keyring {
    use super::{AppError, AppResult};
    use std::collections::HashMap;
    use std::sync::Mutex;

    static STORE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    fn with_store<R>(f: impl FnOnce(&mut HashMap<String, String>) -> R) -> R {
        let mut guard = STORE.lock().expect("mock keyring poisoned");
        let map = guard.get_or_insert_with(HashMap::new);
        f(map)
    }

    pub fn set(id: &str, password: &str) -> AppResult<()> {
        with_store(|m| m.insert(id.to_string(), password.to_string()));
        Ok(())
    }

    pub fn get(id: &str) -> AppResult<String> {
        with_store(|m| {
            m.get(id)
                .cloned()
                .ok_or_else(|| AppError::Other("keyring: no entry".into()))
        })
    }

    pub fn delete(id: &str) -> AppResult<()> {
        with_store(|m| {
            m.remove(id);
        });
        Ok(())
    }

    /// Wipe the mock store. Used between tests so state doesn't bleed
    /// across cases sharing the process-wide map.
    pub fn reset() {
        with_store(|m| m.clear());
    }
}

#[cfg(feature = "mock-keyring")]
pub fn set_password(id: &str, password: &str) -> AppResult<()> {
    mock_keyring::set(id, password)
}

#[cfg(feature = "mock-keyring")]
pub fn get_password(id: &str) -> AppResult<String> {
    mock_keyring::get(id)
}

#[cfg(feature = "mock-keyring")]
pub fn delete_password(id: &str) -> AppResult<()> {
    mock_keyring::delete(id)
}

#[cfg(feature = "mock-keyring")]
#[allow(unused_imports)]
pub use mock_keyring::reset as reset_mock_keyring;

#[cfg(test)]
mod tests {
    use super::*;
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
        reset_mock_keyring();
        set_password("id-1", "secret").unwrap();
        assert_eq!(get_password("id-1").unwrap(), "secret");
        delete_password("id-1").unwrap();
        assert!(get_password("id-1").is_err());
        // Deleting twice is idempotent.
        delete_password("id-1").unwrap();
    }
}
