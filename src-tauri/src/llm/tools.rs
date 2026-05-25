//! Tools the LLM agent is allowed to call while planning a query.
//!
//! Each tool maps to a single async function that operates on the
//! current session: schema lookups come from the cached
//! [`DatabaseSchema`] (no extra round-trips), `sample_rows` goes through
//! the driver so the user's session-level history records the probe.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::chat::ToolDef;
use crate::db::driver::DatabaseSchema;
use crate::db::sql_safety;
use crate::error::{AppError, AppResult};
use crate::state::Session;

/// Hard upper bound for `sample_rows` — the LLM should explore, not pull
/// the table down.
pub const SAMPLE_ROW_HARD_LIMIT: i64 = 20;

/// Hard upper bound on rows returned by `run_select` so the agent can't
/// flood its own context with a giant table.
pub const RUN_SELECT_ROW_LIMIT: usize = 100;

/// Tool executor abstraction so the agent loop can be tested with a
/// fake that records calls. Production uses [`SessionTools`].
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Execute the named tool with JSON-decoded arguments. Errors are
    /// converted into a JSON `{"error": ...}` body by the agent so the
    /// LLM can read and react.
    async fn execute(&self, name: &str, args: Value) -> AppResult<Value>;
}

/// Production tool executor backed by a live session + introspected schema.
pub struct SessionTools {
    session: Session,
    schema: Arc<DatabaseSchema>,
    /// When `true`, even non-destructive writes (INSERT, UPDATE/DELETE
    /// with WHERE) bounce through the confirmation card. Truly
    /// destructive statements always require confirmation regardless.
    confirm_writes: bool,
}

impl SessionTools {
    pub fn new(session: Session, schema: Arc<DatabaseSchema>) -> Self {
        Self {
            session,
            schema,
            confirm_writes: false,
        }
    }

    pub fn with_confirm_writes(mut self, confirm: bool) -> Self {
        self.confirm_writes = confirm;
        self
    }

    /// The JSON-schema-shaped tool definitions handed to the LLM.
    pub fn definitions() -> Vec<ToolDef> {
        vec![
            ToolDef::function(
                "list_tables",
                "List user tables and views available in the connected database. \
                 Optionally filter by schema name. Returns an array of {schema, name, kind}.",
                json!({
                    "type": "object",
                    "properties": {
                        "schema": {
                            "type": "string",
                            "description": "Restrict results to this schema (e.g. \"public\"). Omit for all user schemas."
                        }
                    },
                    "additionalProperties": false
                }),
            ),
            ToolDef::function(
                "describe_table",
                "Return the structure of a table: columns (name, type, nullable, default, comment), primary key and foreign keys.",
                json!({
                    "type": "object",
                    "properties": {
                        "schema": { "type": "string", "description": "Schema name." },
                        "name":   { "type": "string", "description": "Table or view name." }
                    },
                    "required": ["schema", "name"],
                    "additionalProperties": false
                }),
            ),
            ToolDef::function(
                "list_relations",
                "Return foreign-key relations touching the given table — both outbound \
                 (this table's FKs) and inbound (other tables pointing here). Useful for \
                 planning JOINs.",
                json!({
                    "type": "object",
                    "properties": {
                        "schema": { "type": "string", "description": "Schema name." },
                        "name":   { "type": "string", "description": "Table name." }
                    },
                    "required": ["schema", "name"],
                    "additionalProperties": false
                }),
            ),
            ToolDef::function(
                "run_select",
                "Execute a read-only SELECT (or WITH/EXPLAIN/SHOW) query against the connected \
                 database and return the rows. Rejects anything that mutates the database — \
                 use this only when you need real data the user asked about. At most 100 rows \
                 are returned; ask the user before running queries that would return more.",
                json!({
                    "type": "object",
                    "properties": {
                        "sql": {
                            "type": "string",
                            "description": "A single SELECT statement. No semicolon batches, no DML/DDL."
                        }
                    },
                    "required": ["sql"],
                    "additionalProperties": false
                }),
            ),
            ToolDef::function(
                "run_write",
                "Execute an INSERT/UPDATE/DELETE/DDL statement against the connected database. \
                 Non-destructive writes (INSERT, UPDATE/DELETE with WHERE) run immediately when \
                 the safety setting allows. Destructive statements (DROP/TRUNCATE/ALTER/CREATE, \
                 or UPDATE/DELETE without WHERE) are NOT executed — the tool returns a \
                 `needs_approval` payload and the host application surfaces an approval card to \
                 the user. When that happens, STOP and tell the user what you propose to do and \
                 why; do not retry the same statement.",
                json!({
                    "type": "object",
                    "properties": {
                        "sql": {
                            "type": "string",
                            "description": "A single mutating statement. No semicolon batches."
                        },
                        "summary": {
                            "type": "string",
                            "description": "A short human-readable explanation of what this statement does and why."
                        }
                    },
                    "required": ["sql", "summary"],
                    "additionalProperties": false
                }),
            ),
            ToolDef::function(
                "sample_rows",
                "Return up to `limit` rows from a table for inspection. Always read-only \
                 (a LIMIT is enforced). Use sparingly when column meanings or value formats \
                 are unclear.",
                json!({
                    "type": "object",
                    "properties": {
                        "schema": { "type": "string", "description": "Schema name." },
                        "name":   { "type": "string", "description": "Table name." },
                        "limit":  {
                            "type": "integer",
                            "description": "How many rows to fetch (1..=20). Defaults to 5.",
                            "minimum": 1,
                            "maximum": SAMPLE_ROW_HARD_LIMIT
                        }
                    },
                    "required": ["schema", "name"],
                    "additionalProperties": false
                }),
            ),
        ]
    }

