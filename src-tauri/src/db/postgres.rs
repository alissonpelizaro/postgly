//! Postgres implementation of [`DatabaseDriver`].
//!
//! Phase 1 wires up a real `sqlx` connection pool — enough for opening
//! and testing a connection. The schema/table/query methods stay stubbed
//! until Phases 2–3, where each becomes a query against
//! `information_schema` / `pg_catalog`.

use std::time::Duration;

use async_trait::async_trait;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};

use super::driver::{
    ConnectionConfig, DatabaseDriver, DatabaseKind, QueryResult, SchemaInfo, TableDetails,
    TableInfo,
};
use crate::error::{AppError, AppResult};

/// Driver for PostgreSQL. Owns the connection pool once connected.
#[derive(Default)]
pub struct PostgresDriver {
    pool: Option<PgPool>,
}

impl PostgresDriver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Borrow the pool, failing cleanly if the driver isn't connected.
    fn pool(&self) -> AppResult<&PgPool> {
        self.pool
            .as_ref()
            .ok_or_else(|| AppError::Connection("not connected".into()))
    }
}

#[async_trait]
impl DatabaseDriver for PostgresDriver {
    fn kind(&self) -> DatabaseKind {
        DatabaseKind::Postgres
    }

    async fn connect(&mut self, config: &ConnectionConfig) -> AppResult<()> {
        let options = PgConnectOptions::new()
            .host(&config.host)
            .port(config.port)
            .username(&config.user)
            .password(&config.password)
            .database(&config.database);

        let pool = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await
            .map_err(|e| AppError::Connection(e.to_string()))?;

        self.pool = Some(pool);
        Ok(())
    }

    async fn ping(&self) -> AppResult<()> {
        sqlx::query("SELECT 1")
            .execute(self.pool()?)
            .await
            .map_err(|e| AppError::Connection(e.to_string()))?;
        Ok(())
    }

    async fn list_schemas(&self) -> AppResult<Vec<SchemaInfo>> {
        let _ = self.pool()?;
        // Phase 2: SELECT schema_name FROM information_schema.schemata
        Ok(Vec::new())
    }

    async fn list_tables(&self, _schema: &str) -> AppResult<Vec<TableInfo>> {
        let _ = self.pool()?;
        // Phase 2: query information_schema.tables
        Ok(Vec::new())
    }

    async fn describe_table(&self, _schema: &str, _table: &str) -> AppResult<TableDetails> {
        let _ = self.pool()?;
        // Phase 2: query information_schema.columns + pg_indexes
        Ok(TableDetails {
            columns: Vec::new(),
            indexes: Vec::new(),
        })
    }

    async fn execute(&self, _sql: &str) -> AppResult<QueryResult> {
        let _ = self.pool()?;
        // Phase 3: run `_sql` through the pool and map the rows.
        Err(AppError::Query(
            "query execution not implemented yet".into(),
        ))
    }

    async fn disconnect(&mut self) -> AppResult<()> {
        if let Some(pool) = self.pool.take() {
            pool.close().await;
        }
        Ok(())
    }
}
