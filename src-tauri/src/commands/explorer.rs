//! Database explorer commands — opening a connection and browsing its
//! schemas, tables and table structure.

use uuid::Uuid;

use crate::connections;
use crate::db::{
    self,
    driver::{ConnectionConfig, SchemaInfo, TableDetails, TableInfo},
};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, Session};

/// Look up a live session, cloning the `Arc` so the state lock is
/// released before any `await`.
fn session(state: &AppState, id: &str) -> AppResult<Session> {
    state
        .sessions
        .lock()
        .map_err(|_| AppError::Other("state lock poisoned".into()))?
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::Connection("session not found or closed".into()))
}

/// Open a live connection for a saved connection and return its session id.
///
/// The password is read from the OS keyring; the rest of the config comes
/// from the metadata store. A fresh session id is minted each call, so the
/// same connection can be opened more than once (Phase 4 global tabs).
#[tauri::command]
pub async fn open_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> AppResult<String> {
    let meta = connections::load_all(&app)?
        .into_iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| AppError::Other("connection not found".into()))?;
    let password = connections::get_password(&connection_id)?;

    let config = ConnectionConfig {
        name: meta.name,
        kind: meta.kind,
        host: meta.host,
        port: meta.port,
        database: meta.database,
        user: meta.user,
        password,
    };

    let mut driver = db::make_driver(config.kind);
    driver.connect(&config).await?;

    let session_id = Uuid::new_v4().to_string();
    state
        .sessions
        .lock()
        .map_err(|_| AppError::Other("state lock poisoned".into()))?
        .insert(session_id.clone(), Session::from(driver));
    Ok(session_id)
}

/// Close an open connection, dropping its pool.
#[tauri::command]
pub fn close_connection(state: tauri::State<'_, AppState>, session_id: String) -> AppResult<()> {
    state
        .sessions
        .lock()
        .map_err(|_| AppError::Other("state lock poisoned".into()))?
        .remove(&session_id);
    Ok(())
}

/// List the schemas visible to the connected user.
#[tauri::command]
pub async fn list_schemas(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<SchemaInfo>> {
    session(&state, &session_id)?.list_schemas().await
}

/// List the tables and views inside a schema.
#[tauri::command]
pub async fn list_tables(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schema: String,
) -> AppResult<Vec<TableInfo>> {
    session(&state, &session_id)?.list_tables(&schema).await
}

/// Describe a table's columns and indexes.
#[tauri::command]
pub async fn describe_table(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> AppResult<TableDetails> {
    session(&state, &session_id)?
        .describe_table(&schema, &table)
        .await
}