    fn list_tables(&self, schema_filter: Option<&str>) -> Value {
        let items: Vec<Value> = self
            .schema
            .tables
            .iter()
            .filter(|t| schema_filter.is_none_or(|s| t.schema == s))
            .map(|t| {
                json!({
                    "schema": t.schema,
                    "name": t.name,
                    "kind": t.kind,
                    "comment": t.comment,
                })
            })
            .collect();
        json!({ "tables": items })
    }

    fn describe_table(&self, schema: &str, name: &str) -> AppResult<Value> {
        let table = self
            .schema
            .tables
            .iter()
            .find(|t| t.schema == schema && t.name == name)
            .ok_or_else(|| AppError::Other(format!("table not found: {schema}.{name}")))?;
        Ok(json!({
            "schema": table.schema,
            "name": table.name,
            "kind": table.kind,
            "comment": table.comment,
            "primary_key": table.primary_key,
            "columns": table.columns,
            "foreign_keys": table.foreign_keys,
        }))
    }

    fn list_relations(&self, schema: &str, name: &str) -> AppResult<Value> {
        // The table must exist — without it we can't distinguish "no
        // relations" from "wrong name", and the LLM needs that signal.
        let exists = self
            .schema
            .tables
            .iter()
            .any(|t| t.schema == schema && t.name == name);
        if !exists {
            return Err(AppError::Other(format!("table not found: {schema}.{name}")));
        }

        let outbound: Vec<Value> = self
            .schema
            .tables
            .iter()
            .find(|t| t.schema == schema && t.name == name)
            .map(|t| {
                t.foreign_keys
                    .iter()
                    .map(|fk| serde_json::to_value(fk).unwrap())
                    .collect()
            })
            .unwrap_or_default();

        let inbound: Vec<Value> = self
            .schema
            .tables
            .iter()
            .flat_map(|t| {
                t.foreign_keys.iter().filter_map(move |fk| {
                    if fk.ref_schema == schema && fk.ref_table == name {
                        Some(json!({
                            "from_schema": t.schema,
                            "from_table": t.name,
                            "from_columns": fk.columns,
                            "to_columns": fk.ref_columns,
                            "constraint": fk.name,
                        }))
                    } else {
                        None
                    }
                })
            })
            .collect();

        Ok(json!({
            "outbound": outbound,
            "inbound": inbound,
        }))
    }

