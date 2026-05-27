//! The `DatabaseDriver` abstraction.
//!
//! Postgly is built engine-agnostic from day one: every database backend
//! (Postgres today, MySQL/SQLite tomorrow) implements this single trait.
//! The rest of the app — commands, state, frontend IPC — only ever talks
//! to a `dyn DatabaseDriver`, so adding an engine never touches call sites.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// Supported database engines. New variants are the only change required
/// in shared code when an engine is added.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseKind {
    Postgres,
}

/// Everything needed to open a connection. This is the shape the frontend
/// connection form produces. The password is intentionally part of the
/// config struct but is *never* persisted alongside the other fields —
/// see the connection store (Phase 1) which offloads it to encrypted vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    /// Friendly name shown in the connection list.
    pub name: String,
    pub kind: DatabaseKind,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
}

/// A schema (namespace) within a database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub name: String,
}

/// A table or view inside a schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    /// `true` when the relation is a view rather than a base table.
    pub is_view: bool,
}

/// A single column of a table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
}

/// An index defined on a table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub is_primary: bool,
}

/// The full structural description of a table — what the "Structure" tab
/// renders in Phase 2.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDetails {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
}

/// The result of an arbitrary query: column names plus rows of stringified
/// cell values. Typed values come later; strings keep the IPC contract
/// simple and engine-independent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows affected for non-`SELECT` statements.
    pub rows_affected: u64,
}

/// Comparison operator for the records quick-filter.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterOp {
    Eq,
    Neq,
    Lt,
    Gt,
    Lte,
    Gte,
    Like,
    ILike,
}

/// A single quick-filter clause: `column <op> value`. The column value is
/// always compared as text, so `value` is engine-independent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowFilter {
    pub column: String,
    pub operator: FilterOp,
    pub value: String,
}

/// A sort clause for table browsing: `ORDER BY column [ASC|DESC]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBy {
    pub column: String,
    pub descending: bool,
}

/// A single column value, used both to address a row (primary key) and to
/// carry an edited value. `value` is `None` for SQL `NULL`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellValue {
    pub column: String,
    pub value: Option<String>,
}

/// Kind of relation surfaced by schema introspection. Tables and views
/// behave the same way for query generation; the distinction is kept so
/// the UI / LLM can warn before issuing destructive operations on views.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelationKind {
    Table,
    View,
    MaterializedView,
}

/// One column inside a [`TableSchema`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnSchema {
    pub name: String,
    /// Canonical type name as the engine reports it (e.g. `text`, `int4`,
    /// `varchar(255)`).
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
    /// Engine-side `COMMENT ON COLUMN`, when present.
    pub comment: Option<String>,
}

/// A foreign-key constraint referencing another table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeySchema {
    /// Constraint name as reported by the engine.
    pub name: String,
    /// Columns on this table that participate in the FK, in order.
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    /// Referenced columns on the parent table, paired with `columns`.
    pub ref_columns: Vec<String>,
}

/// One table or view as surfaced by schema introspection. Carries
/// everything the LLM tool layer (Phase 4) needs to plan a query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSchema {
    pub schema: String,
    pub name: String,
    pub kind: RelationKind,
    pub comment: Option<String>,
    pub columns: Vec<ColumnSchema>,
    /// Primary-key columns, in declaration order. Empty when none.
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ForeignKeySchema>,
}

/// Full schema view of a connection: every user schema with its tables
/// and their structural detail. User schemas only — `pg_catalog`,
/// `information_schema` and the like are filtered out by the driver.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseSchema {
    pub tables: Vec<TableSchema>,
}

/// The contract every database engine must fulfil.
///
/// Implementations own their own connection/pool. Methods are async and
/// the trait is `Send + Sync` so a driver can live inside Tauri-managed
/// state and be shared across command invocations.
/// File format for `copy_table_to_file`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// `COPY ... TO STDOUT WITH (FORMAT csv, HEADER true)`.
    Csv,
    /// One JSON object per line — newline-delimited JSON. Streams via
    /// `COPY (SELECT row_to_json(t) FROM "s"."t" t) TO STDOUT`.
    JsonLines,
}

