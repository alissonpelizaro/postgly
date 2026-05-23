//! Connection management commands — the IPC surface for Phase 1.

use serde::Deserialize;
use uuid::Uuid;

use crate::connections::{self, ConnectionMeta};
use crate::db::{self, driver::ConnectionConfig, DatabaseKind};
use crate::error::{AppError, AppResult};

/// Form payload for creating, updating or testing a connection.
#[derive(Debug, Deserialize)]
pub struct ConnectionInput {
    /// `None` creates a new connection; `Some` targets an existing one.
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    /// Empty when editing and the user is keeping the saved password.
    #[serde(default)]
    pub password: String,
}

impl ConnectionInput {
    /// Resolve the effective password: the typed one, or — when editing
    /// without retyping — the password already in the keyring.
    fn resolve_password(&self) -> AppResult<String> {
        if !self.password.is_empty() {
            return Ok(self.password.clone());
        }
        match &self.id {
            Some(id) => connections::get_password(id),
            None => Err(AppError::Connection("password is required".into())),
        }
    }

    /// Build a driver-level config from the form fields.
    fn into_config(self, password: String) -> ConnectionConfig {
        ConnectionConfig {
            name: self.name,
            kind: DatabaseKind::Postgres,
            host: self.host,
            port: self.port,
            database: self.database,
            user: self.user,
            password,
        }
    }
}

/// List every saved connection (metadata only — no passwords).
#[tauri::command]
pub fn list_connections<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> AppResult<Vec<ConnectionMeta>> {
    connections::load_all(&app)
}

/// Create a new connection or update an existing one.
///
/// The password goes to the OS keyring; the rest to the JSON store. On
/// update, an empty password leaves the stored secret untouched.
#[tauri::command]
pub fn save_connection<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    input: ConnectionInput,
) -> AppResult<ConnectionMeta> {
    let mut items = connections::load_all(&app)?;
    let is_new = input.id.is_none();
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    if !input.password.is_empty() {
        connections::set_password(&id, &input.password)?;
    } else if is_new {
        return Err(AppError::Other("password is required".into()));
    }

    let meta = ConnectionMeta {
        id: id.clone(),
        name: input.name,
        kind: DatabaseKind::Postgres,
        host: input.host,
        port: input.port,
        database: input.database,
        user: input.user,
    };

    match items.iter_mut().find(|c| c.id == id) {
        Some(existing) => *existing = meta.clone(),
        None => items.push(meta.clone()),
    }
    connections::save_all(&app, &items)?;
    Ok(meta)
}

/// Delete a connection: drop its metadata and its keyring password.
#[tauri::command]
pub fn delete_connection<R: tauri::Runtime>(app: tauri::AppHandle<R>, id: String) -> AppResult<()> {
    let mut items = connections::load_all(&app)?;
    items.retain(|c| c.id != id);
    connections::save_all(&app, &items)?;
    connections::delete_password(&id)
}

/// Open a transient connection, ping it and close it — the "Test
/// connection" button. Never persists anything.
#[tauri::command]
pub async fn test_connection(input: ConnectionInput) -> AppResult<()> {
    let password = input.resolve_password()?;
    let config = input.into_config(password);

    let mut driver = db::make_driver(config.kind);
    driver.connect(&config).await?;
    let result = driver.ping().await;
    let _ = driver.disconnect().await;
    result
}

#[cfg(test)]
pub(crate) mod test_utils {
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// Process-wide guard. Tauri's path resolver reads `HOME` /
    /// `XDG_CONFIG_HOME` / `APPDATA` once, and tests parallelise by
    /// default — serialising the env mutation keeps cases isolated.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// RAII guard that points the OS-specific config-dir env vars at a
    /// fresh tempdir for the duration of one test. The lock is held
    /// until the guard drops.
    pub struct EnvSandbox {
        #[allow(dead_code)]
        pub dir: TempDir,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvSandbox {
        pub fn new() -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let dir = tempfile::tempdir().unwrap();
            // SAFETY: env mutation is serialised through `ENV_LOCK`.
            unsafe {
                std::env::set_var("HOME", dir.path());
                std::env::set_var("XDG_CONFIG_HOME", dir.path());
                std::env::set_var("APPDATA", dir.path());
            }
            Self { dir, _lock: lock }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections;
    use crate::state::AppState;
    use test_utils::EnvSandbox;

    fn mock_app_with_state() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds")
    }

    fn fresh_input(password: &str) -> ConnectionInput {
        ConnectionInput {
            id: None,
            name: "L".into(),
            host: "h".into(),
            port: 5432,
            database: "d".into(),
            user: "u".into(),
            password: password.into(),
        }
    }

    #[test]
    fn resolve_password_returns_typed_value_when_present() {
        let input = fresh_input("typed");
        assert_eq!(input.resolve_password().unwrap(), "typed");
    }