    async fn run_select(&self, sql: &str) -> AppResult<Value> {
        let analysis = sql_safety::analyze(sql);
        if analysis.statements.is_empty() {
            return Err(AppError::Other("empty SQL".into()));
        }
        if analysis.statements.len() > 1 {
            return Err(AppError::Other(
                "run_select accepts a single statement; remove the extra `;`".into(),
            ));
        }
        let kind = analysis.statements[0].kind;
        if kind != sql_safety::StatementKind::Select {
            return Err(AppError::Other(format!(
                "run_select rejects {:?} statements — only SELECT/WITH/EXPLAIN/SHOW are allowed",
                kind
            )));
        }
        let result = self.session.execute(sql).await?;
        let total_rows = result.rows.len();
        let truncated = total_rows > RUN_SELECT_ROW_LIMIT;
        let rows: Vec<_> = result.rows.into_iter().take(RUN_SELECT_ROW_LIMIT).collect();
        Ok(json!({
            "columns": result.columns,
            "rows": rows,
            "row_count": total_rows,
            "truncated": truncated,
            "row_limit": RUN_SELECT_ROW_LIMIT,
        }))
    }

    async fn run_write(&self, sql: &str, summary: &str) -> AppResult<Value> {
        let analysis = sql_safety::analyze(sql);
        if analysis.statements.is_empty() {
            return Err(AppError::Other("empty SQL".into()));
        }
        if analysis.statements.len() > 1 {
            return Err(AppError::Other(
                "run_write accepts a single statement; remove the extra `;`".into(),
            ));
        }
        let stmt = &analysis.statements[0];
        let kind = stmt.kind;
        if kind == sql_safety::StatementKind::Select {
            return Err(AppError::Other(
                "run_write is for mutations; use run_select for SELECTs".into(),
            ));
        }
        if kind == sql_safety::StatementKind::Other {
            return Err(AppError::Other(
                "run_write could not classify this statement; refine the SQL".into(),
            ));
        }

        let is_dml_with_where = matches!(
            kind,
            sql_safety::StatementKind::Update | sql_safety::StatementKind::Delete
        ) && stmt.has_where;
        let is_plain_insert = kind == sql_safety::StatementKind::Insert;
        let auto_safe = is_plain_insert || is_dml_with_where;
        let needs_approval = !auto_safe || self.confirm_writes;

        if needs_approval {
            return Ok(json!({
                "needs_approval": true,
                "sql": sql,
                "summary": summary,
                "kind": kind,
                "preview": stmt.preview,
                "destructive": analysis.destructive,
                "unbounded_dml": analysis.unbounded_dml,
                "has_where": stmt.has_where,
            }));
        }

        let result = self.session.execute(sql).await?;
        Ok(json!({
            "needs_approval": false,
            "executed": true,
            "kind": kind,
            "rows_affected": result.rows_affected,
        }))
    }

    async fn sample_rows(&self, schema: &str, name: &str, limit: i64) -> AppResult<Value> {
        let exists = self
            .schema
            .tables
            .iter()
            .any(|t| t.schema == schema && t.name == name);
        if !exists {
            return Err(AppError::Other(format!("table not found: {schema}.{name}")));
        }

        let limit = limit.clamp(1, SAMPLE_ROW_HARD_LIMIT);
        // Quoting is engine-specific; for now this layer only runs
        // against Postgres which double-quotes identifiers.
        let sql = format!(
            "SELECT * FROM \"{}\".\"{}\" LIMIT {}",
            schema.replace('"', "\"\""),
            name.replace('"', "\"\""),
            limit,
        );
        let result = self.session.execute(&sql).await?;
        Ok(json!({
            "columns": result.columns,
            "rows": result.rows,
            "row_count": result.rows_affected,
        }))
    }
}

#[async_trait]
impl ToolExecutor for SessionTools {
    async fn execute(&self, name: &str, args: Value) -> AppResult<Value> {
        match name {
            "list_tables" => {
                let schema = args
                    .get("schema")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                Ok(self.list_tables(schema.as_deref()))
            }
            "describe_table" => {
                let (s, n) = extract_schema_and_name(&args)?;
                self.describe_table(&s, &n)
            }
            "list_relations" => {
                let (s, n) = extract_schema_and_name(&args)?;
                self.list_relations(&s, &n)
            }
            "sample_rows" => {
                let (s, n) = extract_schema_and_name(&args)?;
                let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(5);
                self.sample_rows(&s, &n, limit).await
            }
            "run_select" => {
                let sql = args
                    .get("sql")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AppError::Other("missing required `sql` argument".into()))?;
                self.run_select(sql).await
            }
            "run_write" => {
                let sql = args
                    .get("sql")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AppError::Other("missing required `sql` argument".into()))?;
                let summary = args.get("summary").and_then(Value::as_str).unwrap_or("");
                self.run_write(sql, summary).await
            }
            other => Err(AppError::Other(format!("unknown tool: {other}"))),
        }
    }
}

