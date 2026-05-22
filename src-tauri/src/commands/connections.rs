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
pub fn list_connections(app: tauri::AppHandle) -> AppResult<Vec<ConnectionMeta>> {
    connections::load_all(&app)
}

/// Create a new connection or update an existing one.
///
/// The password goes to the OS keyring; the rest to the JSON store. On
/// update, an empty password leaves the stored secret untouched.
#[tauri::command]
pub fn save_connection(app: tauri::AppHandle, input: ConnectionInput) -> AppResult<ConnectionMeta> {
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
pub fn delete_connection(app: tauri::AppHandle, id: String) -> AppResult<()> {
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