#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    /// Which engine this driver speaks. Used once the UI surfaces the
    /// engine of a connection (more engines land post-v1).
    #[allow(dead_code)]
    fn kind(&self) -> DatabaseKind;

    /// Open a connection / pool. Called once when a connection tab opens.
    async fn connect(&mut self, config: &ConnectionConfig) -> AppResult<()>;

    /// Cheap round-trip used by the "Test connection" button.
    async fn ping(&self) -> AppResult<()>;

    /// List every schema visible to the connected user.
    async fn list_schemas(&self) -> AppResult<Vec<SchemaInfo>>;

    /// List tables and views inside a schema.
    async fn list_tables(&self, schema: &str) -> AppResult<Vec<TableInfo>>;

    /// Describe a table's columns and indexes.
    async fn describe_table(&self, schema: &str, table: &str) -> AppResult<TableDetails>;

    /// Full schema introspection: every user table with columns, PKs,
    /// FKs and comments. Used by the LLM tool layer to plan natural
    /// language queries. Results are cached at the session level by the
    /// caller, so this method should always do real work.
    async fn introspect_schema(&self) -> AppResult<DatabaseSchema>;

    /// Run an arbitrary SQL statement.
    async fn execute(&self, sql: &str) -> AppResult<QueryResult>;

    /// Browse a table's rows with an optional quick-filter, sort and
    /// pagination.
    async fn browse_table(
        &self,
        schema: &str,
        table: &str,
        filter: Option<&RowFilter>,
        order_by: Option<&OrderBy>,
        limit: i64,
        offset: i64,
    ) -> AppResult<QueryResult>;

    /// Update a single table row, addressed by its primary key.
    async fn update_row(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[CellValue],
        changes: &[CellValue],
    ) -> AppResult<QueryResult>;

    /// Insert a single row from the given column values.
    async fn insert_row(
        &self,
        schema: &str,
        table: &str,
        values: &[CellValue],
    ) -> AppResult<QueryResult>;

    /// Delete a single table row, addressed by its primary key.
    async fn delete_row(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[CellValue],
    ) -> AppResult<QueryResult>;

    /// The statements run this session, oldest first.
    fn query_history(&self) -> Vec<String>;

    /// Close the connection / pool.
    async fn disconnect(&mut self) -> AppResult<()>;

    /// Stream a full table to a local file in the requested format. The
    /// implementation must avoid materializing the whole result set in
    /// memory — large tables should flow row-by-row from the server to
    /// the file. Returns the number of bytes written.
    async fn copy_table_to_file(
        &self,
        schema: &str,
        table: &str,
        format: ExportFormat,
        path: &std::path::Path,
    ) -> AppResult<u64>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_kind_round_trips_through_json() {
        let json = serde_json::to_string(&DatabaseKind::Postgres).unwrap();
        assert_eq!(json, "\"postgres\"");
        let parsed: DatabaseKind = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, DatabaseKind::Postgres);
    }

    #[test]
    fn filter_op_round_trips_through_json() {
        for (op, expected) in [
            (FilterOp::Eq, "\"eq\""),
            (FilterOp::Neq, "\"neq\""),
            (FilterOp::Lt, "\"lt\""),
            (FilterOp::Gt, "\"gt\""),
            (FilterOp::Lte, "\"lte\""),
            (FilterOp::Gte, "\"gte\""),
            (FilterOp::Like, "\"like\""),
            (FilterOp::ILike, "\"ilike\""),
        ] {
            assert_eq!(serde_json::to_string(&op).unwrap(), expected);
        }
    }

    #[test]
    fn connection_config_deserializes_form_payload() {
        let raw = r#"{
            "name": "local",
            "kind": "postgres",
            "host": "h",
            "port": 5432,
            "database": "d",
            "user": "u",
            "password": "p"
        }"#;
        let cfg: ConnectionConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.name, "local");
        assert_eq!(cfg.kind, DatabaseKind::Postgres);
        assert_eq!(cfg.port, 5432);
    }

    #[test]
    fn structs_round_trip_through_json() {
        let info = SchemaInfo {
            name: "public".into(),
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: SchemaInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "public");

        let table = TableInfo {
            schema: "public".into(),
            name: "users".into(),
            is_view: false,
        };
        let back: TableInfo =
            serde_json::from_str(&serde_json::to_string(&table).unwrap()).unwrap();
        assert_eq!(back.name, "users");
        assert!(!back.is_view);

        let col = ColumnInfo {
            name: "id".into(),
            data_type: "int4".into(),
            nullable: false,
            default: Some("nextval(...)".into()),
            is_primary_key: true,
        };
        let back: ColumnInfo = serde_json::from_str(&serde_json::to_string(&col).unwrap()).unwrap();
        assert!(back.is_primary_key);
        assert_eq!(back.default.as_deref(), Some("nextval(...)"));

        let idx = IndexInfo {
            name: "users_pk".into(),
            columns: vec!["id".into()],
            is_unique: true,
            is_primary: true,
        };
        let back: IndexInfo = serde_json::from_str(&serde_json::to_string(&idx).unwrap()).unwrap();
        assert!(back.is_primary);

        let details = TableDetails {
            columns: vec![col],
            indexes: vec![idx],
        };
        let json = serde_json::to_string(&details).unwrap();
        let back: TableDetails = serde_json::from_str(&json).unwrap();
        assert_eq!(back.columns.len(), 1);
        assert_eq!(back.indexes.len(), 1);

        let qr = QueryResult {
            columns: vec!["a".into()],
            rows: vec![vec![Some("1".into()), None]],
            rows_affected: 1,
        };
        let back: QueryResult = serde_json::from_str(&serde_json::to_string(&qr).unwrap()).unwrap();
        assert_eq!(back.rows_affected, 1);

        let filter = RowFilter {
            column: "c".into(),
            operator: FilterOp::Like,
            value: "%v%".into(),
        };
        let back: RowFilter =
            serde_json::from_str(&serde_json::to_string(&filter).unwrap()).unwrap();
        assert_eq!(back.value, "%v%");

        let order = OrderBy {
            column: "id".into(),
            descending: true,
        };
        let back: OrderBy = serde_json::from_str(&serde_json::to_string(&order).unwrap()).unwrap();
        assert!(back.descending);

        let cell = CellValue {
            column: "id".into(),
            value: None,
        };
        let back: CellValue = serde_json::from_str(&serde_json::to_string(&cell).unwrap()).unwrap();
        assert!(back.value.is_none());
    }
}
