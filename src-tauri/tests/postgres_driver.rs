//! Integration tests that exercise the live Postgres driver against a
//! real PostgreSQL instance. Gated by the `POSTGLY_TEST_DB_URL` env var
//! in the form `host:port:user:password:database` — when unset every
//! test bails out as a no-op so the suite stays green on machines
//! without a database. In CI the var is wired up to a `services:`
//! postgres container.

use postgly_lib::db::driver::{
    CellValue, ConnectionConfig, DatabaseDriver, DatabaseKind, FilterOp, OrderBy, RowFilter,
};
use postgly_lib::db::make_driver;

struct Db {
    driver: Box<dyn DatabaseDriver>,
}

impl Db {
    async fn open() -> Option<Self> {
        let raw = std::env::var("POSTGLY_TEST_DB_URL").ok()?;
        let parts: Vec<&str> = raw.split(':').collect();
        if parts.len() != 5 {
            panic!("POSTGLY_TEST_DB_URL must be host:port:user:password:database");
        }
        let config = ConnectionConfig {
            name: "test".into(),
            kind: DatabaseKind::Postgres,
            host: parts[0].into(),
            port: parts[1].parse().expect("port"),
            database: parts[4].into(),
            user: parts[2].into(),
            password: parts[3].into(),
        };
        let mut driver = make_driver(config.kind);
        driver.connect(&config).await.expect("connect");
        Some(Self { driver })
    }

    /// Run a statement and assert that it succeeded — handy for setup.
    async fn run(&self, sql: &str) {
        self.driver.execute(sql).await.expect(sql);
    }
}

macro_rules! db_test {
    ($name:ident, $db:ident, $body:block) => {
        #[tokio::test]
        async fn $name() {
            let $db = match Db::open().await {
                Some(d) => d,
                None => return,
            };
            $body
        }
    };
}

db_test!(ping_round_trips_through_real_pool, db, {
    db.driver.ping().await.unwrap();
});

db_test!(execute_select_returns_rows_and_columns, db, {
    let res = db.driver.execute("SELECT 1 AS a, 'x' AS b").await.unwrap();
    assert_eq!(res.columns, vec!["a".to_string(), "b".to_string()]);
    assert_eq!(res.rows.len(), 1);
    assert_eq!(res.rows[0][0].as_deref(), Some("1"));
    assert_eq!(res.rows[0][1].as_deref(), Some("x"));
    assert_eq!(res.rows_affected, 1);
});

db_test!(execute_dml_reports_rows_affected, db, {
    db.run("DROP TABLE IF EXISTS pg_drv_dml").await;
    db.run("CREATE TABLE pg_drv_dml (id int primary key, v text)")
        .await;
    let res = db
        .driver
        .execute("INSERT INTO pg_drv_dml VALUES (1, 'a'), (2, 'b')")
        .await
        .unwrap();
    assert_eq!(res.rows_affected, 2);
    assert!(res.columns.is_empty());
    db.run("DROP TABLE pg_drv_dml").await;
});

db_test!(execute_rejects_empty_statement, db, {
    let err = db.driver.execute("   ").await.unwrap_err();
    assert!(err.to_string().contains("empty statement"));
});

db_test!(execute_returns_query_error_on_bad_sql, db, {
    let err = db
        .driver
        .execute("SELECT * FROM not_a_real_table_xyz")
        .await
        .unwrap_err();
    assert!(err.to_string().to_lowercase().contains("query"));
});

db_test!(history_records_executed_statements_and_caps, db, {
    // Burn through enough statements to confirm the trim-to-cap path
    // runs. The cap is 200, so 210 keeps the math simple.
    for _ in 0..210 {
        db.driver.execute("SELECT 1").await.unwrap();
    }
    let hist = db.driver.query_history();
    assert!(hist.len() <= 200);
    assert!(hist.iter().all(|s| s == "SELECT 1"));
});

db_test!(list_schemas_includes_public, db, {
    let schemas = db.driver.list_schemas().await.unwrap();
    assert!(schemas.iter().any(|s| s.name == "public"));
});

