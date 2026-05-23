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
/// see the connection store (Phase 1) which offloads it to the OS keyring.
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

/// The contract every database engine must fulfil.
///
/// Implementations own their own connection/pool. Methods are async and
/// the trait is `Send + Sync` so a driver can live inside Tauri-managed
/// state and be shared across command invocations.
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
