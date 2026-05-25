//! Database explorer commands — opening a connection and browsing its
//! schemas, tables and table structure.

use uuid::Uuid;

use crate::connections;
use crate::db::{
    self,
    driver::{
        CellValue, ConnectionConfig, DatabaseSchema, OrderBy, QueryResult, RowFilter, SchemaInfo,
        TableDetails, TableInfo,
    },
    sql_safety::{self, SqlAnalysis},
};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, Session};

/// Look up a live session, cloning the `Arc` so the state lock is
/// released before any `await`.
pub(crate) fn session_for(state: &AppState, id: &str) -> AppResult<Session> {
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
/// The password is read from encrypted `vault.json`; the rest of the config comes
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
    let password = connections::get_password(&app, &connection_id)?;

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

/// Close an open connection, dropping its pool, cached schema and NL history.
#[tauri::command]
pub fn close_connection(state: tauri::State<'_, AppState>, session_id: String) -> AppResult<()> {
    state
        .sessions
        .lock()
        .map_err(|_| AppError::Other("state lock poisoned".into()))?
        .remove(&session_id);
    state
        .schema_cache
        .lock()
        .map_err(|_| AppError::Other("state lock poisoned".into()))?
        .remove(&session_id);
    state.clear_nl_history(&session_id);
    Ok(())
}

/// Return the full schema (tables, columns, PKs, FKs, comments) for an
/// open session, building and caching it on first access.
#[tauri::command]
pub async fn get_database_schema(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> AppResult<std::sync::Arc<DatabaseSchema>> {
    // Cache hit: lock briefly, clone the Arc, done.
    {
        let cache = state
            .schema_cache
            .lock()
            .map_err(|_| AppError::Other("state lock poisoned".into()))?;
        if let Some(cached) = cache.get(&session_id) {
            return Ok(cached.clone());
        }
    }

    let driver = session_for(&state, &session_id)?;
    let schema = std::sync::Arc::new(driver.introspect_schema().await?);

    let mut cache = state
        .schema_cache
        .lock()
        .map_err(|_| AppError::Other("state lock poisoned".into()))?;
    cache.insert(session_id, schema.clone());
    Ok(schema)
}

/// Drop the cached schema for a session so the next read re-introspects.
/// Call after DDL or after the user explicitly clicks "refresh schema".
#[tauri::command]
pub fn refresh_database_schema(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    state
        .schema_cache
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
    session_for(&state, &session_id)?.list_schemas().await
}

/// List the tables and views inside a schema.
#[tauri::command]
pub async fn list_tables(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schema: String,
) -> AppResult<Vec<TableInfo>> {
    session_for(&state, &session_id)?.list_tables(&schema).await
}

/// Describe a table's columns and indexes.
#[tauri::command]
pub async fn describe_table(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> AppResult<TableDetails> {
    session_for(&state, &session_id)?
        .describe_table(&schema, &table)
        .await
}

/// Inspect a SQL string without running it: classify each statement
/// and, when destructive, ask Postgres for a row estimate via
/// `EXPLAIN (FORMAT JSON)` so the UI can warn before execution.
#[derive(Debug, serde::Serialize)]
pub struct StatementAnalysis {
    #[serde(flatten)]
    pub analysis: SqlAnalysis,
    /// Estimated rows the destructive statement would touch — `None`
    /// when the planner refused the EXPLAIN (e.g. DDL) or when the SQL
    /// isn't destructive.
    pub estimated_rows: Option<f64>,
    /// When `EXPLAIN` failed, the reason (so the UI can render it
    /// alongside the confirmation modal rather than swallowing it).
    pub explain_error: Option<String>,
}

#[tauri::command]
pub async fn analyze_statement(
    state: tauri::State<'_, AppState>,
    session_id: String,
    sql: String,
) -> AppResult<StatementAnalysis> {
    let analysis = sql_safety::analyze(&sql);

    // Only probe the planner for actually destructive DML — DDL (DROP,
    // ALTER, TRUNCATE, CREATE) refuses EXPLAIN in Postgres and we'd
    // surface noise. SELECTs don't need a warning at all.
    let is_dml = analysis.statements.iter().any(|s| {
        matches!(
            s.kind,
            crate::db::sql_safety::StatementKind::Insert
                | crate::db::sql_safety::StatementKind::Update
                | crate::db::sql_safety::StatementKind::Delete
        )
    });

    if !analysis.destructive || !is_dml {
        return Ok(StatementAnalysis {
            analysis,
            estimated_rows: None,
            explain_error: None,
        });
    }

    let driver = session_for(&state, &session_id)?;
    let trimmed = sql.trim().trim_end_matches(';');
    let explain_sql = format!("EXPLAIN (FORMAT JSON) {trimmed}");
    let (estimated_rows, explain_error) = match driver.execute(&explain_sql).await {
        Ok(result) => (extract_plan_rows(&result), None),
        Err(e) => (None, Some(e.to_string())),
    };

    Ok(StatementAnalysis {
        analysis,
        estimated_rows,
        explain_error,
    })
}

/// Pull `Plan.Plan Rows` from the first row of `EXPLAIN (FORMAT JSON)`.
fn extract_plan_rows(result: &QueryResult) -> Option<f64> {
    let raw = result.rows.first()?.first()?.as_ref()?;
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let plan = value.get(0)?.get("Plan")?;
    plan.get("Plan Rows").and_then(serde_json::Value::as_f64)
}

/// Run an arbitrary SQL statement from the editor.
#[tauri::command]
pub async fn run_query(
    state: tauri::State<'_, AppState>,
    session_id: String,
    sql: String,
) -> AppResult<QueryResult> {
    session_for(&state, &session_id)?.execute(&sql).await
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
    session_for(&state, &session_id)?
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
    session_for(&state, &session_id)?
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
    session_for(&state, &session_id)?
        .delete_row(&schema, &table, &primary_key)
        .await
}

/// Return the statements run this session, oldest first.
#[tauri::command]
pub fn query_history(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<String>> {
    Ok(session_for(&state, &session_id)?.query_history())
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
    session_for(&state, &session_id)?
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
    use crate::db::driver::{DatabaseKind, RelationKind, TableDetails, TableSchema};
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
        async fn introspect_schema(&self) -> AppResult<DatabaseSchema> {
            self.record("introspect_schema");
            Ok(DatabaseSchema {
                tables: vec![TableSchema {
                    schema: "public".into(),
                    name: "users".into(),
                    kind: RelationKind::Table,
                    comment: None,
                    columns: vec![],
                    primary_key: vec![],
                    foreign_keys: vec![],
                }],
            })
        }
        async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
            self.record(format!("execute({sql})"));
            if sql.trim_start().to_uppercase().starts_with("EXPLAIN") {
                // Mimic Postgres' single-row JSON envelope so the
                // analyze_statement extractor has something to read.
                return Ok(QueryResult {
                    columns: vec!["QUERY PLAN".into()],
                    rows: vec![vec![Some(r#"[{"Plan":{"Plan Rows": 42}}]"#.into())]],
                    rows_affected: 1,
                });
            }
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
        match session_for(&state, "missing") {
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
        assert!(session_for(&state, "s").ok().is_some());
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

    #[tokio::test]
    async fn analyze_statement_flags_select_as_safe_and_skips_explain() {
        let app = app_with_session("s");
        let view = analyze_statement(
            app.state::<AppState>(),
            "s".into(),
            "SELECT * FROM users".into(),
        )
        .await
        .unwrap();
        assert!(!view.analysis.destructive);
        assert!(!view.analysis.unbounded_dml);
        assert!(view.estimated_rows.is_none());
        assert!(view.explain_error.is_none());
        // No execute call: SELECTs short-circuit before touching the driver.
        let driver = session_for(&app.state::<AppState>(), "s").unwrap();
        assert!(driver
            .query_history()
            .iter()
            .all(|c| !c.contains("execute")));
    }

    #[tokio::test]
    async fn analyze_statement_runs_explain_for_destructive_dml() {
        let app = app_with_session("s");
        let view = analyze_statement(
            app.state::<AppState>(),
            "s".into(),
            "DELETE FROM users WHERE id = 1".into(),
        )
        .await
        .unwrap();
        assert!(view.analysis.destructive);
        assert!(!view.analysis.unbounded_dml);
        assert_eq!(view.estimated_rows, Some(42.0));
        assert!(view.explain_error.is_none());
    }

    #[tokio::test]
    async fn analyze_statement_flags_unbounded_delete() {
        let app = app_with_session("s");
        let view = analyze_statement(
            app.state::<AppState>(),
            "s".into(),
            "DELETE FROM users".into(),
        )
        .await
        .unwrap();
        assert!(view.analysis.destructive);
        assert!(view.analysis.unbounded_dml);
    }

    #[tokio::test]
    async fn analyze_statement_skips_explain_for_ddl() {
        let app = app_with_session("s");
        let view = analyze_statement(
            app.state::<AppState>(),
            "s".into(),
            "DROP TABLE users".into(),
        )
        .await
        .unwrap();
        assert!(view.analysis.destructive);
        // DDL doesn't EXPLAIN — caller should render "no estimate" instead
        // of a noisy error.
        assert!(view.estimated_rows.is_none());
        assert!(view.explain_error.is_none());
    }

    #[tokio::test]
    async fn analyze_statement_errors_when_session_unknown() {
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let err = analyze_statement(
            app.state::<AppState>(),
            "ghost".into(),
            "DELETE FROM users".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Connection(_)));
    }

    #[tokio::test]
    async fn get_database_schema_introspects_and_caches() {
        let app = app_with_session("s");

        // First call hits the driver.
        let first = get_database_schema(app.state::<AppState>(), "s".into())
            .await
            .unwrap();
        assert_eq!(first.tables.len(), 1);
        assert_eq!(first.tables[0].name, "users");

        // Second call returns the cached Arc — pointer equality proves
        // we didn't re-introspect.
        let second = get_database_schema(app.state::<AppState>(), "s".into())
            .await
            .unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn refresh_database_schema_invalidates_cache() {
        let app = app_with_session("s");
        let first = get_database_schema(app.state::<AppState>(), "s".into())
            .await
            .unwrap();

        refresh_database_schema(app.state::<AppState>(), "s".into()).unwrap();

        let second = get_database_schema(app.state::<AppState>(), "s".into())
            .await
            .unwrap();
        // Different Arcs after invalidation — driver was queried again.
        assert!(!std::sync::Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn get_database_schema_errors_when_session_unknown() {
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let err = get_database_schema(app.state::<AppState>(), "missing".into())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Connection(_)));
    }

    #[tokio::test]
    async fn close_connection_evicts_cached_schema() {
        let app = app_with_session("s");
        // Warm the cache.
        get_database_schema(app.state::<AppState>(), "s".into())
            .await
            .unwrap();
        close_connection(app.state::<AppState>(), "s".into()).unwrap();
        assert!(app
            .state::<AppState>()
            .schema_cache
            .lock()
            .unwrap()
            .is_empty());
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
