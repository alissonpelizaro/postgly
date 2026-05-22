//! Postgres implementation of [`DatabaseDriver`].
//!
//! Schema/table introspection runs against `pg_catalog` /
//! `information_schema`; arbitrary queries run through the simple-query
//! protocol so every value comes back as text.
//!
//! Note: `information_schema` columns are domain types (`sql_identifier`,
//! `yes_or_no`, ...) that sqlx can't decode directly, so every selected
//! column is cast to `text` / `bool`.

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::{Column, Executor, Row};

use super::driver::{
    CellValue, ColumnInfo, ConnectionConfig, DatabaseDriver, DatabaseKind, FilterOp, IndexInfo,
    OrderBy, QueryResult, RowFilter, SchemaInfo, TableDetails, TableInfo,
};
use crate::error::{AppError, AppResult};

/// Statements whose first keyword means the query yields a result set.
const ROW_RETURNING: [&str; 6] = ["select", "with", "values", "table", "show", "explain"];

/// Quote a SQL identifier (schema/table/column) for Postgres.
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// Quote a Postgres string literal (`standard_conforming_strings` assumed).
fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

impl FilterOp {
    /// The SQL operator token for this filter operator.
    fn as_sql(self) -> &'static str {
        match self {
            FilterOp::Eq => "=",
            FilterOp::Neq => "<>",
            FilterOp::Lt => "<",
            FilterOp::Gt => ">",
            FilterOp::Lte => "<=",
            FilterOp::Gte => ">=",
            FilterOp::Like => "LIKE",
            FilterOp::ILike => "ILIKE",
        }
    }
}

/// Most recent statements kept per session for the command history.
const HISTORY_CAP: usize = 200;

/// Driver for PostgreSQL. Owns the connection pool once connected.
#[derive(Default)]
pub struct PostgresDriver {
    pool: Option<PgPool>,
    /// Statements run through [`execute`], newest last (in-memory only).
    history: Mutex<Vec<String>>,
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

    async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        let pool = self.pool()?;
        let trimmed = sql.trim();
        if trimmed.is_empty() {
            return Err(AppError::Query("empty statement".into()));
        }

        // Record every statement (browse, DML and free-form queries all
        // funnel through here) for the session command history.
        if let Ok(mut h) = self.history.lock() {
            h.push(trimmed.to_string());
            let len = h.len();
            if len > HISTORY_CAP {
                h.drain(0..len - HISTORY_CAP);
            }
        }

        // The simple-query protocol (`raw_sql`) returns every value in
        // text format, so any column decodes cleanly as `Option<String>`
        // regardless of its Postgres type.
        let lower = trimmed.to_lowercase();
        let returns_rows =
            ROW_RETURNING.iter().any(|kw| lower.starts_with(kw)) || lower.contains(" returning ");

