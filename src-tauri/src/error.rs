//! Application-wide error type.
//!
//! Every Tauri command returns `Result<T, AppError>`. `AppError` is
//! `Serialize` so it crosses the IPC boundary as a plain string the
//! frontend can display.

use serde::Serialize;

/// The single error type surfaced to the frontend.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// The driver could not reach or authenticate against the database.
    #[error("connection failed: {0}")]
    Connection(String),

    /// A query or statement failed to execute.
    #[error("query failed: {0}")]
    Query(String),

    /// The requested engine has no registered driver yet. Reserved for
    /// when a second engine is introduced post-v1.
    #[allow(dead_code)]
    #[error("unsupported database engine: {0}")]
    UnsupportedEngine(String),

    /// Anything that does not fit the cases above.
    #[error("{0}")]
    Other(String),
}

/// Serialize as a flat string so the frontend just receives the message.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convenience alias for command and driver results.
pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_formats_each_variant() {
        assert_eq!(
            AppError::Connection("nope".into()).to_string(),
            "connection failed: nope"
        );
        assert_eq!(
            AppError::Query("syntax".into()).to_string(),
            "query failed: syntax"
        );
        assert_eq!(
            AppError::UnsupportedEngine("mysql".into()).to_string(),
            "unsupported database engine: mysql"
        );
        assert_eq!(AppError::Other("boom".into()).to_string(), "boom");
    }

    #[test]
    fn serializes_to_plain_string() {
        let err = AppError::Query("bad".into());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"query failed: bad\"");
    }

    #[test]
    fn app_result_alias_round_trips() {
        fn try_it(ok: bool) -> AppResult<i32> {
            if ok {
                Ok(7)
            } else {
                Err(AppError::Other("x".into()))
            }
        }
        assert_eq!(try_it(true).unwrap(), 7);
        assert!(try_it(false).is_err());
    }
}