db_test!(list_tables_and_describe_table_introspect_columns, db, {
    db.run("DROP TABLE IF EXISTS pg_drv_meta").await;
    db.run(
        "CREATE TABLE pg_drv_meta (\
         id serial PRIMARY KEY,\
         name text NOT NULL,\
         note text DEFAULT 'n')",
    )
    .await;

    let tables = db.driver.list_tables("public").await.unwrap();
    let table = tables
        .iter()
        .find(|t| t.name == "pg_drv_meta")
        .expect("created table listed");
    assert_eq!(table.schema, "public");
    assert!(!table.is_view);

    let details = db
        .driver
        .describe_table("public", "pg_drv_meta")
        .await
        .unwrap();
    let names: Vec<_> = details.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["id", "name", "note"]);
    let id_col = details.columns.iter().find(|c| c.name == "id").unwrap();
    assert!(id_col.is_primary_key);
    let name_col = details.columns.iter().find(|c| c.name == "name").unwrap();
    assert!(!name_col.nullable);
    let note_col = details.columns.iter().find(|c| c.name == "note").unwrap();
    assert!(note_col.default.is_some());
    assert!(details.indexes.iter().any(|i| i.is_primary));
    db.run("DROP TABLE pg_drv_meta").await;
});

db_test!(insert_update_delete_round_trip, db, {
    db.run("DROP TABLE IF EXISTS pg_drv_crud").await;
    db.run("CREATE TABLE pg_drv_crud (id int primary key, v text, opt text)")
        .await;

    db.driver
        .insert_row(
            "public",
            "pg_drv_crud",
            &[
                CellValue {
                    column: "id".into(),
                    value: Some("1".into()),
                },
                CellValue {
                    column: "v".into(),
                    value: Some("a".into()),
                },
                CellValue {
                    column: "opt".into(),
                    value: None,
                },
            ],
        )
        .await
        .unwrap();

    db.driver
        .update_row(
            "public",
            "pg_drv_crud",
            &[CellValue {
                column: "id".into(),
                value: Some("1".into()),
            }],
            &[CellValue {
                column: "v".into(),
                value: Some("b".into()),
            }],
        )
        .await
        .unwrap();

    let after = db
        .driver
        .execute("SELECT v FROM pg_drv_crud WHERE id = 1")
        .await
        .unwrap();
    assert_eq!(after.rows[0][0].as_deref(), Some("b"));

    db.driver
        .delete_row(
            "public",
            "pg_drv_crud",
            &[CellValue {
                column: "id".into(),
                value: Some("1".into()),
            }],
        )
        .await
        .unwrap();
    let count = db
        .driver
        .execute("SELECT count(*)::text FROM pg_drv_crud")
        .await
        .unwrap();
    assert_eq!(count.rows[0][0].as_deref(), Some("0"));
    db.run("DROP TABLE pg_drv_crud").await;
});

db_test!(delete_with_null_primary_key_uses_is_null, db, {
    db.run("DROP TABLE IF EXISTS pg_drv_nullpk").await;
    db.run("CREATE TABLE pg_drv_nullpk (id int, v text)").await;
    db.run("INSERT INTO pg_drv_nullpk VALUES (NULL, 'a')").await;

    db.driver
        .delete_row(
            "public",
            "pg_drv_nullpk",
            &[CellValue {
                column: "id".into(),
                value: None,
            }],
        )
        .await
        .unwrap();
    let count = db
        .driver
        .execute("SELECT count(*)::text FROM pg_drv_nullpk")
        .await
        .unwrap();
    assert_eq!(count.rows[0][0].as_deref(), Some("0"));
    db.run("DROP TABLE pg_drv_nullpk").await;
});

db_test!(update_with_null_change_writes_null, db, {
    db.run("DROP TABLE IF EXISTS pg_drv_nullupd").await;
    db.run("CREATE TABLE pg_drv_nullupd (id int primary key, v text)")
        .await;
    db.run("INSERT INTO pg_drv_nullupd VALUES (1, 'a')").await;

    db.driver
        .update_row(
            "public",
            "pg_drv_nullupd",
            &[CellValue {
                column: "id".into(),
                value: Some("1".into()),
            }],
            &[CellValue {
                column: "v".into(),
                value: None,
            }],
        )
        .await
        .unwrap();
    let after = db
        .driver
        .execute("SELECT v IS NULL FROM pg_drv_nullupd WHERE id = 1")
        .await
        .unwrap();
    assert_eq!(after.rows[0][0].as_deref(), Some("t"));
    db.run("DROP TABLE pg_drv_nullupd").await;
});