        if !returns_rows {
            let result = sqlx::raw_sql(trimmed)
                .execute(pool)
                .await
                .map_err(|e| AppError::Query(e.to_string()))?;
            return Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                rows_affected: result.rows_affected(),
            });
        }

        let rows = sqlx::raw_sql(trimmed)
            .fetch_all(pool)
            .await
            .map_err(|e| AppError::Query(e.to_string()))?;

        // Column names come from the first row; when the query returns no
        // rows, recover them from a `describe` so the UI can still show an
        // empty result set (rather than mistaking it for a DML command).
        let columns: Vec<String> = match rows.first() {
            Some(first) => first
                .columns()
                .iter()
                .map(|c| c.name().to_string())
                .collect(),
            None => pool
                .describe(trimmed)
                .await
                .map(|d| d.columns.iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default(),
        };

        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut cells = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                // `try_get_unchecked` skips sqlx's type-compatibility
                // check: the simple-query protocol already delivers every
                // value as text, so types like JSONB (which `String`'s
                // `Type::compatible` rejects) still decode fine.
                cells.push(
                    row.try_get_unchecked::<Option<String>, _>(i)
                        .map_err(|e| AppError::Query(e.to_string()))?,
                );
            }
            out.push(cells);
        }

        let rows_affected = out.len() as u64;
        Ok(QueryResult {
            columns,
            rows: out,
            rows_affected,
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
        let mut sql = format!(
            "SELECT * FROM {}.{}",
            quote_ident(schema),
            quote_ident(table)
        );
        if let Some(f) = filter {
            // The column is cast to text so any column type can be
            // compared against the (always-text) filter value.
            sql.push_str(&format!(
                " WHERE {}::text {} {}",
                quote_ident(&f.column),
                f.operator.as_sql(),
                quote_literal(&f.value),
            ));
        }
        if let Some(o) = order_by {
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_ident(&o.column),
                if o.descending { "DESC" } else { "ASC" },
            ));
        }
        sql.push_str(&format!(
            " LIMIT {} OFFSET {}",
            limit.clamp(0, 10_000),
            offset.max(0),
        ));
        self.execute(&sql).await
    }

    async fn insert_row(
        &self,
        schema: &str,
        table: &str,
        values: &[CellValue],
    ) -> AppResult<QueryResult> {
        if values.is_empty() {
            return Err(AppError::Query("no values to insert".into()));
        }
        let render = |c: &CellValue| match &c.value {
            Some(v) => quote_literal(v),
            None => "NULL".to_string(),
        };
        let columns = values
            .iter()
            .map(|c| quote_ident(&c.column))
            .collect::<Vec<_>>()
            .join(", ");
        let literals = values.iter().map(render).collect::<Vec<_>>().join(", ");
        let sql = format!(
            "INSERT INTO {}.{} ({}) VALUES ({})",
            quote_ident(schema),
            quote_ident(table),
            columns,
            literals,
        );
        self.execute(&sql).await
    }

    async fn delete_row(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[CellValue],
    ) -> AppResult<QueryResult> {
        if primary_key.is_empty() {
            return Err(AppError::Query(
                "table has no primary key; cannot delete rows".into(),
            ));
        }
        let where_clause = primary_key
            .iter()
            .map(|c| match &c.value {
                Some(v) => format!("{}::text = {}", quote_ident(&c.column), quote_literal(v)),
                None => format!("{} IS NULL", quote_ident(&c.column)),
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        let sql = format!(
            "DELETE FROM {}.{} WHERE {}",
            quote_ident(schema),
            quote_ident(table),
            where_clause,
        );
        self.execute(&sql).await
    }

    fn query_history(&self) -> Vec<String> {
        self.history
            .lock()
            .map(|h| h.clone())
            .unwrap_or_default()
    }

    async fn update_row(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[CellValue],
        changes: &[CellValue],
    ) -> AppResult<QueryResult> {
        if primary_key.is_empty() {
            return Err(AppError::Query(
                "table has no primary key; cannot edit rows".into(),
            ));
        }
        if changes.is_empty() {
            return Err(AppError::Query("no changes to apply".into()));
        }

        // Text literals coerce to the target column type via Postgres
        // assignment casts, so any column type can be set from a string.
        let render = |c: &CellValue| match &c.value {
            Some(v) => quote_literal(v),
            None => "NULL".to_string(),
        };

        let set = changes
            .iter()
            .map(|c| format!("{} = {}", quote_ident(&c.column), render(c)))
            .collect::<Vec<_>>()
            .join(", ");

        // Primary-key columns are compared as text so the value carried
        // back from the (always-text) result grid matches any key type.
        let where_clause = primary_key
            .iter()
            .map(|c| match &c.value {
                Some(v) => format!("{}::text = {}", quote_ident(&c.column), quote_literal(v)),
                None => format!("{} IS NULL", quote_ident(&c.column)),
            })
            .collect::<Vec<_>>()
            .join(" AND ");

        let sql = format!(
            "UPDATE {}.{} SET {} WHERE {}",
            quote_ident(schema),
            quote_ident(table),
            set,
            where_clause,
        );
        self.execute(&sql).await
    }

    async fn disconnect(&mut self) -> AppResult<()> {
        if let Some(pool) = self.pool.take() {
            pool.close().await;
        }
        Ok(())
    }
}