fn extract_schema_and_name(args: &Value) -> AppResult<(String, String)> {
    let schema = args
        .get("schema")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Other("missing required `schema` argument".into()))?;
    let name = args
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Other("missing required `name` argument".into()))?;
    Ok((schema.to_string(), name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::driver::{
        ColumnSchema, DatabaseSchema, ForeignKeySchema, RelationKind, TableSchema,
    };

    fn fixture_schema() -> Arc<DatabaseSchema> {
        Arc::new(DatabaseSchema {
            tables: vec![
                TableSchema {
                    schema: "public".into(),
                    name: "customer".into(),
                    kind: RelationKind::Table,
                    comment: Some("clients".into()),
                    columns: vec![
                        ColumnSchema {
                            name: "id".into(),
                            data_type: "int4".into(),
                            nullable: false,
                            default: None,
                            is_primary_key: true,
                            comment: None,
                        },
                        ColumnSchema {
                            name: "name".into(),
                            data_type: "text".into(),
                            nullable: false,
                            default: None,
                            is_primary_key: false,
                            comment: None,
                        },
                    ],
                    primary_key: vec!["id".into()],
                    foreign_keys: vec![],
                },
                TableSchema {
                    schema: "public".into(),
                    name: "order".into(),
                    kind: RelationKind::Table,
                    comment: None,
                    columns: vec![ColumnSchema {
                        name: "customer_id".into(),
                        data_type: "int4".into(),
                        nullable: false,
                        default: None,
                        is_primary_key: false,
                        comment: None,
                    }],
                    primary_key: vec![],
                    foreign_keys: vec![ForeignKeySchema {
                        name: "order_customer_fk".into(),
                        columns: vec!["customer_id".into()],
                        ref_schema: "public".into(),
                        ref_table: "customer".into(),
                        ref_columns: vec!["id".into()],
                    }],
                },
                TableSchema {
                    schema: "analytics".into(),
                    name: "events".into(),
                    kind: RelationKind::View,
                    comment: None,
                    columns: vec![],
                    primary_key: vec![],
                    foreign_keys: vec![],
                },
            ],
        })
    }

    /// `Session` requires a `DatabaseDriver`, so a no-op driver lets us
    /// build `SessionTools` for tests that don't exercise `sample_rows`.
    #[derive(Default)]
    struct InertDriver;

    #[async_trait]
    impl crate::db::DatabaseDriver for InertDriver {
        fn kind(&self) -> crate::db::driver::DatabaseKind {
            crate::db::driver::DatabaseKind::Postgres
        }
        async fn connect(&mut self, _: &crate::db::driver::ConnectionConfig) -> AppResult<()> {
            Ok(())
        }
        async fn ping(&self) -> AppResult<()> {
            Ok(())
        }
        async fn list_schemas(&self) -> AppResult<Vec<crate::db::driver::SchemaInfo>> {
            Ok(vec![])
        }
        async fn list_tables(&self, _: &str) -> AppResult<Vec<crate::db::driver::TableInfo>> {
            Ok(vec![])
        }
        async fn describe_table(
            &self,
            _: &str,
            _: &str,
        ) -> AppResult<crate::db::driver::TableDetails> {
            Ok(crate::db::driver::TableDetails {
                columns: vec![],
                indexes: vec![],
            })
        }
        async fn introspect_schema(&self) -> AppResult<DatabaseSchema> {
            Ok(DatabaseSchema { tables: vec![] })
        }
        async fn execute(&self, _: &str) -> AppResult<crate::db::driver::QueryResult> {
            Ok(crate::db::driver::QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: 0,
            })
        }
        async fn browse_table(
            &self,
            _: &str,
            _: &str,
            _: Option<&crate::db::driver::RowFilter>,
            _: Option<&crate::db::driver::OrderBy>,
            _: i64,
            _: i64,
        ) -> AppResult<crate::db::driver::QueryResult> {
            Ok(crate::db::driver::QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: 0,
            })
        }
        async fn update_row(
            &self,
            _: &str,
            _: &str,
            _: &[crate::db::driver::CellValue],
            _: &[crate::db::driver::CellValue],
        ) -> AppResult<crate::db::driver::QueryResult> {
            Ok(crate::db::driver::QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: 0,
            })
        }
        async fn insert_row(
            &self,
            _: &str,
            _: &str,
            _: &[crate::db::driver::CellValue],
        ) -> AppResult<crate::db::driver::QueryResult> {
            Ok(crate::db::driver::QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: 0,
            })
        }
        async fn delete_row(
            &self,
            _: &str,
            _: &str,
            _: &[crate::db::driver::CellValue],
        ) -> AppResult<crate::db::driver::QueryResult> {
            Ok(crate::db::driver::QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: 0,
            })
        }
        fn query_history(&self) -> Vec<String> {
            vec![]
        }
        async fn disconnect(&mut self) -> AppResult<()> {
            Ok(())
        }
    }

    fn tools() -> SessionTools {
        SessionTools::new(Arc::new(InertDriver), fixture_schema())
    }

    #[test]
    fn definitions_expose_tools_with_expected_names() {
        let defs = SessionTools::definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.function.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "list_tables",
                "describe_table",
                "list_relations",
                "run_select",
                "run_write",
                "sample_rows"
            ]
        );
    }

    #[tokio::test]
    async fn list_tables_without_filter_returns_every_table() {
        let result = tools().execute("list_tables", json!({})).await.unwrap();
        let tables = result.get("tables").and_then(Value::as_array).unwrap();
        assert_eq!(tables.len(), 3);
    }

    #[tokio::test]
    async fn list_tables_filters_by_schema() {
        let result = tools()
            .execute("list_tables", json!({"schema": "analytics"}))
            .await
            .unwrap();
        let tables = result.get("tables").and_then(Value::as_array).unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0]["name"], "events");
    }

    #[tokio::test]
    async fn describe_table_returns_columns_pk_and_fks() {
        let result = tools()
            .execute(
                "describe_table",
                json!({"schema": "public", "name": "order"}),
            )
            .await
            .unwrap();
        assert_eq!(result["name"], "order");
        assert_eq!(result["foreign_keys"].as_array().unwrap().len(), 1);
        assert!(!result["columns"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn describe_table_errors_when_missing() {
        let err = tools()
            .execute(
                "describe_table",
                json!({"schema": "public", "name": "nope"}),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("table not found"));
    }

    #[tokio::test]
    async fn list_relations_returns_inbound_and_outbound() {
        let result = tools()
            .execute(
                "list_relations",
                json!({"schema": "public", "name": "customer"}),
            )
            .await
            .unwrap();
        // No outbound FKs, one inbound (from `order`).
        assert_eq!(result["outbound"].as_array().unwrap().len(), 0);
        let inbound = result["inbound"].as_array().unwrap();
        assert_eq!(inbound.len(), 1);
        assert_eq!(inbound[0]["from_table"], "order");
    }

    #[tokio::test]
    async fn list_relations_errors_when_table_missing() {
        let err = tools()
            .execute(
                "list_relations",
                json!({"schema": "public", "name": "ghost"}),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("table not found"));
    }

    #[tokio::test]
    async fn unknown_tool_returns_an_error() {
        let err = tools().execute("teleport", json!({})).await.unwrap_err();
        assert!(err.to_string().contains("unknown tool"));
    }

    #[tokio::test]
    async fn missing_schema_argument_is_rejected() {
        let err = tools()
            .execute("describe_table", json!({"name": "x"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("schema"));
    }

    #[tokio::test]
    async fn sample_rows_clamps_limit_and_rejects_missing_tables() {
        let err = tools()
            .execute("sample_rows", json!({"schema": "public", "name": "ghost"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("table not found"));

        // Existing table — InertDriver returns an empty result. We just
        // check the call succeeds end-to-end.
        let ok = tools()
            .execute(
                "sample_rows",
                json!({"schema": "public", "name": "customer", "limit": 9999}),
            )
            .await
            .unwrap();
        assert!(ok.get("columns").is_some());
    }
}
