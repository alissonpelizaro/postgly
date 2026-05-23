//! Database explorer commands — opening a connection and browsing its
//! schemas, tables and table structure.

use uuid::Uuid;

use crate::connections;
use crate::db::{
    self,
    driver::{
        CellValue, ConnectionConfig, OrderBy, QueryResult, RowFilter, SchemaInfo, TableDetails,
        TableInfo,
    },
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
pub async fn open_connection<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
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

/// Run an arbitrary SQL statement from the editor.
#[tauri::command]
pub async fn run_query(
    state: tauri::State<'_, AppState>,
    session_id: String,
    sql: String,
) -> AppResult<QueryResult> {
    session(&state, &session_id)?.execute(&sql).await
}

/// Update a single table row, addressed by its primary key.
#[tauri::command]
pub async fn update_row(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    primary_key: Vec<CellValue>,
    changes: Vec<CellValue>,
) -> AppResult<QueryResult> {
    session(&state, &session_id)?
        .update_row(&schema, &table, &primary_key, &changes)
        .await
}

/// Insert a single row from the given column values.
#[tauri::command]
pub async fn insert_row(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    values: Vec<CellValue>,
) -> AppResult<QueryResult> {
    session(&state, &session_id)?
        .insert_row(&schema, &table, &values)
        .await
}

/// Delete a single table row, addressed by its primary key.
#[tauri::command]
pub async fn delete_row(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    primary_key: Vec<CellValue>,
) -> AppResult<QueryResult> {
    session(&state, &session_id)?
        .delete_row(&schema, &table, &primary_key)
        .await
}

/// Return the statements run this session, oldest first.
#[tauri::command]
pub fn query_history(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<String>> {
    Ok(session(&state, &session_id)?.query_history())
}

/// Browse a table's rows with an optional quick-filter, sort and pagination.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browse_table(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    filter: Option<RowFilter>,
    order_by: Option<OrderBy>,
    limit: i64,
    offset: i64,
) -> AppResult<QueryResult> {
    session(&state, &session_id)?
        .browse_table(
            &schema,
            &table,
            filter.as_ref(),
            order_by.as_ref(),
            limit,
            offset,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::driver::{DatabaseKind, TableDetails};
    use std::sync::Mutex;
    use tauri::Manager;

    /// Fake driver used to exercise the explorer command wrappers
    /// without a live Postgres. Records the calls it receives so each
    /// test can assert that the command actually forwarded the args.
    #[derive(Default)]
    struct FakeDriver {
        pub calls: Mutex<Vec<String>>,
    }

    impl FakeDriver {
        fn record(&self, call: impl Into<String>) {
            self.calls.lock().unwrap().push(call.into());
        }
    }

    #[async_trait::async_trait]
    impl crate::db::DatabaseDriver for FakeDriver {
        fn kind(&self) -> DatabaseKind {
            DatabaseKind::Postgres
        }
        async fn connect(&mut self, _: &ConnectionConfig) -> AppResult<()> {
            Ok(())
        }
        async fn ping(&self) -> AppResult<()> {
            Ok(())
        }
        async fn list_schemas(&self) -> AppResult<Vec<SchemaInfo>> {
            self.record("list_schemas");
            Ok(vec![SchemaInfo {
                name: "public".into(),
            }])
        }
        async fn list_tables(&self, schema: &str) -> AppResult<Vec<TableInfo>> {
            self.record(format!("list_tables({schema})"));
            Ok(vec![TableInfo {
                schema: schema.into(),
                name: "users".into(),
                is_view: false,
            }])
        }
        async fn describe_table(&self, schema: &str, table: &str) -> AppResult<TableDetails> {
            self.record(format!("describe_table({schema},{table})"));
            Ok(TableDetails {
                columns: vec![],
                indexes: vec![],
            })
        }
        async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
            self.record(format!("execute({sql})"));
            Ok(QueryResult {
                columns: vec!["x".into()],
                rows: vec![vec![Some("1".into())]],
                rows_affected: 1,
            })
        }
        async fn browse_table(
            &self,
            schema: &str,
            table: &str,
            filter: Option<&RowFilter>,
            order_by: Option<&OrderBy>,
            limit: i64,
            offset: i64,
        ) -> AppResult<QueryResult> {
            self.record(format!(
                "browse_table({schema},{table},f={},o={},l={limit},off={offset})",
                filter.is_some(),
                order_by.is_some()
            ));
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: 0,
            })
        }
        async fn update_row(
            &self,
            _: &str,
            _: &str,
            _: &[CellValue],
            _: &[CellValue],
        ) -> AppResult<QueryResult> {
            self.record("update_row");
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: 1,
            })
        }
        async fn insert_row(&self, _: &str, _: &str, _: &[CellValue]) -> AppResult<QueryResult> {
            self.record("insert_row");
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: 1,
            })
        }
        async fn delete_row(&self, _: &str, _: &str, _: &[CellValue]) -> AppResult<QueryResult> {
            self.record("delete_row");
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: 1,
            })
        }
        fn query_history(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        async fn disconnect(&mut self) -> AppResult<()> {
            Ok(())
        }
    }

    /// Build a mock Tauri app with a single fake session pre-installed.
    fn app_with_session(id: &str) -> tauri::App<tauri::test::MockRuntime> {
        let state = AppState::default();
        state
            .sessions
            .lock()
            .unwrap()
            .insert(id.into(), std::sync::Arc::new(FakeDriver::default()));
        tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds")
    }

    #[test]
    fn session_lookup_errors_when_id_unknown() {
        let state = AppState::default();
        match session(&state, "missing") {
            Err(AppError::Connection(_)) => {}
            Err(e) => panic!("expected Connection error, got {e}"),
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    #[test]
    fn session_lookup_returns_the_inserted_driver() {
        let state = AppState::default();
        state
            .sessions
            .lock()
            .unwrap()
            .insert("s".into(), std::sync::Arc::new(FakeDriver::default()));
        assert!(session(&state, "s").ok().is_some());
    }

    #[tokio::test]
    async fn list_schemas_forwards_to_driver() {
        let app = app_with_session("s");
        let state = app.state::<AppState>();
        let schemas = list_schemas(state, "s".into()).await.unwrap();
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0].name, "public");
    }

    #[tokio::test]
    async fn list_tables_passes_schema_to_driver() {
        let app = app_with_session("s");
        let state = app.state::<AppState>();
        let tables = list_tables(state, "s".into(), "public".into())
            .await
            .unwrap();
        assert_eq!(tables[0].schema, "public");
        assert_eq!(tables[0].name, "users");
    }

    #[tokio::test]
    async fn describe_table_passes_through() {
        let app = app_with_session("s");
        let state = app.state::<AppState>();
        let details = describe_table(state, "s".into(), "public".into(), "users".into())
            .await
            .unwrap();
        assert!(details.columns.is_empty());
    }

    #[tokio::test]
    async fn run_query_passes_sql_to_driver() {
        let app = app_with_session("s");
        let state = app.state::<AppState>();
        let res = run_query(state, "s".into(), "SELECT 1".into())
            .await
            .unwrap();
        assert_eq!(res.columns, vec!["x".to_string()]);
    }

    #[tokio::test]
    async fn browse_table_forwards_all_arguments() {
        let app = app_with_session("s");
        let state = app.state::<AppState>();
        let res = browse_table(
            state,
            "s".into(),
            "public".into(),
            "users".into(),
            Some(RowFilter {
                column: "id".into(),
                operator: crate::db::driver::FilterOp::Eq,
                value: "1".into(),
            }),
            Some(OrderBy {
                column: "id".into(),
                descending: false,
            }),
            10,
            0,
        )
        .await
        .unwrap();
        assert_eq!(res.rows_affected, 0);
    }

    #[tokio::test]
    async fn dml_commands_round_trip_through_driver() {
        let app = app_with_session("s");

        let state = app.state::<AppState>();
        update_row(
            state,
            "s".into(),
            "public".into(),
            "users".into(),
            vec![CellValue {
                column: "id".into(),
                value: Some("1".into()),
            }],
            vec![CellValue {
                column: "name".into(),
                value: Some("x".into()),
            }],
        )
        .await
        .unwrap();

        let state = app.state::<AppState>();
        insert_row(
            state,
            "s".into(),
            "public".into(),
            "users".into(),
            vec![CellValue {
                column: "name".into(),
                value: Some("x".into()),
            }],
        )
        .await
        .unwrap();

        let state = app.state::<AppState>();
        delete_row(
            state,
            "s".into(),
            "public".into(),
            "users".into(),
            vec![CellValue {
                column: "id".into(),
                value: Some("1".into()),
            }],
        )
        .await
        .unwrap();

        let state = app.state::<AppState>();
        let history = query_history(state, "s".into()).unwrap();
        assert!(history.iter().any(|s| s == "update_row"));
        assert!(history.iter().any(|s| s == "insert_row"));
        assert!(history.iter().any(|s| s == "delete_row"));
    }

    #[tokio::test]
    async fn explorer_commands_error_when_session_unknown() {
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = app.state::<AppState>();
        let err = list_schemas(state, "missing".into()).await.unwrap_err();
        assert!(matches!(err, AppError::Connection(_)));
    }

    #[test]
    fn close_connection_drops_the_session_from_state() {
        let app = app_with_session("s");
        close_connection(app.state::<AppState>(), "s".into()).unwrap();
        let app_state = app.state::<AppState>();
        assert!(app_state.sessions.lock().unwrap().is_empty());

        // Closing a missing session is a no-op (still Ok).
        close_connection(app.state::<AppState>(), "s".into()).unwrap();
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn open_connection_errors_when_id_not_found_in_store() {
        let _sandbox = crate::commands::connections::test_utils::EnvSandbox::new();
        crate::connections::reset_mock_keyring();
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let err = open_connection(app.handle().clone(), app.state::<AppState>(), "nope".into())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("connection not found"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn open_connection_propagates_connect_failure_for_bad_host() {
        let _sandbox = crate::commands::connections::test_utils::EnvSandbox::new();
        crate::connections::reset_mock_keyring();
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        // Seed a saved connection that points at an unreachable host.
        let input = crate::commands::connections::ConnectionInput {
            id: None,
            name: "n".into(),
            host: "127.0.0.1".into(),
            port: 1,
            database: "d".into(),
            user: "u".into(),
            password: "pw".into(),
        };
        let meta =
            crate::commands::connections::save_connection(app.handle().clone(), input).unwrap();

        let err = open_connection(app.handle().clone(), app.state::<AppState>(), meta.id)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Connection(_)));
    }
}
