//! Database layer: the engine-agnostic [`driver::DatabaseDriver`] trait and
//! its per-engine implementations.

pub mod driver;
pub mod postgres;

pub use driver::{DatabaseDriver, DatabaseKind};

/// Build a fresh, unconnected driver for the given engine.
///
/// This is the one place that maps a [`DatabaseKind`] to a concrete
/// implementation — adding an engine means adding a match arm here.
pub fn make_driver(kind: DatabaseKind) -> Box<dyn DatabaseDriver> {
    match kind {
        DatabaseKind::Postgres => Box::new(postgres::PostgresDriver::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn make_driver_for_postgres_returns_a_postgres_driver() {
        let driver = make_driver(DatabaseKind::Postgres);
        assert_eq!(driver.kind(), DatabaseKind::Postgres);
    }
}
