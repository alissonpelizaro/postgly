//! Postgres implementation of [`DatabaseDriver`].
//!
//! Phase 0 ships the skeleton: the type, the trait wiring and method
//! stubs. Phase 1 fills these in with a real `sqlx` Postgres pool —
//! every `todo!` below becomes a query against `information_schema` /
//! `pg_catalog`.

use async_trait::async_trait;

use super::driver::{
    ConnectionConfig, DatabaseDriver, DatabaseKind, QueryResult, SchemaInfo, TableDetails,
    TableInfo,
};
use crate::error::{AppError, AppResult};

/// Driver for PostgreSQL. Holds the connection pool once connected.
#[derive(Default)]
pub struct PostgresDriver {
    // Phase 1: replace with `Option<sqlx::PgPool>`.
    connected: bool,
}

impl PostgresDriver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Guard used by every operation that needs an open connection.
    fn require_connection(&self) -> AppResult<()> {
        if self.connected {
            Ok(())
        } else {
            Err(AppError::Connection("not connected".into()))
        }
    }
}

#[async_trait]
impl DatabaseDriver for PostgresDriver {
    fn kind(&self) -> DatabaseKind {
        DatabaseKind::Postgres
    }

    async fn connect(&mut self, _config: &ConnectionConfig) -> AppResult<()> {
        // Phase 1: build a `PgPool` from `_config` and store it.
        self.connected = true;
        Ok(())
    }

    async fn ping(&self) -> AppResult<()> {
        self.require_connection()
    }

    async fn list_schemas(&self) -> AppResult<Vec<SchemaInfo>> {
        self.require_connection()?;
        // Phase 1: SELECT schema_name FROM information_schema.schemata
        Ok(Vec::new())
    }

    async fn list_tables(&self, _schema: &str) -> AppResult<Vec<TableInfo>> {
        self.require_connection()?;
        // Phase 1: query information_schema.tables
        Ok(Vec::new())
    }

    async fn describe_table(&self, _schema: &str, _table: &str) -> AppResult<TableDetails> {
        self.require_connection()?;
        // Phase 1: query information_schema.columns + pg_indexes
        Ok(TableDetails {
            columns: Vec::new(),
            indexes: Vec::new(),
        })
    }

    async fn execute(&self, _sql: &str) -> AppResult<QueryResult> {
        self.require_connection()?;
        // Phase 3: run `_sql` through the pool and map the rows.
        Err(AppError::Query(
            "query execution not implemented yet".into(),
        ))
    }

    async fn disconnect(&mut self) -> AppResult<()> {
        self.connected = false;
        Ok(())
    }
}
