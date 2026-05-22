//! Postgres implementation of [`DatabaseDriver`].
//!
//! Schema/table introspection (Phase 2) is implemented here against
//! `pg_catalog` / `information_schema`. Arbitrary query execution
//! (`execute`) stays stubbed until Phase 3.
//!
//! Note: `information_schema` columns are domain types (`sql_identifier`,
//! `yes_or_no`, ...) that sqlx can't decode directly, so every selected
//! column is cast to `text` / `bool`.

use std::time::Duration;

use async_trait::async_trait;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::Row;

use super::driver::{
    ColumnInfo, ConnectionConfig, DatabaseDriver, DatabaseKind, IndexInfo, QueryResult, SchemaInfo,
    TableDetails, TableInfo,
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
        let rows = sqlx::query(
            "SELECT nspname::text AS name FROM pg_namespace \
             WHERE nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' \
             ORDER BY nspname",
        )
        .fetch_all(self.pool()?)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| SchemaInfo {
                name: r.get("name"),
            })
            .collect())
    }

    async fn list_tables(&self, schema: &str) -> AppResult<Vec<TableInfo>> {
        let rows = sqlx::query(
            "SELECT table_name::text AS name, table_type::text AS table_type \
             FROM information_schema.tables \
             WHERE table_schema = $1 \
             ORDER BY table_name",
        )
        .bind(schema)
        .fetch_all(self.pool()?)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let table_type: String = r.get("table_type");
                TableInfo {
                    schema: schema.to_string(),
                    name: r.get("name"),
                    is_view: table_type == "VIEW",
                }
            })
            .collect())
    }

    async fn describe_table(&self, schema: &str, table: &str) -> AppResult<TableDetails> {
        let pool = self.pool()?;

        let column_rows = sqlx::query(
            "SELECT c.column_name::text   AS name, \
                    c.data_type::text     AS data_type, \
                    c.is_nullable::text   AS is_nullable, \
                    c.column_default::text AS column_default, \
                    (pk.column_name IS NOT NULL) AS is_pk \
             FROM information_schema.columns c \
             LEFT JOIN ( \
                 SELECT kcu.column_name \
                 FROM information_schema.table_constraints tc \
                 JOIN information_schema.key_column_usage kcu \
                   ON tc.constraint_name = kcu.constraint_name \
                  AND tc.table_schema = kcu.table_schema \
                 WHERE tc.constraint_type = 'PRIMARY KEY' \
                   AND tc.table_schema = $1 AND tc.table_name = $2 \
             ) pk ON pk.column_name = c.column_name \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;

        let columns = column_rows
            .into_iter()
            .map(|r| {
                let nullable: String = r.get("is_nullable");
                ColumnInfo {
                    name: r.get("name"),
                    data_type: r.get("data_type"),
                    nullable: nullable == "YES",
                    default: r.get("column_default"),
                    is_primary_key: r.get("is_pk"),
                }
            })
            .collect();

        let index_rows = sqlx::query(
            "SELECT i.relname::text  AS name, \
                    ix.indisunique   AS is_unique, \
                    ix.indisprimary  AS is_primary, \
                    array_agg(a.attname::text ORDER BY k.ord) AS columns \
             FROM pg_class t \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_index ix ON ix.indrelid = t.oid \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum \
             WHERE n.nspname = $1 AND t.relname = $2 \
             GROUP BY i.relname, ix.indisunique, ix.indisprimary \
             ORDER BY ix.indisprimary DESC, i.relname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::Query(e.to_string()))?;

        let indexes = index_rows
            .into_iter()
            .map(|r| IndexInfo {
                name: r.get("name"),
                columns: r.get("columns"),
                is_unique: r.get("is_unique"),
                is_primary: r.get("is_primary"),
            })
            .collect();

        Ok(TableDetails { columns, indexes })
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
