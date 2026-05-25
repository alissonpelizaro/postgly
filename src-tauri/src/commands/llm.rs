//! Commands that drive the natural-language → SQL agent.

use std::sync::Arc;

use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::driver::DatabaseSchema;
use crate::error::{AppError, AppResult};
use crate::llm::agent::{self, AgentOutput, AgentStatus};
use crate::llm::chat::ChatClient;
use crate::llm::fuzzy;
use crate::llm::tools::SessionTools;
use crate::settings::{self, LLM_API_KEY_ACCOUNT};
use crate::state::{AppState, NlHistoryEntry};

use super::explorer::{get_database_schema, session_for};

/// Turn a natural-language instruction into a SQL query using the
/// configured LLM. Returns a structured outcome that the UI can render
/// directly (the model is asked to emit JSON; the agent recovers it
/// even when wrapped in code fences).
#[tauri::command]
pub async fn generate_sql<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    session_id: String,
    instruction: String,
) -> AppResult<AgentOutput> {
    if instruction.trim().is_empty() {
        return Err(AppError::Other("instruction is empty".into()));
    }

    // LLM config + secret.
    let cfg = settings::load(&app)?.llm;
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err(AppError::Other(
            "LLM is not configured — set base URL and model in Settings.".into(),
        ));
    }
    let api_key = settings::get_secret(LLM_API_KEY_ACCOUNT)?;
    if api_key.trim().is_empty() {
        return Err(AppError::Other(
            "LLM API key is not configured — set it in Settings.".into(),
        ));
    }

    // Session + cached schema.
    let session = session_for(&state, &session_id)?;
    let schema = get_database_schema(state.clone(), session_id.clone()).await?;

    let tool_defs = SessionTools::definitions();
    let executor = SessionTools::new(session, Arc::clone(&schema));
    let client = ChatClient::new(&cfg.base_url, &api_key);

    let mut output = agent::run(
        &client,
        tool_defs,
        &executor,
        &cfg.model,
        cfg.temperature,
        agent::default_system_prompt(),
        instruction.clone(),
    )
    .await?;

    // Belt-and-braces: when the model failed to find a table and didn't
    // suggest anything, run a fuzzy match against the cached schema so
    // the UI can still offer "did you mean X?" hints.
    if output.status == AgentStatus::NotFound && output.suggestions.is_empty() {
        output.suggestions = fallback_suggestions(&schema, output.reason.as_deref());
    }

    state.push_nl_history(
        &session_id,
        NlHistoryEntry {
            instruction,
            output: output.clone(),
            created_at: now_seconds(),
        },
    );

    Ok(output)
}