db_test!(browse_table_applies_filter_sort_and_pagination, db, {
    db.run("DROP TABLE IF EXISTS pg_drv_browse").await;
    db.run("CREATE TABLE pg_drv_browse (id int primary key, name text)")
        .await;
    db.run(
        "INSERT INTO pg_drv_browse VALUES \
        (1,'alpha'),(2,'beta'),(3,'gamma'),(4,'beta-extra')",
    )
    .await;

    let res = db
        .driver
        .browse_table(
            "public",
            "pg_drv_browse",
            Some(&RowFilter {
                column: "name".into(),
                operator: FilterOp::Like,
                value: "beta%".into(),
            }),
            Some(&OrderBy {
                column: "id".into(),
                descending: true,
            }),
            1,
            0,
        )
        .await
        .unwrap();
    assert_eq!(res.rows.len(), 1);
    let id = res
        .columns
        .iter()
        .position(|c| c == "id")
        .expect("id column");
    assert_eq!(res.rows[0][id].as_deref(), Some("4"));

    // No filter / sort path with pagination clamp.
    let all = db
        .driver
        .browse_table("public", "pg_drv_browse", None, None, -5, -1)
        .await
        .unwrap();
    assert_eq!(all.rows.len(), 0); // limit clamped to 0
    db.run("DROP TABLE pg_drv_browse").await;
});

db_test!(disconnect_releases_pool, _db, {
    // Open a second driver to disconnect cleanly without disturbing the
    // shared one.
    if let Some(other) = Db::open().await {
        let Db { mut driver } = other;
        driver.disconnect().await.unwrap();
        // Subsequent calls now return "not connected".
        let err = driver.ping().await.unwrap_err();
        assert!(err.to_string().contains("not connected"));
    }
});

db_test!(execute_with_returning_takes_row_returning_path, db, {
    db.run("DROP TABLE IF EXISTS pg_drv_returning").await;
    db.run("CREATE TABLE pg_drv_returning (id int primary key, v text)")
        .await;
    let res = db
        .driver
        .execute("INSERT INTO pg_drv_returning VALUES (1,'a') RETURNING id")
        .await
        .unwrap();
    assert_eq!(res.columns, vec!["id".to_string()]);
    assert_eq!(res.rows[0][0].as_deref(), Some("1"));
    db.run("DROP TABLE pg_drv_returning").await;
});

db_test!(introspect_schema_returns_columns_pk_fk_and_comments, db, {
    db.run("DROP TABLE IF EXISTS pg_drv_order").await;
    db.run("DROP TABLE IF EXISTS pg_drv_customer").await;
    db.run("CREATE TABLE pg_drv_customer (id serial PRIMARY KEY, name text NOT NULL)")
        .await;
    db.run(
        "CREATE TABLE pg_drv_order (\
         id serial PRIMARY KEY,\
         customer_id int NOT NULL REFERENCES pg_drv_customer(id),\
         total numeric(10,2) DEFAULT 0)",
    )
    .await;
    db.run("COMMENT ON TABLE pg_drv_order IS 'orders placed by customers'")
        .await;
    db.run("COMMENT ON COLUMN pg_drv_order.total IS 'value in BRL'")
        .await;

    let schema = db.driver.introspect_schema().await.unwrap();

    let order = schema
        .tables
        .iter()
        .find(|t| t.schema == "public" && t.name == "pg_drv_order")
        .expect("order table present");
    assert_eq!(order.comment.as_deref(), Some("orders placed by customers"));
    assert_eq!(order.primary_key, vec!["id".to_string()]);

    let id_col = order.columns.iter().find(|c| c.name == "id").unwrap();
    assert!(id_col.is_primary_key);
    let total_col = order.columns.iter().find(|c| c.name == "total").unwrap();
    assert!(total_col.data_type.starts_with("numeric"));
    assert!(total_col.default.as_deref().unwrap_or("").contains('0'));
    assert_eq!(total_col.comment.as_deref(), Some("value in BRL"));

    assert_eq!(order.foreign_keys.len(), 1);
    let fk = &order.foreign_keys[0];
    assert_eq!(fk.columns, vec!["customer_id".to_string()]);
    assert_eq!(fk.ref_schema, "public");
    assert_eq!(fk.ref_table, "pg_drv_customer");
    assert_eq!(fk.ref_columns, vec!["id".to_string()]);

    // System schemas are filtered out.
    assert!(schema
        .tables
        .iter()
        .all(|t| t.schema != "pg_catalog" && t.schema != "information_schema"));

    db.run("DROP TABLE pg_drv_order").await;
    db.run("DROP TABLE pg_drv_customer").await;
});