    #[test]
    fn resolve_password_requires_a_value_for_new_connections() {
        let input = fresh_input("");
        let err = input.resolve_password().unwrap_err();
        assert!(err.to_string().contains("password is required"));
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn resolve_password_falls_back_to_keyring_when_editing() {
        crate::connections::reset_mock_keyring();
        crate::connections::set_password("existing", "stored").unwrap();
        let input = ConnectionInput {
            id: Some("existing".into()),
            ..fresh_input("")
        };
        assert_eq!(input.resolve_password().unwrap(), "stored");
    }

    #[test]
    fn into_config_maps_form_fields_to_driver_config() {
        let cfg = fresh_input("pw").into_config("real".into());
        assert_eq!(cfg.name, "L");
        assert_eq!(cfg.host, "h");
        assert_eq!(cfg.port, 5432);
        assert_eq!(cfg.database, "d");
        assert_eq!(cfg.user, "u");
        assert_eq!(cfg.password, "real");
        assert_eq!(cfg.kind, DatabaseKind::Postgres);
    }

    #[tokio::test]
    async fn test_connection_propagates_password_validation_error() {
        let err = test_connection(fresh_input("")).await.unwrap_err();
        assert!(err.to_string().contains("password is required"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn test_connection_fails_to_connect_against_a_fake_host() {
        // No real server: we want the error to come from the driver, not
        // from the password resolution path.
        let input = ConnectionInput {
            host: "127.0.0.1".into(),
            port: 1, // reserved
            ..fresh_input("pw")
        };
        let err = test_connection(input).await.unwrap_err();
        assert!(matches!(err, AppError::Connection(_)));
    }

    // The remaining tests exercise the full Tauri command pipeline.
    // They run under a sandboxed HOME/XDG/APPDATA so the JSON store
    // lives in a tempdir, and use the `mock-keyring` feature to keep
    // passwords in-memory.

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn list_connections_returns_empty_on_first_run() {
        let _sandbox = EnvSandbox::new();
        connections::reset_mock_keyring();
        let app = mock_app_with_state();
        let items = list_connections(app.handle().clone()).unwrap();
        assert!(items.is_empty());
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn save_connection_creates_a_new_entry_and_stores_password() {
        let _sandbox = EnvSandbox::new();
        connections::reset_mock_keyring();
        let app = mock_app_with_state();
        let meta = save_connection(app.handle().clone(), fresh_input("hunter2")).unwrap();
        assert_eq!(meta.name, "L");

        let items = list_connections(app.handle().clone()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, meta.id);

        // Password landed in the keyring.
        assert_eq!(connections::get_password(&meta.id).unwrap(), "hunter2");
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn save_connection_updates_an_existing_entry() {
        let _sandbox = EnvSandbox::new();
        connections::reset_mock_keyring();
        let app = mock_app_with_state();
        let original = save_connection(app.handle().clone(), fresh_input("pw1")).unwrap();

        let mut updated = fresh_input("pw2");
        updated.id = Some(original.id.clone());
        updated.name = "Renamed".into();
        let meta = save_connection(app.handle().clone(), updated).unwrap();
        assert_eq!(meta.id, original.id);
        assert_eq!(meta.name, "Renamed");

        let items = list_connections(app.handle().clone()).unwrap();
        assert_eq!(items.len(), 1, "update must not duplicate");
        assert_eq!(items[0].name, "Renamed");
        assert_eq!(connections::get_password(&original.id).unwrap(), "pw2");
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn save_connection_can_keep_the_existing_password() {
        let _sandbox = EnvSandbox::new();
        connections::reset_mock_keyring();
        let app = mock_app_with_state();
        let original = save_connection(app.handle().clone(), fresh_input("kept")).unwrap();

        let mut update = fresh_input(""); // empty: keep the stored password
        update.id = Some(original.id.clone());
        update.name = "Updated".into();
        let meta = save_connection(app.handle().clone(), update).unwrap();
        assert_eq!(meta.name, "Updated");
        assert_eq!(connections::get_password(&original.id).unwrap(), "kept");
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn save_connection_rejects_new_entries_without_password() {
        let _sandbox = EnvSandbox::new();
        connections::reset_mock_keyring();
        let app = mock_app_with_state();
        let err = save_connection(app.handle().clone(), fresh_input("")).unwrap_err();
        assert!(err.to_string().contains("password is required"));
    }

    #[cfg(feature = "mock-keyring")]
    #[test]
    fn delete_connection_removes_metadata_and_password() {
        let _sandbox = EnvSandbox::new();
        connections::reset_mock_keyring();
        let app = mock_app_with_state();
        let meta = save_connection(app.handle().clone(), fresh_input("pw")).unwrap();

        delete_connection(app.handle().clone(), meta.id.clone()).unwrap();
        let items = list_connections(app.handle().clone()).unwrap();
        assert!(items.is_empty());
        assert!(connections::get_password(&meta.id).is_err());

        // Deleting a missing connection is still idempotent.
        delete_connection(app.handle().clone(), meta.id).unwrap();
    }
}