/// Snapshot the session's natural-language query history, newest first.
#[tauri::command]
pub fn nl_query_history(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<NlHistoryEntry>> {
    Ok(state.nl_history_snapshot(&session_id))
}

/// Current unix timestamp in seconds. Falls back to `0` on the
/// vanishingly rare case where the system clock is before the epoch.
fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Best-effort fallback when the LLM reports `not_found` without
/// proposing alternatives. Pulls candidate tokens from the reason and
/// matches them against table names in the cached schema.
fn fallback_suggestions(schema: &DatabaseSchema, reason: Option<&str>) -> Vec<String> {
    let reason = match reason {
        Some(r) if !r.is_empty() => r,
        _ => return Vec::new(),
    };
    let tokens = fuzzy::extract_tokens(reason);
    fuzzy::nearest_table_names(schema, &tokens, 3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::connections::test_utils::EnvSandbox;
    use crate::commands::settings::{save_llm_config, LlmConfigInput};
    use crate::db::driver::{
        CellValue, ConnectionConfig, DatabaseKind, DatabaseSchema, OrderBy, QueryResult,
        RelationKind, RowFilter, SchemaInfo, TableDetails, TableInfo, TableSchema,
    };
    use crate::settings;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use tauri::Manager;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Fake driver — only `execute` and `introspect_schema` are
    /// exercised. All other trait methods delegate to a one-line "empty"
    /// result to keep test code small and the file's coverage healthy.
    #[derive(Default)]
    struct FakeDriver {
        executed: Mutex<Vec<String>>,
    }

    fn empty_result() -> QueryResult {
        QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: 0,
        }
    }

    #[async_trait]
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
            Ok(vec![])
        }
        async fn list_tables(&self, _: &str) -> AppResult<Vec<TableInfo>> {
            Ok(vec![])
        }
        async fn describe_table(&self, _: &str, _: &str) -> AppResult<TableDetails> {
            Ok(TableDetails {
                columns: vec![],
                indexes: vec![],
            })
        }
        async fn introspect_schema(&self) -> AppResult<DatabaseSchema> {
            Ok(DatabaseSchema {
                tables: vec![TableSchema {
                    schema: "public".into(),
                    name: "users".into(),
                    kind: RelationKind::Table,
                    comment: None,
                    columns: vec![ColumnSchema {
                        name: "id".into(),
                        data_type: "int4".into(),
                        nullable: false,
                        default: None,
                        is_primary_key: true,
                        comment: None,
                    }],
                    primary_key: vec!["id".into()],
                    foreign_keys: vec![],
                }],
            })
        }
        async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
            self.executed.lock().unwrap().push(sql.to_string());
            Ok(QueryResult {
                columns: vec!["id".into()],
                rows: vec![vec![Some("1".into())]],
                rows_affected: 1,
            })
        }
        async fn browse_table(
            &self,
            _: &str,
            _: &str,
            _: Option<&RowFilter>,
            _: Option<&OrderBy>,
            _: i64,
            _: i64,
        ) -> AppResult<QueryResult> {
            Ok(empty_result())
        }
        async fn update_row(
            &self,
            _: &str,
            _: &str,
            _: &[CellValue],
            _: &[CellValue],
        ) -> AppResult<QueryResult> {
            Ok(empty_result())
        }
        async fn insert_row(&self, _: &str, _: &str, _: &[CellValue]) -> AppResult<QueryResult> {
            Ok(empty_result())
        }
        async fn delete_row(&self, _: &str, _: &str, _: &[CellValue]) -> AppResult<QueryResult> {
            Ok(empty_result())
        }
        fn query_history(&self) -> Vec<String> {
            vec![]
        }
        async fn disconnect(&mut self) -> AppResult<()> {
            Ok(())
        }
    }

    use crate::db::driver::ColumnSchema;

    fn mock_app_with_session(id: &str) -> tauri::App<tauri::test::MockRuntime> {
        let state = AppState::default();
        state
            .sessions
            .lock()
            .unwrap()
            .insert(id.into(), Arc::new(FakeDriver::default()));
        tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app")
    }

    async fn write_llm_config<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        base_url: &str,
        api_key: &str,
    ) {
        save_llm_config(
            app.clone(),
            LlmConfigInput {
                provider: "openai".into(),
                base_url: base_url.into(),
                model: "gpt-test".into(),
                temperature: 0.0,
                api_key: api_key.into(),
            },
        )
        .unwrap();
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_rejects_empty_instruction() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        let err = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "   ".into(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("instruction is empty"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_errors_when_llm_not_configured() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        let err = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "list users".into(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("LLM is not configured"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_errors_when_api_key_missing() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        // Save config but with an empty API key.
        let server = MockServer::start().await; // unused but ensures base url is well-formed
        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "key").await;
        // Wipe the key after saving (simulates the user clearing it).
        settings::set_secret(LLM_API_KEY_ACCOUNT, "").unwrap();

        let err = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "list users".into(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("API key is not configured"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_errors_when_session_unknown() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");
        let server = MockServer::start().await;
        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let err = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "ghost".into(),
            "anything".into(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("session not found"));
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_returns_final_answer_on_single_turn() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"need_info\",\"reason\":\"specify date range\"}"
                    },
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let out = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "users".into(),
        )
        .await
        .unwrap();
        assert_eq!(out.status, agent::AgentStatus::NeedInfo);
        assert_eq!(out.reason.as_deref(), Some("specify date range"));
        assert!(out.sql.is_none());
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_records_history_and_nl_query_history_returns_it() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"ok\",\"sql\":\"SELECT 1\"}"
                    },
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        // Two requests → two history entries, newest first.
        for q in ["primeira", "segunda"] {
            generate_sql(
                app.handle().clone(),
                app.state::<AppState>(),
                "s".into(),
                q.into(),
            )
            .await
            .unwrap();
        }

        let history = nl_query_history(app.state::<AppState>(), "s".into()).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].instruction, "segunda");
        assert_eq!(history[1].instruction, "primeira");
        // Token usage propagates into the history entry.
        assert_eq!(history[0].output.usage.total_tokens, 16);
        assert_eq!(history[0].output.sql.as_deref(), Some("SELECT 1"));
    }

    #[test]
    fn nl_query_history_empty_for_unknown_session() {
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let out = nl_query_history(app.state::<AppState>(), "missing".into()).unwrap();
        assert!(out.is_empty());
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_falls_back_to_fuzzy_suggestions_on_not_found() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");

        let server = MockServer::start().await;
        // Single-turn: model emits not_found WITHOUT suggestions.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"not_found\",\"reason\":\"tabela usuarios não encontrada\"}"
                    },
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let out = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "usuarios cadastrados".into(),
        )
        .await
        .unwrap();
        assert_eq!(out.status, agent::AgentStatus::NotFound);
        // Schema has a `users` table; fuzzy fallback proposed it.
        assert!(out.suggestions.iter().any(|s| s == "public.users"));
    }

    #[test]
    fn fallback_suggestions_returns_empty_without_reason() {
        let schema = DatabaseSchema {
            tables: vec![TableSchema {
                schema: "public".into(),
                name: "users".into(),
                kind: RelationKind::Table,
                comment: None,
                columns: vec![],
                primary_key: vec![],
                foreign_keys: vec![],
            }],
        };
        assert!(super::fallback_suggestions(&schema, None).is_empty());
        assert!(super::fallback_suggestions(&schema, Some("")).is_empty());
    }

    #[cfg(feature = "mock-keyring")]
    #[tokio::test]
    async fn generate_sql_runs_tool_then_returns_final_sql() {
        let _sandbox = EnvSandbox::new();
        settings::reset_mock_keyring();
        let app = mock_app_with_session("s");

        let server = MockServer::start().await;

        // First model turn: ask the host to call `list_tables`.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "list_tables",
                                "arguments": "{}"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        // Second model turn: emit the final JSON answer.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"status\":\"ok\",\"sql\":\"SELECT * FROM public.users\"}"
                    },
                    "finish_reason": "stop"
                }]
            })))
            .mount(&server)
            .await;

        write_llm_config(app.handle(), &format!("{}/v1", server.uri()), "sk").await;

        let out = generate_sql(
            app.handle().clone(),
            app.state::<AppState>(),
            "s".into(),
            "list every user".into(),
        )
        .await
        .unwrap();

        assert_eq!(out.status, agent::AgentStatus::Ok);
        assert_eq!(out.sql.as_deref(), Some("SELECT * FROM public.users"));
        // Trace records: tool call → tool result → final assistant msg.
        assert!(out.trace.iter().any(|e| matches!(
            e,
            agent::TraceEvent::ToolCall { name, .. } if name == "list_tables"
        )));
        assert!(out.trace.iter().any(|e| matches!(
            e,
            agent::TraceEvent::ToolResult { name, ok: true, .. } if name == "list_tables"
        )));
        assert!(out
            .trace
            .iter()
            .any(|e| matches!(e, agent::TraceEvent::AssistantMessage { .. })));
    }
}
